#pragma once

// ─── DynamicsVizCollector.h ────────────────────────────────────────────────────
// Lock-free SPSC ring buffer + bucket accumulator for dynamics visualization
// frames. Modeled on engine/src/TriggerQueue.h (power-of-two index ring with
// acquire/release atomics).
//
// Architecture:
//   • Audio thread (single producer): per-sample observe(...) accumulates cheap
//     scalar values into the in-flight bucket. Once it has accumulated
//     kDynamicsVizBucketSize samples, the accumulator emits a bucket via
//     collector.push(). The push is wait-free.
//   • Main thread (single consumer): drain(out, maxBytes) copies as many
//     complete buckets as fit into the supplied byte buffer.
//
// Audio-thread guarantees:
//   • No allocation, no locking, no logging, no waiting, no JS/IPC.
//
// Overflow policy:
//   • If the ring is full when push() is called, the NEW bucket is dropped.
//     This preserves clean SPSC semantics (only the producer writes writePos_,
//     only the consumer writes readPos_). With a depth of 1024 buckets and
//     ~700 buckets/s, the UI must stall for >1.4 s before any drops occur,
//     which the user would notice in other ways first. The audio thread NEVER
//     stalls or waits — push() returns immediately on full.
//
// Allocation:
//   • The ring's std::vector is allocated on the main thread before the
//     collector pointer is published to the audio thread. Once published, no
//     reallocation occurs.
//
// Generic on bucket type (T) so future Limiter / Transient / Overdone payloads
// can reuse the same template; only CompressorBucket is instantiated today.

#include "DynamicsVizFrame.h"

#include <atomic>
#include <cmath>
#include <cstddef>
#include <cstdint>
#include <cstring>
#include <limits>
#include <type_traits>
#include <vector>

namespace xleth { namespace viz {

// ── Type-erased base ─────────────────────────────────────────────────────────
// Held by XlethEffectBase as std::unique_ptr<DynamicsVizCollectorBase> so the
// audio path can drain bytes without knowing the concrete bucket type. The
// concrete type is recovered on the JS side from `getVisualizationType()` on
// the effect.

class DynamicsVizCollectorBase
{
public:
    virtual ~DynamicsVizCollectorBase() = default;

    // Main-thread drain. Copies up to `maxBytes` bytes worth of complete
    // buckets from the ring into `out`. Returns the number of bytes written.
    // Always writes a whole number of buckets; never partial.
    virtual std::size_t drain(uint8_t* out, std::size_t maxBytes) noexcept = 0;

    // Reports per-bucket size for the layout this collector emits.
    virtual std::size_t bucketSizeBytes() const noexcept = 0;

    // Visualization type tag (see DynamicsVizFrame.h).
    virtual uint32_t vizType() const noexcept = 0;

    // Schema version (mirrored on the JS side).
    virtual uint32_t schemaVersion() const noexcept { return kDynamicsVizSchemaVersion; }
};

// ── Concrete templated collector ─────────────────────────────────────────────
template <typename TBucket>
class DynamicsVizCollector final : public DynamicsVizCollectorBase
{
    static_assert(std::is_trivially_copyable<TBucket>::value,
                  "Bucket type must be trivially copyable");
    static_assert(std::is_standard_layout<TBucket>::value,
                  "Bucket type must be standard layout");

public:
    explicit DynamicsVizCollector(uint32_t bucketSamples = kDynamicsVizBucketSize,
                                  uint32_t ringDepth     = kDynamicsVizRingDepth,
                                  uint32_t vizType       = kVizTypeUnknown)
        : bucketSamples_(bucketSamples)
        , vizType_(vizType)
    {
        // Round ring depth up to next power of two for cheap masking.
        uint32_t cap = 1;
        while (cap < ringDepth) cap <<= 1;
        capacity_ = cap;
        mask_     = cap - 1;
        ring_.resize(capacity_);
    }

    // ── Main-thread API ─────────────────────────────────────────────────────
    std::size_t drain(uint8_t* out, std::size_t maxBytes) noexcept override
    {
        if (out == nullptr || maxBytes < sizeof(TBucket)) return 0;

        const std::size_t maxBuckets = maxBytes / sizeof(TBucket);
        std::size_t copied = 0;

        for (std::size_t i = 0; i < maxBuckets; ++i)
        {
            const uint32_t rp = readPos_.load(std::memory_order_relaxed);
            const uint32_t wp = writePos_.load(std::memory_order_acquire);
            if (rp == wp) break; // empty

            // memcpy is well-defined for trivially-copyable types and avoids
            // strict-aliasing concerns on the JS side (we hand back raw bytes).
            std::memcpy(out + copied, &ring_[rp & mask_], sizeof(TBucket));
            readPos_.store(rp + 1, std::memory_order_release);
            copied += sizeof(TBucket);
        }
        return copied;
    }

    std::size_t bucketSizeBytes() const noexcept override { return sizeof(TBucket); }
    uint32_t    vizType()         const noexcept override { return vizType_; }

    // ── Audio-thread API ────────────────────────────────────────────────────
    // Push a fully-populated bucket. Wait-free. If the ring is full, drops the
    // NEW bucket, increments the dropped-bucket counter, and returns false.
    // See overflow-policy note at top of file.
    bool push(const TBucket& bucket) noexcept
    {
        const uint32_t wp = writePos_.load(std::memory_order_relaxed);
        const uint32_t rp = readPos_.load(std::memory_order_acquire);

        // (wp - rp) is the number of in-flight buckets, computed in unsigned
        // 32-bit arithmetic — wraps correctly on overflow.
        if ((wp - rp) >= capacity_)
        {
            droppedBuckets_.fetch_add(1, std::memory_order_relaxed);
            return false;
        }

        ring_[wp & mask_] = bucket;
        writePos_.store(wp + 1, std::memory_order_release);
        return true;
    }

    // Dropped-bucket counter (relaxed; for diagnostics only). A sustained
    // non-zero value here means the UI has stalled for >1.4 s and the audio
    // thread is silently dropping NEW buckets to keep its wait-free guarantee.
    // Read from any thread.
    uint64_t droppedBuckets() const noexcept
    {
        return droppedBuckets_.load(std::memory_order_relaxed);
    }

    // Number of audio samples per bucket (mirrors kDynamicsVizBucketSize).
    uint32_t bucketSamples() const noexcept { return bucketSamples_; }

    // Reset all SPSC indices. Main thread only — call before audio is running,
    // or while visualization is disabled.
    void reset() noexcept
    {
        writePos_.store(0, std::memory_order_relaxed);
        readPos_.store(0, std::memory_order_relaxed);
    }

private:
    std::vector<TBucket> ring_;
    std::atomic<uint32_t> writePos_{0};
    std::atomic<uint32_t> readPos_{0};
    std::atomic<uint64_t> droppedBuckets_{0};
    uint32_t capacity_{0};   // power of two
    uint32_t mask_{0};       // capacity_ - 1
    uint32_t bucketSamples_{kDynamicsVizBucketSize};
    uint32_t vizType_{kVizTypeUnknown};
};

// ── Compressor accumulator (audio-thread helper) ─────────────────────────────
// Tracks per-bucket aggregates for the Compressor: peak input/output levels,
// max gain reduction, and last detector / I-O dot values. Plain struct, no
// virtuals. Owned by the effect; it composes with a
// DynamicsVizCollector<CompressorBucket> for the ring.
//
// Usage per sample (audio thread):
//     accum.observe(absIn, absOut, envDB, grDB, ioInDb, ioOutDb);
//     accum.advance(currentSampleClock, collector);
class CompressorBucketAccumulator
{
public:
    void reset() noexcept { *this = CompressorBucketAccumulator{}; }

    // Audio-thread per-sample observation. Cheap scalar maths only.
    inline void observe(float absIn,
                        float absOut,
                        float envDb,
                        float grDb,
                        float ioInDb,
                        float ioOutDb) noexcept
    {
        if (absIn  > peakAbsIn_)  peakAbsIn_  = absIn;
        if (absOut > peakAbsOut_) peakAbsOut_ = absOut;
        if (grDb   > maxGrDb_)    maxGrDb_    = grDb;
        lastDetectorDb_ = envDb;
        lastIoInDb_     = ioInDb;
        lastIoOutDb_    = ioOutDb;
        ++sampleCount_;
    }

    // Advance bucket sample counter and, when full, emit a bucket to the ring.
    // Call once per sample after observe(). Wait-free, no allocations.
    inline void advance(uint64_t bucketEndSampleClock,
                        DynamicsVizCollector<CompressorBucket>& collector) noexcept
    {
        if (sampleCount_ >= collector.bucketSamples())
        {
            CompressorBucket b{};
            // sampleClock = first sample index of this bucket.
            b.hdr.sampleClock   = bucketEndSampleClock + 1u - sampleCount_;
            b.hdr.bucketSamples = sampleCount_;
            b.hdr.flags         = flags_;
            // Convert peak abs → dB once per bucket (cheap; ≤ 750 Hz).
            b.inLevelDb  = absToDb(peakAbsIn_);
            b.outLevelDb = absToDb(peakAbsOut_);
            b.detectorDb = lastDetectorDb_;
            b.grDb       = maxGrDb_;
            b.ioInDb     = lastIoInDb_;
            b.ioOutDb    = lastIoOutDb_;

            // push() returns false on overflow — we drop the new bucket
            // silently to keep the audio thread wait-free.
            (void) collector.push(b);

            peakAbsIn_   = 0.0f;
            peakAbsOut_  = 0.0f;
            maxGrDb_     = 0.0f;
            sampleCount_ = 0;
            flags_       = 0u;
        }
    }

private:
    static inline float absToDb(float a) noexcept
    {
        // Below -120 dB → floor; avoids log(0).
        if (a < 1.0e-6f) return -120.0f;
        return 20.0f * std::log10(a);
    }

    float    peakAbsIn_     {0.0f};
    float    peakAbsOut_    {0.0f};
    float    maxGrDb_       {0.0f};
    float    lastDetectorDb_{-120.0f};
    float    lastIoInDb_    {-120.0f};
    float    lastIoOutDb_   {-120.0f};
    uint32_t sampleCount_   {0};
    uint32_t flags_         {0};
};

// ── Limiter accumulator (audio-thread helper) ────────────────────────────────
// Tracks per-bucket aggregates for the Limiter: peak input/output levels,
// max gain reduction, mean-square energy (cheap RMS-like trace), and the last
// snapshot of smoothed ceiling/gain/release parameters. Composes with
// DynamicsVizCollector<LimiterBucket>.
//
// Usage per sample (audio thread):
//     accum.observe(absIn, absOut, msIn, msOut, grDb,
//                   ceilingDb, gainDb, releaseMs);
//     accum.advance(currentSampleClock, collector);
//
// "msIn" / "msOut" are squared-sample contributions (xÂ²). The accumulator
// integrates them over the bucket and emits 10*log10(meanSq) at flush time.
// This is a cheap energy-like trace — it is NOT calibrated to any LUFS or
// ITU-R BS.1770 standard.
class LimiterBucketAccumulator
{
public:
    void reset() noexcept { *this = LimiterBucketAccumulator{}; }

    inline void observe(float absIn,
                        float absOut,
                        float msIn,
                        float msOut,
                        float grDb,
                        float ceilingDb,
                        float gainDb,
                        float releaseMs) noexcept
    {
        if (absIn  > peakAbsIn_)  peakAbsIn_  = absIn;
        if (absOut > peakAbsOut_) peakAbsOut_ = absOut;
        if (grDb   > maxGrDb_)    maxGrDb_    = grDb;
        sumMsIn_  += msIn;
        sumMsOut_ += msOut;
        lastCeilingDb_ = ceilingDb;
        lastGainDb_    = gainDb;
        lastReleaseMs_ = releaseMs;
        ++sampleCount_;
    }

    inline void advance(uint64_t bucketEndSampleClock,
                        DynamicsVizCollector<LimiterBucket>& collector) noexcept
    {
        if (sampleCount_ >= collector.bucketSamples())
        {
            LimiterBucket b{};
            b.hdr.sampleClock   = bucketEndSampleClock + 1u - sampleCount_;
            b.hdr.bucketSamples = sampleCount_;
            b.hdr.flags         = flags_;
            b.inLevelDb         = absToDb(peakAbsIn_);
            b.outLevelDb        = absToDb(peakAbsOut_);
            b.gainReductionDb   = maxGrDb_;
            b.inEnergyDb        = msToDb(sumMsIn_  / static_cast<float>(sampleCount_));
            b.outEnergyDb       = msToDb(sumMsOut_ / static_cast<float>(sampleCount_));
            b.ceilingDb         = lastCeilingDb_;
            b.gainDb            = lastGainDb_;
            b.releaseMs         = lastReleaseMs_;
            b.reserved0         = 0.0f;

            (void) collector.push(b);

            peakAbsIn_   = 0.0f;
            peakAbsOut_  = 0.0f;
            maxGrDb_     = 0.0f;
            sumMsIn_     = 0.0f;
            sumMsOut_    = 0.0f;
            sampleCount_ = 0;
            flags_       = 0u;
        }
    }

private:
    static inline float absToDb(float a) noexcept
    {
        if (a < 1.0e-6f) return -120.0f;
        return 20.0f * std::log10(a);
    }

    static inline float msToDb(float meanSq) noexcept
    {
        if (meanSq < 1.0e-12f) return -120.0f;
        return 10.0f * std::log10(meanSq);
    }

    float    peakAbsIn_     {0.0f};
    float    peakAbsOut_    {0.0f};
    float    maxGrDb_       {0.0f};
    float    sumMsIn_       {0.0f};
    float    sumMsOut_      {0.0f};
    float    lastCeilingDb_ {0.0f};
    float    lastGainDb_    {0.0f};
    float    lastReleaseMs_ {0.0f};
    uint32_t sampleCount_   {0};
    uint32_t flags_         {0};
};

// ── Transient accumulator (audio-thread helper) ─────────────────────────────
// Tracks per-bucket aggregates for the Transient Processor: peak input/output
// levels, last-sample envelope follower outputs (fast + slow), last-sample
// signed gain (positive = boost, negative = cut), and the current snapshot of
// shaping params. Composes with DynamicsVizCollector<TransientBucket>.
//
// observe() is called per sample with the linear (pre-dB) values; the
// accumulator converts to dB once per bucket at flush time. Pass NaN for
// fastEnvLin / slowEnvLin when the envelope followers are not running
// (e.g. MIDI mode) — the bucket's fastEnvDb / slowEnvDb fields will then carry
// NaN through to the JS side, which is a documented "not measured" sentinel.
//
// gainLin is the LINEAR last-sample gain applied (1.0 = unity). Converted to
// signed dB at flush; the processor's slot-2 meter uses the same convention.
class TransientBucketAccumulator
{
public:
    void reset() noexcept { *this = TransientBucketAccumulator{}; }

    inline void observe(float absIn,
                        float absOut,
                        float fastEnvLin,
                        float slowEnvLin,
                        float gainLin,
                        float attackAmount,
                        float sustainAmount,
                        float speedMs,
                        float thresholdDb,
                        float mix) noexcept
    {
        if (absIn  > peakAbsIn_)  peakAbsIn_  = absIn;
        if (absOut > peakAbsOut_) peakAbsOut_ = absOut;
        lastFastEnvLin_  = fastEnvLin;   // may be NaN in MIDI mode
        lastSlowEnvLin_  = slowEnvLin;   // may be NaN in MIDI mode
        lastGainLin_     = gainLin;
        lastAttack_      = attackAmount;
        lastSustain_     = sustainAmount;
        lastSpeedMs_     = speedMs;
        lastThresholdDb_ = thresholdDb;
        lastMix_         = mix;
        ++sampleCount_;
    }

    inline void advance(uint64_t bucketEndSampleClock,
                        DynamicsVizCollector<TransientBucket>& collector) noexcept
    {
        if (sampleCount_ >= collector.bucketSamples())
        {
            TransientBucket b{};
            b.hdr.sampleClock   = bucketEndSampleClock + 1u - sampleCount_;
            b.hdr.bucketSamples = sampleCount_;
            b.hdr.flags         = flags_;
            b.inLevelDb         = absToDb(peakAbsIn_);
            b.outLevelDb        = absToDb(peakAbsOut_);
            b.fastEnvDb         = envToDb(lastFastEnvLin_);
            b.slowEnvDb         = envToDb(lastSlowEnvLin_);
            b.gainDb            = gainToSignedDb(lastGainLin_);
            b.attackAmount      = lastAttack_;
            b.sustainAmount     = lastSustain_;
            b.speedMs           = lastSpeedMs_;
            b.thresholdDb       = lastThresholdDb_;
            b.mix               = lastMix_;

            (void) collector.push(b);

            peakAbsIn_   = 0.0f;
            peakAbsOut_  = 0.0f;
            sampleCount_ = 0;
            flags_       = 0u;
        }
    }

private:
    static inline float absToDb(float a) noexcept
    {
        if (a < 1.0e-6f) return -120.0f;
        return 20.0f * std::log10(a);
    }

    // Envelope followers may carry NaN when not running (MIDI mode). Preserve
    // the NaN through to the bucket so the JS side can render "not measured".
    static inline float envToDb(float lin) noexcept
    {
        if (std::isnan(lin)) return std::numeric_limits<float>::quiet_NaN();
        return absToDb(lin);
    }

    // Signed gain in dB. Linear gain near 1.0 → 0 dB, > 1 → positive (boost),
    // < 1 → negative (cut). Floors at ±60 dB to keep the painter sane on the
    // first few samples after enable when gainLin can be tiny.
    static inline float gainToSignedDb(float gainLin) noexcept
    {
        if (gainLin < 1.0e-6f) return -60.0f;
        return 20.0f * std::log10(gainLin);
    }

    float    peakAbsIn_       {0.0f};
    float    peakAbsOut_      {0.0f};
    float    lastFastEnvLin_  {std::numeric_limits<float>::quiet_NaN()};
    float    lastSlowEnvLin_  {std::numeric_limits<float>::quiet_NaN()};
    float    lastGainLin_     {1.0f};
    float    lastAttack_      {0.0f};
    float    lastSustain_     {0.0f};
    float    lastSpeedMs_     {0.0f};
    float    lastThresholdDb_ {-60.0f};
    float    lastMix_         {1.0f};
    uint32_t sampleCount_     {0};
    uint32_t flags_           {0};
};

// ── Multiband accumulator (audio-thread helper) ─────────────────────────────
// Tracks per-bucket aggregates for the 3-band Overdone effect: global peak
// input/output, per-band peak input/output, max GR per band (dB, positive),
// and a snapshot of smoothed depth / time / crossover params. Composes with
// DynamicsVizCollector<MultibandBucket>.
//
// observe() is called once per audio sample with the LINEAR pre-dB peak
// values — the accumulator converts to dB once per bucket at flush time. The
// per-band absLowL / absLowR style inputs are the band signal post-crossover
// pre-gain; absLowOut / absMidOut / absHighOut are the band signal post-gain.
// grLowDb / grMidDb / grHighDb are positive-dB GR computed by the effect's
// gain-computer — passing 0 when the band is below threshold is fine.
class MultibandBucketAccumulator
{
public:
    void reset() noexcept { *this = MultibandBucketAccumulator{}; }

    inline void observe(float absInGlobal,   float absOutGlobal,
                        float absLowIn,      float absLowOut,   float grLowDb,
                        float absMidIn,      float absMidOut,   float grMidDb,
                        float absHighIn,     float absHighOut,  float grHighDb,
                        float depthPct,      float timePct,
                        float lowXoverHz,    float highXoverHz) noexcept
    {
        if (absInGlobal  > peakAbsIn_)        peakAbsIn_       = absInGlobal;
        if (absOutGlobal > peakAbsOut_)       peakAbsOut_      = absOutGlobal;
        if (absLowIn     > peakAbsLowIn_)     peakAbsLowIn_    = absLowIn;
        if (absLowOut    > peakAbsLowOut_)    peakAbsLowOut_   = absLowOut;
        if (absMidIn     > peakAbsMidIn_)     peakAbsMidIn_    = absMidIn;
        if (absMidOut    > peakAbsMidOut_)    peakAbsMidOut_   = absMidOut;
        if (absHighIn    > peakAbsHighIn_)    peakAbsHighIn_   = absHighIn;
        if (absHighOut   > peakAbsHighOut_)   peakAbsHighOut_  = absHighOut;
        if (grLowDb      > maxGrLowDb_)       maxGrLowDb_      = grLowDb;
        if (grMidDb      > maxGrMidDb_)       maxGrMidDb_      = grMidDb;
        if (grHighDb     > maxGrHighDb_)      maxGrHighDb_     = grHighDb;
        lastDepth_     = depthPct;
        lastTime_      = timePct;
        lastLowXover_  = lowXoverHz;
        lastHighXover_ = highXoverHz;
        ++sampleCount_;
    }

    inline void advance(uint64_t bucketEndSampleClock,
                        DynamicsVizCollector<MultibandBucket>& collector) noexcept
    {
        if (sampleCount_ >= collector.bucketSamples())
        {
            MultibandBucket b{};
            b.hdr.sampleClock      = bucketEndSampleClock + 1u - sampleCount_;
            b.hdr.bucketSamples    = sampleCount_;
            b.hdr.flags            = flags_;
            b.inputPeakDb          = absToDb(peakAbsIn_);
            b.outputPeakDb         = absToDb(peakAbsOut_);
            b.depth                = lastDepth_;
            b.time                 = lastTime_;
            b.lowCrossoverHz       = lastLowXover_;
            b.highCrossoverHz      = lastHighXover_;
            b.lowInputDb           = absToDb(peakAbsLowIn_);
            b.lowOutputDb          = absToDb(peakAbsLowOut_);
            b.lowGainReductionDb   = maxGrLowDb_;
            b.midInputDb           = absToDb(peakAbsMidIn_);
            b.midOutputDb          = absToDb(peakAbsMidOut_);
            b.midGainReductionDb   = maxGrMidDb_;
            b.highInputDb          = absToDb(peakAbsHighIn_);
            b.highOutputDb         = absToDb(peakAbsHighOut_);
            b.highGainReductionDb  = maxGrHighDb_;
            b.reserved0            = 0.0f;

            (void) collector.push(b);

            peakAbsIn_       = 0.0f;
            peakAbsOut_      = 0.0f;
            peakAbsLowIn_    = 0.0f;
            peakAbsLowOut_   = 0.0f;
            peakAbsMidIn_    = 0.0f;
            peakAbsMidOut_   = 0.0f;
            peakAbsHighIn_   = 0.0f;
            peakAbsHighOut_  = 0.0f;
            maxGrLowDb_      = 0.0f;
            maxGrMidDb_      = 0.0f;
            maxGrHighDb_     = 0.0f;
            sampleCount_     = 0;
            flags_           = 0u;
        }
    }

private:
    static inline float absToDb(float a) noexcept
    {
        if (a < 1.0e-6f) return -120.0f;
        return 20.0f * std::log10(a);
    }

    float    peakAbsIn_       {0.0f};
    float    peakAbsOut_      {0.0f};
    float    peakAbsLowIn_    {0.0f};
    float    peakAbsLowOut_   {0.0f};
    float    peakAbsMidIn_    {0.0f};
    float    peakAbsMidOut_   {0.0f};
    float    peakAbsHighIn_   {0.0f};
    float    peakAbsHighOut_  {0.0f};
    float    maxGrLowDb_      {0.0f};
    float    maxGrMidDb_      {0.0f};
    float    maxGrHighDb_     {0.0f};
    float    lastDepth_       {0.0f};
    float    lastTime_        {0.0f};
    float    lastLowXover_    {88.0f};
    float    lastHighXover_   {2500.0f};
    uint32_t sampleCount_     {0};
    uint32_t flags_           {0};
};

}} // namespace xleth::viz
