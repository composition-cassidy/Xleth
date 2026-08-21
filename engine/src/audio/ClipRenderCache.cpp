#include "audio/ClipRenderCache.h"
#include "audio/WorldStretchCache.h"
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
        && formantPreserve     == o.formantPreserve;
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
    return h;
}

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
        const int  numCh      = srcCopy_.getNumChannels();
        const int64_t regOff  = key.regionOffsetSamples;
        const int64_t durSamp = key.durationSamples;
        const int srcTotal    = srcCopy_.getNumSamples();

        // How many source frames we can actually read.
        // When time-stretching, the stretcher multiplies our input length by
        // stretchRatio, so to produce exactly durSamp output samples we must
        // read durSamp / stretchRatio source samples. For unity ratio this
        // collapses to the original durSamp, preserving the no-stretch path.
        const bool willStretch  = (std::abs(key.stretchRatio - 1.0) > 1e-4);
        const double effRatio   = (willStretch && key.stretchRatio > 0.0)
                                ? key.stretchRatio
                                : 1.0;
        const int64_t srcReadNeeded = static_cast<int64_t>(
            std::llround(static_cast<double>(durSamp) / effRatio));

        // ── Stretch-engine input floor (short-clip pitch-drop guard) ─────────
        // PSOLA/WSOLA/PhaseVocoder varispeed anything shorter than one analysis
        // window instead of stretching it, which transposes the clip DOWN by the
        // stretch ratio. Since the input we hand them is durSamp / ratio, a big
        // stretch on a short clip lands under the floor easily (at 8× a 300 ms
        // clip is a 37 ms input, under PSOLA's 50 ms). Read PAST what the clip
        // needs — the trimmed-away audio is sitting right there in the region
        // buffer — and let copyIntoOutBuf drop the surplus output. Output
        // alignment is unaffected: extra input only ever appends.
        const int64_t srcReadFloor = willStretch
            ? static_cast<int64_t>(xleth::dsp::minStretchInputSamples(
                  key.stretchMethod, sampleRate_,
                  key.pitchOffsetSemis + key.pitchOffsetCents / 100.0))
            : 0;
        const int64_t srcReadDesired = std::max(srcReadNeeded, srcReadFloor);

        // Bake-rate → prepared-rate correction. srcCopy_ is stored at the bake
        // rate; the cache output and the pitch/stretch engines run at the
        // prepared rate (sampleRate_). When they differ we resample the source
        // region bake→prepared via Lagrange BEFORE pitch/stretch so the cached
        // clip preserves pitch (mirrors the raw clip path in MixEngine). At
        // matched rate the original memcpy/reverse fast path is kept bit-for-bit.
        const double srFactor = (bufferSampleRate_ > 0.0 && sampleRate_ > 0.0)
                              ? bufferSampleRate_ / sampleRate_ : 1.0;
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

        // Warn for very long clips (>10 s)
        const double durationSec = static_cast<double>(durSamp) / sampleRate_;
#ifdef XLETH_DEBUG
        fprintf(stderr, "[ClipCache] submit-run: clip=%d region=%d pitch=%dst+%dc"
                " stretch=%.4f rev=%d method=%d formant=%d src=%d dur=%lld\n",
                clipId_, key.regionId,
                key.pitchOffsetSemis, key.pitchOffsetCents,
                key.stretchRatio, (int)key.reversed,
                key.stretchMethod, (int)key.formantPreserve,
                srcTotal, (long long)durSamp);
        if (durationSec > 10.0)
            fprintf(stderr, "[ClipCache] warn: clip=%d source length %d samples"
                    " (%.1fs >10s) — cache designed for short clips\n",
                    clipId_, srcTotal, durationSec);
#else
        if (durationSec > 10.0) {
            std::cout << "[ClipRenderCache] WARNING: clip " << clipId_
                      << " is " << durationSec << "s (>10 s) — render may be slow\n"
                      << std::flush;
        }
#endif

        // outBuf is clip-local post-processing output: CacheKey::regionOffsetSamples
        // is consumed while building `working`, and processed samples are copied
        // back starting at sample 0 for exactly durationSamples.
        auto outBuf = std::make_shared<juce::AudioBuffer<float>>(
            std::max(1, numCh), static_cast<int>(durSamp));
        outBuf->clear();

        if (numCh > 0 && readLen > 0 && readStart >= 0 && readStart < srcTotal) {
            // ── a) Build the prepared-rate source segment ───────────────────
            // matchedRate: verbatim reverse/copy (bit-for-bit legacy path).
            // else: resample bake→prepared via Lagrange, then reverse in place.
            // If the source itself ran out before the engine's input floor (clip
            // sits at the very tail of the region), zero-pad up to the floor
            // rather than let the engine varispeed. The padding is silence the
            // clip would have played anyway, and it lands after the real audio,
            // so the kept output (first durSamp) still starts at readStart.
            const int64_t workLen = std::max(readLen, srcReadFloor);
            juce::AudioBuffer<float> working(numCh, static_cast<int>(workLen));
            if (workLen > readLen) working.clear();
            if (matchedRate) {
                for (int ch = 0; ch < numCh; ++ch) {
                    const float* src = srcCopy_.getReadPointer(ch);
                    float*       dst = working.getWritePointer(ch);
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
                                   srcCopy_.getReadPointer(ch) + readStart,
                                   working.getWritePointer(ch),
                                   static_cast<int>(readLen),
                                   static_cast<int>(readAvail),
                                   0);
                    if (key.reversed) {
                        float* dst = working.getWritePointer(ch);
                        std::reverse(dst, dst + static_cast<int>(readLen));
                    }
                }
            }

            // ── b) Pitch / stretch ────────────────────────────────────────────
            const bool needsPitch   = (key.pitchOffsetSemis != 0 || key.pitchOffsetCents != 0);
            const bool needsStretch = (std::abs(key.stretchRatio - 1.0) > 1e-4);

            // Copy a processed buffer into the pre-allocated outBuf (sized to
            // durSamp and pre-cleared above). Trims if the stretcher overshoots
            // due to rounding; leaves the tail as silence if it undershoots or
            // if the source ran out before filling durSamp.
            auto copyIntoOutBuf = [&](const juce::AudioBuffer<float>& processed) {
                const int copyN  = std::min(static_cast<int>(durSamp),
                                            processed.getNumSamples());
                const int copyCh = std::min(processed.getNumChannels(),
                                            outBuf->getNumChannels());
                for (int ch = 0; ch < copyCh; ++ch)
                    outBuf->copyFrom(ch, 0, processed, ch, 0, copyN);
            };

            if ((needsPitch || needsStretch) && key.stretchMethod == 1 /*PSOLA*/) {
                xleth::dsp::PSOLAParams p;
                p.sampleRate       = sampleRate_;
                p.pitchOffsetSemis = key.pitchOffsetSemis;
                p.pitchOffsetCents = key.pitchOffsetCents;
                p.stretchRatio     = key.stretchRatio;
                p.formantPreserve  = key.formantPreserve;
                copyIntoOutBuf(xleth::dsp::processTDPSOLA(working, p));
            } else if ((needsPitch || needsStretch) && key.stretchMethod == 2 /*Rubber*/) {
                xleth::dsp::RubberBandParams p;
                p.sampleRate          = sampleRate_;
                p.pitchShiftSemitones = key.pitchOffsetSemis
                                        + key.pitchOffsetCents / 100.0;
                p.stretchRatio        = key.stretchRatio;
                p.formantPreserve     = key.formantPreserve;
                copyIntoOutBuf(xleth::dsp::processRubberBand(working, p));
            } else if ((needsPitch || needsStretch) && key.stretchMethod == 3 /*WSOLA*/) {
                xleth::dsp::WSOLAParams p;
                p.sampleRate          = sampleRate_;
                p.pitchShiftSemitones = key.pitchOffsetSemis
                                        + key.pitchOffsetCents / 100.0;
                p.stretchRatio        = key.stretchRatio;
                p.formantPreserve     = key.formantPreserve;
                copyIntoOutBuf(xleth::dsp::processWSOLA(working, p));
            } else if ((needsPitch || needsStretch) && key.stretchMethod == 4 /*PhaseVocoder*/) {
                xleth::dsp::PhaseVocoderParams p;
                p.sampleRate          = sampleRate_;
                p.pitchShiftSemitones = key.pitchOffsetSemis
                                        + key.pitchOffsetCents / 100.0;
                p.stretchRatio        = key.stretchRatio;
                p.formantPreserve     = key.formantPreserve;
                copyIntoOutBuf(xleth::dsp::processPhaseVocoder(working, p));
            } else if ((needsPitch || needsStretch) &&
                       key.stretchMethod == static_cast<int>(StretchMethod::WORLD)) {
                xleth::dsp::WORLDParams p;
                p.sampleRate          = sampleRate_;
                p.pitchShiftSemitones = key.pitchOffsetSemis
                                        + key.pitchOffsetCents / 100.0;
                p.stretchRatio        = key.stretchRatio;
                p.formantPreserve     = key.formantPreserve;

                if (auto* wc = owner_->worldCache()) {
                    xleth::audio::WorldCacheKey wk;
                    wk.sourceHash   = xleth::audio::WorldStretchCache::hashPCM(working);
                    wk.pitchMilliSt = static_cast<int32_t>(
                        std::lround(p.pitchShiftSemitones * 1000.0));
                    wk.ratioMicro   = static_cast<int32_t>(
                        std::lround(p.stretchRatio * 1000.0));
                    wk.sampleRateHz = static_cast<int32_t>(std::lround(sampleRate_));
                    wk.numChannels  = working.getNumChannels();
                    auto buf = wc->getOrCompute(wk, working, p);
                    if (buf) copyIntoOutBuf(*buf);
                } else {
                    copyIntoOutBuf(xleth::dsp::processWORLD(working, p));
                }
            } else {
                // Raw copy — Global stub or no processing needed. Clamped to
                // durSamp: with ratio < 1 (or a padded `working`) the segment can
                // be longer than the clip's own output buffer.
                const int copyN = static_cast<int>(std::min(readLen, durSamp));
                for (int ch = 0; ch < numCh; ++ch)
                    outBuf->copyFrom(ch, 0, working, ch, 0, copyN);
            }
        }

        entry_->buffer = std::move(outBuf);
        entry_->ready.store(true, std::memory_order_release);

        if (entry_->key.stretchMethod == static_cast<int>(StretchMethod::WORLD)) {
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
            fprintf(stderr, "[ClipCache] complete: clip=%d rendered %lld→%d samples in %lldms\n",
                    clipId_, (long long)durSamp, outSamples, (long long)ms);
            fprintf(stderr, "[CacheQueue] COMPLETE clip=%d inSamples=%lld outSamples=%d "
                    "(ratio out/in=%.3f, expectedStretchRatio=%.3f)\n",
                    clipId_, (long long)readLen, outSamples,
                    readLen > 0 ? (double)outSamples / (double)readLen : 0.0,
                    key.stretchRatio);
            fflush(stderr);
        }
#endif

        return JobStatus::jobHasFinished;
    }

private:
    int                         clipId_;
    std::shared_ptr<CacheEntry> entry_;
    juce::AudioBuffer<float>    srcCopy_;
    double                      sampleRate_;
    double                      bufferSampleRate_;
    ClipRenderCache*            owner_;
};

// ─── ClipRenderCache ──────────────────────────────────────────────────────────

ClipRenderCache::ClipRenderCache()
    : threadPool_(std::make_unique<juce::ThreadPool>(kThreads))
{}

ClipRenderCache::~ClipRenderCache() {
    shutdown();
}

void ClipRenderCache::shutdown() {
    if (threadPool_) {
        threadPool_->removeAllJobs(true, 5000);
        threadPool_.reset();
    }
    for (int i = 0; i < kMaxClipId; ++i)
        slots_[i].store(nullptr, std::memory_order_seq_cst);
    std::lock_guard<std::mutex> lk(cacheMutex_);
    cache_.clear();
    byKey_.clear();
    worldActiveEntries_.clear();
}

// ── Audio thread ──────────────────────────────────────────────────────────────

const juce::AudioBuffer<float>* ClipRenderCache::getProcessedBuffer(
    int clipId, const CacheKey& key) const noexcept
{
    if (clipId < 0 || clipId >= kMaxClipId) return nullptr;

    auto e = slots_[clipId].load(std::memory_order_acquire);
    if (!e)                                                return nullptr;
    if (!e->ready.load(std::memory_order_acquire))         return nullptr;
    if (!(e->key == key)) {
        // [StreamUnder] stale-key churn. Counted, never logged: this runs on
        // the audio thread, where an fprintf is a hard real-time violation.
        // Read the tally via getKeyMismatchCount() from the 1s health sampler.
        keyMismatchCount_.fetch_add(1, std::memory_order_relaxed);
        return nullptr;
    }
    return e->buffer.get();
}

// ── Message thread ────────────────────────────────────────────────────────────

void ClipRenderCache::detachLocked(int clipId) {
    auto it = cache_.find(clipId);
    if (it == cache_.end()) return;
    auto entry = it->second;
    cache_.erase(it);
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
}

void ClipRenderCache::markDirty(int clipId) {
    if (clipId < 0 || clipId >= kMaxClipId) return;
#ifdef XLETH_DEBUG
    fprintf(stderr, "[ClipCache] evict: clip=%d (dirty or deleted)\n", clipId);
#endif

    // Evict audio-thread slot first so the audio thread immediately falls back
    slots_[clipId].store(nullptr, std::memory_order_seq_cst);

    std::lock_guard<std::mutex> lk(cacheMutex_);
    detachLocked(clipId);
}

bool ClipRenderCache::hasEntryForKey(int clipId, const CacheKey& key) const {
    if (clipId < 0 || clipId >= kMaxClipId) return false;
    std::lock_guard<std::mutex> lk(cacheMutex_);
    auto it = cache_.find(clipId);
    return it != cache_.end() && it->second && it->second->key == key;
}

void ClipRenderCache::submitJob(int clipId, const CacheKey& key,
                                const juce::AudioBuffer<float>& srcPcm,
                                double sampleRate,
                                double bufferSampleRate)
{
    if (!threadPool_) return;
    if (clipId < 0 || clipId >= kMaxClipId) return;

    std::shared_ptr<CacheEntry> entry;
    bool needsRender = false;
    {
        std::lock_guard<std::mutex> lk(cacheMutex_);

        // Already pointing at an entry for this exact key? Nothing to do —
        // this is the repeat-submit path (e.g. an op that touched the clip but
        // not its audio) and re-rendering would be pure waste.
        auto own = cache_.find(clipId);
        if (own != cache_.end() && own->second && own->second->key == key) {
            entry = own->second;
            if (entry->ready.load(std::memory_order_acquire))
                slots_[clipId].store(entry, std::memory_order_release);
            return;
        }

        detachLocked(clipId);

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
            if (key.stretchMethod == static_cast<int>(StretchMethod::WORLD))
                worldActiveEntries_.insert(entry.get());
        }
        entry->subscribers.insert(clipId);
        cache_[clipId] = entry;
    }

    if (!needsRender) {
        // Reused an existing entry. If its render already finished, hand the
        // buffer to the audio thread now; otherwise publishEntry() will fan it
        // out to us when the in-flight job completes.
        if (entry->ready.load(std::memory_order_acquire))
            slots_[clipId].store(entry, std::memory_order_release);
#ifdef XLETH_DEBUG
        fprintf(stderr, "[ClipCache] share: clip=%d joined existing entry "
                "(region=%d stretch=%.3f pitch=%dst+%dc) ready=%d\n",
                clipId, key.regionId, key.stretchRatio,
                key.pitchOffsetSemis, key.pitchOffsetCents,
                (int)entry->ready.load(std::memory_order_acquire));
        fflush(stderr);
#endif
        return;
    }

#ifdef XLETH_DEBUG
    fprintf(stderr, "[ClipCache] submit: clip=%d key={region=%d syl=%d"
            " pitch=%dst+%dc stretch=%.3f rev=%d method=%d formant=%d}\n",
            clipId, key.regionId, key.syllableIndex,
            key.pitchOffsetSemis, key.pitchOffsetCents,
            key.stretchRatio, (int)key.reversed,
            key.stretchMethod, (int)key.formantPreserve);
#endif

    // Copy source PCM synchronously (caller's buffer may be temporary).
    // Only reached on a genuine cache miss, so a bulk paste pays for this
    // once per DISTINCT sound rather than once per clip.
    const int numCh   = srcPcm.getNumChannels();
    const int numSamp = srcPcm.getNumSamples();
    juce::AudioBuffer<float> srcCopy(numCh, numSamp);
    for (int ch = 0; ch < numCh; ++ch)
        srcCopy.copyFrom(ch, 0, srcPcm, ch, 0, numSamp);

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

void ClipRenderCache::publishEntry(int clipId, std::shared_ptr<CacheEntry> entry) {
    if (!entry) return;

    // Fan out to every clip sharing this entry, not just the one that
    // triggered the render.
    std::vector<int> targets;
    {
        std::lock_guard<std::mutex> lk(cacheMutex_);
        targets.assign(entry->subscribers.begin(), entry->subscribers.end());
    }
    if (targets.empty() && clipId >= 0 && clipId < kMaxClipId)
        targets.push_back(clipId);

    for (int id : targets) {
        if (id < 0 || id >= kMaxClipId) continue;
        slots_[id].store(entry, std::memory_order_release);
    }
}
