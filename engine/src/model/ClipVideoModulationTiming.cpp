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

// Stretch ratio as a divisor. The 1e-4 dead-band is ClipRenderCache's own
// `willStretch` test: inside it the audio path does not stretch at all, so the
// video must not either.
double effectiveStretchRatio(const VideoModulationTimingContext& ctx) noexcept
{
    const double r = ctx.clipStretchRatio;
    if (!finite(r) || !(r > 0.0) || std::abs(r - 1.0) <= 1e-4)
        return 1.0;
    return r;
}

// Position in the clip's CACHE buffer (seconds since clip start, i.e. after
// stretch and reverse have been applied) -> position in the source.
//
// This is the one place the audio render's geometry is mirrored for video:
// ClipRenderCache reads D / ratio seconds of source starting at the anchor,
// reverses that segment in place when the clip is reversed, then stretches it
// to D. So `cacheSeconds` of clip time has consumed cacheSeconds / ratio of
// source — counted forward from the anchor, or backward from the segment end.
double sourceTimeForCacheSeconds(double cacheSeconds,
                                 const VideoModulationTimingContext& ctx) noexcept
{
    const double consumed = cacheSeconds / effectiveStretchRatio(ctx);
    if (!ctx.clipReversed)
        return ctx.sourceStartTime + consumed;

    // Length of the source segment the audio reversed: what the clip needs,
    // capped by what is left of the region after the anchor (the cache cannot
    // read past the region either).
    double segment = ctx.clipDurationSeconds / effectiveStretchRatio(ctx);
    if (finite(ctx.sourceEndTime) && ctx.sourceEndTime > ctx.sourceStartTime)
        segment = std::min(segment, ctx.sourceEndTime - ctx.sourceStartTime);
    if (!finite(segment) || !(segment > 0.0))
        return ctx.sourceStartTime;

    // The first reversed sample is the LAST sample of the segment, one sample
    // short of its end. Without that step a segment ending exactly on a frame
    // boundary would open on the frame after the one the audio starts in.
    const double oneSample = (ctx.sampleRate > 0.0 && finite(ctx.sampleRate))
        ? 1.0 / ctx.sampleRate
        : 0.0;
    return ctx.sourceStartTime + std::max(0.0, segment - consumed - oneSample);
}

double fallbackSourceTime(const VideoModulationTimingContext& ctx) noexcept
{
    return sourceTimeForCacheSeconds(ctx.clipLocalSeconds, ctx);
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

    // Scratch and vibrato move the readhead inside the cache buffer (the
    // post-stretch domain), so the modulated position goes through the same
    // cache -> source mapping as the plain one.
    out.sourceTimeSeconds = clampVideoSourceTime(
        sourceTimeForCacheSeconds(scratchBaseSeconds + out.vibratoResidualSeconds, ctx),
        ctx);

    return out;
}

} // namespace xleth::clipmod
