#pragma once
#include <juce_audio_basics/juce_audio_basics.h>

namespace xleth::dsp {

struct RubberBandParams {
    double sampleRate          = 44100.0;
    double pitchShiftSemitones = 0.0;   // fractional semitones (semis + cents/100)
    double stretchRatio        = 1.0;   // > 1 → slower / longer output
    bool   formantPreserve     = false;
};

// Returns a new buffer: same channel count, length ≈ round(input * stretchRatio).
// Offline mode (OptionProcessOffline). Safe to call from a non-audio thread.
// Creates a fresh RubberBandStretcher per call — pure function, no shared state.
juce::AudioBuffer<float> processRubberBand(
    const juce::AudioBuffer<float>& input,
    const RubberBandParams& params);

} // namespace xleth::dsp
