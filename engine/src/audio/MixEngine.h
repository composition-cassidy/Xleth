#pragma once

#include <juce_audio_basics/juce_audio_basics.h>

#include <nlohmann/json.hpp>

#include "model/TimelineTypes.h"
#include "model/Timeline.h"
#include "model/EnvelopeParameterModulation.h"
#include "model/LfoParameterModulation.h"
#include "audio/AutomationPlan.h"
#include "SampleBank.h"
#include "Transport.h"
#include "Sampler.h"
#include "audio/AudioPerformanceTelemetry.h"
#include "audio/ClipRenderCache.h"
#include "audio/ClipModulatedReader.h"
#include "render/VisualEchoTypes.h"   // xleth::echo::DelaySnapshot / IDelaySnapshotResolver
#include "audio/SamplerPreviewRoute.h"
#include "audio/SourceTransformTable.h"
#include "dsp/LoudnessAnalyzer.h"

#include <algorithm>
#include <atomic>
#include <limits>
#include <array>
#include <condition_variable>
#include <cstddef>
#include <cstdint>
#include <cstdio>
#include <deque>
#include <map>
#include <memory>
#include <mutex>
#include <shared_mutex>
#include <string>
#include <thread>
#include <unordered_map>
#include <unordered_set>
#include <utility>
#include <vector>

class EffectChainManager;
class EditorProcessCoordinator;
class PluginEditorHost;
class PluginRegistry;
class XlethEffectBase;
namespace juce { class AudioProcessor; }
// Pointer-only member of AutomationRuntimeTarget. Declared rather than
// included: this header pulls juce_audio_basics, not juce_audio_processors,
// and MixEngine.cpp already has the full definition through EffectChainManager.h.
namespace juce { class RangedAudioParameter; }
namespace xleth { struct RoutePlan; struct RoutePdcPlan; }
namespace xleth::audio { class WorldStretchCache; }
// Immutable per-chain node view (AudioGraph.h). Held by shared_ptr only, so an
// incomplete type here keeps juce_audio_processors out of this header.
namespace xleth::audio { struct GraphRealtimeView; }
namespace xleth::audio { class SlotBakeCache; struct BakeKey; }

// ─── Debug log queue (lock-free, single-producer / single-consumer) ──────────

struct MixDebugEntry
{
    enum Type : uint8_t { ActiveClips, Mapping, Peaks, UnmappedRegion };
    Type type;
    char message[252]; // pad to 256 bytes total
};

class MixDebugLog
{
public:
    explicit MixDebugLog(int capacity = 256);

    // Audio thread — push a log entry. Returns false if full (drop the log).
    bool push(const MixDebugEntry& entry);

    // Non-audio thread — pop one entry. Returns false if empty.
    bool pop(MixDebugEntry& entry);

private:
    std::vector<MixDebugEntry>  buffer_;
    int                         mask_;
    std::atomic<int>            writePos_{0};
    std::atomic<int>            readPos_{0};

    static int nextPow2(int v);
};

// ─── MixEngine ───────────────────────────────────────────────────────────────
// Multi-track timeline mixer. Reads clips from the Timeline data model,
// fetches audio from SampleBank via regionToSampleMap_, mixes per-track
// with volume/pan/spread/mute/solo, and sums to stereo output.

class MixEngine
{
public:
    static constexpr int kMaxTracks = 64;

    MixEngine();
    ~MixEngine();

    // ── Configuration (main thread) ──────────────────────────────────────────
    void setTimeline(const Timeline* timeline);
    void setSampleBank(const SampleBank* bank);

    // Map a region ID to a sample bank slot. Must be called from main thread
    // before playback of clips referencing that region.
    void mapRegionToSample(int regionId, int sampleBankId);

    // Remove all region→sample mappings. Call before loading a new project so
    // stale entries from a previous session don't cause wrong-sample cache hits.
    void clearRegionToSampleMap();

    // Removes the region→sample mapping for regionId. Use this — not
    // mapRegionToSample(id, -1) — when the corresponding SampleBank slot
    // is about to be unloadSample'd, per the contract in SampleBank.h.
    // No-op if regionId isn't in the map.
    void unmapRegion(int regionId);

    // Look up the sample bank slot for a region. Returns -1 if not mapped.
    // Any thread: reads the published snapshot (see regionToSampleMap_).
    int  getSampleIdForRegion(int regionId) const;

    // Returns a copy of the current region→sample mapping table. Any thread.
    std::unordered_map<int, int> getRegionToSampleMapSnapshot() const;

    // ── Per-slot sample mapping (main thread) ────────────────────────────────
    // Slot 0 always plays the region's own audio, so it resolves through the
    // regular region→sample map. Slots 1..7 carry independent audio files and
    // get their own SampleBank ids, registered here as {regionId, slotIndex}.
    // Keeping slot 0 out of this table means a region audio swap keeps working
    // untouched: it remaps the region, and slot 0 follows automatically.
    void mapRegionSlotToSample(int regionId, int slotIndex, int sampleBankId);
    int  getSampleIdForRegionSlot(int regionId, int slotIndex) const;
    void unmapRegionSlot(int regionId, int slotIndex);
    void unmapAllRegionSlots(int regionId);

    // ── Sampler lifecycle (main thread) ──────────────────────────────────────
    // Samplers are keyed by {trackId, regionId}: pattern tracks are sample-
    // agnostic containers, but each PatternBlock on a track references a
    // Pattern that carries a regionId. We maintain one Sampler per unique
    // {trackId, regionId} pair actually used by blocks on that track, so
    // different blocks with different regions on the same track get their
    // own voice pools (no glitch / no voice theft at block boundaries).
    //
    // Build or replace the Sampler for a {trackId, regionId} pair. Cuts
    // voices on replacement. Configured from the region's ADSR/loop/crossfade.
    // No-op if track missing / not Pattern-type, region missing / not mapped,
    // or SampleBank null.
    void loadSamplerForTrackRegion(int trackId, int regionId);

    // Removes one sampler pair (cuts its voices immediately).
    void unloadSamplerForTrackRegion(int trackId, int regionId);

    // Removes every sampler with this trackId (track deleted / converted to Clip).
    void unloadSamplersForTrack(int trackId);

    // Removes every sampler with this regionId (region deleted).
    void unloadSamplersForRegion(int regionId);

    // Rebuilds samplers from every PatternBlock in the Timeline. For each
    // unique {block.trackId, block.pattern.regionId} pair, ensures a Sampler
    // exists. Prunes any samplers no longer referenced by any block.
    // Call after project_load, undo/redo, transport Play() entry, or bulk
    // edits (block add/move/delete, pattern regionId change, region settings
    // change, SampleBank load completion).
    //
    // THREADING: May only be called when the audio device is stopped or when
    // processBlock() is guaranteed not to be executing concurrently.
    // SmoothedValue is not thread-safe; setCurrentAndTargetValue() called inside
    // this function is not safe to race with the audio thread's getNextValue().
    void rebuildAllSamplers();

    // ── Per-slot PREP bake (main thread) ─────────────────────────────────────
    // The sampler's offline time-stretch / pitch-shift stage. buildSamplerForRegion
    // consults the cache for every slot whose PREP is not bypassed: on a hit the
    // slot is loaded with the baked buffer, on a miss the slot plays its RAW
    // audio and an async bake is queued. When that bake lands,
    // drainSlotBakes() swaps the buffer in under the live voices.

    // Where the disk tier writes. Call on project create / load / save-as.
    // Empty (unsaved project) leaves the cache memory-only.
    void setSlotBakeCacheDir(const std::string& dir);

    // Main-thread pump. Publishes every bake that has completed since the last
    // call into the samplers that need it, and returns true when at least one
    // slot changed — the caller uses that to tell the UI to refetch. Cheap and
    // safe to call at any rate: it early-outs on an unchanged completion epoch.
    bool drainSlotBakes();

    // {regionId, slotIndex} pairs with a bake still in flight. Drives the
    // editor's loading indicator.
    struct SlotBakeJobInfo { int regionId; int slotIndex; };
    std::vector<SlotBakeJobInfo> getPendingSlotBakes() const;

    // The buffer a slot is actually PLAYING, when that is a PREP bake rather
    // than the raw sample; nullptr when PREP is bypassed or has not landed yet.
    //
    // This is what the editor must measure and draw against: trim, loop points
    // and fades are all indices into THIS buffer, so a stretched slot whose
    // editor still reported raw length would place every loop point wrong.
    struct PreparedSlot {
        std::shared_ptr<const juce::AudioBuffer<float>> buffer;
        // The bake's content key. Callers that cache anything derived from the
        // buffer (the editor's waveform mipmap) key it on this, so a new bake
        // is a new derived entry rather than a mutation of a live one.
        uint64_t digest = 0;
    };
    PreparedSlot getPreparedSlotBuffer(int regionId, int slotIndex) const;

    // Test/observability hooks.
    xleth::audio::SlotBakeCache* slotBakeCache() { return slotBakeCache_.get(); }

    // True if a Sampler is currently loaded for this pair. Main thread only.
    bool hasSampler(int trackId, int regionId) const;

    // Returns the Sampler for this pair, or nullptr if none loaded.
    // Main-thread only.
    Sampler* getSamplerPtr(int trackId, int regionId);

    // Main-thread bulk: fire allNotesOff() on every loaded sampler (both
    // per-track playback samplers and preview samplers). Used by bridge
    // Stop/Pause handlers as a main-thread safety net alongside the audio-
    // thread transition handler in processBlock.
    void silenceAllSamplers();

    // ── Preview samplers (main thread; piano roll / MiniKeyboard audition) ──
    // Separate from per-track playback samplers so auditioning a note in the
    // piano roll doesn't steal voices from any timeline playback track that
    // shares the region. Keyed by regionId (callers only know regions).
    void ensurePreviewSampler(int regionId);
    void unloadPreviewSampler(int regionId);
    Sampler* getPreviewSamplerPtr(int regionId);
    bool hasPreviewSampler(int regionId) const;
    void silenceAllPreviewSamplers();

    // ── Preview effect routing (main thread) ────────────────────────────────
    // Which track's effect rack an auditioned note is heard through. See
    // SamplerPreviewRoute.h for what "dedicated" means.
    void setSamplerPreviewRouteMode(xleth::SamplerPreviewRouteMode mode);
    xleth::SamplerPreviewRouteMode getSamplerPreviewRouteMode() const;
    void setSamplerPreviewSelectedTrack(int trackId);
    int  getSamplerPreviewSelectedTrack() const;

    // Re-resolve the route for one region and publish it to its preview slot.
    // Called just before a preview note-on, so the route is always current
    // without needing invalidation hooks on every timeline edit. Returns the
    // resolved track id (kPreviewRouteNone when the preview stays dry).
    int refreshPreviewRoute(int regionId);

    // The route currently published for a region, without re-resolving.
    int getPreviewRouteTrack(int regionId) const;

    // ── Audio thread ─────────────────────────────────────────────────────────
    // Mix timeline audio into outputBuffer (additive). Caller must clear first
    // if exclusive output is desired.
    void processBlock(juce::AudioBuffer<float>& outputBuffer,
                      int                       numSamples,
                      const Transport&          transport);

    enum class DiagnosticTapPoint
    {
        PrePdcTrack,
        PostPdcTrack,
        MasterInputSum,
        PostMasterOutput
    };

    struct DiagnosticTapBlock
    {
        DiagnosticTapPoint point = DiagnosticTapPoint::PrePdcTrack;
        const juce::AudioBuffer<float>* buffer = nullptr;
        int numSamples = 0;
        double sampleRate = 0.0;
        int64_t transportStartSample = 0;
        uint64_t blockIndex = 0;
        int trackId = -1;
        const char* trackName = nullptr;
        TrackInfo::Type trackType = TrackInfo::Type::Clip;
        bool muted = false;
        bool solo = false;
        bool visualOnly = false;
        bool audible = false;
        bool hadAudio = false;
        bool tailing = false;
        bool chainsLocked = false;
        bool nonRealtime = false;
        int declaredLatencySamples = 0;
        int compensationDelaySamples = 0;
        int maxAudibleTrackLatencySamples = 0;
        int masterInsertLatencySamples = 0;
    };

    class DiagnosticTapSink
    {
    public:
        virtual ~DiagnosticTapSink() = default;
        virtual bool wantsTrack(int trackId) const { juce::ignoreUnused(trackId); return true; }
        virtual void capture(const DiagnosticTapBlock& block) = 0;
    };

    void setDiagnosticTapSink(DiagnosticTapSink* sink);

    // ── Peak meters (thread-safe reads) ──────────────────────────────────────
    float getMasterPeakL() const { return masterPeakL_.load(std::memory_order_relaxed); }
    float getMasterPeakR() const { return masterPeakR_.load(std::memory_order_relaxed); }

    // ── Master loudness meter (BS.1770-4, opt-in) ────────────────────────────
    // Taps the same point as DiagnosticTapPoint::PostMasterOutput — post master
    // insert chain, post master fader — and feeds dsp/LoudnessAnalyzer, whose
    // processBlock() is alloc-free and lock-free by design. Off by default: when
    // disabled the audio path pays exactly one atomic load per block.
    struct MasterLoudnessSnapshot
    {
        bool   enabled       = false;
        // Live windows; fall with the signal. kNoMeasurement until the first
        // 100 ms sub-block closes.
        double momentary     = xleth::dsp::LoudnessAnalyzer::kNoMeasurement;  // 400 ms, LUFS
        double shortTerm     = xleth::dsp::LoudnessAnalyzer::kNoMeasurement;  // 3 s, LUFS
        // Cumulative since the last reset.
        double integrated    = xleth::dsp::LoudnessAnalyzer::kNoMeasurement;  // LUFS
        double momentaryMax  = xleth::dsp::LoudnessAnalyzer::kNoMeasurement;  // LUFS
        double shortTermMax  = xleth::dsp::LoudnessAnalyzer::kNoMeasurement;  // LUFS
        double lra           = 0.0;                                           // LU
        double truePeakDbtp  = xleth::dsp::LoudnessAnalyzer::kNoMeasurement;  // dBTP
    };

    // Main thread. Enabling clears the previous measurement: resuming an
    // integration across a gap would splice two disjoint spans of programme and
    // restart the K-weighting filters from stale state.
    void setMasterLoudnessEnabled(bool enabled);
    bool isMasterLoudnessEnabled() const noexcept
    {
        return masterLoudnessEnabled_.load(std::memory_order_relaxed);
    }
    void resetMasterLoudness();                        // main thread
    MasterLoudnessSnapshot getMasterLoudness() const;  // main thread (walks histograms)

    // ── Audio-health instrumentation (lock-free reads; never touch chainsMutex_) ──
    // [Underrun] Counts every processBlock where a clip needed a processed
    // (stretch/pitch/reverse/formant) buffer but ClipRenderCache had none ready —
    // the audio thread then silences/falls back for that clip block. Always
    // counted, independent of realtime diagnostics.
    uint64_t getClipCacheMissCount() const noexcept {
        return clipCacheMissCount_.load(std::memory_order_relaxed);
    }
    // [StreamUnder] Subset of getClipCacheMissCount() caused by a ready cache
    // entry whose key differs from the request (stale-key churn), as opposed to
    // no-entry-yet starvation. notReady/s = clipCacheMiss/s − keyMismatch/s.
    uint64_t getClipKeyMismatchCount() const noexcept {
        return clipRenderCache_.getKeyMismatchCount();
    }
    // The three below mirror realtimeDiagnostics_ atomics and only advance while
    // realtime diagnostics are enabled. chainLockMiss = audio thread failed the
    // chainsMutex_ try_lock and skipped effect-chain processing for that block.
    uint64_t getChainLockMissCount() const noexcept {
        return realtimeDiagnostics_.chainLockMissCount.load(std::memory_order_relaxed);
    }
    uint64_t getOverrunBlockCount() const noexcept {
        return realtimeDiagnostics_.overrunBlockCount.load(std::memory_order_relaxed);
    }
    uint64_t getAudioCallbackOverrunCount() const noexcept {
        return realtimeDiagnostics_.audioCallbackOverrunCount.load(std::memory_order_relaxed);
    }

    float getTrackPeakL(int trackId) const;
    float getTrackPeakR(int trackId) const;

    struct LatencyCompensationSnapshot
    {
        int maxAudibleTrackLatencySamples = 0;
        int masterInsertLatencySamples = 0;
        // Route-aware max path latency to the Master input (Prompt 2C): the
        // deepest audible output-route path (insert chains + junction branch
        // compensation), EXCLUDING the master insert chain (reported separately
        // above, downstream of the Master input sum). For an unrouted project
        // this equals maxAudibleTrackLatencySamples. Export pre-roll consumes
        // this value instead of the flat per-track max.
        int maxPathLatencySamples = 0;
    };

    int getTrackInsertLatencySamples(int trackId) const;
    int getTrackCompensationDelaySamples(int trackId) const;
    int getMaxAudibleTrackLatencySamples() const;
    // Route-aware max path latency (see LatencyCompensationSnapshot). Safe to
    // call from export/pre-roll code (main thread; locks chainsMutex_).
    int getMaxPathLatencySamples() const;
    int getMasterInsertLatencySamples() const;
    LatencyCompensationSnapshot getLatencyCompensationSnapshot() const;
    bool isInterTrackLatencyCompensationApplied() const;
    void refreshLatencyDiagnostics();

    // [PDCNotify] Recompute PDC for every chain (tracks + master) that holds a
    // latency change no owner path has accounted for - e.g. an EQ band switched
    // to Spectral through Audio_EQ_SetBandParam, which mutates the effect
    // directly. Run by the envelope applier thread each pass; costs one atomic
    // load when nothing changed anywhere, and takes chainsMutex_ (never the
    // audio thread's lock - it only try_locks it) only when something did.
    // NOT for the audio thread. Returns the number of chains recomputed.
    int servicePendingLatencyChanges();
    std::uint64_t getLatencyChangeServiceCount() const noexcept
    {
        return latencyChangeServiceCount_.load(std::memory_order_relaxed);
    }

    int addProcessorForTesting(int trackId,
                               const std::string& pluginId,
                               std::unique_ptr<juce::AudioProcessor> proc,
                               int position);

    struct RealtimeDiagnosticsSnapshot
    {
        bool enabled = false;
        uint64_t blockCount = 0;
        uint64_t audioCallbackCount = 0;
        int lastBlockSize = 0;
        double lastSampleRate = 0.0;
        double lastDeadlineMs = 0.0;
        double avgProcessBlockMs = 0.0;
        double p50ProcessBlockMs = 0.0;
        double p95ProcessBlockMs = 0.0;
        double p99ProcessBlockMs = 0.0;
        double maxProcessBlockMs = 0.0;
        double avgProcessBlockRatio = 0.0;
        double maxProcessBlockRatio = 0.0;
        double avgAudioCallbackMs = 0.0;
        double p50AudioCallbackMs = 0.0;
        double p95AudioCallbackMs = 0.0;
        double p99AudioCallbackMs = 0.0;
        double maxAudioCallbackMs = 0.0;
        double maxAudioCallbackRatio = 0.0;
        uint64_t overBudgetBlockCount = 0;
        uint64_t overrunBlockCount = 0;
        uint64_t audioCallbackOverrunCount = 0;
        uint64_t droppedTelemetrySamples = 0;
        // Finding 9: structurally 0 while the realtime path uses the chain
        // snapshot. A non-zero value means a try_lock has come back.
        uint64_t chainLockMissCount = 0;
        // Blocks that ran before the first chain snapshot was published.
        uint64_t chainSnapshotMissingCount = 0;
        uint64_t masterChainSkippedCount = 0;
        uint64_t trackChainSkippedCount = 0;
        uint64_t staleSnapshotReuseCount = 0;
        uint64_t guardedPluginCrashedSkippedCount = 0;
        uint64_t latencyEpochChangeCount = 0;
        uint64_t pdcRetargetCount = 0;
        uint64_t pdcDelayProcessCount = 0;
        double avgTrackProcessMs = 0.0;
        double maxTrackProcessMs = 0.0;
        int worstTrackId = -1;
        double avgTrackChainMs = 0.0;
        double p95TrackChainMs = 0.0;
        double p99TrackChainMs = 0.0;
        double maxTrackChainMs = 0.0;
        int worstTrackChainId = -1;
        double avgMasterChainMs = 0.0;
        double p95MasterChainMs = 0.0;
        double p99MasterChainMs = 0.0;
        double maxMasterChainMs = 0.0;
        double avgPdcDelayMs = 0.0;
        double p95PdcDelayMs = 0.0;
        double p99PdcDelayMs = 0.0;
        double maxPdcDelayMs = 0.0;
        uint64_t pluginCallCount = 0;
        double avgPluginMs = 0.0;
        double p95PluginMs = 0.0;
        double p99PluginMs = 0.0;
        double maxPluginMs = 0.0;
        std::string worstPluginId;
        int worstPluginTrackId = -1;
        int worstPluginNodeId = -1;
        std::vector<uint32_t> recentAudioCallbackUs;
        std::vector<xleth::audio::AudioTelemetryWorstScope> worstEffectsByMax;
        std::vector<xleth::audio::AudioTelemetryWorstScope> worstEffectsByP99;
        std::vector<xleth::audio::AudioTelemetryWorstScope> worstChainsByMax;
        std::vector<xleth::audio::AudioTelemetryWorstScope> worstChainsByP99;
        double avgResonanceSuppressorMs = 0.0;
        double maxResonanceSuppressorMs = 0.0;
        double avgResonanceSuppressorWolaMs = 0.0;
        double p99ResonanceSuppressorWolaMs = 0.0;
        double maxResonanceSuppressorWolaMs = 0.0;
        uint64_t resonanceSuppressorWolaCallCount = 0;
        uint64_t resonanceSuppressorAudioThreadReprepareCount = 0;
        uint64_t resonanceSuppressorDeferredReprepareCount = 0;
        uint64_t nanInfBlockCount = 0;
        std::string diagnosis;
        bool highQualityResonanceSuppressorRealtimeSafe = false;
        int activeResonanceSuppressorHighQualityInstanceCount = 0;
        std::string realtimeRsHqRiskLevel = "healthy";
        std::vector<std::string> realtimeRsHqRiskReasons;
        std::vector<std::string> recommendedAction;
        uint64_t timingSequence = 0;
    };

    void setRealtimeDiagnosticsEnabled(bool enabled);
    bool isRealtimeDiagnosticsEnabled() const;
    void resetRealtimeDiagnostics();
    RealtimeDiagnosticsSnapshot getRealtimeDiagnosticsSnapshot(uint64_t minTimingSequence = 0) const;
    void beginRealtimeDiagnosticsCaptureAccumulation(uint64_t minTimingSequence) const;
    void drainRealtimeDiagnosticsCaptureAccumulation() const;
    RealtimeDiagnosticsSnapshot finishRealtimeDiagnosticsCaptureAccumulation(
        uint64_t* accumulatedTimingSampleCount = nullptr,
        uint64_t* accumulatorOverflowDrops = nullptr) const;
    std::string getRealtimeDiagnosticsJSON() const;
    void recordAudioCallbackTiming(int numSamples, double sampleRate, uint64_t elapsedNs);

    // The callback deadline the realtime diagnostics / telemetry judge against.
    // 0 (the default) derives it from the block: numSamples / sampleRate, which
    // is the true deadline for ASIO and WASAPI exclusive/low-latency, where the
    // driver hands over one buffer per period. Under WASAPI SHARED mode that
    // arithmetic is wrong (the true deadline is the fixed engine period,
    // independent of the buffer size the app asked for), so AudioEngine
    // publishes the real value here from audioDeviceAboutToStart. Message/RPC
    // thread writes, audio thread reads (relaxed).
    void setRealtimeDeadlineOverrideNs(uint64_t deadlineNs) noexcept
    {
        realtimeDeadlineOverrideNs_.store(deadlineNs, std::memory_order_relaxed);
    }
    uint64_t getRealtimeDeadlineOverrideNs() const noexcept
    {
        return realtimeDeadlineOverrideNs_.load(std::memory_order_relaxed);
    }

    // ── Debug log ────────────────────────────────────────────────────────────
    MixDebugLog& getDebugLog() { return debugLog_; }

    // ── Prepare (call once after audio device opens) ──────────────────────────
    // Initialises SmoothedValue ramp parameters for all track slots.
    void prepare(double sampleRate, int maxBlockSize);

    // ── Offline render mode ─────────────────────────────────────────────────
    // When true, processBlock() uses a blocking lock on chainsMutex_ instead
    // of try_to_lock, guaranteeing effect chains are always processed.
    // Also propagates to each effect chain's JUCE AudioProcessorGraph so its
    // built-in spin-wait activates before the first offline processBlock.
    void setNonRealtime(bool nr);

    // ── Offline tail render: note-trigger ceiling (Phase 3A) ────────────────
    // While rendering a scoped/full export with the tailClamp policy, the engine
    // must NOT start any new note or clip at or after the capture-end sample, yet
    // must let already-sounding voices decay and insert-effect wet tails ring
    // out. Setting this ceiling (in absolute transport samples) gates only NEW
    // triggers; sustaining voices and effects are untouched. Default INT64_MAX =
    // disabled, so realtime playback and the main capture window are unaffected.
    // Main thread only; processBlock reads it as a relaxed atomic.
    void setNoteTriggerCeilingSample(int64_t ceilingSample);
    void clearNoteTriggerCeiling();   // reset to disabled (INT64_MAX)

    // ── Direct atomic parameter setters (main thread → audio thread) ─────────
    // Write the atomic only. MixEngine holds const Timeline*; model write-back
    // (TrackInfo.volume / .pan / .stereoSpread) is the caller's (XlethAddon)
    // responsibility. trackId is translated to a slot index via trackIdToSlot_;
    // no-op if track not found in slot map.
    void setTrackVolume (int trackId, float volume);  // 0..1+
    void setTrackPan   (int trackId, float pan);      // -1..+1  (caller must clamp)
    void setTrackSpread(int trackId, float spread);   // 0..2
    void setMasterVolume(float volume);               // 0..1+
    // Read back for project persistence — master volume lives only here, so
    // saveProject has to ask MixEngine for it.
    float getMasterVolume() const;

    // Global clip boundary fade. Precomputed from declickMs * sampleRate / 1000.
    // 0 = disabled (zero overhead on audio thread). Call from main thread only.
    // Named distinct from Sampler::setDeclickSamples() (Hann-window trim declick).
    void setClipBoundaryFadeSamples(int n);

    // ── Global clip-processing defaults ──────────────────────────────────────
    // Resolved at CacheKey build time when clip->stretchMethod == Global.
    // Call from message thread only.
    void setGlobalStretchMethod(int method);          // 1=PSOLA, 2=Rubber, 3=WSOLA, 4=PhaseVocoder, 5=WORLD
    int  getGlobalStretchMethod() const { return globalStretchMethod_; }
    void setGlobalFormantPreserve(bool enabled);
    bool getGlobalFormantPreserve() const { return globalFormantPreserve_; }
    void invalidateAllGlobalMethodClips();            // call after global change

    // Re-point clipId at the right cached render, submitting a background job
    // only when one is actually needed. Call from the message thread whenever
    // clip playback params change. No-ops when the clip's CacheKey is unchanged
    // (a MOVE, for instance) — the existing buffer stays valid.
    // `trigger` is a diagnostic label identifying the caller (e.g. "setClipParams",
    // "stretchClip", "addClip"). Defaulted so existing callers compile unchanged.
    void invalidateClipCache(int clipId, const char* trigger = "unknown");

    // Bulk form of invalidateClipCache. Same per-clip semantics, but emits ONE
    // summary log line instead of ~4 fflush'd stderr writes per clip — at a
    // few hundred clips that logging alone dominated the batch.
    void invalidateClipCaches(const std::vector<int>& clipIds, const char* trigger);

    // Content-address for a clip's processed audio. Shared by the invalidate
    // and lookup paths — see MixEngine.cpp.
    CacheKey buildClipCacheKey(const Clip& clip,
                               const juce::AudioBuffer<float>& srcBuf) const;

private:
    // Shared body of the two invalidate entry points. `quiet` suppresses the
    // per-clip debug chatter so bulk callers log one line, not N×4.
    void invalidateClipCacheImpl(int clipId, const char* trigger, bool quiet);
public:

    // Returns clip IDs with in-flight WORLD render jobs; forwarded to the N-API
    // layer so the main process can poll and drive the UI processing spinner.
    std::vector<int> getWorldActiveJobIds() const { return clipRenderCache_.getWorldActiveJobIds(); }

    // ── Per-track source transform table (Pitch Shifter Clip mode) ──────────
    //
    // trackId -> SourceTransform, rebuilt from the effect chains and published
    // lock-free. See SourceTransformTable.h for the table's rules. Consumed by
    // AUDIO CLIPS (mode 4, see "Clip mode render path" below) and by PATTERN
    // tracks, as a voice-spawn transpose (Sampler::setTransposeOffset, written
    // per block in processBlock's pattern loop; Mix/method/formant inert).
    //
    // Poll-driven, not mutator-driven. XlethEngineService calls
    // pollSourceTransformTable() from the WORLD-spinner poll
    // (cache_getWorldActiveJobs, 150 ms while jobs run, 1000 ms idle). A poll
    // whose chains still match the cached stamp snapshot — same nodes, same
    // order, same bypass, same sourceTransformEpoch() — returns without
    // allocating and without republishing. Anything else rebuilds and
    // republishes exactly once.
    //
    // Returns true iff it republished. Skips (returns false, retries next poll)
    // when chainsMutex_ is contended — an offline render holds it for whole
    // blocks, and this poll must never stall the RPC thread behind an export.
    // MESSAGE THREAD.
    bool pollSourceTransformTable();

    // ── Clip mode render path (Pitch Shifter mode 4, audio clips) ───────────
    //
    // For a clip on a track with an active table entry the engine keeps TWO
    // renders: the clip's original render (only when the clip has processing
    // of its own — otherwise raw PCM is the original) and the SHIFTED render
    // (ClipRenderCache fx lane, key = original key + the transform). The clip
    // loop blends them per sample at the provider node's smoothed Mix:
    //   no table entry / wet not ready / Mix == 0  -> today's code, untouched
    //   Mix == 1                                   -> shifted render only
    //   0 < Mix < 1                                -> dry*(1-m) + wet*m
    // with the clip's gain/fade/declick applied once to the result. The
    // shifted render is requested whenever the transform is active, whatever
    // Mix is, so an automated Mix sweep always has wet to blend against.
    //
    // Clips read through ClipModulatedReader (vibrato / scratch) are NOT
    // blended: they keep today's output. The reader holds one readhead state
    // per clip, and a second, independent readhead for the wet is not built.
    //
    // Invalidation: a republish that changes a track's transform queues that
    // track, and kSourceTransformSettleMs after the LAST such change every clip
    // on it is invalidated (and so resubmitted) in one batch. The settle is
    // the render-storm guard for a stepped sweep; a settle timer on the message
    // thread flushes it, and every poll flushes a due queue as well.
    static constexpr int64_t kSourceTransformSettleMs = 250;

    // pollSourceTransformTable() with an explicit clock (ms, ClipRenderCache::
    // nowMs() scale). `blocking` waits for chainsMutex_ instead of skipping.
    bool pollSourceTransformTableAt(int64_t nowMs, bool blocking = false);

    // Invalidate every clip on the queued tracks once the settle has elapsed
    // (or immediately with force). Returns how many clips it invalidated.
    // MESSAGE THREAD.
    int  flushSourceTransformInvalidations(int64_t nowMs, bool force = false);
    bool hasPendingSourceTransformInvalidation() const noexcept { return fxInvalidationPending_; }

    // Drain the cache's miss reports and resubmit those clips (a clip whose
    // buffer was evicted, or whose key went stale without an invalidation),
    // then flush a due settle queue. Clips on a track still settling are left
    // to the flush. MESSAGE THREAD; hooked on the same poll as the table.
    void serviceClipRenderCache();

    // Export entry: publish the current table NOW (blocking), flush any pending
    // settle immediately, so the refresh + wait that follows sees final keys.
    void prepareSourceTransformsForExport();

    // The fx-lane key for `original` under transform `t` (fx fields only; the
    // clip's own pitch fields are left alone).
    static CacheKey withSourceTransform(CacheKey original, const xleth::SourceTransform& t) noexcept;

    // True when the clip needs any cache render: processing of its own, or an
    // active transform on its track. The filter every "warm the caches" loop
    // must use — the old pitch/reverse/stretch test misses identity clips on a
    // Clip-mode track.
    bool clipNeedsCacheRender(const Clip& clip) const;

    // True when every render the clip needs is published (original and/or
    // shifted). Clips needing none are ready. MESSAGE THREAD.
    bool isClipCacheReady(int clipId) const;

    // The clip's shifted (fx lane) buffer under the current table, or nullptr.
    std::shared_ptr<const juce::AudioBuffer<float>> getClipFxProcessedBuffer(int clipId) const;

    // Direct cache access for observability and tests.
    ClipRenderCache&       getClipRenderCache()       noexcept { return clipRenderCache_; }
    const ClipRenderCache& getClipRenderCache() const noexcept { return clipRenderCache_; }

    // Read API. One atomic load, no lock, no allocation; the returned pointer
    // pins the table. Never null. Safe from the audio thread.
    std::shared_ptr<const xleth::TrackSourceTransformTable> currentSourceTransformTable() const noexcept
    {
        return sourceTransformTable_.load(std::memory_order_acquire);
    }

    // Generation of the currently published table: 0 for the empty table the
    // constructor publishes, +1 per republish. Test/introspection.
    std::uint64_t getSourceTransformTableGeneration() const noexcept
    {
        return currentSourceTransformTable()->generation;
    }

    // Returns the cached processed buffer for clipId (message-thread safe via
    // atomic reads). Builds the CacheKey from the clip's current params.
    // Returns nullptr if the clip has identity params (no processing needed)
    // or the cache is a miss (buffer still building). Safe to call from any
    // non-audio thread — atomic shared_ptr load, no mutex. The pointer pins
    // the buffer, so a concurrent LRU eviction cannot free it under the caller.
    std::shared_ptr<const juce::AudioBuffer<float>> getClipProcessedBuffer(int clipId) const;

    // Returns the engine sample rate set by the last prepare() call.
    double getPreparedSampleRate() const { return preparedSampleRate_; }

    // Rebuild the trackId → slot mapping and refresh the slot-owned atomic
    // track params from the current Timeline. Safe for live topology changes
    // because it only touches atomics unless snapVolumeSmoothers is enabled.
    // NEVER call from processBlock (audio thread) — no locks on audio thread.
    void syncTrackSlotsFromTimeline(bool snapVolumeSmoothers = false);

    // Main-thread (Prompt 5A): enable the sidechain input bus on every stock
    // compressor instance that an enabled sidechain route currently targets, and
    // disable it on every other capable instance. This makes the targeted
    // compressor "sidechain-capable" so the existing 4C+4D key transport wires
    // the SidechainSourceProcessor to its second input bus — and ONLY to that
    // instance, so a route targeting another effect on the same track never feeds
    // it. Idempotent and allocation-light: chains whose target set is unchanged
    // do no work. Call after any sidechain-route or chain mutation and after load.
    void syncSidechainTargetBuses();

    // Rebuild the trackId → slot mapping from the current track list.
    // Mapping-only primitive used by syncTrackSlotsFromTimeline().
    // Must be called from the main/message thread whenever tracks are
    // added, removed, or reordered.
    // NEVER call from processBlock (audio thread) — no locks on audio thread.
    void updateSlotMapping();

    // ── Effect chain management (main thread only) ──────────────────────
    // Track chains are keyed by trackId.  The master chain is separate.
    // Audio thread accesses chains under a tryLock mutex — if the main
    // thread is mutating the map, the audio thread skips chain processing
    // for that block (brief glitch, practically inaudible).

    void initEffectChain(int trackId);
    void destroyEffectChain(int trackId);

    // Tear down ALL per-track effect chains and the master chain. Used by
    // New Project to wipe plugin state between sessions. Closes plugin
    // editors first (caller responsibility). Main thread only.
    void destroyAllEffectChains();

    // Returns APG NodeID uid as int, or -1 on failure.
    int  addEffect(int trackId, const std::string& pluginId, int position);
    bool removeEffect(int trackId, int nodeId);
    bool moveEffect(int trackId, int nodeId, int newPosition);
    bool setEffectBypass(int trackId, int nodeId, bool bypassed);
    std::string getEffectChainState(int trackId) const;

    // Master effect chain (trackId-less)
    void initMasterEffectChain();
    void destroyMasterEffectChain();
    int  addMasterEffect(const std::string& pluginId, int position);
    bool removeMasterEffect(int nodeId);
    bool moveMasterEffect(int nodeId, int newPosition);
    bool setMasterEffectBypass(int nodeId, bool bypassed);
    std::string getMasterEffectChainState() const;

    // ── Plugin registry ──────────────────────────────────────────────────────
    // Owns the AudioPluginFormatManager (VST3 registered) and KnownPluginList.
    // AudioGraph uses this to instantiate VST3 plugins by identifier.
    PluginRegistry& getPluginRegistry();

    // ── Plugin editor windows (main thread only) ─────────────────────────────
    // Opens a floating native window hosting the VST3 plugin's GUI editor.
    // trackId = -1 selects the master chain.
    // Returns true if the editor window was opened, false if:
    //   • the node is not found, or
    //   • the plugin has no GUI editor (createEditorIfNeeded returns nullptr).
    // If the editor is already open, brings its window to front and returns true.
    bool openPluginEditor(int trackId, int nodeId);

    // Close the editor window for {trackId, nodeId}. No-op if not open.
    void closePluginEditor(int trackId, int nodeId);

    // Close all editor windows for a given track (track deleted / converted).
    void closePluginEditorsForTrack(int trackId);

    // Close every open editor window (project load / app quit).
    void closeAllPluginEditors();

    // Returns true if an editor is currently open for {trackId, nodeId}.
    bool isPluginEditorOpen(int trackId, int nodeId) const;

    // Set the path to xleth-editor-host.exe. Call once after engine init.
    // Must be called before any openPluginEditor() on a VST node.
    void setEditorHostExe(const std::string& exePath);

    // Store the main Xleth window HWND so VST editor-host windows can be
    // parented to it (minimize together, no separate taskbar button, etc.).
    // Called from Audio_SetMainWindowHandle in XlethAddon.cpp after the
    // BrowserWindow is created.
    void setMainWindowHandle(uintptr_t hwnd);

    // ── Stable effect-instance lookup (main thread) ──────────────────────────
    // Resolve a stable effectInstanceId on a track's chain (trackId == -1 selects
    // the master chain) to the current-session APG uid, or -1 if absent. The uid
    // is transient (remapped every load); only effectInstanceId is persistable.
    // Exposed for a later sidechain phase that resolves persisted
    // (targetTrackId, effectInstanceId) addresses to live engine nodes.
    int getEffectNodeIdForInstance(int trackId, const std::string& effectInstanceId) const;
    std::string getEffectInstanceIdForNode(int trackId, int nodeId) const;

    // VST-SC.3: true iff `effectInstanceId` resolves on the given track's chain
    // (trackId == -1 = master) AND its node exposes a usable sidechain input bus.
    // Backs the bridge's capability resolver so route validation can reject
    // incapable targets with sidechain_unsupported. Session-only — never persisted.
    bool isEffectInstanceSidechainCapable(int trackId,
                                          const std::string& effectInstanceId) const;

    // ── FX Chain Library ──────────────────────────────────────────────────────
    // Rebuild (replace=true) or extend (replace=false) a chain from an ordered
    // [{pluginId, bypassed?, state?}, ...] preset description. trackId < 0
    // selects the master chain. The whole rebuild happens under ONE acquisition
    // of chainsMutex_, so the audio thread never processes a half-built chain.
    // Returns { ok, added, skipped: [pluginId, ...] }.
    nlohmann::json applyEffectChainPreset(int trackId, const nlohmann::json& effects,
                                          bool replace);

    // Full graph serialization (includes APVTS state, connections, wire gains)
    nlohmann::json getEffectChainJSON(int trackId) const;
    nlohmann::json getMasterEffectChainJSON() const;
    bool loadEffectChainFromJSON(int trackId, const nlohmann::json& j);
    bool loadMasterEffectChainFromJSON(const nlohmann::json& j);

    // ── Missing-plugin support ────────────────────────────────────────────────
    // JSON array: [{ trackId, nodeId, pluginId, pluginName, pluginVendor, filePath }, ...]
    // trackId = -1 means the master chain.
    std::string getMissingPluginsJSON() const;

    // Replace the placeholder at {trackId, nodeId} with the real plugin (if now available).
    bool tryResolvePlugin(int trackId, int nodeId);

    // Remove every placeholder node from every chain.
    void removeAllMissingPlugins();

    // ── Crash recovery ────────────────────────────────────────────────────────
    // Attempt to recover a VST node that crashed inside processBlock.
    // trackId == -1 selects the master chain.  Returns true on success.
    bool resetCrashedPlugin(int trackId, int nodeId);

    // ── Graph-mode routing (main thread only) ───────────────────────
    // Per-track graph APIs (keyed by trackId, same mutex as effect chains)
    bool addConnection(int trackId, int sourceNodeId, int destNodeId);
    bool removeConnection(int trackId, int sourceNodeId, int destNodeId);
    bool setWireGain(int trackId, int srcId, int dstId, float gain);
    bool setWireMute(int trackId, int srcId, int dstId, bool muted);
    void setNodePosition(int trackId, int nodeId, float x, float y);
    std::string getGraphTopology(int trackId) const;
    bool isGraphLinear(int trackId) const;

    // ── Graph-owned effect instance lifecycle (FXG.3-b, main thread) ────
    // FX Graph mode owns effect instances keyed by a stable effectInstanceId.
    // These forward to EffectChainManager's graph-owned lifecycle (low-level
    // AudioGraph addNode/removeNode) and never mutate the linear chain. Not
    // valid on the master track (master stays chain-only).
    //   addGraphEffectNode    → APG uid, or -1 on failure.
    //   removeGraphEffectNode → true if an instance was destroyed.
    //   getGraphEffectEngineNodeId → APG uid, or -1 if unknown.
    int  addGraphEffectNode(int trackId, const std::string& effectInstanceId,
                            const std::string& pluginId);
    nlohmann::json hydrateGraphEffectNodes(int trackId,
                                           const nlohmann::json& graphEffectNodes);
    bool removeGraphEffectNode(int trackId, const std::string& effectInstanceId);
    int  getGraphEffectEngineNodeId(int trackId, const std::string& effectInstanceId) const;
    nlohmann::json syncLinearGraphTopology(int trackId, const nlohmann::json& topology);

    // FXG.3-d: rebuild a normal track's runtime routing from a graphState
    // topology (linear OR parallel). Graph mode owns the connection space:
    // every call clears prior chain/graph wiring and rebuilds only the
    // graph-owned route, fail-closed to silence. Rejects the master track.
    nlohmann::json syncGraphTopology(int trackId, const nlohmann::json& topology);

    // FXG.3-d: adopt already-allocated chain processors as graph-owned when a
    // Mixer Chain is converted to a graph (preserves parameter state). Input:
    // array of { effectInstanceId, engineNodeId }. Rejects the master track.
    nlohmann::json adoptGraphEffectNodes(int trackId, const nlohmann::json& mapping);

    // ── FXG.4-a graph-owned effect parameter descriptors (main thread) ──
    // Operate on graph-owned effect instances keyed by a stable effectInstanceId
    // (resolved to the engine node via the per-track graph map). Rejects the
    // master track (chain-only). Return a JSON string: { ok, ... } with a
    // `reason` on failure. Never touch chain-slot editing or effectChains state.
    std::string getGraphEffectParameters(int trackId, const std::string& effectInstanceId) const;
    std::string getGraphEffectParameterValue(int trackId, const std::string& effectInstanceId,
                                             const std::string& parameterId) const;
    std::string setGraphEffectParameterNormalized(int trackId, const std::string& effectInstanceId,
                                                  const std::string& parameterId,
                                                  double normalizedValue);

    // VALUE-ONLY graph parameter write. Same effect on the parameter as
    // setGraphEffectParameterNormalized, but it does NOT unconditionally request a
    // latency-compensation reset. The user-driven RPC path can afford that reset on
    // every write; a continuous modulation source cannot — it would re-run
    // syncSidechainTargetBuses() and the whole PDC recompute at the modulation rate
    // (the MixEngine.cpp / XlethEngineService.cpp cost this path exists to avoid).
    //
    // Correctness is preserved rather than traded away: the chain's latency EPOCH is
    // compared across the write, and the reset is requested only when the parameter
    // actually moved the effect's reported latency. A value-only write that changes
    // no latency needs no PDC work, so skipping it is not an optimization with a
    // caveat — it is the accurate amount of work.
    //
    // Returns true when the parameter was written. Main/applier thread only —
    // takes chainsMutex_, so NEVER call from the audio thread.
    bool setGraphEffectParameterNormalizedValueOnly(int trackId,
                                                   const std::string& effectInstanceId,
                                                   const std::string& parameterId,
                                                   double normalizedValue);

    // ── FX Graph Envelope Controller → parameter modulation ─────────────
    //
    // Ownership split (docs/dev/fxgraph-envelope-controller-architecture-audit.md §1):
    // the Envelope's DEFINITION is renderer-owned and rides the already-persisted
    // opaque TrackInfo::graphState — no new bridge surface exists or is needed —
    // while its EVALUATION happens here, against the authoritative transport clock
    // and the same note gates MixEngine::triggerPatternNotes acts on.
    //
    // Three threads, strictly separated:
    //   message  refreshEnvelopeDefinitions() parses graphState + derives gates and
    //            publishes an immutable snapshot.
    //   audio    processBlock() reads the snapshot and writes mailbox atomics.
    //   applier  applyPendingEnvelopeModulation() drains mailboxes into parameters.

    // Rebuild and publish the envelope snapshot from the current Timeline. Call
    // after any mutation that can change an envelope definition or its gates:
    // graphState set, fxMode change, project load, undo/redo, and pattern / note /
    // block / clip / mute / solo edits. Cheap and idempotent when nothing changed.
    // NEVER call from processBlock (audio thread) — it allocates.
    void refreshEnvelopeDefinitions();

    // Drain every mailbox whose value the audio thread has updated since the last
    // drain, and write it to its graph-owned effect parameter through the
    // value-only path above. Returns the number of parameters written.
    //
    // Public so tests can drive the applier deterministically instead of racing a
    // background thread; the applier thread calls exactly this.
    // Main/applier thread only.
    int applyPendingEnvelopeModulation();

    // Test/diagnostic read of the live snapshot. Never call from the audio thread.
    std::shared_ptr<const xleth::envmod::EnvelopeModulationSnapshot>
    getEnvelopeModulationSnapshotForTesting() const;

    // ── FX Graph LFO Modulator → parameter modulation ────────────────────
    //
    // Sibling of the Envelope block above — same three-thread split, same
    // epoch-RCU publish discipline — but for the FREE-RUNNING LFO source
    // instead of the triggered Envelope. See LfoParameterModulation.h's
    // header-top note for the one real behavioral difference: an LFO has no
    // rest state that naturally maps to `base`, so "go inert" (transport
    // stopped, or the owning track currently inaudible) is handled explicitly
    // inside evaluateLfoModulation rather than falling out of the snapshot's
    // structure the way Envelope's omitted gates do.
    //
    //   message  refreshLfoDefinitions() parses graphState and publishes an
    //            immutable snapshot (no gate/audibility derivation — see
    //            buildLfoModulationSnapshot's doc comment).
    //   audio    processBlock() reads the snapshot, resolves per-edge
    //            audibility, and writes mailbox atomics.
    //   applier  applyPendingLfoModulation() drains mailboxes into
    //            parameters. Rides the SAME background thread as the
    //            Envelope applier — see startEnvelopeApplierThread's loop
    //            body — no second thread is spun up for LFO.

    // Rebuild and publish the LFO snapshot from the current Timeline. Call
    // after any mutation that can change an LFO definition or its edges:
    // graphState set, fxMode change, project load, undo/redo. Cheap and
    // idempotent when nothing changed. NEVER call from processBlock (audio
    // thread) — it allocates.
    void refreshLfoDefinitions();

    // Drain every mailbox whose value the audio thread has updated since the
    // last drain, and write it to its graph-owned effect parameter through
    // the value-only path above. Returns the number of parameters written.
    //
    // Public so tests can drive the applier deterministically instead of
    // racing a background thread; the applier thread calls exactly this.
    // Main/applier thread only.
    int applyPendingLfoModulation();

    // Services effect-chain reset requests posted by the audio thread. A
    // transport stop resets whole chains here. A jump (seek, loop wrap, play
    // after an audition) already reset every realtime-safe node in the jump
    // block (see jumpChainResetPending_); this pass only finishes the rest
    // (VST3 nodes, a Pitch Shifter that had no primed spare). Coalesces any
    // number of requests into one pass, each chain claimed via
    // EffectChainManager::tryResetProcessorsOffThread /
    // tryResetDeferredOffThread. The expensive part of
    // a reset is primed before and after the claims
    // (EffectChainManager::primeDeferredReset), so a claim holds a chain
    // silent for microseconds, not for the whole reset. Takes chainsMutex_.
    // Returns 1 when it ran a reset pass, 0 when nothing was pending. Public so
    // tests can service deterministically; the applier thread calls exactly this.
    int serviceEffectChainResets();

    // Test/diagnostic read of the live snapshot. Never call from the audio thread.
    std::shared_ptr<const xleth::lfomod::LfoModulationSnapshot>
    getLfoModulationSnapshotForTesting() const;

    // ── Automation clips (Phase A) ──────────────────────────────────────
    //
    // Same three-role split as the Envelope/LFO modulators, but with the
    // publication step done under chainsMutex_ instead of an epoch-RCU swap:
    //
    //   message  refreshAutomationPlan() flattens the Timeline's automation
    //            model into an AutomationPlan and resolves each target to the
    //            raw APVTS atomic its effect reads (both need the chains lock,
    //            so both happen here, together).
    //   audio    processBlock() evaluates the plan at this block's tick and
    //            stores each value straight into that atomic — INSIDE the
    //            `chainsLocked` region it already holds, so no new lock is
    //            taken on the callback and no effect can be destroyed under it.
    //
    // Why not the Envelope/LFO mailbox + applier-thread hop: automation's value
    // at tick t is required to be a pure function of t (OfflineRenderer export
    // parity), and an asynchronous applier makes the moment a value LANDS
    // depend on thread scheduling. Writing the parameter in the same block that
    // evaluated it is what makes live playback and export agree. It is
    // realtime-safe because the write is a single relaxed atomic store, not a
    // notifying parameter set — see EffectChainManager::AutomationParameterHandle.
    //
    // Ramping is not done here: the atomic being written is the one
    // XlethEffectBase::updateSmootherTargets() reads once per block, so every
    // parameter the effect registered as smoothed ramps across the block
    // through its own smoother. That is the no-zipper guarantee.

    // Rebuild and publish the plan. Call after ANY mutation that can change it:
    // automation edits (wired to the UndoManager post-mutation hook, which makes
    // it complete by construction for timeline edits), project load, and effect
    // chain changes. Cheap and idempotent. Takes chainsMutex_ — NEVER call it
    // from processBlock or from a function that already holds that lock.
    void refreshAutomationPlan();

    // Rebuild only if a chain mutation has invalidated the resolved parameter
    // handles since the last rebuild. Driven by the envelope applier thread, so
    // adding or removing an effect re-resolves its automation without every
    // chain mutator having to remember to call refreshAutomationPlan(). Returns
    // 1 when it rebuilt, 0 when nothing was dirty.
    int refreshAutomationPlanIfDirty();

    // { targetCount, windowCount, pointCount, overflowed, droppedTargets,
    //   droppedWindows, unresolvedClips, resolvedTargets }. Diagnostics for the
    //   UI (dead-clip badges) and for tests. Main thread.
    nlohmann::json getAutomationPlanDiagnostics() const;

    // True iff (ownerTrackId, effectInstanceId, parameterId) currently addresses
    // an automatable stock-effect parameter. ownerTrackId -1 = master chain.
    // This is the predicate that makes a clip "dead" when it fails.
    bool isAutomationBindingResolvable(int ownerTrackId,
                                       const std::string& effectInstanceId,
                                       const std::string& parameterId) const;

    // Current NORMALIZED [0,1] value of a bound parameter (the knob position).
    // False when the binding does not resolve.
    bool getAutomationParameterNormalized(int ownerTrackId,
                                          const std::string& effectInstanceId,
                                          const std::string& parameterId,
                                          double& outValue) const;

    // The value the plan WOULD apply at `tick`, without applying it. Backs the
    // UI's read-only automated-knob display and makes the evaluation semantics
    // directly testable through the bridge. `found` is false when the binding
    // has no plan target.
    double evaluateAutomationAtTick(int ownerTrackId,
                                    const std::string& effectInstanceId,
                                    const std::string& parameterId,
                                    int64_t tick, bool& found) const;

    // ── Effect parameter / meter access (main thread only) ──────────────
    // Per-track: returns "[]" / false / "[0,0,0,0]" if chain/node not found.
    std::string getEffectParameters(int trackId, int nodeId) const;
    bool        setEffectParameter (int trackId, int nodeId, const std::string& paramId, float value);
    bool        setEffectProgram   (int trackId, int nodeId, int programIndex);
    bool        setEffectStateInformation(int trackId, int nodeId, const void* data, int sizeInBytes);
    std::string getEffectMeter     (int trackId, int nodeId) const;
    bool        refreshGuardedPluginLatency(int trackId, int nodeId);
    bool        refreshGuardedPluginLatency(int trackId, int nodeId,
                                            std::uint64_t latencyPublishCountBefore);

    // Master chain variants
    std::string getMasterEffectParameters(int nodeId) const;
    bool        setMasterEffectParameter (int nodeId, const std::string& paramId, float value);
    std::string getMasterEffectMeter     (int nodeId) const;

    // ── Effect visualization access (main thread only) ──────────────────
    // Visualization is opt-in per effect instance. Toggle on the editor
    // open/close path; while disabled, the audio thread sees nullptr and
    // pays only an acquire-load + null-check per block. trackId == -1
    // selects the master chain (matches existing meter/param convention).
    bool        setEffectVisualizationEnabled(int trackId, int nodeId, bool enabled);
    std::size_t drainEffectVizFrames        (int trackId, int nodeId,
                                             std::uint8_t* out, std::size_t maxBytes);
    std::uint32_t getEffectVisualizationType         (int trackId, int nodeId) const;
    std::uint32_t getEffectVisualizationSchemaVersion(int trackId, int nodeId) const;

    // Direct effect pointer access (for subclass-specific APIs like EQ).
    // Returns nullptr if chain/node not found. Main-thread only.
    XlethEffectBase* getEffectPtr(int trackId, int nodeId);
    XlethEffectBase* getMasterEffectPtr(int nodeId);

    // ── Visual Echo delay binding (render thread) ────────────────────────────
    //
    // Resolve the repeat interval published by a Delay effect so the video-side
    // Visual Echo can size its ring buffer and place its taps. The ONLY thing
    // the render path is allowed to learn about the audio graph.
    //
    // NOT on the audio callback path — called once per output frame per echoing
    // cell from the preview video thread and from the export render thread. It
    // takes chainsMutex_ exactly as getEffectPtr does; that lock is held only by
    // main-thread chain mutations and never by processBlock, so a render thread
    // waiting on it can never stall audio.
    //
    // trackId == -1 selects the master chain, matching the meter/param
    // convention. Returns a snapshot with .valid == false when the node does not
    // exist, is not a Delay, or has not processed a block yet.
    xleth::echo::DelaySnapshot resolveDelaySnapshot(int trackId, int nodeId) const;

    // Master graph APIs (trackId-less)
    bool addMasterConnection(int sourceNodeId, int destNodeId);
    bool removeMasterConnection(int sourceNodeId, int destNodeId);
    bool setMasterWireGain(int srcId, int dstId, float gain);
    bool setMasterWireMute(int srcId, int dstId, bool muted);
    void setMasterNodePosition(int nodeId, float x, float y);
    std::string getMasterGraphTopology() const;
    bool isMasterGraphLinear() const;

private:
    const Timeline*   timeline_   = nullptr;
    const SampleBank* sampleBank_ = nullptr;

    // Region → SampleBank id. The audio thread reads this every block
    // (findActiveClips) while RPC handlers, project load and MIDI import write
    // it, so it is never mutated in place: writers copy, modify and publish a
    // new immutable map under regionSampleMapWriteMutex_; readers take one
    // atomic load and hold that map for as long as they use it. Same shape as
    // chainSnapshot_. Never null after construction.
    using RegionSampleMap = std::unordered_map<int, int>;
    mutable std::atomic<std::shared_ptr<const RegionSampleMap>> regionToSampleMap_;
    // Writers only — the audio thread never takes it.
    std::mutex regionSampleMapWriteMutex_;
    // Superseded maps, released only here (writer side) once no reader holds
    // them, so the audio thread never runs an unordered_map destructor.
    std::vector<std::shared_ptr<const RegionSampleMap>> retiredRegionSampleMaps_;
    // PRECONDITION: regionSampleMapWriteMutex_ held.
    void publishRegionSampleMapLocked(RegionSampleMap next);
    std::shared_ptr<const RegionSampleMap> loadRegionSampleMap() const noexcept
    {
        return regionToSampleMap_.load(std::memory_order_acquire);
    }

    // ── Per-block track snapshot cache (Finding 2b) ─────────────────────────
    // Mirrors timeline_->getAllTracks() (same pointers, same order) without
    // paying its allocation + stable_sort every audio callback. Rebuilt only
    // when Timeline's track topology generation has advanced since the last
    // rebuild — i.e. on an actual track add/remove/reorder, not every block.
    const TrackInfo* cachedTrackSnapshot_[kMaxTracks] = {};
    int              cachedTrackSnapshotCount_ = 0;
    uint64_t         cachedTrackTopologyGeneration_ = ~static_cast<uint64_t>(0);
    void refreshTrackSnapshotIfNeeded();

    // Pre-allocated stereo track buffers (one per track slot, up to kMaxTracks)
    std::vector<juce::AudioBuffer<float>> trackBuffers_;
    int trackBufferSize_ = 0; // current allocation size in samples

    // Pre-allocated stereo sidechain key buffers (Prompt 4C+4D), one per target
    // track slot, sized in lockstep with trackBuffers_. A source track with an
    // enabled sidechain route accumulates its (silent) key into the buffer of
    // its target slot; that buffer is handed to the target chain's sidechain
    // source node before the chain runs and is NEVER summed into any audible
    // buffer (trackBuffers_, outputBuffer, preview). Cleared each block for the
    // target slots that actually receive a key.
    std::vector<juce::AudioBuffer<float>> sidechainBuffers_;

    // Per-track MidiBuffers populated with onset events (note-on, clip-start)
    // before the effect chain runs.  Reused each block — clear() is O(1).
    juce::MidiBuffer trackMidiBuffers_[kMaxTracks];
    juce::MidiBuffer emptyMasterMidi_;

    // Preview bus for sampler voices when transport is stopped (note preview).
    juce::AudioBuffer<float> previewBuffer_;

    // Peak meters
    std::atomic<float> masterPeakL_{0.0f};
    std::atomic<float> masterPeakR_{0.0f};

    // ── Master loudness meter ───────────────────────────────────────────────
    // masterLoudnessInUse_ is the audio thread's claim on the analyzer. It lets
    // prepare()/reset() (main thread) mutate it without a lock the audio thread
    // could ever block on: the audio thread publishes the claim and re-checks
    // the enable flag, the main thread clears the flag and waits out the claim.
    // Both sides need seq_cst on that store/load pair — with release/acquire the
    // hardware may reorder the store past the load (StoreLoad is the one
    // reordering x86 allows) and both threads would proceed.
    xleth::dsp::LoudnessAnalyzer masterLoudness_;
    std::atomic<bool>            masterLoudnessEnabled_{false};
    std::atomic<bool>            masterLoudnessInUse_{false};

    // Runs `fn` (which mutates masterLoudness_) with the audio-thread tap
    // provably outside the analyzer. Main thread only.
    template <typename Fn>
    void withMasterLoudnessSuspended(Fn&& fn)
    {
        const bool wasEnabled = masterLoudnessEnabled_.exchange(false, std::memory_order_seq_cst);

        // Only this (main) thread ever waits. Bounded so a wedged audio device
        // cannot freeze the message thread; overrunning the bound is harmless
        // because no buffer inside the analyzer changes size after the first
        // prepare() — the worst case is one corrupted measurement block, never
        // a dangling pointer.
        for (int spin = 0;
             spin < 100000 && masterLoudnessInUse_.load(std::memory_order_seq_cst);
             ++spin)
        {
            std::this_thread::yield();
        }

        fn();
        masterLoudnessEnabled_.store(wasEnabled, std::memory_order_release);
    }

    // Master output volume (post-effect-chain, pre-clamp)
    std::atomic<float> masterVolume_{1.0f};

    // Global clip boundary fade length in samples (main thread writes, audio thread reads).
    // Named distinct from Sampler::declickSamples_ (Hann-window trim declick).
    std::atomic<int> clipBoundaryFadeSamples_{0};

    struct TrackPeaks
    {
        std::atomic<float> peakL{0.0f};
        std::atomic<float> peakR{0.0f};
    };
    TrackPeaks trackPeaks_[kMaxTracks];

    // ── Atomic write path (main thread → audio thread, indexed by SLOT) ─────
    // Slot = 0-based index in the active track list (from getAllTracks() order).
    // Setters translate trackId → slot via trackIdToSlot_ before writing.
    // std::atomic<T> is not copyable; struct is default-constructible only.
    struct TrackAudioParams
    {
        std::atomic<float> volume{1.0f};
        std::atomic<float> pan{0.0f};
        std::atomic<float> spread{1.0f};
    };
    TrackAudioParams trackParams_[kMaxTracks];

    // ── Global clip-processing defaults ──────────────────────────────────────
    // Resolved at CacheKey build time when clip->stretchMethod == Global.
    // Mutated from message thread only.
    int  globalStretchMethod_   {1};   // 1=PSOLA (default), 2=Rubber, 3=WSOLA, 4=PhaseVocoder, 5=WORLD
    bool globalFormantPreserve_ {false};

    // Per-track volume smoother (20ms linear ramp, indexed by SLOT).
    // Eliminates zipper noise on fader moves.
    // Not thread-safe — only call setCurrentAndTargetValue() from contexts
    // where processBlock() is not running concurrently (see rebuildAllSamplers).
    juce::SmoothedValue<float, juce::ValueSmoothingTypes::Linear> volumeSmoothed_[kMaxTracks];

    // Per-track effect-tail drain (silence-detected). tailEndSamples_ is the
    // absolute sample at which the tail HARD CAP expires (0 = not tailing); it
    // is armed to a generous ceiling while content is active and consulted when
    // content ends to keep calling the effect chain on silent buffers so
    // reverb/delay tails ring out. tailBelowThreshRun_ counts consecutive
    // sub-threshold output samples during the tail so a decayed tail stops early
    // (independent of the plugin's unreliable getTailLengthSeconds()).
    // Audio-thread only — no mutex needed.
    int64_t tailEndSamples_[kMaxTracks] = {};
    int64_t tailBelowThreshRun_[kMaxTracks] = {};

    class StereoCompensationDelay
    {
    public:
        void prepare(double sampleRate, int maxBlockSize);
        void reset();
        void resetToDelaySamples(int delaySamples);
        void setTargetDelaySamples(int delaySamples);
        void process(juce::AudioBuffer<float>& buffer, int numSamples);
        // Longest delay any read tap may still be using (a retarget crossfade
        // reads both the source and the target delay).
        int getCurrentDelaySamples() const noexcept
        {
            return std::max({ currentDelaySamples_, sourceDelaySamples_, targetDelaySamples_ });
        }

    private:
        static constexpr int kCrossfadeSamples = 64;
        static constexpr int kDefaultCapacitySamples = 65536;

        void ensureCapacity(int requiredDelaySamples);
        static int nextPowerOfTwo(int value);
        float readSample(int channel, int delaySamples) const;

        std::vector<float> channels_[2];
        int bufferMask_ = 0;
        int writePos_ = 0;
        int currentDelaySamples_ = 0;
        int sourceDelaySamples_ = 0;
        int targetDelaySamples_ = 0;
        int crossfadeRemaining_ = 0;
        bool hasProcessedAudio_ = false;
        int maxBlockSize_ = 0;
        double sampleRate_ = 44100.0;
    };

    StereoCompensationDelay trackCompensationDelays_[kMaxTracks];
    int cachedTrackInsertLatencySamples_[kMaxTracks] = {};
    int cachedTrackCompensationSamples_[kMaxTracks] = {};
    std::uint64_t cachedTrackLatencyEpochs_[kMaxTracks] = {};
    int cachedMaxAudibleTrackLatencySamples_ = 0;
    int cachedMasterInsertLatencySamples_ = 0;
    std::uint64_t cachedMasterLatencyEpoch_ = 0;
    std::atomic<bool> pendingLatencyCompensationReset_{false};
    mutable xleth::audio::AudioPerformanceTelemetry audioPerformanceTelemetry_;

    // ── Envelope Controller → parameter modulation state ────────────────
    //
    // Publication is an epoch-based RCU, not a lock and not a "probably long
    // enough" buffer ring:
    //
    //   * envelopeSnapshotLive_ is the ONLY thing the audio thread reads. It loads
    //     the pointer once per block into a local, so it can never observe a
    //     half-published snapshot.
    //   * envelopeAudioEpoch_ is bumped by the audio thread at the START of every
    //     block, before it loads the pointer.
    //   * The message thread publishes a new pointer, then retires the old one
    //     TOGETHER WITH the epoch observed at publication time. A retired snapshot
    //     is destroyed only once the audio epoch has moved past that value, which
    //     proves the audio thread has entered a block that cannot have loaded it.
    //
    // The audio thread therefore never allocates, never frees, never locks, and
    // never blocks the message thread. Freeing always happens on the message
    // thread, on the next refresh.
    std::atomic<const xleth::envmod::EnvelopeModulationSnapshot*> envelopeSnapshotLive_{nullptr};
    std::atomic<std::uint64_t> envelopeAudioEpoch_{0};
    // True only while the audio thread is inside evaluateEnvelopeModulation. Lets a
    // retired snapshot be freed immediately when no audio thread is running at all
    // (offline tests, no audio device), instead of piling up until the next block.
    // Sound because the live pointer is stored BEFORE this is read: a thread that
    // enters afterwards can only load the new snapshot.
    std::atomic<bool> envelopeAudioInBlock_{false};
    // Message-thread-owned strong references. envelopeSnapshotOwner_ keeps the
    // live snapshot alive; envelopeSnapshotRetired_ defers destruction of the
    // previous ones until the audio thread has provably moved on.
    std::shared_ptr<const xleth::envmod::EnvelopeModulationSnapshot> envelopeSnapshotOwner_;
    std::vector<std::pair<std::shared_ptr<const xleth::envmod::EnvelopeModulationSnapshot>,
                          std::uint64_t>> envelopeSnapshotRetired_;
    mutable std::mutex envelopeSnapshotMutex_;   // message/applier threads only

    // Applier-side last-written value, keyed by target identity (NOT by mailbox
    // index) so a snapshot rebuild does not resend every parameter, and a target
    // that keeps its identity across an unrelated graph edit stays de-duplicated.
    struct EnvelopeApplierKey
    {
        int         trackId = -1;
        std::string effectInstanceId;
        std::string parameterId;
        bool operator==(const EnvelopeApplierKey& o) const
        {
            return trackId == o.trackId
                && effectInstanceId == o.effectInstanceId
                && parameterId == o.parameterId;
        }
    };
    struct EnvelopeApplierKeyHash
    {
        std::size_t operator()(const EnvelopeApplierKey& k) const
        {
            std::size_t h = std::hash<int>{}(k.trackId);
            h ^= std::hash<std::string>{}(k.effectInstanceId) + 0x9e3779b9 + (h << 6) + (h >> 2);
            h ^= std::hash<std::string>{}(k.parameterId) + 0x9e3779b9 + (h << 6) + (h >> 2);
            return h;
        }
    };
    std::unordered_map<EnvelopeApplierKey, float, EnvelopeApplierKeyHash> envelopeAppliedValues_;
    // Per-mailbox seq last drained, so an unchanged value is never rewritten. Mailbox
    // INDICES are only meaningful within one snapshot, so the seq table is reset whenever
    // the snapshot changes. The identity is held as a strong reference, not a raw pointer:
    // a raw pointer could be compared equal to a freshly allocated snapshot that happened
    // to reuse the freed address, which would skip the reset and then index a stale,
    // possibly shorter, seq table.
    std::vector<std::uint32_t> envelopeDrainedSeqs_;
    std::shared_ptr<const xleth::envmod::EnvelopeModulationSnapshot> envelopeDrainedSnapshot_;

    std::thread             envelopeApplierThread_;
    std::atomic<bool>       envelopeApplierRunning_{false};

    // [PDCNotify] Last LatencyChangeSignal::generation() servicePendingLatencyChanges
    // acted on, and how many chain recomputes it has performed.
    std::atomic<std::uint64_t> latencyChangeGenerationSeen_{0};
    std::atomic<std::uint64_t> latencyChangeServiceCount_{0};

    // AUDIO THREAD. Evaluate every published envelope at this block's transport
    // position and publish the mapped values. `atRest` publishes the env == 0
    // values instead (each edge's authored base) — the stop release.
    void evaluateEnvelopeModulation(int64_t positionSamples,
                                    double  bpm,
                                    double  sampleRate,
                                    bool    atRest) noexcept;

    void startEnvelopeApplierThread();
    void stopEnvelopeApplierThread();

    // ── Xleth Filter in-effect Envelope gates (audio + message threads) ──────
    // The per-slot Envelope modulator lives INSIDE the filter effect, but its
    // note/clip gate is a timeline fact the effect cannot derive. MixEngine
    // resolves the gate per block (from the per-track gate timelines carried on
    // the envelope snapshot — EnvelopeModulationSnapshot::filterTrackGates) and
    // pushes it into the track's filter effects before their chain runs.
    struct FilterGate
    {
        int          trackId = -1;
        bool         valid   = false;
        std::int64_t start   = 0;
        std::int64_t end     = 0;
    };
    FilterGate filterGates_[kMaxTracks];
    int        filterGateCount_ = 0;

    // MESSAGE THREAD. Build a note/clip gate timeline for every track whose chain
    // holds a filter with an active Envelope modulator and store them on the
    // (freshly built) envelope snapshot. Reuses buildTrackGateIntervals.
    void populateFilterEnvelopeGates(xleth::envmod::EnvelopeModulationSnapshot& snapshot);

    // AUDIO THREAD. Resolve each filter-track gate at this block's position into
    // filterGates_ (read later in the per-track chain loop). Called from inside
    // evaluateEnvelopeModulation, under its snapshot epoch guard.
    void resolveFilterGatesFromSnapshot(const xleth::envmod::EnvelopeModulationSnapshot& snapshot,
                                        int64_t positionSamples, double bpm,
                                        double sampleRate, bool atRest) noexcept;

    // ── LFO Modulator → parameter modulation state ───────────────────────
    //
    // Same epoch-based RCU discipline as the Envelope block above — see its
    // comment for the full ordering argument, which applies unchanged here
    // with lfo* in place of envelope*.
    std::atomic<const xleth::lfomod::LfoModulationSnapshot*> lfoSnapshotLive_{nullptr};
    std::atomic<std::uint64_t> lfoAudioEpoch_{0};
    std::atomic<bool> lfoAudioInBlock_{false};
    std::shared_ptr<const xleth::lfomod::LfoModulationSnapshot> lfoSnapshotOwner_;
    std::vector<std::pair<std::shared_ptr<const xleth::lfomod::LfoModulationSnapshot>,
                          std::uint64_t>> lfoSnapshotRetired_;
    mutable std::mutex lfoSnapshotMutex_;   // message/applier threads only

    // Applier-side last-written value, keyed by target identity (NOT by mailbox
    // index) — same rationale as EnvelopeApplierKey above.
    struct LfoApplierKey
    {
        int         trackId = -1;
        std::string effectInstanceId;
        std::string parameterId;
        bool operator==(const LfoApplierKey& o) const
        {
            return trackId == o.trackId
                && effectInstanceId == o.effectInstanceId
                && parameterId == o.parameterId;
        }
    };
    struct LfoApplierKeyHash
    {
        std::size_t operator()(const LfoApplierKey& k) const
        {
            std::size_t h = std::hash<int>{}(k.trackId);
            h ^= std::hash<std::string>{}(k.effectInstanceId) + 0x9e3779b9 + (h << 6) + (h >> 2);
            h ^= std::hash<std::string>{}(k.parameterId) + 0x9e3779b9 + (h << 6) + (h >> 2);
            return h;
        }
    };
    std::unordered_map<LfoApplierKey, float, LfoApplierKeyHash> lfoAppliedValues_;
    // Per-mailbox seq last drained — same reset-on-snapshot-change rationale as
    // envelopeDrainedSeqs_/envelopeDrainedSnapshot_ above.
    std::vector<std::uint32_t> lfoDrainedSeqs_;
    std::shared_ptr<const xleth::lfomod::LfoModulationSnapshot> lfoDrainedSnapshot_;

    // AUDIO THREAD. Evaluate every published LFO at this block's transport
    // position and publish the mapped values. Unlike Envelope, `atRest` is not
    // the only "go inert" trigger: a per-edge audibility check (mute/solo, via
    // xleth::buildRoutePlan) ALSO forces the inert path, because an LFO's
    // neutral sample does not rescale to `base` the way Envelope's env==0
    // does. See LfoParameterModulation.h's header-top note.
    void evaluateLfoModulation(int64_t positionSamples,
                               double  bpm,
                               double  sampleRate,
                               bool    atRest) noexcept;

    struct RealtimeDiagnosticsState
    {
        std::atomic<bool> enabled{false};
        std::atomic<uint64_t> blockCount{0};
        std::atomic<uint64_t> audioCallbackCount{0};
        std::atomic<uint64_t> totalProcessNs{0};
        std::atomic<uint64_t> maxProcessNs{0};
        std::atomic<uint64_t> totalDeadlineNs{0};
        std::atomic<uint64_t> maxRatioPermille{0};
        std::atomic<uint64_t> overBudgetBlockCount{0};
        std::atomic<uint64_t> overrunBlockCount{0};
        std::atomic<uint64_t> totalAudioCallbackNs{0};
        std::atomic<uint64_t> maxAudioCallbackNs{0};
        std::atomic<uint64_t> maxAudioCallbackRatioPermille{0};
        std::atomic<uint64_t> audioCallbackOverrunCount{0};
        std::atomic<uint64_t> chainLockMissCount{0};
        std::atomic<uint64_t> pdcRetargetCount{0};
        std::atomic<uint64_t> pdcDelayProcessCount{0};
        std::atomic<uint64_t> trackProcessCount{0};
        std::atomic<uint64_t> totalTrackProcessNs{0};
        std::atomic<uint64_t> maxTrackProcessNs{0};
        std::atomic<int> worstTrackId{-1};
        std::atomic<uint64_t> trackChainProcessCount{0};
        std::atomic<uint64_t> totalTrackChainNs{0};
        std::atomic<uint64_t> maxTrackChainNs{0};
        std::atomic<int> worstTrackChainId{-1};
        std::atomic<uint64_t> totalPdcDelayNs{0};
        std::atomic<uint64_t> maxPdcDelayNs{0};
        std::atomic<uint64_t> pluginCallCount{0};
        std::atomic<uint64_t> totalPluginNs{0};
        std::atomic<uint64_t> maxPluginNs{0};
        std::array<std::atomic<char>, 64> worstPluginId{};
        std::atomic<int> worstPluginTrackId{-1};
        std::atomic<int> worstPluginNodeId{-1};
        std::atomic<uint64_t> resonanceSuppressorCallCount{0};
        std::atomic<uint64_t> totalResonanceSuppressorNs{0};
        std::atomic<uint64_t> maxResonanceSuppressorNs{0};
        std::atomic<uint64_t> resonanceSuppressorWolaCallCount{0};
        std::atomic<uint64_t> totalResonanceSuppressorWolaNs{0};
        std::atomic<uint64_t> maxResonanceSuppressorWolaNs{0};
        std::atomic<uint64_t> resonanceSuppressorAudioThreadReprepareCount{0};
        std::atomic<uint64_t> resonanceSuppressorDeferredReprepareCount{0};
        std::atomic<uint64_t> nanInfBlockCount{0};
        std::atomic<int> lastBlockSize{0};
        std::atomic<uint64_t> lastSampleRateMilliHz{0};
        std::atomic<uint64_t> lastDeadlineNs{0};
    };

    RealtimeDiagnosticsState realtimeDiagnostics_;

    // See setRealtimeDeadlineOverrideNs(). 0 = derive from block size / rate.
    std::atomic<uint64_t> realtimeDeadlineOverrideNs_{0};
    // Deadline for a callback-level timing sample (AudioCallback / MixBlock).
    uint64_t realtimeDeadlineNs(int numSamples, double sampleRate) const noexcept;

    // [Underrun] Audio-health: clip-render-cache misses observed on the audio
    // thread (see getClipCacheMissCount). Incremented in processBlock; read from
    // the 1s health sampler. Standalone (not gated on realtime diagnostics).
    std::atomic<uint64_t> clipCacheMissCount_{0};

    static void realtimePluginTimingCallback(void* userData, const char* pluginId,
                                             int trackId, int nodeId, uint64_t elapsedNs);
    static void realtimeSectionTimingCallback(void* userData, const char* pluginId,
                                              const char* sectionId, int trackId,
                                              int nodeId, uint64_t elapsedNs);
    static void realtimeEventCallback(void* userData, const char* pluginId,
                                      const char* eventId, int trackId, int nodeId);
    void recordRealtimePluginTiming(const char* pluginId, int trackId,
                                    int nodeId, uint64_t elapsedNs) noexcept;
    void recordRealtimeSectionTiming(const char* pluginId, const char* sectionId,
                                     int trackId, int nodeId, uint64_t elapsedNs) noexcept;
    void recordRealtimeEvent(const char* pluginId, const char* eventId,
                             int trackId, int nodeId) noexcept;
    void recordProcessBlockTiming(int numSamples, double sampleRate,
                                  uint64_t elapsedNs) noexcept;
    void recordTrackProcessTiming(int trackId, uint64_t elapsedNs) noexcept;
    void recordTrackChainTiming(int trackId, uint64_t elapsedNs) noexcept;
    void recordPdcDelayTiming(uint64_t elapsedNs) noexcept;
    void recordPdcRetarget() noexcept;
    void recordTelemetryTiming(xleth::audio::AudioTelemetrySampleKind kind,
                               int trackId,
                               int slotOrNodeId,
                               uint32_t effectType,
                               uint32_t flags,
                               int numSamples,
                               double sampleRate,
                               uint64_t elapsedNs,
                               uint64_t latencyEpoch = 0,
                               int compensationSamples = 0) noexcept;
    int countActiveResonanceSuppressorHighQualityInstancesLocked() const;

    DiagnosticTapSink* diagnosticTapSink_ = nullptr;
    std::uint64_t diagnosticTapBlockIndex_ = 0;

    // ── Track ID → slot mapping (main thread read/write, never audio thread) ──
    // Updated by updateSlotMapping() in rebuildAllSamplers and track add/remove.
    // Setters and peak getters acquire shared_lock; updateSlotMapping acquires
    // unique_lock. Audio thread never touches this — it uses loop counter i directly.
    mutable std::shared_mutex slotMutex_;
    std::unordered_map<int, int> trackIdToSlot_;

    // ── Plugin registry ──────────────────────────────────────────────────────
    std::unique_ptr<PluginRegistry> pluginRegistry_;

    // ── Plugin editor host (stock effects — in-process DocumentWindow) ──────────
    std::unique_ptr<PluginEditorHost> editorHost_;

    // ── VST out-of-process editor coordinators ────────────────────────────────
    // Key: {trackId, nodeId}.  One coordinator per open VST editor process.
    std::string                                                         editorHostExePath_;
    std::atomic<uintptr_t>                                              mainWindowHwnd_{0};
    std::map<std::pair<int,int>, std::unique_ptr<EditorProcessCoordinator>> vstEditorCoordinators_;
    mutable std::mutex                                                  vstEditorCoordinatorsMutex_;

    // ── Coordinator reaper thread ─────────────────────────────────────────────
    // Dying coordinators are pushed here from the IPC poll thread (onClosed_)
    // or from explicit closePluginEditor calls. A single long-lived thread pops
    // and destroys them, avoiding self-join deadlock: the coordinator being
    // destroyed owns the poll thread that produced the onClosed_ event, so we
    // must destroy it from a thread other than that poll thread.
    std::thread                                                         coordinatorReaperThread_;
    std::mutex                                                          reaperMutex_;
    std::condition_variable                                             reaperCv_;
    std::deque<std::unique_ptr<EditorProcessCoordinator>>               reaperQueue_;
    std::atomic<bool>                                                   reaperStop_{false};

    void runCoordinatorReaper();
    void reapCoordinator(std::unique_ptr<EditorProcessCoordinator> dying);

    // ── Effect chains ───────────────────────────────────────────────────────
    // Map key = trackId. chainsMutex_ protects the map, masterEffectChain_ and
    // the automation runtime AGAINST OTHER MESSAGE-THREAD WRITERS, and is still
    // taken (blocking) by an offline render — see processBlock.
    //
    // Finding 9: the REALTIME audio thread no longer takes this mutex at all.
    // It used to try_lock it and, on a miss, skip every per-track and master
    // effect chain for that block — a dry block and an audible level jump, not
    // a dropped optimisation. Measured on a real session it missed on ~1.9% of
    // blocks during ordinary mixer metering and on up to ~94% while chains were
    // being edited. The audio thread now reads an immutable ChainSnapshot
    // published through std::atomic<std::shared_ptr>, the same pattern
    // ClipRenderCache::slots_ uses for rendered buffers.
    mutable std::mutex chainsMutex_;
    std::unordered_map<int, std::shared_ptr<EffectChainManager>> effectChains_;

    // ── Automation runtime (written under chainsMutex_) ──────────────────────
    // One entry per AutomationPlan target, in the same order. Resolution is main
    // thread; the audio thread only stores into `raw`.
    //
    // `effect` + `nodeId` are a LIVENESS CHECK, not a shortcut: before writing,
    // the audio thread re-derives the effect from its chain by nodeId and
    // compares. If the effect was removed (or replaced) since the plan was
    // built, the lookup returns a different pointer (node ids are monotonic
    // uids, never reused) and the target is skipped — so a stale plan fails
    // closed instead of writing through a dangling pointer.
    //
    // Finding 9 changed WHAT makes that check safe, not the check itself. The
    // audio thread no longer holds chainsMutex_, so it re-derives through the
    // ChainSnapshot's immutable RealtimeView rather than the live node map, and
    // the snapshot's strong Node::Ptr references keep `effect` alive for as long
    // as the block can still see it. A runtime is only ever reachable through
    // the snapshot that resolved it, so a target can never outlive its chain.
    struct AutomationRuntimeTarget
    {
        std::atomic<float>*         raw    = nullptr;
        juce::RangedAudioParameter* param  = nullptr;
        XlethEffectBase*            effect = nullptr;
        int   nodeId      = -1;
        int   trackId     = -1;     // -1 = master chain
        float lastWritten = 0.0f;   // skip redundant stores
        bool  everWritten = false;
    };

    struct AutomationRuntime
    {
        std::shared_ptr<const xleth::automation::AutomationPlan> plan;
        std::vector<AutomationRuntimeTarget> targets;   // parallel to plan->targets
        int resolvedCount = 0;
    };

    // Published by refreshAutomationPlan() under chainsMutex_, and handed to the
    // audio thread only as ChainSnapshot::automation — never read directly off
    // this member from the realtime path.
    std::shared_ptr<AutomationRuntime> automationRuntime_;

    // Set by every chain mutator that can create or destroy a node; serviced by
    // the envelope applier thread through refreshAutomationPlanIfDirty().
    std::atomic<bool> automationBindingsDirty_{false};


    // ── Lock-free chain snapshot (Finding 9) ────────────────────────────────
    //
    // Immutable once published. Holds shared_ptrs to THE SAME EffectChainManager
    // objects effectChains_/masterEffectChain_ own, which is what makes the
    // offline path (which still reads the map under the blocking lock) and the
    // realtime path bit-identical by construction: same objects, same order,
    // same DSP. The snapshot answers "which chains exist, and for which track";
    // "what is in this chain right now" is answered per block by the chain's own
    // GraphRealtimeView.
    struct ChainSnapshot
    {
        struct TrackEntry
        {
            int trackId = -1;
            std::shared_ptr<EffectChainManager> chain;
        };

        std::uint64_t generation = 0;
        std::vector<TrackEntry> tracks;                 // sorted by trackId
        std::shared_ptr<EffectChainManager> master;

        // Deliberately NOT cached here: AudioGraph republishes its own node
        // view on its debounce timer, so a view captured at snapshot time can
        // go stale between chain mutations. The audio thread loads the current
        // one per block through chain->realtimeView() — one atomic load, and
        // the copy it holds pins every processor it names for the block.

        // Resolved against exactly these chains, so a target can never point
        // into an effect this snapshot does not keep alive.
        std::shared_ptr<AutomationRuntime> automation;

        // Audio thread: binary search, no allocation, no hashing.
        const TrackEntry* find(int trackId) const noexcept
        {
            const auto it = std::lower_bound(
                tracks.begin(), tracks.end(), trackId,
                [](const TrackEntry& e, int id) { return e.trackId < id; });
            return (it != tracks.end() && it->trackId == trackId) ? &*it : nullptr;
        }
    };

    // Published by publishChainSnapshotLocked(), read by processBlock.
    // MSVC implements std::atomic<shared_ptr<T>> with internal lock striping
    // (~20 ns) rather than a user-visible lock — the same trade ClipRenderCache
    // documents and accepts, and negligible against a 10 ms block.
    mutable std::atomic<std::shared_ptr<const ChainSnapshot>> chainSnapshot_;
    std::uint64_t chainSnapshotGeneration_ = 0;   // message thread only

    // Superseded snapshots, held on the message thread so the audio thread can
    // never be the last owner of an EffectChainManager (which would run plugin
    // destructors on the realtime thread). Pruned on the next publish, and only
    // when use_count()==1 — i.e. when nothing but this list still holds it.
    std::vector<std::shared_ptr<const ChainSnapshot>> retiredChainSnapshots_;

    // Rebuild and publish the snapshot from effectChains_/masterEffectChain_.
    // PRECONDITION: chainsMutex_ is held by the caller.
    void publishChainSnapshotLocked();

    // ── Source transform table publisher ────────────────────────────────────
    // Same shape as chainSnapshot_: immutable table behind an atomic
    // shared_ptr, superseded tables retired here so a reader can never be the
    // one that frees a table's vector on the realtime thread.
    mutable std::atomic<std::shared_ptr<const xleth::TrackSourceTransformTable>> sourceTransformTable_;
    std::uint64_t sourceTransformGeneration_ = 0;                   // message thread only
    xleth::SourceTransformEpochSnapshot sourceTransformSnapshot_;   // message thread only
    std::vector<std::shared_ptr<const xleth::TrackSourceTransformTable>> retiredSourceTransformTables_;

    // Publish `table` with the next generation. PRECONDITION: chainsMutex_ held
    // (it serialises this with every other writer of the members above).
    void publishSourceTransformTableLocked(xleth::TrackSourceTransformTable table);

    // ── Clip mode settle queue (message thread only) ────────────────────────
    std::vector<int> fxInvalidationTracks_;        // sorted, unique
    int64_t          fxInvalidationLastChangeMs_ = 0;
    bool             fxInvalidationPending_      = false;
    std::vector<int> clipMissScratch_;             // serviceClipRenderCache scratch
    class SourceTransformSettleTimer;
    std::unique_ptr<SourceTransformSettleTimer> fxSettleTimer_;

    // Queue every track whose transform differs between the two tables.
    void queueSourceTransformChanges(const xleth::TrackSourceTransformTable& before,
                                     const xleth::TrackSourceTransformTable& after,
                                     int64_t nowMs);

    // RAII republish. Declared immediately after the lock guard in every chain
    // mutator: destruction order means this fires while chainsMutex_ is still
    // held, and no early return can leave the audio thread on a stale snapshot.
    // Parameter writes deliberately do NOT use it — they change no chain
    // membership, and any latency rebuild they trigger republishes the
    // AudioGraph node view on its own.
    struct ChainSnapshotPublisher
    {
        MixEngine* engine;
        explicit ChainSnapshotPublisher(MixEngine* e) noexcept : engine(e) {}
        ~ChainSnapshotPublisher() { engine->publishChainSnapshotLocked(); }
        ChainSnapshotPublisher(const ChainSnapshotPublisher&) = delete;
        ChainSnapshotPublisher& operator=(const ChainSnapshotPublisher&) = delete;
    };

    // Convenience for the ~40 message-thread mutators: take the lock, run `fn`,
    // republish before releasing. Returns whatever `fn` returns.
    std::shared_ptr<const ChainSnapshot> currentChainSnapshot() const noexcept
    {
        return chainSnapshot_.load(std::memory_order_acquire);
    }

    // Evaluate the plan at `tick` and write each target's value. AUDIO THREAD.
    // Reads everything it touches out of `chains`, which pins both the runtime
    // and the effects it points into. No allocation, no locks, no logging.
    void applyAutomationForBlock(const ChainSnapshot& chains, int64_t tick) noexcept;

    std::shared_ptr<EffectChainManager> masterEffectChain_;
    double preparedSampleRate_ = 44100.0;
    int    preparedBlockSize_  = 512;

    // Active clip info — pre-allocated, reused each block
    struct ActiveClip
    {
        const Clip*     clip;
        int             sampleBankId;
        int64_t         clipStartSample;
        int64_t         clipEndSample;
        int64_t         regionOffsetSamples;
    };
    std::vector<ActiveClip> activeClips_;

    // ── Incremental active-clip scan (Finding 2c) ───────────────────────────
    // sortedClipsByStart_ mirrors every Clip in the project, sorted ascending
    // by tick position (order by ticks == order by samples for any fixed bpm,
    // so this ordering stays valid across a live tempo change). Rebuilt only
    // when Timeline's clip topology generation advances — i.e. on an actual
    // add/remove/move/resize, not every block.
    //
    // During uninterrupted sequential playback, findActiveClips() no longer
    // rescans every clip in the project: clipScanCursor_ walks forward
    // through sortedClipsByStart_ exactly once, activating each clip as its
    // start sample enters the window, while already-active clips are
    // refreshed (not rescanned from the full list) each block so a live bpm
    // change or a live region→sample remap still lands on the next block,
    // exactly as the old full rescan produced. A topology change or a seek
    // (bufferStart not contiguous with the last call) forces one full
    // rebuild — the same cost the old code paid every single block.
    std::vector<const Clip*> sortedClipsByStart_;
    int      clipScanCursor_ = 0;
    int64_t  clipScanLastBufferEnd_ = -1;
    uint64_t cachedClipTopologyGeneration_ = ~static_cast<uint64_t>(0);
    // Double-buffer scratch for refreshing the previous block's active set
    // without a per-block allocation (same swap-not-copy idiom prevActiveBlocks_
    // uses below for pattern blocks).
    std::vector<ActiveClip> prevActiveClipsScratch_;
    void rebuildSortedClipsByStart();

    // Per-{track,region} Sampler instances (main-thread owned, audio-thread
    // read). Keyed by {trackId, regionId}: each pattern track is sample-
    // agnostic, and different PatternBlocks on the same track may reference
    // patterns with different regionIds. We keep a separate Sampler per
    // unique {trackId, regionId} pair so each block's voices don't collide
    // with adjacent blocks using a different region.
    // ADSR/loop/crossfade settings are copied from the referenced region on
    // load, so settings are conceptually per-instrument (shared across every
    // pair with that regionId — refreshed in bulk on region edits).
public:
    struct TrackRegionKey {
        int trackId;
        int regionId;
        bool operator==(const TrackRegionKey& o) const noexcept {
            return trackId == o.trackId && regionId == o.regionId;
        }
    };
    struct TrackRegionKeyHash {
        size_t operator()(const TrackRegionKey& k) const noexcept {
            return (static_cast<size_t>(static_cast<uint32_t>(k.trackId)) << 32)
                 ^  static_cast<size_t>(static_cast<uint32_t>(k.regionId));
        }
    };
private:
    std::unordered_map<TrackRegionKey, std::unique_ptr<Sampler>, TrackRegionKeyHash> samplers_;

    // {regionId, slotIndex} → SampleBank id, for slots 1..7 only (see
    // mapRegionSlotToSample). Keyed by regionId*MAX_SAMPLE_SLOTS + slotIndex.
    std::unordered_map<int, int> slotSampleMap_;

    // Shared builder behind loadSamplerForTrackRegion and ensurePreviewSampler:
    // pushes every region setting (sampler-level and per-slot) plus each slot's
    // PCM into a freshly constructed Sampler.
    std::unique_ptr<Sampler> buildSamplerForRegion(const SampleRegion& region);

    // Preview samplers, keyed by regionId. Dedicated to piano-roll and
    // MiniKeyboard auditioning — decoupled from per-track playback so a
    // preview note never competes with timeline voices on the same region.
    //
    // routeTrackId is the track whose effect chain this region's preview is
    // pushed through (kPreviewRouteNone = dry). It is resolved on the main
    // thread at audition time (refreshPreviewRoute) and read on the audio
    // thread, hence the atomic. The slot is heap-allocated so the atomic never
    // has to move when the map rehashes.
    struct PreviewSamplerSlot
    {
        std::unique_ptr<Sampler> sampler;
        std::atomic<int> routeTrackId { xleth::kPreviewRouteNone };
        // Mixer slot index for routeTrackId, resolved on the main thread at the
        // same moment as the route. trackIdToSlot_ lives under slotMutex_ and
        // the audio thread must never take that lock, so the answer is
        // published here instead. -1 when the route has no live mixer slot.
        std::atomic<int> routeTrackSlot { -1 };
    };
    std::unordered_map<int, std::unique_ptr<PreviewSamplerSlot>> previewSamplers_;

    // Audition routing preference (main thread writes, main thread reads during
    // route resolution). selectedTrackId is only meaningful in Selected mode.
    std::atomic<int> previewRouteMode_ {
        static_cast<int>(xleth::SamplerPreviewRouteMode::Dedicated) };
    std::atomic<int> previewRouteSelectedTrackId_ { -1 };

    // Shared by both preview render sites (transport stopped and playing):
    // sums each preview sampler into previewBuffer_, groups by resolved route,
    // and pushes each group through that track's chain before it reaches the
    // master output. `chainsLocked` must be true for any chain to be used.
    // `chains` non-null enables routed auditioning (walk the track chain, the
    // track fader, then the master chain). Null means dry audition only. It
    // used to be a bool fed by a try_lock on chainsMutex_, which silently
    // demoted a routed audition to dry whenever the message thread happened to
    // hold the lock; the snapshot removes that coin flip (Finding 9).
    void renderPreviewSamplers(juce::AudioBuffer<float>& outputBuffer,
                               int numSamples, double sampleRate,
                               double bpm, const ChainSnapshot* chains);

    // Scratch MIDI for preview chain processing. Always empty — preview notes
    // carry no onset events for effects to read.
    juce::MidiBuffer previewMidi_;

    // Sum of every ROUTED preview after its track chain and track fader. Fed
    // through the master chain and master fader as one bus, so an audition
    // lands where the arrangement lands. Dry previews never enter it.
    juce::AudioBuffer<float> previewMasterBus_;

    // Transport state tracking: when playback transitions true → false,
    // fire allNotesOff() on every sampler so sustained notes release instead
    // of ringing past the stop point.
    bool wasPlaying_ = false;

    // Seek detection: tracks the expected start of the next audio buffer.
    // When bufStart != lastBufferEnd_, the playhead jumped — release all
    // held pattern notes so stale voices don't ring past the seek point.
    int64_t lastBufferEnd_ = -1;

    // Transport stop reset request for effect processors. Audio thread posts
    // through requestEffectChainReset():
    //   - realtime: bumps effectResetRequestGen_; serviceEffectChainResets()
    //     resets the chains off-thread, typically within 1-2 blocks. Only for
    //     a STOP: nothing plays until the next start, so late is harmless.
    //   - non-realtime (export): sets pendingEffectChainReset_ and the chains
    //     reset inline under chainsMutex_, exactly as before, so an export stays
    //     deterministic.
    void requestEffectChainReset() noexcept;
    bool pendingEffectChainReset_ = false;              // audio thread only
    std::atomic<uint64_t> effectResetRequestGen_ { 0 }; // audio thread -> worker
    uint64_t effectResetServicedGen_ = 0;               // worker only (under chainsMutex_)

    // Transport JUMP while playing (seek, loop wrap, play after an audition).
    // The PDC compensation delay lines reset inline in the jump block, so the
    // chains must too - a worker reset lands blocks later, and a latent effect
    // then plays pre-jump audio and drops post-jump audio against every
    // compensated track. requestJumpChainReset() sets
    // jumpChainResetPending_; the same block resets every chain on the audio
    // thread (EffectChainManager::resetOnAudioThread) and bumps
    // jumpResetRequestGen_ so the worker re-primes the spares that consumed and
    // finishes any node that could not reset realtime safely. Non-realtime:
    // the inline full reset above, as for a stop.
    void requestJumpChainReset() noexcept;
    bool jumpChainResetPending_ = false;                // audio thread only
    std::atomic<uint64_t> jumpResetRequestGen_ { 0 };   // audio thread -> worker
    uint64_t jumpResetServicedGen_ = 0;                 // worker only (under chainsMutex_)
    // An audition ran a track/master chain while stopped. Those tails must not
    // bleed into playback, but must not be wiped mid-audition either, so the
    // reset is requested on the next play start. Audio thread only.
    bool auditionDirtiedChains_ = false;

    // Active pattern-block info — pre-allocated, reused each block
    struct ActivePatternBlock
    {
        const PatternBlock* block;
        const Pattern*      pattern;
        Sampler*            sampler;
        int64_t             blockStartSample;
        int64_t             blockEndSample;
    };
    std::vector<ActivePatternBlock> activeBlocks_;

    // Fix C: previous buffer's active blocks, for per-block dropout diff.
    // prevActiveKeys_ (below) only fires when a whole {trackId, regionId}
    // sampler drops out — it misses the adjacent-block case where block X
    // ends at the same buffer edge that block Y begins and both share a
    // sampler. prevActiveBlocks_ catches that, releasing only the voices
    // that belonged to the dropped block via releaseVoicesSpawnedInRange.
    std::vector<ActivePatternBlock> prevActiveBlocks_;

    // Block-exit voice cutting: tracks which {trackId, regionId} keys had
    // active blocks on the previous processBlock call. When a key drops out
    // (no longer has any active block — block deleted, moved, or playhead
    // jumped away), fire allNotesOff() on that pair's sampler. Keyed per
    // {trackId, regionId} so cutting a different-region block on the same
    // track never cuts voices that belong to a different region's sampler.
    //
    // Fixed capacity, linear search: this set is rebuilt on the audio thread
    // every block, and an unordered_set allocates a node per insert (and, on
    // MSVC, its sentinel + buckets on construction). The key count is bounded
    // by the number of simultaneously active pattern blocks — a handful.
    struct ActiveKeySet
    {
        static constexpr int kCapacity = 1024;
        std::array<TrackRegionKey, kCapacity> keys {};
        int count = 0;

        bool contains(const TrackRegionKey& k) const noexcept
        {
            for (int i = 0; i < count; ++i)
                if (keys[static_cast<size_t>(i)] == k) return true;
            return false;
        }
        void insert(const TrackRegionKey& k) noexcept
        {
            if (contains(k)) return;
            jassert(count < kCapacity);
            if (count < kCapacity) keys[static_cast<size_t>(count++)] = k;
        }
        void assign(const ActiveKeySet& o) noexcept
        {
            std::copy(o.keys.begin(), o.keys.begin() + o.count, keys.begin());
            count = o.count;
        }
        void clear() noexcept { count = 0; }
    };
    ActiveKeySet prevActiveKeys_;
    ActiveKeySet currentActiveKeysScratch_;

    // ── Clip render cache ────────────────────────────────────────────────────
    ClipRenderCache clipRenderCache_;

    // ── Clip modulated reader (Phase C) ─────────────────────────────────────
    // Renders vibrato-enabled clips directly from raw source PCM, bypassing
    // the cache. Owns per-clip read state (one slot per clip id, mirroring
    // the cache's slot policy). Reset on transport stop and seek.
    xleth::audio::ClipModulatedReader clipModReader_;

    // Content-keyed WORLD vocoder cache, consulted by the WORLD branch of
    // ClipRenderJob (worker thread). Lifetime tied to MixEngine.
    std::unique_ptr<xleth::audio::WorldStretchCache> worldStretchCache_;

    // ── Per-slot PREP bake ───────────────────────────────────────────────────
    // Content-keyed, disk-backed cache for the sampler's stretch/shift bake.
    // Held by pointer so MixEngine.h need not pull in the DSP headers.
    std::unique_ptr<xleth::audio::SlotBakeCache> slotBakeCache_;

    // Bakes queued but not yet published, keyed by regionId*MAX_SAMPLE_SLOTS +
    // slotIndex — the same flat key slotSampleMap_ uses. Main thread only.
    // The stored key is what drainSlotBakes() re-looks-up when the cache's
    // completion epoch moves, which is why no per-job callback is needed.
    std::unordered_map<int, std::unique_ptr<xleth::audio::BakeKey>> pendingSlotBakes_;

    // Completion epoch observed at the last drain. A drain whose epoch is
    // unchanged has nothing to publish and returns immediately.
    uint64_t lastBakeEpoch_ = 0;

    // The bake each slot is currently PLAYING, same flat key. A strong
    // reference, deliberately: the cache's LRU may evict an entry at any time,
    // and the editor's waveform mipmap holds a RAW pointer into this buffer, so
    // something has to guarantee it outlives the mipmap. Erased when a slot's
    // PREP is bypassed, or replaced when a new bake supersedes it.
    std::unordered_map<int, PreparedSlot> publishedSlotBakes_;

    // Push `buffer` into every live sampler (playback and preview) that plays
    // this region's slot. nullptr restores the slot's raw audio.
    void publishSlotBuffer(int regionId, int slotIndex,
                           std::shared_ptr<const juce::AudioBuffer<float>> buffer);

    void findActiveClips(int64_t bufferStart, int64_t bufferEnd,
                         double bpm, double sampleRate);

    void findActivePatternBlocks(int64_t bufferStart, int64_t bufferEnd,
                                 double bpm, double sampleRate);

    void triggerPatternNotes(const ActivePatternBlock& apb,
                             int64_t bufferStart, int64_t bufferEnd,
                             double bpm, double sampleRate);

    void ensureTrackBuffers(int numSamples);

    // Offline render mode: when true, processBlock() uses a blocking lock
    // on chainsMutex_ instead of try_to_lock, ensuring effect chains are
    // never skipped. Set by OfflineRenderer before/after the render loop.
    std::atomic<bool> nonRealtime_{false};

    // Offline tail render: new note/clip triggers at or after this absolute
    // sample are suppressed (Phase 3A tailClamp). INT64_MAX = disabled. Read on
    // the audio thread (relaxed); written on the main thread only.
    std::atomic<int64_t> noteTriggerCeilingSample_{
        (std::numeric_limits<int64_t>::max)() };

    // Debug logging throttle
    MixDebugLog debugLog_;
    int64_t     debugSampleCounter_ = 0;
    double      debugSampleRate_    = 44100.0;

    void resetLatencyCompensationState();
    void syncTrackCompensationDelayState(int slot,
                                         int compensationSamples,
                                         bool clearHistory);
    LatencyCompensationSnapshot computeLatencyCompensationSnapshotLocked() const;
    int getTrackChainOutputLatencySamplesLocked(int trackId) const;

    // Builds the route plan + junction PDC plan (Prompt 2C) from the live
    // timeline and current chain latencies. Main-thread diagnostic/export path
    // (caller holds chainsMutex_); the audio thread builds its own per-block
    // plans inside processBlock instead. Returns the slot count; when
    // slotTrackIds != nullptr it receives the trackId of each slot (slot space
    // == getAllTracks() order, same as processBlock).
    int buildRoutePdcPlanLocked(xleth::RoutePlan& plan,
                                xleth::RoutePdcPlan& pdc,
                                int* slotTrackIds) const;

    void maybeLogDebug(int numSamples, double sampleRate);
};
