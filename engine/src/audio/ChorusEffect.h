#pragma once

#include "audio/XlethEffectBase.h"
#include <juce_dsp/juce_dsp.h>

#include <algorithm>
#include <array>
#include <cmath>

// ─── ChorusEffect ─────────────────────────────────────────────────────────────
// Multi-voice modulated delay chorus.  Uses the same circular delay buffer
// + per-voice fractional read architecture as UniFlange, with chorus-range
// defaults and a feedback path.
//
// Parameters (APVTS-backed):
//   rate      0.05–5 Hz   (Linear 20ms smoothing)
//   depth     0–100 %     (Linear 20ms smoothing)
//   delay     7–30 ms     (manual one-pole 50ms — NOT SmoothedValue)
//   feedback  0–25 %      (Linear 20ms smoothing — capped at 25%)
//   voices    1–10        (discrete, step=1, no smoothing)
//   width     0–100 %     (Linear 20ms smoothing)
//   mix       0–100 %     (Linear 20ms smoothing)
//
// DSP:
//   - Shared juce::dsp::DelayLine per channel with Lagrange3rd interpolation.
//   - numVoices reads per sample at different LFO phases; averaged to wet.
//   - Voice phases are initialised evenly across [0, 2π) and all advance
//     at the same rate (no spread param — fixed distribution).
//   - Stereo width: L reads at lfoPhase, R reads at lfoPhase + phaseOffsetLR
//     where phaseOffsetLR = (width/100) * π.
//   - Feedback is summed wet injected back into the write (capped ≤ 25%).
//   - maxModDepth = (depth/100) * 5 ms.
//
// Metering slots:
//   0 — L channel wet peak
//   1 — R channel wet peak
//
// pluginId: "chorus"

class ChorusEffect : public XlethEffectBase
{
public:
    static constexpr int kMaxVoices = 10;

    ChorusEffect() : XlethEffectBase("chorus", createLayout())
    {
        // delay uses a manual one-pole — NOT registered here.
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

        // Max center delay (30 ms) + max mod depth (5 ms) + headroom for Lagrange
        const int maxDelaySamples = static_cast<int>(0.035 * sampleRate) + 8;
        maxDelaySamples_ = maxDelaySamples;

        juce::dsp::ProcessSpec spec;
        spec.sampleRate       = sampleRate;
        spec.maximumBlockSize = static_cast<juce::uint32>(maxBlockSize);
        spec.numChannels      = 1;

        delayLineL_.setMaximumDelayInSamples(maxDelaySamples);
        delayLineR_.setMaximumDelayInSamples(maxDelaySamples);
        delayLineL_.prepare(spec);
        delayLineR_.prepare(spec);
        delayLineL_.reset();
        delayLineR_.reset();

        // Resolve raw pointers for discrete and manually-smoothed params
        delayPtr_  = apvts_.getRawParameterValue("delay");
        voicesPtr_ = apvts_.getRawParameterValue("voices");

        // One-pole coefficient for delay time smoothing (50 ms time constant)
        smoothDelayCoeff_ = 1.0f - std::exp(
            -1.0f / (0.05f * static_cast<float>(sampleRate)));

        const float initDelay = delayPtr_
            ? delayPtr_->load(std::memory_order_relaxed) : 15.0f;
        smoothDelay_ = initDelay;

        // Evenly distribute voice LFO phases across [0, 2π)
        for (int v = 0; v < kMaxVoices; ++v)
            voicePhases_[v] = float(v) * juce::MathConstants<float>::twoPi
                              / float(kMaxVoices);

#ifdef XLETH_DEBUG
        DBG("[Chorus] prepareToPlay sr=" + juce::String(sampleRate)
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
            ? delayPtr_->load(std::memory_order_relaxed) : 15.0f;
        smoothDelay_ = initDelay;

        for (int v = 0; v < kMaxVoices; ++v)
            voicePhases_[v] = float(v) * juce::MathConstants<float>::twoPi
                              / float(kMaxVoices);
    }

    // ── processEffect ─────────────────────────────────────────────────────────
    void processEffect(juce::AudioBuffer<float>& buffer, juce::MidiBuffer& /*midi*/) override
    {
        const int   numSamples = buffer.getNumSamples();
        const int   numCh      = buffer.getNumChannels();
        const float sr         = static_cast<float>(sampleRate_);
        const float maxDelF    = static_cast<float>(maxDelaySamples_ - 2);

        // Discrete voices param — read once per block
        const int numVoices = std::clamp(
            static_cast<int>(voicesPtr_
                ? voicesPtr_->load(std::memory_order_relaxed) : 2.0f),
            1, kMaxVoices);

        // Delay target — read once per block, smoothed per sample below
        const float targetDelay = delayPtr_
            ? delayPtr_->load(std::memory_order_relaxed) : 15.0f;

        float peakL = 0.0f, peakR = 0.0f;

#ifdef XLETH_DEBUG
        static int blockCount_ = 0;
        ++blockCount_;
        const bool doLog = (blockCount_ % 1000 == 0);
#endif

        for (int s = 0; s < numSamples; ++s)
        {
            // ── Advance base-class smoothers ───────────────────────────────────
            const float rate     = getNextSmoothedValue("rate");
            const float depth    = getNextSmoothedValue("depth");
            const float feedback = getNextSmoothedValue("feedback");
            const float width    = getNextSmoothedValue("width");
            const float mixPct   = getNextSmoothedValue("mix");

            // ── 1. One-pole delay time smoothing (50 ms) ───────────────────────
            smoothDelay_ += smoothDelayCoeff_ * (targetDelay - smoothDelay_);
            const float centerDelaySamples = smoothDelay_ * 0.001f * sr;
            const float maxModDepthSamples = (depth / 100.0f) * 0.005f * sr;

            // ── 2. Derived per-sample constants ────────────────────────────────
            // L/R LFO phase offset: 0 = mono, 100% = 180° = maximum stereo
            const float phaseOffsetLR =
                (width / 100.0f) * juce::MathConstants<float>::pi;
            // Cap feedback gain at 25% — chorus territory, not flanger
            const float fbGain = std::min(feedback / 100.0f, 0.25f);

            // ── 3. Read dry input ──────────────────────────────────────────────
            const float inputL = buffer.getSample(0, s);
            const float inputR = numCh > 1 ? buffer.getSample(1, s) : inputL;

            // ── 4. Sum all voices (read before push) ───────────────────────────
            float wetL = 0.0f, wetR = 0.0f;

            for (int v = 0; v < numVoices; ++v)
            {
                const float lfoL = std::sin(voicePhases_[v]);
                const float lfoR = std::sin(voicePhases_[v] + phaseOffsetLR);

                const float dL = std::clamp(
                    centerDelaySamples + lfoL * maxModDepthSamples,
                    1.0f, maxDelF);
                const float dR = std::clamp(
                    centerDelaySamples + lfoR * maxModDepthSamples,
                    1.0f, maxDelF);

                // Advance readPos only on the final voice.  DelayLine has
                // separate readPos / writePos counters.  pushSample moves
                // writePos; popSample with false leaves readPos frozen.
                // All voices read relative to the same frozen readPos anchor
                // (correct — each specifies its own delayInSamples offset).
                // The last voice's true bumps readPos by 1 after its read,
                // keeping readPos in lock-step with writePos for the next sample.
                // Using false on every voice leaves readPos at 0 forever while
                // writePos marches to totalSize-N → reads drift into stale/zero
                // buffer regions → silent wet output.
                const bool advancePtr = (v == numVoices - 1);
                wetL += delayLineL_.popSample(0, dL, advancePtr);
                wetR += delayLineR_.popSample(0, dR, advancePtr);
            }

            const float normFactor = 1.0f / static_cast<float>(numVoices);
            wetL *= normFactor;
            wetR *= normFactor;

            // ── 5. Advance LFO phases ──────────────────────────────────────────
            const float phaseInc =
                rate * juce::MathConstants<float>::twoPi / sr;

            for (int v = 0; v < numVoices; ++v)
            {
                voicePhases_[v] += phaseInc;
                if (voicePhases_[v] >= juce::MathConstants<float>::twoPi)
                    voicePhases_[v] -= juce::MathConstants<float>::twoPi;
            }

            // ── 6. Write to delay buffer (input + feedback) ────────────────────
            delayLineL_.pushSample(0, inputL + fbGain * wetL);
            delayLineR_.pushSample(0, inputR + fbGain * wetR);

            // ── 7. Dry/wet mix ─────────────────────────────────────────────────
            const float mixNorm = mixPct / 100.0f;
            buffer.setSample(0, s, inputL * (1.0f - mixNorm) + wetL * mixNorm);
            if (numCh > 1)
                buffer.setSample(1, s, inputR * (1.0f - mixNorm) + wetR * mixNorm);

            peakL = std::max(peakL, std::abs(wetL));
            peakR = std::max(peakR, std::abs(wetR));
        }

#ifdef XLETH_DEBUG
        if (doLog)
            DBG("[Chorus] delay=" + juce::String(smoothDelay_, 1) + "ms"
                + " voices=" + juce::String(numVoices)
                + " rate=" + juce::String(getSmoothedValue("rate"), 2) + "Hz");
#endif

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
                Nar{0.05f, 5.0f,   0.0f, 0.5f}, 0.8f,  "Hz"),
            std::make_unique<Apf>(Pid{"depth",    1}, "Depth",
                Nar{0.0f,  100.0f, 0.0f, 1.0f}, 50.0f, "%"),
            std::make_unique<Apf>(Pid{"delay",    1}, "Delay",
                Nar{7.0f,  30.0f,  0.0f, 1.0f}, 15.0f, "ms"),
            std::make_unique<Apf>(Pid{"feedback", 1}, "Feedback",
                Nar{0.0f,  25.0f,  0.0f, 1.0f}, 0.0f,  "%"),
            std::make_unique<Apf>(Pid{"voices",   1}, "Voices",
                Nar{1.0f,  10.0f,  1.0f, 1.0f}, 2.0f,  ""),
            std::make_unique<Apf>(Pid{"width",    1}, "Width",
                Nar{0.0f,  100.0f, 0.0f, 1.0f}, 80.0f, "%"),
            std::make_unique<Apf>(Pid{"mix",      1}, "Mix",
                Nar{0.0f,  100.0f, 0.0f, 1.0f}, 50.0f, "%"),
        };
    }

    // ── Delay lines (Lagrange3rd for fractional-sample modulation) ────────────
    juce::dsp::DelayLine<float, juce::dsp::DelayLineInterpolationTypes::Lagrange3rd>
        delayLineL_, delayLineR_;
    int maxDelaySamples_ = 0;

    // ── Raw APVTS pointers (discrete + manually-smoothed params) ─────────────
    std::atomic<float>* delayPtr_  = nullptr;
    std::atomic<float>* voicesPtr_ = nullptr;

    // ── Manual one-pole delay time smoothing ──────────────────────────────────
    float smoothDelay_      = 15.0f;
    float smoothDelayCoeff_ = 0.0f;

    // ── Voice LFO phases (radians, 0–2π) ─────────────────────────────────────
    float voicePhases_[kMaxVoices] = {};

    double sampleRate_ = 44100.0;
};
