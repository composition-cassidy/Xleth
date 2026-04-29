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

// ─── CacheEntry ───────────────────────────────────────────────────────────────
// Owned by ClipRenderCache. The buffer pointer is published atomically once
// the worker thread sets ready = true.

struct CacheEntry {
    CacheKey  key;
    std::shared_ptr<juce::AudioBuffer<float>> buffer;
    std::atomic<bool> ready{false};

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

    // ── Message thread ───────────────────────────────────────────────────────
    // Evict the entry for clipId (e.g. clip params changed).
    void markDirty(int clipId);

    // Returns the set of clip IDs that are currently being processed by a WORLD
    // render job. Called by the main process poll to drive the UI spinner.
    // Thread-safe: acquires cacheMutex_ internally.
    std::vector<int> getWorldActiveJobIds() const;

    // Submit a background render job.
    // srcPcm is copied synchronously inside this call — safe to pass a
    // temporary / stack reference.
    void submitJob(int clipId, const CacheKey& key,
                   const juce::AudioBuffer<float>& srcPcm,
                   double sampleRate);

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

    // Owning map: keeps entries alive until explicitly evicted.
    // Held only by message/worker threads — NEVER audio thread.
    mutable std::mutex                                   cacheMutex_;
    std::unordered_map<int, std::shared_ptr<CacheEntry>> cache_;

    // Set of clip IDs with an in-flight WORLD render job. Protected by cacheMutex_.
    // Inserted in submitJob, erased in runJob after publishEntry.
    std::unordered_set<int> worldActiveJobs_;

    friend class ClipRenderJob;

    std::unique_ptr<juce::ThreadPool> threadPool_;

    xleth::audio::WorldStretchCache* worldCache_ = nullptr;
};
