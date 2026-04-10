#pragma once
#include <juce_audio_basics/juce_audio_basics.h>

namespace xleth::dsp {

struct PSOLAParams {
    double sampleRate       = 44100.0;
    int    pitchOffsetSemis = 0;
    int    pitchOffsetCents = 0;
    double stretchRatio     = 1.0;   // > 1 → slower / longer output
    bool   formantPreserve  = false;
};

// Returns a new buffer: same channel count,
// length = round(input.getNumSamples() * stretchRatio).
// Processes each channel independently. Safe to call from a non-audio thread.
juce::AudioBuffer<float> processTDPSOLA(
    const juce::AudioBuffer<float>& input,
    const PSOLAParams& params);

} // namespace xleth::dsp
