#pragma once

#include <juce_audio_basics/juce_audio_basics.h>
#include "model/TimelineTypes.h"

#include <atomic>
#include <cstdint>
#include <memory>
#include <mutex>
#include <unordered_map>
#include <unordered_set>
#include <vector>

namespace xleth::audio { class WorldStretchCache; }

// ─── CacheKey ────────────────────────────────────────────────────────────────
// Uniquely identifies a processed audio segment. Two clips that produce the
// same key can share a buffer; a key change triggers a fresh render job.

struct CacheKey {
    int     regionId            = 0;
    int     syllableIndex       = -1;
    int64_t regionOffsetSamples = 0;   // start frame inside raw PCM
    int64_t durationSamples     = 0;   // desired output buffer length
    int64_t sourceLengthSamples = 0;   // full raw PCM length (for identity)
    int     pitchOffsetSemis    = 0;
    int     pitchOffsetCents    = 0;
    bool    reversed            = false;
    double  stretchRatio        = 1.0;
    int     stretchMethod       = 0;   // resolved — 1=PSOLA 2=Rubber (never 0=Global)
    bool    formantPreserve     = false;

    bool operator==(const CacheKey& o) const noexcept;
};

// Hash for content-addressing. Two clips whose CacheKeys are equal produce
// bit-identical audio, so they share one render job and one buffer.
struct CacheKeyHash {
    size_t operator()(const CacheKey& k) const noexcept;
};

// ─── CacheEntry ───────────────────────────────────────────────────────────────
// Owned by ClipRenderCache. The buffer pointer is published atomically once
// the worker thread sets ready = true.

struct CacheEntry {
    CacheKey  key;
    std::shared_ptr<juce::AudioBuffer<float>> buffer;
    std::atomic<bool> ready{false};

    // Clip IDs currently sharing this entry. Guarded by ClipRenderCache::
    // cacheMutex_ — message/worker threads only, never the audio thread.
    // publishEntry() fans the finished buffer out to every subscriber, so a
    // paste of N identical clips costs exactly one render.
    std::unordered_set<int> subscribers;

    CacheEntry() = default;
    CacheEntry(const CacheEntry&) = delete;
    CacheEntry& operator=(const CacheEntry&) = delete;
};

// ─── ClipRenderCache ──────────────────────────────────────────────────────────
//
// Threading model:
//   Audio thread   — getProcessedBuffer() : reads slots_ atomically, no mutex
//   Message thread — submitJob(), markDirty() : protected by cacheMutex_
//   Worker thread  — runs DSP, calls publishEntry() to make result visible
//
// Cache miss → audio thread falls back to raw PCM (zero-overhead path).
// Cache hit  → audio thread reads pre-rendered buffer (lock-free).
//
// slots_ uses std::atomic<std::shared_ptr<T>> (C++20).  On MSVC x64, the
// implementation uses internal lock striping (~20 ns); this is negligible
// compared to a 256-sample audio block (~5.8 ms at 44100 Hz) and satisfies
// the "no user-level blocking" requirement.

class ClipRenderCache {
public:
    // TODO: static flat array indexed by clip ID; IDs are monotonic and never
    // reused (shared counter across all entity types), so the cap erodes over
    // time. Consider switching slots_ to an unordered_map<int,…> once the
    // real-time read path is audited for lock acceptability.
    static constexpr int kMaxClipId = 65536;
    static constexpr int kThreads   = 4;

    ClipRenderCache();
    ~ClipRenderCache();

    // ── Audio thread ─────────────────────────────────────────────────────────
    // Lock-free. Returns the ready processed buffer if available and the key
    // matches. nullptr = cache miss — caller should use raw PCM.
    const juce::AudioBuffer<float>* getProcessedBuffer(
        int clipId, const CacheKey& key) const noexcept;

    // [StreamUnder] diagnostic split. getProcessedBuffer() returns nullptr in
    // two distinct situations that look identical to MixEngine's clipCacheMiss
    // counter: (a) no ready entry yet (genuine streaming/render starvation) and
    // (b) a ready entry exists but its key differs from the request (stale-key
    // churn — the audio thread re-falls-back to raw PCM every block AND, today,
    // hits the non-gated MISMATCH fprintf in getProcessedBuffer). Counting the
    // mismatch case separately lets the 1s health sampler tell starvation apart
    // from key churn. Lock-free atomic, incremented on the audio thread.
    uint64_t getKeyMismatchCount() const noexcept {
        return keyMismatchCount_.load(std::memory_order_relaxed);
    }

    // ── Message thread ───────────────────────────────────────────────────────
    // Evict the entry for clipId (e.g. clip params changed).
    void markDirty(int clipId);

    // True when clipId already has an entry rendering (or rendered) under
    // exactly this key. Lets callers skip an evict+resubmit that would throw
    // away a still-valid buffer — a clip MOVE, for instance, changes nothing
    // the key depends on. Thread-safe: acquires cacheMutex_.
    bool hasEntryForKey(int clipId, const CacheKey& key) const;

    // Returns the set of clip IDs that are currently being processed by a WORLD
    // render job. Called by the main process poll to drive the UI spinner.
    // Thread-safe: acquires cacheMutex_ internally.
    std::vector<int> getWorldActiveJobIds() const;

    // Submit a background render job.
    // srcPcm is copied synchronously inside this call — safe to pass a
    // temporary / stack reference.
    // sampleRate is the prepared/export rate the output is rendered at;
    // bufferSampleRate is the rate srcPcm is actually stored at (the bake rate).
    // When they differ, the source region is resampled bake→prepared before
    // pitch/stretch so the cached clip preserves pitch (mirrors the raw path).
    void submitJob(int clipId, const CacheKey& key,
                   const juce::AudioBuffer<float>& srcPcm,
                   double sampleRate,
                   double bufferSampleRate);

    // Block until all pending jobs finish, then free all state.
    // Call before destroying the owning MixEngine.
    void shutdown();

    // ── Worker thread (internal) ─────────────────────────────────────────────
    // Called by ClipRenderJob to publish a completed entry.
    void publishEntry(int clipId, std::shared_ptr<CacheEntry> entry);

    // Optional content-keyed cache for WORLD-method jobs. Set by MixEngine
    // once at construction; null is fine (WORLD branch then runs without
    // caching). Read-only after setup, so no synchronization is needed.
    void setWorldCache(xleth::audio::WorldStretchCache* c) noexcept { worldCache_ = c; }
    xleth::audio::WorldStretchCache* worldCache() const noexcept { return worldCache_; }

private:
    // Per-clipId audio-thread-visible slot.
    // C++20 std::atomic<shared_ptr<T>> — load/store are always safe across
    // message-thread writes and audio-thread reads.
    mutable std::atomic<std::shared_ptr<CacheEntry>> slots_[kMaxClipId];

    // [StreamUnder] key-mismatch tally — see getKeyMismatchCount(). Audio thread
    // increments (relaxed); 1s sampler reads. Never gates behaviour.
    mutable std::atomic<uint64_t> keyMismatchCount_{0};

    // Owning maps: keep entries alive until explicitly evicted.
    // Held only by message/worker threads — NEVER audio thread.
    mutable std::mutex                                   cacheMutex_;
    // clipId → entry. Several clip IDs may map to the SAME entry.
    std::unordered_map<int, std::shared_ptr<CacheEntry>> cache_;
    // CacheKey → entry. The content-addressed index that makes the sharing
    // above possible: submitJob consults this before spawning any DSP work.
    std::unordered_map<CacheKey, std::shared_ptr<CacheEntry>, CacheKeyHash> byKey_;

    // Entries with an in-flight WORLD render job. Protected by cacheMutex_.
    // Keyed by entry (not clip ID) because one job now serves N clips.
    // Inserted in submitJob, erased in runJob after publishEntry.
    std::unordered_set<CacheEntry*> worldActiveEntries_;

    // Drop clipId's reference to whatever entry it holds; garbage-collects the
    // entry (and its byKey_ index slot) once the last subscriber leaves.
    // Caller must hold cacheMutex_.
    void detachLocked(int clipId);

    friend class ClipRenderJob;

    std::unique_ptr<juce::ThreadPool> threadPool_;

    xleth::audio::WorldStretchCache* worldCache_ = nullptr;
};
