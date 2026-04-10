#pragma once

/**
 * RenderFrameCache — LRU cache for decoded video frames stored as D3D11 textures.
 *
 * Each cache entry holds a GPU texture (ID3D11Texture2D) and its shader
 * resource view, keyed by (sourcePath, frameIndex).  The cache is designed
 * for the offline render pipeline where the same frame may be referenced by
 * multiple grid cells in the same output frame.
 *
 * Two capacity modes:
 *   - Memory-limited (default 512 MB): evicts when total GPU memory exceeds limit
 *   - Frame-count-limited: evicts when entry count exceeds limit
 *
 * Thread safety: accessed from the render thread ONLY.  No mutex — a debug
 * assert verifies the calling thread.
 */

#include <cstdint>
#include <cstdio>
#include <list>
#include <string>
#include <thread>
#include <unordered_map>
#include <utility>

// GpuDeviceManager.h already guards NOMINMAX before <d3d11_4.h>
#include "GpuDeviceManager.h"

// ---------------------------------------------------------------------------
// FrameCacheKey — composite key: (sourcePath, frameIndex)
// ---------------------------------------------------------------------------
struct FrameCacheKey {
    std::string sourcePath;
    int64_t     frameIndex = 0;

    bool operator==(const FrameCacheKey& o) const {
        return frameIndex == o.frameIndex && sourcePath == o.sourcePath;
    }
    bool operator<(const FrameCacheKey& o) const {
        if (sourcePath != o.sourcePath) return sourcePath < o.sourcePath;
        return frameIndex < o.frameIndex;
    }
};

struct FrameCacheKeyHash {
    size_t operator()(const FrameCacheKey& k) const {
        // Combine string hash and int64 hash with a bit mix
        size_t h1 = std::hash<std::string>{}(k.sourcePath);
        size_t h2 = std::hash<int64_t>{}(k.frameIndex);
        return h1 ^ (h2 * 0x9e3779b97f4a7c15ULL + 0x517cc1b727220a95ULL + (h1 << 6) + (h1 >> 2));
    }
};

// ---------------------------------------------------------------------------
// FrameCacheEntry — a decoded frame living on the GPU
// ---------------------------------------------------------------------------
struct FrameCacheEntry {
    Microsoft::WRL::ComPtr<ID3D11Texture2D>          texture;
    Microsoft::WRL::ComPtr<ID3D11ShaderResourceView> srv;
    int    width           = 0;
    int    height          = 0;
    size_t memorySizeBytes = 0;   // width * height * 4 for BGRA
};

// ---------------------------------------------------------------------------
// CacheStats — snapshot of cache performance counters
// ---------------------------------------------------------------------------
struct RenderCacheStats {
    uint64_t hitCount       = 0;
    uint64_t missCount      = 0;
    uint64_t evictionCount  = 0;
    size_t   currentEntries = 0;
    size_t   currentBytes   = 0;
    size_t   limitBytes     = 0;
};

// ---------------------------------------------------------------------------
// Capacity mode
// ---------------------------------------------------------------------------
enum class CacheCapacityMode {
    MemoryLimited,     // evict when totalMemoryUsed > memoryLimit
    FrameCountLimited  // evict when entryCount > frameLimit
};

// ---------------------------------------------------------------------------
// RenderFrameCache
// ---------------------------------------------------------------------------
class RenderFrameCache
{
public:
    RenderFrameCache();
    ~RenderFrameCache();

    // Non-copyable
    RenderFrameCache(const RenderFrameCache&)            = delete;
    RenderFrameCache& operator=(const RenderFrameCache&) = delete;

    // ── Lookup ──────────────────────────────────────────────────────────────

    /** Returns pointer to entry on hit (promoted to MRU), nullptr on miss. */
    FrameCacheEntry* get(const FrameCacheKey& key);

    /** Insert or replace an entry. Evicts LRU entries if over capacity. */
    void put(const FrameCacheKey& key, FrameCacheEntry entry);

    /** Flush the entire cache (project load, GPU device change). */
    void clear();

    // ── Configuration ───────────────────────────────────────────────────────

    void setMemoryLimit(size_t bytes);
    void setFrameLimit(int count);

    CacheCapacityMode getCapacityMode() const { return capacityMode_; }
    size_t getMemoryLimit() const { return memoryLimitBytes_; }
    int    getFrameLimit()  const { return frameLimitCount_; }

    // ── Stats ───────────────────────────────────────────────────────────────

    RenderCacheStats getStats() const;

    // ── Thread binding ──────────────────────────────────────────────────────

    /** Call once from the render thread to register the expected thread ID. */
    void bindToCurrentThread();

private:
    // ── LRU data structures ─────────────────────────────────────────────────
    // lruList_: front = MRU, back = LRU
    using LruList = std::list<FrameCacheKey>;
    LruList lruList_;

    struct MapEntry {
        FrameCacheEntry   entry;
        LruList::iterator lruIt;
    };
    std::unordered_map<FrameCacheKey, MapEntry, FrameCacheKeyHash> map_;

    // ── Capacity ────────────────────────────────────────────────────────────
    CacheCapacityMode capacityMode_    = CacheCapacityMode::MemoryLimited;
    size_t            memoryLimitBytes_ = 512ULL * 1024 * 1024;  // 512 MB
    int               frameLimitCount_  = 120;

    // ── Tracking ────────────────────────────────────────────────────────────
    size_t   totalMemoryUsed_ = 0;
    uint64_t hitCount_        = 0;
    uint64_t missCount_       = 0;
    uint64_t evictionCount_   = 0;
    uint64_t accessCount_     = 0;   // for periodic stats logging

    // ── Thread safety (debug) ───────────────────────────────────────────────
    std::thread::id boundThread_;
    bool            threadBound_ = false;

    void assertRenderThread() const;
    void evictOne();
    void evictUntilUnder(bool pendingInsert = false);
    void logPeriodicStats();
};
