#pragma once

#include "audio/XlethEffectBase.h"

#include <algorithm>
#include <cmath>

// ─── XlethPhaserEffect ────────────────────────────────────────────────────────
// Cascaded SECOND-ORDER (biquad) allpass filter phaser with LFO-swept
// breakpoint frequency, adjustable resonance (Q), and per-stage frequency
// staggering for a lush, dramatic sweep.
//
// Why second-order instead of first-order:
//   First-order allpass gives a gentle 0°→180° transition over ~1 decade.
//   Second-order allpass gives a sharper 0°→360° transition, with the
//   steepness controlled by Q. Higher Q = narrower, deeper notches =
//   dramatically more audible phaser sweep. Each second-order stage
//   produces one full notch (vs needing 2 first-order stages per notch).
//
// Parameters (APVTS-backed):
//   rate      0.05–5 Hz     LFO speed
//   depth     0–100 %       sweep width (symmetric around center)
//   stages    1–6           number of second-order allpass stages (= number of notches)
//   feedback  -95–95 %      bipolar feedback, capped ±0.95
//   resonance 0.3–5.0       allpass Q — controls notch sharpness
//   width     0–100 %       stereo LFO phase offset
//   mix       0–100 %       additive mix (dry + mix*wet)
//   freq_low  20–2000 Hz    sweep range low bound
//   freq_high 200–16000 Hz  sweep range high bound
//   spread    0–100 %       per-stage frequency staggering
//
// DSP (per sample):
//   1. Compute LFO → per-stage fc (with stagger offset) → biquad coefficients
//   2. Add feedback: input += fbGain * lastAllpassOutput
//   3. Cascade N biquad allpass stages in series
//   4. Output = dry + mix * allpassOutput  (additive, NOT crossfade)
//
// Biquad allpass (Audio EQ Cookbook):
//   w0 = 2π * fc / sr
//   alpha = sin(w0) / (2 * Q)
//   b0 = 1 - alpha,  b1 = -2*cos(w0),  b2 = 1 + alpha
//   a0 = 1 + alpha,  a1 = -2*cos(w0),  a2 = 1 - alpha
//   (normalize by dividing all by a0)
//
// Metering: slot 0 = L allpass peak, slot 1 = R allpass peak
// pluginId: "phaser"

class XlethPhaserEffect : public XlethEffectBase
{
public:
    XlethPhaserEffect() : XlethEffectBase("phaser", createLayout())
    {
        registerSmoothedParam("rate",      SmoothType::Linear,         20.0f);
        registerSmoothedParam("depth",     SmoothType::Linear,         20.0f);
        registerSmoothedParam("feedback",  SmoothType::Linear,         20.0f);
        registerSmoothedParam("resonance", SmoothType::Multiplicative, 30.0f);
        registerSmoothedParam("width",     SmoothType::Linear,         20.0f);
        registerSmoothedParam("mix",       SmoothType::Linear,         20.0f);
        registerSmoothedParam("freq_low",  SmoothType::Multiplicative, 30.0f);
        registerSmoothedParam("freq_high", SmoothType::Multiplicative, 30.0f);
        registerSmoothedParam("spread",    SmoothType::Linear,         20.0f);
    }

    void prepareEffect(double sampleRate, int /*maxBlockSize*/) override
    {
        sampleRate_ = sampleRate;
        stagesPtr_  = apvts_.getRawParameterValue("stages");
        resetEffect();

#ifdef XLETH_DEBUG
        DBG("[Phaser] prepareToPlay: sampleRate=" + juce::String(sampleRate)
            + " maxStages=" + juce::String(kMaxStages));
#endif
    }

    void resetEffect() override
    {
        for (auto& stage : stages_)
            stage.reset();

        lastOutput_[0] = 0.0f;
        lastOutput_[1] = 0.0f;
        lfoPhase_      = 0.0f;
        debugThrottle_ = 0;
    }

    void processEffect(juce::AudioBuffer<float>& buffer, juce::MidiBuffer& /*midi*/) override
    {
        const int   numSamples = buffer.getNumSamples();
        const int   numCh      = buffer.getNumChannels();
        const float sr         = static_cast<float>(sampleRate_);
        const float pi         = juce::MathConstants<float>::pi;
        const float twoPi      = juce::MathConstants<float>::twoPi;

        // Read stages (integer, no smoothing)
        const float stagesRaw = stagesPtr_
            ? stagesPtr_->load(std::memory_order_relaxed) : 4.0f;
        const int numStages = std::clamp(static_cast<int>(std::round(stagesRaw)), 1, kMaxStages);

        float peakL = 0.0f, peakR = 0.0f;

        for (int s = 0; s < numSamples; ++s)
        {
            // ── 1. Advance smoothers ─────────────────────────────────────────
            const float rate      = getNextSmoothedValue("rate");
            const float depth     = getNextSmoothedValue("depth");
            const float feedback  = getNextSmoothedValue("feedback");
            const float resonance = getNextSmoothedValue("resonance");
            const float width     = getNextSmoothedValue("width");
            const float mixPct    = getNextSmoothedValue("mix");
            const float freqLow   = getNextSmoothedValue("freq_low");
            const float freqHigh  = getNextSmoothedValue("freq_high");
            const float spread    = getNextSmoothedValue("spread");

            // ── 2. Stereo phase offset ───────────────────────────────────────
            const float phaseOffsetLR = (width / 100.0f) * pi;

            // ── 3. Center-based symmetric log sweep ──────────────────────────
            const float safeHigh     = std::max(freqHigh, freqLow + 1.0f);
            const float centerFreq   = std::sqrt(freqLow * safeHigh);
            const float halfRangeLog = std::log(safeHigh / centerFreq);

            const float lfoL   = std::sin(lfoPhase_);
            const float sweepL = lfoL * (depth / 100.0f);

            const float lfoR   = std::sin(lfoPhase_ + phaseOffsetLR);
            const float sweepR = lfoR * (depth / 100.0f);

            // ── 4. Feedback ──────────────────────────────────────────────────
            const float fbGain = std::clamp(feedback / 100.0f, -0.95f, 0.95f);

            const float dryL = buffer.getSample(0, s);
            const float dryR = numCh > 1 ? buffer.getSample(1, s) : dryL;

            float xL = dryL + fbGain * lastOutput_[0];
            float xR = dryR + fbGain * lastOutput_[1];

            // ── 5. Cascade biquad allpass stages with per-stage stagger ──────
            // Spread offsets each stage's frequency in log-space:
            //   stage 0 gets offset -spread/2, last stage gets +spread/2
            //   This distributes notches across a wider range for richness.
            //   At spread=0%: all stages identical (classic phaser).
            //   At spread=100%: each stage offset by up to ±0.5 octaves.
            const float spreadNorm   = spread / 100.0f;
            const float maxOffsetLog = spreadNorm * 0.5f;  // ±0.5 octaves at 100%

            for (int i = 0; i < numStages; ++i)
            {
                // Per-stage frequency offset (evenly distributed)
                float stageT = (numStages > 1)
                    ? static_cast<float>(i) / static_cast<float>(numStages - 1)
                    : 0.5f;
                float offsetLog = (stageT - 0.5f) * 2.0f * maxOffsetLog;

                float fcL = centerFreq * std::exp((sweepL + offsetLog) * halfRangeLog);
                float fcR = centerFreq * std::exp((sweepR + offsetLog) * halfRangeLog);

                // Clamp to valid range
                fcL = std::clamp(fcL, 20.0f, sr * 0.499f);
                fcR = std::clamp(fcR, 20.0f, sr * 0.499f);

                // Biquad allpass coefficients (Audio EQ Cookbook)
                float coeffsL[5], coeffsR[5];
                computeBiquadAllpass(fcL, resonance, sr, coeffsL);
                computeBiquadAllpass(fcR, resonance, sr, coeffsR);

                xL = stages_[i].process(0, xL, coeffsL);
                xR = stages_[i].process(1, xR, coeffsR);
            }

            lastOutput_[0] = xL;
            lastOutput_[1] = xR;

            // ── 6. Advance LFO ───────────────────────────────────────────────
            lfoPhase_ += rate * twoPi / sr;
            if (lfoPhase_ >= twoPi)
                lfoPhase_ -= twoPi;

            // ── 7. Additive mix ──────────────────────────────────────────────
            const float mixNorm = mixPct / 100.0f;
            buffer.setSample(0, s, dryL + mixNorm * xL);
            if (numCh > 1)
                buffer.setSample(1, s, dryR + mixNorm * xR);

            peakL = std::max(peakL, std::abs(xL));
            peakR = std::max(peakR, std::abs(xR));

#ifdef XLETH_DEBUG
            if (++debugThrottle_ >= kDebugInterval)
            {
                debugThrottle_ = 0;
                float fcDbg = centerFreq * std::exp(sweepL * halfRangeLog);
                DBG("[Phaser] fc=" + juce::String(fcDbg, 1)
                    + " Q=" + juce::String(resonance, 2)
                    + " stages=" + juce::String(numStages)
                    + " spread=" + juce::String(spread, 0)
                    + " freqLow=" + juce::String(freqLow, 0)
                    + " freqHigh=" + juce::String(freqHigh, 0));
            }
#endif
        }

        writeMeterValue(0, peakL);
        writeMeterValue(1, numCh > 1 ? peakR : peakL);
    }

private:
    // ── Second-order biquad allpass stage ──────────────────────────────────────
    // Direct Form II Transposed — same topology the EQ uses for biquads.
    // Per-channel state: z1, z2 (two delay elements per channel).
    struct BiquadAllpassStage
    {
        float z1[2] = {0, 0};  // [0]=L, [1]=R
        float z2[2] = {0, 0};

        void reset()
        {
            z1[0] = z1[1] = 0.0f;
            z2[0] = z2[1] = 0.0f;
        }

        // coeffs: [b0/a0, b1/a0, b2/a0, a1/a0, a2/a0] (pre-normalized)
        float process(int ch, float input, const float* c)
        {
            float output = c[0] * input + z1[ch];
            z1[ch] = c[1] * input - c[3] * output + z2[ch];
            z2[ch] = c[2] * input - c[4] * output;
            return output;
        }
    };

    // ── Compute normalized biquad allpass coefficients ─────────────────────────
    // Audio EQ Cookbook (Robert Bristow-Johnson):
    //   b0 = 1 - alpha,  b1 = -2*cos(w0),  b2 = 1 + alpha
    //   a0 = 1 + alpha,  a1 = -2*cos(w0),  a2 = 1 - alpha
    //   alpha = sin(w0) / (2*Q)
    // All divided by a0 for Direct Form II Transposed.
    static void computeBiquadAllpass(float fc, float Q, float sr, float* out)
    {
        Q = std::max(Q, 0.1f);  // prevent division by zero

        const float w0    = juce::MathConstants<float>::twoPi * fc / sr;
        const float cosw0 = std::cos(w0);
        const float sinw0 = std::sin(w0);
        const float alpha = sinw0 / (2.0f * Q);

        const float a0 = 1.0f + alpha;
        const float invA0 = 1.0f / a0;

        out[0] = (1.0f - alpha) * invA0;   // b0/a0
        out[1] = (-2.0f * cosw0) * invA0;  // b1/a0
        out[2] = (1.0f + alpha) * invA0;   // b2/a0
        out[3] = (-2.0f * cosw0) * invA0;  // a1/a0 (same as b1/a0 for allpass)
        out[4] = (1.0f - alpha) * invA0;   // a2/a0 (same as b0/a0 for allpass)
    }

    // ── Parameter layout ──────────────────────────────────────────────────────
    static juce::AudioProcessorValueTreeState::ParameterLayout createLayout()
    {
        using Apf = juce::AudioParameterFloat;
        using Pid = juce::ParameterID;
        using Nar = juce::NormalisableRange<float>;

        return {
            std::make_unique<Apf>(Pid{"rate",      1}, "Rate",
                Nar{0.05f,  5.0f,    0.0f, 0.5f},   0.5f,    "Hz"),
            std::make_unique<Apf>(Pid{"depth",     1}, "Depth",
                Nar{0.0f,   100.0f,  0.0f, 1.0f},   80.0f,   "%"),
            std::make_unique<Apf>(Pid{"stages",    1}, "Stages",
                Nar{1.0f,   6.0f,    1.0f, 1.0f},   4.0f,    ""),
            std::make_unique<Apf>(Pid{"feedback",  1}, "Feedback",
                Nar{-95.0f, 95.0f,   0.0f, 1.0f},   40.0f,   "%"),
            std::make_unique<Apf>(Pid{"resonance", 1}, "Resonance",
                Nar{0.3f,   5.0f,    0.0f, 0.5f},   1.0f,    ""),
            std::make_unique<Apf>(Pid{"width",     1}, "Width",
                Nar{0.0f,   100.0f,  0.0f, 1.0f},   50.0f,   "%"),
            std::make_unique<Apf>(Pid{"mix",       1}, "Mix",
                Nar{0.0f,   100.0f,  0.0f, 1.0f},   100.0f,  "%"),
            std::make_unique<Apf>(Pid{"freq_low",  1}, "Freq Low",
                Nar{20.0f,  2000.0f, 0.0f, 0.3f},   100.0f,  "Hz"),
            std::make_unique<Apf>(Pid{"freq_high", 1}, "Freq High",
                Nar{200.0f, 16000.0f,0.0f, 0.23f},  4000.0f, "Hz"),
            std::make_unique<Apf>(Pid{"spread",    1}, "Spread",
                Nar{0.0f,   100.0f,  0.0f, 1.0f},   30.0f,   "%"),
        };
    }

    // ── Constants ─────────────────────────────────────────────────────────────
    static constexpr int kMaxStages    = 6;
    static constexpr int kDebugInterval = 4410;

    // ── State ─────────────────────────────────────────────────────────────────
    BiquadAllpassStage stages_[kMaxStages];
    float              lfoPhase_ = 0.0f;
    float              lastOutput_[2] = {0.0f, 0.0f};
    std::atomic<float>* stagesPtr_ = nullptr;
    double             sampleRate_ = 44100.0;
    int                debugThrottle_ = 0;
};
