#pragma once

#include <juce_audio_basics/juce_audio_basics.h>
#include "model/TimelineTypes.h"

#include <atomic>
#include <cstddef>
#include <cstdint>
#include <list>
#include <memory>
#include <mutex>
#include <unordered_map>
#include <unordered_set>
#include <vector>

namespace xleth::audio { class WorldStretchCache; }

// ─── CacheKey ────────────────────────────────────────────────────────────────
// Uniquely identifies a processed audio segment. Two clips that produce the
// same key can share a buffer; a key change triggers a fresh render job.
//
// In-memory only — never serialized — so adding fields (and so changing the
// hash) is free.

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

    // ── Pitch Shifter Clip mode (the track's SourceTransform) ───────────────
    // fxMethod == 0 means "no fx transform": the ORIGINAL render, exactly the
    // key every clip had before Clip mode existed. A non-zero fxMethod makes
    // this the SHIFTED render of the same clip: the clip's own pitch fields
    // above are left alone and ClipRenderJob sums the two (see
    // resolveEffectiveRender). stretchRatio is never touched by the fx, so a
    // shifted buffer is always exactly durationSamples long — the clip's A/V
    // sync is preserved structurally, not by compensation.
    int     fxPitchSemis        = 0;
    int     fxPitchCents        = 0;
    int     fxMethod            = 0;   // StretchMethod 1..5; 0 = no fx transform
    bool    fxFormant           = false;

    bool hasFx() const noexcept { return fxMethod != 0; }

    bool operator==(const CacheKey& o) const noexcept;
};

// Hash for content-addressing. Two clips whose CacheKeys are equal produce
// bit-identical audio, so they share one render job and one buffer.
struct CacheKeyHash {
    size_t operator()(const CacheKey& k) const noexcept;
};

// ─── Effective render ─────────────────────────────────────────────────────────
// What the DSP actually runs for a key. For a key without an fx transform this
// is the key's own fields, verbatim. With one, pitch is clip + fx (cents
// carried into semitones, total clamped to ±kMaxEffectiveSemis), and the
// method and formant flag are the fx's — the Pitch Shifter chose them.
struct EffectiveRender {
    int    pitchSemis      = 0;
    int    pitchCents      = 0;      // always in (-100, 100)
    int    method          = 0;
    bool   formantPreserve = false;
    // An fx render always runs its engine, even at 0 st: a formant-only
    // transform is a real render, and a raw copy would silently drop it.
    bool   forceEngine     = false;

    double totalSemitones() const noexcept { return pitchSemis + pitchCents / 100.0; }
};

static constexpr int kMaxEffectiveSemis = 48;
EffectiveRender resolveEffectiveRender(const CacheKey& key) noexcept;

// ─── Alignment report ────────────────────────────────────────────────────────
// Written once by the render job (before `ready`), read-only afterwards. Only
// fx renders are aligned; an original render reports measured == false.
struct ClipAlignmentReport {
    bool    measured          = false;
    bool    confident         = false;
    int     basis             = 0;      // xleth::dsp::LagEstimate::Basis
    int     measuredLag       = 0;      // wet lag vs dry before compensation (samples, + = late)
    int     appliedLag        = 0;      // what was actually compensated (0 when not confident)
    double  peak              = 0.0;    // correlation peak at measuredLag
    int64_t engineSamples     = 0;      // samples the engine produced
    int64_t undershootSamples = 0;      // trailing outBuf samples the aligned wet could not fill
};

// ─── CacheEntry ───────────────────────────────────────────────────────────────
// Owned by ClipRenderCache. The buffer pointer is published atomically once
// the worker thread sets ready = true. `buffer` and `alignment` are written
// exactly once, before `ready`, and never again.

struct CacheEntry {
    CacheKey  key;
    std::shared_ptr<juce::AudioBuffer<float>> buffer;
    std::atomic<bool> ready{false};
    ClipAlignmentReport alignment;

    // Clip IDs currently sharing this entry. Guarded by ClipRenderCache::
    // cacheMutex_ — message/worker threads only, never the audio thread.
    // publishEntry() fans the finished buffer out to every subscriber, so a
    // paste of N identical clips costs exactly one render.
    std::unordered_set<int> subscribers;

    // ── LRU bookkeeping (cacheMutex_) ───────────────────────────────────────
    bool                             resident = false;   // counted in bytesNow_
    size_t                           bytes    = 0;
    std::list<CacheEntry*>::iterator lruIt;

    // Audio thread stamps this on every hit (relaxed store, no lock). The
    // eviction pass never retires an entry heard within the hot window.
    std::atomic<int64_t> lastHitMs{0};

    CacheEntry() = default;
    CacheEntry(const CacheEntry&) = delete;
    CacheEntry& operator=(const CacheEntry&) = delete;
};

// ─── ClipRenderCache ──────────────────────────────────────────────────────────
//
// Threading model:
//   Audio thread   — acquire(), noteMiss() : atomic slot loads, no mutex
//   Message thread — submitJob(), markDirty(), drainMisses() : cacheMutex_
//   Worker thread  — runs DSP, calls publishEntry() to make result visible
//
// Cache miss → audio thread falls back to raw PCM (zero-overhead path).
// Cache hit  → audio thread reads pre-rendered buffer (lock-free).
//
// Two slot LANES per clip. The ORIGINAL lane holds the clip's own render (no
// fx transform); the FX lane holds the Pitch Shifter Clip-mode render of the
// same clip. A key's lane is key.hasFx(). An entry therefore only ever lives
// in one lane, and a clip on a Clip-mode track can have one entry in each.
//
// slots_ uses std::atomic<std::shared_ptr<T>> (C++20).  On MSVC x64, the
// implementation uses internal lock striping (~20 ns); this is negligible
// compared to a 256-sample audio block (~5.8 ms at 44100 Hz) and satisfies
// the "no user-level blocking" requirement.
//
// RETIREMENT. The audio thread holds a shared_ptr copy of an entry for the
// whole clip pass (acquire()). Every entry a slot or map lets go of — slot
// replaced by a newer publish, markDirty, LRU eviction, last subscriber gone —
// is parked on retired_ and only freed, by a message/worker thread, once the
// retire list is its sole owner. The audio thread can never drop the last
// reference, so it can never run a buffer's deallocation.
//
// MEMORY BOUND. Resident (published, still-subscribed) entries are counted in
// bytes and kept in LRU order, WorldStretchCache's scheme. Past maxBytes() the
// least-recently-used entries are evicted, except entries still rendering and
// entries the audio thread hit within the hot window — evicting audio that is
// playing right now would just thrash. When only protected entries remain the
// cache stays over the cap and counts it (overCapEvents()). An evicted clip
// misses on its next play, reports it through noteMiss(), and MixEngine's
// service pass resubmits it. Eviction is suspended while an export runs, so an
// export never loses a buffer it waited for.

class ClipRenderCache {
public:
    // TODO: static flat array indexed by clip ID; IDs are monotonic and never
    // reused (shared counter across all entity types), so the cap erodes over
    // time. Consider switching slots_ to an unordered_map<int,…> once the
    // real-time read path is audited for lock acceptability.
    static constexpr int kMaxClipId  = 65536;
    // Upper bound on worker count; actual count is clamp(hardware_concurrency()/2 - 1, 1, kMaxThreads).
    static constexpr int kMaxThreads = 4;

    static constexpr size_t  kDefaultMaxBytes  = 512ull * 1024ull * 1024ull;
    static constexpr int64_t kDefaultHotWindowMs = 2000;
    static constexpr int     kMissRingCapacity = 4096;   // power of two

    ClipRenderCache();
    ~ClipRenderCache();

    // Monotonic milliseconds, the clock every lastHitMs stamp uses. Lock- and
    // allocation-free (QueryPerformanceCounter underneath), audio-thread safe.
    static int64_t nowMs() noexcept;

    // ── Audio thread ─────────────────────────────────────────────────────────
    // Lock-free. Returns the ready entry for clipId in key's lane when its key
    // matches, pinned for as long as the caller holds the pointer, and stamps
    // its hit time with `nowMs`. nullptr = cache miss — caller should use raw
    // PCM. The caller must let the pointer go on the audio thread only because
    // retirement guarantees it is never the last owner.
    std::shared_ptr<const CacheEntry> acquire(int clipId, const CacheKey& key,
                                              int64_t nowMs) const noexcept;

    // Record that clipId wanted a render and found none. Deduplicated per clip
    // until drained; a full ring drops the report (the clip reports again on a
    // later block). Wait-free, no allocation.
    void noteMiss(int clipId) noexcept;

    // Message-thread convenience: same lookup as acquire(), no hit stamp. The
    // returned pointer pins its entry (aliasing shared_ptr, no allocation), so
    // a worker-thread eviction cannot free the buffer under the reader.
    std::shared_ptr<const juce::AudioBuffer<float>> getProcessedBuffer(
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
    // Evict every entry for clipId, both lanes (e.g. clip deleted).
    void markDirty(int clipId);
    // Evict only one lane. markDirtyLane(id, true) drops a clip's fx render when
    // its track stops asking for one, leaving the original render intact.
    void markDirtyLane(int clipId, bool fxLane);

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

    // Move every pending miss report into `out` (appends). Message thread.
    void drainMisses(std::vector<int>& out);

    // The entry clipId holds in one lane (ready or not), or nullptr.
    // Observability/tests. Thread-safe: acquires cacheMutex_.
    std::shared_ptr<const CacheEntry> peekEntry(int clipId, bool fxLane) const;

    // ── Memory bound ─────────────────────────────────────────────────────────
    void   setMaxBytes(size_t bytes);
    size_t maxBytes() const noexcept { return maxBytes_.load(std::memory_order_relaxed); }
    size_t currentBytes() const noexcept { return bytesNow_.load(std::memory_order_relaxed); }
    size_t residentEntryCount() const;
    void   setHotWindowMs(int64_t ms) noexcept { hotWindowMs_.store(ms, std::memory_order_relaxed); }
    // True while an export runs: no eviction at all. Clearing it runs one pass.
    void   setEvictionSuspended(bool suspended);
    uint64_t evictionCount() const noexcept { return evictions_.load(std::memory_order_relaxed); }
    uint64_t overCapEvents() const noexcept { return overCapEvents_.load(std::memory_order_relaxed); }
    // Entries parked on the retire list (not yet freed). Tests.
    size_t retiredCount() const;
    // Render jobs actually handed to the thread pool (shared/kept keys excluded).
    uint64_t submittedRenderCount() const noexcept { return submittedRenders_.load(std::memory_order_relaxed); }
    // Fx renders whose dry/wet lag could not be measured confidently.
    uint64_t unalignedRenderCount() const noexcept { return unalignedRenders_.load(std::memory_order_relaxed); }

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
    using Slot = std::atomic<std::shared_ptr<CacheEntry>>;

    // Per-clipId audio-thread-visible slots. ORIGINAL lane inline (unchanged
    // footprint), FX lane on the heap so MixEngine's own size doesn't double.
    // C++20 std::atomic<shared_ptr<T>> — load/store are always safe across
    // message-thread writes and audio-thread reads.
    mutable Slot slots_[kMaxClipId];
    std::unique_ptr<Slot[]> fxSlots_;

    Slot& slotFor(int clipId, bool fxLane) const noexcept
    {
        return fxLane ? fxSlots_[clipId] : slots_[clipId];
    }

    // [StreamUnder] key-mismatch tally — see getKeyMismatchCount(). Audio thread
    // increments (relaxed); 1s sampler reads. Never gates behaviour.
    mutable std::atomic<uint64_t> keyMismatchCount_{0};

    // Owning maps: keep entries alive until explicitly evicted.
    // Held only by message/worker threads — NEVER audio thread.
    mutable std::mutex                                   cacheMutex_;
    // clipId → entry, one map per lane. Several clip IDs may map to the SAME entry.
    std::unordered_map<int, std::shared_ptr<CacheEntry>> cache_;
    std::unordered_map<int, std::shared_ptr<CacheEntry>> fxCache_;
    std::unordered_map<int, std::shared_ptr<CacheEntry>>& laneMap(bool fxLane) { return fxLane ? fxCache_ : cache_; }
    const std::unordered_map<int, std::shared_ptr<CacheEntry>>& laneMap(bool fxLane) const { return fxLane ? fxCache_ : cache_; }
    // CacheKey → entry. The content-addressed index that makes the sharing
    // above possible: submitJob consults this before spawning any DSP work.
    std::unordered_map<CacheKey, std::shared_ptr<CacheEntry>, CacheKeyHash> byKey_;

    // Entries with an in-flight WORLD render job. Protected by cacheMutex_.
    // Keyed by entry (not clip ID) because one job now serves N clips.
    // Inserted in submitJob, erased in runJob after publishEntry.
    std::unordered_set<CacheEntry*> worldActiveEntries_;

    // ── Retirement + LRU (cacheMutex_) ──────────────────────────────────────
    std::vector<std::shared_ptr<CacheEntry>> retired_;
    std::list<CacheEntry*>                   lruOrder_;   // front = most recent
    std::atomic<size_t>   maxBytes_{kDefaultMaxBytes};
    std::atomic<size_t>   bytesNow_{0};
    std::atomic<int64_t>  hotWindowMs_{kDefaultHotWindowMs};
    bool                  evictionSuspended_ = false;
    std::atomic<uint64_t> evictions_{0};
    std::atomic<uint64_t> overCapEvents_{0};
    std::atomic<uint64_t> submittedRenders_{0};
    std::atomic<uint64_t> unalignedRenders_{0};

    void retireLocked(std::shared_ptr<CacheEntry> e);
    void pruneRetiredLocked();
    // Clear clipId's slot in `fxLane` and retire what it held.
    void clearSlotLocked(int clipId, bool fxLane);
    void makeResidentLocked(CacheEntry& e);
    void dropResidentLocked(CacheEntry& e);
    void evictLocked();

    // Drop clipId's reference to whatever entry it holds in one lane;
    // garbage-collects the entry (and its byKey_ index slot) once the last
    // subscriber leaves. Caller must hold cacheMutex_.
    void detachLocked(int clipId, bool fxLane);

    // ── Miss ring (audio thread → message thread) ───────────────────────────
    // Single producer (the one thread running processBlock — live callback or
    // an offline render, never both), single consumer (message thread).
    std::unique_ptr<std::atomic<int>[]>     missRing_;
    std::atomic<uint32_t>                   missHead_{0};   // producer
    std::atomic<uint32_t>                   missTail_{0};   // consumer
    std::unique_ptr<std::atomic<uint8_t>[]> missPending_;   // dedupe, per clip

    friend class ClipRenderJob;

    std::unique_ptr<juce::ThreadPool> threadPool_;

    xleth::audio::WorldStretchCache* worldCache_ = nullptr;
};
