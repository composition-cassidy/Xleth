#include "audio/ClipRenderCache.h"
#include "dsp/RubberBandWrapper.h"
#include "dsp/TDPSOLA.h"
#include "dsp/WSOLA.h"
#include "dsp/PhaseVocoder.h"
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

// ─── ClipRenderJob ───────────────────────────────────────────────────────────
// Runs on a worker thread from the ThreadPool.

class ClipRenderJob : public juce::ThreadPoolJob {
public:
    ClipRenderJob(int                         clipId,
                  std::shared_ptr<CacheEntry> entry,
                  juce::AudioBuffer<float>    srcCopy,
                  double                      sampleRate,
                  ClipRenderCache*            owner)
        : juce::ThreadPoolJob("ClipRender")
        , clipId_    (clipId)
        , entry_     (std::move(entry))
        , srcCopy_   (std::move(srcCopy))
        , sampleRate_(sampleRate)
        , owner_     (owner)
    {}

    JobStatus runJob() override {
        juce::ScopedNoDenormals noDenormals;
#ifdef XLETH_DEBUG
        const auto jobStart = std::chrono::steady_clock::now();
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
        const int64_t readStart = regOff;
        const int64_t readAvail = static_cast<int64_t>(srcTotal) - readStart;
        const bool willStretch  = (std::abs(key.stretchRatio - 1.0) > 1e-4);
        const double effRatio   = (willStretch && key.stretchRatio > 0.0)
                                ? key.stretchRatio
                                : 1.0;
        const int64_t srcReadDesired = static_cast<int64_t>(
            std::llround(static_cast<double>(durSamp) / effRatio));
        const int64_t readLen   = std::min(srcReadDesired,
                                           std::max(int64_t(0), readAvail));

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

        auto outBuf = std::make_shared<juce::AudioBuffer<float>>(
            std::max(1, numCh), static_cast<int>(durSamp));
        outBuf->clear();

        if (numCh > 0 && readLen > 0 && readStart >= 0) {
            // ── a) Reverse / copy source segment ────────────────────────────
            juce::AudioBuffer<float> working(numCh, static_cast<int>(readLen));
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
            } else {
                // Raw copy — Global stub or no processing needed
                const int copyN = static_cast<int>(readLen);
                for (int ch = 0; ch < numCh; ++ch)
                    outBuf->copyFrom(ch, 0, working, ch, 0, copyN);
            }
        }

        entry_->buffer = std::move(outBuf);
        entry_->ready.store(true, std::memory_order_release);
        owner_->publishEntry(clipId_, entry_);

#ifdef XLETH_DEBUG
        {
            const auto ms = std::chrono::duration_cast<std::chrono::milliseconds>(
                std::chrono::steady_clock::now() - jobStart).count();
            const int outSamples = entry_->buffer ? entry_->buffer->getNumSamples() : 0;
            fprintf(stderr, "[ClipCache] complete: clip=%d rendered %lld→%d samples in %lldms\n",
                    clipId_, (long long)durSamp, outSamples, (long long)ms);
        }
#endif

        return JobStatus::jobHasFinished;
    }

private:
    int                         clipId_;
    std::shared_ptr<CacheEntry> entry_;
    juce::AudioBuffer<float>    srcCopy_;
    double                      sampleRate_;
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
        // TEMPORARY non-gated log: dump both keys side-by-side on mismatch
        fprintf(stderr, "[ClipCache] MISMATCH clip=%d\n"
            "  lookup: region=%d syl=%d offset=%lld dur=%lld srcLen=%lld pitch=%d+%dc stretch=%.6f rev=%d method=%d formant=%d\n"
            "  stored: region=%d syl=%d offset=%lld dur=%lld srcLen=%lld pitch=%d+%dc stretch=%.6f rev=%d method=%d formant=%d\n",
            clipId,
            key.regionId, key.syllableIndex,
            (long long)key.regionOffsetSamples, (long long)key.durationSamples, (long long)key.sourceLengthSamples,
            key.pitchOffsetSemis, key.pitchOffsetCents, key.stretchRatio,
            (int)key.reversed, key.stretchMethod, (int)key.formantPreserve,
            e->key.regionId, e->key.syllableIndex,
            (long long)e->key.regionOffsetSamples, (long long)e->key.durationSamples, (long long)e->key.sourceLengthSamples,
            e->key.pitchOffsetSemis, e->key.pitchOffsetCents, e->key.stretchRatio,
            (int)e->key.reversed, e->key.stretchMethod, (int)e->key.formantPreserve);
        return nullptr;
    }
    return e->buffer.get();
}

// ── Message thread ────────────────────────────────────────────────────────────

void ClipRenderCache::markDirty(int clipId) {
    if (clipId < 0 || clipId >= kMaxClipId) return;
#ifdef XLETH_DEBUG
    fprintf(stderr, "[ClipCache] evict: clip=%d (dirty or deleted)\n", clipId);
#endif

    // Evict audio-thread slot first so the audio thread immediately falls back
    slots_[clipId].store(nullptr, std::memory_order_seq_cst);

    std::lock_guard<std::mutex> lk(cacheMutex_);
    cache_.erase(clipId);
}

void ClipRenderCache::submitJob(int clipId, const CacheKey& key,
                                const juce::AudioBuffer<float>& srcPcm,
                                double sampleRate)
{
    if (!threadPool_) return;
    if (clipId < 0 || clipId >= kMaxClipId) return;
#ifdef XLETH_DEBUG
    fprintf(stderr, "[ClipCache] submit: clip=%d key={region=%d syl=%d"
            " pitch=%dst+%dc stretch=%.3f rev=%d method=%d formant=%d}\n",
            clipId, key.regionId, key.syllableIndex,
            key.pitchOffsetSemis, key.pitchOffsetCents,
            key.stretchRatio, (int)key.reversed,
            key.stretchMethod, (int)key.formantPreserve);
#endif

    // Build entry (not ready yet)
    auto entry = std::make_shared<CacheEntry>();
    entry->key = key;
    entry->ready.store(false, std::memory_order_relaxed);

    // Copy source PCM synchronously (caller's buffer may be temporary)
    const int numCh   = srcPcm.getNumChannels();
    const int numSamp = srcPcm.getNumSamples();
    juce::AudioBuffer<float> srcCopy(numCh, numSamp);
    for (int ch = 0; ch < numCh; ++ch)
        srcCopy.copyFrom(ch, 0, srcPcm, ch, 0, numSamp);

    {
        std::lock_guard<std::mutex> lk(cacheMutex_);
        cache_[clipId] = entry;
    }

    threadPool_->addJob(
        new ClipRenderJob(clipId, entry, std::move(srcCopy), sampleRate, this),
        /*deleteJobWhenFinished=*/true);
}

// ── Worker thread → audio thread publish ──────────────────────────────────────

void ClipRenderCache::publishEntry(int clipId, std::shared_ptr<CacheEntry> entry) {
    if (clipId < 0 || clipId >= kMaxClipId) return;
    slots_[clipId].store(std::move(entry), std::memory_order_release);
}
