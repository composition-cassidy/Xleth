#pragma once

// ===========================================================================
// ParamTrackEase — CSS-semantics cubic-bezier easing for ParamTrack segments.
// ===========================================================================
//
// Endpoints are FIXED at (0,0) and (1,1); only the two interior control points
// are free, exactly like CSS `cubic-bezier(p1x, p1y, p2x, p2y)`. Evaluating it
// means solving x -> t (the curve is parametric, not a function of x) and then
// reading y(t).
//
// ── Why this is NOT util/BezierEase.h ──────────────────────────────────────
// BezierEase.h looks superficially similar and is deliberately NOT reused here.
// The two are different functions and neither is a copy of the other:
//
//   BezierEase::bezierEase(t, cx, cy)   ParamTrackEase::paramTrackEase(...)
//   ---------------------------------   -------------------------------------
//   1-D bezier evaluated directly in t  parametric 2-D curve, solves x -> t
//   ignores cx entirely (by design)     both x control points are meaningful
//   second control point forced to      p2y independent of p1y
//     (1 - cy), i.e. always symmetric
//   y is implicitly bounded             p1y / p2y intentionally UNCLAMPED so
//                                         overshoot easings are representable
//   frozen byte-for-byte to keep the    free to evolve with the ParamTrack
//     Sampler group-slide and the         schema
//     slide-curve goldens stable
//
// BezierEase.h is on the realtime AUDIO path (Sampler group-slide). Merging
// the two would change Sampler output. DO NOT "deduplicate" them.
//
// This header is the single easing evaluator for ParamTrack, shared by the
// live preview and the offline export so the two cannot drift.
//
// Pure, stateless, header-only: no allocation, no logging, no locks.

#include <algorithm>
#include <cmath>

namespace paramtrack {

// A segment's easing curve. Defaults describe the identity curve y = x.
struct EaseCurve {
    double p1x = 1.0 / 3.0;
    double p1y = 1.0 / 3.0;
    double p2x = 2.0 / 3.0;
    double p2y = 2.0 / 3.0;
};

// The x control points that make x(t) collapse to the identity. See kFastPathEps.
inline constexpr double kFastP1x = 1.0 / 3.0;
inline constexpr double kFastP2x = 2.0 / 3.0;

// Tolerance for recognising the fast path. Deliberately tight: a curve that is
// only approximately identity in x must go through the solver.
inline constexpr double kFastPathEps = 1e-9;

// Newton-Raphson budget before falling back to bisection, and the accuracy
// both are held to.
inline constexpr double kSolveEpsilon    = 1e-7;
inline constexpr int    kMaxNewtonIters  = 8;
inline constexpr int    kMaxBisectIters  = 64;

// Cubic Bernstein polynomial with endpoints pinned at 0 and 1, in the
// coefficient form  ((A*s + B)*s + C)*s.
//   A = 1 + 3*c1 - 3*c2,  B = 3*c2 - 6*c1,  C = 3*c1
inline double bernsteinCubic(double c1, double c2, double s) {
    const double A = 1.0 + 3.0 * c1 - 3.0 * c2;
    const double B = 3.0 * c2 - 6.0 * c1;
    const double C = 3.0 * c1;
    return ((A * s + B) * s + C) * s;
}

inline double bernsteinCubicSlope(double c1, double c2, double s) {
    const double A = 1.0 + 3.0 * c1 - 3.0 * c2;
    const double B = 3.0 * c2 - 6.0 * c1;
    const double C = 3.0 * c1;
    return (3.0 * A * s + 2.0 * B) * s + C;
}

// True when x(t) == t identically, so the x -> t solve can be skipped.
//
// Every curve produced by the legacy-easing migration table satisfies this
// (p1x = 1/3, p2x = 2/3), so migrated projects always take the exact path and
// the solver only ever runs for hand-authored curves.
inline bool isIdentityInX(double p1x, double p2x) {
    return std::abs(p1x - kFastP1x) < kFastPathEps
        && std::abs(p2x - kFastP2x) < kFastPathEps;
}

// Solve for the curve parameter t such that x(t) == x, for x in [0, 1].
//
// Newton-Raphson first (quadratic convergence, and the initial guess t = x is
// good for any sane curve); bisection as the guaranteed-progress fallback when
// Newton stalls on a near-zero derivative or wanders out of [0, 1]. This is the
// same strategy browsers use for CSS timing functions.
inline double solveCurveX(double p1x, double p2x, double x) {
    // Newton-Raphson.
    double t = x;
    for (int i = 0; i < kMaxNewtonIters; ++i) {
        const double err = bernsteinCubic(p1x, p2x, t) - x;
        if (std::abs(err) < kSolveEpsilon) return t;
        const double d = bernsteinCubicSlope(p1x, p2x, t);
        if (std::abs(d) < 1e-12) break;          // flat — Newton cannot progress
        const double next = t - err / d;
        if (!(next >= 0.0 && next <= 1.0)) break; // left the domain (also traps NaN)
        t = next;
    }

    // Bisection fallback. x(t) is monotonically non-decreasing on [0,1] for any
    // p1x, p2x in [0,1], so a sign test on the midpoint is a valid bracket step.
    double lo = 0.0, hi = 1.0;
    t = x;
    for (int i = 0; i < kMaxBisectIters; ++i) {
        t = 0.5 * (lo + hi);
        const double err = bernsteinCubic(p1x, p2x, t) - x;
        if (std::abs(err) < kSolveEpsilon) return t;
        if (err > 0.0) hi = t; else lo = t;
        if (hi - lo < kSolveEpsilon) break;
    }
    return t;
}

// Evaluate cubic-bezier(p1x, p1y, p2x, p2y) at x.
//
// p1x / p2x are CLAMPED to [0, 1] — outside that range x(t) stops being
// monotonic and the x -> t solve has no unique answer.
//
// p1y / p2y are deliberately NOT clamped. Overshoot beyond [0, 1] is a required
// feature: anticipation and back-out easings live there, and the legacy
// Ease-Out-Back curve migrates to p1y > 1.
inline double paramTrackEase(double p1x, double p1y, double p2x, double p2y, double x) {
    p1x = std::clamp(p1x, 0.0, 1.0);
    p2x = std::clamp(p2x, 0.0, 1.0);

    if (x <= 0.0) return 0.0;
    if (x >= 1.0) return 1.0;

    // Fast path: x(t) == t, so t is x and no solve is needed.
    if (isIdentityInX(p1x, p2x))
        return bernsteinCubic(p1y, p2y, x);

    return bernsteinCubic(p1y, p2y, solveCurveX(p1x, p2x, x));
}

inline double paramTrackEase(const EaseCurve& c, double x) {
    return paramTrackEase(c.p1x, c.p1y, c.p2x, c.p2y, x);
}

} // namespace paramtrack
