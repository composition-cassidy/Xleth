#pragma once

#include "audio/XlethEffectBase.h"
#include <juce_dsp/juce_dsp.h>

#include <algorithm>
#include <atomic>
#include <cmath>
#include <cstdint>

// ─── SmartBalanceEffect ─────────────────────────────────────────────────────
// A gentle four-band leveller: the "even everything out" half of an OTT-style
// upward + downward multiband compressor, without its harshness, its pumping or
// its level jump, plus an optional Warmth stage. (Rewritten 2026-11; v1 pulled
// every band up to the full-band level, so by default it boosted Air +4..6 dB,
// played +3 LU louder and lifted the noise floor ~3 dB; its Preserve only scaled
// the correction back down; and a partial Mix combed at the crossovers.)
//
// Signal flow (stereo-linked, zero latency):
//
//   in ─► LR4 tree 150 / 800 / 4000 Hz (balanced; the four bands sum to an allpass)
//      ─► per band: detectors ─► tonal + dynamic gain (+ warmth tilt)
//      ─► warmth saturation on Sub and Low-mid (level-relative, DC-blocked)
//      ─► dry/wet against the SAME allpassed dry, per band (no comb at any Mix)
//      ─► loudness match (predicted + measured BS.1770) ─► output trim ─► out
//
// Per band, every 32 samples:
//   S       short-term level (RMS over ~Response; capped per sample by Preserve)
//   P       program level: S averaged over ~20 x Response (dB, symmetric), only
//           while the band plays, so it holds through silence
//   tonal   (Relative) P against the balanced reference: anchor + share[b] +
//           offset[b], where `share` is the band layout of finished mixes and
//           `anchor` the presence-weighted fit of all bands' P to it. Slow,
//           symmetric and kept through gaps: an EQ that follows the material.
//   dynamic S against P (Relative) or the literal target (Absolute): quiet
//           passages come up, bursts go down.
// Both pass a 1.5 dB tolerance, scale with Amount x band amount (at most ~3:1
// down, ~2.5:1 up) and saturate smoothly (cut 12 dB; lift 3..7 dB by band, Sub
// and Air least, and tonal Sub / Air lifts at reduced strength: lifting the
// extremes is the mud-and-fizz half of OTT). Lifts go only to bands that are
// really there (a voice clip's empty sub band is never pulled out of the
// noise), above the band's Floor, never deep under P.
//
// Dips and gaps. A sudden drop (fast level 12 dB under S) or near-silence
// (under the Floor, or 30 dB under P) first HOLDS the detector and the dynamic
// gain for 120 ms, so the room between hits and syllables is never pumped;
// after that a dip is just a quieter passage, while a gap lets the dynamic gain
// return to 0. A gap therefore never gets more gain than the notes around it.
//
// Preserve: a hit (fast level 6 dB over S) freezes the band's dynamic gain for
// up to 100 ms x Preserve and keeps the hit out of the detector, so hits keep
// their shape and do not pull the band down after them. An onset out of silence
// fast-tracks the detector instead, so the leveller knows the new level at once.
//
// Warmth (0 = bit-transparent): a gentle tilt (+0.5 / +2 / -1 / -3 dB) and
// soft, slightly asymmetric saturation (mostly 2nd, some 3rd harmonic; ~1 %
// THD at 50 %, 3-4.5 % at 100 %) on Sub and Low-mid only, driven relative to
// the band's own peak level so it sounds the same at any input gain. Nothing
// above 800 Hz is saturated, so no aliasing and no fizz.
//
// Loudness match: the PREDICTED part is what the tonal gains and the tilt do to
// K-weighted loudness (from each band's P): instant, so a short sample is
// matched from its first note. The MEASURED part compares BS.1770 K-weighted
// input and output over ~3 s and trims what the prediction misses (the net
// effect of the evening, saturation). Output trim comes after both.
//
// Parameters (APVTS):
//   amount 0-100 %, preserve 0-100 %, response 10-500 ms, mix 0-100 %,
//   mode Relative/Absolute, target_* -40..12 dB, bandamt_* 0-100 %,
//   floor_* -96..-20 dB, warmth 0-100 %, output -12..12 dB, loudness_match.
//
// Metering slots: 0-3 band level (dB), 4-7 band gain incl. warmth tilt (dB).
//
// pluginId: "smartbalance"

class SmartBalanceEffect : public XlethEffectBase
{
public:
    static constexpr int kBands = 4;

    SmartBalanceEffect() : XlethEffectBase("smartbalance", createLayout())
    {
        registerSmoothedParam("amount",   SmoothType::Linear, 20.0f);
        registerSmoothedParam("preserve", SmoothType::Linear, 20.0f);
        registerSmoothedParam("response", SmoothType::Linear, 20.0f);
        registerSmoothedParam("mix",      SmoothType::Linear, 20.0f);
        registerSmoothedParam("warmth",   SmoothType::Linear, 30.0f);
        registerSmoothedParam("output",   SmoothType::Linear, 20.0f);

        for (int b = 0; b < kBands; ++b)
        {
            registerSmoothedParam(targetId(b),  SmoothType::Linear, 20.0f);
            registerSmoothedParam(bandAmtId(b), SmoothType::Linear, 20.0f);
            registerSmoothedParam(floorId(b),   SmoothType::Linear, 20.0f);
        }

        modeParam_  = apvts_.getRawParameterValue("mode");
        matchParam_ = apvts_.getRawParameterValue("loudness_match");

        // Until the first block: no level, no reference (the display then
        // draws nothing rather than a 0 dB reading).
        for (int b = 0; b < kBands; ++b)
        {
            debugLevel_[b].store(-100.0f, std::memory_order_relaxed);
            debugRef_[b].store(-100.0f, std::memory_order_relaxed);
        }
    }

    // ── Constants (public: the tests read them) ──────────────────────────────
    static constexpr int   kTick          = 32;     // control period, samples
    static constexpr float kShareDb[kBands]      = { -5.5f, -6.0f, -9.0f, -13.5f };
    // Lift limits. Sub and Air are the bands whose lifts turn to mud and fizz
    // (and the Air band carries sibilance and hiss), so they get the least.
    static constexpr float kLiftMaxDb[kBands]    = { 4.0f, 7.0f, 6.0f, 4.0f };   // tonal
    static constexpr float kDynLiftMaxDb[kBands] = { 4.0f, 6.0f, 5.0f, 3.0f };   // dynamic
    static constexpr float kCutMaxDb      = 12.0f;
    static constexpr float kToleranceDb   = 1.5f;
    static constexpr float kCutStrength   = 0.67f;  // at Amount 100 %: ~3:1
    static constexpr float kLiftStrength  = 0.60f;  // ~2.5:1
    static constexpr float kTimeScale[kBands]    = { 1.6f, 1.15f, 1.0f, 0.85f };
    static constexpr float kMinDetMs[kBands]     = { 20.0f, 8.0f, 5.0f, 4.0f };
    static constexpr float kMinAttackMs[kBands]  = { 25.0f, 10.0f, 4.0f, 3.0f };
    static constexpr float kMinReleaseMs[kBands] = { 60.0f, 30.0f, 15.0f, 12.0f };
    static constexpr float kFastMs[kBands]       = { 12.0f, 6.0f, 3.0f, 2.0f };
    // Tonal lifts of the extremes are the "hype" half of an OTT chain (more
    // sub mud, more fizz and sibilance); cutting an excess is the balancing
    // half. Sub and Air lift at half strength.
    static constexpr float kTonalLiftScale[kBands] = { 0.5f, 1.0f, 1.0f, 0.6f };
    static constexpr float kGapDb         = 30.0f;  // fast this far under the program level: a gap
    static constexpr float kWarmTiltDb[kBands]   = { 0.5f, 2.0f, -1.0f, -3.0f };
    static constexpr float kWarmDrive[2]         = { 0.42f, 0.50f };  // on a peak-normalised signal
    static constexpr float kWarmBias      = 0.35f;
    static constexpr float kWarmLevelFloor = 0.015848932f;            // -18 dB (power)
    static constexpr float kDipDb         = 12.0f;  // fast this far under the level: a dip
    static constexpr float kDipHoldMs     = 120.0f; // ...that holds; longer is a gap
    static constexpr float kHitDb         = 6.0f;   // fast over level: a hit
    static constexpr float kOnsetDb       = 18.0f;  // ...this far over: out of a gap
    static constexpr float kRearmDb       = 3.0f;
    static constexpr float kMaxHoldMs     = 100.0f;
    static constexpr float kOnsetTrackMs  = 50.0f;
    static constexpr float kGapFadeStartDb = -24.0f; // lifts fade out below this deviation
    static constexpr float kGapFadeEndDb   = -36.0f;
    static constexpr float kLoudnessTauS  = 3.0f;   // the measured residual's window
    static constexpr float kMakeupTauS    = 0.5f;
    static constexpr float kMakeupMaxDb   = 12.0f;  // predicted part
    static constexpr float kResidualMaxDb = 6.0f;   // measured part
    // Average BS.1770 K-weighting over each band for typical material (the RLB
    // high-pass costs the sub band ~2.5 dB, the shelf gives the top +1.5 / +4).
    static constexpr float kLoudnessWeight[kBands] = { 0.56f, 1.0f, 1.4f, 2.5f };

    // ── prepareEffect ───────────────────────────────────────────────────────
    void prepareEffect(double sampleRate, int maxBlockSize) override
    {
        sampleRate_ = sampleRate;

        juce::dsp::ProcessSpec spec;
        spec.sampleRate       = sampleRate;
        spec.maximumBlockSize = static_cast<juce::uint32>(std::max(1, maxBlockSize));
        spec.numChannels      = 2;

        crossoverMid_.prepare(spec);
        crossoverLow_.prepare(spec);
        crossoverHigh_.prepare(spec);
        allpassLow_.prepare(spec);
        allpassHigh_.prepare(spec);

        allpassLow_.setType(juce::dsp::LinkwitzRileyFilterType::allpass);
        allpassHigh_.setType(juce::dsp::LinkwitzRileyFilterType::allpass);

        crossoverLow_.setCutoffFrequency(150.0f);
        crossoverMid_.setCutoffFrequency(800.0f);
        crossoverHigh_.setCutoffFrequency(4000.0f);
        allpassLow_.setCutoffFrequency(150.0f);
        allpassHigh_.setCutoffFrequency(4000.0f);

        for (auto* k : { &kIn_[0], &kIn_[1], &kOut_[0], &kOut_[1] })
            k->design(sampleRate);

        const double sr   = sampleRate;
        const double tick = static_cast<double>(kTick) / sr;
        for (int b = 0; b < kBands; ++b)
            aFast_[b] = onePole(kFastMs[b] * 0.001, 1.0 / sr);
        aSatRise_    = onePole(0.005, 1.0 / sr);
        aSatFall_    = onePole(0.080, 1.0 / sr);
        dcR_         = static_cast<float>(std::exp(-2.0 * juce::MathConstants<double>::pi * 10.0 / sr));
        aTonal_      = onePole(0.08, tick);
        aSettle_     = onePole(0.03, tick);
        aLoudness_   = onePole(kLoudnessTauS, tick);
        aMakeup_     = onePole(kMakeupTauS, tick);
        aMakeupFast_ = onePole(0.03, tick);
        aPred_       = onePole(0.05, tick);
        makeupSettleTicks_ = std::max(1, static_cast<int>(sr / kTick));   // 1 s
        holdTicksPerMs_  = static_cast<float>(sr * 0.001 / kTick);
        onsetTicks_      = std::max(1, static_cast<int>(std::lround(kOnsetTrackMs * holdTicksPerMs_)));
        settleTicks_       = std::max(1, static_cast<int>(std::lround(100.0 * holdTicksPerMs_)));
        dipHoldTicks_      = std::max(1, static_cast<int>(std::lround(kDipHoldMs * holdTicksPerMs_)));
        lastResponse_ = -1.0f;   // force a coefficient rebuild on the first tick

        hAmount_   = resolveSmoothed("amount");
        hPreserve_ = resolveSmoothed("preserve");
        hResponse_ = resolveSmoothed("response");
        hMix_      = resolveSmoothed("mix");
        hWarmth_   = resolveSmoothed("warmth");
        hOutput_   = resolveSmoothed("output");
        for (int b = 0; b < kBands; ++b)
        {
            hTarget_[b]  = resolveSmoothed(targetId(b));
            hBandAmt_[b] = resolveSmoothed(bandAmtId(b));
            hFloor_[b]   = resolveSmoothed(floorId(b));
        }

        clearState();
    }

    // ── resetEffect ─────────────────────────────────────────────────────────
    void resetEffect() override
    {
        crossoverMid_.reset();
        crossoverLow_.reset();
        crossoverHigh_.reset();
        allpassLow_.reset();
        allpassHigh_.reset();
        clearState();
    }

    // ── processEffect ───────────────────────────────────────────────────────
    void processEffect(juce::AudioBuffer<float>& buffer, juce::MidiBuffer& /*midi*/) override
    {
        juce::ScopedNoDenormals noDenormals;

        const int numSamples = buffer.getNumSamples();
        const int numCh      = buffer.getNumChannels();
        if (numSamples <= 0 || numCh <= 0)
            return;

        float* chL = buffer.getWritePointer(0);
        float* chR = numCh > 1 ? buffer.getWritePointer(1) : nullptr;

        const int  mode  = juce::roundToInt(modeParam_->load(std::memory_order_relaxed));
        const bool match = matchParam_->load(std::memory_order_relaxed) >= 0.5f;

        for (int s = 0; s < numSamples; ++s)
        {
            // ── Smoothed parameters: advanced every sample ──────────────
            p_.amount   = hAmount_.next();
            p_.preserve = hPreserve_.next();
            p_.response = hResponse_.next();
            const float mix = hMix_.next() * 0.01f;
            p_.mix      = mix;
            p_.warmth   = hWarmth_.next();
            p_.outputDb = hOutput_.next();
            for (int b = 0; b < kBands; ++b)
            {
                p_.target[b]  = hTarget_[b].next();
                p_.bandAmt[b] = hBandAmt_[b].next();
                p_.floorDb[b] = hFloor_[b].next();
            }

            if (tickPos_ == 0)
                controlTick(mode, match);
            if (++tickPos_ >= kTick)
                tickPos_ = 0;

            // ── Split ───────────────────────────────────────────────────
            const float inL = chL[s];
            const float inR = chR != nullptr ? chR[s] : inL;

            float dL[kBands], dR[kBands];
            splitBands(0, inL, dL);
            if (chR != nullptr) splitBands(1, inR, dR);
            else for (int b = 0; b < kBands; ++b) dR[b] = dL[b];

            float outL = 0.0f, outR = 0.0f;

            // Full-band peak-following level: the floor of the Warmth drive.
            {
                const float sqIn = 0.5f * (inL * inL + inR * inR);
                const float a = sqIn > fullMs_ ? aSatRise_ : aSatFall_;
                fullMs_ += (1.0f - a) * (sqIn - fullMs_);
            }

            for (int b = 0; b < kBands; ++b)
            {
                // Detectors (stereo-linked power). The level detector takes
                // each sample's power capped at detCap_ x its own value, so a
                // hit cannot jerk it up in the samples before the control tick
                // sees the hit (an onset out of silence is fast-tracked there).
                const float sq = 0.5f * (dL[b] * dL[b] + dR[b] * dR[b]);
                fastMs_[b] += (1.0f - aFast_[b]) * (sq - fastMs_[b]);
                if (!detFrozen_[b])
                    ms_[b] += (1.0f - aDet_[b]) * (std::min(sq, detCap_ * ms_[b] + 1.0e-12f) - ms_[b]);

                // Gain, interpolated across the control period.
                const float g = gainLin_[b];
                gainLin_[b] += gainStep_[b];

                float pL = dL[b] * g;
                float pR = dR[b] * g;

                // Warmth saturation (Sub and Low-mid only). The level follower
                // runs even while Warmth is off, so turning it up never starts
                // from a stale (tiny) level and crunches the first notes.
                if (b < 2)
                {
                    const float sqp = 0.5f * (pL * pL + pR * pR);
                    const float a   = sqp > satMs_[b] ? aSatRise_ : aSatFall_;
                    satMs_[b] += (1.0f - a) * (sqp - satMs_[b]);
                    if (satActive_)
                    {
                        pL += saturate(b, 0, pL);
                        pR += saturate(b, 1, pR);
                    }
                }

                // Dry/wet per band: the dry is the same allpassed band, so a
                // partial mix never combs at the crossovers.
                const float oL = dL[b] + mix * (pL - dL[b]);
                const float oR = dR[b] + mix * (pR - dR[b]);
                outL += oL;
                outR += oR;
            }

            // Loudness match, part 1: the predicted make-up (from the tonal
            // gains). Part 2 measures what is left: BS.1770 K-weighted power
            // of the input against the output with part 1 applied.
            const float pred = predLin_;
            predLin_ += predStep_;
            outL *= pred;
            outR *= pred;
            {
                const float kiL = kIn_[0].process(inL),  kiR = kIn_[1].process(inR);
                const float koL = kOut_[0].process(outL), koR = kOut_[1].process(outR);
                accIn_  += 0.5f * (kiL * kiL + kiR * kiR);
                accOut_ += 0.5f * (koL * koL + koR * koR);
            }

            const float post = postLin_;
            postLin_ += postStep_;

            chL[s] = outL * post;
            if (chR != nullptr) chR[s] = outR * post;
        }

        // ── Metering (once per block) ────────────────────────────────────
        const float tiltScale = p_.warmth * 0.01f;
        for (int b = 0; b < kBands; ++b)
        {
            writeMeterValue(b,     levelDb_[b]);
            writeMeterValue(b + 4, gainDb_[b] + tiltScale * kWarmTiltDb[b]);

            debugLevel_[b].store(levelDb_[b], std::memory_order_relaxed);
            debugRef_[b].store(mode == 0 ? (anchorInit_ ? anchorDb_ + kShareDb[b] : -100.0f) : 0.0f,
                               std::memory_order_relaxed);
            debugPresence_[b].store(presence_[b], std::memory_order_relaxed);
            debugTransient_[b].store(holdTicks_[b] > 0 ? 1.0f : 0.0f, std::memory_order_relaxed);
        }
        debugProgram_.store(anchorInit_ ? anchorDb_ : -100.0f, std::memory_order_relaxed);
        debugMakeup_.store(predDb_ + makeupDb_, std::memory_order_relaxed);
    }

    // Param ids, shared with the tests.
    static const char* bandKey(int b)
    {
        static const char* const keys[kBands] = { "sub", "lomid", "upmid", "air" };
        return keys[juce::jlimit(0, kBands - 1, b)];
    }
    static std::string targetId(int b)  { return std::string("target_")  + bandKey(b); }
    static std::string bandAmtId(int b) { return std::string("bandamt_") + bandKey(b); }
    static std::string floorId(int b)   { return std::string("floor_")   + bandKey(b); }

private:
    // ── Parameter layout ────────────────────────────────────────────────────
    static juce::AudioProcessorValueTreeState::ParameterLayout createLayout()
    {
        using Apf = juce::AudioParameterFloat;
        using Apc = juce::AudioParameterChoice;
        using Apb = juce::AudioParameterBool;
        using Pid = juce::ParameterID;
        using Nar = juce::NormalisableRange<float>;

        static const char* const names[kBands] = { "Sub", "LoMid", "UpMid", "Air" };

        juce::AudioProcessorValueTreeState::ParameterLayout layout;
        layout.add(std::make_unique<Apf>(Pid{"amount",   1}, "Amount",   Nar{0.0f,   100.0f, 0.0f, 1.0f},  60.0f, "%"));
        layout.add(std::make_unique<Apf>(Pid{"preserve", 1}, "Preserve", Nar{0.0f,   100.0f, 0.0f, 1.0f},  50.0f, "%"));
        layout.add(std::make_unique<Apf>(Pid{"response", 1}, "Response", Nar{10.0f,  500.0f, 0.0f, 1.0f}, 150.0f, "ms"));
        layout.add(std::make_unique<Apf>(Pid{"mix",      1}, "Mix",      Nar{0.0f,   100.0f, 0.0f, 1.0f}, 100.0f, "%"));
        layout.add(std::make_unique<Apc>(Pid{"mode",     1}, "Mode", juce::StringArray{"Relative", "Absolute"}, 0));

        for (int b = 0; b < kBands; ++b)
            layout.add(std::make_unique<Apf>(Pid{targetId(b), 1}, juce::String("Target ") + names[b],
                                             Nar{-40.0f, 12.0f, 0.0f, 1.0f}, 0.0f, "dB"));
        for (int b = 0; b < kBands; ++b)
            layout.add(std::make_unique<Apf>(Pid{bandAmtId(b), 1}, juce::String("Band Amt ") + names[b],
                                             Nar{0.0f, 100.0f, 0.0f, 1.0f}, 100.0f, "%"));
        for (int b = 0; b < kBands; ++b)
            layout.add(std::make_unique<Apf>(Pid{floorId(b), 1}, juce::String("Floor ") + names[b],
                                             Nar{-96.0f, -20.0f, 0.0f, 1.0f}, -60.0f, "dB"));

        layout.add(std::make_unique<Apf>(Pid{"warmth", 1}, "Warmth", Nar{0.0f, 100.0f, 0.0f, 1.0f}, 0.0f, "%"));
        layout.add(std::make_unique<Apf>(Pid{"output", 1}, "Output", Nar{-12.0f, 12.0f, 0.0f, 1.0f}, 0.0f, "dB"));
        layout.add(std::make_unique<Apb>(Pid{"loudness_match", 1}, "Loudness Match", true));
        return layout;
    }

    // ── Helpers ─────────────────────────────────────────────────────────────
    static float onePole(double tauSeconds, double stepSeconds)
    {
        return static_cast<float>(std::exp(-stepSeconds / std::max(tauSeconds, 1e-6)));
    }

    static float toDb(float power)  { return 10.0f * std::log10(std::max(power, 1e-12f)); }
    static float dbToGain(float db) { return std::pow(10.0f, db * 0.05f); }

    // BS.1770 K-weighting (pre-filter shelf + RLB high-pass), any sample rate.
    struct KWeighting
    {
        float b[2][3] {}, a[2][2] {};
        float x1[2] {}, x2[2] {}, y1[2] {}, y2[2] {};

        void design(double sr)
        {
            const double pi = juce::MathConstants<double>::pi;
            {
                const double f0 = 1681.974450955533, G = 3.999843853973347, Q = 0.7071752369554196;
                const double K = std::tan(pi * f0 / sr), Vh = std::pow(10.0, G / 20.0);
                const double Vb = std::pow(Vh, 0.4996667741545416), a0 = 1.0 + K / Q + K * K;
                b[0][0] = static_cast<float>((Vh + Vb * K / Q + K * K) / a0);
                b[0][1] = static_cast<float>(2.0 * (K * K - Vh) / a0);
                b[0][2] = static_cast<float>((Vh - Vb * K / Q + K * K) / a0);
                a[0][0] = static_cast<float>(2.0 * (K * K - 1.0) / a0);
                a[0][1] = static_cast<float>((1.0 - K / Q + K * K) / a0);
            }
            {
                const double f0 = 38.13547087602444, Q = 0.5003270373238773;
                const double K = std::tan(pi * f0 / sr), a0 = 1.0 + K / Q + K * K;
                b[1][0] = 1.0f; b[1][1] = -2.0f; b[1][2] = 1.0f;
                a[1][0] = static_cast<float>(2.0 * (K * K - 1.0) / a0);
                a[1][1] = static_cast<float>((1.0 - K / Q + K * K) / a0);
            }
            reset();
        }
        void reset()
        {
            for (int s = 0; s < 2; ++s) x1[s] = x2[s] = y1[s] = y2[s] = 0.0f;
        }
        float process(float x)
        {
            for (int s = 0; s < 2; ++s)
            {
                const float y = b[s][0] * x + b[s][1] * x1[s] + b[s][2] * x2[s] - a[s][0] * y1[s] - a[s][1] * y2[s];
                x2[s] = x1[s]; x1[s] = x;
                y2[s] = y1[s]; y1[s] = y;
                x = y;
            }
            return x;
        }
    };

    static float fastTanh(float x)
    {
        return juce::dsp::FastMathApproximations::tanh(juce::jlimit(-4.9f, 4.9f, x));
    }

    void splitBands(int ch, float in, float* out)
    {
        float lowHalf, highHalf;
        crossoverMid_.processSample(ch, in, lowHalf, highHalf);
        crossoverHigh_.processSample(ch, allpassLow_.processSample(ch, highHalf), out[2], out[3]);
        crossoverLow_.processSample(ch, allpassHigh_.processSample(ch, lowHalf), out[0], out[1]);
    }

    // The saturator's added signal for one band/channel sample, DC-blocked:
    // L * s(x / L) - x, where s is a unity-slope, slightly biased tanh and L the
    // band's own peak-following level (fast up, slow down), so the drive is the
    // same at any input level and an onset is not over-driven.
    float saturate(int b, int ch, float x)
    {
        const float level = satLevel_[b];
        const float d     = satDrive_[b];
        const float u     = x * satInvLevel_[b];
        const float y     = (fastTanh(d * (u + kWarmBias)) - satTb_[b]) * satNorm_[b];
        const float diff  = level * y - x;

        float& px = dcX_[b][ch];
        float& py = dcY_[b][ch];
        const float hp = diff - px + dcR_ * py;
        px = diff;
        py = hp;
        return hp;
    }

    // dev (dB over the reference) -> correction (dB): a tolerance zone, then
    // Amount-scaled cut / lift, each soft-limited; lifts scaled by `liftAllow`.
    static float shapeCorrection(float dev, float k, float liftMaxDb, float liftAllow, float liftScale = 1.0f)
    {
        const float excess = dev - kToleranceDb * std::tanh(dev / kToleranceDb);
        if (excess > 0.0f)
            return -kCutMaxDb * std::tanh(k * kCutStrength * excess / kCutMaxDb);
        if (excess < 0.0f)
            return liftAllow * liftMaxDb * std::tanh(-k * kLiftStrength * liftScale * excess / liftMaxDb);
        return 0.0f;
    }

    // 0 at the band's Floor, 1 from 12 dB over it (smoothstep).
    float overFloorWeight(float levelDb, int b) const
    {
        const float x = juce::jlimit(0.0f, 1.0f, (levelDb - p_.floorDb[b]) / 12.0f);
        return x * x * (3.0f - 2.0f * x);
    }

    void rebuildResponseCoefficients(float responseMs)
    {
        const double sr   = sampleRate_;
        const double tick = static_cast<double>(kTick) / sr;
        const double resp = static_cast<double>(responseMs) * 0.001;
        for (int b = 0; b < kBands; ++b)
        {
            const double scaled = resp * kTimeScale[b];
            aDet_[b] = onePole(std::max(scaled,       kMinDetMs[b]     * 0.001), 1.0 / sr);
            aAtk_[b] = onePole(std::max(0.3 * scaled, kMinAttackMs[b]  * 0.001), tick);
            aRel_[b] = onePole(std::max(1.2 * scaled, kMinReleaseMs[b] * 0.001), tick);
        }
        aPres_ = onePole(juce::jlimit(1.0, 6.0, 20.0 * resp), tick);
        lastResponse_ = responseMs;
    }

    // Everything that runs at the control rate: levels, transient state,
    // presence, the program anchor, each band's gain and the make-up.
    void controlTick(int mode, bool match)
    {
        if (std::abs(p_.response - lastResponse_) > 0.01f)
            rebuildResponseCoefficients(p_.response);

        const float preserve     = juce::jlimit(0.0f, 1.0f, p_.preserve * 0.01f);
        const float holdMaxTicks = preserve * kMaxHoldMs * holdTicksPerMs_;
        detCap_ = std::pow(10.0f, (kHitDb + 34.0f * (1.0f - preserve)) * 0.1f);

        // 1. Levels, dips / gaps and the transient / onset state machine.
        for (int b = 0; b < kBands; ++b)
        {
            if (holdTicks_[b] > 0) --holdTicks_[b];

            float levelDb = toDb(ms_[b]);
            const float fastDb  = toDb(fastMs_[b]);
            const float overDb  = fastDb - levelDb;
            const bool  audible = fastDb > p_.floorDb[b];

            // Dips and gaps. A gap is near-silence for this band: under its
            // Floor, or kGapDb under its program level. A dip is a sudden drop
            // inside the material: the fast level kDipDb under the band's
            // short-term level. Either one first HOLDS the detector and the
            // dynamic gain for kDipHoldMs, so the room between hits and
            // syllables is never pumped. After that a dip is simply a quieter
            // passage (evened like any other), while a gap lets the dynamic
            // gain go back to 0, so silence and hiss are never lifted.
            const bool gapNow = !audible || (presInit_[b] && fastDb < presDb_[b] - kGapDb);
            const bool dipNow = !gapNow && fastDb < levelDb - kDipDb;
            gapTicks_[b] = gapNow ? std::min(gapTicks_[b] + 1, 1 << 20) : 0;
            dipTicks_[b] = dipNow ? std::min(dipTicks_[b] + 1, 1 << 20) : 0;

            if (armed_[b] && audible && overDb > kHitDb)
            {
                armed_[b] = false;
                const bool fromGap = overDb > kOnsetDb || levelDb < p_.floorDb[b];
                if (fromGap)
                    onsetLeft_[b] = onsetTicks_;
                if (holdMaxTicks >= 1.0f)
                {
                    holdTicks_[b]      = static_cast<int>(holdMaxTicks);
                    freezeDetector_[b] = !fromGap;
                }
            }
            if (onsetLeft_[b] > 0)
            {
                --onsetLeft_[b];
                ms_[b]  = std::max(ms_[b], 0.7f * fastMs_[b]);
                levelDb = toDb(ms_[b]);
            }
            if (!armed_[b] && holdTicks_[b] <= 0 && onsetLeft_[b] <= 0 && overDb < kRearmDb)
                armed_[b] = true;

            inDip_[b] = (gapTicks_[b] > 0 && gapTicks_[b] <= dipHoldTicks_)
                     || (dipTicks_[b] > 0 && dipTicks_[b] <= dipHoldTicks_);
            inGap_[b] = gapTicks_[b] > dipHoldTicks_;
            detFrozen_[b] = (holdTicks_[b] > 0 && freezeDetector_[b]) || (inDip_[b] && onsetLeft_[b] <= 0);

            levelDb_[b] = levelDb;

            // Program level: the band's average level over the last ~20 x
            // Response (dB average, symmetric), taken only while the band is
            // playing (not in a gap), so it holds through silence. Symmetric on
            // purpose: a level biased toward the band's bursts (plosives,
            // sibilants, hats) makes everything between them look too quiet,
            // and lifting that is exactly the breath / hiss lift of an OTT
            // chain. For its first 100 ms it is a fast average, so a fresh
            // note is measured at once without an onset click standing in.
            if (levelDb > p_.floorDb[b] && !gapNow)
            {
                if (!presInit_[b])
                {
                    presDb_[b] = levelDb;
                    presInit_[b] = true;
                    presSettle_[b] = settleTicks_;
                }
                else if (presSettle_[b] > 0)
                {
                    --presSettle_[b];
                    presDb_[b] += (1.0f - aSettle_) * (levelDb - presDb_[b]);
                }
                else
                {
                    presDb_[b] += (1.0f - aPres_) * (levelDb - presDb_[b]);
                }
            }
        }

        // 2. Presence: a band far under the most prominent one (on the
        //    balanced layout) is not really there, so it is never lifted.
        float maxRel = -1.0e9f;
        for (int b = 0; b < kBands; ++b)
            if (presInit_[b]) maxRel = std::max(maxRel, presDb_[b] - kShareDb[b]);
        for (int b = 0; b < kBands; ++b)
            presence_[b] = presInit_[b]
                ? juce::jlimit(0.0f, 1.0f, (presDb_[b] - kShareDb[b] - (maxRel - 30.0f)) / 12.0f)
                : 0.0f;

        // 3. The balanced reference: the presence-weighted fit of the program
        //    levels to the balanced layout (it follows the program levels).
        float sumW = 0.0f, sumWM = 0.0f;
        for (int b = 0; b < kBands; ++b)
        {
            if (!presInit_[b]) continue;
            sumW  += presence_[b];
            sumWM += presence_[b] * (presDb_[b] - kShareDb[b]);
        }
        anchorInit_ = sumW > 0.05f;
        if (anchorInit_)
            anchorDb_ = sumWM / sumW;

        // 4. Each band's gain = tonal + dynamic.
        //    Tonal (Relative only): the band's program level against the
        //    balanced reference. Slow, symmetric, and it persists through gaps,
        //    so a short sample gets its tone from the first note on.
        //    Dynamic: the band's short-term level against its own program level
        //    (Relative) or the literal target (Absolute): quiet passages come
        //    up, bursts go down. It holds through dips and Preserve holds, and
        //    returns to 0 in gaps, so the room between phrases is never lifted.
        const float amount = juce::jlimit(0.0f, 1.0f, p_.amount * 0.01f);
        const float tilt   = juce::jlimit(0.0f, 1.0f, p_.warmth * 0.01f);
        for (int b = 0; b < kBands; ++b)
        {
            const float k = amount * juce::jlimit(0.0f, 1.0f, p_.bandAmt[b] * 0.01f);

            float tonalWanted = 0.0f;
            if (mode == 0 && anchorInit_ && presInit_[b])
            {
                const float dev = presDb_[b] - (anchorDb_ + kShareDb[b] + p_.target[b]);
                tonalWanted = shapeCorrection(dev, k, kLiftMaxDb[b], presence_[b] * overFloorWeight(presDb_[b], b),
                                              kTonalLiftScale[b]);
            }
            tonalDb_[b] += (1.0f - aTonal_) * (tonalWanted - tonalDb_[b]);

            float dynWanted = 0.0f;
            const float levelDb = levelDb_[b];
            if (presInit_[b] && levelDb > p_.floorDb[b])
            {
                const float refDb = mode == 0 ? presDb_[b] : p_.target[b];
                const float dev   = levelDb - refDb;
                const float gapFade = juce::jlimit(0.0f, 1.0f,
                    (dev - kGapFadeEndDb) / (kGapFadeStartDb - kGapFadeEndDb));
                dynWanted = shapeCorrection(dev, k, kDynLiftMaxDb[b],
                                            presence_[b] * overFloorWeight(levelDb, b) * gapFade);
            }

            if (holdTicks_[b] > 0 || inDip_[b])
                ; // hold
            else if (inGap_[b])
                dynDb_[b] += (1.0f - aRel_[b]) * (0.0f - dynDb_[b]);
            else
            {
                const float a = dynWanted < dynDb_[b] ? aAtk_[b] : aRel_[b];
                dynDb_[b] += (1.0f - a) * (dynWanted - dynDb_[b]);
            }

            // The sum is soft-limited to the band's lift / cut range.
            const float sum  = tonalDb_[b] + dynDb_[b];
            const float lim  = sum >= 0.0f ? std::max(kLiftMaxDb[b], kDynLiftMaxDb[b]) + 2.0f : kCutMaxDb + 2.0f;
            gainDb_[b] = lim * std::tanh(sum / lim);

            const float targetLin = dbToGain(gainDb_[b] + tilt * kWarmTiltDb[b]);
            gainStep_[b] = (targetLin - gainLin_[b]) / static_cast<float>(kTick);
        }

        // 5. Warmth saturation coefficients (held for this control period).
        // The drive is relative to the band's own level, floored 18 dB under
        // the full-band level: a band holding only another band's crossover
        // skirt (a 2 kHz tone's residue in Low-mid) is barely driven.
        satActive_ = tilt > 0.0005f;
        if (satActive_)
        {
            const float floorMs = fullMs_ * kWarmLevelFloor;
            for (int b = 0; b < 2; ++b)
            {
                const float d  = tilt * kWarmDrive[b];
                const float tb = fastTanh(d * kWarmBias);   // same tanh as the audio path: s(0) == 0 exactly
                satDrive_[b] = d;
                satTb_[b]    = tb;
                satNorm_[b]  = 1.0f / (d * (1.0f - tb * tb));
                satLevel_[b] = std::sqrt(std::max(std::max(satMs_[b], floorMs), 1.0e-10f));
                satInvLevel_[b] = 1.0f / satLevel_[b];
            }
        }

        // 6. Loudness match.
        //    Predicted: what the TONAL gains (and the warmth tilt) do to the
        //    K-weighted loudness, from each band's program power. Instant, so
        //    a short sample is matched from its first note, and blind to the
        //    dynamic evening, which it must not undo.
        float predTarget = 0.0f;
        if (match)
        {
            double num = 0.0, den = 0.0;
            for (int b = 0; b < kBands; ++b)
            {
                if (!presInit_[b]) continue;
                const double pw = kLoudnessWeight[b] * std::pow(10.0, 0.1 * presDb_[b]);
                const double g  = 1.0 + p_.mix * (dbToGain(tonalDb_[b] + tilt * kWarmTiltDb[b]) - 1.0);
                num += pw * g * g;
                den += pw;
            }
            if (den > 1.0e-14 && num > 1.0e-14)
                predTarget = juce::jlimit(-kMakeupMaxDb, kMakeupMaxDb, static_cast<float>(-10.0 * std::log10(num / den)));
        }
        predDb_ += (1.0f - aPred_) * (predTarget - predDb_);
        predStep_ = (dbToGain(predDb_) - predLin_) / static_cast<float>(kTick);

        //    Measured residual: K-weighted input against the output with the
        //    prediction applied, over ~3 s (a running mean from the start),
        //    for whatever the prediction misses (band weighting, saturation,
        //    the net effect of the evening).
        const float blockIn  = static_cast<float>(accIn_  / kTick);
        const float blockOut = static_cast<float>(accOut_ / kTick);
        accIn_ = accOut_ = 0.0;
        if (blockIn > 1.0e-8f)
        {
            if (loudCount_ < (1 << 24)) ++loudCount_;
            const float a = std::max(1.0f / static_cast<float>(loudCount_), 1.0f - aLoudness_);
            loudIn_  += a * (blockIn  - loudIn_);
            loudOut_ += a * (blockOut - loudOut_);
        }
        float residTarget = 0.0f;
        if (match && loudCount_ > 0 && loudIn_ > 1.0e-12f && loudOut_ > 1.0e-12f)
            residTarget = juce::jlimit(-kResidualMaxDb, kResidualMaxDb, 10.0f * std::log10(loudIn_ / loudOut_));
        // Quick while the measurement is young, then kMakeupTauS.
        const float young = std::min(1.0f, static_cast<float>(loudCount_) / static_cast<float>(std::max(1, makeupSettleTicks_)));
        const float aMk   = aMakeupFast_ + (aMakeup_ - aMakeupFast_) * young;
        makeupDb_ += (1.0f - aMk) * (residTarget - makeupDb_);

        const float postTarget = dbToGain(makeupDb_ + p_.outputDb);
        postStep_ = (postTarget - postLin_) / static_cast<float>(kTick);
    }

    void clearState()
    {
        for (int b = 0; b < kBands; ++b)
        {
            ms_[b] = fastMs_[b] = 0.0f;
            levelDb_[b]  = -120.0f;
            presDb_[b]   = -120.0f;
            presInit_[b] = false;
            presence_[b] = 0.0f;
            gainDb_[b]   = 0.0f;
            tonalDb_[b]  = 0.0f;
            dynDb_[b]    = 0.0f;
            presSettle_[b] = 0;
            gainLin_[b]  = 1.0f;
            gainStep_[b] = 0.0f;
            holdTicks_[b] = 0;
            onsetLeft_[b] = 0;
            freezeDetector_[b] = false;
            armed_[b] = true;
            gapTicks_[b] = dipTicks_[b] = 0;
            inDip_[b] = inGap_[b] = detFrozen_[b] = false;
        }
        for (int b = 0; b < 2; ++b)
        {
            satMs_[b] = 0.0f;
            satLevel_[b] = 1.0e-5f;
            satInvLevel_[b] = 1.0e5f;
            satDrive_[b] = 0.0f;
            satTb_[b] = 0.0f;
            satNorm_[b] = 1.0f;
            for (int c = 0; c < 2; ++c) dcX_[b][c] = dcY_[b][c] = 0.0f;
        }
        satActive_   = false;
        fullMs_      = 0.0f;
        detCap_      = 1.0e4f;
        anchorDb_    = -120.0f;
        anchorInit_  = false;
        accIn_ = accOut_ = 0.0;
        for (auto* k : { &kIn_[0], &kIn_[1], &kOut_[0], &kOut_[1] })
            k->reset();
        loudIn_ = loudOut_ = 0.0f;
        loudCount_ = 0;
        makeupDb_  = 0.0f;
        postLin_   = 1.0f;
        postStep_  = 0.0f;
        predDb_    = 0.0f;
        predLin_   = 1.0f;
        predStep_  = 0.0f;
        tickPos_   = 0;
    }

    // ── DSP state ───────────────────────────────────────────────────────────
    double sampleRate_ = 44100.0;

    // Crossover (balanced binary tree: 3 LR4 + 2 allpass compensators).
    juce::dsp::LinkwitzRileyFilter<float> crossoverMid_;    // 800 Hz
    juce::dsp::LinkwitzRileyFilter<float> crossoverLow_;    // 150 Hz
    juce::dsp::LinkwitzRileyFilter<float> crossoverHigh_;   // 4000 Hz
    juce::dsp::LinkwitzRileyFilter<float> allpassLow_;      // 150 Hz, allpass
    juce::dsp::LinkwitzRileyFilter<float> allpassHigh_;     // 4000 Hz, allpass

    struct TickParams
    {
        float amount = 60.0f, preserve = 50.0f, response = 150.0f, warmth = 0.0f, outputDb = 0.0f, mix = 1.0f;
        float target[kBands]  = {};
        float bandAmt[kBands] = { 100.0f, 100.0f, 100.0f, 100.0f };
        float floorDb[kBands] = { -60.0f, -60.0f, -60.0f, -60.0f };
    } p_;

    // Per-band detector and gain state.
    float ms_[kBands] = {}, fastMs_[kBands] = {};
    float levelDb_[kBands] = {}, presDb_[kBands] = {}, presence_[kBands] = {};
    bool  presInit_[kBands] = {};
    float gainDb_[kBands] = {}, gainLin_[kBands] = { 1.0f, 1.0f, 1.0f, 1.0f }, gainStep_[kBands] = {};
    float tonalDb_[kBands] = {}, dynDb_[kBands] = {};
    int   presSettle_[kBands] = {};
    int   holdTicks_[kBands] = {}, onsetLeft_[kBands] = {};
    bool  freezeDetector_[kBands] = {}, armed_[kBands] = { true, true, true, true };
    int   gapTicks_[kBands] = {}, dipTicks_[kBands] = {};
    bool  inDip_[kBands] = {}, inGap_[kBands] = {}, detFrozen_[kBands] = {};
    float detCap_ = 1.0e4f;           // level-detector input cap (x its own power), from Preserve

    // Warmth saturation (Sub, Low-mid).
    bool  satActive_ = false;
    float fullMs_ = 0.0f;              // full-band peak-following power
    float satMs_[2] = {}, satLevel_[2] = { 1.0e-5f, 1.0e-5f }, satInvLevel_[2] = { 1.0e5f, 1.0e5f };
    float satDrive_[2] = {}, satTb_[2] = {}, satNorm_[2] = { 1.0f, 1.0f };
    float dcX_[2][2] = {}, dcY_[2][2] = {};

    // Balanced reference (the fit of the program levels to the layout).
    float anchorDb_ = -120.0f;
    bool  anchorInit_ = false;

    // Loudness match and output.
    KWeighting kIn_[2], kOut_[2];
    double accIn_ = 0.0, accOut_ = 0.0;
    float  loudIn_ = 0.0f, loudOut_ = 0.0f;
    int    loudCount_ = 0;
    float  makeupDb_ = 0.0f, postLin_ = 1.0f, postStep_ = 0.0f;
    float  predDb_ = 0.0f, predLin_ = 1.0f, predStep_ = 0.0f;
    int    tickPos_ = 0;

    // Coefficients.
    float aDet_[kBands] = {}, aFast_[kBands] = {}, aAtk_[kBands] = {}, aRel_[kBands] = {};
    float aSatRise_ = 0.0f, aSatFall_ = 0.0f, dcR_ = 0.0f;
    float aPres_ = 0.0f, aTonal_ = 0.0f, aSettle_ = 0.0f;
    float aLoudness_ = 0.0f, aMakeup_ = 0.0f, aMakeupFast_ = 0.0f, aPred_ = 0.0f;
    int   makeupSettleTicks_ = 1500;
    float holdTicksPerMs_ = 1.5f, lastResponse_ = -1.0f;
    int   onsetTicks_ = 75, settleTicks_ = 150, dipHoldTicks_ = 180;

    std::atomic<float>* modeParam_  = nullptr;
    std::atomic<float>* matchParam_ = nullptr;

    SmoothedHandle hAmount_, hPreserve_, hResponse_, hMix_, hWarmth_, hOutput_;
    SmoothedHandle hTarget_[kBands], hBandAmt_[kBands], hFloor_[kBands];

public:
    // Read by the bridge at ~30 fps (relaxed loads only); written once per block.
    std::atomic<float> debugLevel_[kBands]     = {};   // band short-term level, dB
    std::atomic<float> debugRef_[kBands]       = {};   // Relative: balanced reference per band, dB (-100 = none yet)
    std::atomic<float> debugPresence_[kBands]  = {};   // 0..1: how much this band may be lifted
    std::atomic<float> debugTransient_[kBands] = {};   // 1 while Preserve holds the band
    std::atomic<float> debugProgram_{-100.0f};         // the program anchor, dB
    std::atomic<float> debugMakeup_{0.0f};             // loudness-match make-up, dB
};
