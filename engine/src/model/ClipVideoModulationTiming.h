#pragma once

#include "TimelineTypes.h"

#include <cstdint>

namespace xleth::clipmod {

struct VideoModulationTimingContext {
    double  bpm        = 140.0;
    double  sampleRate = 48000.0;

    double  timelineSeconds = 0.0;
    double  timelineBeats   = 0.0;
    int64_t timelineSamples = 0;

    double  clipLocalSeconds = 0.0;
    double  clipLocalBeats   = 0.0;
    int64_t clipLocalSamples = 0;

    double  clipDurationSeconds = 0.0;
    double  clipDurationBeats   = 0.0;

    double  sourceStartTime = 0.0;
    double  sourceClampStartTime = 0.0;
    double  sourceEndTime   = 0.0;
    double  sourceFps       = 0.0;

    int clipPitchOffsetSemis = 0;
    int clipPitchOffsetCents = 0;

    int64_t clipStartTimelineSamples = 0;

    // Clip time-stretch and reverse, so the picture moves with the audio.
    //
    // clipStretchRatio is Clip::stretchRatio: output length / input length.
    // A clip of timeline duration D consumes only D / ratio seconds of source
    // (ClipRenderCache reads that much and stretches it), so 2.0 plays the
    // source at half speed and 0.5 at double speed.
    //
    // clipReversed mirrors ClipRenderCache too: it reverses the source segment
    // the clip consumes, [anchor, anchor + D / ratio) clamped to the region
    // end, so playback starts at the END of that segment and runs back to the
    // anchor.
    double clipStretchRatio = 1.0;
    bool   clipReversed     = false;
};

struct VideoModulationTimingResult {
    bool timingActive  = false;
    bool scratchActive = false;
    bool vibratoActive = false;

    double sourceTimeSeconds         = 0.0;
    double scratchSourceOffsetSeconds = 0.0;
    double vibratoResidualSeconds    = 0.0;

    float vibratoLfo     = 0.0f;
    float vibratoPhase01 = 0.0f;
    float vibratoCents   = 0.0f;

    float scratchRateMultiplier = 1.0f;
    float scratchPhase01        = 0.0f;
    float scratchIntensity01    = 0.0f;
};

VideoModulationTimingResult evaluateVideoClipModulationTiming(
    const ClipModulation& modulation,
    const VideoModulationTimingContext& ctx,
    bool compatible) noexcept;

} // namespace xleth::clipmod
