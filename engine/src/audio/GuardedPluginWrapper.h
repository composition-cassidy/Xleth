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
//   Non-realtime owner paths call refreshReportedLatency() after prepare,
//   state restore, parameter/program changes, or crash recovery. processBlock()
//   never publishes host-visible latency or marks graph/PDC state dirty.

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
    void setCurrentProgram(int index) override;
    const juce::String getProgramName(int index) override      { return inner_ ? inner_->getProgramName(index) : juce::String(); }
    void changeProgramName(int index, const juce::String& newName) override;

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

    // Poll the wrapped plugin's reported latency from a non-audio thread and
    // publish it via setLatencySamples only when it actually changed. Returns
    // true when a new latency was published and owners should refresh PDC.
    bool refreshReportedLatency();

    // Third-party parameter owner route. The value is normalized [0, 1], and
    // paramId may be an integer index, "#<index>", or a JUCE parameter ID/name.
    bool setWrappedParameterValue(const std::string& paramId, float normalizedValue);
    bool setWrappedBypass(bool bypassed);
    bool setWrappedCurrentProgram(int index);

    int getReportedProcessorLatencySamples() const noexcept
    {
        return juce::AudioProcessor::getLatencySamples();
    }

    std::uint64_t getNonRealtimeLatencyRefreshCount() const noexcept
    {
        return nonRealtimeLatencyRefreshCount_.load(std::memory_order_acquire);
    }

    std::uint64_t getLatencyChangePublishCount() const noexcept
    {
        return latencyChangePublishCount_.load(std::memory_order_acquire);
    }

    std::uint64_t getProcessBlockLatencyPublishCount() const noexcept
    {
        return processBlockLatencyPublishCount_.load(std::memory_order_acquire);
    }

    std::uint64_t getPendingLatencyChangeFlagCount() const noexcept
    {
        return pendingLatencyChangeFlagCount_.load(std::memory_order_acquire);
    }

    std::uint64_t getStaleLatencyDetectedCount() const noexcept
    {
        return staleLatencyDetectedCount_.load(std::memory_order_acquire);
    }

    bool hasPendingLatencyChangeFlag() const noexcept
    {
        return pendingLatencyMayHaveChanged_.load(std::memory_order_acquire);
    }

    void setHostNodeId(int nodeId) noexcept
    {
        hostNodeId_.store(nodeId, std::memory_order_relaxed);
    }

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

    std::atomic<std::uint64_t> nonRealtimeLatencyRefreshCount_{0};
    std::atomic<std::uint64_t> latencyChangePublishCount_{0};
    std::atomic<std::uint64_t> processBlockLatencyPublishCount_{0};
    std::atomic<std::uint64_t> pendingLatencyChangeFlagCount_{0};
    std::atomic<std::uint64_t> staleLatencyDetectedCount_{0};
    std::atomic<bool> pendingLatencyMayHaveChanged_{false};
    std::atomic<bool> ownerBypassed_{false};
    std::atomic<int> preservedActiveLatencySamples_{0};
    std::atomic<int> hostNodeId_{-1};

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

    bool syncBypassStateFromInner();
};
