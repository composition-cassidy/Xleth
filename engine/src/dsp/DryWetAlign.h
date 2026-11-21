#pragma once

#include <juce_audio_basics/juce_audio_basics.h>

#include <cstdint>

// ─── DryWetAlign ────────────────────────────────────────────────────────────
//
// Measures how far an offline-rendered WET signal lags the DRY signal it will
// be blended against, so the Pitch Shifter's Clip mode can line the two up
// before a Mix < 100 % blend. A blend of two copies of the same material that
// are a few samples apart is a comb filter, and it sounds like a bug.
//
// No per-method constants. Every render is measured on its own material:
//
//   Waveform basis  — normalised cross-correlation of the two waveforms. Only
//                     meaningful when wet and dry share pitch (a formant-only
//                     transform, or any transform whose fx pitch is exactly
//                     zero). Sample-exact, and it is the case where a comb
//                     is audible across the whole spectrum.
//
//   Envelope basis  — normalised cross-correlation of the two smoothed,
//                     mean-removed amplitude envelopes. Used when the pitch
//                     differs (a waveform correlation between two different
//                     pitches has no meaningful peak).
//
// A measurement is CONFIDENT only when its correlation peak clears the bar for
// its basis. A non-confident measurement must not be applied: the caller
// reports it and leaves the wet unshifted. Faking a compensation from a weak
// peak would move the wet by an arbitrary amount.
//
// The waveform bar is high on purpose. At the same pitch the whole point is a
// comb-free blend, and a lag only removes a comb when the wet IS the dry,
// delayed. An engine that resynthesises (per-period PSOLA, say) can correlate
// at 0.7 and still notch by 7 dB at the best lag — that is not an alignment
// problem a lag can fix, so it is reported, and the envelope basis is NOT
// consulted as a fallback for it.
//
// Worker thread only (allocates, runs FFTs).

namespace xleth::dsp
{
    struct LagEstimate
    {
        enum class Basis : int { None = 0, Waveform = 1, Envelope = 2 };

        // Positive = wet is LATE: wet[i + lag] lines up with dry[i].
        int    lagSamples = 0;
        double peak       = 0.0;     // normalised correlation at lagSamples, [-1, 1]
        Basis  basis      = Basis::None;
        bool   confident  = false;
    };

    static constexpr double kWaveformConfidence = 0.9;
    static constexpr double kEnvelopeConfidence = 0.5;

    // dry/wet are read for their first `dryLen`/`wetLen` samples (all channels
    // summed to mono). The search covers lags in [-maxLag, maxLag]. The analysis
    // window is capped at 2^18 samples. `samePitch` selects the waveform basis
    // (and ONLY it); a pitch difference selects the envelope basis.
    LagEstimate estimateWetLag(const juce::AudioBuffer<float>& dry, int dryLen,
                               const juce::AudioBuffer<float>& wet, int wetLen,
                               int maxLag, bool samePitch, double sampleRate);

    // Raw building block, exposed for the tests: normalised cross-correlation
    // peak of two mono signals over [-maxLag, maxLag].
    LagEstimate correlationPeak(const float* dry, int dryLen,
                                const float* wet, int wetLen, int maxLag);
}
