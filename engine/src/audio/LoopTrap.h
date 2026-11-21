#pragma once
#include <cstdint>

// ─── LoopTrap ─────────────────────────────────────────────────────────────────
// Pure, header-only state machine for the live in-app playback loop trap.
//
// These functions contain the entire arm/disarm/wrap decision logic in a form
// that performs NO allocation, NO locking, and NO logging, so they are safe to
// call directly from the audio thread. Transport wraps them with atomics for the
// production master-clock path; the unit test (test_loop_region) drives them
// directly for deterministic coverage of every spec edge case.
//
// Sample domain throughout: the loop window is the half-open interval
// [startSamples, endSamples). `armed` is a latch owned by the caller.
//
// Phase 1 scope: live playback only. The wrap is a HARD JUMP (it may click at
// the seam). TODO(Phase 3): fold the tail / crossfade here — see loopAdvance.

namespace xleth {

// True when `pos` is inside the half-open loop window. A degenerate window
// (end <= start) contains nothing.
inline bool loopContains(int64_t pos, int64_t startSamples, int64_t endSamples) {
    return endSamples > startSamples && pos >= startSamples && pos < endSamples;
}

// Decide the arm latch on a DISCRETE transport event (play / seek / bounds set).
//
//   keepLatch == false (play, seek): armed becomes exactly "is the playhead
//       inside the window?". Start-inside arms immediately; start-outside does
//       not arm (natural entry, handled by loopAdvance, arms later). A seek
//       inside keeps it armed; a seek outside disarms it.
//   keepLatch == true (bounds changed): preserve an existing arm only while the
//       playhead is still inside the (possibly resized) window. Shrinking the
//       region past the playhead therefore disarms until the next natural entry,
//       and never yanks the playhead.
inline bool loopArmOnEvent(bool wasArmed, bool keepLatch,
                           int64_t pos, int64_t startSamples,
                           int64_t endSamples, bool enabled) {
    if (!enabled) return false;
    const bool inside = loopContains(pos, startSamples, endSamples);
    return keepLatch ? (wasArmed && inside) : inside;
}

// Advance the master clock by `numSamples`, applying the loop trap.
//
// `armed` is read AND written (latch). When disabled or the window is
// degenerate, this is a plain linear advance — playback behaves exactly as it
// does with no loop. When enabled:
//   • If not yet armed, the playhead arms the moment it naturally reaches the
//     window (and has not already passed it entirely). Out-of-bounds playback
//     before that first entry is NEVER blocked.
//   • Once armed, reaching endSamples wraps back to startSamples (carrying the
//     overshoot remainder so loop timing stays tempo-accurate).
//
// The carried overshoot is correct ONLY when the caller has already split its
// render at the seam. Advancing across the seam by a whole device buffer names
// a resume point past startSamples, and the samples in between are then
// rendered by nobody — see loopSamplesUntilWrap below.
//
// Returns the new sample position. PURE: no alloc, no locks, no logging.
inline int64_t loopAdvance(int64_t pos, int numSamples, bool& armed,
                           int64_t startSamples, int64_t endSamples,
                           bool enabled) {
    int64_t newPos = pos + numSamples;
    if (!enabled || endSamples <= startSamples)
        return newPos;

    // Natural entry: latch armed the first time the advancing window reaches the
    // region. `pos < endSamples` excludes the case where we started entirely
    // past the region (no backward jump on play-after).
    if (!armed && newPos >= startSamples && pos < endSamples)
        armed = true;

    if (armed && newPos >= endSamples) {
        const int64_t len = endSamples - startSamples;
        // ── Phase 1 seam: HARD JUMP back to start ───────────────────────────
        // Subtract whole loop lengths so a buffer that overshoots the end lands
        // at the matching offset past start. Bounded: len >= 1 sample and
        // numSamples is a single audio buffer, so this runs only a few times.
        // TODO(Phase 3): replace this hard jump with tail/crossfade folding
        // (tailMode / tailThresholdDb / tailMaxSeconds) to kill the seam click.
        while (newPos >= endSamples) {
            newPos -= len;
            if (newPos < startSamples) { newPos = startSamples; break; }
        }
    }
    return newPos;
}

// Number of samples that may be rendered from `pos` before the loop trap wraps.
//
// This is the seam splitter for the audio callback. Rendering a whole device
// buffer and only then calling loopAdvance() is WRONG: loopAdvance carries the
// overshoot across the seam, so playback resumes at (startSamples + overshoot)
// and the samples in [startSamples, startSamples + overshoot) are never
// rendered by any buffer. Every note that lands in that gap is silently
// dropped on every lap — including a note sitting exactly ON the loop start.
//
// The caller instead renders in sub-blocks:
//     chunk = loopSamplesUntilWrap(pos, remaining, armed, s, e, enabled);
//     render [pos, pos + chunk);
//     loopAdvance(pos, chunk, ...);   // lands exactly on startSamples at a seam
// so the region is covered contiguously and nothing past endSamples is heard.
//
// Returns `numSamples` unchanged when this block does not cross the loop end
// (trap disabled, degenerate window, never arms, or simply ends early). When it
// does cross, returns (endSamples - pos) — always in [1, numSamples].
//
// PURE: no alloc, no locks, no logging. Safe on the audio thread.
inline int loopSamplesUntilWrap(int64_t pos, int numSamples, bool armed,
                                int64_t startSamples, int64_t endSamples,
                                bool enabled) {
    if (!enabled || endSamples <= startSamples || numSamples <= 0)
        return numSamples;

    const int64_t newPos = pos + numSamples;

    // Mirror loopAdvance's natural-entry latch: a block may arm AND cross the
    // end within itself when the region is shorter than one device buffer.
    const bool willBeArmed = armed || (newPos >= startSamples && pos < endSamples);
    if (!willBeArmed)      return numSamples;  // no wrap can happen this block
    if (newPos < endSamples) return numSamples;  // does not reach the seam

    // Already at/past the end (only reachable if the bounds moved under a live
    // playhead). Nothing useful to split — let loopAdvance re-establish phase.
    if (pos >= endSamples) return numSamples;

    return static_cast<int>(endSamples - pos);  // 1 .. numSamples
}

} // namespace xleth
