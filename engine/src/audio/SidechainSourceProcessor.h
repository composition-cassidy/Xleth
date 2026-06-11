#pragma once

#include "audio/SidechainDiagnostics.h"

#include <juce_audio_processors/juce_audio_processors.h>

#include <algorithm>

// ─── SidechainSourceProcessor ───────────────────────────────────────────────
// Internal infrastructure node injected into a target track's effect graph when
// that track has incoming sidechain routes (Prompt 4C+4D). It is a *source*: it
// has 0 audio inputs and 2 audio outputs. Each block it copies a key signal from
// an externally-supplied buffer (owned by MixEngine, valid only for the duration
// of one chain processBlock) into its outputs, which the AudioGraph wires to a
// sidechain-capable effect node's second input bus.
//
// The key signal is therefore delivered to the chain WITHOUT ever touching the
// target's audible main input bus — structural silence is preserved.
//
// Threading / realtime safety:
//   • setExternalBuffer() / clearExternalBuffer() are called by MixEngine on the
//     audio thread, under the already-held chains lock, immediately around the
//     target chain's processBlock — same thread, same block, no extra locking.
//   • processBlock() never allocates and never reads past the supplied length:
//     a shorter external buffer zero-fills the remainder, so a block-size change
//     can never reuse a stale/oversized pointer.
//   • The processor never owns or frees the external buffer; it only borrows the
//     raw pointers for the single block they were set for.
//
// NOT an XlethEffectBase (no bypass, no pluginId, no editor). Reports zero
// latency and is treated as a PDC root (key-path PDC is out of scope for v1).

class SidechainSourceProcessor : public juce::AudioProcessor
{
public:
    SidechainSourceProcessor()
        : AudioProcessor(BusesProperties()
              .withOutput("Key", juce::AudioChannelSet::stereo(), true))
    {}

    ~SidechainSourceProcessor() override = default;

    // ── Audio-thread control (called by MixEngine around chain processBlock) ──

    // Borrow `numSamples` of stereo key audio for the next processBlock. `left`
    // and `right` may alias (mono key); a null pointer is treated as silence on
    // that channel. The pointers must stay valid until clearExternalBuffer() or
    // the next processBlock() returns — MixEngine guarantees this by setting them
    // immediately before, and clearing immediately after, the chain processBlock.
    void setExternalBuffer(const float* left, const float* right, int numSamples) noexcept
    {
        extL_ = left;
        extR_ = right != nullptr ? right : left;
        extN_ = numSamples > 0 ? numSamples : 0;
        if (xleth::sidechain_diag::audioBlockActive())
        {
            xleth::sidechain_diag::appendf("SidechainSourceProcessor", "setExternalBuffer",
                "numSamples=%d inputPeakL=%.8f inputRmsL=%.8f inputPeakR=%.8f inputRmsR=%.8f",
                extN_,
                xleth::sidechain_diag::peak(extL_, extN_),
                xleth::sidechain_diag::rms(extL_, extN_),
                xleth::sidechain_diag::peak(extR_, extN_),
                xleth::sidechain_diag::rms(extR_, extN_));
        }
    }

    // Drop the borrowed pointers so a later block can never read stale audio.
    void clearExternalBuffer() noexcept
    {
        extL_ = nullptr;
        extR_ = nullptr;
        extN_ = 0;
        if (xleth::sidechain_diag::audioBlockActive())
            xleth::sidechain_diag::append("SidechainSourceProcessor", "clearExternalBuffer",
                                          "staleBufferReusePrevented=1");
    }

    bool hasExternalBuffer() const noexcept { return extL_ != nullptr || extR_ != nullptr; }

    // ── AudioProcessor overrides ────────────────────────────────────────────

    void prepareToPlay(double, int) override {}
    void releaseResources() override {}

    bool isBusesLayoutSupported(const BusesLayout& layouts) const override
    {
        return layouts.getMainOutputChannelSet() == juce::AudioChannelSet::stereo();
    }

    void processBlock(juce::AudioBuffer<float>& buffer, juce::MidiBuffer& /*midi*/) override
    {
        juce::ScopedNoDenormals noDenormals;

        const int numCh      = buffer.getNumChannels();
        const int numSamples = buffer.getNumSamples();
        if (numSamples <= 0) return;

        // Copy only what was actually supplied; zero-fill the rest so a stale or
        // shorter external buffer can never bleed garbage into the key signal.
        const int copyN = std::min(numSamples, extN_);

        for (int ch = 0; ch < numCh; ++ch)
        {
            float* dst = buffer.getWritePointer(ch);
            const float* src = (ch == 0) ? extL_ : extR_;

            if (src != nullptr && copyN > 0)
                std::copy(src, src + copyN, dst);
            else
                std::fill(dst, dst + copyN, 0.0f);

            if (copyN < numSamples)
                std::fill(dst + copyN, dst + numSamples, 0.0f);
        }

        if (xleth::sidechain_diag::audioBlockActive())
        {
            const float* outL = numCh > 0 ? buffer.getReadPointer(0) : nullptr;
            const float* outR = numCh > 1 ? buffer.getReadPointer(1) : outL;
            xleth::sidechain_diag::appendf("SidechainSourceProcessor", "processBlock",
                "numSamples=%d copySamples=%d hasExternalBuffer=%d outputPeakL=%.8f outputRmsL=%.8f outputPeakR=%.8f outputRmsR=%.8f",
                numSamples, copyN, hasExternalBuffer() ? 1 : 0,
                xleth::sidechain_diag::peak(outL, numSamples),
                xleth::sidechain_diag::rms(outL, numSamples),
                xleth::sidechain_diag::peak(outR, numSamples),
                xleth::sidechain_diag::rms(outR, numSamples));
        }
    }

    // ── Boilerplate ─────────────────────────────────────────────────────────

    const juce::String getName() const override { return "SidechainSource"; }
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
    const float* extL_ = nullptr;
    const float* extR_ = nullptr;
    int          extN_ = 0;
};
