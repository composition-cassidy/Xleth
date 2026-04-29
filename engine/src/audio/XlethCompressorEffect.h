#pragma once

#include "audio/XlethEffectBase.h"
#include "audio/viz/DynamicsVizCollector.h"
#include "audio/viz/DynamicsVizFrame.h"
#include <juce_dsp/juce_dsp.h>

#include <algorithm>
#include <atomic>
#include <cmath>
#include <cstddef>
#include <cstdint>
#include <memory>

// ─── XlethCompressorEffect ────────────────────────────────────────────────────
// Feed-forward compressor with soft-knee, decoupled peak/RMS envelope detector
// (Giannoulis JAES 2012), lookahead delay, and makeup gain.
//
// Parameters (APVTS-backed):
//   threshold  -60–0 dB       (Linear 20ms smoothing)
//   ratio       1–100 :1      (Linear 20ms smoothing, skew 0.35)
//   attack      0.01–100 ms   (Linear 20ms smoothing, skew 0.3)
//   release    10–1000 ms     (Linear 20ms smoothing, skew 0.3)
//   knee        0–24 dB       (Linear 20ms smoothing)
//   makeup      0–36 dB       (Linear 20ms smoothing)
//   mix         0–100 %       (Linear 20ms smoothing)
//   detect_mode 0=Peak, 1=RMS (discrete)
//   lookahead   0–10 ms       (discrete, applied per block boundary)
//
// Metering slots:
//   0 — L channel output peak (absolute, max over block)
//   1 — R channel output peak
//   2 — Gain reduction dB (positive = reduction, max over block)
//
// pluginId: "compressor"

class XlethCompressorEffect : public XlethEffectBase
{
public:
    XlethCompressorEffect() : XlethEffectBase("compressor", createLayout())
    {
        registerSmoothedParam("threshold", SmoothType::Linear, 20.0f);
        registerSmoothedParam("ratio",     SmoothType::Linear, 20.0f);
        registerSmoothedParam("attack",    SmoothType::Linear, 20.0f);
        registerSmoothedParam("release",   SmoothType::Linear, 20.0f);
        registerSmoothedParam("knee",      SmoothType::Linear, 20.0f);
        registerSmoothedParam("makeup",    SmoothType::Linear, 20.0f);
        registerSmoothedParam("mix",       SmoothType::Linear, 20.0f);
    }

    // ── Visualization overrides (XlethEffectBase) ───────────────────────────
    //
    // Lifetime model:
    //   • The collector is allocated lazily on the FIRST enable (main thread).
    //   • Once allocated, it lives until the effect itself is destroyed.
    //     `setVisualizationEnabled(false)` only un-publishes the atomic pointer
    //     — it does NOT destroy the ring. Destroying the ring while the audio
    //     thread is mid-block (it loads vizActive_ once per block and uses it
    //     for the whole block) would be a use-after-free.
    //   • The effect destructor frees the collector. By that point JUCE's
    //     AudioProcessorGraph has already detached the effect from the audio
    //     callback, so there is no audio thread to race against.
    //   • Cost: ~40 KB per Compressor that has ever opened its editor. Fine.
    //
    // No state reset on toggle:
    //   • We never call `vizCollector_->reset()` or `vizAccum_.reset()` from
    //     this method, because doing so would race the audio thread if the
    //     audio thread is still finishing a block that captured a non-null
    //     vizCol from a previous enable. The ring's SPSC indices are
    //     monotonically increasing under the producer; stale buckets from
    //     before the previous disable get drained naturally by the consumer
    //     (engine drain returns up to maxBuckets at a time, and the JS-side
    //     ring is also bounded — the live tail wins out within a few frames).
    //   • The accumulator's per-bucket fields (peak / max / detector) are
    //     overwritten by `observe()` and zeroed by `advance()` on every
    //     bucket boundary, so a stale residue at re-enable is at most one
    //     bucket worth of inflated values (≤ 1.45 ms @ 44.1 kHz).
    //
    // While vizActive_ is null, processEffect's hot loop pays only one
    // acquire-load + null-check per block.
    void setVisualizationEnabled(bool enabled) override
    {
        if (enabled)
        {
            if (!vizCollector_)
            {
                vizCollector_ = std::make_unique<
                    xleth::viz::DynamicsVizCollector<xleth::viz::CompressorBucket>>(
                        xleth::viz::kDynamicsVizBucketSize,
                        xleth::viz::kDynamicsVizRingDepth,
                        xleth::viz::kVizTypeCompressor);
            }
            // Idempotent: re-publishing the same pointer is a no-op for the
            // audio thread (which already loads vizActive_ each block).
            vizActive_.store(vizCollector_.get(), std::memory_order_release);
        }
        else
        {
            // Un-publish only. The audio thread's next block sees nullptr and
            // skips all visualization work. The collector itself is retained
            // and re-used on the next enable to avoid use-after-free.
            vizActive_.store(nullptr, std::memory_order_release);
        }
    }

    std::uint32_t getVisualizationType() const override
    {
        return xleth::viz::kVizTypeCompressor;
    }

    std::uint32_t getVisualizationSchemaVersion() const override
    {
        return xleth::viz::kDynamicsVizSchemaVersion;
    }

    std::size_t drainVizFrames(std::uint8_t* out, std::size_t maxBytes) override
    {
        // Main-thread only — read collector_ via the unique_ptr (not the
        // atomic), since this method is also main-thread.
        if (!vizCollector_) return 0;
        return vizCollector_->drain(out, maxBytes);
    }

    // ── prepareEffect ───────────────────────────────────────────────────────
    void prepareEffect(double sampleRate, int maxBlockSize) override
    {
        sampleRate_ = sampleRate;

        detectModePtr_ = apvts_.getRawParameterValue("detect_mode");
        lookaheadPtr_  = apvts_.getRawParameterValue("lookahead");

        // setMaximumDelayInSamples must be called BEFORE prepare() so the
        // buffer is allocated at the right size.
        const int maxDelaySamples = static_cast<int>(0.01 * sampleRate) + 5;
        lookaheadDelay_.setMaximumDelayInSamples(maxDelaySamples);

        juce::dsp::ProcessSpec spec;
        spec.sampleRate       = sampleRate;
        spec.maximumBlockSize = static_cast<juce::uint32>(maxBlockSize);
        spec.numChannels      = 2;
        lookaheadDelay_.prepare(spec);
        lookaheadDelay_.reset();

        env_  = 0.0f;
        peak_ = 0.0f;
        vizSampleClock_ = 0;
        vizAccum_.reset();

        const float initLa = lookaheadPtr_
                           ? lookaheadPtr_->load(std::memory_order_relaxed) : 0.0f;
        prevLookaheadMs_ = initLa;
        setLatencySamples(static_cast<int>(initLa * sampleRate / 1000.0));

#ifdef XLETH_DEBUG
        DBG("[Compressor] prepareEffect sr=" + juce::String(sampleRate)
            + " blockSize=" + juce::String(maxBlockSize)
            + " maxDelay=" + juce::String(maxDelaySamples));
#endif
    }

    // ── resetEffect ─────────────────────────────────────────────────────────
    void resetEffect() override
    {
        env_  = 0.0f;
        peak_ = 0.0f;
        lookaheadDelay_.reset();
        vizSampleClock_ = 0;
        vizAccum_.reset();
    }

    // ── getTailLengthSeconds ────────────────────────────────────────────────
    // Gain-reduction envelope takes up to the release time to return to unity
    // after input stops.
    double getTailLengthSeconds() const override
    {
        return static_cast<double>(getSmoothedValue("release") * 0.001f);
    }

    // ── processEffect ───────────────────────────────────────────────────────
    void processEffect(juce::AudioBuffer<float>& buffer, juce::MidiBuffer& /*midi*/) override
    {
        const int numSamples = buffer.getNumSamples();
        const int numCh      = buffer.getNumChannels();

        // Discrete params: read once per block
        const int detectMode = detectModePtr_
                             ? static_cast<int>(detectModePtr_->load(std::memory_order_relaxed))
                             : 0;
        const float lookaheadMs = lookaheadPtr_
                                ? lookaheadPtr_->load(std::memory_order_relaxed)
                                : 0.0f;
        const int lookaheadSamps = static_cast<int>(lookaheadMs * sampleRate_ / 1000.0);

        // Latency compensation: update whenever lookahead changes
        if (lookaheadMs != prevLookaheadMs_)
        {
            prevLookaheadMs_ = lookaheadMs;
            setLatencySamples(lookaheadSamps);
#ifdef XLETH_DEBUG
            DBG("[Compressor] lookahead changed to " + juce::String(lookaheadMs)
                + "ms (" + juce::String(lookaheadSamps) + " samples)");
#endif
        }

        // JUCE DelayLine: pushSample decrements writePos after writing, so
        // pop with delay=1 retrieves the just-pushed sample (0-sample net latency).
        // We add 1 to align the read position correctly.
        const float popDelay = static_cast<float>(lookaheadSamps + 1);

        float peakL = 0.0f, peakR = 0.0f, maxGR = 0.0f;

        // Visualization (opt-in per instance). One acquire load per block —
        // null when the editor is closed, so the hot loop pays only a cheap
        // null-check.
        auto* vizCol = vizActive_.load(std::memory_order_acquire);

#ifdef XLETH_DEBUG
        static int blockCount_ = 0;
        ++blockCount_;
        const bool doLog = (blockCount_ % 1000 == 0);
#endif

        for (int s = 0; s < numSamples; ++s)
        {
            // Smoothed continuous params (one advance per sample)
            const float threshold = getNextSmoothedValue("threshold");
            const float ratio     = getNextSmoothedValue("ratio");
            const float attackMs  = getNextSmoothedValue("attack");
            const float releaseMs = getNextSmoothedValue("release");
            const float knee      = getNextSmoothedValue("knee");
            const float makeup    = getNextSmoothedValue("makeup");
            const float mixPct    = getNextSmoothedValue("mix");

            // Attack / release coefficients
            // coeff = exp(-1 / (timeInSeconds * sampleRate))
            // coeff close to 1 = slow response, close to 0 = fast response
            const float aCoeff = std::exp(
                -1.0f / std::max(attackMs  * 0.001f * static_cast<float>(sampleRate_), 1e-6f));
            const float rCoeff = std::exp(
                -1.0f / std::max(releaseMs * 0.001f * static_cast<float>(sampleRate_), 1e-6f));

            // Sidechain: read NON-delayed input (stereo-linked max)
            const float sideL = buffer.getSample(0, s);
            const float sideR = numCh > 1 ? buffer.getSample(1, s) : sideL;

            // Per-sample visualization input level (pre-process). Reuses the
            // values already read above — one extra std::max in the hot path.
            const float vizAbsIn = vizCol
                ? std::max(std::abs(sideL), std::abs(sideR))
                : 0.0f;

            // Envelope detection
            float level;
            if (detectMode == 1)  // RMS — decoupled detector on squared signal
            {
                const float sq = 0.5f * (sideL * sideL + sideR * sideR);
                peak_ = std::max(sq, rCoeff * peak_ + (1.0f - rCoeff) * sq);
                env_  = aCoeff * env_ + (1.0f - aCoeff) * peak_;
                level = std::sqrt(std::max(env_, 1e-12f));
            }
            else  // Peak — decoupled Giannoulis detector
            {
                const float absLevel = std::max(std::abs(sideL), std::abs(sideR));
                peak_ = std::max(absLevel, rCoeff * peak_ + (1.0f - rCoeff) * absLevel);
                env_  = aCoeff * env_ + (1.0f - aCoeff) * peak_;
                level = env_;
            }

            // Envelope → dB (clamped to prevent log(0))
            const float envDB = 20.0f * std::log10(std::max(level, 1e-6f));

            // Soft-knee gain reduction in dB
            const float slope     = 1.0f - 1.0f / std::max(ratio, 1.0f);
            const float halfW     = knee * 0.5f;
            const float overshoot = envDB - threshold;
            float grDB;
            if (overshoot <= -halfW)
                grDB = 0.0f;
            else if (overshoot >= halfW)
                grDB = slope * overshoot;
            else
            {
                const float t = overshoot + halfW;
                grDB = 0.5f * slope * t * t / std::max(knee, 1e-6f);
            }

            // Linear gain: compression + makeup gain (dB domain arithmetic)
            const float gainLin = std::pow(10.0f, (-grDB + makeup) / 20.0f);
            const float mixNorm = mixPct / 100.0f;

            // Delay input signal, apply gain, blend dry/wet
            // Both the wet path and dry-mix path use the delayed signal so that
            // mix < 100% with lookahead > 0 doesn't produce comb filtering.
            float vizAbsOut = 0.0f;
            for (int ch = 0; ch < numCh; ++ch)
            {
                const float dry = buffer.getSample(ch, s);
                lookaheadDelay_.pushSample(ch, dry);
                const float delayed = lookaheadDelay_.popSample(ch, popDelay, true);
                const float wet     = delayed * gainLin;
                const float mixed   = delayed * (1.0f - mixNorm) + wet * mixNorm;
                buffer.setSample(ch, s, mixed);

                const float absOut = std::abs(mixed);
                if (ch == 0) peakL = std::max(peakL, absOut);
                if (ch == 1) peakR = std::max(peakR, absOut);
                if (vizCol && absOut > vizAbsOut) vizAbsOut = absOut;
            }

            maxGR = std::max(maxGR, grDB);

            // Advance the per-instance visualization sample clock and, if
            // visualization is enabled, accumulate this sample's observations.
            // ioInDb / ioOutDb feed the live transfer-curve dot — we use the
            // input level (envDB is detector dB; envDB at the end of bucket is
            // the captured detector). For the dot we want the instantaneous
            // input-vs-output relationship: envDB → envDB - grDB + makeup.
            ++vizSampleClock_;
            if (vizCol)
            {
                const float ioInDb  = envDB;
                const float ioOutDb = envDB - grDB + makeup;
                vizAccum_.observe(vizAbsIn, vizAbsOut, envDB, grDB, ioInDb, ioOutDb);
                vizAccum_.advance(vizSampleClock_, *vizCol);
            }
        }

#ifdef XLETH_DEBUG
        if (doLog)
            DBG("[Compressor] GR=" + juce::String(maxGR, 2)
                + " envDB=" + juce::String(20.0f * std::log10(std::max(env_, 1e-6f)), 2)
                + " threshold=" + juce::String(getSmoothedValue("threshold"), 1));
#endif

        writeMeterValue(0, peakL);
        writeMeterValue(1, numCh > 1 ? peakR : peakL);
        writeMeterValue(2, maxGR);
    }

private:
    // ── Parameter layout ────────────────────────────────────────────────────
    static juce::AudioProcessorValueTreeState::ParameterLayout createLayout()
    {
        using Apf = juce::AudioParameterFloat;
        using Pid = juce::ParameterID;
        using Nar = juce::NormalisableRange<float>;

        return {
            std::make_unique<Apf>(Pid{"threshold",   1}, "Threshold",
                Nar{-60.0f, 0.0f,    0.0f, 1.0f  }, -20.0f,  "dB"),
            std::make_unique<Apf>(Pid{"ratio",        1}, "Ratio",
                Nar{1.0f,   100.0f,  0.0f, 0.35f }, 4.0f,    ":1"),
            std::make_unique<Apf>(Pid{"attack",       1}, "Attack",
                Nar{0.01f,  100.0f,  0.0f, 0.3f  }, 10.0f,   "ms"),
            std::make_unique<Apf>(Pid{"release",      1}, "Release",
                Nar{10.0f,  1000.0f, 0.0f, 0.3f  }, 100.0f,  "ms"),
            std::make_unique<Apf>(Pid{"knee",         1}, "Knee",
                Nar{0.0f,   24.0f,   0.0f, 1.0f  }, 6.0f,    "dB"),
            std::make_unique<Apf>(Pid{"makeup",       1}, "Makeup",
                Nar{0.0f,   36.0f,   0.0f, 1.0f  }, 0.0f,    "dB"),
            std::make_unique<Apf>(Pid{"mix",          1}, "Mix",
                Nar{0.0f,   100.0f,  0.0f, 1.0f  }, 100.0f,  "%"),
            std::make_unique<Apf>(Pid{"detect_mode",  1}, "Detect Mode",
                Nar{0.0f,   1.0f,    1.0f, 1.0f  }, 0.0f,    ""),
            std::make_unique<Apf>(Pid{"lookahead",    1}, "Lookahead",
                Nar{0.0f,   10.0f,   0.0f, 1.0f  }, 0.0f,    "ms"),
        };
    }

    // Raw APVTS pointers for discrete parameters (resolved in prepareEffect)
    std::atomic<float>* detectModePtr_ = nullptr;
    std::atomic<float>* lookaheadPtr_  = nullptr;

    // Envelope follower state (shared for both Peak and RMS modes)
    // In RMS mode, peak_/env_ operate on the squared signal; sqrt is taken at the end.
    float env_  = 0.0f;
    float peak_ = 0.0f;

    // Lookahead delay line (stereo, integer-sample delay, no interpolation)
    juce::dsp::DelayLine<float, juce::dsp::DelayLineInterpolationTypes::None> lookaheadDelay_;

    float  prevLookaheadMs_ = 0.0f;
    double sampleRate_      = 44100.0;

    // ── Visualization state ─────────────────────────────────────────────────
    // Owning unique_ptr lives only on the main thread (prepare/setEnabled).
    // The audio thread reads `vizActive_` (release/acquire) and operates on
    // it without ever touching the unique_ptr. While the effect is enabled,
    // vizActive_ == vizCollector_.get(); when disabled, it's nullptr.
    std::unique_ptr<xleth::viz::DynamicsVizCollector<xleth::viz::CompressorBucket>>
        vizCollector_;
    std::atomic<xleth::viz::DynamicsVizCollector<xleth::viz::CompressorBucket>*>
        vizActive_{nullptr};

    xleth::viz::CompressorBucketAccumulator vizAccum_;
    std::uint64_t vizSampleClock_ = 0; // monotonic per-instance sample index
};
