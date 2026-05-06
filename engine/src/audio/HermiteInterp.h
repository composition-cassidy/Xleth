#pragma once

#include <juce_audio_basics/juce_audio_basics.h>

namespace xleth::audio {

// 4-point cubic Hermite interpolation.
// `pos` is a fractional sample index into `src` on `channel`.
// Returns 0 outside the valid range. Neighbours are clamped at the edges,
// matching the inline reader in Sampler.cpp's processVoice.
//
// TODO(phase-d): dedupe with Sampler::processVoice readInterp lambda once
// Phase C lands and the Sampler test surface can be re-touched safely.
inline float hermiteSample(const juce::AudioBuffer<float>& src,
                           int channel, double pos) noexcept
{
    const int n = src.getNumSamples();
    const int i0 = static_cast<int>(pos);
    if (i0 < 0 || i0 >= n) return 0.0f;
    const float f = static_cast<float>(pos - i0);

    auto clampGet = [&](int idx) -> float {
        if (idx < 0) idx = 0;
        else if (idx >= n) idx = n - 1;
        return src.getSample(channel, idx);
    };

    const float ym1 = clampGet(i0 - 1);
    const float y0  = clampGet(i0);
    const float y1  = clampGet(i0 + 1);
    const float y2  = clampGet(i0 + 2);

    const float c0 = y0;
    const float c1 = 0.5f * (y1 - ym1);
    const float c2 = ym1 - 2.5f * y0 + 2.0f * y1 - 0.5f * y2;
    const float c3 = 0.5f * (y2 - ym1) + 1.5f * (y0 - y1);

    return ((c3 * f + c2) * f + c1) * f + c0;
}

} // namespace xleth::audio
