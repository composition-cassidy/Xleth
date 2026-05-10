#include "commands/ImportMidiCommand.h"

#include "SampleBank.h"
#include "audio/MixEngine.h"
#include "model/Timeline.h"

#include <chrono>
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

    // 2. For each selected output track, create the pattern container.
    // Region/sample resolution is conditional: assigned rows use the existing
    // region binding path, while regionId < 0 imports as an unassigned pattern.
    for (auto& spec : options_.outputTracks) {
        const bool hasAssignedRegion = spec.regionId >= 0;
        const SampleRegion* region = nullptr;
        bool wasAlreadyMapped = false;
        bool createdSampleMapping = false;
        int sampleBankId = -1;

        if (hasAssignedRegion) {
            // 2a. Resolve the existing region.
            region = timeline.getRegion(spec.regionId);
            if (region == nullptr) {
#ifdef XLETH_DEBUG
                std::fprintf(stderr,
                             "[MidiImport] regionId %d not found - skipping output track %d\n",
                             spec.regionId, spec.outputTrackIndex);
                std::fflush(stderr);
#endif
                continue;
            }

            // 2b. Determine sample slot - reuse if already mapped, otherwise load.
            const int existingSampleId = mixEngine_->getSampleIdForRegion(spec.regionId);
            wasAlreadyMapped = (existingSampleId >= 0);

            if (wasAlreadyMapped) {
                sampleBankId = existingSampleId;
#ifdef XLETH_DEBUG
                std::fprintf(stderr,
                             "[MidiImport]   regionId=%d already mapped -> reusing sampleId=%d\n",
                             spec.regionId, sampleBankId);
                std::fflush(stderr);
#endif
            } else {
                // Resolve audio path. Mirror Audio_LoadRegionAudio: prefer swapped
                // audio if present, otherwise the source media's file path with the
                // region's [startTime, endTime] window.
                const SourceMedia* source = timeline.getSource(region->sourceId);
                if (source == nullptr || source->filePath.empty()) {
#ifdef XLETH_DEBUG
                    std::fprintf(stderr,
                                 "[MidiImport] regionId %d source %d unresolved - skipping\n",
                                 spec.regionId, region->sourceId);
                    std::fflush(stderr);
#endif
                    continue;
                }

                const std::string audioPath =
                    (region->hasSwappedAudio && !region->swappedAudioPath.empty())
                        ? region->swappedAudioPath
                        : source->filePath;

                sampleBankId = sampleBank_->loadSampleFromSource(
                    audioPath, region->startTime, region->endTime, engineSampleRate_);
                if (sampleBankId < 0) {
#ifdef XLETH_DEBUG
                    std::fprintf(stderr,
                                 "[MidiImport] loadSampleFromSource failed for regionId=%d path=%s - skipping\n",
                                 spec.regionId, audioPath.c_str());
                    std::fflush(stderr);
#endif
                    continue;
                }

                mixEngine_->mapRegionToSample(spec.regionId, sampleBankId);
                createdSampleSlots_.push_back(CreatedSampleSlotInfo{ sampleBankId, audioPath });
                createdMappedRegionIds_.push_back(spec.regionId);
                createdSampleMapping = true;
            }
        } else {
#ifdef XLETH_DEBUG
            std::fprintf(stderr,
                         "[MidiImport] output track %d importing as unassigned pattern\n",
                         spec.outputTrackIndex);
            std::fflush(stderr);
#endif
        }

        // 2c. Create TrackInfo (Pattern type).
        TrackInfo track;
        track.type       = TrackInfo::Type::Pattern;
        track.name       = spec.name;
        track.visualOnly = spec.visualOnly;
        const int trackId = timeline.addTrack(std::move(track));
        if (trackId < 0) {
#ifdef XLETH_DEBUG
            std::fprintf(stderr,
                         "[MidiImport] addTrack failed for output track %d\n",
                         spec.outputTrackIndex);
            std::fflush(stderr);
#endif
            // Roll back this iteration's sample-load if we just performed one.
            if (createdSampleMapping) {
                mixEngine_->unmapRegion(spec.regionId);
                sampleBank_->unloadSample(sampleBankId);
                createdSampleSlots_.pop_back();
                createdMappedRegionIds_.pop_back();
            }
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
            if (createdSampleMapping) {
                mixEngine_->unmapRegion(spec.regionId);
                sampleBank_->unloadSample(sampleBankId);
                createdSampleSlots_.pop_back();
                createdMappedRegionIds_.pop_back();
            }
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

        // 2g. Place the pattern at position 0 on the new track.
        PatternBlock block;
        block.trackId   = trackId;
        block.patternId = patternId;
        block.position  = TickTime{ 0 };
        block.duration  = blockDuration;
        const int blockId = timeline.addPatternBlock(std::move(block));
        if (blockId < 0) {
#ifdef XLETH_DEBUG
            std::fprintf(stderr,
                         "[MidiImport] addPatternBlock failed for track %d pattern %d\n",
                         trackId, patternId);
            std::fflush(stderr);
#endif
            continue;
        }
        createdPatternBlockIds_.push_back(blockId);

#ifdef XLETH_DEBUG
        std::fprintf(stderr,
                     "[MidiImport]   bound outputTrack=%d trackId=%d regionId=%d sampleId=%d "
                     "patternId=%d blockId=%d notes=%zu reusedMapping=%d\n",
                     spec.outputTrackIndex, trackId, spec.regionId, sampleBankId,
                     patternId, blockId, spec.notes.size(), wasAlreadyMapped ? 1 : 0);
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

    // Reverse order: blocks -> patterns -> unmap (only command-created mappings) ->
    // unload (only command-created slots) -> remove regions (defensive, empty in
    // normal flow) -> remove tracks -> restore BPM -> defensive snapshot restore.

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
    return "Import MIDI";
}

void ImportMidiCommand::capturePreImportState(Timeline& timeline)
{
    preBpm_ = timeline.getBPM();

    if (mixEngine_ != nullptr) {
        preRegionToSampleMap_ = mixEngine_->getRegionToSampleMapSnapshot();
    } else {
        preRegionToSampleMap_.clear();
    }
}
