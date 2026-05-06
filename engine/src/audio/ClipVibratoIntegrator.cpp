// ClipVibratoIntegrator.cpp — Phase C.1
//
// See ClipVibratoIntegrator.h for purpose. The exact path here matches the
// reader's per-sample loop bit-for-bit: same integer sample index, same
// ClipModulationContext fields, same evaluateVibrato call. The strided path
// uses midpoint integration over chunks whose width adapts to vibrato rate
// and shape so source-offset error stays bounded.

#include "audio/ClipVibratoIntegrator.h"

#include <cmath>

#include "model/ClipModulationEvaluator.h"

namespace xleth::audio {

namespace {

// Mirror of ClipModulationEvaluator.cpp's anonymous-namespace cyclesPerBeat —
// the evaluator's copy is private. Keep these in sync; if the canonical table
// changes, this one must too.
double cyclesPerBeat(ClipModulation::Vibrato::SyncDivision d) noexcept
{
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

} // namespace

double computeVibratoIntegratedSourceOffsetSamples(
    const VibratoSourceOffsetParams& p) noexcept
{
    if (p.clipLocalSamples <= 0) return 0.0;

    const int64_t N = p.clipLocalSamples;

    const bool noVibrato = !p.topLevelEnabled
                        || p.vibrato == nullptr
                        || !p.vibrato->enabled
                        || p.vibrato->depthCents == 0.0f;
    if (noVibrato)
        return p.staticRatio * static_cast<double>(N);

    const auto& v = *p.vibrato;

    const double invSr = (p.sampleRate > 0.0) ? 1.0 / p.sampleRate : 0.0;
    const double bps   = p.bpm / 60.0;

    // Builds a context that mirrors what ClipModulatedReader populates per
    // sample. Using identical field math here is what makes the exact path
    // bit-equivalent to continuous playback.
    auto buildCtx = [&](int64_t sampleIdx) noexcept {
        xleth::clipmod::ClipModulationContext ctx;
        ctx.bpm        = p.bpm;
        ctx.sampleRate = p.sampleRate;

        const int64_t timelineSamples = p.clipStartTimelineSamples + sampleIdx;
        ctx.timelineSamples = timelineSamples;
        ctx.timelineSeconds = static_cast<double>(timelineSamples) * invSr;
        ctx.timelineBeats   = ctx.timelineSeconds * bps;

        ctx.clipLocalSamples = sampleIdx;
        ctx.clipLocalSeconds = static_cast<double>(sampleIdx) * invSr;
        ctx.clipLocalBeats   = ctx.clipLocalSeconds * bps;

        ctx.clipDurationSeconds = p.clipDurationSeconds;
        ctx.clipDurationBeats   = p.clipDurationBeats;
        return ctx;
    };

    // Effective LFO rate in Hz (cycles per second) for both rate modes.
    using RM = ClipModulation::Vibrato::RateMode;
    double effectiveRateHz = 0.0;
    if (v.rateMode == RM::FreeHz)
        effectiveRateHz = std::fabs(static_cast<double>(v.rateHz));
    else
        effectiveRateHz = cyclesPerBeat(v.syncDivision) * bps;

    using S = ClipModulation::Vibrato::Shape;
    // Only Sine is C^1 (continuous derivative) — midpoint rule converges
    // quadratically. Triangle is C^0 with corners every quarter-cycle and
    // shows ~8 samples / 1M of strided drift at the smooth-shape stride, so
    // we group it with the sharp shapes (Square/Saw*/Custom) under the
    // tighter ≥256-pts/cycle stride.
    const bool isSmoothShape = (v.shape == S::Sine);

    // kExactBudget — exact per-sample integration ceiling. Above this we
    // switch to strided midpoint. Sharp shapes get a higher ceiling because
    // their stride must be smaller (more eval calls per sample of progress)
    // and we want to keep the strided path's worst-case cost reasonable.
    const int64_t kExactBudget = isSmoothShape ? int64_t{65536} : int64_t{200000};

    // Exact path. Bit-equivalent to ClipModulatedReader's per-sample loop.
    if (N <= kExactBudget
        || !std::isfinite(effectiveRateHz) || effectiveRateHz <= 0.0
        || p.sampleRate <= 0.0)
    {
        double accum = 0.0;
        for (int64_t i = 0; i < N; ++i) {
            const auto ctx = buildCtx(i);
            const auto vEval = xleth::clipmod::evaluateVibrato(v, ctx, p.topLevelEnabled);
            accum += p.staticRatio * vEval.pitchRatio;
        }
        return accum;
    }

    // Strided midpoint integration.
    const double cycleSamples = p.sampleRate / effectiveRateHz;
    int64_t stride;
    if (isSmoothShape) {
        // ≥16 samples / cycle. Quadratic midpoint convergence on smooth
        // integrands keeps source-offset error well below one sample.
        stride = static_cast<int64_t>(std::floor(cycleSamples / 16.0));
        if (stride < 8)    stride = 8;
        if (stride > 4096) stride = 4096;
    } else {
        // ≥256 samples / cycle. Discontinuous shapes (Square, Saw*, Custom-
        // with-jumps) lose a degree of midpoint convergence near each jump;
        // the tighter cap keeps per-cycle error bounded.
        stride = static_cast<int64_t>(std::floor(cycleSamples / 256.0));
        if (stride < 4)    stride = 4;
        if (stride > 4096) stride = 4096;
    }

    double accum = 0.0;
    int64_t i = 0;
    while (i + stride <= N) {
        const int64_t mid = i + stride / 2;
        const auto ctx = buildCtx(mid);
        const auto vEval = xleth::clipmod::evaluateVibrato(v, ctx, p.topLevelEnabled);
        accum += p.staticRatio * vEval.pitchRatio * static_cast<double>(stride);
        i += stride;
    }

    // Final partial chunk: exact per-sample to keep the tail accurate.
    for (; i < N; ++i) {
        const auto ctx = buildCtx(i);
        const auto vEval = xleth::clipmod::evaluateVibrato(v, ctx, p.topLevelEnabled);
        accum += p.staticRatio * vEval.pitchRatio;
    }

    return accum;
}

} // namespace xleth::audio
