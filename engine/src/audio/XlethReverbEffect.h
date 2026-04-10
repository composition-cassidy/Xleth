#pragma once

#include "audio/XlethEffectBase.h"
#include <juce_dsp/juce_dsp.h>

#include <algorithm>
#include <array>
#include <cmath>

// ─── XlethReverbEffect ──────────────────────────────────────────────────────
// 8×8 Feedback Delay Network reverb with early reflections, Hadamard feedback
// matrix, per-line damping, per-line modulation, and DC blockers.
//
// Three processing stages:
//   1. Pre-delay (0–100 ms, non-interpolated)
//   2. Early reflections (12-tap stereo-decorrelated delay line)
//   3. Late reverb (8×8 FDN with FWHT, damping, modulation, DC blocking)
//
// Parameters (APVTS-backed):
//   decay      0.1–30 s       (Linear 30ms)
//   predelay   0–100 ms       (None — read per block)
//   size       0–100 %        (Linear 30ms)
//   damping    0–100 %        (Linear 20ms)
//   mod_rate   0–100 %        (Linear 20ms)
//   mod_depth  0–100 %        (Linear 20ms)
//   er_level   0–100 %        (Linear 20ms)
//   er_late    0–100 %        (Linear 20ms)
//   hicut      1000–20000 Hz  (Multiplicative 30ms)
//   locut      20–500 Hz      (Multiplicative 30ms)
//   mix        0–100 %        (Linear 20ms)
//
// Metering slots:
//   0 — L output peak
//   1 — R output peak
//
// Latency: 0 (pre-delay is creative, not compensated)
//
// pluginId: "reverb"

class XlethReverbEffect : public XlethEffectBase
{
public:
    XlethReverbEffect() : XlethEffectBase("reverb", createLayout())
    {
        registerSmoothedParam("decay",     SmoothType::Linear,          30.0f);
        registerSmoothedParam("size",      SmoothType::Linear,          30.0f);
        registerSmoothedParam("damping",   SmoothType::Linear,          20.0f);
        registerSmoothedParam("mod_rate",  SmoothType::Linear,          20.0f);
        registerSmoothedParam("mod_depth", SmoothType::Linear,          20.0f);
        registerSmoothedParam("er_level",  SmoothType::Linear,          20.0f);
        registerSmoothedParam("er_late",   SmoothType::Linear,          20.0f);
        registerSmoothedParam("hicut",     SmoothType::Multiplicative,  30.0f);
        registerSmoothedParam("locut",     SmoothType::Multiplicative,  30.0f);
        registerSmoothedParam("mix",       SmoothType::Linear,          20.0f);
    }

    // ── prepareEffect ───────────────────────────────────────────────────────
    void prepareEffect(double sampleRate, int maxBlockSize) override
    {
        sampleRate_ = sampleRate;
        const float sr = static_cast<float>(sampleRate);

        predelayPtr_ = apvts_.getRawParameterValue("predelay");

        // ── Stage 1: Pre-delay (max 100 ms, no interpolation) ───────────────
        const int maxPredelay = static_cast<int>(0.1 * sampleRate) + 1;
        predelayLine_.setMaximumDelayInSamples(maxPredelay);
        {
            juce::dsp::ProcessSpec spec;
            spec.sampleRate       = sampleRate;
            spec.maximumBlockSize = static_cast<juce::uint32>(maxBlockSize);
            spec.numChannels      = 1;
            predelayLine_.prepare(spec);
            predelayLine_.reset();
        }
        maxPredelaySamplesF_ = static_cast<float>(maxPredelay - 1);

        // ── Stage 2: Early reflections (max ~80 ms, no interpolation) ───────
        const int maxEr = static_cast<int>(0.08 * sampleRate) + 1;
        erLine_.setMaximumDelayInSamples(maxEr);
        {
            juce::dsp::ProcessSpec spec;
            spec.sampleRate       = sampleRate;
            spec.maximumBlockSize = static_cast<juce::uint32>(maxBlockSize);
            spec.numChannels      = 1;
            erLine_.prepare(spec);
            erLine_.reset();
        }
        maxErSamplesF_ = static_cast<float>(maxEr - 1);

        // ── Stage 3: FDN — 8 Lagrange3rd delay lines ────────────────────────
        // Max delay: largest base (1499) × max size scale (1.25) × SR scale + headroom
        const float srScale = sr / 48000.0f;
        const int maxFdn = static_cast<int>(kBaseDelays[7] * 1.25f * srScale) + 8;
        for (int i = 0; i < 8; ++i)
        {
            fdnLines_[i].setMaximumDelayInSamples(maxFdn);
            juce::dsp::ProcessSpec spec;
            spec.sampleRate       = sampleRate;
            spec.maximumBlockSize = static_cast<juce::uint32>(maxBlockSize);
            spec.numChannels      = 1;
            fdnLines_[i].prepare(spec);
            fdnLines_[i].reset();
        }
        maxFdnSamplesF_ = static_cast<float>(maxFdn - 1);

        // ── DC blocker coefficient (5 Hz HPF) ───────────────────────────────
        dcR_ = 1.0f - 2.0f * juce::MathConstants<float>::pi * 5.0f / sr;

        // ── Zero all state ──────────────────────────────────────────────────
        dampState_.fill(0.0f);
        dcX_.fill(0.0f);
        dcY_.fill(0.0f);
        modPhase_.fill(0.0f);
        hicutStateL_ = 0.0f;  hicutStateR_ = 0.0f;
        locutStateL_ = 0.0f;  locutStateR_ = 0.0f;

#ifdef XLETH_DEBUG
        DBG("[Reverb] prepareToPlay sr=" + juce::String(sampleRate)
            + " blockSize=" + juce::String(maxBlockSize));
        for (int i = 0; i < 8; ++i)
        {
            float d = kBaseDelays[i] * 1.0f * srScale;
            float g = std::pow(10.0f, -3.0f * (d / sr) / 2.0f);
            DBG("[Reverb]   line " + juce::String(i)
                + " base=" + juce::String(kBaseDelays[i])
                + " actual=" + juce::String(d, 1)
                + " gain(2s)=" + juce::String(g, 4));
        }
#endif
    }

    // ── resetEffect ─────────────────────────────────────────────────────────
    void resetEffect() override
    {
        predelayLine_.reset();
        erLine_.reset();
        for (int i = 0; i < 8; ++i)
            fdnLines_[i].reset();

        dampState_.fill(0.0f);
        dcX_.fill(0.0f);
        dcY_.fill(0.0f);
        modPhase_.fill(0.0f);
        hicutStateL_ = 0.0f;  hicutStateR_ = 0.0f;
        locutStateL_ = 0.0f;  locutStateR_ = 0.0f;
    }

    // ── getTailLengthSeconds ────────────────────────────────────────────────
    double getTailLengthSeconds() const override
    {
        return static_cast<double>(getSmoothedValue("decay"));
    }

    // ── processEffect ───────────────────────────────────────────────────────
    void processEffect(juce::AudioBuffer<float>& buffer, juce::MidiBuffer& /*midi*/) override
    {
        const int numSamples = buffer.getNumSamples();
        const int numCh      = buffer.getNumChannels();
        const float sr       = static_cast<float>(sampleRate_);

        // Pre-delay: read once per block (no smoothing)
        const float predelayMs = predelayPtr_
            ? predelayPtr_->load(std::memory_order_relaxed) : 10.0f;
        const float predelaySamples = std::clamp(
            predelayMs * 0.001f * sr, 0.0f, maxPredelaySamplesF_);

        float peakL = 0.0f, peakR = 0.0f;

#ifdef XLETH_DEBUG
        static int blockCount_ = 0;
        ++blockCount_;
        const bool doLog = (blockCount_ % 2000 == 0);
        float fdnEnergy = 0.0f;
#endif

        // ── Per-sample loop ─────────────────────────────────────────────────
        for (int s = 0; s < numSamples; ++s)
        {
            // 1. Advance smoothers
            const float decay    = getNextSmoothedValue("decay");
            const float size     = getNextSmoothedValue("size");
            const float damping  = getNextSmoothedValue("damping");
            const float modRate  = getNextSmoothedValue("mod_rate");
            const float modDepth = getNextSmoothedValue("mod_depth");
            const float erLevel  = getNextSmoothedValue("er_level");
            const float erLate   = getNextSmoothedValue("er_late");
            const float hicut    = getNextSmoothedValue("hicut");
            const float locut    = getNextSmoothedValue("locut");
            const float mixPct   = getNextSmoothedValue("mix");

            // 2. Read dry input, sum to mono
            const float inputL = buffer.getSample(0, s);
            const float inputR = numCh > 1 ? buffer.getSample(1, s) : inputL;
            const float monoIn = (inputL + inputR) * 0.5f;

            // ── STAGE 1: Pre-delay ──────────────────────────────────────────
            predelayLine_.pushSample(0, monoIn);
            const float preOut = predelayLine_.popSample(0, predelaySamples);

            // ── STAGE 2: Early Reflections (12-tap) ─────────────────────────
            const float sizeScale = (size / 100.0f) * 0.5f + 0.75f;

            erLine_.pushSample(0, preOut);

            float erL = 0.0f, erR = 0.0f;
            for (int t = 0; t < 12; ++t)
            {
                const float tapSamples = std::clamp(
                    kErTaps[t].delayMs * 0.001f * sr * sizeScale,
                    0.0f, maxErSamplesF_);
                const float tapVal = erLine_.popSample(0, tapSamples, t == 11);
                erL += tapVal * kErTaps[t].gainL;
                erR += tapVal * kErTaps[t].gainR;
            }

            // ── STAGE 3: Late Reverb — 8×8 FDN ─────────────────────────────
            const float srScale  = sr / 48000.0f;
            const float dampG    = damping / 100.0f;
            const float modAmt   = (modDepth / 100.0f) * 3.0f;
            const float safeDecay = std::max(decay, 0.1f);

            // 3a. Pop all 8 lines with modulated delay
            float fdnOut[8];
            for (int i = 0; i < 8; ++i)
            {
                const float baseDelay = kBaseDelays[i] * sizeScale * srScale;

                // Per-line LFO
                const float lfoVal = std::sin(
                    2.0f * juce::MathConstants<float>::pi * modPhase_[i]);
                modPhase_[i] += kModRates[i] * (modRate / 100.0f) / sr;
                if (modPhase_[i] >= 1.0f) modPhase_[i] -= 1.0f;

                const float modulatedDelay = std::clamp(
                    baseDelay + lfoVal * modAmt, 1.0f, maxFdnSamplesF_);

                fdnOut[i] = fdnLines_[i].popSample(0, modulatedDelay, true);
            }

            // 3b. Hadamard transform (in-place FWHT + normalization)
            float h[8];
            for (int i = 0; i < 8; ++i) h[i] = fdnOut[i];
            hadamard8(h);

            // 3c. Per-line feedback: damping → decay gain → DC blocker → push
            for (int i = 0; i < 8; ++i)
            {
                // Damping one-pole LPF
                dampState_[i] = (1.0f - dampG) * h[i] + dampG * dampState_[i];

                // RT60 decay gain
                const float delaySeconds =
                    (kBaseDelays[i] * sizeScale * srScale) / sr;
                const float g = std::pow(10.0f,
                    -3.0f * delaySeconds / safeDecay);

                const float fbSample = dampState_[i] * g;

                // DC blocker (5 Hz HPF): y = x - x_prev + R * y_prev
                const float dcOut = fbSample - dcX_[i] + dcR_ * dcY_[i];
                dcX_[i] = fbSample;
                dcY_[i] = dcOut;

                // Push: feedback + new input
                fdnLines_[i].pushSample(0, dcOut + preOut * kFdnInputGain);
            }

            // 3d. Stereo output from FDN: L = even lines, R = odd lines
            const float fdnL = fdnOut[0] + fdnOut[2] + fdnOut[4] + fdnOut[6];
            const float fdnR = fdnOut[1] + fdnOut[3] + fdnOut[5] + fdnOut[7];

#ifdef XLETH_DEBUG
            for (int i = 0; i < 8; ++i)
                fdnEnergy += fdnOut[i] * fdnOut[i];
#endif

            // ── Mix ER + late reverb ────────────────────────────────────────
            float wetL = erL * (erLevel / 100.0f) + fdnL * (erLate / 100.0f);
            float wetR = erR * (erLevel / 100.0f) + fdnR * (erLate / 100.0f);

            // ── Output tone shaping ─────────────────────────────────────────
            // Hi-cut (one-pole LPF)
            const float hcCoeff = std::exp(
                -2.0f * juce::MathConstants<float>::pi * hicut / sr);
            hicutStateL_ = hcCoeff * hicutStateL_ + (1.0f - hcCoeff) * wetL;
            hicutStateR_ = hcCoeff * hicutStateR_ + (1.0f - hcCoeff) * wetR;

            // Lo-cut (one-pole HPF applied to hi-cut output)
            const float lcCoeff = std::exp(
                -2.0f * juce::MathConstants<float>::pi * locut / sr);
            locutStateL_ += (1.0f - lcCoeff) * (hicutStateL_ - locutStateL_);
            locutStateR_ += (1.0f - lcCoeff) * (hicutStateR_ - locutStateR_);
            wetL = hicutStateL_ - locutStateL_;
            wetR = hicutStateR_ - locutStateR_;

            // ── Dry/wet mix ─────────────────────────────────────────────────
            const float mixN = mixPct / 100.0f;
            buffer.setSample(0, s, inputL * (1.0f - mixN) + wetL * mixN);
            if (numCh > 1)
                buffer.setSample(1, s, inputR * (1.0f - mixN) + wetR * mixN);

            peakL = std::max(peakL, std::abs(wetL));
            peakR = std::max(peakR, std::abs(wetR));
        }

#ifdef XLETH_DEBUG
        if (doLog)
            DBG("[Reverb] energy=" + juce::String(fdnEnergy, 4)
                + " decay=" + juce::String(getSmoothedValue("decay"), 2) + "s"
                + " size=" + juce::String(getSmoothedValue("size"), 0) + "%");
#endif

        writeMeterValue(0, peakL);
        writeMeterValue(1, numCh > 1 ? peakR : peakL);
    }

private:
    // ── Parameter layout ────────────────────────────────────────────────────
    static juce::AudioProcessorValueTreeState::ParameterLayout createLayout()
    {
        using Apf = juce::AudioParameterFloat;
        using Pid = juce::ParameterID;
        using Nar = juce::NormalisableRange<float>;

        return {
            std::make_unique<Apf>(Pid{"decay",     1}, "Decay",
                Nar{0.1f,    30.0f,    0.0f, 0.3f  }, 2.0f,     "s"),
            std::make_unique<Apf>(Pid{"predelay",  1}, "Pre-delay",
                Nar{0.0f,    100.0f,   0.0f, 1.0f  }, 10.0f,    "ms"),
            std::make_unique<Apf>(Pid{"size",      1}, "Size",
                Nar{0.0f,    100.0f,   0.0f, 1.0f  }, 50.0f,    "%"),
            std::make_unique<Apf>(Pid{"damping",   1}, "Damping",
                Nar{0.0f,    100.0f,   0.0f, 1.0f  }, 50.0f,    "%"),
            std::make_unique<Apf>(Pid{"mod_rate",  1}, "Mod Rate",
                Nar{0.0f,    100.0f,   0.0f, 1.0f  }, 30.0f,    "%"),
            std::make_unique<Apf>(Pid{"mod_depth", 1}, "Mod Depth",
                Nar{0.0f,    100.0f,   0.0f, 1.0f  }, 20.0f,    "%"),
            std::make_unique<Apf>(Pid{"er_level",  1}, "ER Level",
                Nar{0.0f,    100.0f,   0.0f, 1.0f  }, 50.0f,    "%"),
            std::make_unique<Apf>(Pid{"er_late",   1}, "Late Level",
                Nar{0.0f,    100.0f,   0.0f, 1.0f  }, 50.0f,    "%"),
            std::make_unique<Apf>(Pid{"hicut",     1}, "Hi Cut",
                Nar{1000.0f, 20000.0f, 0.0f, 0.23f }, 12000.0f, "Hz"),
            std::make_unique<Apf>(Pid{"locut",     1}, "Lo Cut",
                Nar{20.0f,   500.0f,   0.0f, 0.3f  }, 80.0f,    "Hz"),
            std::make_unique<Apf>(Pid{"mix",       1}, "Mix",
                Nar{0.0f,    100.0f,   0.0f, 1.0f  }, 30.0f,    "%"),
        };
    }

    // ── Hadamard 8×8 via Fast Walsh-Hadamard Transform (in-place) ───────────
    // 3-stage butterfly: 24 add/sub + 8 multiply (normalization).
    static inline void hadamard8(float* v)
    {
        // Stage 1: butterfly pairs (stride 1)
        float a0 = v[0] + v[1], a1 = v[0] - v[1],
              a2 = v[2] + v[3], a3 = v[2] - v[3],
              a4 = v[4] + v[5], a5 = v[4] - v[5],
              a6 = v[6] + v[7], a7 = v[6] - v[7];
        // Stage 2: butterfly pairs (stride 2)
        float b0 = a0 + a2, b1 = a1 + a3, b2 = a0 - a2, b3 = a1 - a3,
              b4 = a4 + a6, b5 = a5 + a7, b6 = a4 - a6, b7 = a5 - a7;
        // Stage 3: butterfly pairs (stride 4)
        v[0] = b0 + b4;  v[1] = b1 + b5;  v[2] = b2 + b6;  v[3] = b3 + b7;
        v[4] = b0 - b4;  v[5] = b1 - b5;  v[6] = b2 - b6;  v[7] = b3 - b7;
        // Normalize for energy preservation: 1/sqrt(8)
        constexpr float scale = 1.0f / 2.8284271247f;
        for (int i = 0; i < 8; ++i) v[i] *= scale;
    }

    // ── Early reflection tap table ──────────────────────────────────────────
    struct ERTap { float delayMs; float gainL; float gainR; };
    static constexpr ERTap kErTaps[12] = {
        {  3.1f, 0.85f, 0.72f }, {  7.3f, 0.72f, 0.85f },
        { 12.5f, 0.65f, 0.58f }, { 17.8f, 0.58f, 0.65f },
        { 23.2f, 0.50f, 0.43f }, { 29.7f, 0.43f, 0.50f },
        { 36.1f, 0.36f, 0.30f }, { 42.8f, 0.30f, 0.36f },
        { 51.3f, 0.24f, 0.20f }, { 58.9f, 0.20f, 0.24f },
        { 67.4f, 0.15f, 0.12f }, { 76.2f, 0.10f, 0.08f },
    };

    // ── FDN constants ───────────────────────────────────────────────────────
    // Base delay lengths — all prime, mutually coprime, ~17–31 ms at 48 kHz
    static constexpr float kBaseDelays[8] = {
        809.0f, 877.0f, 937.0f, 1049.0f,
        1151.0f, 1249.0f, 1373.0f, 1499.0f
    };

    // Per-line LFO rates (Hz) — irrational ratios prevent periodic coloration
    static constexpr float kModRates[8] = {
        0.37f, 0.43f, 0.53f, 0.61f, 0.71f, 0.83f, 0.97f, 1.13f
    };

    static constexpr float kFdnInputGain = 0.1f;

    // ── Raw APVTS pointer (non-smoothed param) ─────────────────────────────
    std::atomic<float>* predelayPtr_ = nullptr;

    // ── Delay lines ─────────────────────────────────────────────────────────
    juce::dsp::DelayLine<float, juce::dsp::DelayLineInterpolationTypes::None>
        predelayLine_;
    juce::dsp::DelayLine<float, juce::dsp::DelayLineInterpolationTypes::None>
        erLine_;
    std::array<juce::dsp::DelayLine<float,
        juce::dsp::DelayLineInterpolationTypes::Lagrange3rd>, 8> fdnLines_;

    // ── Filter state ────────────────────────────────────────────────────────
    std::array<float, 8> dampState_ = {};   // per-line damping LPF
    std::array<float, 8> dcX_       = {};   // DC blocker x[n-1]
    std::array<float, 8> dcY_       = {};   // DC blocker y[n-1]
    float dcR_                      = 0.0f; // DC blocker coefficient

    float hicutStateL_ = 0.0f, hicutStateR_ = 0.0f;  // output hi-cut LPF
    float locutStateL_ = 0.0f, locutStateR_ = 0.0f;  // output lo-cut HPF

    // ── Modulation ──────────────────────────────────────────────────────────
    std::array<float, 8> modPhase_ = {};

    // ── Max delay values (float, for clamping) ──────────────────────────────
    float maxPredelaySamplesF_ = 0.0f;
    float maxErSamplesF_       = 0.0f;
    float maxFdnSamplesF_      = 0.0f;

    // ── State ───────────────────────────────────────────────────────────────
    double sampleRate_ = 44100.0;
};
