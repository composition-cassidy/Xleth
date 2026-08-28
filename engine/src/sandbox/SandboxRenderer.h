#pragma once

#include "dsp/PitchTrackAnalysis.h"
#include "sandbox/SandboxOp.h"

#include <juce_audio_basics/juce_audio_basics.h>
#include <juce_core/juce_core.h>

#include <atomic>
#include <cstdint>
#include <deque>
#include <list>
#include <memory>
#include <mutex>
#include <string>
#include <unordered_map>
#include <vector>

// ─── SandboxRenderer ──────────────────────────────────────────────────────────
//
// Evaluates a SandboxOp stack against a source buffer into an output buffer,
// offline, on a worker thread. The Sandbox's whole identity is "every job too
// heavy to run live" — so nothing here ever runs under the audio callback.
//
// ── The prefix cache is the design ───────────────────────────────────────────
// Entries are keyed by (sourceBufferId, prefixHash(ops, i), i, sampleRate) —
// the identity of the audio AFTER op i-1 has run. So a stack of N ops leaves N+1
// cacheable states, and editing op k changes the hash of prefixes k+1..N while
// leaving 0..k untouched.
//
// renderStack() therefore walks DOWN from the full stack looking for the deepest
// prefix already cached, and resumes from there. Re-rendering after a param
// tweak on op 1 of a 3-op stack costs exactly 2 op evaluations, not 3, and it
// falls out of the keying rather than needing separate dirty plumbing to stay
// correct. SandboxOp::dirty exists for the UI's benefit; the cache does not
// consult it, so a stale flag can never produce wrong audio.
//
// ── Sample-rate domain ───────────────────────────────────────────────────────
// Every index in a stack is in engine-buffer samples at the rate the SOURCE is
// stored at. That rate is part of the cache key, so the same stack applied to a
// re-baked source at another rate is a different render rather than a silently
// mis-scaled one. renderStack() refuses a non-positive rate outright — a guessed
// 44100 is exactly the bug the key is there to prevent.
//
// ── Threading ────────────────────────────────────────────────────────────────
//   Main thread   — submit, lookup, publish bookkeeping, stats
//   Worker thread — renderStack (owned by the internal ThreadPool)
//   Audio thread  — publishedOutput() ONLY. Atomic shared_ptr load: no
//                   allocation, no lock, no logging, no DSP. That published
//                   buffer is the only thing playback ever touches.

namespace xleth::sandbox {

using SandboxBuffer    = juce::AudioBuffer<float>;
using SandboxBufferPtr = std::shared_ptr<const SandboxBuffer>;

// ─── SandboxRenderKey ─────────────────────────────────────────────────────────

struct SandboxRenderKey {
    int      sourceBufferId = -1;
    uint64_t opStackHash    = 0;   // prefixHash(ops, opCount)
    int      opCount        = 0;   // how many ops this state has had applied
    int      sampleRateHz   = 0;   // rate the source buffer is stored at

    bool operator==(const SandboxRenderKey& o) const noexcept {
        return sourceBufferId == o.sourceBufferId
            && opStackHash    == o.opStackHash
            && opCount        == o.opCount
            && sampleRateHz   == o.sampleRateHz;
    }

    uint64_t digest() const noexcept;
};

struct SandboxRenderKeyHash {
    size_t operator()(const SandboxRenderKey& k) const noexcept {
        return static_cast<size_t>(k.digest());
    }
};

// ─── SandboxRenderResult ──────────────────────────────────────────────────────

struct SandboxRenderResult {
    SandboxBufferPtr buffer;

    // Ops actually evaluated by this call. The number the smoke test asserts on:
    // a 3-op stack renders 3 the first time and 2 after op 1 changes.
    int opsEvaluated = 0;

    // Index the render resumed from — the depth of the deepest cached prefix.
    int resumedAtOp = 0;

    // True when the FULL stack was already cached and nothing ran.
    bool fullyCached = false;

    // Ops that were skipped because their DSP has not landed (Pitch, Stretch).
    // Surfaced so the UI can say "not built yet" instead of leaving the user
    // to conclude the edit was ignored.
    int unimplementedOps = 0;

    // Ops that ARE built but REFUSED this particular input and rendered as a
    // pass-through — today only AUTOTUNE, on material its pitch analysis judges
    // non-monophonic (see AutotuneParams). Distinct from unimplementedOps: "not
    // built yet" and "built, and it will not fake this" are different things to
    // tell a user, and the second one comes with a reason.
    //
    // refusalReason carries the FIRST refusal's own wording, verbatim from the
    // analysis that produced it. It survives a cache hit: renderStack re-probes
    // the pitch-track cache on the fully-cached path rather than letting the
    // message vanish the moment nothing needs re-rendering.
    int         refusedOps = 0;
    std::string refusalReason;

    bool valid() const { return buffer != nullptr; }
};

// ─── Composite mixing (SB-5) ───────────────────────────────────────────────────
//
// One layer's contribution to a composite mix — everything SandboxLayer keeps
// OUTSIDE its op-stack, plus the buffer/rate the caller already resolved.
// SandboxRenderer::renderComposite() never touches SandboxCore or SampleBank
// itself; the RPC layer builds this list from each layer's published render.
struct SandboxLayerMixInput {
    SandboxBufferPtr buffer;            // this layer's currently published render
    double  bufferSampleRate = 0.0;     // rate `buffer` is stored at
    double  gainDb           = 0.0;
    double  pan              = 0.0;     // -1..1
    int64_t offsetSamples    = 0;       // delay, in samples at bufferSampleRate
    bool    muted            = false;
    bool    soloed           = false;
};

struct SandboxCompositeResult {
    SandboxBufferPtr buffer;
    double sampleRate  = 0.0;   // rate `buffer` is stored at
    int    layersMixed = 0;     // layers that actually contributed audio

    bool valid() const { return buffer != nullptr; }
};

// ─── SandboxRenderer ──────────────────────────────────────────────────────────

class SandboxRenderer {
public:
    static constexpr size_t kDefaultMaxBytes = 512ull * 1024ull * 1024ull;
    static constexpr int    kThreads         = 2;

    // Upper bound on live layer ids. A sandbox session is a handful of sources,
    // not thousands; ids above this are refused by publish() rather than
    // silently dropped, so the ceiling can never become a wrong-audio bug.
    static constexpr int    kMaxLayers       = 256;

    explicit SandboxRenderer(size_t maxBytes = kDefaultMaxBytes);
    ~SandboxRenderer();

    SandboxRenderer(const SandboxRenderer&)            = delete;
    SandboxRenderer& operator=(const SandboxRenderer&) = delete;

    // ── Worker thread, or any non-audio thread (tests, offline render) ───────
    //
    // Evaluates `ops` against `source` and returns the finished buffer, reusing
    // the deepest cached prefix. `source` must be the raw PCM for
    // `sourceBufferId` at `bufferSampleRate`.
    //
    // Returns an invalid result (buffer == nullptr) when bufferSampleRate <= 0
    // or the source is empty. Never blocks on the pool; this IS the work.
    SandboxRenderResult renderStack(int sourceBufferId,
                                    const SandboxBuffer& source,
                                    const std::vector<SandboxOp>& ops,
                                    double bufferSampleRate);

    // ── Main thread ──────────────────────────────────────────────────────────

    // Non-blocking cache probe for the FULL stack. nullptr = not rendered yet.
    // Promotes the entry to most-recently-used, hence non-const.
    SandboxBufferPtr lookup(int sourceBufferId,
                            const std::vector<SandboxOp>& ops,
                            double bufferSampleRate);

    // Queue a render for `layerId` unless an identical one is already in flight.
    // `source` is COPIED synchronously, so a temporary is safe to pass.
    // Returns true when a job was queued.
    //
    // On completion the finished buffer is published for `layerId` and
    // completionEpoch() is bumped.
    bool submit(int layerId,
                int sourceBufferId,
                const SandboxBuffer& source,
                const std::vector<SandboxOp>& ops,
                double bufferSampleRate);

    bool   isPending(int layerId) const;
    size_t pendingCount() const;

    // Bumped once per completed render. A caller that parked on a miss watches
    // this instead of registering a per-job callback — same contract as
    // SlotBakeCache::completionEpoch.
    uint64_t completionEpoch() const noexcept {
        return completionEpoch_.load(std::memory_order_acquire);
    }

    // Block until every queued render finishes. Main thread only; used by
    // shutdown and by tests that need a deterministic point to assert at.
    void waitForPendingJobs(int timeoutMs = 60000);

    // ── Audio thread ─────────────────────────────────────────────────────────
    //
    // The ONLY method the audio callback may call. Atomic shared_ptr load — no
    // allocation, no lock, no logging. Returns nullptr when nothing has been
    // published for this layer yet, and the caller falls back to silence (or to
    // the raw source, its choice); it must NOT wait.
    //
    // Holding the returned shared_ptr for the duration of a block keeps the
    // buffer alive even if a newer render is published mid-block, which is what
    // makes the handoff atomic instead of a use-after-free.
    SandboxBufferPtr publishedOutput(int layerId) const noexcept;

    // Main thread. Publishes `buffer` as the output for `layerId` — the atomic
    // handoff the audio thread reads. Called by the render job; exposed because
    // bake/swap (SB-5/SB-6) publish through the same door.
    void publish(int layerId, SandboxBufferPtr buffer);

    // Drop a layer's published buffer (layer removed / sandbox closed).
    void unpublish(int layerId);

    // ── Cache management / instrumentation ───────────────────────────────────

    void   clearCache();
    size_t entryCount()   const;
    size_t currentBytes() const noexcept { return bytesNow_.load(std::memory_order_relaxed); }

    // Total ops evaluated across every render since construction. The smoke
    // test's proof that a downstream-only re-render happened.
    uint64_t opEvalCount() const noexcept { return opEvalCount_.load(std::memory_order_relaxed); }
    uint64_t renderCount() const noexcept { return renderCount_.load(std::memory_order_relaxed); }
    uint64_t cacheHitCount() const noexcept { return cacheHitCount_.load(std::memory_order_relaxed); }

    // ── Op evaluation (exposed for testing) ──────────────────────────────────
    //
    // Applies ONE op to `in`, returning the result. A bypassed or unimplemented
    // op returns `in` unchanged (a copy). Pure — no cache, no state. `clipboard`
    // is consulted only by PASTE (nullptr = insert/overwrite silence, exactly
    // the fallback a stale or -1 clipboardId gets at real render time too — see
    // PasteParams). Passing it directly here is what keeps this method pure
    // and testable without going through the clipboard store below.
    //
    // `pitchTrack` and `refusalOut` are AUTOTUNE's equivalents of `clipboard`:
    // resources the real render path resolves for the op, passed in explicitly
    // so this stays pure.
    //   pitchTrack — the analysis of `in` (NOT of the layer's source: this op
    //                may sit downstream of edits that changed the audio). The
    //                render path supplies it from the renderer's own
    //                prefix-keyed cache; nullptr means "analyze `in` here and
    //                now", which is what a direct test caller gets and is
    //                always correct, only slower.
    //   refusalOut — set to the reason when a built op declines to render this
    //                input and passes it through instead. Left untouched
    //                otherwise. See SandboxRenderResult::refusalReason.
    static SandboxBuffer applyOp(const SandboxBuffer& in,
                                 const SandboxOp& op,
                                 double bufferSampleRate,
                                 const SandboxBuffer* clipboard = nullptr,
                                 const xleth::dsp::PitchTrackResult* pitchTrack = nullptr,
                                 std::string* refusalOut = nullptr);

    // ── Composite mixing (SB-5, exposed for testing) ─────────────────────────
    //
    // Mixes N layers' own rendered outputs into one stereo buffer, honoring
    // each layer's gain/pan/offset/mute/solo — the mix params SandboxLayer
    // keeps OUTSIDE its op-stack. Pure/static, no cache, no instance state:
    // this never touches SandboxCore or SampleBank itself, so it is directly
    // testable with fixture buffers, exactly like applyOp.
    //
    // Rules (see the .cpp for the full rationale):
    //   • Output is always 2-channel. A mono layer's buffer broadcasts to both
    //     output channels before panning; a stereo layer's two channels are
    //     scaled independently (a balance pan), matching TrackMixer::applyPan's
    //     convention (engine/src/audio/TrackMixer.h) so a Sandbox layer panned
    //     the same way sits at the same apparent level as a mixer track.
    //   • Layers at different bufferSampleRate are resampled UP to the highest
    //     rate present (juce::LagrangeInterpolator, the same approach
    //     SampleBank::loadSample uses) rather than ever downsampling.
    //   • offsetSamples is a DELAY, in samples at the layer's own
    //     bufferSampleRate; negative values clamp to 0 (a "delay" cannot be
    //     negative — see SandboxLayer's own comment).
    //   • Solo: if any layer is soloed, only soloed-and-unmuted layers sound;
    //     otherwise every unmuted layer sounds. Mute always wins over solo for
    //     that one layer — the two flags are not mutually exclusive in the
    //     model.
    //   • Composite LENGTH is computed from every layer regardless of mute, so
    //     silencing a layer never shrinks the timeline out from under the
    //     others.
    //
    // Returns an invalid result (buffer == nullptr) when `layers` is empty or
    // nothing in it has real audio to contribute (e.g. every layer's stack
    // trimmed itself to zero length).
    static SandboxCompositeResult renderComposite(const std::vector<SandboxLayerMixInput>& layers);

    // ── Spectral extraction (SPC selection "Copy to New Layer", exposed for testing) ──
    //
    // Produces a NEW buffer containing ONLY the audio inside `keepDabs`' time x
    // frequency footprints (each a rectangle with raised-cosine feather, same
    // shape SpectralPaintDab uses for ATTENUATE/BOOST/MUTE) — the complement of
    // applySpectralPaint: everything NOT covered by any dab is silenced instead
    // of everything covered being attenuated. amountDb on each dab is ignored;
    // only its footprint/feather matter. Pure/static/no-cache, same testing
    // contract as applyOp/renderComposite above — never touches SandboxCore or
    // SampleBank.
    //
    // Empty `keepDabs` returns silence (nothing selected, nothing kept) — NOT
    // a pass-through, unlike SPECTRAL_PAINT's own empty-dabs gate.
    static SandboxBuffer extractSelection(const SandboxBuffer& in,
                                          const std::vector<SpectralPaintDab>& keepDabs,
                                          double bufferSampleRate);

    // ── Clipboard (main thread; CUT/COPY/PASTE) ──────────────────────────────
    //
    // Session-local only — NOT persisted with the project. A PASTE op's
    // clipboardId that no longer resolves (new session, evicted, never
    // existed) degrades to silence of clipboardLengthSamples at render time
    // rather than failing; see PasteParams. Capturing reads straight out of a
    // caller-supplied buffer (the layer's own published render for COPY/CUT
    // from a selection), so this file never has to reach into SampleBank.
    //
    // Returns -1 when [startSample, endSample) does not overlap `source`.
    int captureClipboard(const SandboxBuffer& source, int64_t startSample, int64_t endSample);

    // nullptr when `clipboardId` is unknown (including -1, the "silence" id).
    SandboxBufferPtr clipboardBuffer(int clipboardId) const;

private:
    friend class SandboxRenderJob;

    struct Entry {
        SandboxBufferPtr                     buffer;
        std::list<SandboxRenderKey>::iterator lruIt;
        size_t                               bytes = 0;
    };

    SandboxBufferPtr lookupKey(const SandboxRenderKey& key);
    void             insert(const SandboxRenderKey& key, SandboxBufferPtr buffer);
    void             evictLocked();
    void             finishJob(int layerId);

    // ── AUTOTUNE detection cache ─────────────────────────────────────────────
    //
    // Keyed by SandboxRenderKey — the identity of the audio an AUTOTUNE op
    // RECEIVES, i.e. the prefix state just above it. That is the only correct
    // key: SandboxPitchTrackAnalyzer (XlethEngineService's cache, which feeds
    // the UI's pitch overlay) is keyed by sourceBufferId and therefore
    // describes the layer's RAW SOURCE — right for "what would AUTOTUNE
    // correct", wrong for an AUTOTUNE sitting below a trim and a denoise.
    //
    // Reusing the render key also gets the invalidation for free: change an
    // upstream op and the prefix hash changes, so the analysis misses exactly
    // when it should. Drag one of AUTOTUNE's own six controls and the prefix
    // above it is untouched, so the (expensive) detection pass is skipped and
    // only the (cheap) PSOLA re-runs — which is what lets autoRender() stay
    // true for this op.
    //
    // analyzeFor() computes OUTSIDE the lock (an NSDF pass over a whole buffer
    // is far too long to hold mu_ for, with a second worker thread live), same
    // lookup/compute/insert shape SandboxPitchTrackAnalyzer::analyze uses.
    static constexpr size_t kMaxPitchEntries = 16;
    using PitchTrackPtr = std::shared_ptr<const xleth::dsp::PitchTrackResult>;

    PitchTrackPtr analyzeFor(const SandboxRenderKey& key,
                             const SandboxBuffer& in,
                             double bufferSampleRate);
    PitchTrackPtr lookupPitch(const SandboxRenderKey& key);   // probe only, no compute

    static size_t bufferBytes(const SandboxBuffer& b) noexcept;

    mutable std::mutex mu_;
    std::list<SandboxRenderKey> lruOrder_;                                    // front = MRU
    std::unordered_map<SandboxRenderKey, Entry, SandboxRenderKeyHash> map_;

    // layerId -> in-flight. Guarded by mu_.
    std::unordered_map<int, bool> pending_;

    // AUTOTUNE detection cache (see analyzeFor above). Guarded by mu_ — it is
    // touched once per AUTOTUNE op per render, nowhere near often enough to
    // justify a second lock.
    std::unordered_map<SandboxRenderKey, PitchTrackPtr, SandboxRenderKeyHash> pitchCache_;
    std::list<SandboxRenderKey> pitchLru_;                   // front = MRU

    // Clipboard store for CUT/COPY/PASTE. Guarded by mu_ — capture/lookup are
    // both main-thread, low-frequency, and already sharing the cache's lock is
    // simpler than a second one for what is at most a handful of small
    // buffers. A small FIFO cap, not full LRU: unlike the render cache this is
    // not read every frame, so eviction order only has to be "bounded", not
    // "optimal".
    static constexpr size_t kMaxClipboardEntries = 64;
    std::unordered_map<int, SandboxBufferPtr> clipboard_;
    std::deque<int>                           clipboardOrder_;   // insertion order, front = oldest
    int                                        nextClipboardId_ = 1;

    // layerId -> published output, read lock-free from the audio thread.
    //
    // A FLAT ARRAY, not a map, for the same reason ClipRenderCache::slots_ is
    // one: the audio thread indexes it directly. An unordered_map lookup racing
    // a main-thread insert is a rehash away from undefined behaviour, and no
    // amount of care on the writer side fixes that for the reader.
    //
    // C++20 std::atomic<shared_ptr> — on MSVC x64 that is internally lock-striped
    // (~20 ns), negligible against a 256-sample block and free of user-level
    // blocking, which is the bar the audio thread actually has to clear.
    mutable std::atomic<SandboxBufferPtr> published_[kMaxLayers];

    std::unique_ptr<juce::ThreadPool> pool_;

    std::atomic<size_t>   maxBytes_;
    std::atomic<size_t>   bytesNow_{0};
    std::atomic<uint64_t> opEvalCount_{0};
    std::atomic<uint64_t> renderCount_{0};
    std::atomic<uint64_t> cacheHitCount_{0};
    std::atomic<uint64_t> completionEpoch_{0};
};

} // namespace xleth::sandbox
