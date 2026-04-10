#pragma once

#include <cstddef>
#include <cstdint>
#include <list>
#include <mutex>
#include <unordered_map>
#include <utility>
#include <vector>

struct FrameKey {
    int sourceId;
    int frameNumber;

    bool operator==(const FrameKey& other) const {
        return sourceId == other.sourceId && frameNumber == other.frameNumber;
    }
};

struct FrameKeyHash {
    size_t operator()(const FrameKey& k) const {
        return std::hash<int>()(k.sourceId) ^ (std::hash<int>()(k.frameNumber) << 16);
    }
};

struct CachedFrame {
    std::vector<uint8_t> yPlane;
    std::vector<uint8_t> uPlane;
    std::vector<uint8_t> vPlane;
    int width, height;
    int yStride, uStride, vStride;

    size_t sizeBytes() const {
        return yPlane.size() + uPlane.size() + vPlane.size();
    }
};

class FrameCache {
public:
    explicit FrameCache(size_t maxBytes = 2ULL * 1024 * 1024 * 1024);

    const CachedFrame* get(const FrameKey& key);
    void put(const FrameKey& key, CachedFrame&& frame);
    void clear();

    size_t hitCount()  const { return hits_; }
    size_t missCount() const { return misses_; }
    double hitRate()   const;
    size_t currentBytes() const { return currentBytes_; }
    size_t maxBytes()  const { return maxBytes_; }
    size_t entryCount() const;

private:
    size_t maxBytes_;
    size_t currentBytes_ = 0;
    size_t hits_   = 0;
    size_t misses_ = 0;

    using EntryList = std::list<std::pair<FrameKey, CachedFrame>>;
    EntryList entries_;
    std::unordered_map<FrameKey, EntryList::iterator, FrameKeyHash> lookup_;

    std::mutex mutex_;

    void evictLRU();
};
