#include "model/ClipVideoModulationTiming.h"

#include "audio/ClipVibratoIntegrator.h"
#include "model/ClipModulationEvaluator.h"

#include <algorithm>
#include <cmath>

namespace xleth::clipmod {
namespace {

double centsToRatio(double cents) noexcept
{
    return std::pow(2.0, cents / 1200.0);
}

bool finite(double v) noexcept
{
    return std::isfinite(v);
}

double fallbackSourceTime(const VideoModulationTimingContext& ctx) noexcept
{
    return ctx.sourceStartTime + ctx.clipLocalSeconds;
}

double clampVideoSourceTime(double sourceTime,
                            const VideoModulationTimingContext& ctx) noexcept
{
    if (!finite(sourceTime))
        sourceTime = fallbackSourceTime(ctx);

    const double lo = finite(ctx.sourceClampStartTime)
        ? ctx.sourceClampStartTime
        : (finite(ctx.sourceStartTime) ? ctx.sourceStartTime : 0.0);

    if (!(ctx.sourceEndTime > lo) || !finite(ctx.sourceEndTime))
        return std::max(lo, sourceTime);

    double hi = ctx.sourceEndTime;
    if (ctx.sourceFps > 0.0 && finite(ctx.sourceFps))
        hi = std::max(lo, ctx.sourceEndTime - 0.5 / ctx.sourceFps);

    return std::clamp(sourceTime, lo, hi);
}

ClipModulationContext makeEvaluatorContext(
    const VideoModulationTimingContext& ctx) noexcept
{
    ClipModulationContext out;
    out.bpm                 = ctx.bpm;
    out.sampleRate          = ctx.sampleRate;
    out.timelineSamples     = ctx.timelineSamples;
    out.timelineSeconds     = ctx.timelineSeconds;
    out.timelineBeats       = ctx.timelineBeats;
    out.clipLocalSamples    = ctx.clipLocalSamples;
    out.clipLocalSeconds    = ctx.clipLocalSeconds;
    out.clipLocalBeats      = ctx.clipLocalBeats;
    out.clipDurationSeconds = ctx.clipDurationSeconds;
    out.clipDurationBeats   = ctx.clipDurationBeats;
    return out;
}

bool modulationTimingEnabled(const ClipModulation& modulation,
                             bool compatible) noexcept
{
    return compatible
        && modulation.enabled
        && (modulation.vibrato.enabled || modulation.scratch.enabled);
}

} // namespace

VideoModulationTimingResult evaluateVideoClipModulationTiming(
    const ClipModulation& modulation,
    const VideoModulationTimingContext& ctx,
    bool compatible) noexcept
{
    VideoModulationTimingResult out;
    out.sourceTimeSeconds = clampVideoSourceTime(fallbackSourceTime(ctx), ctx);
    out.scratchSourceOffsetSeconds = ctx.clipLocalSeconds;

    if (!modulationTimingEnabled(modulation, compatible))
        return out;

    const ClipModulationContext evalCtx = makeEvaluatorContext(ctx);
    const bool scratchActive = modulation.scratch.enabled
                            && !modulation.scratch.curve.empty();

    ScratchEval scratchEval;
    if (scratchActive) {
        scratchEval = evaluateScratch(modulation.scratch, evalCtx, modulation.enabled);
        out.scratchSourceOffsetSeconds = scratchEval.sourceOffsetSeconds;
    }

    const double scratchBaseSeconds = scratchActive
        ? scratchEval.sourceOffsetSeconds
        : ctx.clipLocalSeconds;

    const double staticCents =
        static_cast<double>(ctx.clipPitchOffsetSemis) * 100.0
      + static_cast<double>(ctx.clipPitchOffsetCents);
    const double staticRatio = centsToRatio(staticCents);

    xleth::audio::VibratoSourceOffsetParams params;
    params.vibrato                  = &modulation.vibrato;
    params.topLevelEnabled          = modulation.enabled;
    params.staticRatio              = staticRatio;
    params.bpm                      = ctx.bpm;
    params.sampleRate               = ctx.sampleRate;
    params.clipLocalSamples         = ctx.clipLocalSamples;
    params.clipDurationSeconds      = ctx.clipDurationSeconds;
    params.clipDurationBeats        = ctx.clipDurationBeats;
    params.clipStartTimelineSamples = ctx.clipStartTimelineSamples;

    double integratedPitchOffsetSamples =
        xleth::audio::computeVibratoIntegratedSourceOffsetSamples(params);
    if (!finite(integratedPitchOffsetSamples))
        integratedPitchOffsetSamples = static_cast<double>(ctx.clipLocalSamples);

    const double sampleRate = (ctx.sampleRate > 0.0 && finite(ctx.sampleRate))
        ? ctx.sampleRate
        : 48000.0;
    out.vibratoResidualSeconds =
        (integratedPitchOffsetSamples - static_cast<double>(ctx.clipLocalSamples))
        / sampleRate;

    const VibratoEval vibratoEval =
        evaluateVibrato(modulation.vibrato, evalCtx, modulation.enabled);

    out.timingActive = true;
    out.scratchActive = scratchActive;
    out.vibratoActive = modulation.vibrato.enabled;
    out.vibratoLfo = vibratoEval.lfo;
    out.vibratoPhase01 = vibratoEval.phase01;
    out.vibratoCents = vibratoEval.cents;
    out.scratchRateMultiplier = scratchActive ? scratchEval.rateMultiplier : 1.0f;
    out.scratchPhase01 = scratchActive ? scratchEval.phase01 : 0.0f;
    out.scratchIntensity01 = scratchActive ? scratchEval.intensity01 : 0.0f;

    out.sourceTimeSeconds = clampVideoSourceTime(
        ctx.sourceStartTime + scratchBaseSeconds + out.vibratoResidualSeconds,
        ctx);

    return out;
}

} // namespace xleth::clipmod
