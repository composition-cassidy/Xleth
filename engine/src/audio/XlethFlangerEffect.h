#pragma once

#include "audio/XlethEffectBase.h"
#include <juce_dsp/juce_dsp.h>

#include <algorithm>
#include <cmath>

// ─── XlethFlangerEffect ───────────────────────────────────────────────────────
// Single-voice modulated delay flanger with bipolar feedback.
//
// Parameters (APVTS-backed):
//   rate      0.05–10 Hz  (Linear 20ms smoothing)
//   depth     0–100 %     (Linear 20ms smoothing)
//   delay     0.1–5 ms    (manual one-pole 50ms — NOT SmoothedValue)
//   feedback  -95–95 %    (Linear 20ms smoothing — bipolar, capped at ±0.95)
//   width     0–100 %     (Linear 20ms smoothing)
//   mix       0–100 %     (Linear 20ms smoothing)
//
// DSP (per sample):
//   1. Pop delayed sample (read FIRST):
//        delayed = delayLine.popSample(ch, currentDelay)
//   2. Soft-limit feedback path:
//        fb = tanh(delayed * feedbackGain)     feedbackGain ∈ [-0.95, +0.95]
//   3. Push input + feedback:
//        delayLine.pushSample(ch, input + fb)
//   4. Dry/wet mix:
//        out = input * (1-mix) + delayed * mix
//
// Key differences from ChorusEffect:
//   - Single voice (no kMaxVoices, no voice-phase array)
//   - Bipolar feedback (negative → phase inversion → hollow/nasal character)
//   - tanh soft limiter in feedback path (prevents runaway oscillation)
//   - Short delay range (0.1–5 ms) — comb filter territory
//   - modDepth is relative to center delay (depth/100 * center * 0.8)
//     so the read head can never cross the write head at 0.1 ms settings
//
// Stereo width: L LFO at lfoPhase_, R LFO at lfoPhase_ + phaseOffsetLR
//   where phaseOffsetLR = (width/100) * π
//
// Metering slots:
//   0 — L channel wet peak
//   1 — R channel wet peak
//
// pluginId: "flanger"

class XlethFlangerEffect : public XlethEffectBase
{
public:
    XlethFlangerEffect() : XlethEffectBase("flanger", createLayout())
    {
        // delay uses manual one-pole — NOT registered here (same reason as ChorusEffect)
        registerSmoothedParam("rate",     SmoothType::Linear, 20.0f);
        registerSmoothedParam("depth",    SmoothType::Linear, 20.0f);
        registerSmoothedParam("feedback", SmoothType::Linear, 20.0f);
        registerSmoothedParam("width",    SmoothType::Linear, 20.0f);
        registerSmoothedParam("mix",      SmoothType::Linear, 20.0f);
    }

    // ── prepareEffect ──────────────────────────────────────────────────────────
    void prepareEffect(double sampleRate, int maxBlockSize) override
    {
        sampleRate_ = sampleRate;

        // Max center delay = 5 ms, max modulation depth = 5 ms * 0.8 = 4 ms
        // Total worst-case read offset = 9 ms.  Use 10 ms + 8 samples headroom
        // for the Lagrange3rd cubic kernel (needs samples ahead of write head).
        const int maxDelaySamples = static_cast<int>(0.010 * sampleRate) + 8;
        maxDelaySamples_ = maxDelaySamples;

        juce::dsp::ProcessSpec spec;
        spec.sampleRate       = sampleRate;
        spec.maximumBlockSize = static_cast<juce::uint32>(maxBlockSize);
        spec.numChannels      = 1; // each line is mono; stereo handled via L/R pair

        // setMaximumDelayInSamples MUST precede prepare() — allocates the buffer
        delayLineL_.setMaximumDelayInSamples(maxDelaySamples);
        delayLineR_.setMaximumDelayInSamples(maxDelaySamples);
        delayLineL_.prepare(spec);
        delayLineR_.prepare(spec);
        delayLineL_.reset();
        delayLineR_.reset();

        // Raw pointer for manually-smoothed delay param
        delayPtr_ = apvts_.getRawParameterValue("delay");

        // One-pole coefficient for delay time smoothing (50 ms time constant)
        smoothDelayCoeff_ = 1.0f - std::exp(
            -1.0f / (0.05f * static_cast<float>(sampleRate)));

        // Seed from current param value to avoid ramp-from-zero on first play
        const float initDelay = delayPtr_
            ? delayPtr_->load(std::memory_order_relaxed) : 1.5f;
        smoothDelay_ = initDelay;

        lfoPhase_ = 0.0f;

#ifdef XLETH_DEBUG
        DBG("[Flanger] prepareEffect sr=" + juce::String(sampleRate)
            + " blockSize=" + juce::String(maxBlockSize)
            + " maxDelay=" + juce::String(maxDelaySamples) + " samples");
#endif
    }

    // ── resetEffect ───────────────────────────────────────────────────────────
    void resetEffect() override
    {
        delayLineL_.reset();
        delayLineR_.reset();

        const float initDelay = delayPtr_
            ? delayPtr_->load(std::memory_order_relaxed) : 1.5f;
        smoothDelay_ = initDelay;

        lfoPhase_ = 0.0f;
    }

    // ── processEffect ─────────────────────────────────────────────────────────
    void processEffect(juce::AudioBuffer<float>& buffer, juce::MidiBuffer& /*midi*/) override
    {
        const int   numSamples = buffer.getNumSamples();
        const int   numCh      = buffer.getNumChannels();
        const float sr         = static_cast<float>(sampleRate_);

        // Safety margin: Lagrange3rd needs delayInSamples+1 ahead of write pointer
        const float maxDelF = static_cast<float>(maxDelaySamples_ - 2);

        // Delay target — read once per block, smoothed per sample below
        const float targetDelay = delayPtr_
            ? delayPtr_->load(std::memory_order_relaxed) : 1.5f;

        float peakL = 0.0f, peakR = 0.0f;

        for (int s = 0; s < numSamples; ++s)
        {
            // ── 1. Advance base-class smoothers ────────────────────────────────
            const float rate     = getNextSmoothedValue("rate");
            const float depth    = getNextSmoothedValue("depth");
            const float feedback = getNextSmoothedValue("feedback");
            const float width    = getNextSmoothedValue("width");
            const float mixPct   = getNextSmoothedValue("mix");

            // ── 2. One-pole delay time smoothing (50 ms) ───────────────────────
            smoothDelay_ += smoothDelayCoeff_ * (targetDelay - smoothDelay_);
            const float center = smoothDelay_ * 0.001f * sr;

            // Modulation depth is relative to center delay (not a fixed ms value).
            // This prevents the read head from crossing the write head when
            // center delay is very short (e.g. 0.1 ms).
            const float modDepth =
                (depth / 100.0f) * smoothDelay_ * 0.8f * 0.001f * sr;

            // ── 3. Derived per-sample constants ────────────────────────────────
            // L/R phase offset: 0 = mono, 100% = π = maximum stereo
            const float phaseOffsetLR =
                (width / 100.0f) * juce::MathConstants<float>::pi;

            // Bipolar feedback gain, capped at ±0.95 regardless of param range
            const float fbGain =
                std::clamp(feedback / 100.0f, -0.95f, 0.95f);

            // ── 4. Read dry input ──────────────────────────────────────────────
            const float inputL = buffer.getSample(0, s);
            const float inputR = numCh > 1 ? buffer.getSample(1, s) : inputL;

            // ── 5. Compute LFO delay times (clamped to valid range) ────────────
            const float dL = std::clamp(
                center + std::sin(lfoPhase_) * modDepth,
                1.0f, maxDelF);
            const float dR = std::clamp(
                center + std::sin(lfoPhase_ + phaseOffsetLR) * modDepth,
                1.0f, maxDelF);

            // ── 6. Pop delayed sample (READ FIRST — before push) ──────────────
            // advanceReadPointer=true: L and R are separate instances so each
            // advances its own readPos independently, once per sample. Correct.
            const float delayedL = delayLineL_.popSample(0, dL, true);
            const float delayedR = delayLineR_.popSample(0, dR, true);

            // ── 7. tanh soft limiter in feedback path ─────────────────────────
            // Prevents runaway self-oscillation even at fbGain near ±0.95.
            // tanh(0.95 * 1.0) ≈ 0.740 — safely below unity gain.
            // Negative fbGain: inverts comb peaks → odd harmonics only (hollow).
            const float fbL = std::tanh(delayedL * fbGain);
            const float fbR = std::tanh(delayedR * fbGain);

            // ── 8. Push: input + feedback ──────────────────────────────────────
            delayLineL_.pushSample(0, inputL + fbL);
            delayLineR_.pushSample(0, inputR + fbR);

            // ── 9. Advance LFO phase (subtraction wrap, cheaper than fmod) ─────
            lfoPhase_ += rate * juce::MathConstants<float>::twoPi / sr;
            if (lfoPhase_ >= juce::MathConstants<float>::twoPi)
                lfoPhase_ -= juce::MathConstants<float>::twoPi;

            // ── 10. Dry/wet mix (use delayedL/R — the pre-tanh delay output) ───
            const float mixNorm = mixPct / 100.0f;
            buffer.setSample(0, s, inputL * (1.0f - mixNorm) + delayedL * mixNorm);
            if (numCh > 1)
                buffer.setSample(1, s, inputR * (1.0f - mixNorm) + delayedR * mixNorm);

            peakL = std::max(peakL, std::abs(delayedL));
            peakR = std::max(peakR, std::abs(delayedR));
        }

        writeMeterValue(0, peakL);
        writeMeterValue(1, numCh > 1 ? peakR : peakL);
    }

private:
    // ── Parameter layout ──────────────────────────────────────────────────────
    static juce::AudioProcessorValueTreeState::ParameterLayout createLayout()
    {
        using Apf = juce::AudioParameterFloat;
        using Pid = juce::ParameterID;
        using Nar = juce::NormalisableRange<float>;

        return {
            std::make_unique<Apf>(Pid{"rate",     1}, "Rate",
                Nar{0.05f,  10.0f,  0.0f, 0.5f},  0.5f,  "Hz"),
            std::make_unique<Apf>(Pid{"depth",    1}, "Depth",
                Nar{0.0f,   100.0f, 0.0f, 1.0f},  70.0f, "%"),
            std::make_unique<Apf>(Pid{"delay",    1}, "Delay",
                Nar{0.1f,   5.0f,   0.0f, 0.5f},  1.5f,  "ms"),
            std::make_unique<Apf>(Pid{"feedback", 1}, "Feedback",
                Nar{-95.0f, 95.0f,  0.0f, 1.0f},  50.0f, "%"),
            std::make_unique<Apf>(Pid{"width",    1}, "Width",
                Nar{0.0f,   100.0f, 0.0f, 1.0f},  50.0f, "%"),
            std::make_unique<Apf>(Pid{"mix",      1}, "Mix",
                Nar{0.0f,   100.0f, 0.0f, 1.0f},  50.0f, "%"),
        };
    }

    // ── Delay lines (Lagrange3rd for smooth fractional-sample modulation) ─────
    // CRITICAL: Lagrange3rd is minimum quality for flanging. At 0.1–5 ms delays
    // the read position moves through fractional samples constantly; linear
    // interpolation creates audible noise.
    juce::dsp::DelayLine<float, juce::dsp::DelayLineInterpolationTypes::Lagrange3rd>
        delayLineL_, delayLineR_;
    int maxDelaySamples_ = 0;

    // ── Raw APVTS pointer — manually one-pole smoothed (delay only) ───────────
    std::atomic<float>* delayPtr_ = nullptr;

    // ── Manual one-pole delay time smoothing ──────────────────────────────────
    float smoothDelay_      = 1.5f;
    float smoothDelayCoeff_ = 0.0f;

    // ── Single LFO phase scalar ────────────────────────────────────────────────
    // R channel reads at lfoPhase_ + phaseOffsetLR (computed fresh each sample).
    // No second phase variable needed.
    float lfoPhase_ = 0.0f;

    double sampleRate_ = 44100.0;
};
