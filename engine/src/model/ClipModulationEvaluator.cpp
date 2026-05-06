// ClipModulationEvaluator.cpp — Phase B
//
// Pure deterministic evaluator. Audio (per sample/block) and video
// (per frame) must obtain the same modulation values from the same
// ClipModulation + clip-local time. No persistent phase, no audio-thread
// state, no globals, no static caches. Stateful smoothing/declicking is
// deferred to a future ClipModulatedReader where per-reader local state
// is permitted.

#include "ClipModulationEvaluator.h"

#include <algorithm>
#include <cmath>

namespace xleth::clipmod {

namespace {

constexpr double kTwoPi = 6.28318530717958647692;

inline bool isFiniteD(double x) { return std::isfinite(x); }
inline bool isFiniteF(float  x) { return std::isfinite(x); }

inline double wrap01(double x) {
    if (!isFiniteD(x)) return 0.0;
    double w = x - std::floor(x);
    // Floating drift can land w == 1.0 (or marginally above) — pull back.
    if (w >= 1.0) w -= 1.0;
    if (w <  0.0) w += 1.0;
    return w;
}

inline float clamp01f(float v) {
    if (v < 0.0f) return 0.0f;
    if (v > 1.0f) return 1.0f;
    return v;
}

// Cycles per beat for each tempo-sync division (the division names the
// LFO period: e.g. "Quarter" => one full cycle per quarter-note beat).
double cyclesPerBeat(ClipModulation::Vibrato::SyncDivision d) {
    using D = ClipModulation::Vibrato::SyncDivision;
    switch (d) {
        case D::Whole:             return 0.25;
        case D::Half:              return 0.5;
        case D::Quarter:           return 1.0;
        case D::Eighth:            return 2.0;
        case D::Sixteenth:         return 4.0;
        case D::ThirtySecond:      return 8.0;
        case D::QuarterTriplet:    return 1.5;
        case D::EighthTriplet:     return 3.0;
        case D::SixteenthTriplet:  return 6.0;
        case D::QuarterDotted:     return 2.0 / 3.0;
        case D::EighthDotted:      return 4.0 / 3.0;
        case D::SixteenthDotted:   return 8.0 / 3.0;
    }
    return 1.0;
}

float evaluateBuiltinShape(ClipModulation::Vibrato::Shape shape, float p) {
    using S = ClipModulation::Vibrato::Shape;
    switch (shape) {
        case S::Sine:
            return std::sin(static_cast<float>(kTwoPi) * p);
        case S::Triangle:
            // 0=0, .25=+1, .5=0, .75=-1, 1=0
            if (p < 0.25f)      return 4.0f * p;
            else if (p < 0.75f) return 2.0f - 4.0f * p;
            else                return 4.0f * p - 4.0f;
        case S::SawUp:
            return 2.0f * p - 1.0f;
        case S::SawDown:
            return 1.0f - 2.0f * p;
        case S::Square:
            return p < 0.5f ? 1.0f : -1.0f;
        case S::Custom:
            return 0.0f; // handled by caller (needs the breakpoint vector)
    }
    return 0.0f;
}

// Linear interpolation through a breakpoint table whose times are in [0,1].
// Phase A keeps points in author order; we treat them as monotonically
// non-decreasing in time. Empty => 0; single point => that value.
float evaluateCustomShape(const std::vector<SampleRegion::LfoBreakpoint>& bps,
                          float p) {
    if (bps.empty()) return 0.0f;
    if (bps.size() == 1) return bps.front().value;

    if (p <= bps.front().time) return bps.front().value;
    if (p >= bps.back().time)  return bps.back().value;

    for (size_t i = 0; i + 1 < bps.size(); ++i) {
        const auto& a = bps[i];
        const auto& b = bps[i + 1];
        if (p >= a.time && p <= b.time) {
            const float span = b.time - a.time;
            if (span <= 0.0f) return a.value;
            const float t = (p - a.time) / span;
            return a.value + t * (b.value - a.value);
        }
    }
    return bps.back().value;
}

// Convert a ScratchPoint::time (in the curve's time mode) into seconds
// since clip start. Used both for current-rate lookup and for the
// integral of rate over time.
double scratchPointTimeSeconds(float                                rawTime,
                               ClipModulation::Scratch::CurveTimeMode mode,
                               const ClipModulationContext&         ctx) {
    using M = ClipModulation::Scratch::CurveTimeMode;
    switch (mode) {
        case M::ClipSeconds: return static_cast<double>(rawTime);
        case M::ClipPercent: return static_cast<double>(rawTime)
                                  * ctx.clipDurationSeconds;
        case M::Beats:
            // Guard against bpm <= 0 (or NaN) — fall back to identity.
            if (!(ctx.bpm > 0.0) || !isFiniteD(ctx.bpm))
                return static_cast<double>(rawTime);
            return static_cast<double>(rawTime) * 60.0 / ctx.bpm;
    }
    return static_cast<double>(rawTime);
}

// Linear interpolation between (t0,r0) and (t1,r1) at t.
inline double lerpRate(double t0, double r0, double t1, double r1, double t) {
    const double span = t1 - t0;
    if (span <= 0.0) return r0;
    const double k = (t - t0) / span;
    return r0 + k * (r1 - r0);
}

} // namespace

VibratoEval evaluateVibrato(const ClipModulation::Vibrato& v,
                            const ClipModulationContext& ctx,
                            bool topLevelEnabled) {
    VibratoEval out; // neutral by default
    if (!topLevelEnabled || !v.enabled || v.depthCents == 0.0f)
        return out;

    using RM = ClipModulation::Vibrato::RateMode;

    const double timeSec   = v.phaseResetOnClipStart ? ctx.clipLocalSeconds
                                                     : ctx.timelineSeconds;
    const double timeBeats = v.phaseResetOnClipStart ? ctx.clipLocalBeats
                                                     : ctx.timelineBeats;

    double cycles = 0.0;
    if (v.rateMode == RM::FreeHz) {
        // Defensive: negative rate is allowed input but treated as |rate|.
        const double r = std::fabs(static_cast<double>(v.rateHz));
        cycles = r * timeSec;
    } else {
        cycles = cyclesPerBeat(v.syncDivision) * timeBeats;
    }

    if (!isFiniteD(cycles)) cycles = 0.0;

    const double offset = isFiniteF(v.phaseOffset)
                            ? static_cast<double>(v.phaseOffset) : 0.0;
    const double phase = wrap01(cycles + offset);
    const float  p     = static_cast<float>(phase);

    out.phase01 = p;

    using S = ClipModulation::Vibrato::Shape;
    if (v.shape == S::Custom)
        out.lfo = evaluateCustomShape(v.customShape, p);
    else
        out.lfo = evaluateBuiltinShape(v.shape, p);

    if (!isFiniteF(out.lfo)) out.lfo = 0.0f;

    out.cents      = out.lfo * v.depthCents;
    out.semis      = out.cents / 100.0f;
    out.pitchRatio = std::pow(2.0, static_cast<double>(out.cents) / 1200.0);
    return out;
}

ScratchEval evaluateScratch(const ClipModulation::Scratch& s,
                            const ClipModulationContext& ctx,
                            bool topLevelEnabled) {
    ScratchEval out;
    out.rateMultiplier      = 1.0f;
    out.reversed            = false;
    out.intensity01         = 0.0f;
    out.sourceOffsetSeconds = ctx.clipLocalSeconds; // neutral default
    out.phase01             = 0.0f;

    if (!topLevelEnabled || !s.enabled || s.curve.empty())
        return out;

    const double tNow = ctx.clipLocalSeconds;
    const auto&  pts  = s.curve;
    const auto   mode = s.timeMode;

    // ── Current rate at tNow ────────────────────────────────────────────
    double currentRate = 1.0;
    {
        const double t0 = scratchPointTimeSeconds(pts.front().time, mode, ctx);
        const double tN = scratchPointTimeSeconds(pts.back().time,  mode, ctx);

        if (tNow <= t0) {
            // If first point starts after zero, normal rate 1.0 before it.
            // If first point is at/before zero, use that point's rate.
            currentRate = (t0 > 0.0) ? 1.0 : static_cast<double>(pts.front().rateMultiplier);
            // Edge: tNow exactly equals t0 — prefer the explicit point.
            if (tNow == t0)
                currentRate = static_cast<double>(pts.front().rateMultiplier);
        } else if (tNow >= tN) {
            currentRate = static_cast<double>(pts.back().rateMultiplier);
        } else {
            for (size_t i = 0; i + 1 < pts.size(); ++i) {
                const double ta = scratchPointTimeSeconds(pts[i].time,     mode, ctx);
                const double tb = scratchPointTimeSeconds(pts[i + 1].time, mode, ctx);
                if (tNow >= ta && tNow <= tb) {
                    currentRate = lerpRate(ta, pts[i].rateMultiplier,
                                           tb, pts[i + 1].rateMultiplier, tNow);
                    break;
                }
            }
        }
    }

    // ── Integral of rate from 0 to tNow ─────────────────────────────────
    double integral = 0.0;
    {
        const double t0 = scratchPointTimeSeconds(pts.front().time, mode, ctx);

        // Region [0, min(tNow, t0)] at unity rate.
        if (t0 > 0.0) {
            const double end = std::min(tNow, t0);
            if (end > 0.0) integral += end; // rate == 1.0 implicitly
        }

        if (tNow > t0) {
            // Walk through fully covered segments.
            for (size_t i = 0; i + 1 < pts.size(); ++i) {
                const double ta = scratchPointTimeSeconds(pts[i].time,     mode, ctx);
                const double tb = scratchPointTimeSeconds(pts[i + 1].time, mode, ctx);
                const double ra = pts[i].rateMultiplier;
                const double rb = pts[i + 1].rateMultiplier;

                if (tNow >= tb) {
                    if (tb > ta)
                        integral += 0.5 * (ra + rb) * (tb - ta);
                } else if (tNow > ta && tNow < tb) {
                    const double rEnd = lerpRate(ta, ra, tb, rb, tNow);
                    integral += 0.5 * (ra + rEnd) * (tNow - ta);
                    break;
                }
                // tNow <= ta: nothing to add for this or later segments.
                if (tNow <= ta) break;
            }

            // Region after the last point.
            const double tN = scratchPointTimeSeconds(pts.back().time, mode, ctx);
            if (tNow > tN) {
                integral += static_cast<double>(pts.back().rateMultiplier)
                          * (tNow - tN);
            }
        }
    }

    if (!isFiniteD(integral)) integral = ctx.clipLocalSeconds;

    out.rateMultiplier      = static_cast<float>(currentRate);
    out.reversed            = currentRate < 0.0;
    out.intensity01         = clamp01f(std::fabs(out.rateMultiplier - 1.0f));
    out.sourceOffsetSeconds = integral;

    const double absOff = std::fabs(integral);
    out.phase01 = static_cast<float>(absOff - std::floor(absOff));
    return out;
}

ClipModulationEval evaluateClipModulation(const ClipModulation& m,
                                          const ClipModulationContext& ctx) {
    ClipModulationEval out;
    out.vibrato = evaluateVibrato(m.vibrato, ctx, m.enabled);
    out.scratch = evaluateScratch(m.scratch, ctx, m.enabled);
    return out;
}

} // namespace xleth::clipmod
