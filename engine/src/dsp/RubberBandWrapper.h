#pragma once
#include <juce_audio_basics/juce_audio_basics.h>

namespace xleth::dsp {

struct RubberBandParams {
    double sampleRate          = 44100.0;
    double pitchShiftSemitones = 0.0;   // fractional semitones (semis + cents/100)
    double stretchRatio        = 1.0;   // > 1 → slower / longer output
    bool   formantPreserve     = false;

    // Explicit formant scaling ratio (target/source), independent of
    // pitchShiftSemitones — RubberBandStretcher::setFormantScale(). 0.0 (the
    // default) means "automatic": 1/pitchScale when formantPreserve is set,
    // 1.0 otherwise — i.e. ordinary PITCH behaviour, unchanged from before this
    // field existed. A non-zero value shifts the formant envelope by THAT
    // amount regardless of formantPreserve/pitchShiftSemitones, which is what
    // a standalone FORMANT SHIFT op needs (pitch held at 1.0, formants moved
    // on their own — something RubberBand's Options flags alone cannot
    // express, per setFormantScale's own doc comment).
    double formantScaleOverride = 0.0;
};

// Returns a new buffer: same channel count, length ≈ round(input * stretchRatio).
// Offline mode (OptionProcessOffline). Safe to call from a non-audio thread.
// Creates a fresh RubberBandStretcher per call — pure function, no shared state.
juce::AudioBuffer<float> processRubberBand(
    const juce::AudioBuffer<float>& input,
    const RubberBandParams& params);

} // namespace xleth::dsp
