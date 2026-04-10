#pragma once

#include <juce_audio_processors/juce_audio_processors.h>

#include <atomic>
#include <vector>

// ─── DelayCompensationProcessor ─────────────────────────────────────────────
// Circular-buffer delay line used for Plugin Delay Compensation (PDC).
// Inserted on shorter-path connections so that all inputs to a node arrive
// time-aligned.
//
// Reports zero latency itself — it IS the compensation.
//
// Threading:
//   Main thread  — writes delaySamples_ (atomic) during computePDC()
//   Audio thread — processBlock reads the atomic, manages the delay ring

class DelayCompensationProcessor : public juce::AudioProcessor
{
public:
    DelayCompensationProcessor()
        : AudioProcessor(BusesProperties()
              .withInput ("Input",  juce::AudioChannelSet::stereo(), true)
              .withOutput("Output", juce::AudioChannelSet::stereo(), true))
    {}

    ~DelayCompensationProcessor() override = default;

    // ── Main-thread control ─────────────────────────────────────────────

    void setDelaySamples(int samples)
    {
        delaySamples_.store(std::max(0, samples), std::memory_order_relaxed);
    }

    int getDelaySamples() const
    {
        return delaySamples_.load(std::memory_order_relaxed);
    }

    // ── AudioProcessor overrides ────────────────────────────────────────

    void prepareToPlay(double /*sampleRate*/, int maximumExpectedSamplesPerBlock) override
    {
        // Allocate ring buffer large enough for max plausible PDC delay.
        // 2 seconds at 192 kHz = 384000 samples — generous upper bound.
        const int maxDelay = 384000;
        const int ringSize = maxDelay + maximumExpectedSamplesPerBlock + 1;

        ring_.resize(2);  // stereo
        for (auto& ch : ring_)
        {
            ch.assign(static_cast<size_t>(ringSize), 0.0f);
        }
        ringSize_ = ringSize;
        writePos_ = 0;
    }

    void releaseResources() override
    {
        ring_.clear();
        ringSize_ = 0;
        writePos_ = 0;
    }

    void processBlock(juce::AudioBuffer<float>& buffer, juce::MidiBuffer& /*midi*/) override
    {
        juce::ScopedNoDenormals noDenormals;

        const int delay      = delaySamples_.load(std::memory_order_relaxed);
        const int numSamples = buffer.getNumSamples();
        const int numCh      = std::min(buffer.getNumChannels(), static_cast<int>(ring_.size()));

        if (delay <= 0 || ringSize_ == 0)
            return;  // pass through unchanged

        for (int ch = 0; ch < numCh; ++ch)
        {
            auto* data   = buffer.getWritePointer(ch);
            auto& ringCh = ring_[static_cast<size_t>(ch)];

            int wp = writePos_;
            for (int s = 0; s < numSamples; ++s)
            {
                // Write current sample into ring
                ringCh[static_cast<size_t>(wp)] = data[s];

                // Read delayed sample
                int rp = wp - delay;
                if (rp < 0) rp += ringSize_;
                data[s] = ringCh[static_cast<size_t>(rp)];

                wp++;
                if (wp >= ringSize_) wp = 0;
            }
        }

        writePos_ = (writePos_ + numSamples) % ringSize_;
    }

    // ── Boilerplate ─────────────────────────────────────────────────────

    const juce::String getName() const override { return "DelayComp"; }
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
    std::atomic<int> delaySamples_{0};
    std::vector<std::vector<float>> ring_;
    int ringSize_ = 0;
    int writePos_ = 0;
};
