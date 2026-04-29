#include "VideoFlipResolver.h"

#include <algorithm>

namespace {

// True when `pitch` appears in the whitelist. Linear scan: whitelists are tiny
// (≤12 in practice) and v1 has no per-event hot path requirement here.
bool pitchInWhitelist(const std::vector<int>& whitelist, int pitch) {
    return std::find(whitelist.begin(), whitelist.end(), pitch) != whitelist.end();
}

// Resolves a single tick to a stateIndex for the every-n-beats modifier.
// State at tick T = ((floor((T - anchor) / ticksPerUnit / n) + startStateIndex) mod numStates)
// with anchor = 0 in v1 (project start). Negative results from C++ % on negative
// dividends are normalised to [0, numStates).
int resolveByBeats(int64_t tick,
                   int     n,
                   int     unitTicks,
                   int     startStateIndex,
                   int     numStates) {
    // Defensive clamps — a 0/negative period would divide-by-zero.
    if (n         < 1) n         = 1;
    if (unitTicks < 1) unitTicks = 1;

    const int64_t period = static_cast<int64_t>(unitTicks) * n;
    // Floor-division semantics: C++ truncates toward zero, but the spec says
    // "floor". For non-negative ticks the two coincide; for safety we still
    // normalise the modulo so a future caller can pass anchored ticks.
    int64_t k = tick / period;
    if (tick < 0 && tick % period != 0)
        k -= 1;  // emulate floor for negative dividends

    const int64_t raw = k + startStateIndex;
    int idx = static_cast<int>(((raw % numStates) + numStates) % numStates);
    return idx;
}

}  // namespace

std::vector<int> resolveStateIndex(const VideoFlipConfig&           config,
                                   const std::vector<TriggerEvent>& monoTriggerEvents,
                                   int                              ticksPerBeat,
                                   int                              beatsPerBar) {
    const std::size_t nEvents = monoTriggerEvents.size();

    // ── Short-circuits ────────────────────────────────────────────────────────
    // Disabled config, or a degenerate states list (1 entry, no cycle), trivially
    // resolves every event to stateIndex 0. No modifier work required.
    if (!config.enabled || config.states.size() <= 1) {
        return std::vector<int>(nEvents, 0);
    }

    const int numStates = static_cast<int>(config.states.size());

    // Clamp startStateIndex to [0, numStates) — the UI auto-clamps on edit, but
    // a project file written by an older build (or hand-edited JSON) might land
    // out of range. Tolerate it without crashing.
    int startIdx = config.startStateIndex;
    if (startIdx < 0)            startIdx = 0;
    if (startIdx >= numStates)   startIdx = numStates - 1;

    // ── every-n-beats: clock-driven, no event walk ────────────────────────────
    if (config.modifier.type == VideoFlipModifier::Type::EveryNBeats) {
        const int n         = config.modifier.n;
        const int unitTicks = (config.modifier.subdivision == VideoFlipModifier::Subdivision::Bar)
            ? ticksPerBeat * std::max(1, beatsPerBar)
            : ticksPerBeat;
        std::vector<int> result;
        result.reserve(nEvents);
        for (const auto& ev : monoTriggerEvents) {
            result.push_back(resolveByBeats(ev.tick, n, unitTicks, startIdx, numStates));
        }
        return result;
    }

    // ── Walked modifiers: every-note, new-note, specific-pitches ──────────────
    // State persists across the loop. previousMonoPitch is updated on every
    // mono event (the upstream filter has already removed chord events, which
    // are the only events that would NOT update previous-pitch memory).
    std::vector<int> result;
    result.reserve(nEvents);

    int  stateIdx        = startIdx;
    bool hasPrevious     = false;   // becomes true after the first mono event
    int  previousPitch   = 0;       // valid only when hasPrevious == true

    for (const auto& ev : monoTriggerEvents) {
        bool advance = false;

        switch (config.modifier.type) {
            case VideoFlipModifier::Type::EveryNote:
                // Every mono trigger advances — except the very first.
                advance = hasPrevious;
                break;

            case VideoFlipModifier::Type::NewNote:
                // Advance only when pitch differs from the previous mono pitch.
                // First trigger: no advance.
                advance = hasPrevious && (ev.pitch != previousPitch);
                break;

            case VideoFlipModifier::Type::SpecificPitches:
                // Whitelisted pitch ALWAYS advances, including the first one
                // (whitelist semantics override the first-trigger rule).
                // Non-whitelisted mono triggers render the current state without
                // advancing.
                advance = pitchInWhitelist(config.modifier.pitches, ev.pitch);
                break;

            case VideoFlipModifier::Type::EveryNBeats:
                // Handled by the clock branch above; unreachable here.
                break;
        }

        if (advance)
            stateIdx = (stateIdx + 1) % numStates;

        result.push_back(stateIdx);

        // Update mono history. Per spec §3.3.2: chord events do not update
        // previous-mono memory, but the resolver only sees mono events, so this
        // unconditional update is correct.
        hasPrevious   = true;
        previousPitch = ev.pitch;
    }

    return result;
}
