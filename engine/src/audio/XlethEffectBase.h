#pragma once

#include <juce_audio_processors/juce_audio_processors.h>
#include <nlohmann/json.hpp>

#include <algorithm>
#include <atomic>
#include <chrono>
#include <cmath>
#include <cstddef>
#include <cstdint>
#include <string>
#include <unordered_map>

// ─── XlethEffectBase ────────────────────────────────────────────────────────
// Base class for all Xleth real-time insert effects.  Extends AudioProcessor
// so instances can be hosted inside a juce::AudioProcessorGraph.
//
// Features
//   APVTS   : subclass passes its ParameterLayout to the constructor; the base
//             builds the AudioProcessorValueTreeState before audio starts.
//   Smoothing: three types (Linear 20 ms, Multiplicative 30 ms, OnePole 50-100 ms).
//             Subclass calls registerSmoothedParam() from its constructor; the base
//             resolves raw-value pointers in prepareToPlay and drives smoothers
//             per block.  Subclass calls getNextSmoothedValue() per sample inside
//             processEffect().
//   Metering : 8 atomic float slots.  Subclass calls writeMeterValue() from the
//             audio thread; N-API calls readMeterValue() / getMeterAsJSON() from
//             the main thread.
//   Bypass   : 5 ms linear crossfade (wet ↔ dry).  processEffect() is always
//             called so internal state (including smoothers) stays consistent.
//   Serialization: getStateInformation / setStateInformation backed by APVTS XML.

class XlethEffectBase : public juce::AudioProcessor
{
public:
    // ── Smoothing type ──────────────────────────────────────────────────────
    enum class SmoothType { Linear, Multiplicative, OnePole };

    // ── Constructor ─────────────────────────────────────────────────────────
    // Subclass builds the parameter layout in a static factory function and
    // passes it here so the APVTS member is initialised in the MIL with *this
    // already pointing to a valid AudioProcessor.  Empty default layout keeps
    // all existing stubs that call XlethEffectBase("pluginId") compiling as-is.
    // `withSidechainInput` adds a SECOND, optional stereo input bus ("Sidechain")
    // that is DISABLED by default — so the effect's channel layout, latency, and
    // graph wiring are byte-identical to a plain stereo effect until the bus is
    // explicitly enabled (Prompt 5A: only the stock compressor declares it, and
    // only when a sidechain route targets that exact instance). Every other stock
    // effect passes `withSidechainInput == false` and is completely unaffected.
    explicit XlethEffectBase(
            const std::string& pluginId,
            juce::AudioProcessorValueTreeState::ParameterLayout layout = {},
            bool withSidechainInput = false)
        : AudioProcessor(makeBusesProperties(withSidechainInput))
        , pluginId_(pluginId)
        , apvts_(*this, nullptr, "State", std::move(layout))
    {}

    ~XlethEffectBase() override = default;

    // ── Bypass control (main thread writes, audio thread reads) ─────────────
    void setBypassed(bool b)
    {
        bypassed_.store(b, std::memory_order_relaxed);
        onBypassChanged(b);
    }
    bool isBypassed()  const { return bypassed_.load(std::memory_order_relaxed); }

    const std::string& getPluginId() const { return pluginId_; }

    // ── External sidechain capability (Prompt 5A) ───────────────────────────
    // Internal truth used by the engine to decide which stock effects may have a
    // sidechain key bus enabled when a route targets them. Only the stock
    // compressor overrides this; every other stock effect stays false, so they
    // never receive a second input bus (no behavior change).
    virtual bool supportsExternalSidechain() const { return false; }

    // True iff this effect declared the optional second input bus at construction.
    bool hasSidechainInputBus() const { return getBusCount(true) > 1; }

    // True iff the optional sidechain input bus is currently enabled (has > 0
    // channels). Audio thread may read this; it is only mutated on the main
    // thread under the chains lock via setSidechainInputEnabled().
    bool isSidechainInputEnabled() const
    {
        const auto* bus = getBusCount(true) > 1 ? getBus(true, 1) : nullptr;
        return bus != nullptr && bus->isEnabled() && bus->getNumberOfChannels() > 0;
    }

    // Main-thread only: enable/disable the optional sidechain input bus. Returns
    // true iff the layout actually changed (so the caller can re-prepare the
    // graph exactly once). No-op (returns false) for effects without the bus.
    // The graph MUST be re-prepared after a true return — the new channel layout
    // is not live until prepareToPlay runs again.
    bool setSidechainInputEnabled(bool enabled)
    {
        if (getBusCount(true) < 2) return false;
        auto* bus = getBus(true, 1);
        if (bus == nullptr) return false;
        const bool cur = bus->isEnabled() && bus->getNumberOfChannels() > 0;
        if (cur == enabled) return false;

        auto layout = getBusesLayout();
        if (layout.inputBuses.size() < 2) return false;
        layout.inputBuses.getReference(1) = enabled
            ? juce::AudioChannelSet::stereo()
            : juce::AudioChannelSet::disabled();
        if (!setBusesLayout(layout)) return false;
        return true;
    }

    struct RealtimeTimingContext
    {
        bool enabled = false;
        int trackId = 0;
        void* userData = nullptr;
        void (*recordPlugin)(void*, const char*, int, int, std::uint64_t) = nullptr;
        void (*recordSection)(void*, const char*, const char*, int, int, std::uint64_t) = nullptr;
        void (*recordEvent)(void*, const char*, const char*, int, int) = nullptr;
    };

    void setHostNodeId(int nodeId) noexcept
    {
        hostNodeId_.store(nodeId, std::memory_order_relaxed);
    }

    int getHostNodeId() const noexcept
    {
        return hostNodeId_.load(std::memory_order_relaxed);
    }

    static void setRealtimeTimingContext(const RealtimeTimingContext& context) noexcept
    {
        sRealtimeTimingContext_ = context;
    }

    static RealtimeTimingContext getRealtimeTimingContext() noexcept
    {
        return sRealtimeTimingContext_;
    }

    // ── Global BPM (written by MixEngine once per block, read by any effect) ──
    static void setGlobalBPM(double bpm) { sBPM_.store(bpm, std::memory_order_relaxed); }

    // ── Per-block MidiBuffer (set by AudioGraph before graph_->processBlock) ──
    // Audio-thread only.  Bypasses APG MIDI routing (no MIDI connections exist
    // in the graph); effects read onset events from this pointer instead.
    static void setCurrentMidiBuffer(juce::MidiBuffer* buf) { sCurrentMidi_ = buf; }

    // ── Smoothing registration ───────────────────────────────────────────────
    // Call from the subclass constructor (after the base constructor has run).
    // Pointers are resolved and smoothers initialised in prepareToPlay().
    void registerSmoothedParam(const std::string& paramId, SmoothType type, float rampMs)
    {
        SmoothedEntry e;
        e.type   = type;
        e.rampMs = rampMs;
        smoothedParams_.emplace(paramId, std::move(e));
    }

    // ── Metering (audio thread writes, main thread reads) ────────────────────
    static constexpr int kNumMeterSlots = 8;

    // Audio thread: write an output level to a slot (0–7).
    void writeMeterValue(int slot, float value)
    {
        if (slot >= 0 && slot < kNumMeterSlots)
            meterSlots_[slot].store(value, std::memory_order_relaxed);
    }

    // Main thread: read a meter slot.
    float readMeterValue(int slot) const
    {
        if (slot >= 0 && slot < kNumMeterSlots)
            return meterSlots_[slot].load(std::memory_order_relaxed);
        return 0.0f;
    }

    // ── Parameter helpers (main-thread only) ────────────────────────────────

    // Returns JSON array: [{id, name, min, max, default, value, unit}, ...]
    std::string getParametersAsJSON() const
    {
        nlohmann::json arr = nlohmann::json::array();
        for (auto* param : getParameters())
        {
            auto* rp = dynamic_cast<juce::RangedAudioParameter*>(param);
            if (!rp) continue;
            const auto& range = rp->getNormalisableRange();
            nlohmann::json p;
            p["id"]      = rp->paramID.toStdString();
            p["name"]    = rp->getName(256).toStdString();
            p["min"]     = range.start;
            p["max"]     = range.end;
            p["default"] = rp->convertFrom0to1(rp->getDefaultValue());
            p["value"]   = rp->convertFrom0to1(rp->getValue());
            p["unit"]    = rp->getLabel().toStdString();
            arr.push_back(std::move(p));
        }
        return arr.dump();
    }

    float getParameterValue(const std::string& paramId) const
    {
        auto* param = apvts_.getParameter(juce::String(paramId));
        if (!param) return 0.0f;
        auto* rp = dynamic_cast<juce::RangedAudioParameter*>(param);
        return rp ? rp->convertFrom0to1(rp->getValue()) : 0.0f;
    }

    // Set a parameter by ID (denormalised value).  Returns false if not found.
    bool setParameterValue(const std::string& paramId, float value)
    {
        auto* param = apvts_.getParameter(juce::String(paramId));
        if (!param) return false;
        auto* rp = dynamic_cast<juce::RangedAudioParameter*>(param);
        if (!rp) return false;
        param->setValueNotifyingHost(rp->convertTo0to1(value));
        onParameterValueChanged(paramId, value);
        return true;
    }

    // Returns JSON array of kNumMeterSlots floats: [slot0, slot1, ..., slot7]
    std::string getMeterAsJSON() const
    {
        nlohmann::json arr = nlohmann::json::array();
        for (int i = 0; i < kNumMeterSlots; ++i)
            arr.push_back(meterSlots_[i].load(std::memory_order_relaxed));
        return arr.dump();
    }

    // ── Visualization (dynamics, optional, opt-in per instance) ─────────────
    // Default behavior: no-op. Effects with a meaningful visualization payload
    // (Compressor today; later Limiter / Transient / Overdone) override these.
    //
    // Enable/disable allocates / tears down the per-instance ring on the main
    // thread; the audio thread checks an atomic pointer per block (zero cost
    // when disabled). Called from the bridge/UI when the editor opens/closes.
    virtual void setVisualizationEnabled(bool /*enabled*/) {}

    // Visualization type tag (see engine/src/audio/viz/DynamicsVizFrame.h).
    // Default: kVizTypeUnknown (= 0). Compressor returns kVizTypeCompressor.
    virtual std::uint32_t getVisualizationType() const { return 0u; }

    // Schema version of the bucket layout this effect emits. Default 0 means
    // "no visualization"; concrete effects return kDynamicsVizSchemaVersion.
    virtual std::uint32_t getVisualizationSchemaVersion() const { return 0u; }

    // Main-thread drain. Copies up to `maxBytes` of complete visualization
    // buckets to `out`. Returns the number of bytes written. Default: 0.
    virtual std::size_t drainVizFrames(std::uint8_t* /*out*/, std::size_t /*maxBytes*/)
    {
        return 0;
    }

    // ── AudioProcessor overrides ─────────────────────────────────────────────

    void prepareToPlay(double sampleRate, int maximumExpectedSamplesPerBlock) override
    {
        bypassRampPerSample_ = 1.0f / static_cast<float>(sampleRate * 0.005);
        dryBuffer_.setSize(2, maximumExpectedSamplesPerBlock, false, true, true);
        initSmoothers(sampleRate);
        prepareEffect(sampleRate, maximumExpectedSamplesPerBlock);
    }

    void releaseResources() override
    {
        dryBuffer_.setSize(0, 0);
        releaseEffect();
    }

    void processBlock(juce::AudioBuffer<float>& buffer, juce::MidiBuffer& /*apgMidi*/) override
    {
        struct TimingScope
        {
            RealtimeTimingContext context;
            const char* pluginId = "";
            int nodeId = -1;
            std::chrono::steady_clock::time_point start;

            TimingScope(RealtimeTimingContext c, const char* id, int node)
                : context(c), pluginId(id), nodeId(node)
            {
                if (context.enabled && context.recordPlugin != nullptr)
                    start = std::chrono::steady_clock::now();
            }

            ~TimingScope()
            {
                if (!context.enabled || context.recordPlugin == nullptr)
                    return;

                const auto end = std::chrono::steady_clock::now();
                const auto elapsed =
                    std::chrono::duration_cast<std::chrono::nanoseconds>(end - start).count();
                context.recordPlugin(context.userData,
                                     pluginId,
                                     context.trackId,
                                     nodeId,
                                     static_cast<std::uint64_t>(
                                         std::max<std::int64_t>(0, elapsed)));
            }
        };

        TimingScope timingScope(sRealtimeTimingContext_,
                                pluginId_.c_str(),
                                hostNodeId_.load(std::memory_order_relaxed));

        juce::ScopedNoDenormals noDenormals;
        const int  numSamples = buffer.getNumSamples();
        const int  numCh      = buffer.getNumChannels();
        const bool wantBypass = bypassed_.load(std::memory_order_relaxed);

        // Resolve the MidiBuffer set by AudioGraph (bypasses APG MIDI routing).
        juce::MidiBuffer emptyFallback;
        juce::MidiBuffer& midi = sCurrentMidi_ ? *sCurrentMidi_ : emptyFallback;

        // Pull latest APVTS values into smoothers once per block (not per sample)
        updateSmootherTargets();

        const bool useAlignedBypassDry = usesLatencyAlignedBypassDry();
        const int dryChannels = std::min(numCh, dryBuffer_.getNumChannels());

        // Fast path: fully wet, not transitioning → just process
        if (!wantBypass && bypassMix_ <= 0.0f)
        {
            processEffect(buffer, midi);
            return;
        }

        // Fast path: fully dry, not transitioning → pass through but keep
        // smoothers in sync so ramps are correct when bypass is lifted
        if (wantBypass && bypassMix_ >= 1.0f)
        {
            if (useAlignedBypassDry)
            {
                for (int ch = 0; ch < dryChannels; ++ch)
                    dryBuffer_.copyFrom(ch, 0, buffer, ch, 0, numSamples);

                processEffect(buffer, midi);

                (void) copyLatencyAlignedBypassDry(dryBuffer_, numSamples);

                for (int ch = 0; ch < dryChannels; ++ch)
                    buffer.copyFrom(ch, 0, dryBuffer_, ch, 0, numSamples);
                return;
            }

            advanceSmoothers(numSamples);
            return;
        }

        // Crossfade path: save dry, process wet, blend per sample
        for (int ch = 0; ch < dryChannels; ++ch)
            dryBuffer_.copyFrom(ch, 0, buffer, ch, 0, numSamples);

        processEffect(buffer, midi);

        if (useAlignedBypassDry)
            (void) copyLatencyAlignedBypassDry(dryBuffer_, numSamples);

        const float target = wantBypass ? 1.0f : 0.0f;
        for (int s = 0; s < numSamples; ++s)
        {
            if (bypassMix_ < target)
                bypassMix_ = std::min(bypassMix_ + bypassRampPerSample_, target);
            else if (bypassMix_ > target)
                bypassMix_ = std::max(bypassMix_ - bypassRampPerSample_, target);

            for (int ch = 0; ch < dryChannels; ++ch)
            {
                const float wet = buffer.getSample(ch, s);
                const float dry = dryBuffer_.getSample(ch, s);
                buffer.setSample(ch, s, dry * bypassMix_ + wet * (1.0f - bypassMix_));
            }
        }
    }

    // ── Subclass interface ────────────────────────────────────────────────────
    virtual void processEffect(juce::AudioBuffer<float>& buffer, juce::MidiBuffer& midi) = 0;
    virtual void prepareEffect(double sampleRate, int maxBlockSize)
        { juce::ignoreUnused(sampleRate, maxBlockSize); }
    virtual void releaseEffect() {}
    virtual void resetEffect()   {}
    virtual bool usesLatencyAlignedBypassDry() const { return false; }
    virtual bool copyLatencyAlignedBypassDry(juce::AudioBuffer<float>& dest, int numSamples)
    {
        juce::ignoreUnused(dest, numSamples);
        return false;
    }
    virtual void onBypassChanged(bool /*bypassed*/) {}
    virtual void onParameterValueChanged(const std::string& /*paramId*/, float /*value*/) {}

    static bool isRealtimeTimingEnabled() noexcept
    {
        return sRealtimeTimingContext_.enabled;
    }

    static std::uint64_t realtimeNowNs() noexcept
    {
        return static_cast<std::uint64_t>(
            std::chrono::duration_cast<std::chrono::nanoseconds>(
                std::chrono::steady_clock::now().time_since_epoch()).count());
    }

    void recordRealtimeSection(const char* sectionId, std::uint64_t elapsedNs) const noexcept
    {
        const auto context = sRealtimeTimingContext_;
        if (context.enabled && context.recordSection != nullptr)
        {
            context.recordSection(context.userData,
                                  pluginId_.c_str(),
                                  sectionId,
                                  context.trackId,
                                  hostNodeId_.load(std::memory_order_relaxed),
                                  elapsedNs);
        }
    }

    void recordRealtimeEvent(const char* eventId) const noexcept
    {
        const auto context = sRealtimeTimingContext_;
        if (context.enabled && context.recordEvent != nullptr)
        {
            context.recordEvent(context.userData,
                                pluginId_.c_str(),
                                eventId,
                                context.trackId,
                                hostNodeId_.load(std::memory_order_relaxed));
        }
    }

    // ── Smoothed value accessors (audio thread only) ──────────────────────────

    // Advance the named smoother by one sample and return its value.
    // Call once per sample inside processEffect's inner loop.
    // Returns 1.0 if paramId was never registered (safe no-op default).
    float getNextSmoothedValue(const std::string& paramId)
    {
        auto it = smoothedParams_.find(paramId);
        if (it == smoothedParams_.end()) return 1.0f;
        return it->second.advance();
    }

    // Read the current smoothed value without advancing (block-level snapshot).
    float getSmoothedValue(const std::string& paramId) const
    {
        auto it = smoothedParams_.find(paramId);
        if (it == smoothedParams_.end()) return 1.0f;
        return it->second.current();
    }

    // ── Boilerplate AudioProcessor overrides (headless — no GUI) ─────────────
    const juce::String getName() const override { return juce::String(pluginId_); }

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

    // ── Serialization (APVTS XML round-trip) ─────────────────────────────────
    void getStateInformation(juce::MemoryBlock& dest) override
    {
        auto xml = apvts_.copyState().createXml();
        if (xml) copyXmlToBinary(*xml, dest);
    }

    void setStateInformation(const void* data, int sizeInBytes) override
    {
        auto xml = getXmlFromBinary(data, sizeInBytes);
        if (xml && xml->hasTagName(apvts_.state.getType()))
            apvts_.replaceState(juce::ValueTree::fromXml(*xml));
    }

    void reset() override
    {
        bypassMix_ = bypassed_.load(std::memory_order_relaxed) ? 1.0f : 0.0f;
        resetEffect();
    }

protected:
    // Exposed so subclass can attach listeners or access params directly.
    juce::AudioProcessorValueTreeState apvts_;

    static double getGlobalBPM() { return sBPM_.load(std::memory_order_relaxed); }

private:
    // ── Bus construction ──────────────────────────────────────────────────────
    // All Xleth effects are stereo-in / stereo-out. When `withSidechainInput` is
    // set, a SECOND stereo input bus ("Sidechain") is declared but left DISABLED
    // by default, so the realtime layout is identical to a plain stereo effect
    // until the engine enables it on demand (Prompt 5A).
    static BusesProperties makeBusesProperties(bool withSidechainInput)
    {
        auto props = BusesProperties()
            .withInput ("Input",  juce::AudioChannelSet::stereo(), true)
            .withOutput("Output", juce::AudioChannelSet::stereo(), true);
        if (withSidechainInput)
            props = props.withInput("Sidechain", juce::AudioChannelSet::stereo(), false);
        return props;
    }

    // ── Per-parameter smoother state ──────────────────────────────────────────
    struct SmoothedEntry
    {
        SmoothType          type    = SmoothType::Linear;
        float               rampMs  = 20.0f;
        std::atomic<float>* paramPtr = nullptr; // set in prepareToPlay

        // One of these is active depending on type (both stored — small cost)
        juce::SmoothedValue<float, juce::ValueSmoothingTypes::Linear>          linear;
        juce::SmoothedValue<float, juce::ValueSmoothingTypes::Multiplicative>  multi;

        // OnePole state (1-pole IIR: y = α·x + (1-α)·y)
        float onePoleState  = 0.0f;
        float onePoleAlpha  = 0.0f;
        float onePoleTarget = 0.0f;

        void prepare(double sampleRate, float initVal)
        {
            switch (type)
            {
                case SmoothType::Linear:
                    linear.reset(sampleRate, static_cast<double>(rampMs) / 1000.0);
                    linear.setCurrentAndTargetValue(initVal);
                    break;

                case SmoothType::Multiplicative:
                {
                    const float safeInit = std::max(initVal, 1e-6f);
                    multi.reset(sampleRate, static_cast<double>(rampMs) / 1000.0);
                    multi.setCurrentAndTargetValue(safeInit);
                    break;
                }

                case SmoothType::OnePole:
                    onePoleAlpha  = 1.0f - std::exp(
                        -1.0f / (static_cast<float>(rampMs) / 1000.0f
                                 * static_cast<float>(sampleRate)));
                    onePoleState  = initVal;
                    onePoleTarget = initVal;
                    break;
            }
        }

        void setTarget(float target)
        {
            switch (type)
            {
                case SmoothType::Linear:
                    linear.setTargetValue(target);
                    break;
                case SmoothType::Multiplicative:
                    multi.setTargetValue(std::max(target, 1e-6f));
                    break;
                case SmoothType::OnePole:
                    onePoleTarget = target;
                    break;
            }
        }

        // Advance by one sample, return current value.
        float advance()
        {
            switch (type)
            {
                case SmoothType::Linear:         return linear.getNextValue();
                case SmoothType::Multiplicative: return multi.getNextValue();
                case SmoothType::OnePole:
                    onePoleState = onePoleAlpha * onePoleTarget
                                 + (1.0f - onePoleAlpha) * onePoleState;
                    return onePoleState;
            }
            return onePoleState; // unreachable
        }

        // Read current value without advancing.
        float current() const
        {
            switch (type)
            {
                case SmoothType::Linear:         return linear.getCurrentValue();
                case SmoothType::Multiplicative: return multi.getCurrentValue();
                case SmoothType::OnePole:        return onePoleState;
            }
            return onePoleState; // unreachable
        }

        // Advance by n samples in one shot (used when fully bypassed).
        void skip(int n)
        {
            if (n <= 0) return;
            switch (type)
            {
                case SmoothType::Linear:         linear.skip(n); break;
                case SmoothType::Multiplicative: multi.skip(n);  break;
                case SmoothType::OnePole:
                    // Closed-form: state approaches target with decay (1-α)^n
                    onePoleState = onePoleTarget
                                 + (onePoleState - onePoleTarget)
                                 * std::pow(1.0f - onePoleAlpha, static_cast<float>(n));
                    break;
            }
        }
    };

    // ── Smoother lifecycle helpers ────────────────────────────────────────────

    void initSmoothers(double sampleRate)
    {
        for (auto& [id, entry] : smoothedParams_)
        {
            entry.paramPtr  = apvts_.getRawParameterValue(id);
            const float init = entry.paramPtr
                             ? entry.paramPtr->load(std::memory_order_relaxed)
                             : 1.0f;
            entry.prepare(sampleRate, init);
        }
    }

    // Update smoother targets from APVTS atomics — called once per block.
    void updateSmootherTargets()
    {
        for (auto& [id, entry] : smoothedParams_)
            if (entry.paramPtr)
                entry.setTarget(entry.paramPtr->load(std::memory_order_relaxed));
    }

    // Advance all smoothers by numSamples without producing output (fully bypassed).
    void advanceSmoothers(int numSamples)
    {
        for (auto& [id, entry] : smoothedParams_)
            entry.skip(numSamples);
    }

    // ── Global BPM (static, shared across all effect instances) ────────────
    static inline std::atomic<double> sBPM_{140.0};

    // ── Per-block MidiBuffer pointer (audio-thread only, single-threaded) ──
    static inline juce::MidiBuffer* sCurrentMidi_ = nullptr;
    static inline thread_local RealtimeTimingContext sRealtimeTimingContext_ {};

    // ── Data members ─────────────────────────────────────────────────────────
    std::string       pluginId_;
    std::atomic<bool> bypassed_{false};
    std::atomic<int>  hostNodeId_{-1};
    float             bypassMix_           = 0.0f; // 0 = fully wet, 1 = fully dry
    float             bypassRampPerSample_ = 0.0f;
    juce::AudioBuffer<float> dryBuffer_;

    std::unordered_map<std::string, SmoothedEntry> smoothedParams_;

    // Zero-initialised via aggregate init (std::atomic is not copyable, but
    // array aggregate init with {} is fine in C++17/20).
    std::atomic<float> meterSlots_[kNumMeterSlots] {};
};
