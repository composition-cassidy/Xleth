#include "FrameCache.h"

#include <cassert>
#include <cstdio>

// ===========================================================================
// Construction / destruction
// ===========================================================================

RenderFrameCache::RenderFrameCache()  = default;
RenderFrameCache::~RenderFrameCache() = default;

// ===========================================================================
// Thread binding (debug)
// ===========================================================================

void RenderFrameCache::bindToCurrentThread()
{
    boundThread_ = std::this_thread::get_id();
    threadBound_ = true;
}

void RenderFrameCache::assertRenderThread() const
{
#ifndef NDEBUG
    if (threadBound_) {
        assert(std::this_thread::get_id() == boundThread_ &&
               "RenderFrameCache accessed from wrong thread!");
    }
#endif
}

// ===========================================================================
// get()
// ===========================================================================

FrameCacheEntry* RenderFrameCache::get(const FrameCacheKey& key)
{
    assertRenderThread();

    auto it = map_.find(key);
    if (it == map_.end()) {
        ++missCount_;
        ++accessCount_;
        std::fprintf(stderr, "[RenderFrameCache] MISS: '%s' frame=%lld\n",
                     key.sourcePath.c_str(), (long long)key.frameIndex);
        logPeriodicStats();
        return nullptr;
    }

    // Promote to MRU: splice to front of LRU list
    lruList_.splice(lruList_.begin(), lruList_, it->second.lruIt);

    ++hitCount_;
    ++accessCount_;

    double usedMB = static_cast<double>(totalMemoryUsed_) / (1024.0 * 1024.0);
    std::fprintf(stderr, "[RenderFrameCache] HIT: '%s' frame=%lld (%.1f MB used, %zu entries)\n",
                 key.sourcePath.c_str(), (long long)key.frameIndex,
                 usedMB, map_.size());

    logPeriodicStats();
    return &it->second.entry;
}

// ===========================================================================
// put()
// ===========================================================================

void RenderFrameCache::put(const FrameCacheKey& key, FrameCacheEntry entry)
{
    assertRenderThread();

    // If key already exists, update in place
    auto it = map_.find(key);
    if (it != map_.end()) {
        totalMemoryUsed_ -= it->second.entry.memorySizeBytes;
        it->second.entry = std::move(entry);
        totalMemoryUsed_ += it->second.entry.memorySizeBytes;
        lruList_.splice(lruList_.begin(), lruList_, it->second.lruIt);

        double usedMB = static_cast<double>(totalMemoryUsed_) / (1024.0 * 1024.0);
        std::fprintf(stderr, "[RenderFrameCache] PUT: '%s' frame=%lld size=%zuB (%.1f MB used, %zu entries) [updated]\n",
                     key.sourcePath.c_str(), (long long)key.frameIndex,
                     it->second.entry.memorySizeBytes, usedMB, map_.size());
        return;
    }

    size_t newSize = entry.memorySizeBytes;

    // Account for the incoming entry's memory BEFORE evicting, so the
    // eviction loop knows the true post-insert usage and frees enough room.
    totalMemoryUsed_ += newSize;
    evictUntilUnder(/*pendingInsert=*/true);

    // Insert at MRU position (front of list)
    lruList_.push_front(key);
    auto lruIt = lruList_.begin();

    MapEntry mapEntry;
    mapEntry.entry = std::move(entry);
    mapEntry.lruIt = lruIt;
    map_.emplace(key, std::move(mapEntry));

    double usedMB = static_cast<double>(totalMemoryUsed_) / (1024.0 * 1024.0);
    std::fprintf(stderr, "[RenderFrameCache] PUT: '%s' frame=%lld size=%zuB (%.1f MB used, %zu entries)\n",
                 key.sourcePath.c_str(), (long long)key.frameIndex,
                 newSize, usedMB, map_.size());
}

// ===========================================================================
// clear()
// ===========================================================================

void RenderFrameCache::clear()
{
    assertRenderThread();

    size_t count = map_.size();
    double freedMB = static_cast<double>(totalMemoryUsed_) / (1024.0 * 1024.0);

    // ComPtr releases textures automatically when MapEntry is destroyed
    map_.clear();
    lruList_.clear();
    totalMemoryUsed_ = 0;

    std::fprintf(stderr, "[RenderFrameCache] CLEAR: released %zu entries (%.1f MB)\n",
                 count, freedMB);
}

// ===========================================================================
// Configuration
// ===========================================================================

void RenderFrameCache::setMemoryLimit(size_t bytes)
{
    memoryLimitBytes_ = bytes;
    capacityMode_ = CacheCapacityMode::MemoryLimited;
    evictUntilUnder();
}

void RenderFrameCache::setFrameLimit(int count)
{
    frameLimitCount_ = count;
    capacityMode_ = CacheCapacityMode::FrameCountLimited;
    evictUntilUnder();
}

// ===========================================================================
// Stats
// ===========================================================================

RenderCacheStats RenderFrameCache::getStats() const
{
    RenderCacheStats s;
    s.hitCount       = hitCount_;
    s.missCount      = missCount_;
    s.evictionCount  = evictionCount_;
    s.currentEntries = map_.size();
    s.currentBytes   = totalMemoryUsed_;
    s.limitBytes     = (capacityMode_ == CacheCapacityMode::MemoryLimited)
                         ? memoryLimitBytes_
                         : static_cast<size_t>(frameLimitCount_);
    return s;
}

// ===========================================================================
// Eviction internals
// ===========================================================================

void RenderFrameCache::evictOne()
{
    if (lruList_.empty()) return;

    // Pop from back (LRU)
    const FrameCacheKey& victimKey = lruList_.back();
    auto it = map_.find(victimKey);
    assert(it != map_.end());

    size_t freedBytes = it->second.entry.memorySizeBytes;
    double freedMB = static_cast<double>(freedBytes) / (1024.0 * 1024.0);

    totalMemoryUsed_ -= freedBytes;
    ++evictionCount_;

    double usedMB = static_cast<double>(totalMemoryUsed_) / (1024.0 * 1024.0);
    std::fprintf(stderr, "[RenderFrameCache] EVICT: '%s' frame=%lld (%.1f MB freed -> %.1f MB used)\n",
                 victimKey.sourcePath.c_str(), (long long)victimKey.frameIndex,
                 freedMB, usedMB);

    // Erase from map first (key reference is from lruList_ back, erasing list invalidates it)
    map_.erase(it);
    lruList_.pop_back();
}

void RenderFrameCache::evictUntilUnder(bool pendingInsert)
{
    if (map_.empty()) return;

    switch (capacityMode_) {
    case CacheCapacityMode::MemoryLimited: {
        // For memory mode, the caller has already added the incoming entry's
        // size to totalMemoryUsed_ when pendingInsert is true, so the simple
        // `>` check is correct in both cases.
        int evicted = 0;
        while (!map_.empty() && totalMemoryUsed_ > memoryLimitBytes_) {
            evictOne();
            ++evicted;
        }
        if (evicted > 0) {
            std::fprintf(stderr, "[RenderFrameCache] CAPACITY: evicted %d entries to stay under %zu bytes\n",
                         evicted, memoryLimitBytes_);
        }
        break;
    }
    case CacheCapacityMode::FrameCountLimited: {
        // When called from put(), one more entry is about to be inserted,
        // so we need to leave room: evict until size < limit.
        // When called from setFrameLimit(), no pending insert: evict until size <= limit.
        int maxAllowed = pendingInsert ? (frameLimitCount_ - 1) : frameLimitCount_;
        int evicted = 0;
        while (!map_.empty() && static_cast<int>(map_.size()) > maxAllowed) {
            evictOne();
            ++evicted;
        }
        if (evicted > 0) {
            std::fprintf(stderr, "[RenderFrameCache] CAPACITY: evicted %d entries to stay under %d frames\n",
                         evicted, frameLimitCount_);
        }
        break;
    }
    }
}

// ===========================================================================
// Periodic stats logging
// ===========================================================================

void RenderFrameCache::logPeriodicStats()
{
    if (accessCount_ % 100 != 0) return;

    uint64_t total = hitCount_ + missCount_;
    double hitRate = (total > 0)
        ? static_cast<double>(hitCount_) / static_cast<double>(total) * 100.0
        : 0.0;
    double usedMB  = static_cast<double>(totalMemoryUsed_) / (1024.0 * 1024.0);
    double limitMB = static_cast<double>(memoryLimitBytes_) / (1024.0 * 1024.0);

    std::fprintf(stderr, "[RenderFrameCache] STATS: %llu hits / %llu misses (%.1f%% hit rate), %.1f MB / %.1f MB limit\n",
                 (unsigned long long)hitCount_, (unsigned long long)missCount_,
                 hitRate, usedMB, limitMB);
}
