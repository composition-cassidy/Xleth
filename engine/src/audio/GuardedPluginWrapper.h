#pragma once

#include <juce_audio_processors/juce_audio_processors.h>

#include <atomic>
#include <memory>
#include <string>

class NamedAudioRing;

// ─── GuardedPluginWrapper ───────────────────────────────────────────────────
// Transparent juce::AudioProcessor wrapper that intercepts processBlock (and
// reset/release/prepare during recovery) behind a Structured Exception Handler.
// Used ONLY for VST3 (third-party) nodes in AudioGraph.  Stock XlethEffectBase
// processors are NOT wrapped — we want their crashes to surface immediately.
//
// On first SEH exception inside processBlock:
//   • crashed_ is set (atomic, single-writer = audio thread)
//   • subsequent processBlock calls return immediately (passthrough: the APG
//     render sequence leaves the input audio in the buffer, so a no-op equals
//     dry signal)
//   • getChainState() exposes "crashed": true so the UI can display a badge
//
// Recovery:
//   Call resetCrashed() from the main thread.  It attempts releaseResources +
//   prepareToPlay + reset inside a guard.  If that succeeds, clears crashed_.
//   If the reset itself faults, the node stays bypassed permanently.
//
// Latency:
//   prepareToPlay / setStateInformation both re-sync latencySamples from the
//   inner plugin so PDC recomputes correctly after state changes.

class GuardedPluginWrapper : public juce::AudioProcessor
{
public:
    explicit GuardedPluginWrapper(std::unique_ptr<juce::AudioProcessor> inner);
    ~GuardedPluginWrapper() override;

    // ── juce::AudioProcessor overrides ──────────────────────────────────
    const juce::String getName() const override
    {
        // Prefer the live value when the plugin is healthy — some VST3s initialise
        // their name lazily and the constructor-cached value may be empty.
        if (inner_ && !crashed_.load(std::memory_order_acquire))
        {
            const auto n = inner_->getName();
            if (n.isNotEmpty()) return n;
        }
        return cachedName_.isNotEmpty() ? cachedName_ : juce::String("GuardedWrapper");
    }

    void prepareToPlay(double sampleRate, int samplesPerBlock) override;
    void releaseResources() override;
    void reset() override;

    void processBlock(juce::AudioBuffer<float>& buffer, juce::MidiBuffer& midi) override;

    bool   acceptsMidi()          const override { return inner_ && inner_->acceptsMidi(); }
    bool   producesMidi()         const override { return inner_ && inner_->producesMidi(); }
    bool   isMidiEffect()         const override { return inner_ && inner_->isMidiEffect(); }
    double getTailLengthSeconds() const override { return inner_ ? inner_->getTailLengthSeconds() : 0.0; }

    bool hasEditor() const override              { return inner_ && inner_->hasEditor(); }
    juce::AudioProcessorEditor* createEditor() override;

    int  getNumPrograms() override                             { return inner_ ? inner_->getNumPrograms() : 1; }
    int  getCurrentProgram() override                          { return inner_ ? inner_->getCurrentProgram() : 0; }
    void setCurrentProgram(int index) override                 { if (inner_) inner_->setCurrentProgram(index); }
    const juce::String getProgramName(int index) override      { return inner_ ? inner_->getProgramName(index) : juce::String(); }
    void changeProgramName(int index, const juce::String& newName) override
    {
        if (inner_) inner_->changeProgramName(index, newName);
    }

    void getStateInformation(juce::MemoryBlock& destData) override;
    void setStateInformation(const void* data, int sizeInBytes) override;

    juce::AudioProcessorParameter* getBypassParameter() const override
    {
        return inner_ ? inner_->getBypassParameter() : nullptr;
    }

    // ── Wrapper-specific API (main thread) ──────────────────────────────
    juce::AudioProcessor*       getInner()       noexcept { return inner_.get(); }
    const juce::AudioProcessor* getInner() const noexcept { return inner_.get(); }

    bool isCrashed() const noexcept { return crashed_.load(std::memory_order_acquire); }

    // Attempt to recover a crashed plugin.  Returns true if the plugin is
    // now healthy (crashed_ cleared), false if the reset itself faulted
    // (plugin permanently bypassed) or the wrapper has no inner.
    bool resetCrashed();

    // ── Audio streaming to editor-host (message thread only) ───────────────
    // When an out-of-process editor is open, a copy of the post-processBlock
    // audio is pushed into a named shared-memory ring so the editor-process
    // plugin instance's analyzers can stay in sync. See NamedAudioRing.h.
    //
    // PRECONDITION: both methods must be called on the message thread (the
    // thread that owns MixEngine::vstEditorCoordinators_). They must not race
    // with each other; rapid toggling is safe only if serialised by the caller.
    // enableAudioStream must not be called again before disableAudioStream.
    void enableAudioStream (const std::string& shmName,
                            int                streamSampleRate,
                            int                streamBlockSize);
    void disableAudioStream();

private:
    std::unique_ptr<juce::AudioProcessor> inner_;

    // Cached so we can log safely after a crash (avoid re-entering the plugin).
    juce::String cachedName_;

    std::atomic<bool> crashed_{false};

    // ── Audio stream to editor-host (see enable/disableAudioStream) ────────
    // hasOpenEditor_: audio-thread-safe gate. Set to true AFTER the ring is
    // constructed (release); cleared to false BEFORE the ring is destroyed,
    // followed by a sleep that drains any in-flight audio callback.
    // audioStreamRing_: mutated only from the message thread. The audio thread
    // reads .get() as a raw pointer, safe under the release/acquire discipline
    // described in NamedAudioRing.h and enableAudioStream/disableAudioStream.
    std::atomic<bool>                 hasOpenEditor_{false};
    std::unique_ptr<NamedAudioRing>   audioStreamRing_;
    int                               streamSampleRate_ = 44100;
    int                               streamBlockSize_  = 512;
};
