#pragma once

#include <juce_audio_processors/juce_audio_processors.h>

#include <atomic>

// ─── WireGainProcessor ──────────────────────────────────────────────────────
// Lightweight AudioProcessor inserted on a graph connection when gain != 1.0
// or muted == true.  Applies a smoothed gain ramp (20 ms linear) so wire
// gain / mute changes are click-free.
//
// Threading:
//   Main thread  — writes targetGain_ (atomic store), calls setMuted()
//   Audio thread — processBlock reads the atomic, drives SmoothedValue
//
// NOT an XlethEffectBase (no bypass, no pluginId).  Reports zero latency.

class WireGainProcessor : public juce::AudioProcessor
{
public:
    WireGainProcessor()
        : AudioProcessor(BusesProperties()
              .withInput ("Input",  juce::AudioChannelSet::stereo(), true)
              .withOutput("Output", juce::AudioChannelSet::stereo(), true))
    {
        gain_.setCurrentAndTargetValue(1.0f);
    }

    ~WireGainProcessor() override = default;

    // ── Main-thread control ─────────────────────────────────────────────

    void setTargetGain(float g)
    {
        targetGain_.store(std::clamp(g, 0.0f, 2.0f), std::memory_order_relaxed);
    }

    void setMuted(bool m)
    {
        muted_.store(m, std::memory_order_relaxed);
    }

    float getTargetGain() const { return targetGain_.load(std::memory_order_relaxed); }
    bool  isMuted()       const { return muted_.load(std::memory_order_relaxed); }

    // True when gain == 1.0 and not muted (can be removed from APG).
    bool isUnity() const
    {
        return !muted_.load(std::memory_order_relaxed)
            && targetGain_.load(std::memory_order_relaxed) == 1.0f;
    }

    // ── AudioProcessor overrides ────────────────────────────────────────

    void prepareToPlay(double sampleRate, int maximumExpectedSamplesPerBlock) override
    {
        juce::ignoreUnused(maximumExpectedSamplesPerBlock);
        gain_.reset(sampleRate, 0.020);  // 20 ms ramp
        gain_.setCurrentAndTargetValue(targetGain_.load(std::memory_order_relaxed));
    }

    void releaseResources() override {}

    void processBlock(juce::AudioBuffer<float>& buffer, juce::MidiBuffer& /*midi*/) override
    {
        juce::ScopedNoDenormals noDenormals;

        const float target = muted_.load(std::memory_order_relaxed)
                           ? 0.0f
                           : targetGain_.load(std::memory_order_relaxed);
        gain_.setTargetValue(target);

        if (gain_.isSmoothing())
        {
            const int numSamples = buffer.getNumSamples();
            const int numCh      = buffer.getNumChannels();
            for (int s = 0; s < numSamples; ++s)
            {
                const float g = gain_.getNextValue();
                for (int ch = 0; ch < numCh; ++ch)
                    buffer.setSample(ch, s, buffer.getSample(ch, s) * g);
            }
        }
        else
        {
            const float g = gain_.getCurrentValue();
            if (g == 0.0f)
                buffer.clear();
            else if (g != 1.0f)
                buffer.applyGain(g);
            // g == 1.0f → pass through unchanged
        }
    }

    // ── Boilerplate ─────────────────────────────────────────────────────

    const juce::String getName() const override { return "WireGain"; }
    double getTailLengthSeconds() const override { return 0.0; }
    bool   acceptsMidi()  const override { return false; }
    bool   producesMidi() const override { return false; }

    juce::AudioProcessorEditor* createEditor() override { return nullptr; }
    bool hasEditor() const override { return false; }

    int  getNumPrograms()    override { return 1; }
    int  getCurrentProgram() override { return 0; }
    void setCurrentProgram(int) override {}
    const juce::String getProgramName(int) override { return {}; }
    void changeProgramName(int, const juce::String&) override {}

    void getStateInformation(juce::MemoryBlock&) override {}
    void setStateInformation(const void*, int) override {}

private:
    std::atomic<float> targetGain_{1.0f};
    std::atomic<bool>  muted_{false};
    juce::SmoothedValue<float, juce::ValueSmoothingTypes::Linear> gain_{1.0f};
};
