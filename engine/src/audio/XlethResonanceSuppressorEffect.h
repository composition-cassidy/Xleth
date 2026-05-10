#pragma once

#include "audio/XlethEffectBase.h"
#include "audio/viz/DynamicsVizCollector.h"
#include "audio/viz/DynamicsVizFrame.h"

#include <juce_dsp/juce_dsp.h>

#include <algorithm>
#include <array>
#include <atomic>
#include <cmath>
#include <cstdint>
#include <memory>
#include <string>
#include <vector>

// XlethResonanceSuppressorEffect
// Adaptive resonance suppressor, Phase 1 DSP foundation.
//
// This phase applies the first real spectral gain-reduction mask from the
// detector salience plus latency-aligned mix, trim, delta listen, and
// frequency weighting. The weighting curve shapes suppression sensitivity only;
// it is not an audio EQ. Sidechain, graph visualization, and UI behavior are
// not active.
//
// The WOLA path processes mono/stereo. Channels 2+ pass through unchanged.
//
// Quality is captured in prepareEffect() only:
//   Fast   = 512 FFT,  128 hop
//   Normal = 1024 FFT, 256 hop
//   High   = 2048 FFT, 512 hop
//
// The current streaming implementation has been regression-tested by impulse
// measurement as a delay of fftSize samples for each mode. setLatencySamples()
// follows the same JUCE/Xleth pattern used by existing latency-reporting
// effects in this project.
//
// Metering slots:
//   0 = input peak L
//   1 = input peak R
//   2 = gain-reduction activity in [0..1]. It reports the average of the top
//       smoothed reduction bins relative to the 24 dB hard-mode ceiling, not a
//       single random peak bin.
//
// Visualization emits schema-v2 ResonanceBucket payloads only while explicitly
// enabled. Buckets are log-frequency summaries of spectrum, reduction, and
// weighting arrays; they are display-only and never feed back into DSP.
//
// pluginId: "resonancesuppressor"

class XlethResonanceSuppressorEffect : public XlethEffectBase
{
public:
    XlethResonanceSuppressorEffect()
        : XlethEffectBase("resonancesuppressor", createLayout())
    {
        registerSmoothedParam("depth",       SmoothType::Linear, 20.0f);
        registerSmoothedParam("sharpness",   SmoothType::Linear, 20.0f);
        registerSmoothedParam("selectivity", SmoothType::Linear, 20.0f);
        registerSmoothedParam("mix",         SmoothType::Linear, 20.0f);
        registerSmoothedParam("trim",        SmoothType::Linear, 20.0f);
        registerSmoothedParam("stereo_link", SmoothType::Linear, 20.0f);

        registerSmoothedParam("attack",      SmoothType::OnePole, 50.0f);
        registerSmoothedParam("release",     SmoothType::OnePole, 80.0f);

        // wc_hp/wc_lp and per-band wc_bN_freq/gain/q are read directly from
        // APVTS once per block (see processEffect). The per-bin weighting curve
        // is recomputed each FFT frame, so per-sample smoothing on these
        // discretely-sampled scalars wouldn't be observed; using readFloatParam
        // also avoids a JUCE SmoothedValue gotcha where current() never
        // advances unless getNextValue() is called per sample.
    }

    void setVisualizationEnabled(bool enabled) override
    {
        if (enabled)
        {
            if (!vizCollector_)
            {
                vizCollector_ = std::make_unique<
                    xleth::viz::DynamicsVizCollector<xleth::viz::ResonanceBucket>>(
                        xleth::viz::kDynamicsVizBucketSize,
                        xleth::viz::kDynamicsVizRingDepth,
                        xleth::viz::kVizTypeResonance);
            }

            vizActive_.store(vizCollector_.get(), std::memory_order_release);
        }
        else
        {
            // Retain the collector after unpublishing it, matching the other
            // dynamics visualizers and avoiding a possible audio-thread race.
            vizActive_.store(nullptr, std::memory_order_release);
        }
    }

    std::uint32_t getVisualizationType() const override
    {
        return xleth::viz::kVizTypeResonance;
    }

    std::uint32_t getVisualizationSchemaVersion() const override
    {
        return xleth::viz::kDynamicsVizSchemaVersion;
    }

    std::size_t drainVizFrames(std::uint8_t* out, std::size_t maxBytes) override
    {
        if (!vizCollector_)
            return 0;
        return vizCollector_->drain(out, maxBytes);
    }

    double getTailLengthSeconds() const override
    {
        const int latency = getLatencySamples();
        return sampleRate_ > 0.0 && latency > 0
            ? static_cast<double>(latency) / sampleRate_
            : 0.0;
    }

    std::uint64_t getProcessBlockLatencyUpdateCount() const
    {
        return processBlockLatencyUpdateCount_.load(std::memory_order_acquire);
    }

    std::uint64_t getNonRealtimeLatencyUpdateCount() const
    {
        return nonRealtimeLatencyUpdateCount_.load(std::memory_order_acquire);
    }

    int getReportedProcessorLatencySamples() const
    {
        return AudioProcessor::getLatencySamples();
    }

    void setStateInformation(const void* data, int sizeInBytes) override
    {
        auto xml = getXmlFromBinary(data, sizeInBytes);
        if (xml && xml->hasTagName(apvts_.state.getType()))
        {
            bool hasProcessingMode = false;
            for (auto* child : xml->getChildIterator())
            {
                if (child != nullptr
                    && child->hasTagName("PARAM")
                    && child->getStringAttribute("id") == "processing_mode")
                {
                    hasProcessingMode = true;
                    break;
                }
            }

            if (!hasProcessingMode)
            {
                auto legacyMode = std::make_unique<juce::XmlElement>("PARAM");
                legacyMode->setAttribute("id", "processing_mode");
                legacyMode->setAttribute("value", "1.0");
                xml->addChildElement(legacyMode.release());
            }

            apvts_.replaceState(juce::ValueTree::fromXml(*xml));
            preparedHighQualityQualityIndex_ = -1;
            pendingHighQualityReprepare_ = true;
            reprepareHighQualityStateForCurrentQuality();
            activeEngine_ = ProcessingEngine::None;
            wetStateCleared_ = false;
            refreshLatencyState();
        }
    }

    void prepareEffect(double sampleRate, int maxBlockSize) override
    {
        sampleRate_   = sampleRate;
        maxBlockSize_ = maxBlockSize;

        preparedHighQualityQualityIndex_ = -1;
        pendingHighQualityReprepare_ = true;
        reprepareHighQualityStateForCurrentQuality();
        lowLatency_.prepare(maxBlockSize, sampleRate);
        liveDry_.setSize(2, std::max(1, maxBlockSize), false, true, true);
        msComponent_.assign(static_cast<std::size_t>(std::max(1, maxBlockSize)), 0.0f);
        deltaRampPerSample_ = sampleRate > 0.0
            ? static_cast<float>(1.0 / (sampleRate * 0.005))
            : 1.0f;
        deltaMix_ = readBoolParam("delta", false) ? 1.0f : 0.0f;
        activeEngine_ = ProcessingEngine::None;
        wetStateCleared_ = false;
        refreshLatencyState();

#ifdef XLETH_DEBUG
        DBG("[ResonanceSuppressor] prepareEffect sr=" + juce::String(sampleRate)
            + " blockSize=" + juce::String(maxBlockSize)
            + " fftSize=" + juce::String(wola_.getFftSize())
            + " hopSize=" + juce::String(wola_.getHopSize())
            + " latency=" + juce::String(wola_.getLatencySamples()));
#endif
    }

    void releaseEffect() override
    {
        wola_.release();
        lowLatency_.release();
        dryDelay_.release();
        delayedDry_.setSize(0, 0);
        liveDry_.setSize(0, 0);
        msComponent_.clear();
        setLatencySamples(0);
        activeEngine_ = ProcessingEngine::None;
        wetStateCleared_ = false;
    }

    void resetEffect() override
    {
        clearWetProcessingState();
        std::fill(msComponent_.begin(), msComponent_.end(), 0.0f);
        deltaMix_ = readBoolParam("delta", false) ? 1.0f : 0.0f;
        activeEngine_ = ProcessingEngine::None;
        wetStateCleared_ = false;
    }

    void processEffect(juce::AudioBuffer<float>& buffer, juce::MidiBuffer& /*midi*/) override
    {
        const int numSamples = buffer.getNumSamples();
        const int numCh      = buffer.getNumChannels();

        float peakL = 0.0f;
        float peakR = 0.0f;

#if defined(XLETH_DEBUG) && defined(XLETH_RESONANCE_SUPPRESSOR_AUDIO_LOG)
        // Throttled diagnostic: confirms processEffect runs in the real app and
        // reports input vs output peak so we can verify the wet path actually
        // modifies the buffer. Logged once every ~500 blocks (~5s at 48k/480).
        static std::atomic<uint64_t> rsCounter{0};
        const uint64_t rsCallNo = rsCounter.fetch_add(1, std::memory_order_relaxed);
        const bool rsLogThis = (rsCallNo % 500 == 0);
        float rsInPeakBefore = 0.0f;
        if (rsLogThis && numCh > 0)
        {
            const float* d = buffer.getReadPointer(0);
            for (int s = 0; s < numSamples; ++s)
                rsInPeakBefore = std::max(rsInPeakBefore, std::abs(d[s]));
        }
#endif

        if (numCh > 0)
        {
            const float* dataL = buffer.getReadPointer(0);
            for (int s = 0; s < numSamples; ++s)
                peakL = std::max(peakL, std::abs(dataL[s]));
        }

        if (numCh > 1)
        {
            const float* dataR = buffer.getReadPointer(1);
            for (int s = 0; s < numSamples; ++s)
                peakR = std::max(peakR, std::abs(dataR[s]));
        }
        else
        {
            peakR = peakL;
        }

        const int processedChannels = std::min(numCh, 2);
        if (processedChannels > 0 && liveDry_.getNumSamples() >= numSamples)
        {
            for (int ch = 0; ch < processedChannels; ++ch)
                liveDry_.copyFrom(ch, 0, buffer, ch, 0, numSamples);
        }

        const ProcessorSettings settings = readProcessorSettings();
        const bool dryOnlyTarget = shouldOutputLiveDry();
        float gainReductionActivity = 0.0f;

        if (processedChannels > 0)
        {
            if (dryOnlyTarget)
            {
                advanceOutputSmoothers(numSamples);
                deltaMix_ = 0.0f;

                if (!wetStateCleared_)
                {
                    clearWetProcessingState();
                    activeEngine_ = ProcessingEngine::None;
                    wetStateCleared_ = true;
                }

                for (int ch = 0; ch < processedChannels; ++ch)
                    buffer.copyFrom(ch, 0, liveDry_, ch, 0, numSamples);
            }
            else if (readProcessingMode() == 1)
            {
                ensureHighQualityStateForCurrentQuality();
                if (!wola_.isPrepared())
                {
                    buffer.clear();
                    writeMeterValue(0, peakL);
                    writeMeterValue(1, peakR);
                    writeMeterValue(2, gainReductionActivity);
                    return;
                }

                wetStateCleared_ = false;
                if (activeEngine_ != ProcessingEngine::HighQuality)
                {
                    clearLowLatencyState();
                    activeEngine_ = ProcessingEngine::HighQuality;
                }

                for (int ch = 0; ch < processedChannels; ++ch)
                    dryDelay_.processChannel(ch,
                                             liveDry_.getReadPointer(ch),
                                             delayedDry_.getWritePointer(ch),
                                             numSamples);

                const int stereoMode = std::clamp(static_cast<int>(settings.stereoMode), 0, 2);
                if (stereoMode != lastStereoMode_)
                {
                    wola_.reset();
                    lastStereoMode_ = stereoMode;
                }

                const bool timeWola = isRealtimeTimingEnabled();
                const std::uint64_t wolaStartNs = timeWola ? realtimeNowNs() : 0;

                wola_.beginBlock(settings, vizActive_.load(std::memory_order_acquire));

                if (processedChannels == 2 && stereoMode == 1)
                    processHighQualityMidMode(buffer, numSamples);
                else if (processedChannels == 2 && stereoMode == 2)
                    processHighQualitySideMode(buffer, numSamples);
                else if (processedChannels == 2)
                    wola_.processStereo(buffer.getWritePointer(0),
                                        buffer.getWritePointer(1),
                                        numSamples);
                else if (processedChannels == 1)
                {
                    if (stereoMode == 2)
                        processHighQualityMonoSideMode(buffer, numSamples);
                    else
                        wola_.processMono(buffer.getWritePointer(0), numSamples);
                }

                if (timeWola)
                    recordRealtimeSection("rs_wola", realtimeNowNs() - wolaStartNs);

                applyOutputStage(buffer, delayedDry_, processedChannels, numSamples);
                gainReductionActivity = wola_.getGainReductionActivityForMeter();
            }
            else if (lowLatency_.isPrepared())
            {
                wetStateCleared_ = false;
                if (activeEngine_ != ProcessingEngine::LowLatency)
                {
                    clearHighQualityState();
                    activeEngine_ = ProcessingEngine::LowLatency;
                }

                lowLatency_.beginBlock(settings);

                const int stereoMode = std::clamp(static_cast<int>(settings.stereoMode), 0, 2);
                if (processedChannels == 2 && stereoMode == 1)
                    processLowLatencyMidMode(buffer, numSamples);
                else if (processedChannels == 2 && stereoMode == 2)
                    processLowLatencySideMode(buffer, numSamples);
                else if (processedChannels == 2)
                    lowLatency_.processStereo(buffer.getWritePointer(0),
                                              buffer.getWritePointer(1),
                                              numSamples);
                else if (processedChannels == 1)
                {
                    if (stereoMode == 2)
                        processLowLatencyMonoSideMode(buffer, numSamples);
                    else
                        lowLatency_.processMono(buffer.getWritePointer(0), numSamples);
                }

                applyOutputStage(buffer, liveDry_, processedChannels, numSamples);
                gainReductionActivity = lowLatency_.getGainReductionActivityForMeter();
            }
            else
            {
                deltaMix_ = 0.0f;
                for (int ch = 0; ch < processedChannels; ++ch)
                    buffer.copyFrom(ch, 0, liveDry_, ch, 0, numSamples);
            }
        }
        else
        {
            deltaMix_ = readBoolParam("delta", false) ? 1.0f : 0.0f;
        }

        writeMeterValue(0, peakL);
        writeMeterValue(1, peakR);
        writeMeterValue(2, gainReductionActivity);

#if defined(XLETH_DEBUG) && defined(XLETH_RESONANCE_SUPPRESSOR_AUDIO_LOG)
        if (rsLogThis)
        {
            float rsOutPeak = 0.0f;
            if (numCh > 0)
            {
                const float* d = buffer.getReadPointer(0);
                for (int s = 0; s < numSamples; ++s)
                    rsOutPeak = std::max(rsOutPeak, std::abs(d[s]));
            }
            std::fprintf(stderr,
                         "[ResonanceSuppressor] processEffect call=%llu prepared=%d nCh=%d nS=%d "
                         "inPeak=%.4f outPeak=%.4f deltaMix=%.2f gr=%.3f\n",
                         (unsigned long long)rsCallNo,
                         (int)wola_.isPrepared(), numCh, numSamples,
                         rsInPeakBefore, rsOutPeak, deltaMix_,
                         readMeterValue(2));
            std::fflush(stderr);
        }
#endif
    }

protected:
    bool usesLatencyAlignedBypassDry() const override
    {
        return false;
    }

    bool copyLatencyAlignedBypassDry(juce::AudioBuffer<float>& dest, int numSamples) override
    {
        juce::ignoreUnused(dest, numSamples);
        return false;
    }

private:
    enum class ProcessingEngine
    {
        None,
        LowLatency,
        HighQuality
    };

    static constexpr float kDryOnlyMixThresholdPct = 1.0e-4f;

    void onBypassChanged(bool bypassed) override
    {
        if (bypassed)
        {
            clearWetProcessingState();
            activeEngine_ = ProcessingEngine::None;
            wetStateCleared_ = true;
        }

        refreshLatencyState();
    }

    void onParameterValueChanged(const std::string& paramId, float /*value*/) override
    {
        if (paramId == "processing_mode")
        {
            clearWetProcessingState();
            activeEngine_ = ProcessingEngine::None;
            wetStateCleared_ = false;
        }
        else if (paramId == "quality")
        {
            clearWetProcessingState();
            preparedHighQualityQualityIndex_ = -1;
            pendingHighQualityReprepare_ = true;
            reprepareHighQualityStateForCurrentQuality();
            activeEngine_ = ProcessingEngine::None;
            wetStateCleared_ = false;
        }
        else if ((paramId == "mix" || paramId == "delta") && shouldOutputLiveDry())
        {
            clearWetProcessingState();
            activeEngine_ = ProcessingEngine::None;
            wetStateCleared_ = true;
        }

        if (paramId == "mix"
            || paramId == "delta"
            || paramId == "processing_mode"
            || paramId == "quality")
        {
            refreshLatencyState();
        }
    }

    void advanceOutputSmoothers(int numSamples)
    {
        for (int s = 0; s < numSamples; ++s)
        {
            (void) getNextSmoothedValue(mixParamId_);
            (void) getNextSmoothedValue(trimParamId_);
        }
    }

    bool shouldOutputLiveDry() const noexcept
    {
        return !readBoolParam("delta", false)
            && readFloatParam("mix", 100.0f) <= kDryOnlyMixThresholdPct;
    }

    int readProcessingMode() const noexcept
    {
        return std::clamp(readChoiceParam("processing_mode", 0), 0, 1);
    }

    static int latencyForQualityIndex(int qualityIndex) noexcept
    {
        switch (std::clamp(qualityIndex, 0, 2))
        {
            case 0: return 512;
            case 2: return 2048;
            case 1:
            default: return 1024;
        }
    }

    int computeDesiredLatencySamples() const noexcept
    {
        if (isBypassed() || shouldOutputLiveDry())
            return 0;

        if (readProcessingMode() == 0)
            return 0;

        const int targetQuality = readQualityForPrepare();
        if (pendingHighQualityReprepare_ || preparedHighQualityQualityIndex_ != targetQuality)
        {
            return wola_.isPrepared()
                ? wola_.getLatencySamples()
                : latencyForQualityIndex(targetQuality);
        }

        return wola_.isPrepared()
            ? wola_.getLatencySamples()
            : latencyForQualityIndex(targetQuality);
    }

    bool refreshLatencyState()
    {
        const int desiredLatency = computeDesiredLatencySamples();
        if (desiredLatency == getLatencySamples())
            return false;

        setLatencySamples(desiredLatency);
        nonRealtimeLatencyUpdateCount_.fetch_add(1, std::memory_order_acq_rel);
        return true;
    }

    void ensureHighQualityStateForCurrentQuality()
    {
        const int targetQuality = readQualityForPrepare();
        if (!pendingHighQualityReprepare_
            && preparedHighQualityQualityIndex_ == targetQuality
            && wola_.isPrepared())
        {
            return;
        }

        pendingHighQualityReprepare_ = true;
        recordRealtimeEvent("rs_audio_thread_reprepare_blocked");
    }

    void reprepareHighQualityStateForCurrentQuality()
    {
        if (sampleRate_ <= 0.0 || maxBlockSize_ <= 0)
        {
            pendingHighQualityReprepare_ = true;
            return;
        }

        const int targetQuality = readQualityForPrepare();
        wola_.prepare(targetQuality, maxBlockSize_, sampleRate_);
        dryDelay_.prepare(wola_.getLatencySamples(), maxBlockSize_);
        delayedDry_.setSize(2, std::max(1, maxBlockSize_), false, true, true);
        preparedHighQualityQualityIndex_ = targetQuality;
        pendingHighQualityReprepare_ = false;
    }

    void clearHighQualityState()
    {
        wola_.reset();
        dryDelay_.reset();
        delayedDry_.clear();
        lastStereoMode_ = -1;
    }

    void clearLowLatencyState()
    {
        lowLatency_.reset();
    }

    void clearWetProcessingState()
    {
        clearHighQualityState();
        clearLowLatencyState();
    }

    struct ProcessorSettings
    {
        float depth = 0.5f;
        float sharpness = 0.5f;
        float selectivity = 0.5f;
        float attackMs = 15.0f;
        float releaseMs = 200.0f;
        float stereoLink = 1.0f;
        bool hardMode = false;
        float wcHp = 80.0f;
        float wcLp = 16000.0f;
        float stereoMode = 0.0f;
        std::array<bool, 8> wcActive { true, true, true, true, false, false, false, false };
        std::array<int, 8> wcTypes {};
        std::array<float, 8> wcFreqs { 250.0f, 800.0f, 2500.0f, 8000.0f, 500.0f, 1500.0f, 4000.0f, 10000.0f };
        std::array<float, 8> wcGainsDb {};
        std::array<float, 8> wcQs { 1.0f, 1.0f, 1.0f, 1.0f, 1.0f, 1.0f, 1.0f, 1.0f };
    };

    struct WolaConfig
    {
        int qualityIndex = 1;
        int fftOrder     = 10;
        int fftSize      = 1024;
        int hopSize      = 256;
    };

    struct DryDelayLine
    {
        void prepare(int delaySamplesToUse, int maxBlockSize)
        {
            delaySamples = std::max(0, delaySamplesToUse);
            const int needed = std::max(1, delaySamples + maxBlockSize + 1);
            ringSize = nextPowerOfTwo(needed);
            ringMask = ringSize - 1;
            for (auto& ch : ring)
                ch.assign(static_cast<std::size_t>(ringSize), 0.0f);
            reset();
        }

        void release()
        {
            for (auto& ch : ring)
                ch.clear();
            delaySamples = 0;
            ringSize = 0;
            ringMask = 0;
            writeIndex.fill(0);
        }

        void reset()
        {
            for (auto& ch : ring)
                std::fill(ch.begin(), ch.end(), 0.0f);
            writeIndex.fill(0);
        }

        void processChannel(int channel, const float* input, float* delayed, int numSamples) noexcept
        {
            if (channel < 0 || channel >= static_cast<int>(ring.size()) || ringSize <= 0)
            {
                std::fill(delayed, delayed + numSamples, 0.0f);
                return;
            }

            auto& chRing = ring[static_cast<std::size_t>(channel)];
            auto& chWriteIndex = writeIndex[static_cast<std::size_t>(channel)];
            for (int s = 0; s < numSamples; ++s)
            {
                const std::int64_t readIndex = chWriteIndex - static_cast<std::int64_t>(delaySamples);
                delayed[s] = readIndex >= 0
                    ? chRing[static_cast<std::size_t>(readIndex & ringMask)]
                    : 0.0f;
                chRing[static_cast<std::size_t>(chWriteIndex & ringMask)] = input[s];
                ++chWriteIndex;
            }
        }

        static int nextPowerOfTwo(int value) noexcept
        {
            int p = 1;
            while (p < value)
                p <<= 1;
            return p;
        }

        std::array<std::vector<float>, 2> ring;
        int delaySamples = 0;
        int ringSize = 0;
        int ringMask = 0;
        std::array<std::int64_t, 2> writeIndex {};
    };

    struct SpectralChannelState
    {
        void prepare(int fftSizeToUse, int hopSizeToUse, int ringSizeToUse, int numBinsToUse)
        {
            fftSize  = fftSizeToUse;
            hopSize  = hopSizeToUse;
            ringSize = ringSizeToUse;
            ringMask = ringSize - 1;

            inputRing.assign(static_cast<std::size_t>(ringSize), 0.0f);
            outputRing.assign(static_cast<std::size_t>(ringSize), 0.0f);
            fftBuffer.assign(static_cast<std::size_t>(fftSize * 2), 0.0f);
            salience.assign(static_cast<std::size_t>(numBinsToUse), 0.0f);
            prevSalience.assign(static_cast<std::size_t>(numBinsToUse), 0.0f);
            smoothedReductionDb.assign(static_cast<std::size_t>(numBinsToUse), 0.0f);
            reset();
        }

        void release()
        {
            inputRing.clear();
            outputRing.clear();
            fftBuffer.clear();
            salience.clear();
            prevSalience.clear();
            smoothedReductionDb.clear();
            fftSize = 0;
            hopSize = 0;
            ringSize = 0;
            ringMask = 0;
            samplesWritten = 0;
            samplesEmitted = 0;
            nextFrameStart = 0;
        }

        void reset()
        {
            std::fill(inputRing.begin(), inputRing.end(), 0.0f);
            std::fill(outputRing.begin(), outputRing.end(), 0.0f);
            std::fill(fftBuffer.begin(), fftBuffer.end(), 0.0f);
            std::fill(salience.begin(), salience.end(), 0.0f);
            std::fill(prevSalience.begin(), prevSalience.end(), 0.0f);
            std::fill(smoothedReductionDb.begin(), smoothedReductionDb.end(), 0.0f);
            samplesWritten = 0;
            samplesEmitted = 0;
            nextFrameStart = -static_cast<std::int64_t>(fftSize)
                           + static_cast<std::int64_t>(hopSize);
            detectorActivity = 0.0f;
            reductionActivity = 0.0f;
        }

        float readInput(std::int64_t absoluteIndex) const noexcept
        {
            if (absoluteIndex < 0 || absoluteIndex >= samplesWritten || ringSize <= 0)
                return 0.0f;
            return inputRing[static_cast<std::size_t>(absoluteIndex & ringMask)];
        }

        float readAndClearOutput(std::int64_t absoluteIndex) noexcept
        {
            if (ringSize <= 0)
                return 0.0f;

            const std::size_t idx = static_cast<std::size_t>(absoluteIndex & ringMask);
            const float y = outputRing[idx];
            outputRing[idx] = 0.0f;
            return y;
        }

        void addOutput(std::int64_t absoluteIndex, float value) noexcept
        {
            if (absoluteIndex < samplesEmitted || ringSize <= 0)
                return;

            outputRing[static_cast<std::size_t>(absoluteIndex & ringMask)] += value;
        }

        std::vector<float> inputRing;
        std::vector<float> outputRing;
        std::vector<float> fftBuffer;
        std::vector<float> salience;
        std::vector<float> prevSalience;
        std::vector<float> smoothedReductionDb;
        int fftSize  = 0;
        int hopSize  = 0;
        int ringSize = 0;
        int ringMask = 0;
        std::int64_t samplesWritten = 0;
        std::int64_t samplesEmitted = 0;
        std::int64_t nextFrameStart = 0;
        float detectorActivity = 0.0f;
        float reductionActivity = 0.0f;
    };

    class WolaProcessor
    {
    public:
        void prepare(int qualityIndex, int maxBlockSize, double sampleRate)
        {
            config_ = configForQuality(qualityIndex);
            sampleRate_ = sampleRate > 0.0 ? sampleRate : 44100.0;
            ringSize_ = nextPowerOfTwo(std::max(config_.fftSize * 4,
                                                config_.fftSize * 2 + maxBlockSize + 1));

            fft_ = std::make_unique<juce::dsp::FFT>(config_.fftOrder);
            window_.assign(static_cast<std::size_t>(config_.fftSize), 0.0f);
            normalization_.assign(static_cast<std::size_t>(config_.hopSize), 1.0f);
            const int numBins = config_.fftSize / 2 + 1;
            magDb_.assign(static_cast<std::size_t>(numBins), kFloorDb);
            magDbPrefix_.assign(static_cast<std::size_t>(numBins + 1), 0.0f);
            weighting_.assign(static_cast<std::size_t>(numBins), 1.0f);
            binFrequencies_.assign(static_cast<std::size_t>(numBins), 0.0f);

            buildWindowAndNormalization();
            buildBinFrequencies();
            weightingDirty_ = true;
            rebuildWeightingIfNeeded();

            for (auto& ch : channels_)
                ch.prepare(config_.fftSize, config_.hopSize, ringSize_, numBins);

            prepared_ = true;
        }

        void release()
        {
            prepared_ = false;
            fft_.reset();
            window_.clear();
            normalization_.clear();
            magDb_.clear();
            magDbPrefix_.clear();
            weighting_.clear();
            binFrequencies_.clear();
            ringSize_ = 0;
            blockDetectorActivity_ = 0.0f;
            meterDetectorActivity_ = 0.0f;
            blockReductionActivity_ = 0.0f;
            meterReductionActivity_ = 0.0f;
            vizCollector_ = nullptr;
            vizSampleClock_ = 0;
            weightingDirty_ = true;
            for (auto& ch : channels_)
                ch.release();
        }

        void reset()
        {
            for (auto& ch : channels_)
                ch.reset();
            blockDetectorActivity_ = 0.0f;
            meterDetectorActivity_ = 0.0f;
            blockReductionActivity_ = 0.0f;
            meterReductionActivity_ = 0.0f;
            vizSampleClock_ = 0;
        }

        bool isPrepared() const noexcept { return prepared_ && fft_ != nullptr; }
        int getFftSize() const noexcept { return config_.fftSize; }
        int getHopSize() const noexcept { return config_.hopSize; }

        // Confirmed by the impulse-delay regression tests for the current
        // causal frame scheduling: Fast=512, Normal=1024, High=2048.
        int getLatencySamples() const noexcept { return config_.fftSize; }

        void beginBlock(const ProcessorSettings& settings,
                        xleth::viz::DynamicsVizCollector<xleth::viz::ResonanceBucket>* vizCollector) noexcept
        {
            settings_ = settings;
            vizCollector_ = vizCollector;
            blockDetectorActivity_ = 0.0f;
            blockReductionActivity_ = 0.0f;
            updateDerivedSettings();
            rebuildWeightingIfNeeded();
        }

        float getGainReductionActivityForMeter() noexcept
        {
            if (blockReductionActivity_ > meterReductionActivity_)
                meterReductionActivity_ = blockReductionActivity_;
            else
                meterReductionActivity_ *= 0.92f;

            if (!std::isfinite(meterReductionActivity_) || meterReductionActivity_ < 1.0e-6f)
                meterReductionActivity_ = 0.0f;

            return std::clamp(meterReductionActivity_, 0.0f, 1.0f);
        }

        void processMono(float* data, int numSamples)
        {
            if (!isPrepared())
                return;

            auto& ch = channels_[0];

            for (int s = 0; s < numSamples; ++s)
            {
                const std::int64_t inputIndex = ch.samplesWritten;
                ch.inputRing[static_cast<std::size_t>(inputIndex & ch.ringMask)] = data[s];
                ++ch.samplesWritten;

                processReadyFrames(ch);

                data[s] = ch.readAndClearOutput(ch.samplesEmitted);
                ++ch.samplesEmitted;
            }
        }

        void processStereo(float* left, float* right, int numSamples)
        {
            if (!isPrepared())
                return;

            auto& l = channels_[0];
            auto& r = channels_[1];

            for (int s = 0; s < numSamples; ++s)
            {
                const std::int64_t inputIndexL = l.samplesWritten;
                const std::int64_t inputIndexR = r.samplesWritten;
                l.inputRing[static_cast<std::size_t>(inputIndexL & l.ringMask)] = left[s];
                r.inputRing[static_cast<std::size_t>(inputIndexR & r.ringMask)] = right[s];
                ++l.samplesWritten;
                ++r.samplesWritten;

                processReadyStereoFrames(l, r);

                left[s] = l.readAndClearOutput(l.samplesEmitted);
                right[s] = r.readAndClearOutput(r.samplesEmitted);
                ++l.samplesEmitted;
                ++r.samplesEmitted;
            }
        }

    private:
        static WolaConfig configForQuality(int qualityIndex) noexcept
        {
            WolaConfig c;
            c.qualityIndex = std::clamp(qualityIndex, 0, 2);
            switch (c.qualityIndex)
            {
                case 0: c.fftOrder = 9;  c.fftSize = 512;  c.hopSize = 128; break;
                case 2: c.fftOrder = 11; c.fftSize = 2048; c.hopSize = 512; break;
                case 1:
                default:
                    c.fftOrder = 10; c.fftSize = 1024; c.hopSize = 256; break;
            }
            return c;
        }

        static int nextPowerOfTwo(int value) noexcept
        {
            int p = 1;
            while (p < value)
                p <<= 1;
            return p;
        }

        void buildWindowAndNormalization()
        {
            const float twoPi = 2.0f * juce::MathConstants<float>::pi;
            const float nInv = 1.0f / static_cast<float>(config_.fftSize);

            for (int n = 0; n < config_.fftSize; ++n)
            {
                const float hann = 0.5f - 0.5f * std::cos(twoPi * static_cast<float>(n) * nInv);
                window_[static_cast<std::size_t>(n)] = std::sqrt(std::max(hann, 0.0f));
            }

            for (int phase = 0; phase < config_.hopSize; ++phase)
            {
                float sum = 0.0f;
                for (int n = phase; n < config_.fftSize; n += config_.hopSize)
                {
                    const float w = window_[static_cast<std::size_t>(n)];
                    sum += w * w;
                }

                normalization_[static_cast<std::size_t>(phase)] =
                    sum > 1.0e-8f ? (1.0f / sum) : 1.0f;
            }
        }

        void buildBinFrequencies()
        {
            const int numBins = config_.fftSize / 2 + 1;
            if (numBins <= 0 || binFrequencies_.size() != static_cast<std::size_t>(numBins))
                return;

            const float nyquist = static_cast<float>(sampleRate_ * 0.5);
            for (int k = 0; k < numBins; ++k)
            {
                binFrequencies_[static_cast<std::size_t>(k)] = std::clamp(
                    static_cast<float>(static_cast<double>(k) * sampleRate_
                                     / static_cast<double>(config_.fftSize)),
                    1.0f,
                    nyquist);
            }
        }

        static bool weightingSettingsEqual(const ProcessorSettings& a,
                                           const ProcessorSettings& b) noexcept
        {
            if (a.wcHp != b.wcHp || a.wcLp != b.wcLp)
                return false;

            for (std::size_t i = 0; i < a.wcActive.size(); ++i)
            {
                if (a.wcActive[i] != b.wcActive[i]
                    || a.wcTypes[i] != b.wcTypes[i]
                    || a.wcFreqs[i] != b.wcFreqs[i]
                    || a.wcGainsDb[i] != b.wcGainsDb[i]
                    || a.wcQs[i] != b.wcQs[i])
                {
                    return false;
                }
            }

            return true;
        }

        void updateDerivedSettings() noexcept
        {
            detectorThresholdOffsetDb_ = 2.0f + settings_.selectivity * 14.0f;
            detectorSharpness_ = std::clamp(settings_.sharpness, 0.0f, 1.0f);
            detectorCenterGap_ = 1 + static_cast<int>(std::lround(detectorSharpness_ * 4.0f));
            detectorNormCurve_ = 0.055f + detectorSharpness_ * 0.085f;
            maxReductionDb_ = getMaxReductionDb();

            const float frameSeconds = static_cast<float>(config_.hopSize / sampleRate_);
            maskAttack_ = smoothingAmount(std::clamp(settings_.attackMs, 1.0f, 200.0f), frameSeconds);
            maskRelease_ = smoothingAmount(std::clamp(settings_.releaseMs, 10.0f, 2000.0f), frameSeconds);
            maskStereoLink_ = std::clamp(settings_.stereoLink, 0.0f, 1.0f);
        }

        void rebuildWeightingIfNeeded() noexcept
        {
            const int numBins = config_.fftSize / 2 + 1;
            if (numBins <= 0 || weighting_.size() != static_cast<std::size_t>(numBins))
                return;

            if (!weightingDirty_ && weightingSettingsEqual(settings_, cachedWeightingSettings_))
                return;

            weighting_[0] = 0.0f;
            if (numBins > 1)
                weighting_[static_cast<std::size_t>(numBins - 1)] = 0.0f;

            for (int k = 1; k < numBins - 1; ++k)
            {
                const float freq = binFrequencies_.size() == weighting_.size()
                    ? binFrequencies_[static_cast<std::size_t>(k)]
                    : std::clamp(
                        static_cast<float>(static_cast<double>(k) * sampleRate_
                                         / static_cast<double>(config_.fftSize)),
                        1.0f,
                        static_cast<float>(sampleRate_ * 0.5));
                weighting_[static_cast<std::size_t>(k)] = weightingForFrequency(freq);
            }

            cachedWeightingSettings_ = settings_;
            weightingDirty_ = false;
        }

        void processReadyFrames(SpectralChannelState& ch)
        {
            while (ch.nextFrameStart + config_.fftSize <= ch.samplesWritten)
            {
                processMonoFrame(ch, ch.nextFrameStart);
                ch.nextFrameStart += config_.hopSize;
            }
        }

        void processReadyStereoFrames(SpectralChannelState& l, SpectralChannelState& r)
        {
            while (l.nextFrameStart + config_.fftSize <= l.samplesWritten
                   && r.nextFrameStart + config_.fftSize <= r.samplesWritten)
            {
                const std::int64_t frameStart = l.nextFrameStart;
                processStereoFrame(l, r, frameStart);
                l.nextFrameStart += config_.hopSize;
                r.nextFrameStart += config_.hopSize;
            }
        }

        void forwardFrame(SpectralChannelState& ch, std::int64_t frameStart)
        {
            if (static_cast<int>(ch.fftBuffer.size()) >= config_.fftSize * 2)
            {
                std::fill(ch.fftBuffer.begin() + config_.fftSize,
                          ch.fftBuffer.end(),
                          0.0f);
            }

            if (frameStart >= 0
                && frameStart + static_cast<std::int64_t>(config_.fftSize) <= ch.samplesWritten)
            {
                std::int64_t readIndex = frameStart;
                for (int n = 0; n < config_.fftSize; ++n, ++readIndex)
                {
                    ch.fftBuffer[static_cast<std::size_t>(n)] =
                        ch.inputRing[static_cast<std::size_t>(readIndex & ch.ringMask)]
                        * window_[static_cast<std::size_t>(n)];
                }
            }
            else
            {
                for (int n = 0; n < config_.fftSize; ++n)
                {
                    ch.fftBuffer[static_cast<std::size_t>(n)] =
                        ch.readInput(frameStart + n) * window_[static_cast<std::size_t>(n)];
                }
            }

            fft_->performRealOnlyForwardTransform(ch.fftBuffer.data(), false);

            updateDetector(ch);
        }

        void processMonoFrame(SpectralChannelState& ch, std::int64_t frameStart)
        {
            forwardFrame(ch, frameStart);

            applyReductionMask(ch, nullptr);
            inverseAndOverlapAdd(ch, frameStart);
        }

        void processStereoFrame(SpectralChannelState& l, SpectralChannelState& r, std::int64_t frameStart)
        {
            forwardFrame(l, frameStart);
            forwardFrame(r, frameStart);

            applyReductionMask(l, &r);
            applyReductionMask(r, &l);
            inverseAndOverlapAdd(l, frameStart);
            inverseAndOverlapAdd(r, frameStart);
        }

        void inverseAndOverlapAdd(SpectralChannelState& ch, std::int64_t frameStart)
        {
            fft_->performRealOnlyInverseTransform(ch.fftBuffer.data());

            const std::int64_t outputStart =
                frameStart + static_cast<std::int64_t>(getLatencySamples());

            int phase = 0;
            if (ch.ringSize > 0 && outputStart >= ch.samplesEmitted)
            {
                std::int64_t writeIndex = outputStart;
                for (int n = 0; n < config_.fftSize; ++n, ++writeIndex)
                {
                    const float y = ch.fftBuffer[static_cast<std::size_t>(n)]
                                  * window_[static_cast<std::size_t>(n)]
                                  * normalization_[static_cast<std::size_t>(phase)];

                    ch.outputRing[static_cast<std::size_t>(writeIndex & ch.ringMask)] += y;
                    if (++phase == config_.hopSize)
                        phase = 0;
                }
            }
            else
            {
                for (int n = 0; n < config_.fftSize; ++n)
                {
                    const float y = ch.fftBuffer[static_cast<std::size_t>(n)]
                                  * window_[static_cast<std::size_t>(n)]
                                  * normalization_[static_cast<std::size_t>(phase)];

                    ch.addOutput(outputStart + n, y);
                    if (++phase == config_.hopSize)
                        phase = 0;
                }
            }
        }

        void updateDetector(SpectralChannelState& ch)
        {
            const int numBins = config_.fftSize / 2 + 1;
            if (numBins <= 2)
                return;

            magDb_[0] = kFloorDb;
            magDb_[static_cast<std::size_t>(numBins - 1)] = kFloorDb;

            for (int k = 1; k < numBins - 1; ++k)
            {
                const float re = ch.fftBuffer[static_cast<std::size_t>(2 * k)];
                const float im = ch.fftBuffer[static_cast<std::size_t>(2 * k + 1)];
                const float magSq = std::max(re * re + im * im, kMagnitudeFloorSq);
                magDb_[static_cast<std::size_t>(k)] = 10.0f * std::log10(magSq);
            }

            if (magDbPrefix_.size() < static_cast<std::size_t>(numBins + 1))
                return;

            buildDetectorPrefix(magDb_, magDbPrefix_, numBins);

            const float thresholdOffsetDb = detectorThresholdOffsetDb_;
            const int centerGap = detectorCenterGap_;
            const float normCurve = detectorNormCurve_;

            std::array<float, 12> topStable {};
            int activeCount = 0;

            ch.salience[0] = 0.0f;
            ch.salience[static_cast<std::size_t>(numBins - 1)] = 0.0f;
            if (ch.prevSalience.size() == ch.salience.size())
            {
                ch.prevSalience[0] = 0.0f;
                ch.prevSalience[static_cast<std::size_t>(numBins - 1)] = 0.0f;
            }

            for (int k = 1; k < numBins - 1; ++k)
            {
                const float baseline = detectorBaselineFromPrefix(
                    magDb_, magDbPrefix_, numBins, k, centerGap);

                const float excessDb = magDb_[static_cast<std::size_t>(k)]
                                     - baseline
                                     - thresholdOffsetDb;

                float s = 0.0f;
                if (excessDb > 0.0f)
                    s = 1.0f - std::exp(-excessDb * normCurve);

                if (!std::isfinite(s))
                    s = 0.0f;

                s = std::clamp(s, 0.0f, 1.0f);
                ch.salience[static_cast<std::size_t>(k)] = s;

                const float prev = ch.prevSalience.size() == ch.salience.size()
                    ? ch.prevSalience[static_cast<std::size_t>(k)]
                    : 0.0f;
                const float stable = std::sqrt(std::max(s * prev, 0.0f));

                if (s > 0.10f)
                    ++activeCount;

                if (stable > topStable.back())
                {
                    topStable.back() = stable;
                    for (int i = static_cast<int>(topStable.size()) - 1; i > 0; --i)
                    {
                        if (topStable[static_cast<std::size_t>(i)] <= topStable[static_cast<std::size_t>(i - 1)])
                            break;
                        std::swap(topStable[static_cast<std::size_t>(i)],
                                  topStable[static_cast<std::size_t>(i - 1)]);
                    }
                }
            }

            if (ch.prevSalience.size() == ch.salience.size())
                std::copy(ch.salience.begin(), ch.salience.end(), ch.prevSalience.begin());

            float topSum = 0.0f;
            int topCount = 0;
            for (float v : topStable)
            {
                if (v <= 0.0f)
                    break;
                topSum += v;
                ++topCount;
            }

            const float topAvg = topCount > 0 ? (topSum / static_cast<float>(topCount)) : 0.0f;
            const float activeBinRatio = static_cast<float>(activeCount) / static_cast<float>(numBins - 2);
            const float densityPenalty = 1.0f / (1.0f + 18.0f * std::pow(activeBinRatio, 1.15f));
            const float frameActivity = std::clamp(topAvg * densityPenalty * 1.25f, 0.0f, 1.0f);

            if (frameActivity > ch.detectorActivity)
                ch.detectorActivity += 0.35f * (frameActivity - ch.detectorActivity);
            else
                ch.detectorActivity += 0.12f * (frameActivity - ch.detectorActivity);

            if (!std::isfinite(ch.detectorActivity) || ch.detectorActivity < 1.0e-6f)
                ch.detectorActivity = 0.0f;

            ch.detectorActivity = std::clamp(ch.detectorActivity, 0.0f, 1.0f);
            blockDetectorActivity_ = std::max(blockDetectorActivity_, ch.detectorActivity);
        }

        static float smoothingAmount(float timeMs, float frameSeconds) noexcept
        {
            const float safeMs = std::max(timeMs, 0.1f);
            const float seconds = safeMs * 0.001f;
            const float a = 1.0f - std::exp(-frameSeconds / seconds);
            return std::isfinite(a) ? std::clamp(a, 0.0f, 1.0f) : 1.0f;
        }

        float salienceToReductionDb(float salience, float maxReductionDb) const noexcept
        {
            const float s = std::clamp(salience, 0.0f, 1.0f);
            if (maxReductionDb <= 0.0f || s <= 0.0f)
                return 0.0f;

            const float shaped = settings_.hardMode
                ? std::pow(s, 0.75f)
                : (s * s * (3.0f - 2.0f * s)) * 0.85f;

            return std::clamp(shaped * maxReductionDb, 0.0f, maxReductionDb);
        }

        float getMaxReductionDb() const noexcept
        {
            const float depth = std::clamp(settings_.depth, 0.0f, 1.0f);
            return depth * (settings_.hardMode ? 24.0f : 12.0f);
        }

        static float smoothStep(float x) noexcept
        {
            x = std::clamp(x, 0.0f, 1.0f);
            return x * x * (3.0f - 2.0f * x);
        }

        static float logRamp(float freq, float lo, float hi) noexcept
        {
            const float safeFreq = std::max(freq, 1.0f);
            const float safeLo = std::max(lo, 1.0f);
            const float safeHi = std::max(hi, safeLo * 1.001f);
            const float denom = std::log2(safeHi) - std::log2(safeLo);
            if (denom <= 1.0e-6f)
                return safeFreq >= safeHi ? 1.0f : 0.0f;
            return smoothStep((std::log2(safeFreq) - std::log2(safeLo)) / denom);
        }

        static float boundedExp(float x) noexcept
        {
            return std::exp(std::clamp(x, -60.0f, 60.0f));
        }

    public:
        static int detectorRadiusForBin(int binIndex) noexcept
        {
            return std::clamp(binIndex / 6 + 4, 6, 48);
        }

        static void detectorRangeForBin(int binIndex,
                                        int numBins,
                                        int& lo,
                                        int& hi) noexcept
        {
            const int radius = detectorRadiusForBin(binIndex);
            lo = std::max(1, binIndex - radius);
            hi = std::min(numBins - 2, binIndex + radius);
        }

        static void buildDetectorPrefix(const std::vector<float>& source,
                                        std::vector<float>& prefix,
                                        int numBins) noexcept
        {
            prefix[0] = 0.0f;
            for (int k = 0; k < numBins; ++k)
            {
                const std::size_t idx = static_cast<std::size_t>(k);
                prefix[idx + 1] = prefix[idx] + source[idx];
            }
        }

        static float detectorBaselineFromPrefix(const std::vector<float>& source,
                                                const std::vector<float>& prefix,
                                                int numBins,
                                                int binIndex,
                                                int centerGap) noexcept
        {
            int lo = 1;
            int hi = numBins - 2;
            detectorRangeForBin(binIndex, numBins, lo, hi);

            const std::size_t loIndex = static_cast<std::size_t>(lo);
            const std::size_t hiIndex = static_cast<std::size_t>(hi + 1);
            float localSum = prefix[hiIndex] - prefix[loIndex];
            int localCount = hi - lo + 1;

            const int gapLo = std::max(lo, binIndex - centerGap);
            const int gapHi = std::min(hi, binIndex + centerGap);
            if (gapLo <= gapHi)
            {
                const std::size_t gapLoIndex = static_cast<std::size_t>(gapLo);
                const std::size_t gapHiIndex = static_cast<std::size_t>(gapHi + 1);
                localSum -= prefix[gapHiIndex] - prefix[gapLoIndex];
                localCount -= gapHi - gapLo + 1;
            }

            return localCount > 0
                ? (localSum / static_cast<float>(localCount))
                : source[static_cast<std::size_t>(binIndex)];
        }

#if defined(XLETH_RESONANCE_SUPPRESSOR_TEST_HOOKS)
        static float detectorBaselineReferenceSlow(const std::vector<float>& source,
                                                   int numBins,
                                                   int binIndex,
                                                   int centerGap) noexcept
        {
            int lo = 1;
            int hi = numBins - 2;
            detectorRangeForBin(binIndex, numBins, lo, hi);

            float localSum = 0.0f;
            int localCount = 0;
            for (int j = lo; j <= hi; ++j)
            {
                if (std::abs(j - binIndex) <= centerGap)
                    continue;

                localSum += source[static_cast<std::size_t>(j)];
                ++localCount;
            }

            return localCount > 0
                ? (localSum / static_cast<float>(localCount))
                : source[static_cast<std::size_t>(binIndex)];
        }
#endif

    private:
        float weightingForFrequency(float freq) const noexcept
        {
            if (config_.fftSize <= 0 || sampleRate_ <= 0.0)
                return 0.0f;

            const float nyquist = static_cast<float>(sampleRate_ * 0.5);
            freq = std::clamp(freq, 1.0f, nyquist);

            const float hp = std::clamp(settings_.wcHp, 20.0f, std::max(20.0f, nyquist * 0.98f));
            const float lp = std::clamp(settings_.wcLp, hp * 1.01f, std::max(hp * 1.01f, nyquist));

            const float hpGate = logRamp(freq, hp * 0.5f, hp);
            const float lpUpper = std::max(lp * 1.001f, std::min(nyquist, lp * 2.0f));
            const float lpGate = lpUpper >= nyquist && lp >= nyquist * 0.999f
                ? 1.0f
                : (1.0f - logRamp(freq, lp, lpUpper));

            float nodeOffset = 0.0f;
            for (std::size_t i = 0; i < settings_.wcFreqs.size(); ++i)
            {
                if (!settings_.wcActive[i])
                    continue;

                const float bandFreq = std::clamp(settings_.wcFreqs[i], 20.0f, nyquist);
                const float gain = std::clamp(settings_.wcGainsDb[i], -12.0f, 12.0f);
                const float qSafe = std::clamp(settings_.wcQs[i], 0.25f, 4.0f);
                const float offsetOct = std::log2(std::max(freq, 1.0f) / std::max(bandFreq, 1.0f));
                float contribution = 0.0f;

                switch (settings_.wcTypes[i])
                {
                    case 1:
                    {
                        const float transitionK = 4.0f * qSafe;
                        const float shelf = 1.0f / (1.0f + boundedExp(transitionK * offsetOct));
                        contribution = (gain / 12.0f) * shelf;
                        break;
                    }
                    case 2:
                    {
                        const float transitionK = 4.0f * qSafe;
                        const float shelf = 1.0f / (1.0f + boundedExp(-transitionK * offsetOct));
                        contribution = (gain / 12.0f) * shelf;
                        break;
                    }
                    case 3:
                    {
                        const float effectiveGain = std::min(gain, 0.0f);
                        const float qReject = std::max(qSafe, 0.5f);
                        const float sigmaOct = 0.5f / qReject;
                        const float bell = boundedExp(-(offsetOct * offsetOct) / (2.0f * sigmaOct * sigmaOct));
                        contribution = (effectiveGain / 12.0f) * bell;
                        break;
                    }
                    case 4:
                    {
                        const float tilt = std::clamp(offsetOct / 5.0f, -1.0f, 1.0f);
                        contribution = (gain / 12.0f) * tilt;
                        break;
                    }
                    case 0:
                    default:
                    {
                        const float sigmaOct = 0.5f / qSafe;
                        const float bell = boundedExp(-(offsetOct * offsetOct) / (2.0f * sigmaOct * sigmaOct));
                        contribution = (gain / 12.0f) * bell;
                        break;
                    }
                }

                nodeOffset += std::isfinite(contribution) ? contribution : 0.0f;
            }

            const float nodeWeight = std::clamp(1.0f + nodeOffset, 0.0f, 2.5f);
            const float weight = nodeWeight * hpGate * lpGate;
            return std::isfinite(weight) ? std::clamp(weight, 0.0f, 2.5f) : 0.0f;
        }

        void applyReductionMask(SpectralChannelState& ch, const SpectralChannelState* linkedChannel)
        {
            const int numBins = config_.fftSize / 2 + 1;
            if (numBins <= 2 || ch.smoothedReductionDb.size() != ch.salience.size()
                || weighting_.size() != ch.salience.size())
                return;

            const float maxReductionDb = maxReductionDb_;
            const float attack = maskAttack_;
            const float release = maskRelease_;
            const float link = linkedChannel != nullptr ? maskStereoLink_ : 0.0f;

            std::array<float, 12> topReduction {};

            ch.smoothedReductionDb[0] = 0.0f;
            ch.smoothedReductionDb[static_cast<std::size_t>(numBins - 1)] = 0.0f;

            for (int k = 1; k < numBins - 1; ++k)
            {
                const std::size_t idx = static_cast<std::size_t>(k);
                const float weight = weighting_[idx];
                float targetDb = std::clamp(salienceToReductionDb(ch.salience[idx], maxReductionDb) * weight,
                                            0.0f, maxReductionDb);

                if (linkedChannel != nullptr && linkedChannel->salience.size() == ch.salience.size())
                {
                    const float linkedDb = std::clamp(salienceToReductionDb(linkedChannel->salience[idx], maxReductionDb) * weight,
                                                      0.0f, maxReductionDb);
                    const float commonDb = std::max(targetDb, linkedDb);
                    targetDb += link * (commonDb - targetDb);
                }

                float currentDb = ch.smoothedReductionDb[idx];
                const float amount = targetDb > currentDb ? attack : release;
                currentDb += amount * (targetDb - currentDb);

                if (!std::isfinite(currentDb) || currentDb < 1.0e-5f)
                    currentDb = 0.0f;

                currentDb = std::clamp(currentDb, 0.0f, maxReductionDb);
                ch.smoothedReductionDb[idx] = currentDb;

                const float gain = std::pow(10.0f, -currentDb / 20.0f);
                ch.fftBuffer[static_cast<std::size_t>(2 * k)] *= gain;
                ch.fftBuffer[static_cast<std::size_t>(2 * k + 1)] *= gain;

                if (currentDb > topReduction.back())
                {
                    topReduction.back() = currentDb;
                    for (int i = static_cast<int>(topReduction.size()) - 1; i > 0; --i)
                    {
                        if (topReduction[static_cast<std::size_t>(i)] <= topReduction[static_cast<std::size_t>(i - 1)])
                            break;
                        std::swap(topReduction[static_cast<std::size_t>(i)],
                                  topReduction[static_cast<std::size_t>(i - 1)]);
                    }
                }
            }

            float topSum = 0.0f;
            int topCount = 0;
            for (float v : topReduction)
            {
                if (v <= 0.0f)
                    break;
                topSum += v;
                ++topCount;
            }

            const float topAvgDb = topCount > 0 ? (topSum / static_cast<float>(topCount)) : 0.0f;
            ch.reductionActivity = maxReductionDb > 1.0e-5f
                ? std::clamp(topAvgDb / 24.0f, 0.0f, 1.0f)
                : 0.0f;

            if (!std::isfinite(ch.reductionActivity))
                ch.reductionActivity = 0.0f;

            blockReductionActivity_ = std::max(blockReductionActivity_, ch.reductionActivity);

            emitResonanceViz(ch);
        }

        static int resonanceBucketForBin(int binIndex, int fftSize, double sampleRate) noexcept
        {
            if (binIndex <= 0 || fftSize <= 0 || sampleRate <= 0.0)
                return 0;

            const float nyquist = static_cast<float>(sampleRate * 0.5);
            const float minFreq = std::max(20.0f, static_cast<float>(sampleRate / static_cast<double>(fftSize)));
            const float freq = std::clamp(
                static_cast<float>(static_cast<double>(binIndex) * sampleRate / static_cast<double>(fftSize)),
                minFreq, nyquist);

            const float denom = std::max(std::log2(std::max(nyquist, minFreq * 1.001f) / minFreq), 1.0e-6f);
            const float norm = std::clamp(std::log2(freq / minFreq) / denom, 0.0f, 1.0f);
            return std::clamp(static_cast<int>(std::lround(norm * static_cast<float>(xleth::viz::kResonanceVizBucketCount - 1))),
                              0,
                              static_cast<int>(xleth::viz::kResonanceVizBucketCount - 1));
        }

        void emitResonanceViz(const SpectralChannelState& ch) noexcept
        {
            auto* collector = vizCollector_;
            if (collector == nullptr)
                return;

            const int numBins = config_.fftSize / 2 + 1;
            if (numBins <= 2 || magDb_.size() < static_cast<std::size_t>(numBins)
                || weighting_.size() < static_cast<std::size_t>(numBins)
                || ch.smoothedReductionDb.size() < static_cast<std::size_t>(numBins))
                return;

            xleth::viz::ResonanceBucket bucket {};
            bucket.hdr.sampleClock = vizSampleClock_;
            bucket.hdr.bucketSamples = static_cast<std::uint32_t>(config_.hopSize);
            bucket.hdr.flags = 0;
            bucket.sampleRate = static_cast<float>(sampleRate_);
            bucket.fftSize = static_cast<float>(config_.fftSize);
            bucket.qualityIndex = static_cast<float>(config_.qualityIndex);
            bucket.stereoMode = settings_.stereoMode;
            bucket.activity = ch.reductionActivity;
            bucket.bucketCount = static_cast<float>(xleth::viz::kResonanceVizBucketCount);
            bucket.maxReductionDb = maxReductionDb_;

            std::array<float, xleth::viz::kResonanceVizBucketCount> weightingSum {};
            std::array<std::uint32_t, xleth::viz::kResonanceVizBucketCount> weightingCount {};

            for (int k = 1; k < numBins - 1; ++k)
            {
                const int b = resonanceBucketForBin(k, config_.fftSize, sampleRate_);
                const std::size_t bi = static_cast<std::size_t>(b);
                const std::size_t ki = static_cast<std::size_t>(k);

                const float spectrumNorm =
                    std::clamp((magDb_[ki] + 120.0f) * (1.0f / 120.0f), 0.0f, 1.0f);
                const float reductionNorm =
                    std::clamp(ch.smoothedReductionDb[ki] * (1.0f / 24.0f), 0.0f, 1.0f);
                const float weight = std::clamp(weighting_[ki], 0.0f, 2.5f);

                bucket.spectrum[bi] = std::max(bucket.spectrum[bi], spectrumNorm);
                bucket.reduction[bi] = std::max(bucket.reduction[bi], reductionNorm);
                weightingSum[bi] += weight;
                ++weightingCount[bi];
            }

            for (std::size_t i = 0; i < xleth::viz::kResonanceVizBucketCount; ++i)
            {
                if (weightingCount[i] > 0)
                    bucket.weighting[i] = weightingSum[i] / static_cast<float>(weightingCount[i]);
            }

            collector->push(bucket);
            vizSampleClock_ += static_cast<std::uint64_t>(std::max(1, config_.hopSize));
        }

        WolaConfig config_;
        static constexpr float kFloorDb = -240.0f;
        static constexpr float kMagnitudeFloorSq = 1.0e-24f;
        int ringSize_ = 0;
        double sampleRate_ = 44100.0;
        bool prepared_ = false;
        ProcessorSettings settings_;
        float blockDetectorActivity_ = 0.0f;
        float meterDetectorActivity_ = 0.0f;
        float blockReductionActivity_ = 0.0f;
        float meterReductionActivity_ = 0.0f;
        xleth::viz::DynamicsVizCollector<xleth::viz::ResonanceBucket>* vizCollector_ = nullptr;
        std::uint64_t vizSampleClock_ = 0;
        bool weightingDirty_ = true;
        ProcessorSettings cachedWeightingSettings_;
        float detectorThresholdOffsetDb_ = 9.0f;
        float detectorSharpness_ = 0.5f;
        int detectorCenterGap_ = 3;
        float detectorNormCurve_ = 0.0975f;
        float maxReductionDb_ = 6.0f;
        float maskAttack_ = 1.0f;
        float maskRelease_ = 1.0f;
        float maskStereoLink_ = 1.0f;
        std::unique_ptr<juce::dsp::FFT> fft_;
        std::vector<float> window_;
        std::vector<float> normalization_;
        std::vector<float> magDb_;
        std::vector<float> magDbPrefix_;
        std::vector<float> weighting_;
        std::vector<float> binFrequencies_;
        std::array<SpectralChannelState, 2> channels_;
    };

#if defined(XLETH_RESONANCE_SUPPRESSOR_TEST_HOOKS)
public:
    struct DetectorBaselineTestResult
    {
        std::vector<float> reference;
        std::vector<float> prefix;
    };

    static DetectorBaselineTestResult computeDetectorBaselinesForTest(
        const std::vector<float>& source,
        int centerGap)
    {
        DetectorBaselineTestResult result;
        const int numBins = static_cast<int>(source.size());
        result.reference.assign(source.size(), 0.0f);
        result.prefix.assign(source.size(), 0.0f);
        if (numBins <= 2)
            return result;

        std::vector<float> prefix(static_cast<std::size_t>(numBins + 1), 0.0f);
        WolaProcessor::buildDetectorPrefix(source, prefix, numBins);

        for (int k = 1; k < numBins - 1; ++k)
        {
            const std::size_t idx = static_cast<std::size_t>(k);
            result.reference[idx] =
                WolaProcessor::detectorBaselineReferenceSlow(source, numBins, k, centerGap);
            result.prefix[idx] =
                WolaProcessor::detectorBaselineFromPrefix(source, prefix, numBins, k, centerGap);
        }

        return result;
    }

private:
#endif

    class LowLatencyProcessor
    {
    public:
        static constexpr int kNumBands = 8;

        void prepare(int maxBlockSize, double sampleRate)
        {
            juce::ignoreUnused(maxBlockSize);
            sampleRate_ = sampleRate > 0.0 ? sampleRate : 44100.0;
            prepared_ = true;
            reset();
        }

        void release()
        {
            prepared_ = false;
            sampleRate_ = 44100.0;
            blockReductionActivity_ = 0.0f;
            meterReductionActivity_ = 0.0f;
            for (auto& channel : channels_)
            {
                for (auto& band : channel)
                {
                    band.detectorNarrow.reset();
                    band.detectorWide.reset();
                    band.wetFilter.reset();
                    band.narrowEnv = 0.0f;
                    band.wideEnv = 0.0f;
                    band.reductionDb = 0.0f;
                }
            }
        }

        void reset()
        {
            blockReductionActivity_ = 0.0f;
            meterReductionActivity_ = 0.0f;
            for (auto& channel : channels_)
            {
                for (auto& band : channel)
                {
                    band.detectorNarrow.reset();
                    band.detectorWide.reset();
                    band.wetFilter.reset();
                    band.narrowEnv = 0.0f;
                    band.wideEnv = 0.0f;
                    band.reductionDb = 0.0f;
                }
            }
        }

        bool isPrepared() const noexcept { return prepared_; }

        void beginBlock(const ProcessorSettings& settings) noexcept
        {
            settings_ = settings;
            blockReductionActivity_ = 0.0f;
            updateBandLayout();
        }

        float getGainReductionActivityForMeter() noexcept
        {
            if (blockReductionActivity_ > meterReductionActivity_)
                meterReductionActivity_ = blockReductionActivity_;
            else
                meterReductionActivity_ *= 0.90f;

            if (!std::isfinite(meterReductionActivity_) || meterReductionActivity_ < 1.0e-6f)
                meterReductionActivity_ = 0.0f;

            return std::clamp(meterReductionActivity_, 0.0f, 1.0f);
        }

        void processMono(float* data, int numSamples)
        {
            if (!prepared_ || data == nullptr || numSamples <= 0)
                return;

            std::array<float, kNumBands> targets {};
            analyzeChannel(0, data, numSamples, targets);
            smoothTargets(0, targets, numSamples);
            processChannel(0, data, numSamples);
        }

        void processStereo(float* left, float* right, int numSamples)
        {
            if (!prepared_ || left == nullptr || right == nullptr || numSamples <= 0)
                return;

            std::array<float, kNumBands> leftTargets {};
            std::array<float, kNumBands> rightTargets {};

            analyzeChannel(0, left, numSamples, leftTargets);
            analyzeChannel(1, right, numSamples, rightTargets);
            applyStereoLink(leftTargets, rightTargets);
            smoothTargets(0, leftTargets, numSamples);
            smoothTargets(1, rightTargets, numSamples);
            processChannel(0, left, numSamples);
            processChannel(1, right, numSamples);
        }

    private:
        struct BandState
        {
            juce::dsp::IIR::Filter<float> detectorNarrow;
            juce::dsp::IIR::Filter<float> detectorWide;
            juce::dsp::IIR::Filter<float> wetFilter;
            float narrowEnv = 0.0f;
            float wideEnv = 0.0f;
            float reductionDb = 0.0f;
        };

        static float smoothStep(float x) noexcept
        {
            x = std::clamp(x, 0.0f, 1.0f);
            return x * x * (3.0f - 2.0f * x);
        }

        static float boundedExp(float x) noexcept
        {
            return std::exp(std::clamp(x, -60.0f, 60.0f));
        }

        static float logRamp(float freq, float lo, float hi) noexcept
        {
            const float safeFreq = std::max(freq, 1.0f);
            const float safeLo = std::max(lo, 1.0f);
            const float safeHi = std::max(hi, safeLo * 1.001f);
            const float denom = std::log2(safeHi) - std::log2(safeLo);
            if (denom <= 1.0e-6f)
                return safeFreq >= safeHi ? 1.0f : 0.0f;
            return smoothStep((std::log2(safeFreq) - std::log2(safeLo)) / denom);
        }

        float computeWeightingForFrequency(float freq) const noexcept
        {
            if (sampleRate_ <= 0.0)
                return 0.0f;

            const float nyquist = static_cast<float>(sampleRate_ * 0.5);
            const float clampedFreq = std::clamp(freq, 1.0f, nyquist);
            const float hp = std::clamp(settings_.wcHp, 20.0f, std::max(20.0f, nyquist * 0.98f));
            const float lp = std::clamp(settings_.wcLp, hp * 1.01f, std::max(hp * 1.01f, nyquist));

            const float hpGate = logRamp(clampedFreq, hp * 0.5f, hp);
            const float lpUpper = std::max(lp * 1.001f, std::min(nyquist, lp * 2.0f));
            const float lpGate = lpUpper >= nyquist && lp >= nyquist * 0.999f
                ? 1.0f
                : (1.0f - logRamp(clampedFreq, lp, lpUpper));

            float nodeOffset = 0.0f;
            for (std::size_t i = 0; i < settings_.wcFreqs.size(); ++i)
            {
                if (!settings_.wcActive[i])
                    continue;

                const float bandFreq = std::clamp(settings_.wcFreqs[i], 20.0f, nyquist);
                const float gain = std::clamp(settings_.wcGainsDb[i], -12.0f, 12.0f);
                const float qSafe = std::clamp(settings_.wcQs[i], 0.25f, 4.0f);
                const float offsetOct = std::log2(std::max(clampedFreq, 1.0f) / std::max(bandFreq, 1.0f));
                float contribution = 0.0f;

                switch (settings_.wcTypes[i])
                {
                    case 1:
                    {
                        const float transitionK = 4.0f * qSafe;
                        const float shelf = 1.0f / (1.0f + boundedExp(transitionK * offsetOct));
                        contribution = (gain / 12.0f) * shelf;
                        break;
                    }
                    case 2:
                    {
                        const float transitionK = 4.0f * qSafe;
                        const float shelf = 1.0f / (1.0f + boundedExp(-transitionK * offsetOct));
                        contribution = (gain / 12.0f) * shelf;
                        break;
                    }
                    case 3:
                    {
                        const float effectiveGain = std::min(gain, 0.0f);
                        const float qReject = std::max(qSafe, 0.5f);
                        const float sigmaOct = 0.5f / qReject;
                        const float bell = boundedExp(-(offsetOct * offsetOct) / (2.0f * sigmaOct * sigmaOct));
                        contribution = (effectiveGain / 12.0f) * bell;
                        break;
                    }
                    case 4:
                    {
                        const float tilt = std::clamp(offsetOct / 5.0f, -1.0f, 1.0f);
                        contribution = (gain / 12.0f) * tilt;
                        break;
                    }
                    case 0:
                    default:
                    {
                        const float sigmaOct = 0.5f / qSafe;
                        const float bell = boundedExp(-(offsetOct * offsetOct) / (2.0f * sigmaOct * sigmaOct));
                        contribution = (gain / 12.0f) * bell;
                        break;
                    }
                }

                nodeOffset += std::isfinite(contribution) ? contribution : 0.0f;
            }

            const float nodeWeight = std::clamp(1.0f + nodeOffset, 0.0f, 2.5f);
            const float weight = nodeWeight * hpGate * lpGate;
            return std::isfinite(weight) ? std::clamp(weight, 0.0f, 2.5f) : 0.0f;
        }

        float maxReductionDb() const noexcept
        {
            const float depth = std::clamp(settings_.depth, 0.0f, 1.0f);
            return depth * (settings_.hardMode ? 24.0f : 12.0f);
        }

        static float timeCoeff(double sampleRate, float ms) noexcept
        {
            const float safeMs = std::max(ms, 0.1f);
            const double tau = static_cast<double>(safeMs) * 0.001;
            const double coeff = std::exp(-1.0 / std::max(tau * sampleRate, 1.0));
            return std::isfinite(coeff) ? static_cast<float>(std::clamp(coeff, 0.0, 0.999999)) : 0.0f;
        }

        void updateBandLayout() noexcept
        {
            const float nyquist = static_cast<float>(sampleRate_ * 0.5);
            float low = std::clamp(settings_.wcHp, 40.0f, std::max(40.0f, nyquist * 0.45f));
            float high = std::clamp(settings_.wcLp, low * 1.5f, std::max(low * 1.5f, nyquist * 0.98f));
            if (high <= low * 1.05f)
                high = std::min(nyquist * 0.98f, low * 2.0f);

            for (int i = 0; i < kNumBands; ++i)
            {
                const float t = (static_cast<float>(i) + 0.5f) / static_cast<float>(kNumBands);
                const float ratio = std::pow(high / low, t);
                bandFreqs_[static_cast<std::size_t>(i)] = std::clamp(low * ratio, 30.0f, high);
                bandWeights_[static_cast<std::size_t>(i)] =
                    computeWeightingForFrequency(bandFreqs_[static_cast<std::size_t>(i)]);
            }
        }

        void configureDetectorFilters(int channel) noexcept
        {
            const float sharpness = std::clamp(settings_.sharpness, 0.0f, 1.0f);
            const float detectorQ = std::clamp(0.7f + sharpness * 7.0f, 0.5f, 8.0f);
            const float contextQ = std::max(0.35f, detectorQ * 0.35f);

            for (int i = 0; i < kNumBands; ++i)
            {
                auto& band = channels_[static_cast<std::size_t>(channel)][static_cast<std::size_t>(i)];
                const float freq = bandFreqs_[static_cast<std::size_t>(i)];
                band.detectorNarrow.coefficients =
                    juce::dsp::IIR::Coefficients<float>::makeBandPass(sampleRate_, freq, detectorQ);
                band.detectorWide.coefficients =
                    juce::dsp::IIR::Coefficients<float>::makeBandPass(sampleRate_, freq, contextQ);
            }
        }

        void analyzeChannel(int channel,
                            const float* data,
                            int numSamples,
                            std::array<float, kNumBands>& targets) noexcept
        {
            configureDetectorFilters(channel);

            const float attackCoeff = timeCoeff(sampleRate_, std::clamp(settings_.attackMs, 1.0f, 200.0f));
            const float releaseCoeff = timeCoeff(sampleRate_, std::clamp(settings_.releaseMs, 10.0f, 2000.0f));
            const float maxDb = maxReductionDb();
            const float thresholdDb = 0.35f + std::clamp(settings_.selectivity, 0.0f, 1.0f) * 2.0f;
            const float sharpness = std::clamp(settings_.sharpness, 0.0f, 1.0f);

            for (int s = 0; s < numSamples; ++s)
            {
                const float x = std::isfinite(data[s]) ? data[s] : 0.0f;
                for (int i = 0; i < kNumBands; ++i)
                {
                    auto& band = channels_[static_cast<std::size_t>(channel)][static_cast<std::size_t>(i)];
                    const float narrow = band.detectorNarrow.processSample(x);
                    const float wide = band.detectorWide.processSample(x);
                    const float narrowAbs = std::abs(narrow);
                    const float wideAbs = std::abs(wide);

                    band.narrowEnv = narrowAbs > band.narrowEnv
                        ? narrowAbs + attackCoeff * (band.narrowEnv - narrowAbs)
                        : narrowAbs + releaseCoeff * (band.narrowEnv - narrowAbs);
                    band.wideEnv = wideAbs > band.wideEnv
                        ? wideAbs + attackCoeff * (band.wideEnv - wideAbs)
                        : wideAbs + releaseCoeff * (band.wideEnv - wideAbs);
                }
            }

            for (int i = 0; i < kNumBands; ++i)
            {
                auto& band = channels_[static_cast<std::size_t>(channel)][static_cast<std::size_t>(i)];
                float neighborSum = 0.0f;
                float neighborWeight = 0.0f;
                if (i > 0)
                {
                    neighborSum += channels_[static_cast<std::size_t>(channel)][static_cast<std::size_t>(i - 1)].narrowEnv;
                    neighborWeight += 1.0f;
                }
                if (i + 1 < kNumBands)
                {
                    neighborSum += channels_[static_cast<std::size_t>(channel)][static_cast<std::size_t>(i + 1)].narrowEnv;
                    neighborWeight += 1.0f;
                }
                if (i > 1)
                {
                    neighborSum += 0.5f * channels_[static_cast<std::size_t>(channel)][static_cast<std::size_t>(i - 2)].narrowEnv;
                    neighborWeight += 0.5f;
                }
                if (i + 2 < kNumBands)
                {
                    neighborSum += 0.5f * channels_[static_cast<std::size_t>(channel)][static_cast<std::size_t>(i + 2)].narrowEnv;
                    neighborWeight += 0.5f;
                }

                const float neighborBase = neighborWeight > 0.0f
                    ? (neighborSum / neighborWeight)
                    : band.narrowEnv;
                const float spectralBase = std::max(neighborBase, band.wideEnv * 0.2f);
                const float base = std::max(spectralBase, 1.0e-5f);
                const float bandDb = juce::Decibels::gainToDecibels(std::max(band.narrowEnv, 1.0e-6f), -120.0f);
                const float baseDb = juce::Decibels::gainToDecibels(base, -120.0f);
                const float excessDb = std::max(0.0f, bandDb - baseDb - thresholdDb);
                float salience = 1.0f - std::exp(-excessDb * (0.35f + sharpness * 0.35f));
                if (!std::isfinite(salience))
                    salience = 0.0f;

                salience = std::clamp(salience, 0.0f, 1.0f);
                salience = settings_.hardMode
                    ? std::pow(salience, 0.75f)
                    : (smoothStep(salience) * 0.85f);

                const float weighted = salience * std::clamp(bandWeights_[static_cast<std::size_t>(i)] * 1.2f, 0.0f, 2.5f);
                targets[static_cast<std::size_t>(i)] = std::clamp(weighted * maxDb, 0.0f, maxDb);
            }
        }

        void applyStereoLink(std::array<float, kNumBands>& leftTargets,
                             std::array<float, kNumBands>& rightTargets) const noexcept
        {
            const float link = std::clamp(settings_.stereoLink, 0.0f, 1.0f);
            if (link <= 0.0f)
                return;

            for (int i = 0; i < kNumBands; ++i)
            {
                const float common = std::max(leftTargets[static_cast<std::size_t>(i)],
                                              rightTargets[static_cast<std::size_t>(i)]);
                leftTargets[static_cast<std::size_t>(i)] +=
                    link * (common - leftTargets[static_cast<std::size_t>(i)]);
                rightTargets[static_cast<std::size_t>(i)] +=
                    link * (common - rightTargets[static_cast<std::size_t>(i)]);
            }
        }

        void smoothTargets(int channel,
                           const std::array<float, kNumBands>& targets,
                           int numSamples) noexcept
        {
            const float blockSeconds = static_cast<float>(numSamples / sampleRate_);
            const float attack = 1.0f - std::exp(-blockSeconds / (std::max(settings_.attackMs, 1.0f) * 0.001f));
            const float release = 1.0f - std::exp(-blockSeconds / (std::max(settings_.releaseMs, 10.0f) * 0.001f));
            const float maxDb = maxReductionDb();
            std::array<float, 8> topReduction {};

            for (int i = 0; i < kNumBands; ++i)
            {
                auto& band = channels_[static_cast<std::size_t>(channel)][static_cast<std::size_t>(i)];
                const float targetDb = std::clamp(targets[static_cast<std::size_t>(i)], 0.0f, maxDb);
                const float amount = targetDb > band.reductionDb ? attack : release;
                band.reductionDb += amount * (targetDb - band.reductionDb);

                if (!std::isfinite(band.reductionDb) || band.reductionDb < 1.0e-5f)
                    band.reductionDb = 0.0f;

                band.reductionDb = std::clamp(band.reductionDb, 0.0f, maxDb);

                if (band.reductionDb > topReduction.back())
                {
                    topReduction.back() = band.reductionDb;
                    for (int j = static_cast<int>(topReduction.size()) - 1; j > 0; --j)
                    {
                        if (topReduction[static_cast<std::size_t>(j)] <= topReduction[static_cast<std::size_t>(j - 1)])
                            break;
                        std::swap(topReduction[static_cast<std::size_t>(j)],
                                  topReduction[static_cast<std::size_t>(j - 1)]);
                    }
                }
            }

            float topSum = 0.0f;
            int topCount = 0;
            for (float v : topReduction)
            {
                if (v <= 0.0f)
                    break;
                topSum += v;
                ++topCount;
            }

            const float topAvgDb = topCount > 0 ? (topSum / static_cast<float>(topCount)) : 0.0f;
            const float activity = maxDb > 1.0e-5f
                ? std::clamp(topAvgDb / 24.0f, 0.0f, 1.0f)
                : 0.0f;
            blockReductionActivity_ = std::max(blockReductionActivity_, activity);
        }

        void processChannel(int channel, float* data, int numSamples) noexcept
        {
            const float sharpness = std::clamp(settings_.sharpness, 0.0f, 1.0f);
            const float filterQ = std::clamp(0.8f + sharpness * 10.0f, 0.6f, 12.0f);

            for (int i = 0; i < kNumBands; ++i)
            {
                auto& band = channels_[static_cast<std::size_t>(channel)][static_cast<std::size_t>(i)];
                const float cutGain = juce::Decibels::decibelsToGain(-band.reductionDb);
                band.wetFilter.coefficients =
                    juce::dsp::IIR::Coefficients<float>::makePeakFilter(
                        sampleRate_, bandFreqs_[static_cast<std::size_t>(i)], filterQ, cutGain);
            }

            for (int s = 0; s < numSamples; ++s)
            {
                float y = std::isfinite(data[s]) ? data[s] : 0.0f;
                for (int i = 0; i < kNumBands; ++i)
                    y = channels_[static_cast<std::size_t>(channel)][static_cast<std::size_t>(i)].wetFilter.processSample(y);
                data[s] = std::isfinite(y) ? y : 0.0f;
            }
        }

        double sampleRate_ = 44100.0;
        bool prepared_ = false;
        ProcessorSettings settings_;
        float blockReductionActivity_ = 0.0f;
        float meterReductionActivity_ = 0.0f;
        std::array<float, kNumBands> bandFreqs_ {};
        std::array<float, kNumBands> bandWeights_ {};
        std::array<std::array<BandState, kNumBands>, 2> channels_ {};
    };

    float readPercentParam(const char* paramId, float fallback) const noexcept
    {
        if (auto* p = apvts_.getRawParameterValue(paramId))
            return std::clamp(p->load(std::memory_order_relaxed), 0.0f, 100.0f) * 0.01f;
        return std::clamp(fallback, 0.0f, 100.0f) * 0.01f;
    }

    int readQualityForPrepare() const noexcept
    {
        if (auto* q = apvts_.getRawParameterValue("quality"))
            return std::clamp(static_cast<int>(std::lround(q->load(std::memory_order_relaxed))), 0, 2);
        return 1;
    }

    float readFloatParam(const char* paramId, float fallback) const noexcept
    {
        if (auto* p = apvts_.getRawParameterValue(paramId))
            return p->load(std::memory_order_relaxed);
        return fallback;
    }

    bool readBoolParam(const char* paramId, bool fallback) const noexcept
    {
        if (auto* p = apvts_.getRawParameterValue(paramId))
            return p->load(std::memory_order_relaxed) >= 0.5f;
        return fallback;
    }

    int readChoiceParam(const char* paramId, int fallback) const noexcept
    {
        if (auto* p = apvts_.getRawParameterValue(paramId))
            return static_cast<int>(std::lround(p->load(std::memory_order_relaxed)));
        return fallback;
    }

    ProcessorSettings readProcessorSettings() const
    {
        ProcessorSettings settings;
        settings.depth = readPercentParam("depth", 50.0f);
        settings.sharpness = readPercentParam("sharpness", 50.0f);
        settings.selectivity = readPercentParam("selectivity", 50.0f);
        settings.attackMs = readFloatParam("attack", 15.0f);
        settings.releaseMs = readFloatParam("release", 200.0f);
        settings.stereoLink = readPercentParam("stereo_link", 100.0f);
        settings.hardMode = readChoiceParam("mode", 0) == 1;
        settings.wcHp = readFloatParam("wc_hp", 80.0f);
        settings.wcLp = readFloatParam("wc_lp", 16000.0f);
        settings.wcActive = {
            readBoolParam("wc_b1_active", true),
            readBoolParam("wc_b2_active", true),
            readBoolParam("wc_b3_active", true),
            readBoolParam("wc_b4_active", true),
            readBoolParam("wc_b5_active", false),
            readBoolParam("wc_b6_active", false),
            readBoolParam("wc_b7_active", false),
            readBoolParam("wc_b8_active", false)
        };
        settings.wcTypes = {
            std::clamp(readChoiceParam("wc_b1_type", 0), 0, 4),
            std::clamp(readChoiceParam("wc_b2_type", 0), 0, 4),
            std::clamp(readChoiceParam("wc_b3_type", 0), 0, 4),
            std::clamp(readChoiceParam("wc_b4_type", 0), 0, 4),
            std::clamp(readChoiceParam("wc_b5_type", 0), 0, 4),
            std::clamp(readChoiceParam("wc_b6_type", 0), 0, 4),
            std::clamp(readChoiceParam("wc_b7_type", 0), 0, 4),
            std::clamp(readChoiceParam("wc_b8_type", 0), 0, 4)
        };
        settings.wcFreqs = {
            readFloatParam("wc_b1_freq",  250.0f),
            readFloatParam("wc_b2_freq",  800.0f),
            readFloatParam("wc_b3_freq",  2500.0f),
            readFloatParam("wc_b4_freq",  8000.0f),
            readFloatParam("wc_b5_freq",  500.0f),
            readFloatParam("wc_b6_freq",  1500.0f),
            readFloatParam("wc_b7_freq",  4000.0f),
            readFloatParam("wc_b8_freq",  10000.0f)
        };
        settings.wcGainsDb = {
            readFloatParam("wc_b1_gain", 0.0f),
            readFloatParam("wc_b2_gain", 0.0f),
            readFloatParam("wc_b3_gain", 0.0f),
            readFloatParam("wc_b4_gain", 0.0f),
            readFloatParam("wc_b5_gain", 0.0f),
            readFloatParam("wc_b6_gain", 0.0f),
            readFloatParam("wc_b7_gain", 0.0f),
            readFloatParam("wc_b8_gain", 0.0f)
        };
        settings.wcQs = {
            readFloatParam("wc_b1_q", 1.0f),
            readFloatParam("wc_b2_q", 1.0f),
            readFloatParam("wc_b3_q", 1.0f),
            readFloatParam("wc_b4_q", 1.0f),
            readFloatParam("wc_b5_q", 1.0f),
            readFloatParam("wc_b6_q", 1.0f),
            readFloatParam("wc_b7_q", 1.0f),
            readFloatParam("wc_b8_q", 1.0f)
        };
        settings.stereoMode = static_cast<float>(std::clamp(readChoiceParam("stereo_mode", 0), 0, 2));
        return settings;
    }

    void processHighQualityMidMode(juce::AudioBuffer<float>& buffer, int numSamples)
    {
        if (static_cast<int>(msComponent_.size()) < numSamples)
            return;

        const float* inL = buffer.getReadPointer(0);
        const float* inR = buffer.getReadPointer(1);
        for (int s = 0; s < numSamples; ++s)
            msComponent_[static_cast<std::size_t>(s)] = 0.5f * (inL[s] + inR[s]);

        wola_.processMono(msComponent_.data(), numSamples);

        float* outL = buffer.getWritePointer(0);
        float* outR = buffer.getWritePointer(1);
        const float* dryL = delayedDry_.getReadPointer(0);
        const float* dryR = delayedDry_.getReadPointer(1);

        for (int s = 0; s < numSamples; ++s)
        {
            const float mid = msComponent_[static_cast<std::size_t>(s)];
            const float side = 0.5f * (dryL[s] - dryR[s]);
            outL[s] = mid + side;
            outR[s] = mid - side;
        }
    }

    void processHighQualitySideMode(juce::AudioBuffer<float>& buffer, int numSamples)
    {
        if (static_cast<int>(msComponent_.size()) < numSamples)
            return;

        const float* inL = buffer.getReadPointer(0);
        const float* inR = buffer.getReadPointer(1);
        for (int s = 0; s < numSamples; ++s)
            msComponent_[static_cast<std::size_t>(s)] = 0.5f * (inL[s] - inR[s]);

        wola_.processMono(msComponent_.data(), numSamples);

        float* outL = buffer.getWritePointer(0);
        float* outR = buffer.getWritePointer(1);
        const float* dryL = delayedDry_.getReadPointer(0);
        const float* dryR = delayedDry_.getReadPointer(1);

        for (int s = 0; s < numSamples; ++s)
        {
            const float mid = 0.5f * (dryL[s] + dryR[s]);
            const float side = msComponent_[static_cast<std::size_t>(s)];
            outL[s] = mid + side;
            outR[s] = mid - side;
        }
    }

    void processHighQualityMonoSideMode(juce::AudioBuffer<float>& buffer, int numSamples)
    {
        if (static_cast<int>(msComponent_.size()) < numSamples)
            return;

        std::fill(msComponent_.begin(), msComponent_.begin() + numSamples, 0.0f);
        wola_.processMono(msComponent_.data(), numSamples);

        float* out = buffer.getWritePointer(0);
        const float* dry = delayedDry_.getReadPointer(0);
        for (int s = 0; s < numSamples; ++s)
            out[s] = dry[s];
    }

    void processLowLatencyMidMode(juce::AudioBuffer<float>& buffer, int numSamples)
    {
        if (static_cast<int>(msComponent_.size()) < numSamples)
            return;

        const float* inL = buffer.getReadPointer(0);
        const float* inR = buffer.getReadPointer(1);
        for (int s = 0; s < numSamples; ++s)
            msComponent_[static_cast<std::size_t>(s)] = 0.5f * (inL[s] + inR[s]);

        lowLatency_.processMono(msComponent_.data(), numSamples);

        float* outL = buffer.getWritePointer(0);
        float* outR = buffer.getWritePointer(1);
        const float* dryL = liveDry_.getReadPointer(0);
        const float* dryR = liveDry_.getReadPointer(1);

        for (int s = 0; s < numSamples; ++s)
        {
            const float mid = msComponent_[static_cast<std::size_t>(s)];
            const float side = 0.5f * (dryL[s] - dryR[s]);
            outL[s] = mid + side;
            outR[s] = mid - side;
        }
    }

    void processLowLatencySideMode(juce::AudioBuffer<float>& buffer, int numSamples)
    {
        if (static_cast<int>(msComponent_.size()) < numSamples)
            return;

        const float* inL = buffer.getReadPointer(0);
        const float* inR = buffer.getReadPointer(1);
        for (int s = 0; s < numSamples; ++s)
            msComponent_[static_cast<std::size_t>(s)] = 0.5f * (inL[s] - inR[s]);

        lowLatency_.processMono(msComponent_.data(), numSamples);

        float* outL = buffer.getWritePointer(0);
        float* outR = buffer.getWritePointer(1);
        const float* dryL = liveDry_.getReadPointer(0);
        const float* dryR = liveDry_.getReadPointer(1);
        for (int s = 0; s < numSamples; ++s)
        {
            const float mid = 0.5f * (dryL[s] + dryR[s]);
            const float side = msComponent_[static_cast<std::size_t>(s)];
            outL[s] = mid + side;
            outR[s] = mid - side;
        }
    }

    void processLowLatencyMonoSideMode(juce::AudioBuffer<float>& buffer, int numSamples)
    {
        if (static_cast<int>(msComponent_.size()) < numSamples)
            return;

        std::fill(msComponent_.begin(), msComponent_.begin() + numSamples, 0.0f);
        lowLatency_.processMono(msComponent_.data(), numSamples);

        float* out = buffer.getWritePointer(0);
        const float* dry = liveDry_.getReadPointer(0);
        for (int s = 0; s < numSamples; ++s)
            out[s] = dry[s];
    }

    void applyOutputStage(juce::AudioBuffer<float>& buffer,
                          const juce::AudioBuffer<float>& drySource,
                          int processedChannels,
                          int numSamples)
    {
        if (processedChannels <= 0)
            return;

        const bool deltaTarget = readBoolParam("delta", false);
        const float deltaTargetValue = deltaTarget ? 1.0f : 0.0f;
        float* out0 = buffer.getWritePointer(0);
        const float* dry0 = drySource.getReadPointer(0);
        float* out1 = processedChannels > 1 ? buffer.getWritePointer(1) : nullptr;
        const float* dry1 = processedChannels > 1 ? drySource.getReadPointer(1) : nullptr;
        bool trimGainValid = false;
        float lastTrimDb = 0.0f;
        float trimGain = 1.0f;

        for (int s = 0; s < numSamples; ++s)
        {
            if (deltaMix_ < deltaTargetValue)
                deltaMix_ = std::min(deltaMix_ + deltaRampPerSample_, deltaTargetValue);
            else if (deltaMix_ > deltaTargetValue)
                deltaMix_ = std::max(deltaMix_ - deltaRampPerSample_, deltaTargetValue);

            const float mix = std::clamp(getNextSmoothedValue(mixParamId_) * 0.01f, 0.0f, 1.0f);
            const float trimDb = std::clamp(getNextSmoothedValue(trimParamId_), -24.0f, 24.0f);
            if (!trimGainValid || trimDb != lastTrimDb)
            {
                trimGain = std::pow(10.0f, trimDb / 20.0f);
                lastTrimDb = trimDb;
                trimGainValid = true;
            }

            const float wet0 = out0[s];
            const float normal0 = dry0[s] + mix * (wet0 - dry0[s]);
            const float delta0 = dry0[s] - wet0;
            float y0 = (normal0 + deltaMix_ * (delta0 - normal0)) * trimGain;
            out0[s] = std::isfinite(y0) ? y0 : 0.0f;

            if (out1 != nullptr && dry1 != nullptr)
            {
                const float wet1 = out1[s];
                const float normal1 = dry1[s] + mix * (wet1 - dry1[s]);
                const float delta1 = dry1[s] - wet1;
                float y1 = (normal1 + deltaMix_ * (delta1 - normal1)) * trimGain;
                out1[s] = std::isfinite(y1) ? y1 : 0.0f;
            }
        }
    }

    static juce::AudioProcessorValueTreeState::ParameterLayout createLayout()
    {
        using Apf = juce::AudioParameterFloat;
        using Apb = juce::AudioParameterBool;
        using Apc = juce::AudioParameterChoice;
        using Pid = juce::ParameterID;
        using Nar = juce::NormalisableRange<float>;

        constexpr float kFreqSkewWide   = 0.25f;
        constexpr float kFreqSkewNarrow = 0.5f;

        return {
            std::make_unique<Apf>(Pid{"depth",       1}, "Depth",
                Nar{0.0f,    100.0f,   0.0f, 1.0f},          50.0f,    "%"),
            std::make_unique<Apf>(Pid{"sharpness",   1}, "Sharpness",
                Nar{0.0f,    100.0f,   0.0f, 1.0f},          50.0f,    "%"),
            std::make_unique<Apf>(Pid{"selectivity", 1}, "Selectivity",
                Nar{0.0f,    100.0f,   0.0f, 1.0f},          50.0f,    "%"),
            std::make_unique<Apf>(Pid{"attack",      1}, "Attack",
                Nar{1.0f,    200.0f,   0.0f, 0.4f},          15.0f,    "ms"),
            std::make_unique<Apf>(Pid{"release",     1}, "Release",
                Nar{10.0f,   2000.0f,  0.0f, 0.4f},          200.0f,   "ms"),
            std::make_unique<Apf>(Pid{"mix",         1}, "Mix",
                Nar{0.0f,    100.0f,   0.0f, 1.0f},          100.0f,   "%"),
            std::make_unique<Apf>(Pid{"trim",        1}, "Trim",
                Nar{-12.0f,  12.0f,    0.0f, 1.0f},          0.0f,     "dB"),

            std::make_unique<Apb>(Pid{"delta",       1}, "Delta", false),

            std::make_unique<Apc>(Pid{"processing_mode", 1}, "Processing Mode",
                juce::StringArray{"Low Latency", "High Quality"}, 0),

            std::make_unique<Apc>(Pid{"quality",     1}, "Quality",
                juce::StringArray{"Fast", "Normal", "High"},  1),

            std::make_unique<Apf>(Pid{"stereo_link", 1}, "Stereo Link",
                Nar{0.0f,    100.0f,   0.0f, 1.0f},          100.0f,   "%"),

            std::make_unique<Apc>(Pid{"stereo_mode", 1}, "Stereo Mode",
                juce::StringArray{"Stereo", "Mid", "Side"},   0),

            std::make_unique<Apc>(Pid{"mode",        1}, "Mode",
                juce::StringArray{"Soft", "Hard"},            0),

            std::make_unique<Apf>(Pid{"wc_hp",       1}, "HP Boundary",
                Nar{20.0f,   2000.0f,  0.0f, kFreqSkewWide},   80.0f,   "Hz"),
            std::make_unique<Apf>(Pid{"wc_lp",       1}, "LP Boundary",
                Nar{2000.0f, 20000.0f, 0.0f, kFreqSkewNarrow}, 16000.0f,"Hz"),

            std::make_unique<Apf>(Pid{"wc_b1_freq",  1}, "Node 1 Freq",
                Nar{40.0f,   20000.0f, 0.0f, kFreqSkewWide},   250.0f,  "Hz"),
            std::make_unique<Apf>(Pid{"wc_b1_gain",  1}, "Node 1 Gain",
                Nar{-12.0f,  12.0f,    0.0f, 1.0f},            0.0f,    "dB"),

            std::make_unique<Apf>(Pid{"wc_b2_freq",  1}, "Node 2 Freq",
                Nar{40.0f,   20000.0f, 0.0f, kFreqSkewWide},   800.0f,  "Hz"),
            std::make_unique<Apf>(Pid{"wc_b2_gain",  1}, "Node 2 Gain",
                Nar{-12.0f,  12.0f,    0.0f, 1.0f},            0.0f,    "dB"),

            std::make_unique<Apf>(Pid{"wc_b3_freq",  1}, "Node 3 Freq",
                Nar{40.0f,   20000.0f, 0.0f, kFreqSkewWide},   2500.0f, "Hz"),
            std::make_unique<Apf>(Pid{"wc_b3_gain",  1}, "Node 3 Gain",
                Nar{-12.0f,  12.0f,    0.0f, 1.0f},            0.0f,    "dB"),

            std::make_unique<Apf>(Pid{"wc_b4_freq",  1}, "Node 4 Freq",
                Nar{40.0f,   20000.0f, 0.0f, kFreqSkewWide},   8000.0f, "Hz"),
            std::make_unique<Apf>(Pid{"wc_b4_gain",  1}, "Node 4 Gain",
                Nar{-12.0f,  12.0f,    0.0f, 1.0f},            0.0f,    "dB"),

            // ── v1.1: per-band active / type / Q for slots 1–4 ───────────────
            // active defaults true so old projects keep all four bands enabled.
            // type defaults to 0 (Bell) preserving the current Gaussian shape.
            // Q defaults to 1.0 which reproduces the fixed 0.5-octave sigma exactly.
            std::make_unique<Apb>(Pid{"wc_b1_active", 1}, "Band 1 Active", true),
            std::make_unique<Apc>(Pid{"wc_b1_type",   1}, "Band 1 Type",
                juce::StringArray{"Bell", "Low Shelf", "High Shelf", "Band Reject", "Tilt"}, 0),
            std::make_unique<Apf>(Pid{"wc_b1_q",      1}, "Band 1 Q",
                Nar{0.25f, 4.0f, 0.0f, 0.5f}, 1.0f, ""),

            std::make_unique<Apb>(Pid{"wc_b2_active", 1}, "Band 2 Active", true),
            std::make_unique<Apc>(Pid{"wc_b2_type",   1}, "Band 2 Type",
                juce::StringArray{"Bell", "Low Shelf", "High Shelf", "Band Reject", "Tilt"}, 0),
            std::make_unique<Apf>(Pid{"wc_b2_q",      1}, "Band 2 Q",
                Nar{0.25f, 4.0f, 0.0f, 0.5f}, 1.0f, ""),

            std::make_unique<Apb>(Pid{"wc_b3_active", 1}, "Band 3 Active", true),
            std::make_unique<Apc>(Pid{"wc_b3_type",   1}, "Band 3 Type",
                juce::StringArray{"Bell", "Low Shelf", "High Shelf", "Band Reject", "Tilt"}, 0),
            std::make_unique<Apf>(Pid{"wc_b3_q",      1}, "Band 3 Q",
                Nar{0.25f, 4.0f, 0.0f, 0.5f}, 1.0f, ""),

            std::make_unique<Apb>(Pid{"wc_b4_active", 1}, "Band 4 Active", true),
            std::make_unique<Apc>(Pid{"wc_b4_type",   1}, "Band 4 Type",
                juce::StringArray{"Bell", "Low Shelf", "High Shelf", "Band Reject", "Tilt"}, 0),
            std::make_unique<Apf>(Pid{"wc_b4_q",      1}, "Band 4 Q",
                Nar{0.25f, 4.0f, 0.0f, 0.5f}, 1.0f, ""),

            // ── v1.1: new band slots 5–8 (inactive by default) ───────────────
            // Frequencies spread musically across the remaining gaps.
            std::make_unique<Apb>(Pid{"wc_b5_active", 1}, "Band 5 Active", false),
            std::make_unique<Apc>(Pid{"wc_b5_type",   1}, "Band 5 Type",
                juce::StringArray{"Bell", "Low Shelf", "High Shelf", "Band Reject", "Tilt"}, 0),
            std::make_unique<Apf>(Pid{"wc_b5_freq",   1}, "Band 5 Freq",
                Nar{40.0f, 20000.0f, 0.0f, kFreqSkewWide}, 500.0f,   "Hz"),
            std::make_unique<Apf>(Pid{"wc_b5_gain",   1}, "Band 5 Gain",
                Nar{-12.0f, 12.0f,   0.0f, 1.0f},          0.0f,     "dB"),
            std::make_unique<Apf>(Pid{"wc_b5_q",      1}, "Band 5 Q",
                Nar{0.25f, 4.0f,     0.0f, 0.5f},           1.0f,    ""),

            std::make_unique<Apb>(Pid{"wc_b6_active", 1}, "Band 6 Active", false),
            std::make_unique<Apc>(Pid{"wc_b6_type",   1}, "Band 6 Type",
                juce::StringArray{"Bell", "Low Shelf", "High Shelf", "Band Reject", "Tilt"}, 0),
            std::make_unique<Apf>(Pid{"wc_b6_freq",   1}, "Band 6 Freq",
                Nar{40.0f, 20000.0f, 0.0f, kFreqSkewWide}, 1500.0f,  "Hz"),
            std::make_unique<Apf>(Pid{"wc_b6_gain",   1}, "Band 6 Gain",
                Nar{-12.0f, 12.0f,   0.0f, 1.0f},          0.0f,     "dB"),
            std::make_unique<Apf>(Pid{"wc_b6_q",      1}, "Band 6 Q",
                Nar{0.25f, 4.0f,     0.0f, 0.5f},           1.0f,    ""),

            std::make_unique<Apb>(Pid{"wc_b7_active", 1}, "Band 7 Active", false),
            std::make_unique<Apc>(Pid{"wc_b7_type",   1}, "Band 7 Type",
                juce::StringArray{"Bell", "Low Shelf", "High Shelf", "Band Reject", "Tilt"}, 0),
            std::make_unique<Apf>(Pid{"wc_b7_freq",   1}, "Band 7 Freq",
                Nar{40.0f, 20000.0f, 0.0f, kFreqSkewWide}, 4000.0f,  "Hz"),
            std::make_unique<Apf>(Pid{"wc_b7_gain",   1}, "Band 7 Gain",
                Nar{-12.0f, 12.0f,   0.0f, 1.0f},          0.0f,     "dB"),
            std::make_unique<Apf>(Pid{"wc_b7_q",      1}, "Band 7 Q",
                Nar{0.25f, 4.0f,     0.0f, 0.5f},           1.0f,    ""),

            std::make_unique<Apb>(Pid{"wc_b8_active", 1}, "Band 8 Active", false),
            std::make_unique<Apc>(Pid{"wc_b8_type",   1}, "Band 8 Type",
                juce::StringArray{"Bell", "Low Shelf", "High Shelf", "Band Reject", "Tilt"}, 0),
            std::make_unique<Apf>(Pid{"wc_b8_freq",   1}, "Band 8 Freq",
                Nar{40.0f, 20000.0f, 0.0f, kFreqSkewWide}, 10000.0f, "Hz"),
            std::make_unique<Apf>(Pid{"wc_b8_gain",   1}, "Band 8 Gain",
                Nar{-12.0f, 12.0f,   0.0f, 1.0f},          0.0f,     "dB"),
            std::make_unique<Apf>(Pid{"wc_b8_q",      1}, "Band 8 Q",
                Nar{0.25f, 4.0f,     0.0f, 0.5f},           1.0f,    ""),
        };
    }

    double sampleRate_   = 44100.0;
    int    maxBlockSize_ = 0;
    int    lastStereoMode_ = -1;
    WolaProcessor wola_;
    LowLatencyProcessor lowLatency_;
    DryDelayLine dryDelay_;
    juce::AudioBuffer<float> delayedDry_;
    juce::AudioBuffer<float> liveDry_;
    std::vector<float> msComponent_;
    float deltaMix_ = 0.0f;
    float deltaRampPerSample_ = 1.0f;
    ProcessingEngine activeEngine_ = ProcessingEngine::None;
    bool wetStateCleared_ = false;
    bool pendingHighQualityReprepare_ = false;
    int preparedHighQualityQualityIndex_ = -1;
    std::atomic<std::uint64_t> processBlockLatencyUpdateCount_{0};
    std::atomic<std::uint64_t> nonRealtimeLatencyUpdateCount_{0};
    const std::string mixParamId_ {"mix"};
    const std::string trimParamId_ {"trim"};
    std::unique_ptr<xleth::viz::DynamicsVizCollector<xleth::viz::ResonanceBucket>>
        vizCollector_;
    std::atomic<xleth::viz::DynamicsVizCollector<xleth::viz::ResonanceBucket>*>
        vizActive_ { nullptr };
};
