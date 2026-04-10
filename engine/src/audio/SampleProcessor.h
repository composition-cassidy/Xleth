#pragma once

#include <juce_audio_basics/juce_audio_basics.h>

// Precomputed sample effects — applied destructively to an AudioBuffer copy
// before the Sampler consumes it. The SampleBank's stored buffer stays
// pristine; MixEngine re-applies active flags on every rebuild, so toggling
// a flag off naturally restores the original.
class SampleProcessor {
public:
    static void removeDCOffset(juce::AudioBuffer<float>& buffer);
    static void normalize(juce::AudioBuffer<float>& buffer, float targetPeak = 1.0f);
    static void reversePolarity(juce::AudioBuffer<float>& buffer);
    static void reverse(juce::AudioBuffer<float>& buffer);

    struct Flags {
        bool dcOffsetRemoved  = false;
        bool normalized       = false;
        bool polarityReversed = false;
        bool reversed         = false;
    };

    // Apply active flags in canonical order: DC → normalize → polarity → reverse.
    static void applyFlags(juce::AudioBuffer<float>& buffer, const Flags& f);
};
