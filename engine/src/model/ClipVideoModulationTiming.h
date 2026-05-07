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
