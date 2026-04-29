#pragma once

#include <juce_audio_basics/juce_audio_basics.h>
#include "dsp/WORLD.h"

#include <atomic>
#include <cstddef>
#include <cstdint>
#include <list>
#include <memory>
#include <mutex>
#include <unordered_map>

namespace xleth::audio {

// Content-keyed LRU cache for WORLD-processed audio. Keyed by
// {sourceHash, pitch, ratio, sampleRate} so flipping a clip's pitch back and
// forth keeps both rendered variants resident — WORLD analysis is far too
// expensive to re-run on every parameter change.
//
// Threading: every public entry point is intended for the worker thread
// (JUCE ThreadPool inside ClipRenderCache). The cache mutex must NEVER be
// taken on the audio thread; the audio path goes through ClipRenderCache's
// existing lock-free atomic publish.

struct WorldCacheKey {
    uint64_t sourceHash    = 0;   // xxh3_64 of raw PCM bytes (all channels)
    int32_t  pitchMilliSt  = 0;   // round(semitones * 1000) — 0.001 st quant
    int32_t  ratioMicro    = 0;   // round(ratio * 1000)     — 0.001 quant
    int32_t  sampleRateHz  = 0;
    int32_t  numChannels   = 0;

    bool operator==(const WorldCacheKey& o) const noexcept {
        return sourceHash   == o.sourceHash
            && pitchMilliSt == o.pitchMilliSt
            && ratioMicro   == o.ratioMicro
            && sampleRateHz == o.sampleRateHz
            && numChannels  == o.numChannels;
    }
};

struct WorldCacheKeyHash {
    size_t operator()(const WorldCacheKey& k) const noexcept {
        // Mix sourceHash with the parameter ints. sourceHash is already a
        // good 64-bit digest, so xor-shift mixing is sufficient.
        uint64_t h = k.sourceHash;
        h ^= static_cast<uint64_t>(k.pitchMilliSt) * 0x9E3779B97F4A7C15ULL;
        h ^= static_cast<uint64_t>(k.ratioMicro)   * 0xBF58476D1CE4E5B9ULL;
        h ^= static_cast<uint64_t>(k.sampleRateHz) * 0x94D049BB133111EBULL;
        h ^= static_cast<uint64_t>(k.numChannels)  * 0xD6E8FEB86659FD93ULL;
        return static_cast<size_t>(h ^ (h >> 32));
    }
};

class WorldStretchCache {
public:
    static constexpr size_t kDefaultMaxBytes = 128ull * 1024ull * 1024ull;

    explicit WorldStretchCache(size_t maxBytes = kDefaultMaxBytes);

    // Worker-thread call. On hit returns the cached buffer; on miss runs
    // processWORLD on the calling thread, inserts, evicts LRU as needed,
    // returns the freshly produced buffer. Never call from the audio thread.
    std::shared_ptr<const juce::AudioBuffer<float>>
    getOrCompute(const WorldCacheKey& key,
                 const juce::AudioBuffer<float>& source,
                 const dsp::WORLDParams& params);

    // xxh3_64 over the raw float bytes of every channel, plus channel count
    // and sample count to disambiguate buffers with identical PCM but
    // different shapes. Computed once per ClipRenderJob in the dispatcher.
    static uint64_t hashPCM(const juce::AudioBuffer<float>& src) noexcept;

    void   setMaxBytes(size_t bytes);
    size_t maxBytes() const noexcept { return maxBytes_.load(std::memory_order_relaxed); }
    size_t currentBytes() const noexcept { return bytesNow_.load(std::memory_order_relaxed); }
    size_t entryCount()    const noexcept;
    void   clear();

    // Test/observability hook: monotonically increments every time
    // processWORLD is invoked through this cache. Hits do NOT increment.
    uint64_t computeCount() const noexcept { return computeCount_.load(std::memory_order_relaxed); }

private:
    using BufferPtr = std::shared_ptr<const juce::AudioBuffer<float>>;
    struct Entry {
        BufferPtr                              buffer;
        std::list<WorldCacheKey>::iterator     lruIt;
        size_t                                 bytes = 0;
    };

    void evictLocked();
    static size_t bufferBytes(const juce::AudioBuffer<float>& b) noexcept;

    mutable std::mutex                                                       mu_;
    std::list<WorldCacheKey>                                                 lruOrder_; // front = most recent
    std::unordered_map<WorldCacheKey, Entry, WorldCacheKeyHash>              map_;
    std::atomic<size_t>                                                      maxBytes_;
    std::atomic<size_t>                                                      bytesNow_{0};
    std::atomic<uint64_t>                                                    computeCount_{0};
};

} // namespace xleth::audio
