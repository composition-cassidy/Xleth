#include "VideoFlipApplier.h"

#include "SyncManager.h"                  // VideoEvent
#include "model/TimelineTypes.h"          // VideoFlipConfig, Orientation
#include "model/Timeline.h"               // Timeline (track lookup, time-sig)
#include "model/VideoFlipResolver.h"      // resolveStateIndex, TriggerEvent

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <unordered_map>

namespace {

// Project tick rate. Xleth fixes this at 960 PPQ across the codebase
// (see TickTime in TimelineTypes.h). The applier reads it from this
// constant rather than threading it through every call signature.
constexpr int kTicksPerBeat = 960;

// Round VideoEvent.startBeat (double) to an integer tick. Pattern-track and
// clip-track events are derived from int64 tick math, so the round-trip
// through double preserves integer values exactly. Arp expansion can land
// on non-integer beats (e.g. 5.333 for triplet division), but those events
// are never co-located with another event on the same track at the same
// floating-point position — chord detection only matters for true ties.
int64_t eventTick(const VideoEvent& ev) {
    return static_cast<int64_t>(std::llround(ev.startBeat * kTicksPerBeat));
}

}  // namespace

namespace videoFlipApplier {

void applyTrack(std::vector<VideoEvent*>& trackEvents,
                const VideoFlipConfig&    config,
                int                       ticksPerBeat,
                int                       beatsPerBar) {
    if (trackEvents.empty()) return;

    // ── Disabled config short-circuit ─────────────────────────────────────
    // Spec §3.1: enabled=false → identity render, no resolver work. We still
    // zero monoOrdinal/stateIndex/orientation so downstream code (FrameCollector,
    // shader) sees deterministic values.
    if (!config.enabled) {
        for (VideoEvent* ev : trackEvents) {
            ev->monoOrdinal = -1;
            ev->stateIndex  = 0;
            ev->orientation = Orientation::None;
        }
        return;
    }

    // ── Sort by tick (stable, preserves emission order within ties) ───────
    std::stable_sort(trackEvents.begin(), trackEvents.end(),
        [](const VideoEvent* a, const VideoEvent* b) {
            return eventTick(*a) < eventTick(*b);
        });

    // ── Detect chord groups; build mono-only resolver input ───────────────
    // ≥2 events sharing a tick on the same track → chord (skipped from the
    // mono ordinal counter and from the resolver input list).
    const std::size_t n = trackEvents.size();
    std::vector<bool>         isMono(n, false);
    std::vector<TriggerEvent> monoEvents;
    monoEvents.reserve(n);

    for (std::size_t i = 0; i < n; ) {
        const int64_t tick = eventTick(*trackEvents[i]);
        std::size_t j = i + 1;
        while (j < n && eventTick(*trackEvents[j]) == tick) ++j;
        if (j - i == 1) {
            isMono[i] = true;
            monoEvents.push_back({tick, trackEvents[i]->pitch});
        }
        i = j;
    }

    // ── Run the pure resolver once for this track ─────────────────────────
    const std::vector<int> resolved =
        resolveStateIndex(config, monoEvents, ticksPerBeat, beatsPerBar);

    // Compute the safe lookup parameters (defensively clamped — the resolver
    // already does the same internally, but the orientation lookup needs them
    // too in case `resolved` returns out-of-range values from a future modifier).
    const int  numStates = static_cast<int>(config.states.size());
    int        startIdx  = config.startStateIndex;
    if (startIdx < 0)             startIdx = 0;
    if (numStates > 0 && startIdx >= numStates) startIdx = numStates - 1;

    auto orientationOf = [&](int stateIdx) -> Orientation {
        if (config.states.empty()) return Orientation::None;
        if (stateIdx < 0)                                   stateIdx = 0;
        if (stateIdx >= static_cast<int>(config.states.size()))
            stateIdx = static_cast<int>(config.states.size()) - 1;
        return config.states[stateIdx].orientation;
    };

    // ── Write back. Chord events inherit the most-recent prior mono state. ─
    int  monoCounter   = 0;
    int  lastMonoState = startIdx;
    bool hasPriorMono  = false;

    for (std::size_t k = 0; k < n; ++k) {
        VideoEvent* ev = trackEvents[k];
        int stateIdx;
        if (isMono[k]) {
            stateIdx = (monoCounter < static_cast<int>(resolved.size()))
                ? resolved[monoCounter]
                : startIdx;
            ev->monoOrdinal = monoCounter;
            ++monoCounter;
            lastMonoState = stateIdx;
            hasPriorMono  = true;
        } else {
            // Chord event: render the inherited state, do NOT advance, do NOT
            // bump the mono ordinal. With no prior mono on this track, fall
            // back to startStateIndex (spec §4.4 row 2).
            stateIdx = hasPriorMono ? lastMonoState : startIdx;
            ev->monoOrdinal = -1;
        }
        ev->stateIndex  = stateIdx;
        ev->orientation = orientationOf(stateIdx);
    }
}

void applyAll(std::vector<VideoEvent>& events, const Timeline& timeline) {
    if (events.empty()) return;

    // Group event pointers by trackId. Using ptr+map keeps the in-place
    // mutation semantics (apply writes back through the original vector).
    std::unordered_map<int, std::vector<VideoEvent*>> byTrack;
    for (VideoEvent& ev : events) byTrack[ev.trackId].push_back(&ev);

    const int beatsPerBar = std::max(1, timeline.getTimeSigNum());

    for (auto& kv : byTrack) {
        const int trackId = kv.first;
        const TrackInfo* track = timeline.getTrack(trackId);
        if (!track) {
            // Unknown track (orphaned event) — leave defaults (mono=-1, state=0, none).
            continue;
        }
        applyTrack(kv.second, track->videoFlipConfig, kTicksPerBeat, beatsPerBar);
    }
}

}  // namespace videoFlipApplier
