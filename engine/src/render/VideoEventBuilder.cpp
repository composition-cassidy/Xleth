#include "render/VideoEventBuilder.h"

#include "model/ClipSourceAnchor.h"
#include "model/Clone.h"
#include "model/Timeline.h"
#include "render/ArpVideoExpander.h"
#include "render/VideoFlipApplier.h"

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <map>
#include <utility>

namespace xleth::videoevents {
namespace {

// Ticks -> beats, the same division TickTime::toBeats() does, kept in one
// spot so an event's start and end can never be converted two different ways.
double beatsFromTicks(int64_t ticks) noexcept
{
    return TickTime{ ticks }.toBeats();
}

struct PatternNoteRef {
    const PatternNote* note = nullptr;
    int sourceOrder = 0;
};

// Position, then the note's stable id (falling back to its index for notes
// that predate ids), then pitch. Same-tick chord members therefore reach the
// flip resolver in the same order every build, on every machine.
bool patternNoteRefLess(const PatternNoteRef& a, const PatternNoteRef& b) noexcept
{
    if (a.note->position.ticks != b.note->position.ticks)
        return a.note->position.ticks < b.note->position.ticks;

    const int orderA = a.note->id > 0 ? a.note->id : a.sourceOrder;
    const int orderB = b.note->id > 0 ? b.note->id : b.sourceOrder;
    if (orderA != orderB) return orderA < orderB;

    if (a.note->pitch != b.note->pitch) return a.note->pitch < b.note->pitch;
    return a.sourceOrder < b.sourceOrder;
}

std::vector<PatternNoteRef> sortedPatternNoteRefs(const Pattern& pattern)
{
    std::vector<PatternNoteRef> refs;
    refs.reserve(pattern.notes.size());
    for (int i = 0; i < static_cast<int>(pattern.notes.size()); ++i)
        refs.push_back({ &pattern.notes[static_cast<std::size_t>(i)], i });
    std::sort(refs.begin(), refs.end(), patternNoteRefLess);
    return refs;
}

int sourceOrderFor(const PatternNote& note, int fallbackOrder) noexcept
{
    return note.id > 0 ? note.id : fallbackOrder;
}

// ── Clip tracks: one VideoEvent per video-backed clip ───────────────────────
void buildClipEvents(const Timeline& timeline, double bpm, double sampleRate,
                     BuildResult& out)
{
    auto clips = timeline.getAllClips();
    clips.erase(std::remove(clips.begin(), clips.end(), nullptr), clips.end());

    // Track, then position, then id. The id tie-break matters: two clips at the
    // same tick on one track used to land in whatever order an unstable sort
    // left them, so their flip states could swap between two builds of the
    // same project.
    std::sort(clips.begin(), clips.end(),
        [](const Clip* a, const Clip* b) {
            if (a->trackId != b->trackId) return a->trackId < b->trackId;
            if (a->position.ticks != b->position.ticks)
                return a->position.ticks < b->position.ticks;
            return a->id < b->id;
        });

    int counter     = 0;
    int lastTrackId = -1;
    bool haveTrack  = false;

    for (const Clip* clip : clips) {
        const TrackInfo* track = timeline.getTrack(clip->trackId);
        if (!track) { ++out.stats.clipsSkipped; continue; }

        const SampleRegion* region = timeline.getRegion(clip->regionId);
        if (!region) { ++out.stats.clipsSkipped; continue; }

        const SourceMedia* source = timeline.getSource(region->sourceId);
        if (!source || !source->hasVideo) { ++out.stats.clipsSkipped; continue; }

        // Per-track running index, in timeline order.
        if (!haveTrack || clip->trackId != lastTrackId) {
            counter     = 0;
            lastTrackId = clip->trackId;
            haveTrack   = true;
        }

        VideoEvent ev;
        ev.startBeat     = clip->position.toBeats();
        ev.durationBeats = clip->duration.toBeats();
        ev.startTick     = static_cast<double>(clip->position.ticks);   // clip lens keys' origin
        ev.lengthTicks   = static_cast<double>(clip->duration.ticks);
        ev.hasTickSpan   = true;
        ev.sourceId      = region->sourceId;
        ev.trackId       = clip->trackId;
        ev.regionId      = clip->regionId;   // routes to the per-region proxy

        // Source anchor = region start + syllable offset + clip trim, through
        // the one helper MixEngine's readhead agrees with
        // (model/ClipSourceAnchor.h). Syllable times are REGION-RELATIVE.
        const double syllableStart =
            (clip->syllableIndex >= 0
             && clip->syllableIndex < static_cast<int>(region->syllables.size()))
                ? region->syllables[static_cast<std::size_t>(clip->syllableIndex)].startTime
                : 0.0;
        ev.sourceStartTime = xleth::anchoring::clipSourceAnchorSeconds(
            region->startTime, clip->regionOffset.ticks, bpm, syllableStart);
        ev.sourceEndTime        = region->endTime;
        ev.sourceClampStartTime = region->startTime;

        ev.clipId            = clip->id;
        ev.hasClipModulation = clip->modulation.enabled
            && (clip->modulation.vibrato.enabled || clip->modulation.scratch.enabled);
        ev.modulation           = clip->modulation;
        ev.clipReversed         = clip->reversed;
        ev.clipStretchRatio     = clip->stretchRatio;
        ev.clipFormantPreserve  = clip->formantPreserve;
        ev.clipPitchOffsetSemis = clip->pitchOffset;
        ev.clipPitchOffsetCents = clip->pitchOffsetCents;
        ev.clipStartTimelineSamples = static_cast<int64_t>(
            std::llround(ev.startBeat * 60.0 / bpm * sampleRate));

        ev.layerIndex = 0;   // unused by the grid compositor path
        ev.x      = track->videoX;
        ev.y      = track->videoY;
        ev.width  = track->videoW;
        ev.height = track->videoH;
        ev.opacity = track->videoOpacity * clip->velocity;

        ev.fadeInPercent  = clip->fadeInPercent;
        ev.fadeOutPercent = clip->fadeOutPercent;
        normalizeClipFadePercents(ev.fadeInPercent, ev.fadeOutPercent);
        ev.fadeInX1  = clip->fadeInX1;   ev.fadeInY1  = clip->fadeInY1;
        ev.fadeInX2  = clip->fadeInX2;   ev.fadeInY2  = clip->fadeInY2;
        ev.fadeOutX1 = clip->fadeOutX1;  ev.fadeOutY1 = clip->fadeOutY1;
        ev.fadeOutX2 = clip->fadeOutX2;  ev.fadeOutY2 = clip->fadeOutY2;

        const int emissionOrder = counter++;
        ev.globalNoteIndex       = emissionOrder;
        ev.hasSourceTriggerOrder = true;
        ev.sourceTriggerOrder    = clip->id > 0 ? clip->id : emissionOrder;
        ev.originalEmissionOrder = emissionOrder;
        ev.pitch = clip->pitchOffset;   // flip-v2 resolver input (spec §1)

        out.events.push_back(std::move(ev));
        ++out.stats.clipEvents;
    }
}

// ── Voice clones (model/Clone.h) ─────────────────────────────────────────────
// Where a source track's notes go: voice 0 is the source itself, voice k its
// k-th Voice clone. Resolved once per track per build; empty (the source plays
// everything, today's path) for every track without Voice clones.
struct VoiceRouting {
    bool               resolved = false;
    std::vector<const TrackInfo*> clones;   // voice k = clones[k - 1]
    std::vector<int>   lensTrackIds;        // per clone: source (Linked) or the clone (Own)
};

// ── Pattern tracks: one VideoEvent per audible note-on ──────────────────────
void buildPatternEvents(const Timeline& timeline, double bpm, BuildResult& out)
{
    // Per source track: its Voice clones. Per (track, pattern): the voice of
    // every note, decided from the pattern alone (so a seek, the preview and
    // the export all agree), computed once per build on this message-thread
    // pass, never on the render or audio thread.
    std::map<int, VoiceRouting> routingByTrack;
    std::map<std::pair<int, int>, std::vector<clones::VoiceSlot>> voicesByTrackPattern;
    auto routingFor = [&](const TrackInfo& track) -> const VoiceRouting& {
        VoiceRouting& r = routingByTrack[track.id];
        if (!r.resolved) {
            r.resolved = true;
            if (!track.isClone()) {
                r.clones = clones::voiceClonesOf(timeline, track.id);
                for (const TrackInfo* c : r.clones)
                    r.lensTrackIds.push_back(c->cloneLensMode == CloneLensMode::Own ? c->id : track.id);
            }
        }
        return r;
    };

    auto blocks = timeline.getAllPatternBlocks();
    blocks.erase(std::remove(blocks.begin(), blocks.end(), nullptr), blocks.end());
    std::sort(blocks.begin(), blocks.end(),
        [](const PatternBlock* a, const PatternBlock* b) {
            if (a->trackId != b->trackId) return a->trackId < b->trackId;
            if (a->position.ticks != b->position.ticks)
                return a->position.ticks < b->position.ticks;
            return a->id < b->id;
        });

    int counter     = 0;
    int lastTrackId = -1;
    bool haveTrack  = false;

    for (const PatternBlock* block : blocks) {
        const TrackInfo* track = timeline.getTrack(block->trackId);
        if (!track) { ++out.stats.blocksSkipped; continue; }
        // A Clone has no blocks of its own (it is driven by its source's).
        if (track->isClone()) { ++out.stats.blocksSkipped; continue; }

        const Pattern* pattern = timeline.getPattern(block->patternId);
        if (!pattern) { ++out.stats.blocksSkipped; continue; }

        const int64_t patternLenTicks    = pattern->length.ticks;
        const int64_t blockPosTicks      = block->position.ticks;
        const int64_t blockDurationTicks = block->duration.ticks;
        if (patternLenTicks <= 0 || blockDurationTicks <= 0) {
            ++out.stats.blocksSkipped; continue;
        }

        const SampleRegion* region = timeline.getRegion(pattern->regionId);
        if (!region) { ++out.stats.blocksSkipped; continue; }

        const SourceMedia* source = timeline.getSource(region->sourceId);
        if (!source || !source->hasVideo) { ++out.stats.blocksSkipped; continue; }

        // The counter runs across every block of a track, in timeline order, so
        // a flip cycle carries over block boundaries instead of restarting.
        if (!haveTrack || block->trackId != lastTrackId) {
            counter     = 0;
            lastTrackId = block->trackId;
            haveTrack   = true;
        }

        // The block shows the slice [offset, offset + duration) of an endless
        // tape made of the pattern repeated end to end. Loop iteration L puts a
        // note at tape position L * patternLen + note.position.
        //
        // Mirrors MixEngine::processPatternBlock: iterations start at 0 (an
        // offset that rolls the window start negative still plays from the
        // first pass), and with looping off ONLY iteration 0 exists — whatever
        // the block spans past the pattern end is empty, in the picture as in
        // the sound.
        const int64_t windowStart   = block->offset.ticks;
        const int64_t windowEnd     = windowStart + blockDurationTicks;
        const int64_t blockEndTicks = blockPosTicks + blockDurationTicks;
        if (windowEnd <= 0) continue;   // the whole window sits before the tape starts

        const int64_t firstLoopIdx = std::max<int64_t>(0, windowStart / patternLenTicks);
        int64_t       lastLoopIdx  = (windowEnd - 1) / patternLenTicks;
        if (!block->loopEnabled)
            lastLoopIdx = std::min<int64_t>(lastLoopIdx, 0);

        const auto noteRefs = sortedPatternNoteRefs(*pattern);

        if (region->arpEnabled) {
            // Arpeggiated: simulate the arp in beat space and emit one event per
            // arp step instead of per note.
            std::vector<const PatternNote*> notes;
            notes.reserve(noteRefs.size());
            for (const auto& ref : noteRefs) notes.push_back(ref.note);

            auto arpEvents = ArpVideoExpander::expandArpVideoEvents(
                notes, blockPosTicks, blockDurationTicks,
                patternLenTicks, block->loopEnabled,
                firstLoopIdx, lastLoopIdx,
                windowStart, windowEnd,
                region->arpTempoSync, region->arpDivision,
                region->arpFreeTimeMs, region->arpGate,
                region->arpRange, region->arpDirection,
                bpm,
                region->sourceId, block->trackId,
                pattern->regionId,
                region->startTime, region->endTime,
                counter);

            for (auto& ev : arpEvents) {
                // Arp steps are timed in beat space (free-time steps are not
                // on the tick grid), so their tick span is the beats * 960.
                // A step is not one note (the arp cycles the held notes), so
                // it carries no note key: arp steps play the hit curve
                // (Follow), never a per-note override.
                ev.startTick   = ev.startBeat * 960.0;
                ev.lengthTicks = ev.durationBeats * 960.0;
                ev.hasTickSpan = true;
                ev.x      = track->videoX;
                ev.y      = track->videoY;
                ev.width  = track->videoW;
                ev.height = track->videoH;
                ev.opacity *= track->videoOpacity;
            }
            out.stats.noteEvents += static_cast<int>(arpEvents.size());
            out.events.insert(out.events.end(),
                              std::make_move_iterator(arpEvents.begin()),
                              std::make_move_iterator(arpEvents.end()));
            continue;
        }

        // Voice clones: the voice of every note of this pattern on this track
        // (arp steps above are one stream and always play on the source).
        const VoiceRouting& routing = routingFor(*track);
        const std::vector<clones::VoiceSlot>* voices = nullptr;
        if (!routing.clones.empty()) {
            const auto key = std::make_pair(track->id, pattern->id);
            auto it = voicesByTrackPattern.find(key);
            if (it == voicesByTrackPattern.end())
                it = voicesByTrackPattern.emplace(key,
                         clones::assignVoices(*pattern, static_cast<int>(routing.clones.size()))).first;
            voices = &it->second;
        }

        for (int64_t L = firstLoopIdx; L <= lastLoopIdx; ++L) {
            for (const auto& noteRef : noteRefs) {
                const PatternNote& note = *noteRef.note;
                const int64_t tapePos = L * patternLenTicks + note.position.ticks;
                if (tapePos < windowStart) continue;
                if (tapePos >= windowEnd)  continue;

                const int64_t startTicks = blockPosTicks + (tapePos - windowStart);

                // Slide notes spawn no video cell: they fire a per-track visual
                // effect on the cell that is already there. Their duration is
                // NOT clamped to the block — the audio glide they accompany
                // runs its full length too (MixEngine emits SlideStart with the
                // note's whole duration).
                if (note.isSlide) {
                    SlideAnimationEvent se;
                    se.startBeat     = beatsFromTicks(startTicks);
                    se.durationBeats = beatsFromTicks(note.duration.ticks);
                    se.trackId       = block->trackId;
                    se.slideVelocity = note.velocity;
                    se.slideCurveCx  = note.slideCurveCx;
                    se.slideCurveCy  = note.slideCurveCy;
                    out.slideEvents.push_back(se);
                    ++out.stats.slideEvents;
                    continue;
                }

                // The note-off is clamped to the block end, exactly as the audio
                // clamps it, so a note that overruns its block stops showing
                // when it stops sounding.
                const int64_t endTicks =
                    std::min<int64_t>(startTicks + note.duration.ticks, blockEndTicks);
                if (endTicks <= startTicks) continue;

                VideoEvent ev;
                ev.startBeat     = beatsFromTicks(startTicks);
                ev.durationBeats = beatsFromTicks(endTicks - startTicks);
                // The hit curve's clock: note-on and the CLAMPED length
                // (spec Ruling 4: Tail anchors where the video stops).
                ev.startTick     = static_cast<double>(startTicks);
                ev.lengthTicks   = static_cast<double>(endTicks - startTicks);
                ev.hasTickSpan   = true;
                ev.sourceId      = region->sourceId;
                ev.trackId       = block->trackId;
                ev.regionId      = pattern->regionId;
                // Every note retriggers the sample from the region start.
                ev.sourceStartTime      = region->startTime;
                ev.sourceEndTime        = region->endTime;
                ev.sourceClampStartTime = region->startTime;
                ev.layerIndex = 0;
                ev.x      = track->videoX;
                ev.y      = track->videoY;
                ev.width  = track->videoW;
                ev.height = track->videoH;
                ev.opacity = track->videoOpacity * note.velocity;

                const int emissionOrder = counter++;
                ev.globalNoteIndex       = emissionOrder;
                ev.hasSourceTriggerOrder = true;
                ev.sourceTriggerOrder    = sourceOrderFor(note, noteRef.sourceOrder);
                ev.originalEmissionOrder = emissionOrder;
                ev.pitch = note.pitch;   // flip-v2 resolver input
                // The {patternId, noteId} of its Lens override (Follow / Nudge /
                // Own). A note without a real id (<= 0, old data) has no address
                // and plays Follow.
                if (note.id > 0) {
                    ev.lensPatternId = pattern->id;
                    ev.lensNoteId    = note.id;
                }

                // A note assigned to Voice k >= 1 shows in that Voice clone's
                // cell: its placement, Roam, effects and flip sequence, with
                // the clone's own layout fields and opacity. Its Lens is the
                // source's (Linked) or the clone's (Own); the note's override
                // travels with it either way. Overflow and voice 0 stay here.
                if (voices) {
                    const std::size_t idx = static_cast<std::size_t>(noteRef.sourceOrder);
                    const int v = idx < voices->size() ? (*voices)[idx].voice : 0;
                    if (v >= 1 && v <= static_cast<int>(routing.clones.size())) {
                        const TrackInfo& clone = *routing.clones[static_cast<std::size_t>(v - 1)];
                        ev.trackId     = clone.id;
                        ev.lensTrackId = routing.lensTrackIds[static_cast<std::size_t>(v - 1)];
                        ev.x       = clone.videoX;
                        ev.y       = clone.videoY;
                        ev.width   = clone.videoW;
                        ev.height  = clone.videoH;
                        ev.opacity = clone.videoOpacity * note.velocity;
                        ++out.stats.voiceCloneEvents;
                    }
                }

                out.events.push_back(std::move(ev));
                ++out.stats.noteEvents;
            }
        }
    }
}

} // namespace

BuildResult build(const Timeline& timeline, double bpm, double sampleRate)
{
    BuildResult out;
    if (!(bpm > 0.0) || !std::isfinite(bpm)) bpm = 140.0;
    if (!(sampleRate > 0.0) || !std::isfinite(sampleRate)) sampleRate = 48000.0;

    buildClipEvents(timeline, bpm, sampleRate, out);
    buildPatternEvents(timeline, bpm, out);

    // Single flip-resolution pass over the complete list: chord detection,
    // per-track resolver, write-back of monoOrdinal / stateIndex / orientation.
    // A no-op for tracks whose VideoFlipConfig is disabled.
    videoFlipApplier::applyAll(out.events, timeline);

    return out;
}

} // namespace xleth::videoevents
