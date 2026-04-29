#pragma once
#include <juce_audio_basics/juce_audio_basics.h>

namespace xleth::dsp {

struct WORLDParams {
    double sampleRate          = 44100.0;
    double pitchShiftSemitones = 0.0;
    double stretchRatio        = 1.0;
    bool   formantPreserve     = false; // currently no-op: WORLD is formant-aware by construction
};

// Offline pitch/time stretch using WORLD: Harvest (F0) → CheapTrick (spectral
// envelope) → D4C (aperiodicity) → modify f0/time axis → Synthesis. Each
// channel is processed independently (WORLD is monophonic). Caller-side
// resampling between clip and engine sample rates is the dispatcher's
// responsibility — this function works at params.sampleRate.
//
// Output length = round(input.getNumSamples() * stretchRatio).
// Safe to call from a non-audio worker thread; allocates internally.
juce::AudioBuffer<float> processWORLD(
    const juce::AudioBuffer<float>& input,
    const WORLDParams& params);

} // namespace xleth::dsp
