#pragma once

// ---------------------------------------------------------------------------
// SnapshotTransitionTiming — pure, deterministic time->progress mapping for the
// snapshot transition system (see docs/plans/snapshot-transition-system-spec.md).
//
// A snapshot transition blends an outgoing snapshot A into an incoming snapshot B
// across a window [start, pin, end] on the render timeline. A single progress
// value `t` runs 0 -> 1 across the window, with the PIN anchored to t = 0.5 (the
// even-blend point, which lands on the musical boundary). Because the Start and
// End handles sit at INDEPENDENT distances from the pin, the mapping is piecewise:
// the left tail spans t 0 -> 0.5 over its own duration, the right tail spans
// 0.5 -> 1 over its own duration. Asymmetric handles time-warp the two halves
// but 0.5 always lands exactly on the pin.
//
// Everything here is integer-in / double-out and free of any GPU/D3D/JUCE
// dependency so it can be unit tested on CPU (see test/test_timeline.cpp). This
// is the ONLY sample-domain code in Slice 2: offsets live in ticks on the model
// and are converted tick->sample via RenderClock::ppqToSample by the caller
// before this function is reached. Optional two-half cubic Bezier shaping is
// evaluated here too; preview and export share this one path, which guarantees
// they match frame for frame.
// ---------------------------------------------------------------------------

#include <algorithm>
#include <cstdint>

#include "model/TimelineTypes.h"

namespace xleth {

// Map an absolute render sample position `s` to transition progress in [0,1].
//
//   s <= start        -> 0.0
//   start < s < pin    -> 0.5 * (s - start) / (pin - start)
//   s == pin           -> 0.5
//   pin < s < end       -> 0.5 + 0.5 * (s - pin) / (end - pin)
//   s >= end           -> 1.0
//
// Degenerate windows (every divide is guarded — no divide-by-zero on any path):
//   • zero left tail  (start == pin): 0 for s < pin, >= 0.5 at/after the pin.
//   • zero right tail (pin  == end):  fades 0 -> 0.5 up to the pin, then 1.0 at/after it.
//   • fully-zero window (start == pin == end): a hard-cut step — 0 for s < pin, 1 for s >= pin.
//
// The result is always clamped to [0,1]. `start <= pin <= end` is the expected
// ordering; out-of-order inputs are treated as their degenerate (zero-tail) case
// rather than producing negative or >1 progress.
inline double progressForSample(int64_t s,
                                int64_t startSample,
                                int64_t pinSample,
                                int64_t endSample) {
    // ── Left of the pin ─────────────────────────────────────────────────────
    if (s < pinSample) {
        if (startSample >= pinSample) return 0.0;   // zero/degenerate left tail
        if (s <= startSample)         return 0.0;
        const double t = 0.5 * static_cast<double>(s - startSample)
                             / static_cast<double>(pinSample - startSample);
        return t < 0.0 ? 0.0 : (t > 1.0 ? 1.0 : t);
    }

    // ── Exactly on the pin ──────────────────────────────────────────────────
    if (s == pinSample) {
        // With no right tail to fade B in, B is already fully shown at the pin;
        // this also covers the fully-zero (hard-cut) window.
        return (endSample <= pinSample) ? 1.0 : 0.5;
    }

    // ── Right of the pin ────────────────────────────────────────────────────
    if (endSample <= pinSample) return 1.0;          // zero/degenerate right tail
    if (s >= endSample)         return 1.0;
    const double t = 0.5 + 0.5 * static_cast<double>(s - pinSample)
                              / static_cast<double>(endSample - pinSample);
    return t < 0.0 ? 0.0 : (t > 1.0 ? 1.0 : t);
}

// Evaluate a CSS-style cubic Bezier easing at the supplied normalized time.
// X is inverted with a fixed-count binary search, keeping preview and export
// deterministic while accepting the full bounded CSS control-point domain.
inline double evaluateSnapshotTransitionBezier(
    double x, SnapshotTransitionEasingCurve curve) {
    if (x <= 0.0) return 0.0;
    if (x >= 1.0) return 1.0;
    curve.normalize();
    if (curve.isLinear()) return x;

    const auto bezier = [](double u, double p1, double p2) {
        const double inv = 1.0 - u;
        return 3.0 * inv * inv * u * p1
             + 3.0 * inv * u * u * p2
             + u * u * u;
    };

    double lo = 0.0;
    double hi = 1.0;
    for (int i = 0; i < 32; ++i) {
        const double mid = (lo + hi) * 0.5;
        if (bezier(mid, curve.x1, curve.x2) < x) lo = mid;
        else                                      hi = mid;
    }
    const double y = bezier((lo + hi) * 0.5, curve.y1, curve.y2);
    return std::clamp(y, 0.0, 1.0);
}

// Shape the two halves independently while keeping the cue pin an exact 50%
// blend point. Linear default curves are therefore byte-for-byte identity.
inline double applySnapshotTransitionEasing(
    double linearProgress,
    const SnapshotTransitionEasingCurve& startToPin,
    const SnapshotTransitionEasingCurve& pinToEnd) {
    if (linearProgress <= 0.0) return 0.0;
    if (linearProgress >= 1.0) return 1.0;
    if (linearProgress == 0.5) return 0.5;
    if (linearProgress < 0.5) {
        return 0.5 * evaluateSnapshotTransitionBezier(linearProgress * 2.0, startToPin);
    }
    return 0.5 + 0.5 * evaluateSnapshotTransitionBezier(
        (linearProgress - 0.5) * 2.0, pinToEnd);
}

} // namespace xleth
