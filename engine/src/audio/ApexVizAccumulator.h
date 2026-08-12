#pragma once

#include "audio/viz/DynamicsVizCollector.h"
#include "audio/viz/DynamicsVizFrame.h"

#include <juce_dsp/juce_dsp.h>

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <vector>

// ─── ApexVizAccumulator ──────────────────────────────────────────────────────
//
// Audio-thread helper that turns APEX's per-block measurements into
// xleth::viz::ApexBucket frames on a DynamicsVizCollector ring.
//
// It lives here rather than in engine/src/audio/viz/DynamicsVizCollector.h
// because it needs juce::dsp::FFT, and that header is deliberately JUCE-free
// (it is pure POD + atomics so tests can include it standalone).
//
// ── Why this one is block-rate, not sample-rate ──────────────────────────────
//
// Every other accumulator in DynamicsVizCollector.h exposes a per-sample
// observe(). APEX does not, for two reasons:
//
//   1. Everything APEX reports is already a block-level quantity by the time
//      processEffect() has it — per-band gain reduction is derived from the
//      block's minimum curve gain, and the peaks are block peaks. Re-deriving
//      them per sample would mean threading eight extra trackers through four
//      band stages for no extra information.
//   2. The spectrum is a 2048-point FFT. Running it per bucket at the shared
//      64-sample cadence would be ~700 FFTs/s AND ~3 MB/s of IPC. APEX
//      therefore uses its own, much coarser bucket size
//      (kApexVizBucketSize = 1024 samples ≈ 43 Hz) which is matched to the
//      ~30 Hz rate the UI actually drains at.
//
// ── Audio-thread discipline ──────────────────────────────────────────────────
//
// prepare() is main-thread and does every allocation: the Hann window, the
// 2048-sample input history ring, and the FFT scratch buffer. After that,
// observeBlock() allocates nothing, locks nothing, and logs nothing. The FFT
// itself runs only on the ~43 Hz flush, never per block and never per sample.
//
// The whole object is only ever touched when visualization is ENABLED (the
// effect null-checks its published collector pointer first), so a closed
// editor costs one acquire-load per block and nothing else.
//
// ── At most one bucket per block ─────────────────────────────────────────────
//
// observeBlock() flushes at most once per call. With the realtime block sizes
// this engine runs (64-1024) that is always enough to keep the 1024-sample
// cadence. A host block LARGER than kApexVizBucketSize (e.g. an offline
// render) would emit one bucket per block instead — i.e. a slower, not a
// wrong, stream. Visualization is only ever enabled while an editor window is
// open in realtime, so that case does not arise in practice, and dropping to
// block rate is the correct degradation if it ever does.

namespace xleth { namespace apexviz {

class ApexVizAccumulator
{
public:
    static constexpr int kFftOrder = 11;                                  // 2048
    static constexpr int kFftSize  = static_cast<int>(xleth::viz::kApexVizFftSize);
    static constexpr int kNumBins  = static_cast<int>(xleth::viz::kApexVizSpectrumBins);

    static_assert(kFftSize == (1 << kFftOrder), "kFftOrder must match kApexVizFftSize");

    // ── Main thread ─────────────────────────────────────────────────────────
    void prepare(double sampleRate)
    {
        sampleRate_ = sampleRate > 0.0 ? static_cast<float>(sampleRate) : 44100.0f;

        window_.assign(static_cast<std::size_t>(kFftSize), 0.0f);
        for (int n = 0; n < kFftSize; ++n)
        {
            // Periodic Hann — sum(w) == N/2 exactly, which is what the 4/N
            // magnitude normalisation below assumes.
            window_[static_cast<std::size_t>(n)] =
                0.5f - 0.5f * std::cos(2.0f * juce::MathConstants<float>::pi
                                       * static_cast<float>(n)
                                       / static_cast<float>(kFftSize));
        }

        history_.assign(static_cast<std::size_t>(kFftSize), 0.0f);
        // performFrequencyOnlyForwardTransform needs 2*N floats of workspace.
        scratch_.assign(static_cast<std::size_t>(kFftSize) * 2u, 0.0f);

        reset();
    }

    // Safe from either thread while visualization is disabled; called from the
    // effect's resetEffect() (main thread) in practice. No allocation.
    void reset() noexcept
    {
        std::fill(history_.begin(), history_.end(), 0.0f);
        historyPos_  = 0;
        sampleClock_ = 0;
        clearBucketState();
    }

    bool isPrepared() const noexcept
    {
        return !window_.empty() && !history_.empty() && !scratch_.empty();
    }

    // ── Audio thread — step 1, immediately after LOW CUT ────────────────────
    //
    // Feeds the FFT history ring with the mono sum of the post-LOW-CUT input.
    //
    // This is deliberately a SEPARATE call from observeBlock() below. APEX
    // reuses its dry buffer as a lane of the shared lookahead ring, so by the
    // end of processEffect() the "dry" pointers hold the DELAYED dry leg, not
    // the input. Capturing the spectrum here — before the ring runs — is what
    // makes the analysis display show the actual input rather than an input
    // shifted by whatever LOOKAHEAD happens to be set to.
    void pushInput(const float* inL, const float* inR, int numSamples) noexcept
    {
        if (!isPrepared() || numSamples <= 0 || inL == nullptr) return;
        if (inR == nullptr) inR = inL;

        for (int s = 0; s < numSamples; ++s)
        {
            history_[static_cast<std::size_t>(historyPos_)] = 0.5f * (inL[s] + inR[s]);
            historyPos_ = (historyPos_ + 1) & (kFftSize - 1);
        }
    }

    // ── Audio thread — step 2, once per block, at the end ───────────────────
    //
    // inPeak      : peak abs of the post-LOW-CUT input over the block
    // outPeak     : peak abs of the effect's final output over the block
    // bandGrDb    : 4 entries, positive dB gain reduction (LOW, MID, HIGH, MASTER)
    // bandOutAbs  : 4 entries, LINEAR peak output level per band (converted to
    //               dB once per bucket, not once per block)
    //
    // Must be called after pushInput() for the same block — the flush reads the
    // history ring this block just wrote.
    void observeBlock(int          numSamples,
                      float        inPeak,
                      float        outPeak,
                      const float* bandGrDb,
                      const float* bandOutAbs,
                      const float* bandInAbs,
                      float        lookaheadSamples,
                      float        latencySamples,
                      float        splitLoHz,
                      float        splitHiHz,
                      xleth::viz::DynamicsVizCollector<xleth::viz::ApexBucket>& collector) noexcept
    {
        if (!isPrepared() || numSamples <= 0) return;

        // ── Fold the block's scalars into the in-flight bucket ──────────────
        if (inPeak  > peakAbsIn_)  peakAbsIn_  = inPeak;
        if (outPeak > peakAbsOut_) peakAbsOut_ = outPeak;
        for (int b = 0; b < kNumBands; ++b)
        {
            if (bandGrDb   && bandGrDb[b]   > maxGrDb_[b])      maxGrDb_[b]      = bandGrDb[b];
            if (bandOutAbs && bandOutAbs[b] > peakAbsBand_[b])  peakAbsBand_[b]  = bandOutAbs[b];
            if (bandInAbs  && bandInAbs[b]  > peakAbsBandIn_[b]) peakAbsBandIn_[b] = bandInAbs[b];
        }
        lastLookahead_ = lookaheadSamples;
        lastLatency_   = latencySamples;
        lastSplitLo_   = splitLoHz;
        lastSplitHi_   = splitHiHz;

        sampleCount_ += static_cast<std::uint32_t>(numSamples);
        sampleClock_ += static_cast<std::uint64_t>(numSamples);

        if (sampleCount_ < collector.bucketSamples()) return;

        // ── Flush ───────────────────────────────────────────────────────────
        xleth::viz::ApexBucket bucket{};
        bucket.hdr.sampleClock   = sampleClock_ - sampleCount_;
        bucket.hdr.bucketSamples = sampleCount_;
        bucket.hdr.flags         = 0u;

        bucket.inputPeakDb  = absToDb(peakAbsIn_);
        bucket.outputPeakDb = absToDb(peakAbsOut_);
        for (int b = 0; b < kNumBands; ++b)
        {
            bucket.bandGrDb [b] = maxGrDb_[b];
            bucket.bandOutDb[b] = absToDb(peakAbsBand_[b]);
            bucket.bandInDb [b] = absToDb(peakAbsBandIn_[b]);
        }
        bucket.lookaheadSamples = lastLookahead_;
        bucket.latencySamples   = lastLatency_;
        bucket.splitLoHz        = lastSplitLo_;
        bucket.splitHiHz        = lastSplitHi_;
        bucket.sampleRate       = sampleRate_;
        bucket.spectrumBins     = static_cast<float>(kNumBins);

        computeSpectrum(bucket.spectrum);

        (void) collector.push(bucket);
        clearBucketState();
    }

private:
    static constexpr int kNumBands = static_cast<int>(xleth::viz::kApexVizNumBands);

    void clearBucketState() noexcept
    {
        peakAbsIn_  = 0.0f;
        peakAbsOut_ = 0.0f;
        for (int b = 0; b < kNumBands; ++b)
        {
            maxGrDb_[b]       = 0.0f;
            peakAbsBand_[b]   = 0.0f;
            peakAbsBandIn_[b] = 0.0f;
        }
        sampleCount_ = 0;
    }

    static float absToDb(float a) noexcept
    {
        if (a < 1.0e-6f) return -120.0f;
        return 20.0f * std::log10(a);
    }

    // Unwrap the newest kFftSize samples from the ring (oldest first), window
    // them, transform, and write normalised magnitudes in dB.
    //
    // Normalisation: for x[n] = A·cos(2πkn/N) windowed by a periodic Hann,
    // |X[k]| = A·Σw/2 = A·N/4. Scaling by 4/N therefore makes a full-scale
    // (A = 1) sine read exactly 0 dB, which is what the UI's dB grid assumes.
    void computeSpectrum(float* outDb) noexcept
    {
        // historyPos_ is the next WRITE slot, i.e. the oldest sample.
        const int oldest = historyPos_;
        for (int n = 0; n < kFftSize; ++n)
        {
            const int src = (oldest + n) & (kFftSize - 1);
            scratch_[static_cast<std::size_t>(n)] =
                history_[static_cast<std::size_t>(src)] * window_[static_cast<std::size_t>(n)];
        }
        std::fill(scratch_.begin() + kFftSize, scratch_.end(), 0.0f);

        fft_.performFrequencyOnlyForwardTransform(scratch_.data());

        constexpr float norm = 4.0f / static_cast<float>(kFftSize);
        for (int k = 0; k < kNumBins; ++k)
            outDb[k] = absToDb(scratch_[static_cast<std::size_t>(k)] * norm);
    }

    juce::dsp::FFT     fft_ { kFftOrder };
    std::vector<float> window_;
    std::vector<float> history_;
    std::vector<float> scratch_;

    int           historyPos_  = 0;
    std::uint64_t sampleClock_ = 0;
    std::uint32_t sampleCount_ = 0;
    float         sampleRate_  = 44100.0f;

    float peakAbsIn_          = 0.0f;
    float peakAbsOut_         = 0.0f;
    float maxGrDb_[kNumBands] {};
    float peakAbsBand_[kNumBands] {};
    float peakAbsBandIn_[kNumBands] {};
    float lastLookahead_      = 0.0f;
    float lastLatency_        = 0.0f;
    float lastSplitLo_        = 200.0f;
    float lastSplitHi_        = 2000.0f;
};

}} // namespace xleth::apexviz
