#pragma once
#include <juce_audio_basics/juce_audio_basics.h>

namespace xleth::dsp {

struct PhaseVocoderParams {
    double sampleRate          = 44100.0;
    double pitchShiftSemitones = 0.0;   // combined: semis + cents/100
    double stretchRatio        = 1.0;   // >1 = longer output
    bool   formantPreserve     = false; // cepstral envelope preservation
};

// Returns a new buffer: same channel count,
// length = round(input.getNumSamples() * stretchRatio).
// Time stretching via analysis/synthesis hop interpolation.
// Pitch shifting via Lanczos-3 spectral resampling in IF domain.
// Safe to call from a non-audio thread.
juce::AudioBuffer<float> processPhaseVocoder(
    const juce::AudioBuffer<float>& input,
    const PhaseVocoderParams& params);

} // namespace xleth::dsp
