#pragma once

#include <juce_audio_basics/juce_audio_basics.h>

#include <atomic>
#include <cmath>

// ─── TrackMixer ──────────────────────────────────────────────────────────────
// Per-track gain staging: volume, constant-power pan, peak metering.
// One instance per track slot. All methods are audio-thread safe (no alloc).

class TrackMixer
{
public:
    // Apply volume gain to all channels in-place.
    static void applyVolume(juce::AudioBuffer<float>& buffer, float volume)
    {
        if (std::abs(volume - 1.0f) > 1e-6f)
            buffer.applyGain(volume);
    }

    // Constant-power pan law.
    // pan ∈ [-1, +1]: -1 = hard left, 0 = center, +1 = hard right.
    // angle = (pan + 1) * π/4
    // L = cos(angle), R = sin(angle)
    // At center (pan=0): L=R = cos(π/4) ≈ 0.707 → −3 dB each → unity sum-of-squares.
    static void applyPan(juce::AudioBuffer<float>& buffer, float pan)
    {
        if (buffer.getNumChannels() < 2) return;

        const float angle = (pan + 1.0f) * (juce::MathConstants<float>::pi * 0.25f);
        const float gainL = std::cos(angle);
        const float gainR = std::sin(angle);

        buffer.applyGain(0, 0, buffer.getNumSamples(), gainL);
        buffer.applyGain(1, 0, buffer.getNumSamples(), gainR);
    }

    // Mid-side stereo spread.
    // width: 0.0 = mono (side = 0), 1.0 = unchanged, 2.0 = exaggerated stereo.
    static void applyStereoSpread(juce::AudioBuffer<float>& buffer, float width)
    {
        if (buffer.getNumChannels() < 2) return;
        if (std::abs(width - 1.0f) < 1e-6f) return;  // no-op at unity

        const int n = buffer.getNumSamples();
        float* L = buffer.getWritePointer(0);
        float* R = buffer.getWritePointer(1);
        for (int i = 0; i < n; ++i)
        {
            const float mid  = (L[i] + R[i]) * 0.5f;
            const float side = (L[i] - R[i]) * 0.5f;
            L[i] = mid + side * width;
            R[i] = mid - side * width;
        }
    }

    // Measure peak absolute values for L and R channels.
    static void measurePeaks(const juce::AudioBuffer<float>& buffer,
                             float& peakL, float& peakR)
    {
        peakL = 0.0f;
        peakR = 0.0f;
        const int n = buffer.getNumSamples();
        if (n == 0) return;

        if (buffer.getNumChannels() >= 1)
            peakL = buffer.getMagnitude(0, 0, n);
        if (buffer.getNumChannels() >= 2)
            peakR = buffer.getMagnitude(1, 0, n);
    }

    // Full per-track process: volume → pan → spread → measure peaks.
    // Returns measured peaks after processing.
    static void process(juce::AudioBuffer<float>& buffer,
                        float volume, float pan, float spread,
                        float& peakL, float& peakR)
    {
        applyVolume(buffer, volume);
        applyPan(buffer, pan);
        applyStereoSpread(buffer, spread);
        measurePeaks(buffer, peakL, peakR);
    }
};
