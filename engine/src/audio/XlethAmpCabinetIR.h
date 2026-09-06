#pragma once

#include <juce_dsp/juce_dsp.h>

#include <algorithm>
#include <array>
#include <cmath>
#include <vector>

// ─── XlethAmpCabinetIR ───────────────────────────────────────────────────────
//
//   *** PLACEHOLDER IMPULSE RESPONSES — NOT RECORDED CABINETS ***
//
// Amp Stack spec §6 requires four cabinet impulse responses, every one of them
// CC0 or self-recorded, with provenance on file.  Those recordings do not exist
// yet.  Until they do, this file SYNTHESISES four v0 placeholder IRs
// procedurally so the rest of the effect can be built, measured and tested
// against a real convolution stage instead of a stub.
//
// Provenance for these placeholders is recorded beside this header in
// XlethAmpCabinetIR.PROVENANCE.md.  Read it before shipping anything.
//
// What a placeholder is:
//   A designed FIR whose magnitude curve matches the *character note* in spec
//   §6 — the low-end resonance, the body/scoop, the presence or mid spike, and
//   the top roll-off frequency — plus a handful of early reflections that give
//   the response the comb structure a real baffle has.  It is a plausible
//   cabinet curve.  It is NOT a measurement of any speaker, and nobody should
//   pretend otherwise.
//
// How it is built (all of this runs in prepareToPlay, never on the audio
// thread):
//   1. A unit impulse plus 3 early reflections (baffle / back-wall bounce).
//   2. A cascade of biquads designed at the ENGINE sample rate:
//        high-pass  → cabinet's low-frequency cutoff
//        low peak   → cone/cabinet resonance
//        body peak  → low-mid body (or scoop, when the dB value is negative)
//        mid peak   → presence peak / V30-style mid spike
//        low-pass   → top roll-off (the "≈5 kHz" in the spec's character notes)
//        high shelf → residual top tilt
//   3. An exponential decay envelope with a raised-cosine fade-out, so the IR
//      truncates without a click.
//   4. Peak-magnitude normalisation: the IR is scaled so max|H(f)| over the
//      audio band is exactly 1.0.  The cabinet stage therefore CANNOT boost at
//      any frequency, which is what makes it pass the spec §10.3 element
//      isolation bound by construction rather than by luck.
//
// Because the biquads are designed at the engine rate, the IR is *generated
// at* the measured engine rate — there is no 44.1-vs-48 assumption anywhere in
// this file, and no resampling error.  When the real recordings land they will
// arrive as fixed-rate WAVs and juce::dsp::Convolution's own load-time
// resampling takes over; the caller's code path does not change.
//
// Length: every voicing below is well under the spec's 100 ms ceiling (the
// longest is 34 ms).  kMaxCabinetIrMs enforces the ceiling.

namespace xleth::audio::amp
{

// ── Cabinet roster (spec §6) ─────────────────────────────────────────────────
enum class CabinetId : int
{
    OpenBack1x12  = 0,
    Alnico2x12    = 1,
    Greenback4x12 = 2,
    V30_4x12      = 3,
};

inline constexpr int kNumCabinets = 4;

// Spec §6 / §9: IR length ≤ 100 ms, hard ceiling.
inline constexpr float kMaxCabinetIrMs = 100.0f;

struct CabReflection
{
    float delayMs = 0.0f;
    float gain    = 0.0f;   // signed — sign flips are what make the comb real
};

// One row per cabinet.  Everything about a cabinet's character lives here; the
// synthesiser below is generic.  Adding a fifth placeholder cab is a data edit.
struct CabinetVoicing
{
    const char* displayName;
    const char* characterNote;   // quoted from spec §6

    float lengthMs;              // total IR length (≤ kMaxCabinetIrMs)
    float decayMs;               // exponential decay time constant

    float hpHz,   hpQ;           // cabinet low cutoff
    float resHz,  resQ,  resDb;  // cone / cabinet resonance
    float bodyHz, bodyQ, bodyDb; // low-mid body (+) or scoop (−)
    float midHz,  midQ,  midDb;  // presence peak / mid spike
    float lpHz,   lpQ;           // top roll-off
    float tiltHz, tiltDb;        // residual high-shelf tilt

    std::array<CabReflection, 3> reflections;
};

// ── The four v0 placeholder voicings ────────────────────────────────────────
// Character notes are copied verbatim from spec §6 so a future reader can see
// what each row was aiming at without opening the doc.
inline const CabinetVoicing& cabinetVoicing(CabinetId id) noexcept
{
    static const CabinetVoicing table[kNumCabinets] =
    {
        // Open-back 1×12 — "Round, open, less mid focus"
        // Open backs lose low end (high HP), have a mild cone resonance, and
        // deliberately do NOT have the mid focus a closed 4×12 has.
        {
            "Open-back 1x12", "Round, open, less mid focus",
            28.0f, 9.0f,
            105.0f, 0.707f,
             95.0f, 1.40f,  3.5f,
            480.0f, 0.90f, -2.5f,
           2200.0f, 1.10f,  2.0f,
           6000.0f, 0.85f,
           4500.0f, -2.0f,
            { CabReflection{0.42f, -0.30f}, CabReflection{1.10f, 0.18f}, CabReflection{2.05f, -0.10f} }
        },
        // Alnico 2×12 — "Warm, vintage compression feel"
        // Warmth = a low-mid body lift at ~700 Hz plus an early top roll-off.
        {
            "Alnico 2x12", "Warm, vintage compression feel",
            32.0f, 11.0f,
             82.0f, 0.707f,
             88.0f, 1.60f,  4.0f,
            700.0f, 0.80f,  2.5f,
           1900.0f, 1.30f,  1.0f,
           5500.0f, 0.80f,
           4000.0f, -3.5f,
            { CabReflection{0.55f, -0.34f}, CabReflection{1.35f, 0.20f}, CabReflection{2.60f, -0.12f} }
        },
        // Greenback 4×12 — "Smooth top roll-off ≈5 kHz"
        // The 5 kHz figure in the spec is the low-pass corner below.
        {
            "Greenback 4x12", "Smooth top roll-off ~5 kHz",
            34.0f, 12.0f,
             76.0f, 0.707f,
             80.0f, 1.70f,  4.5f,
            560.0f, 0.90f, -1.5f,
           1700.0f, 1.20f,  2.5f,
           5000.0f, 0.75f,
           5000.0f, -5.0f,
            { CabReflection{0.62f, -0.36f}, CabReflection{1.50f, 0.22f}, CabReflection{3.00f, -0.14f} }
        },
        // V30 4×12 — "Mid spike ≈3 kHz, extended top"
        // The 3 kHz figure is the mid peak below; "extended top" is the higher
        // low-pass corner.  The scoop at 520 Hz is what makes the spike read as
        // a spike rather than as a broad mid lift.
        {
            "V30 4x12", "Mid spike ~3 kHz, extended top",
            34.0f, 12.0f,
             74.0f, 0.707f,
             78.0f, 1.80f,  4.5f,
            520.0f, 1.00f, -3.5f,
           3000.0f, 1.60f,  5.0f,
           6800.0f, 0.80f,
           5500.0f, -1.5f,
            { CabReflection{0.58f, -0.35f}, CabReflection{1.42f, 0.21f}, CabReflection{2.80f, -0.13f} }
        },
    };

    const int idx = juce::jlimit(0, kNumCabinets - 1, static_cast<int>(id));
    return table[idx];
}

inline const char* cabinetDisplayName(CabinetId id) noexcept
{
    return cabinetVoicing(id).displayName;
}

// ── Synthesis ────────────────────────────────────────────────────────────────
// PREPARE-TIME ONLY.  Allocates.  Never call from the audio callback.
//
// Returns a 1-channel buffer holding the placeholder IR, generated at
// `sampleRate` and peak-magnitude normalised so max|H(f)| == 1.0.
inline juce::AudioBuffer<float> synthesizePlaceholderCabinetIR(CabinetId id,
                                                               double sampleRate)
{
    const CabinetVoicing& v = cabinetVoicing(id);

    // Spec §6 / §9 hard ceiling, enforced rather than assumed.
    const float lengthMs = std::min(v.lengthMs, kMaxCabinetIrMs);
    const int   numSamples =
        std::max(16, static_cast<int>(std::lround(sampleRate * lengthMs * 0.001)));

    juce::AudioBuffer<float> ir(1, numSamples);
    ir.clear();
    float* d = ir.getWritePointer(0);

    // 1. Impulse + early reflections (the baffle bounce that gives a cab its
    //    comb structure).  Reflection delays are in ms so they track the rate.
    d[0] = 1.0f;
    for (const auto& r : v.reflections)
    {
        const int n = static_cast<int>(std::lround(sampleRate * r.delayMs * 0.001));
        if (n > 0 && n < numSamples)
            d[n] += r.gain;
    }

    // 2. Biquad cascade, every coefficient designed at `sampleRate`.
    {
        juce::dsp::ProcessSpec spec;
        spec.sampleRate       = sampleRate;
        spec.maximumBlockSize = static_cast<juce::uint32>(numSamples);
        spec.numChannels      = 1;

        using Coeffs = juce::dsp::IIR::Coefficients<float>;
        // Corners are clamped below Nyquist so a low engine rate (or a future
        // 22.05 kHz proxy path) can never hand JUCE an out-of-range frequency.
        const float nyq = static_cast<float>(sampleRate * 0.5);
        const auto  fc  = [nyq](float hz) { return juce::jlimit(20.0f, nyq * 0.97f, hz); };

        std::array<juce::dsp::IIR::Filter<float>, 6> chain;
        chain[0].coefficients = Coeffs::makeHighPass  (sampleRate, fc(v.hpHz),   v.hpQ);
        chain[1].coefficients = Coeffs::makePeakFilter(sampleRate, fc(v.resHz),  v.resQ,
                                                       juce::Decibels::decibelsToGain(v.resDb));
        chain[2].coefficients = Coeffs::makePeakFilter(sampleRate, fc(v.bodyHz), v.bodyQ,
                                                       juce::Decibels::decibelsToGain(v.bodyDb));
        chain[3].coefficients = Coeffs::makePeakFilter(sampleRate, fc(v.midHz),  v.midQ,
                                                       juce::Decibels::decibelsToGain(v.midDb));
        chain[4].coefficients = Coeffs::makeLowPass   (sampleRate, fc(v.lpHz),   v.lpQ);
        chain[5].coefficients = Coeffs::makeHighShelf (sampleRate, fc(v.tiltHz), 0.707f,
                                                       juce::Decibels::decibelsToGain(v.tiltDb));

        for (auto& f : chain)
        {
            f.prepare(spec);
            f.reset();
        }

        for (auto& f : chain)
            for (int s = 0; s < numSamples; ++s)
                d[s] = f.processSample(d[s]);
    }

    // 3. Decay envelope + raised-cosine fade-out (no truncation click).
    {
        const float tau      = std::max(1.0e-4f, v.decayMs * 0.001f / 3.0f);
        const int   fadeFrom = static_cast<int>(numSamples * 0.85);
        for (int s = 0; s < numSamples; ++s)
        {
            const float t = static_cast<float>(s) / static_cast<float>(sampleRate);
            float g = std::exp(-t / tau);
            if (s >= fadeFrom)
            {
                const float u = static_cast<float>(s - fadeFrom)
                              / static_cast<float>(std::max(1, numSamples - fadeFrom));
                g *= 0.5f * (1.0f + std::cos(juce::MathConstants<float>::pi * u));
            }
            d[s] *= g;
        }
    }

    // 4. Peak-magnitude normalisation.  A direct DFT of the finished IR on a
    //    log-spaced grid — a few hundred thousand MACs, once, at prepare time.
    //    Scaling by 1/max|H| guarantees the cabinet stage has unity gain at its
    //    loudest frequency and attenuates everywhere else, so it can never
    //    produce unbounded gain (spec §10.3).
    {
        constexpr int kGridPoints = 512;
        const double  fLo = 20.0;
        const double  fHi = std::min(20000.0, sampleRate * 0.45);

        double maxMag = 0.0;
        if (fHi > fLo)
        {
            const double ratio = std::log(fHi / fLo) / (kGridPoints - 1);
            for (int k = 0; k < kGridPoints; ++k)
            {
                const double f = fLo * std::exp(ratio * k);
                const double w = 2.0 * juce::MathConstants<double>::pi * f / sampleRate;
                double re = 0.0, im = 0.0;
                for (int s = 0; s < numSamples; ++s)
                {
                    const double ph = w * s;
                    re += d[s] * std::cos(ph);
                    im -= d[s] * std::sin(ph);
                }
                maxMag = std::max(maxMag, std::sqrt(re * re + im * im));
            }
        }

        const float scale = (maxMag > 1.0e-9) ? static_cast<float>(1.0 / maxMag) : 1.0f;
        juce::FloatVectorOperations::multiply(d, scale, numSamples);
    }

    return ir;
}

// Convenience for tests and diagnostics: magnitude of an IR at one frequency,
// in dB relative to unity.  Prepare-time / offline only.
inline double cabinetIrMagnitudeDb(const juce::AudioBuffer<float>& ir,
                                   double sampleRate, double freqHz)
{
    const int n = ir.getNumSamples();
    const float* d = ir.getReadPointer(0);
    const double w = 2.0 * juce::MathConstants<double>::pi * freqHz / sampleRate;
    double re = 0.0, im = 0.0;
    for (int s = 0; s < n; ++s)
    {
        const double ph = w * s;
        re += d[s] * std::cos(ph);
        im -= d[s] * std::sin(ph);
    }
    return 20.0 * std::log10(std::max(1.0e-12, std::sqrt(re * re + im * im)));
}

} // namespace xleth::audio::amp
