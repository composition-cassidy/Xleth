#pragma once

// ---------------------------------------------------------------------------
// LandingMath — the pure arithmetic of a Landing (docs/XLETH_LANDING_SPEC.md).
//
// Two halves, both free of any GPU / D3D / JUCE dependency so they unit-test on
// the CPU:
//
//   • where a move STARTS when it is derived from the destination
//     (edgeFromRect, growFromRect) — used by Timeline::landingsAt;
//   • where the track IS on a given frame (evaluateLanding) — used by
//     LandingRenderer for the live preview and the export alike.
//
// Determinism (spec ruling 8): progress is a function of the frame's absolute
// project SAMPLE and of two sample positions the caller converts from ticks
// with RenderClock::ppqToSample, exactly as the snapshot-transition path does.
// No wall clock reaches it, so preview and export agree frame for frame and a
// seek into a lead-in lands mid-move.
//
// The seam (spec ruling 4): at progress 1 the pose is the landing's `to` rect
// returned AS STORED, never recomputed as from + (to - from) * 1, so the last
// landing frame and the incoming snapshot's own draw are bitwise equal.
// ---------------------------------------------------------------------------

#include <cmath>
#include <cstdint>
#include <limits>

#include "model/Timeline.h"                    // Timeline::ResolvedLanding
#include "render/SnapshotTransitionTiming.h"   // evaluateSnapshotTransitionBezier

namespace xleth::landing {

struct Rect {
    float x = 0.0f, y = 0.0f, w = 0.0f, h = 0.0f;
};

// Edge: the destination rect, slid off the canvas along the side it enters
// from. angleDeg uses SnapshotTransition::geomAngleDeg's convention: 0 = left,
// 90 = top, 180 = right, 270 = bottom.
//
// The slide direction is e = (-cos θ, -sin θ) in UV with y down. The rect is
// translated by k·e, k being the smallest distance that puts it fully outside
// [0,1]²: per axis with a non-zero component, e.x < 0 → (x + w) / -e.x and
// e.x > 0 → (1 - x) / e.x, the same for y, and the minimum of the two.
//
// The axis that decides k is written as the exact boundary value (-w, 1, -h or
// 1) rather than as x + k·e.x, so the rect TOUCHES the edge with no overlap
// and no gap, whatever the rounding of the trig.
inline Rect edgeFromRect(const Rect& to, float angleDeg) noexcept
{
    constexpr double kPi = 3.14159265358979323846;
    const double rad = static_cast<double>(angleDeg) * kPi / 180.0;
    double ex = -std::cos(rad);
    double ey = -std::sin(rad);
    // cos/sin of a cardinal angle is not exactly zero; without this a pure
    // "from the top" would also carry a 1e-17 sideways slide.
    if (std::fabs(ex) < 1e-9) ex = 0.0;
    if (std::fabs(ey) < 1e-9) ey = 0.0;

    const double inf = std::numeric_limits<double>::infinity();
    double kx = inf, ky = inf;
    if      (ex < 0.0) kx = (static_cast<double>(to.x) + to.w) / -ex;
    else if (ex > 0.0) kx = (1.0 - static_cast<double>(to.x)) / ex;
    if      (ey < 0.0) ky = (static_cast<double>(to.y) + to.h) / -ey;
    else if (ey > 0.0) ky = (1.0 - static_cast<double>(to.y)) / ey;

    Rect from = to;
    if (kx == inf && ky == inf) return from;   // unreachable: e is a unit vector

    if (kx <= ky) {
        // Already past this edge (a destination outside the canvas): no move.
        if (kx <= 0.0) return from;
        from.x = (ex < 0.0) ? -to.w : 1.0f;
        from.y = static_cast<float>(static_cast<double>(to.y) + kx * ey);
    } else {
        if (ky <= 0.0) return from;
        from.y = (ey < 0.0) ? -to.h : 1.0f;
        from.x = static_cast<float>(static_cast<double>(to.x) + ky * ex);
    }
    return from;
}

// Grow: a zero-size rect at the destination's centre.
inline Rect growFromRect(const Rect& to) noexcept
{
    return Rect{ to.x + to.w * 0.5f, to.y + to.h * 0.5f, 0.0f, 0.0f };
}

// Linear progress of a landing at absolute project sample S.
//
//   S >= pinS            -> 1   (the pin itself, and the whole carry phase)
//   S <= startS          -> 0   (not started yet: still drawn, at its from rect)
//   startS < S < pinS    -> (S - startS) / (pinS - startS)
//
// A zero-length lead-in (pinS == startS) has no third case and so no divide:
// it holds its from rect until the pin and is at its destination from there.
inline double landingProgress(int64_t S, int64_t startS, int64_t pinS) noexcept
{
    if (S >= pinS)   return 1.0;
    if (S <= startS) return 0.0;
    return static_cast<double>(S - startS) / static_cast<double>(pinS - startS);
}

// Where a landing track is on one frame.
struct Pose {
    float x = 0.0f, y = 0.0f, w = 0.0f, h = 0.0f;   // canvas-normalized home rect
    float unitW = 0.0f, unitH = 0.0f;               // Roam's unit (pre-gap placement size)
    float opacity = 1.0f;                           // multiplies the request's own opacity
};

inline Pose evaluateLanding(const Timeline::ResolvedLanding& l,
                            int64_t S, int64_t startS, int64_t pinS) noexcept
{
    const double p = landingProgress(S, startS, pinS);
    const double e = evaluateSnapshotTransitionBezier(p, l.easing);

    Pose out;
    if (e >= 1.0) {
        out.x = l.toX;  out.y = l.toY;  out.w = l.toW;  out.h = l.toH;
        out.unitW = l.toUnitW;  out.unitH = l.toUnitH;
        out.opacity = 1.0f;
        return out;
    }
    if (e <= 0.0) {
        out.x = l.fromX;  out.y = l.fromY;  out.w = l.fromW;  out.h = l.fromH;
        out.unitW = l.fromUnitW;  out.unitH = l.fromUnitH;
        out.opacity = l.fromOpacity;
        return out;
    }
    const float ef = static_cast<float>(e);
    const auto lerp = [ef](float a, float b) { return a + (b - a) * ef; };
    out.x = lerp(l.fromX, l.toX);
    out.y = lerp(l.fromY, l.toY);
    out.w = lerp(l.fromW, l.toW);
    out.h = lerp(l.fromH, l.toH);
    out.unitW   = lerp(l.fromUnitW, l.toUnitW);
    out.unitH   = lerp(l.fromUnitH, l.toUnitH);
    out.opacity = lerp(l.fromOpacity, 1.0f);
    return out;
}

} // namespace xleth::landing
