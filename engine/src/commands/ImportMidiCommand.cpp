#include "commands/ImportMidiCommand.h"

#include "SampleBank.h"
#include "audio/MixEngine.h"
#include "model/Timeline.h"

#include <algorithm>
#include <chrono>
#include <iostream>
#include <utility>

#ifdef XLETH_DEBUG
#include <cstdio>
#endif

ImportMidiCommand::ImportMidiCommand(ImportMidiCommandOptions options,
                                     MixEngine& mixEngine,
                                     SampleBank& sampleBank,
                                     double engineSampleRate)
    : options_(std::move(options)),
      mixEngine_(&mixEngine),
      sampleBank_(&sampleBank),
      engineSampleRate_(engineSampleRate > 0.0 ? engineSampleRate : 44100.0)
{
}

void ImportMidiCommand::execute(Timeline& timeline)
{
    const auto t0 = std::chrono::steady_clock::now();

    if (!hasCapturedPreState_) {
        capturePreImportState(timeline);
        hasCapturedPreState_ = true;
    }

#ifdef XLETH_DEBUG
    std::fprintf(stderr,
                 "[MidiImport] execute begin: %zu output tracks, tempoOverride=%d sourceBPM=%.2f\n",
                 options_.outputTracks.size(),
                 options_.tempoOverride ? 1 : 0,
                 options_.sourceBPM);
    std::fflush(stderr);
#endif

    // 1. Apply tempo override BEFORE creating tracks.
    if (options_.tempoOverride) {
        timeline.setBPM(options_.sourceBPM);
    }

    // 2. For each selected output track, either create a new pattern track
    // (Create) or rewrite the notes of the pattern already sitting on an
    // existing one (Update). Region/sample resolution is shared by both modes
    // and conditional: assigned rows use the existing region binding path,
    // while regionId < 0 means "unassigned" in Create mode and "keep whatever
    // the pattern already has" in Update mode.
    for (auto& spec : options_.outputTracks) {
        const bool isUpdate = (spec.mode == ImportMidiCommandOptions::Mode::Update);
        if (isUpdate) hasUpdateRows_ = true;

        bool createdSampleMapping = false;
        int  sampleBankId         = -1;
        bool haveBinding          = false;

        if (spec.regionId >= 0) {
            haveBinding = resolveRegionBinding(timeline, spec, createdSampleMapping, sampleBankId);
            if (!haveBinding) continue;  // reason already logged
        }

        // Undoes this row's sample load when the row fails after the binding
        // was resolved, so a failed row leaves no orphan slot behind.
        auto rollbackRowBinding = [&] {
            if (!createdSampleMapping) return;
            mixEngine_->unmapRegion(spec.regionId);
            sampleBank_->unloadSample(sampleBankId);
            createdSampleSlots_.pop_back();
            createdMappedRegionIds_.pop_back();
            createdSampleMapping = false;
        };

        if (isUpdate) {
            if (!executeUpdateRow(timeline, spec, spec.regionId, haveBinding)) {
                rollbackRowBinding();
            }
            continue;
        }

        // ── Create ───────────────────────────────────────────────────────────
        // 2c. Create TrackInfo (Pattern type).
        TrackInfo track;
        track.type       = TrackInfo::Type::Pattern;
        track.name       = spec.name;
        track.visualOnly = spec.visualOnly;
        const int trackId = timeline.addTrack(std::move(track));
        if (trackId < 0) {
            std::cout << "[MidiImport] output track " << spec.outputTrackIndex
                      << " FAILED: addTrack returned -1\n";
            rollbackRowBinding();
            continue;
        }
        createdTrackIds_.push_back(trackId);

        // 2d. Create Pattern bound to the assigned region, or left unassigned
        // when regionId is -1.
        Pattern pattern;
        pattern.name     = spec.name;
        pattern.regionId = spec.regionId;
        const int patternId = timeline.addPattern(std::move(pattern));
        if (patternId < 0) {
            timeline.removeTrack(trackId);
            createdTrackIds_.pop_back();
            rollbackRowBinding();
            continue;
        }
        createdPatternIds_.push_back(patternId);

        // 2e. Bulk-insert notes (Timeline recalculates pattern length).
        if (!spec.notes.empty()) {
            timeline.addNotesToPatternBulk(patternId, spec.notes);
        }

        // 2f. Compute block duration from the now-stored pattern's length.
        TickTime blockDuration{ 0 };
        if (const Pattern* storedPattern = timeline.getPattern(patternId)) {
            blockDuration = storedPattern->length;
        }

        // 2g. Place the pattern at the resolved import position on the new track.
        PatternBlock block;
        block.trackId   = trackId;
        block.patternId = patternId;
        block.position  = options_.importPosition;
        block.duration  = blockDuration;
        const int blockId = timeline.addPatternBlock(std::move(block));
        if (blockId < 0) {
            std::cout << "[MidiImport] output track " << spec.outputTrackIndex
                      << " FAILED: addPatternBlock returned -1 (track " << trackId
                      << " pattern " << patternId << ")\n";
            continue;
        }
        createdPatternBlockIds_.push_back(blockId);

        // 2h. "Loop pattern to fill project" -- Create rows only. Places
        // sequential, contiguous copies of the same pattern until they cover
        // preProjectEndTick_ (captured before this command placed anything).
        if (options_.tileToFillProject) {
            if (blockDuration.ticks <= 0) {
                std::cout << "[MidiImport] output track " << spec.outputTrackIndex
                          << " tile-to-fill skipped: pattern has zero length\n";
            } else if (preProjectEndTick_.ticks <= options_.importPosition.ticks) {
                std::cout << "[MidiImport] output track " << spec.outputTrackIndex
                          << " tile-to-fill skipped: project end (" << preProjectEndTick_.ticks
                          << ") is at or before the import position ("
                          << options_.importPosition.ticks << ") -- placing a single block\n";
            } else {
                TickTime nextPos = options_.importPosition + blockDuration;
                int tileCount = 0;
                while (nextPos.ticks < preProjectEndTick_.ticks) {
                    PatternBlock tileBlock;
                    tileBlock.trackId   = trackId;
                    tileBlock.patternId = patternId;
                    tileBlock.position  = nextPos;
                    tileBlock.duration  = blockDuration;
                    const int tileBlockId = timeline.addPatternBlock(std::move(tileBlock));
                    if (tileBlockId < 0) break;
                    createdPatternBlockIds_.push_back(tileBlockId);
                    ++tileCount;
                    nextPos = nextPos + blockDuration;
                }
                std::cout << "[MidiImport] output track " << spec.outputTrackIndex
                          << " tile-to-fill placed " << tileCount
                          << " additional block(s) to cover project end ("
                          << preProjectEndTick_.ticks << ")\n";
            }
        }

#ifdef XLETH_DEBUG
        std::fprintf(stderr,
                     "[MidiImport]   created outputTrack=%d trackId=%d regionId=%d sampleId=%d "
                     "patternId=%d blockId=%d notes=%zu newMapping=%d\n",
                     spec.outputTrackIndex, trackId, spec.regionId, sampleBankId,
                     patternId, blockId, spec.notes.size(), createdSampleMapping ? 1 : 0);
        std::fflush(stderr);
#endif
    }

    const auto t1 = std::chrono::steady_clock::now();
    const auto elapsedMs =
        std::chrono::duration_cast<std::chrono::milliseconds>(t1 - t0).count();
#ifdef XLETH_DEBUG
    std::fprintf(stderr,
                 "[MidiImport] execute complete: %zu tracks, %zu patterns, "
                 "%zu blocks, %zu new sample slots, %zu new region mappings, %lld ms\n",
                 createdTrackIds_.size(),
                 createdPatternIds_.size(), createdPatternBlockIds_.size(),
                 createdSampleSlots_.size(), createdMappedRegionIds_.size(),
                 (long long)elapsedMs);
    std::fflush(stderr);
#else
    (void)elapsedMs;
#endif
}

void ImportMidiCommand::undo(Timeline& timeline)
{
    const auto t0 = std::chrono::steady_clock::now();

#ifdef XLETH_DEBUG
    std::fprintf(stderr,
                 "[MidiImport] undo begin: removing %zu tracks, %zu patterns, %zu blocks, "
                 "unmapping %zu regions, unloading %zu sample slots, removing %zu defensive regions\n",
                 createdTrackIds_.size(),
                 createdPatternIds_.size(), createdPatternBlockIds_.size(),
                 createdMappedRegionIds_.size(), createdSampleSlots_.size(),
                 createdRegionIds_.size());
    std::fflush(stderr);
#endif

    // Reverse order: restore updated tracks -> blocks -> patterns -> unmap (only
    // command-created mappings) -> unload (only command-created slots) -> remove
    // regions (defensive, empty in normal flow) -> remove tracks -> restore BPM ->
    // defensive snapshot restore.

    // Update-mode rows first. They touch only PRE-EXISTING patterns and blocks,
    // which are disjoint from the created* vectors below, so the two halves
    // cannot interfere -- but doing them first keeps the log in true reverse
    // order of execute().
    for (auto it = updatedTracks_.rbegin(); it != updatedTracks_.rend(); ++it) {
        const UpdatedTrackSnapshot& snap = *it;

        // Notes, ids, note counter and stored length, verbatim and without a
        // cascade (see Timeline::restorePatternNotes).
        timeline.restorePatternNotes(snap.patternId, snap.notes,
                                     snap.nextNoteId, snap.patternLength);

        // Exact pre-import durations for every block of this pattern. Replayed
        // rather than re-cascaded because the cascade rule is not invertible.
        for (const auto& [blockId, duration] : snap.blockDurations) {
            timeline.resizePatternBlock(blockId, duration);
        }

        // Pattern binding. execute() only writes this when the dialog handed us
        // a region, but restoring the captured value is a no-op otherwise.
        if (Pattern* pattern = timeline.getPatternMutable(snap.patternId)) {
            pattern->regionId = snap.regionId;
        }

        std::cout << "[MidiImport] undo: restored track " << snap.trackId
                  << " pattern " << snap.patternId
                  << " (" << snap.notes.size() << " notes, "
                  << snap.blockDurations.size() << " block durations, regionId="
                  << snap.regionId << ")\n";
    }
    updatedTracks_.clear();

    for (auto it = createdPatternBlockIds_.rbegin(); it != createdPatternBlockIds_.rend(); ++it) {
        timeline.removePatternBlock(*it);
    }
    createdPatternBlockIds_.clear();

    for (auto it = createdPatternIds_.rbegin(); it != createdPatternIds_.rend(); ++it) {
        timeline.removePattern(*it);
    }
    createdPatternIds_.clear();

    // Critical: unmap regions BEFORE unloadSample (per SampleBank.h contract).
    // ONLY mappings this command created - pre-existing mappings are left alone.
    if (mixEngine_ != nullptr) {
        for (auto it = createdMappedRegionIds_.rbegin(); it != createdMappedRegionIds_.rend(); ++it) {
            mixEngine_->unmapRegion(*it);
        }
    }
    createdMappedRegionIds_.clear();

    if (sampleBank_ != nullptr) {
        for (auto it = createdSampleSlots_.rbegin(); it != createdSampleSlots_.rend(); ++it) {
            sampleBank_->unloadSample(it->sampleBankId);
        }
    }
    createdSampleSlots_.clear();

    // Defensive: createdRegionIds_ is empty in normal flow (we don't create
    // regions on import anymore). Kept for partial-failure cleanup paths.
    for (auto it = createdRegionIds_.rbegin(); it != createdRegionIds_.rend(); ++it) {
        timeline.removeRegion(*it);
    }
    createdRegionIds_.clear();

    for (auto it = createdTrackIds_.rbegin(); it != createdTrackIds_.rend(); ++it) {
        timeline.removeTrack(*it);
    }
    createdTrackIds_.clear();

    // Restore BPM (always - execute may have written, and even if it didn't,
    // restoring to the captured value is a no-op).
    timeline.setBPM(preBpm_);

    // Restore any pre-existing region->sample mappings the snapshot captured.
    // execute() never mutates these (it only adds new region ids), but the
    // snapshot is the source of truth on undo.
    if (mixEngine_ != nullptr) {
        for (const auto& [regionId, sampleId] : preRegionToSampleMap_) {
            mixEngine_->mapRegionToSample(regionId, sampleId);
        }
    }

    const auto t1 = std::chrono::steady_clock::now();
    const auto elapsedMs =
        std::chrono::duration_cast<std::chrono::milliseconds>(t1 - t0).count();
#ifdef XLETH_DEBUG
    std::fprintf(stderr, "[MidiImport] undo complete: %lld ms\n", (long long)elapsedMs);
    std::fflush(stderr);
#else
    (void)elapsedMs;
#endif
}

std::string ImportMidiCommand::describe() const
{
    // A mixed commit (some rows updated, some created) is still one undo step
    // and reads as a re-import: that is the half the user cares about undoing.
    return hasUpdateRows_ ? "Re-import MIDI" : "Import MIDI";
}

void ImportMidiCommand::capturePreImportState(Timeline& timeline)
{
    preBpm_ = timeline.getBPM();

    if (mixEngine_ != nullptr) {
        preRegionToSampleMap_ = mixEngine_->getRegionToSampleMapSnapshot();
    } else {
        preRegionToSampleMap_.clear();
    }

    preProjectEndTick_ = TickTime{ 0 };
    for (const PatternBlock* block : timeline.getAllPatternBlocks()) {
        if (block == nullptr) continue;
        const TickTime end = block->position + block->duration;
        if (end.ticks > preProjectEndTick_.ticks) {
            preProjectEndTick_ = end;
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Shared region binding
// ─────────────────────────────────────────────────────────────────────────────

bool ImportMidiCommand::resolveRegionBinding(Timeline& timeline,
                                             const ImportMidiCommandOptions::OutputTrackSpec& spec,
                                             bool& outCreatedMapping,
                                             int& outSampleBankId)
{
    outCreatedMapping = false;
    outSampleBankId   = -1;

    const SampleRegion* region = timeline.getRegion(spec.regionId);
    if (region == nullptr) {
        std::cout << "[MidiImport] output track " << spec.outputTrackIndex
                  << " FAILED: regionId " << spec.regionId << " not found\n";
        return false;
    }

    // Reuse an existing mapping rather than loading the sample twice. A mapping
    // we did NOT create must never be torn down on undo, which is why
    // createdMappedRegionIds_ is only appended to in the load branch below.
    const int existingSampleId = mixEngine_->getSampleIdForRegion(spec.regionId);
    if (existingSampleId >= 0) {
        outSampleBankId = existingSampleId;
        return true;
    }

    // Resolve audio path. Mirror Audio_LoadRegionAudio: prefer swapped audio if
    // present, otherwise the source media's file path with the region's
    // [startTime, endTime] window.
    const SourceMedia* source = timeline.getSource(region->sourceId);
    if (source == nullptr || source->filePath.empty()) {
        std::cout << "[MidiImport] output track " << spec.outputTrackIndex
                  << " FAILED: regionId " << spec.regionId << " source "
                  << region->sourceId << " unresolved\n";
        return false;
    }

    const std::string audioPath =
        (region->hasSwappedAudio && !region->swappedAudioPath.empty())
            ? region->swappedAudioPath
            : source->filePath;

    outSampleBankId = sampleBank_->loadSampleFromSource(
        audioPath, region->startTime, region->endTime, engineSampleRate_);
    if (outSampleBankId < 0) {
        std::cout << "[MidiImport] output track " << spec.outputTrackIndex
                  << " FAILED: loadSampleFromSource(" << audioPath
                  << ") for regionId " << spec.regionId << "\n";
        return false;
    }

    mixEngine_->mapRegionToSample(spec.regionId, outSampleBankId);
    createdSampleSlots_.push_back(CreatedSampleSlotInfo{ outSampleBankId, audioPath });
    createdMappedRegionIds_.push_back(spec.regionId);
    outCreatedMapping = true;
    return true;
}

// ─────────────────────────────────────────────────────────────────────────────
// Update mode
// ─────────────────────────────────────────────────────────────────────────────
//
// What is PRESERVED, and why it needs no code here:
//   trackId, track name, visualOnly, grid placement, sampler settings, colour,
//   FX chains  -- the TrackInfo is never touched. The user may have renamed the
//                 track since the first import; their name wins over the MIDI
//                 track name by construction.
//   block positions, offsets, loopEnabled
//                 -- only `duration` is written, and only by the cascade.
//
// What CHANGES: the pattern's note set (and, derived from it, the pattern
// length and the duration of every block the user left untrimmed), plus the
// pattern's region binding when the dialog supplied a new one.
bool ImportMidiCommand::executeUpdateRow(Timeline& timeline,
                                         const ImportMidiCommandOptions::OutputTrackSpec& spec,
                                         int resolvedRegionId,
                                         bool bindRegion)
{
    const TrackInfo* track = timeline.getTrack(spec.targetTrackId);
    if (track == nullptr) {
        std::cout << "[MidiImport] output track " << spec.outputTrackIndex
                  << " FAILED (update): target trackId " << spec.targetTrackId
                  << " does not exist\n";
        return false;
    }
    // Hard-fail rather than fall back to creating a track: silently producing a
    // duplicate is exactly the behaviour re-import mode exists to eliminate.
    if (track->type != TrackInfo::Type::Pattern) {
        std::cout << "[MidiImport] output track " << spec.outputTrackIndex
                  << " FAILED (update): target trackId " << spec.targetTrackId
                  << " is a Clip track, not a Pattern track\n";
        return false;
    }

    // Notes live in the Pattern, not the track, so the update targets the
    // pattern the track carries. Collect the distinct patternIds among the
    // track's blocks.
    std::vector<int> distinctPatternIds;
    for (const PatternBlock* block : timeline.getPatternBlocksOnTrack(spec.targetTrackId)) {
        if (block == nullptr) continue;
        if (std::find(distinctPatternIds.begin(), distinctPatternIds.end(), block->patternId)
            == distinctPatternIds.end()) {
            distinctPatternIds.push_back(block->patternId);
        }
    }

    if (distinctPatternIds.size() > 1) {
        std::cout << "[MidiImport] output track " << spec.outputTrackIndex
                  << " FAILED (update): target trackId " << spec.targetTrackId
                  << " carries " << distinctPatternIds.size()
                  << " distinct patterns - ambiguous, no single note set to replace\n";
        return false;
    }

    if (distinctPatternIds.empty()) {
        // An existing but empty Pattern track: there is no note set to rewrite,
        // so give it one. Both new entities go on the created* vectors, so the
        // shared undo path removes them and the track is left empty again --
        // the track itself is NOT removed, because we did not create it.
        Pattern pattern;
        pattern.name     = spec.name;
        pattern.regionId = bindRegion ? resolvedRegionId : -1;
        const int patternId = timeline.addPattern(std::move(pattern));
        if (patternId < 0) {
            std::cout << "[MidiImport] output track " << spec.outputTrackIndex
                      << " FAILED (update): addPattern returned -1\n";
            return false;
        }
        createdPatternIds_.push_back(patternId);

        std::vector<PatternNote> notes = spec.notes;
        if (!notes.empty()) {
            timeline.addNotesToPatternBulk(patternId, notes);
        }

        TickTime blockDuration{ 0 };
        if (const Pattern* stored = timeline.getPattern(patternId)) {
            blockDuration = stored->length;
        }

        PatternBlock block;
        block.trackId   = spec.targetTrackId;
        block.patternId = patternId;
        block.position  = TickTime{ 0 };
        block.duration  = blockDuration;
        const int blockId = timeline.addPatternBlock(std::move(block));
        if (blockId < 0) {
            timeline.removePattern(patternId);
            createdPatternIds_.pop_back();
            std::cout << "[MidiImport] output track " << spec.outputTrackIndex
                      << " FAILED (update): addPatternBlock returned -1\n";
            return false;
        }
        createdPatternBlockIds_.push_back(blockId);

        std::cout << "[MidiImport]   updated (seeded empty) outputTrack="
                  << spec.outputTrackIndex << " trackId=" << spec.targetTrackId
                  << " patternId=" << patternId << " blockId=" << blockId
                  << " notes=" << spec.notes.size() << "\n";
        return true;
    }

    const int patternId = distinctPatternIds.front();
    const Pattern* pattern = timeline.getPattern(patternId);
    if (pattern == nullptr) {
        std::cout << "[MidiImport] output track " << spec.outputTrackIndex
                  << " FAILED (update): patternId " << patternId
                  << " referenced by a block on trackId " << spec.targetTrackId
                  << " does not exist\n";
        return false;
    }

    // ── Snapshot BEFORE the first mutation ───────────────────────────────────
    UpdatedTrackSnapshot snap;
    snap.trackId       = spec.targetTrackId;
    snap.patternId     = patternId;
    snap.notes         = pattern->notes;
    snap.nextNoteId    = pattern->nextNoteId;
    snap.patternLength = pattern->length;
    snap.regionId      = pattern->regionId;

    // EVERY block of this pattern, not just the ones on the target track: the
    // length cascade is pattern-wide, so a second placement of the same pattern
    // parked on another track is resized too and must be restorable.
    for (const PatternBlock* block : timeline.getAllPatternBlocks()) {
        if (block != nullptr && block->patternId == patternId) {
            snap.blockDurations.emplace_back(block->id, block->duration);
        }
    }

    // ── Region binding ───────────────────────────────────────────────────────
    // Rebind ONLY when the dialog handed us a region. regionId < 0 in update
    // mode means "leave the existing binding alone", not "clear it": it is the
    // value an untouched row carries, and dropping a working sample binding
    // because the user never opened the sample rail would be a worse failure
    // than being unable to clear one from this dialog.
    if (bindRegion && pattern->regionId != resolvedRegionId) {
        if (Pattern* mutablePattern = timeline.getPatternMutable(patternId)) {
            mutablePattern->regionId = resolvedRegionId;
        }
    }

    // ── Notes ────────────────────────────────────────────────────────────────
    // One swap, one length recalculation, one cascade. Copied because the id
    // rewrite must not leak back into options_ (a redo re-reads spec.notes).
    std::vector<PatternNote> notes = spec.notes;
    timeline.replacePatternNotes(patternId, notes);

    std::cout << "[MidiImport]   updated outputTrack=" << spec.outputTrackIndex
              << " trackId=" << spec.targetTrackId
              << " patternId=" << patternId
              << " notes " << snap.notes.size() << " -> " << notes.size()
              << " regionId " << snap.regionId << " -> "
              << (bindRegion ? resolvedRegionId : snap.regionId)
              << " blocks=" << snap.blockDurations.size() << "\n";

    updatedTracks_.push_back(std::move(snap));
    return true;
}
