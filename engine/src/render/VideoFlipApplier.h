#pragma once
// VideoFlipApplier — single resolver call site for the entire event-build pipeline.
//
// Spec: xleth-flip-v2-architecture-spec.md §4.1, §4.3, §5.1.
//
// All three event-build paths (OfflineRenderer clip loop, OfflineRenderer
// pattern loop / ArpVideoExpander, bridge XlethAddon::rebuildVideoEventsFromClips)
// converge here. The applier:
//   1. Groups events by trackId.
//   2. Per track, sorts events by tick and detects chord groups (≥2 events
//      sharing the same tick).
//   3. Builds a mono-only TriggerEvent list and runs `resolveStateIndex`
//      (the pure resolver from VideoFlipResolver.h) ONCE per track.
//   4. Writes monoOrdinal / stateIndex / orientation back to each event.
//      Chord events inherit stateIndex from the most recent prior mono event
//      (or startStateIndex if none); they do NOT advance state and they are
//      marked monoOrdinal = -1.
//
// Determinism: same project + same input event list → same output. The
// applier is pure, stateless, and threadsafe.

#include <vector>

class Timeline;
struct VideoEvent;
struct VideoFlipConfig;

namespace videoFlipApplier {

// Per-track entry point. All pointers in `trackEvents` must reference events
// belonging to a single track. Public so unit tests can drive it directly
// without spinning up a Timeline.
void applyTrack(std::vector<VideoEvent*>& trackEvents,
                const VideoFlipConfig&    config,
                int                       ticksPerBeat,
                int                       beatsPerBar = 4);

// Convenience: groups events by trackId, looks up each track's
// VideoFlipConfig from the timeline, and runs `applyTrack` per group.
// Reads `timeline.getTimeSigNum()` for the every-n-beats(bar) modifier.
//
// Call this once after a build loop completes — the events list size is
// preserved; only the new flip-v2 fields on each VideoEvent are mutated.
void applyAll(std::vector<VideoEvent>& events,
              const Timeline&          timeline);

}  // namespace videoFlipApplier
