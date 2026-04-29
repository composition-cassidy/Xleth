#include "audio/WorldStretchCache.h"
#include "XlethDebug.h"

#define XXH_INLINE_ALL
#include "xxhash.h"

#include <algorithm>
#include <cstdio>

namespace xleth::audio {

WorldStretchCache::WorldStretchCache(size_t maxBytes)
    : maxBytes_(maxBytes)
{}

size_t WorldStretchCache::bufferBytes(const juce::AudioBuffer<float>& b) noexcept {
    return static_cast<size_t>(std::max(0, b.getNumChannels()))
         * static_cast<size_t>(std::max(0, b.getNumSamples()))
         * sizeof(float);
}

size_t WorldStretchCache::entryCount() const noexcept {
    std::lock_guard<std::mutex> lk(mu_);
    return map_.size();
}

void WorldStretchCache::setMaxBytes(size_t bytes) {
    maxBytes_.store(bytes, std::memory_order_relaxed);
    std::lock_guard<std::mutex> lk(mu_);
    evictLocked();
}

void WorldStretchCache::clear() {
    std::lock_guard<std::mutex> lk(mu_);
    map_.clear();
    lruOrder_.clear();
    bytesNow_.store(0, std::memory_order_relaxed);
}

void WorldStretchCache::evictLocked() {
    const size_t cap = maxBytes_.load(std::memory_order_relaxed);
    while (bytesNow_.load(std::memory_order_relaxed) > cap && !lruOrder_.empty()) {
        const auto victimKey = lruOrder_.back();
        lruOrder_.pop_back();
        auto it = map_.find(victimKey);
        if (it != map_.end()) {
            bytesNow_.fetch_sub(it->second.bytes, std::memory_order_relaxed);
            map_.erase(it);
        }
    }
}

uint64_t WorldStretchCache::hashPCM(const juce::AudioBuffer<float>& src) noexcept {
    XXH3_state_t* state = XXH3_createState();
    if (!state) return 0;
    XXH3_64bits_reset(state);

    const int numCh   = src.getNumChannels();
    const int numSamp = src.getNumSamples();
    const int32_t shape[2] = { numCh, numSamp };
    XXH3_64bits_update(state, shape, sizeof(shape));

    for (int ch = 0; ch < numCh; ++ch) {
        const float* p = src.getReadPointer(ch);
        if (p && numSamp > 0)
            XXH3_64bits_update(state, p, sizeof(float) * static_cast<size_t>(numSamp));
    }

    const uint64_t digest = XXH3_64bits_digest(state);
    XXH3_freeState(state);
    return digest;
}

std::shared_ptr<const juce::AudioBuffer<float>>
WorldStretchCache::getOrCompute(const WorldCacheKey& key,
                                const juce::AudioBuffer<float>& source,
                                const dsp::WORLDParams& params)
{
    {
        std::lock_guard<std::mutex> lk(mu_);
        auto it = map_.find(key);
        if (it != map_.end()) {
            // Promote to MRU.
            lruOrder_.erase(it->second.lruIt);
            lruOrder_.push_front(key);
            it->second.lruIt = lruOrder_.begin();
#ifdef XLETH_DEBUG
            fprintf(stderr, "[WorldCache] HIT  hash=%016llx pitch=%d ratio=%d (entries=%zu, bytes=%zu)\n",
                    (unsigned long long)key.sourceHash, key.pitchMilliSt, key.ratioMicro,
                    map_.size(), bytesNow_.load(std::memory_order_relaxed));
            fflush(stderr);
#endif
            return it->second.buffer;
        }
    }

    // Miss → compute outside the lock so concurrent worker threads can
    // process different clips in parallel. (Two workers racing on the same
    // key will each compute once; only one's entry survives in the map.)
    computeCount_.fetch_add(1, std::memory_order_relaxed);
#ifdef XLETH_DEBUG
    fprintf(stderr, "[WorldCache] MISS hash=%016llx pitch=%d ratio=%d — computing\n",
            (unsigned long long)key.sourceHash, key.pitchMilliSt, key.ratioMicro);
    fflush(stderr);
#endif

    auto produced = std::make_shared<juce::AudioBuffer<float>>(
        dsp::processWORLD(source, params));
    const size_t bytes = bufferBytes(*produced);

    std::lock_guard<std::mutex> lk(mu_);
    auto it = map_.find(key);
    if (it != map_.end()) {
        // Lost a race; return the entry that won.
        lruOrder_.erase(it->second.lruIt);
        lruOrder_.push_front(key);
        it->second.lruIt = lruOrder_.begin();
        return it->second.buffer;
    }

    lruOrder_.push_front(key);
    Entry entry;
    entry.buffer = produced;
    entry.lruIt  = lruOrder_.begin();
    entry.bytes  = bytes;
    bytesNow_.fetch_add(bytes, std::memory_order_relaxed);
    map_.emplace(key, std::move(entry));
    evictLocked();
    return produced;
}

} // namespace xleth::audio
