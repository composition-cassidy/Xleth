#include "ClipCompanionFxBuilder.h"

namespace xleth::clipmod {

ClipCompanionFxSnapshot buildClipCompanionFxSnapshot(
    const ClipModulation& modulation,
    const VideoModulationTimingResult& timing) noexcept
{
    ClipCompanionFxSnapshot out;
    if (!timing.timingActive)
        return out;

    const auto& video = modulation.video;

    if (video.vibratoSwirlEnabled && timing.vibratoActive) {
        out.vibratoSwirlEnabled = true;
        out.vibratoLfo          = timing.vibratoLfo;
        out.vibratoPhase01      = timing.vibratoPhase01;
        out.vibratoCents        = timing.vibratoCents;
        out.swirlAmount         = video.swirlAmount;
        out.swirlRadius         = video.swirlRadius;
        out.swirlCenterX        = video.swirlCenterX;
        out.swirlCenterY        = video.swirlCenterY;
    }

    if (video.scratchWaveEnabled && timing.scratchActive) {
        out.scratchWaveEnabled      = true;
        out.scratchRateMultiplier   = timing.scratchRateMultiplier;
        out.scratchPhase01          = timing.scratchPhase01;
        out.scratchIntensity01      = timing.scratchIntensity01;
        out.waveAmount              = video.waveAmount;
        out.waveFrequency           = video.waveFrequency;
        out.smearAmount             = video.smearAmount;
        out.reverseWaveWithScratch  = video.reverseWaveWithScratch;
    }

    return out;
}

} // namespace xleth::clipmod
