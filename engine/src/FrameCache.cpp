#include "FrameCache.h"

FrameCache::FrameCache(size_t maxBytes)
    : maxBytes_(maxBytes)
{
}

const CachedFrame* FrameCache::get(const FrameKey& key)
{
    std::lock_guard<std::mutex> lock(mutex_);

    auto it = lookup_.find(key);
    if (it == lookup_.end())
    {
        ++misses_;
        return nullptr;
    }

    // Move to front (most recently used)
    entries_.splice(entries_.begin(), entries_, it->second);
    ++hits_;
    return &it->second->second;
}

void FrameCache::put(const FrameKey& key, CachedFrame&& frame)
{
    std::lock_guard<std::mutex> lock(mutex_);

    auto it = lookup_.find(key);
    if (it != lookup_.end())
    {
        // Update existing entry
        currentBytes_ -= it->second->second.sizeBytes();
        it->second->second = std::move(frame);
        currentBytes_ += it->second->second.sizeBytes();
        entries_.splice(entries_.begin(), entries_, it->second);
        return;
    }

    // Insert new entry at front
    size_t frameSize = frame.sizeBytes();
    entries_.emplace_front(key, std::move(frame));
    lookup_[key] = entries_.begin();
    currentBytes_ += frameSize;

    // Evict until under budget
    while (currentBytes_ > maxBytes_ && entries_.size() > 1)
        evictLRU();
}

void FrameCache::clear()
{
    std::lock_guard<std::mutex> lock(mutex_);
    entries_.clear();
    lookup_.clear();
    currentBytes_ = 0;
}

double FrameCache::hitRate() const
{
    size_t total = hits_ + misses_;
    return (total > 0) ? static_cast<double>(hits_) / static_cast<double>(total) * 100.0 : 0.0;
}

size_t FrameCache::entryCount() const
{
    return entries_.size();
}

void FrameCache::evictLRU()
{
    // Remove from back (least recently used)
    auto& back = entries_.back();
    currentBytes_ -= back.second.sizeBytes();
    lookup_.erase(back.first);
    entries_.pop_back();
}
