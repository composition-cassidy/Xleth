#pragma once

#include <juce_audio_basics/juce_audio_basics.h>
#include <juce_core/juce_core.h>

#include <atomic>
#include <cstddef>
#include <cstdint>
#include <list>
#include <memory>
#include <mutex>
#include <string>
#include <unordered_map>
#include <unordered_set>

namespace xleth::audio {

// ─── SlotBakeCache ────────────────────────────────────────────────────────────
// Content-keyed cache for the sampler's per-slot PREP bake — the offline
// time-stretch / pitch-shift that turns a slot's raw PCM into the buffer that
// trim, loop, fades and the editor's waveform all subsequently work against.
//
// Two tiers, mirroring WorldStretchCache's LRU with a disk tier bolted under it:
//
//   memory — LRU by bytes, so flipping stretch back and forth keeps both
//            renders resident (a WORLD bake is far too expensive to redo on
//            every parameter change)
//   disk   — one file per key inside the project's audio cache folder, so a
//            bake survives a reload. A missing file is not an error: it is
//            simply a miss, and the bake is recomputed and rewritten. That is
//            what makes "delete the cache folder, reload the project" heal
//            itself instead of silently playing the wrong audio.
//
// Threading:
//   Main thread   — setCacheDir, lookup, submit, isPending, drain bookkeeping.
//                   lookup() NEVER blocks on DSP; it returns nullptr on a miss
//                   and the caller falls back to the raw PCM until the bake
//                   lands.
//   Worker thread — getOrCompute (disk read, or DSP + disk write). Owned by the
//                   internal ThreadPool.
//   Audio thread  — NEVER. Buffers reach the audio path only as a
//                   shared_ptr the Sampler publishes atomically.

struct BakeKey {
    uint64_t sourceHash   = 0;      // xxh3_64 of the post-destructive-flag PCM
    int32_t  algorithm    = 0;      // StretchMethod (1=PSOLA … 5=WORLD)
    int32_t  stretchMilli = 1000;   // round(stretch * 1000) — 0.001 quant
    int32_t  shiftCents   = 0;      // round(cents)
    int32_t  sampleRateHz = 0;      // rate the source buffer is stored at
    int32_t  numChannels  = 0;

    bool operator==(const BakeKey& o) const noexcept {
        return sourceHash   == o.sourceHash
            && algorithm    == o.algorithm
            && stretchMilli == o.stretchMilli
            && shiftCents   == o.shiftCents
            && sampleRateHz == o.sampleRateHz
            && numChannels  == o.numChannels;
    }
    bool operator!=(const BakeKey& o) const noexcept { return !(*this == o); }

    // Stable 64-bit digest of every field — the cache file's name. Stable
    // across runs and machines, which is the whole point of a disk tier.
    uint64_t digest() const noexcept;
};

struct BakeKeyHash {
    size_t operator()(const BakeKey& k) const noexcept {
        return static_cast<size_t>(k.digest());
    }
};

class SlotBakeCache {
public:
    static constexpr size_t kDefaultMaxBytes = 256ull * 1024ull * 1024ull;
    static constexpr int    kThreads         = 2;

    explicit SlotBakeCache(size_t maxBytes = kDefaultMaxBytes);
    ~SlotBakeCache();

    // ── Main thread ──────────────────────────────────────────────────────────

    // Where the disk tier lives. Empty disables it (memory-only) — which is
    // what an unsaved project gets, since it has no folder to write into yet.
    // Changing it does NOT invalidate memory entries: the key is content-based,
    // so the same bake is still the same bake in a different project.
    void        setCacheDir(const std::string& dir);
    std::string cacheDir() const;

    // Non-blocking. Returns the baked buffer when it is already in memory,
    // else nullptr. Never touches the disk and never runs DSP. Not const: a
    // hit promotes the entry to most-recently-used.
    std::shared_ptr<const juce::AudioBuffer<float>> lookup(const BakeKey& key);

    // Queue a bake for `key` unless one is already in flight or already
    // resident. `source` is COPIED synchronously, so callers may pass a
    // temporary. Returns true when a job was actually queued.
    bool submit(const BakeKey& key, const juce::AudioBuffer<float>& source);

    bool   isPending(const BakeKey& key) const;
    size_t pendingCount() const;

    // Bumped once per completed bake. A caller that parked work on a miss can
    // watch this instead of registering a per-job callback: when it moves, some
    // pending key is now resident, and re-running lookup() is cheap.
    uint64_t completionEpoch() const noexcept {
        return completionEpoch_.load(std::memory_order_acquire);
    }

    // ── Worker thread (and direct/synchronous callers: tests, offline render) ─
    // Memory hit → return it. Disk hit → load, insert, return. Otherwise run
    // the algorithm, insert, write the disk entry, return. Never call from the
    // audio thread.
    std::shared_ptr<const juce::AudioBuffer<float>>
    getOrCompute(const BakeKey& key, const juce::AudioBuffer<float>& source);

    // ── Keying ───────────────────────────────────────────────────────────────
    // xxh3_64 over every channel's raw float bytes plus the buffer shape. The
    // slot's destructive flags are applied BEFORE this is taken, so they are
    // folded into the key without needing their own fields.
    static uint64_t hashPCM(const juce::AudioBuffer<float>& src) noexcept;

    // ── Instrumentation / lifecycle ──────────────────────────────────────────
    uint64_t computeCount()  const noexcept { return computeCount_.load(std::memory_order_relaxed); }
    uint64_t diskHitCount()  const noexcept { return diskHitCount_.load(std::memory_order_relaxed); }
    uint64_t diskWriteCount() const noexcept { return diskWriteCount_.load(std::memory_order_relaxed); }
    size_t   entryCount()    const noexcept;
    size_t   currentBytes()  const noexcept { return bytesNow_.load(std::memory_order_relaxed); }

    // Drop the memory tier, leaving disk entries alone. The "cache folder was
    // deleted underneath us" test needs this to see past the memory tier.
    void clearMemory();

    // Block until every queued bake has finished. Main thread only; used by
    // shutdown and by tests that need a deterministic point to assert at.
    void waitForPendingJobs(int timeoutMs = 60000);

    // Absolute path of the disk entry for `key` (empty when no cache dir is
    // set). Exposed so tests can delete a specific bake file.
    std::string filePathForKey(const BakeKey& key) const;

private:
    friend class SlotBakeJob;

    using BufferPtr = std::shared_ptr<const juce::AudioBuffer<float>>;
    struct Entry {
        BufferPtr                     buffer;
        std::list<BakeKey>::iterator  lruIt;
        size_t                        bytes = 0;
    };

    void      insert(const BakeKey& key, BufferPtr buffer);
    void      evictLocked();
    void      finishJob(const BakeKey& key);
    static size_t bufferBytes(const juce::AudioBuffer<float>& b) noexcept;

    // Disk tier. Both are no-ops (returning nullptr / false) when no cache dir
    // is configured. readEntry verifies the key stored in the file header, so a
    // filename collision or a truncated write reads as a miss rather than as
    // the wrong audio.
    std::shared_ptr<juce::AudioBuffer<float>> readEntry(const BakeKey& key);
    bool                                     writeEntry(const BakeKey& key,
                                                        const juce::AudioBuffer<float>& buf);

    // Pure dispatch onto the five timeline stretch algorithms. Worker thread.
    static juce::AudioBuffer<float> runAlgorithm(const BakeKey& key,
                                                 const juce::AudioBuffer<float>& source);

    mutable std::mutex                                  mu_;
    std::list<BakeKey>                                  lruOrder_;   // front = MRU
    std::unordered_map<BakeKey, Entry, BakeKeyHash>     map_;
    std::unordered_set<BakeKey, BakeKeyHash>            pending_;
    std::string                                         cacheDir_;

    std::unique_ptr<juce::ThreadPool> pool_;

    std::atomic<size_t>   maxBytes_;
    std::atomic<size_t>   bytesNow_{0};
    std::atomic<uint64_t> computeCount_{0};
    std::atomic<uint64_t> diskHitCount_{0};
    std::atomic<uint64_t> diskWriteCount_{0};
    std::atomic<uint64_t> completionEpoch_{0};
};

} // namespace xleth::audio
