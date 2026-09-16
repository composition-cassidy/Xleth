#include "audio/ClipRenderCache.h"
#include "audio/WorldStretchCache.h"
#include "dsp/DryWetAlign.h"
#include "dsp/RubberBandWrapper.h"
#include "dsp/TDPSOLA.h"
#include "dsp/WSOLA.h"
#include "dsp/PhaseVocoder.h"
#include "dsp/WORLD.h"
#include "dsp/StretchInputFloor.h"
#include "model/TimelineTypes.h"
#include "XlethDebug.h"

#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstring>
#include <iostream>
#include <thread>

// ─── CacheKey ==  ────────────────────────────────────────────────────────────

bool CacheKey::operator==(const CacheKey& o) const noexcept {
    return regionId            == o.regionId
        && syllableIndex       == o.syllableIndex
        && regionOffsetSamples == o.regionOffsetSamples
        && durationSamples     == o.durationSamples
        && sourceLengthSamples == o.sourceLengthSamples
        && pitchOffsetSemis    == o.pitchOffsetSemis
        && pitchOffsetCents    == o.pitchOffsetCents
        && reversed            == o.reversed
        && stretchRatio        == o.stretchRatio
        && stretchMethod       == o.stretchMethod
        && formantPreserve     == o.formantPreserve
        && fxPitchSemis        == o.fxPitchSemis
        && fxPitchCents        == o.fxPitchCents
        && fxMethod            == o.fxMethod
        && fxFormant           == o.fxFormant;
}

size_t CacheKeyHash::operator()(const CacheKey& k) const noexcept {
    // FNV-1a over the key's byte-comparable fields. stretchRatio is hashed by
    // bit pattern, which is exactly what operator== compares it by.
    size_t h = 1469598103934665603ULL;
    auto mix = [&h](uint64_t v) {
        for (int i = 0; i < 8; ++i) {
            h ^= static_cast<size_t>(v & 0xFF);
            h *= 1099511628211ULL;
            v >>= 8;
        }
    };
    uint64_t ratioBits = 0;
    static_assert(sizeof(ratioBits) == sizeof(k.stretchRatio), "double is 64-bit");
    std::memcpy(&ratioBits, &k.stretchRatio, sizeof(ratioBits));

    mix(static_cast<uint64_t>(static_cast<uint32_t>(k.regionId)));
    mix(static_cast<uint64_t>(static_cast<uint32_t>(k.syllableIndex)));
    mix(static_cast<uint64_t>(k.regionOffsetSamples));
    mix(static_cast<uint64_t>(k.durationSamples));
    mix(static_cast<uint64_t>(k.sourceLengthSamples));
    mix(static_cast<uint64_t>(static_cast<uint32_t>(k.pitchOffsetSemis)));
    mix(static_cast<uint64_t>(static_cast<uint32_t>(k.pitchOffsetCents)));
    mix(ratioBits);
    mix(static_cast<uint64_t>(static_cast<uint32_t>(k.stretchMethod)));
    mix(static_cast<uint64_t>((k.reversed ? 1u : 0u) | (k.formantPreserve ? 2u : 0u)));
    mix(static_cast<uint64_t>(static_cast<uint32_t>(k.fxPitchSemis)));
    mix(static_cast<uint64_t>(static_cast<uint32_t>(k.fxPitchCents)));
    mix(static_cast<uint64_t>(static_cast<uint32_t>(k.fxMethod))
        | (static_cast<uint64_t>(k.fxFormant ? 1u : 0u) << 32));
    return h;
}

// ─── Effective render ────────────────────────────────────────────────────────

EffectiveRender resolveEffectiveRender(const CacheKey& key) noexcept {
    EffectiveRender r;
    if (!key.hasFx()) {
        // The original render: the key's own fields, verbatim. Nothing is
        // normalised here — this path must stay bit-identical to the cache as
        // it was before fx transforms existed.
        r.pitchSemis      = key.pitchOffsetSemis;
        r.pitchCents      = key.pitchOffsetCents;
        r.method          = key.stretchMethod;
        r.formantPreserve = key.formantPreserve;
        return r;
    }
    int totalCents = (key.pitchOffsetSemis + key.fxPitchSemis) * 100
                   + key.pitchOffsetCents + key.fxPitchCents;
    totalCents = std::clamp(totalCents, -kMaxEffectiveSemis * 100, kMaxEffectiveSemis * 100);
    r.pitchSemis      = totalCents / 100;   // truncation: semis and cents share a sign
    r.pitchCents      = totalCents % 100;
    r.method          = key.fxMethod;
    r.formantPreserve = key.fxFormant;
    r.forceEngine     = true;
    return r;
}

// ─── Segment render ──────────────────────────────────────────────────────────
// The DSP half of a render job: build the prepared-rate source segment and run
// it through the effective engine. Returns the engine's whole output (or the
// raw segment, for a render that needs no engine) and how many of its samples
// are real. Copying into the clip's durationSamples-long buffer is the
// caller's job, because an fx render aligns before it copies.

namespace {

// Lookahead for fx renders == the largest lag the alignment pass searches.
static constexpr double kFxLookaheadSeconds = 0.1;

struct SegmentRender {
    std::shared_ptr<const juce::AudioBuffer<float>> processed;
    int64_t valid = 0;
};

SegmentRender renderSegment(const CacheKey&                  key,
                            const EffectiveRender&           eff,
                            const juce::AudioBuffer<float>&  srcCopy,
                            double                           sampleRate,
                            double                           bufferSampleRate,
                            xleth::audio::WorldStretchCache* worldCache)
{
    SegmentRender out;

    const int  numCh      = srcCopy.getNumChannels();
    const int64_t regOff  = key.regionOffsetSamples;
    const int64_t durSamp = key.durationSamples;
    const int srcTotal    = srcCopy.getNumSamples();

    // How many source frames we can actually read.
    // When time-stretching, the stretcher multiplies our input length by
    // stretchRatio, so to produce exactly durSamp output samples we must
    // read durSamp / stretchRatio source samples. For unity ratio this
    // collapses to the original durSamp, preserving the no-stretch path.
    const bool willStretch  = (std::abs(key.stretchRatio - 1.0) > 1e-4);
    const double effRatio   = (willStretch && key.stretchRatio > 0.0)
                            ? key.stretchRatio
                            : 1.0;
    // An fx render reads kFxLookaheadSeconds of source past the clip end, so
    // when alignment pulls a late wet earlier its tail is real engine output
    // rather than padding. Original renders read exactly what they always did.
    const int64_t fxLookahead = key.hasFx()
        ? static_cast<int64_t>(std::llround(kFxLookaheadSeconds * sampleRate / effRatio))
        : 0;
    const int64_t srcReadNeeded = static_cast<int64_t>(
        std::llround(static_cast<double>(durSamp) / effRatio)) + fxLookahead;

    // ── Stretch-engine input floor (short-clip pitch-drop guard) ─────────
    // PSOLA/WSOLA/PhaseVocoder varispeed anything shorter than one analysis
    // window instead of stretching it, which transposes the clip DOWN by the
    // stretch ratio. Since the input we hand them is durSamp / ratio, a big
    // stretch on a short clip lands under the floor easily (at 8× a 300 ms
    // clip is a 37 ms input, under PSOLA's 50 ms). Read PAST what the clip
    // needs — the trimmed-away audio is sitting right there in the region
    // buffer — and let the caller drop the surplus output. Output alignment
    // is unaffected: extra input only ever appends.
    const int64_t srcReadFloor = willStretch
        ? static_cast<int64_t>(xleth::dsp::minStretchInputSamples(
              eff.method, sampleRate,
              eff.pitchSemis + eff.pitchCents / 100.0))
        : 0;
    const int64_t srcReadDesired = std::max(srcReadNeeded, srcReadFloor);

    // Bake-rate → prepared-rate correction. srcCopy is stored at the bake
    // rate; the cache output and the pitch/stretch engines run at the
    // prepared rate (sampleRate). When they differ we resample the source
    // region bake→prepared via Lagrange BEFORE pitch/stretch so the cached
    // clip preserves pitch (mirrors the raw clip path in MixEngine). At
    // matched rate the original memcpy/reverse fast path is kept bit-for-bit.
    const double srFactor = (bufferSampleRate > 0.0 && sampleRate > 0.0)
                          ? bufferSampleRate / sampleRate : 1.0;
    const bool   matchedRate = std::abs(srFactor - 1.0) < 1e-9;

    // regOff and srcReadDesired are prepared-rate counts; the bake buffer is
    // indexed at prepared-index * srFactor.
    const int64_t readStart = matchedRate
        ? regOff
        : static_cast<int64_t>(std::llround(static_cast<double>(regOff) * srFactor));
    const int64_t readAvail = static_cast<int64_t>(srcTotal) - readStart;

    // readLen = number of PREPARED-rate samples `working` holds (post-resample).
    int64_t readLen = 0;
    if (matchedRate) {
        readLen = std::min(srcReadDesired, std::max(int64_t(0), readAvail));
    } else if (readAvail > 1) {
        // Prepared samples producible from the available bake source, with
        // one sample of Lagrange interpolation headroom.
        const int64_t maxProducible = static_cast<int64_t>(
            std::floor(static_cast<double>(readAvail - 1) / srFactor));
        readLen = std::min(srcReadDesired, std::max(int64_t(0), maxProducible));
    }

    if (!(numCh > 0 && readLen > 0 && readStart >= 0 && readStart < srcTotal))
        return out;

    // ── a) Build the prepared-rate source segment ───────────────────────
    // matchedRate: verbatim reverse/copy (bit-for-bit legacy path).
    // else: resample bake→prepared via Lagrange, then reverse in place.
    // If the source itself ran out before the engine's input floor (clip
    // sits at the very tail of the region), zero-pad up to the floor
    // rather than let the engine varispeed. The padding is silence the
    // clip would have played anyway, and it lands after the real audio,
    // so the kept output (first durSamp) still starts at readStart.
    const int64_t workLen = std::max(readLen, srcReadFloor);
    auto working = std::make_shared<juce::AudioBuffer<float>>(numCh, static_cast<int>(workLen));
    if (workLen > readLen) working->clear();
    if (matchedRate) {
        for (int ch = 0; ch < numCh; ++ch) {
            const float* src = srcCopy.getReadPointer(ch);
            float*       dst = working->getWritePointer(ch);
            if (key.reversed) {
                for (int64_t i = 0; i < readLen; ++i)
                    dst[i] = src[readStart + (readLen - 1 - i)];
            } else {
                std::memcpy(dst, src + readStart,
                            sizeof(float) * static_cast<size_t>(readLen));
            }
        }
    } else {
        for (int ch = 0; ch < numCh; ++ch) {
            juce::LagrangeInterpolator interp;
            interp.reset();
            interp.process(srFactor,
                           srcCopy.getReadPointer(ch) + readStart,
                           working->getWritePointer(ch),
                           static_cast<int>(readLen),
                           static_cast<int>(readAvail),
                           0);
            if (key.reversed) {
                float* dst = working->getWritePointer(ch);
                std::reverse(dst, dst + static_cast<int>(readLen));
            }
        }
    }

    // ── b) Pitch / stretch ────────────────────────────────────────────────
    const bool needsPitch   = (eff.pitchSemis != 0 || eff.pitchCents != 0);
    const bool needsStretch = (std::abs(key.stretchRatio - 1.0) > 1e-4);
    const bool runEngine    = needsPitch || needsStretch || eff.forceEngine;

    auto take = [&out](juce::AudioBuffer<float>&& processed) {
        out.valid     = processed.getNumSamples();
        out.processed = std::make_shared<juce::AudioBuffer<float>>(std::move(processed));
    };

    if (runEngine && eff.method == 1 /*PSOLA*/) {
        xleth::dsp::PSOLAParams p;
        p.sampleRate       = sampleRate;
        p.pitchOffsetSemis = eff.pitchSemis;
        p.pitchOffsetCents = eff.pitchCents;
        p.stretchRatio     = key.stretchRatio;
        p.formantPreserve  = eff.formantPreserve;
        take(xleth::dsp::processTDPSOLA(*working, p));
    } else if (runEngine && eff.method == 2 /*Rubber*/) {
        xleth::dsp::RubberBandParams p;
        p.sampleRate          = sampleRate;
        p.pitchShiftSemitones = eff.pitchSemis + eff.pitchCents / 100.0;
        p.stretchRatio        = key.stretchRatio;
        p.formantPreserve     = eff.formantPreserve;
        take(xleth::dsp::processRubberBand(*working, p));
    } else if (runEngine && eff.method == 3 /*WSOLA*/) {
        xleth::dsp::WSOLAParams p;
        p.sampleRate          = sampleRate;
        p.pitchShiftSemitones = eff.pitchSemis + eff.pitchCents / 100.0;
        p.stretchRatio        = key.stretchRatio;
        p.formantPreserve     = eff.formantPreserve;
        take(xleth::dsp::processWSOLA(*working, p));
    } else if (runEngine && eff.method == 4 /*PhaseVocoder*/) {
        xleth::dsp::PhaseVocoderParams p;
        p.sampleRate          = sampleRate;
        p.pitchShiftSemitones = eff.pitchSemis + eff.pitchCents / 100.0;
        p.stretchRatio        = key.stretchRatio;
        p.formantPreserve     = eff.formantPreserve;
        take(xleth::dsp::processPhaseVocoder(*working, p));
    } else if (runEngine && eff.method == static_cast<int>(StretchMethod::WORLD)) {
        xleth::dsp::WORLDParams p;
        p.sampleRate          = sampleRate;
        p.pitchShiftSemitones = eff.pitchSemis + eff.pitchCents / 100.0;
        p.stretchRatio        = key.stretchRatio;
        p.formantPreserve     = eff.formantPreserve;

        if (worldCache) {
            xleth::audio::WorldCacheKey wk;
            wk.sourceHash   = xleth::audio::WorldStretchCache::hashPCM(*working);
            wk.pitchMilliSt = static_cast<int32_t>(
                std::lround(p.pitchShiftSemitones * 1000.0));
            wk.ratioMicro   = static_cast<int32_t>(
                std::lround(p.stretchRatio * 1000.0));
            wk.sampleRateHz = static_cast<int32_t>(std::lround(sampleRate));
            wk.numChannels  = working->getNumChannels();
            if (auto buf = worldCache->getOrCompute(wk, *working, p)) {
                out.valid     = buf->getNumSamples();
                out.processed = std::move(buf);
            }
        } else {
            take(xleth::dsp::processWORLD(*working, p));
        }
    } else {
        // Raw copy — Global stub or no processing needed. The caller clamps
        // to durSamp: with ratio < 1 (or a padded `working`) the segment can
        // be longer than the clip's own output buffer.
        out.valid     = readLen;
        out.processed = std::move(working);
    }
    return out;
}

// Copy [srcOffset, srcOffset + durSamp) of `seg` into outBuf (pre-cleared,
// durSamp long). Source samples outside [0, seg.valid) stay silent. With
// srcOffset == 0 this is exactly the pre-alignment copy.
void copySegment(const SegmentRender& seg, int64_t srcOffset,
                 juce::AudioBuffer<float>& outBuf, int64_t durSamp)
{
    if (!seg.processed) return;
    const int64_t valid = std::min<int64_t>(seg.valid, seg.processed->getNumSamples());
    const int64_t dstStart = std::max<int64_t>(0, -srcOffset);
    const int64_t srcStart = srcOffset + dstStart;
    const int64_t n = std::min(durSamp - dstStart, valid - srcStart);
    if (n <= 0) return;
    const int copyCh = std::min(seg.processed->getNumChannels(), outBuf.getNumChannels());
    for (int ch = 0; ch < copyCh; ++ch)
        outBuf.copyFrom(ch, static_cast<int>(dstStart), *seg.processed, ch,
                        static_cast<int>(srcStart), static_cast<int>(n));
}

} // namespace

// ─── ClipRenderJob ───────────────────────────────────────────────────────────
// Runs on a worker thread from the ThreadPool.

class ClipRenderJob : public juce::ThreadPoolJob {
public:
    ClipRenderJob(int                         clipId,
                  std::shared_ptr<CacheEntry> entry,
                  juce::AudioBuffer<float>    srcCopy,
                  double                      sampleRate,
                  double                      bufferSampleRate,
                  ClipRenderCache*            owner)
        : juce::ThreadPoolJob("ClipRender")
        , clipId_    (clipId)
        , entry_     (std::move(entry))
        , srcCopy_   (std::move(srcCopy))
        , sampleRate_(sampleRate)
        , bufferSampleRate_(bufferSampleRate)
        , owner_     (owner)
    {}

    JobStatus runJob() override {
        juce::ScopedNoDenormals noDenormals;
#ifdef XLETH_DEBUG
        const auto jobStart = std::chrono::steady_clock::now();
        fprintf(stderr, "[CacheQueue] START clip=%d\n", clipId_);
        fflush(stderr);
#endif

        const CacheKey& key   = entry_->key;
        const EffectiveRender eff = resolveEffectiveRender(key);
        const int  numCh      = srcCopy_.getNumChannels();
        const int64_t durSamp = key.durationSamples;
        const int srcTotal    = srcCopy_.getNumSamples();

        // Warn for very long clips (>10 s)
        const double durationSec = static_cast<double>(durSamp) / sampleRate_;
#ifdef XLETH_DEBUG
        fprintf(stderr, "[ClipCache] submit-run: clip=%d region=%d pitch=%dst+%dc"
                " stretch=%.4f rev=%d method=%d formant=%d fx=%dst+%dc/%d/%d src=%d dur=%lld\n",
                clipId_, key.regionId,
                key.pitchOffsetSemis, key.pitchOffsetCents,
                key.stretchRatio, (int)key.reversed,
                key.stretchMethod, (int)key.formantPreserve,
                key.fxPitchSemis, key.fxPitchCents, key.fxMethod, (int)key.fxFormant,
                srcTotal, (long long)durSamp);
        if (durationSec > 10.0)
            fprintf(stderr, "[ClipCache] warn: clip=%d source length %d samples"
                    " (%.1fs >10s) — cache designed for short clips\n",
                    clipId_, srcTotal, durationSec);
#else
        (void) srcTotal;
        if (durationSec > 10.0) {
            std::cout << "[ClipRenderCache] WARNING: clip " << clipId_
                      << " is " << durationSec << "s (>10 s) — render may be slow\n"
                      << std::flush;
        }
#endif

        // outBuf is clip-local post-processing output: CacheKey::regionOffsetSamples
        // is consumed while building the segment, and processed samples are
        // copied back starting at sample 0 for exactly durationSamples. Its
        // length never depends on what an engine produced.
        auto outBuf = std::make_shared<juce::AudioBuffer<float>>(
            std::max(1, numCh), static_cast<int>(durSamp));
        outBuf->clear();

        const SegmentRender wet = renderSegment(key, eff, srcCopy_, sampleRate_,
                                                bufferSampleRate_, owner_->worldCache());

        if (!key.hasFx()) {
            copySegment(wet, 0, *outBuf, durSamp);
        } else {
            alignAndCopy(key, wet, *outBuf);
        }

        entry_->buffer = std::move(outBuf);
        entry_->ready.store(true, std::memory_order_release);

        if (eff.method == static_cast<int>(StretchMethod::WORLD)) {
            std::lock_guard<std::mutex> lk(owner_->cacheMutex_);
            owner_->worldActiveEntries_.erase(entry_.get());
        }

        // Publish LAST: it fans the finished buffer out to every clip sharing
        // this entry, so the WORLD spinner must already be cleared by then.
        owner_->publishEntry(clipId_, entry_);

#ifdef XLETH_DEBUG
        {
            const auto ms = std::chrono::duration_cast<std::chrono::milliseconds>(
                std::chrono::steady_clock::now() - jobStart).count();
            const int outSamples = entry_->buffer ? entry_->buffer->getNumSamples() : 0;
            fprintf(stderr, "[ClipCache] complete: clip=%d rendered %lld→%d samples in %lldms"
                    " engine=%lld\n",
                    clipId_, (long long)durSamp, outSamples, (long long)ms,
                    (long long)wet.valid);
            fflush(stderr);
        }
#endif

        return JobStatus::jobHasFinished;
    }

private:
    // ── Dry/wet alignment (fx renders only) ─────────────────────────────────
    // The wet is blended against the clip's ORIGINAL render (or its raw PCM,
    // which is what the original render is for an identity clip). Measure the
    // wet's lag against exactly that signal, then copy the wet into outBuf
    // shifted by it. outBuf's length is fixed; a late wet is trimmed at the
    // head and a short tail is reported as undershoot, never stretched to fit.
    void alignAndCopy(const CacheKey& key, const SegmentRender& wet,
                      juce::AudioBuffer<float>& outBuf)
    {
        const int64_t durSamp = key.durationSamples;
        ClipAlignmentReport& rep = entry_->alignment;
        rep.measured      = true;
        rep.engineSamples = wet.valid;

        CacheKey dryKey     = key;
        dryKey.fxPitchSemis = 0;
        dryKey.fxPitchCents = 0;
        dryKey.fxMethod     = 0;
        dryKey.fxFormant    = false;

        // The original render is usually already in the cache (or rendering
        // beside us); reuse a finished one rather than paying for it twice.
        SegmentRender dry;
        {
            std::lock_guard<std::mutex> lk(owner_->cacheMutex_);
            auto it = owner_->byKey_.find(dryKey);
            if (it != owner_->byKey_.end() && it->second
                && it->second->ready.load(std::memory_order_acquire)
                && it->second->buffer) {
                dry.processed = it->second->buffer;
                dry.valid     = it->second->buffer->getNumSamples();
            }
        }
        if (!dry.processed)
            dry = renderSegment(dryKey, resolveEffectiveRender(dryKey), srcCopy_,
                                sampleRate_, bufferSampleRate_, owner_->worldCache());

        const int64_t dryLen = std::min(dry.valid, durSamp);
        const int64_t wetLen = wet.valid;

        xleth::dsp::LagEstimate est;
        if (dry.processed && wet.processed && dryLen > 0 && wetLen > 0) {
            const bool samePitch = (key.fxPitchSemis * 100 + key.fxPitchCents) == 0;
            const int  maxLag    = static_cast<int>(std::lround(kFxLookaheadSeconds * sampleRate_));
            est = xleth::dsp::estimateWetLag(*dry.processed, static_cast<int>(dryLen),
                                             *wet.processed,
                                             static_cast<int>(std::min<int64_t>(wetLen, wet.processed->getNumSamples())),
                                             maxLag, samePitch, sampleRate_);
        }

        rep.basis       = static_cast<int>(est.basis);
        rep.peak        = est.peak;
        rep.measuredLag = est.lagSamples;
        rep.confident   = est.confident;
        rep.appliedLag  = est.confident ? est.lagSamples : 0;

        copySegment(wet, rep.appliedLag, outBuf, durSamp);

        // Trailing samples the dry has content for but the shifted wet cannot
        // fill: the engine undershot (or the compensation consumed the tail).
        const int64_t wetEnd = wetLen - rep.appliedLag;
        rep.undershootSamples = std::clamp<int64_t>(dryLen - wetEnd, 0, durSamp);

        if (!rep.confident) {
            owner_->unalignedRenders_.fetch_add(1, std::memory_order_relaxed);
            // Worker thread — a log line is fine here. Reported, not hidden:
            // the wet is left where the engine put it.
            fprintf(stderr, "[ClipCache] fx align: clip=%d method=%d fx=%dst+%dc NOT CONFIDENT"
                    " (basis=%d peak=%.3f lag=%d) — wet left uncompensated\n",
                    clipId_, key.fxMethod, key.fxPitchSemis, key.fxPitchCents,
                    rep.basis, rep.peak, rep.measuredLag);
        }
#ifdef XLETH_DEBUG
        fprintf(stderr, "[ClipCache] fx align: clip=%d method=%d basis=%d peak=%.3f"
                " lag=%d applied=%d undershoot=%lld\n",
                clipId_, key.fxMethod, rep.basis, rep.peak, rep.measuredLag,
                rep.appliedLag, (long long)rep.undershootSamples);
#endif
    }

    int                         clipId_;
    std::shared_ptr<CacheEntry> entry_;
    juce::AudioBuffer<float>    srcCopy_;
    double                      sampleRate_;
    double                      bufferSampleRate_;
    ClipRenderCache*            owner_;
};

// ─── ClipRenderCache ──────────────────────────────────────────────────────────

namespace {
// Workers feed a cache with a correct raw-PCM fallback, so a late worker is
// cheap and a preempting one is not: fewer threads, below-normal priority.
int clipCacheWorkerCount() {
    const int hw = (int) std::thread::hardware_concurrency();
    return juce::jlimit(1, ClipRenderCache::kMaxThreads, hw / 2 - 1);
}

size_t bufferBytes(const CacheEntry& e) noexcept {
    if (!e.buffer) return 0;
    return static_cast<size_t>(std::max(0, e.buffer->getNumChannels()))
         * static_cast<size_t>(std::max(0, e.buffer->getNumSamples()))
         * sizeof(float);
}
} // namespace

ClipRenderCache::ClipRenderCache()
    : fxSlots_(std::make_unique<Slot[]>(kMaxClipId))
    , missRing_(std::make_unique<std::atomic<int>[]>(kMissRingCapacity))
    , missPending_(std::make_unique<std::atomic<uint8_t>[]>(kMaxClipId))
    , threadPool_(std::make_unique<juce::ThreadPool>(
          juce::ThreadPool::Options{}
              .withNumberOfThreads(clipCacheWorkerCount())
              .withDesiredThreadPriority(juce::Thread::Priority::low)))
{}

ClipRenderCache::~ClipRenderCache() {
    shutdown();
}

int64_t ClipRenderCache::nowMs() noexcept {
    return std::chrono::duration_cast<std::chrono::milliseconds>(
        std::chrono::steady_clock::now().time_since_epoch()).count();
}

void ClipRenderCache::shutdown() {
    if (threadPool_) {
        threadPool_->removeAllJobs(true, 5000);
        threadPool_.reset();
    }
    for (int i = 0; i < kMaxClipId; ++i) {
        slots_[i].store(nullptr, std::memory_order_seq_cst);
        if (fxSlots_) fxSlots_[i].store(nullptr, std::memory_order_seq_cst);
    }
    std::lock_guard<std::mutex> lk(cacheMutex_);
    // lruOrder_ holds raw pointers: unlink them while the maps still own the
    // entries, never after.
    for (CacheEntry* e : lruOrder_) e->resident = false;
    lruOrder_.clear();
    cache_.clear();
    fxCache_.clear();
    byKey_.clear();
    worldActiveEntries_.clear();
    retired_.clear();
    bytesNow_.store(0, std::memory_order_relaxed);
}

// ── Audio thread ──────────────────────────────────────────────────────────────

std::shared_ptr<const CacheEntry> ClipRenderCache::acquire(
    int clipId, const CacheKey& key, int64_t nowMs) const noexcept
{
    if (clipId < 0 || clipId >= kMaxClipId) return nullptr;

    // The slot owns a reference at load time, and anything that later takes it
    // out of the slot retires it — so this copy is never the last owner.
    auto e = slotFor(clipId, key.hasFx()).load(std::memory_order_acquire);
    if (!e)                                                return nullptr;
    if (!e->ready.load(std::memory_order_acquire))         return nullptr;
    if (!(e->key == key)) {
        // [StreamUnder] stale-key churn. Counted, never logged: this runs on
        // the audio thread, where an fprintf is a hard real-time violation.
        // Read the tally via getKeyMismatchCount() from the 1s health sampler.
        keyMismatchCount_.fetch_add(1, std::memory_order_relaxed);
        return nullptr;
    }
    e->lastHitMs.store(nowMs, std::memory_order_relaxed);
    return e;
}

void ClipRenderCache::noteMiss(int clipId) noexcept
{
    if (clipId < 0 || clipId >= kMaxClipId) return;
    if (missPending_[clipId].exchange(1, std::memory_order_acq_rel) != 0) return;

    const uint32_t head = missHead_.load(std::memory_order_relaxed);
    const uint32_t tail = missTail_.load(std::memory_order_acquire);
    if (head - tail >= static_cast<uint32_t>(kMissRingCapacity)) {
        // Full: drop, and let the clip report again next block.
        missPending_[clipId].store(0, std::memory_order_relaxed);
        return;
    }
    missRing_[head & (kMissRingCapacity - 1)].store(clipId, std::memory_order_relaxed);
    missHead_.store(head + 1, std::memory_order_release);
}

// ── Message thread ────────────────────────────────────────────────────────────

std::shared_ptr<const juce::AudioBuffer<float>> ClipRenderCache::getProcessedBuffer(
    int clipId, const CacheKey& key) const noexcept
{
    if (clipId < 0 || clipId >= kMaxClipId) return nullptr;
    auto e = slotFor(clipId, key.hasFx()).load(std::memory_order_acquire);
    if (!e || !e->ready.load(std::memory_order_acquire) || !(e->key == key) || !e->buffer)
        return nullptr;
    const juce::AudioBuffer<float>* raw = e->buffer.get();
    return std::shared_ptr<const juce::AudioBuffer<float>>(std::move(e), raw);
}

void ClipRenderCache::drainMisses(std::vector<int>& out)
{
    uint32_t       tail = missTail_.load(std::memory_order_relaxed);
    const uint32_t head = missHead_.load(std::memory_order_acquire);
    while (tail != head) {
        const int id = missRing_[tail & (kMissRingCapacity - 1)].load(std::memory_order_relaxed);
        ++tail;
        if (id >= 0 && id < kMaxClipId) {
            missPending_[id].store(0, std::memory_order_relaxed);
            out.push_back(id);
        }
    }
    missTail_.store(tail, std::memory_order_release);
}

void ClipRenderCache::retireLocked(std::shared_ptr<CacheEntry> e) {
    if (!e) return;
    if (e.use_count() > 1) {
        const bool parked = std::any_of(retired_.begin(), retired_.end(),
            [&](const std::shared_ptr<CacheEntry>& r) { return r == e; });
        if (!parked) retired_.push_back(std::move(e));
    }
    // A sole owner is simply dropped here — on a message/worker thread.
    pruneRetiredLocked();
}

void ClipRenderCache::pruneRetiredLocked() {
    retired_.erase(
        std::remove_if(retired_.begin(), retired_.end(),
                       [](const std::shared_ptr<CacheEntry>& r) { return r.use_count() == 1; }),
        retired_.end());
}

void ClipRenderCache::clearSlotLocked(int clipId, bool fxLane) {
    retireLocked(slotFor(clipId, fxLane).exchange(nullptr, std::memory_order_acq_rel));
}

void ClipRenderCache::makeResidentLocked(CacheEntry& e) {
    if (e.resident) return;
    e.bytes    = bufferBytes(e);
    e.resident = true;
    lruOrder_.push_front(&e);
    e.lruIt = lruOrder_.begin();
    // A fresh publish counts as a hit: its clip is almost always about to play.
    e.lastHitMs.store(nowMs(), std::memory_order_relaxed);
    bytesNow_.fetch_add(e.bytes, std::memory_order_relaxed);
}

void ClipRenderCache::dropResidentLocked(CacheEntry& e) {
    if (!e.resident) return;
    lruOrder_.erase(e.lruIt);
    e.resident = false;
    bytesNow_.fetch_sub(e.bytes, std::memory_order_relaxed);
}

void ClipRenderCache::evictLocked() {
    if (evictionSuspended_) return;
    const size_t cap = maxBytes_.load(std::memory_order_relaxed);
    if (bytesNow_.load(std::memory_order_relaxed) <= cap) return;

    const int64_t now = nowMs();
    const int64_t hot = hotWindowMs_.load(std::memory_order_relaxed);

    // Walk from the least-recently-used end. Erasing `cur` never invalidates
    // `rit`, which always points one past it.
    auto rit = lruOrder_.end();
    while (bytesNow_.load(std::memory_order_relaxed) > cap && rit != lruOrder_.begin()) {
        auto cur = std::prev(rit);
        CacheEntry* e = *cur;
        if (!e->ready.load(std::memory_order_acquire)
            || now - e->lastHitMs.load(std::memory_order_relaxed) < hot) {
            rit = cur;
            continue;
        }

        const bool fx = e->key.hasFx();
        std::shared_ptr<CacheEntry> owner;
        auto bk = byKey_.find(e->key);
        const bool indexed = (bk != byKey_.end() && bk->second.get() == e);
        if (indexed) owner = bk->second;

        auto& lane = laneMap(fx);
        for (int id : e->subscribers) {
            auto mit = lane.find(id);
            if (mit != lane.end() && mit->second.get() == e) {
                if (!owner) owner = mit->second;
                lane.erase(mit);
            }
            if (id < 0 || id >= kMaxClipId) continue;
            auto& slot = slotFor(id, fx);
            auto held = slot.load(std::memory_order_acquire);
            if (held.get() == e) {
                auto expected = held;
                if (slot.compare_exchange_strong(expected, nullptr, std::memory_order_acq_rel))
                    retireLocked(std::move(held));
            }
        }
        e->subscribers.clear();
        if (indexed) byKey_.erase(bk);
        worldActiveEntries_.erase(e);
        dropResidentLocked(*e);
        evictions_.fetch_add(1, std::memory_order_relaxed);
        retireLocked(std::move(owner));
    }

    if (bytesNow_.load(std::memory_order_relaxed) > cap)
        overCapEvents_.fetch_add(1, std::memory_order_relaxed);
}

void ClipRenderCache::setMaxBytes(size_t bytes) {
    maxBytes_.store(bytes, std::memory_order_relaxed);
    std::lock_guard<std::mutex> lk(cacheMutex_);
    evictLocked();
}

void ClipRenderCache::setEvictionSuspended(bool suspended) {
    std::lock_guard<std::mutex> lk(cacheMutex_);
    evictionSuspended_ = suspended;
    if (!suspended) evictLocked();
}

size_t ClipRenderCache::residentEntryCount() const {
    std::lock_guard<std::mutex> lk(cacheMutex_);
    return lruOrder_.size();
}

size_t ClipRenderCache::retiredCount() const {
    std::lock_guard<std::mutex> lk(cacheMutex_);
    const_cast<ClipRenderCache*>(this)->pruneRetiredLocked();
    return retired_.size();
}

std::shared_ptr<const CacheEntry> ClipRenderCache::peekEntry(int clipId, bool fxLane) const {
    std::lock_guard<std::mutex> lk(cacheMutex_);
    const auto& lane = laneMap(fxLane);
    auto it = lane.find(clipId);
    return it == lane.end() ? nullptr : it->second;
}

void ClipRenderCache::detachLocked(int clipId, bool fxLane) {
    auto& lane = laneMap(fxLane);
    auto it = lane.find(clipId);
    if (it == lane.end()) return;
    auto entry = it->second;
    lane.erase(it);
    if (!entry) return;

    entry->subscribers.erase(clipId);
    if (!entry->subscribers.empty()) return;   // other clips still share it

    // Last subscriber left — retire the entry from the content index so a
    // later submitJob for the same key renders fresh. An in-flight job keeps
    // the entry alive through its own shared_ptr and simply publishes into a
    // now-empty subscriber set, which is a harmless no-op.
    auto byKeyIt = byKey_.find(entry->key);
    if (byKeyIt != byKey_.end() && byKeyIt->second == entry)
        byKey_.erase(byKeyIt);
    worldActiveEntries_.erase(entry.get());
    dropResidentLocked(*entry);
    retireLocked(std::move(entry));
}

void ClipRenderCache::markDirty(int clipId) {
    if (clipId < 0 || clipId >= kMaxClipId) return;
#ifdef XLETH_DEBUG
    fprintf(stderr, "[ClipCache] evict: clip=%d (dirty or deleted)\n", clipId);
#endif
    std::lock_guard<std::mutex> lk(cacheMutex_);
    for (const bool fx : { false, true }) {
        // Slot first so the audio thread immediately falls back.
        clearSlotLocked(clipId, fx);
        detachLocked(clipId, fx);
    }
}

void ClipRenderCache::markDirtyLane(int clipId, bool fxLane) {
    if (clipId < 0 || clipId >= kMaxClipId) return;
    std::lock_guard<std::mutex> lk(cacheMutex_);
    clearSlotLocked(clipId, fxLane);
    detachLocked(clipId, fxLane);
}

bool ClipRenderCache::hasEntryForKey(int clipId, const CacheKey& key) const {
    if (clipId < 0 || clipId >= kMaxClipId) return false;
    std::lock_guard<std::mutex> lk(cacheMutex_);
    const auto& lane = laneMap(key.hasFx());
    auto it = lane.find(clipId);
    return it != lane.end() && it->second && it->second->key == key;
}

void ClipRenderCache::submitJob(int clipId, const CacheKey& key,
                                const juce::AudioBuffer<float>& srcPcm,
                                double sampleRate,
                                double bufferSampleRate)
{
    if (!threadPool_) return;
    if (clipId < 0 || clipId >= kMaxClipId) return;

    const bool fx = key.hasFx();
    std::shared_ptr<CacheEntry> entry;
    bool needsRender = false;
    {
        std::lock_guard<std::mutex> lk(cacheMutex_);
        auto& lane = laneMap(fx);

        // Publish `e` into this clip's slot, retiring whatever it replaces.
        auto publishToSlot = [&](const std::shared_ptr<CacheEntry>& e) {
            auto old = slotFor(clipId, fx).exchange(e, std::memory_order_acq_rel);
            if (old != e) retireLocked(std::move(old));
        };

        // Already pointing at an entry for this exact key? Nothing to do —
        // this is the repeat-submit path (e.g. an op that touched the clip but
        // not its audio) and re-rendering would be pure waste. Re-publish a
        // finished buffer in case the slot lost it (evicted sibling, stale job).
        auto own = lane.find(clipId);
        if (own != lane.end() && own->second && own->second->key == key) {
            entry = own->second;
            if (entry->ready.load(std::memory_order_acquire))
                publishToSlot(entry);
            return;
        }

        detachLocked(clipId, fx);

        // Content-addressed lookup: another clip may already have rendered (or
        // be rendering) byte-identical audio. Paste/duplicate of N identical
        // clips lands here N-1 times and costs one map insert each.
        auto shared = byKey_.find(key);
        if (shared != byKey_.end() && shared->second) {
            entry = shared->second;
        } else {
            entry = std::make_shared<CacheEntry>();
            entry->key = key;
            entry->ready.store(false, std::memory_order_relaxed);
            byKey_[key] = entry;
            needsRender = true;
            if (resolveEffectiveRender(key).method == static_cast<int>(StretchMethod::WORLD))
                worldActiveEntries_.insert(entry.get());
        }
        entry->subscribers.insert(clipId);
        lane[clipId] = entry;

        if (!needsRender) {
            // Reused an existing entry. If its render already finished, hand
            // the buffer to the audio thread now; otherwise publishEntry() will
            // fan it out to us when the in-flight job completes.
            if (entry->ready.load(std::memory_order_acquire)) {
                publishToSlot(entry);
                entry->lastHitMs.store(nowMs(), std::memory_order_relaxed);
            }
        }
    }

    if (!needsRender) {
#ifdef XLETH_DEBUG
        fprintf(stderr, "[ClipCache] share: clip=%d joined existing entry "
                "(region=%d stretch=%.3f pitch=%dst+%dc fxMethod=%d) ready=%d\n",
                clipId, key.regionId, key.stretchRatio,
                key.pitchOffsetSemis, key.pitchOffsetCents, key.fxMethod,
                (int)entry->ready.load(std::memory_order_acquire));
        fflush(stderr);
#endif
        return;
    }

#ifdef XLETH_DEBUG
    fprintf(stderr, "[ClipCache] submit: clip=%d key={region=%d syl=%d"
            " pitch=%dst+%dc stretch=%.3f rev=%d method=%d formant=%d"
            " fx=%dst+%dc/%d/%d}\n",
            clipId, key.regionId, key.syllableIndex,
            key.pitchOffsetSemis, key.pitchOffsetCents,
            key.stretchRatio, (int)key.reversed,
            key.stretchMethod, (int)key.formantPreserve,
            key.fxPitchSemis, key.fxPitchCents, key.fxMethod, (int)key.fxFormant);
#endif

    // Copy source PCM synchronously (caller's buffer may be temporary).
    // Only reached on a genuine cache miss, so a bulk paste pays for this
    // once per DISTINCT sound rather than once per clip.
    const int numCh   = srcPcm.getNumChannels();
    const int numSamp = srcPcm.getNumSamples();
    juce::AudioBuffer<float> srcCopy(numCh, numSamp);
    for (int ch = 0; ch < numCh; ++ch)
        srcCopy.copyFrom(ch, 0, srcPcm, ch, 0, numSamp);

    submittedRenders_.fetch_add(1, std::memory_order_relaxed);
    threadPool_->addJob(
        new ClipRenderJob(clipId, entry, std::move(srcCopy), sampleRate,
                          bufferSampleRate, this),
        /*deleteJobWhenFinished=*/true);
}

std::vector<int> ClipRenderCache::getWorldActiveJobIds() const {
    std::lock_guard<std::mutex> lk(cacheMutex_);
    std::vector<int> ids;
    for (const CacheEntry* e : worldActiveEntries_)
        ids.insert(ids.end(), e->subscribers.begin(), e->subscribers.end());
    return ids;
}

// ── Worker thread → audio thread publish ──────────────────────────────────────

void ClipRenderCache::publishEntry(int /*clipId*/, std::shared_ptr<CacheEntry> entry) {
    if (!entry) return;

    std::lock_guard<std::mutex> lk(cacheMutex_);

    // Fan out to every clip sharing this entry, not just the one that
    // triggered the render. An entry nobody subscribes to any more (its clips
    // were re-keyed or deleted while it rendered) publishes NOWHERE: writing it
    // into the triggering clip's slot would overwrite that clip's newer buffer.
    if (entry->subscribers.empty()) return;

    makeResidentLocked(*entry);

    const bool fx = entry->key.hasFx();
    for (int id : entry->subscribers) {
        if (id < 0 || id >= kMaxClipId) continue;
        auto old = slotFor(id, fx).exchange(entry, std::memory_order_acq_rel);
        if (old != entry) retireLocked(std::move(old));
    }

    evictLocked();
}
