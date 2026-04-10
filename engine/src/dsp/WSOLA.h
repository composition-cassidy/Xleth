#pragma once
#include <juce_audio_basics/juce_audio_basics.h>

namespace xleth::dsp {

struct WSOLAParams {
    double sampleRate          = 44100.0;
    double pitchShiftSemitones = 0.0;   // combined: semis + cents/100
    double stretchRatio        = 1.0;   // >1 = longer output
    bool   formantPreserve     = false; // reserved (warns, then proceeds without)
};

// Returns a new buffer: same channel count,
// length = round(input.getNumSamples() * stretchRatio).
// Pitch shifting uses a resample-then-WSOLA pipeline.
// Safe to call from a non-audio thread.
juce::AudioBuffer<float> processWSOLA(
    const juce::AudioBuffer<float>& input,
    const WSOLAParams& params);

} // namespace xleth::dsp
