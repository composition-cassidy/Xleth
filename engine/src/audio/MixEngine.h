#pragma once

#include <juce_audio_basics/juce_audio_basics.h>

#include <nlohmann/json.hpp>

#include "model/TimelineTypes.h"
#include "model/Timeline.h"
#include "SampleBank.h"
#include "Transport.h"
#include "Sampler.h"
#include "audio/ClipRenderCache.h"
#include "audio/ClipModulatedReader.h"

#include <atomic>
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
namespace xleth::audio { class WorldStretchCache; }

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
    // Main-thread read (map is only mutated from main thread).
    int  getSampleIdForRegion(int regionId) const;

    // Returns a copy of the current region→sample mapping table.
    // Main-thread read only; the map is mutated from the main thread.
    std::unordered_map<int, int> getRegionToSampleMapSnapshot() const;

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

    // ── Audio thread ─────────────────────────────────────────────────────────
    // Mix timeline audio into outputBuffer (additive). Caller must clear first
    // if exclusive output is desired.
    void processBlock(juce::AudioBuffer<float>& outputBuffer,
                      int                       numSamples,
                      const Transport&          transport);

    // ── Peak meters (thread-safe reads) ──────────────────────────────────────
    float getMasterPeakL() const { return masterPeakL_.load(std::memory_order_relaxed); }
    float getMasterPeakR() const { return masterPeakR_.load(std::memory_order_relaxed); }
    float getTrackPeakL(int trackId) const;
    float getTrackPeakR(int trackId) const;

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

    // ── Direct atomic parameter setters (main thread → audio thread) ─────────
    // Write the atomic only. MixEngine holds const Timeline*; model write-back
    // (TrackInfo.volume / .pan / .stereoSpread) is the caller's (XlethAddon)
    // responsibility. trackId is translated to a slot index via trackIdToSlot_;
    // no-op if track not found in slot map.
    void setTrackVolume (int trackId, float volume);  // 0..1+
    void setTrackPan   (int trackId, float pan);      // -1..+1  (caller must clamp)
    void setTrackSpread(int trackId, float spread);   // 0..2
    void setMasterVolume(float volume);               // 0..1+

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

    // Evict the cached render for clipId and re-submit a background job if the
    // clip has non-identity pitch/stretch/reverse params.
    // Call from message thread whenever clip playback params change.
    // `trigger` is a diagnostic label identifying the caller (e.g. "setClipParams",
    // "stretchClip", "addClip"). Defaulted so existing callers compile unchanged.
    void invalidateClipCache(int clipId, const char* trigger = "unknown");

    // Returns clip IDs with in-flight WORLD render jobs; forwarded to the N-API
    // layer so the main process can poll and drive the UI processing spinner.
    std::vector<int> getWorldActiveJobIds() const { return clipRenderCache_.getWorldActiveJobIds(); }

    // Returns the cached processed buffer for clipId (message-thread safe via
    // atomic reads). Builds the CacheKey from the clip's current params.
    // Returns nullptr if the clip has identity params (no processing needed)
    // or the cache is a miss (buffer still building). Safe to call from any
    // non-audio thread — atomic shared_ptr load, no mutex.
    const juce::AudioBuffer<float>* getClipProcessedBuffer(int clipId) const;

    // Returns the engine sample rate set by the last prepare() call.
    double getPreparedSampleRate() const { return preparedSampleRate_; }

    // Rebuild the trackId → slot mapping from the current track list.
    // Must be called from the main/message thread whenever tracks are
    // added, removed, or reordered (e.g. in rebuildAllSamplers).
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

    // ── Effect parameter / meter access (main thread only) ──────────────
    // Per-track: returns "[]" / false / "[0,0,0,0]" if chain/node not found.
    std::string getEffectParameters(int trackId, int nodeId) const;
    bool        setEffectParameter (int trackId, int nodeId, const std::string& paramId, float value);
    std::string getEffectMeter     (int trackId, int nodeId) const;

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

    std::unordered_map<int, int> regionToSampleMap_;

    // Pre-allocated stereo track buffers (one per track slot, up to kMaxTracks)
    std::vector<juce::AudioBuffer<float>> trackBuffers_;
    int trackBufferSize_ = 0; // current allocation size in samples

    // Per-track MidiBuffers populated with onset events (note-on, clip-start)
    // before the effect chain runs.  Reused each block — clear() is O(1).
    juce::MidiBuffer trackMidiBuffers_[kMaxTracks];
    juce::MidiBuffer emptyMasterMidi_;

    // Preview bus for sampler voices when transport is stopped (note preview).
    juce::AudioBuffer<float> previewBuffer_;

    // Peak meters
    std::atomic<float> masterPeakL_{0.0f};
    std::atomic<float> masterPeakR_{0.0f};

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

    // Per-track effect-tail drain: absolute sample position where the tail
    // expires.  0 = no tail.  Set while content is active (hasClips or
    // releasing voices), checked when content ends to keep calling the
    // effect chain on silent buffers until internal state drains.
    // Audio-thread only — no mutex needed.
    int64_t tailEndSamples_[kMaxTracks] = {};

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

    // ── Effect chains (main-thread owned, audio-thread reads via tryLock) ──
    // Map key = trackId.  mutex protects both the map and masterEffectChain_.
    mutable std::mutex chainsMutex_;
    std::unordered_map<int, std::unique_ptr<EffectChainManager>> effectChains_;
    std::unique_ptr<EffectChainManager> masterEffectChain_;
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

    // Preview samplers, keyed by regionId. Dedicated to piano-roll and
    // MiniKeyboard auditioning — decoupled from per-track playback so a
    // preview note never competes with timeline voices on the same region.
    std::unordered_map<int, std::unique_ptr<Sampler>> previewSamplers_;

    // Transport state tracking: when playback transitions true → false,
    // fire allNotesOff() on every sampler so sustained notes release instead
    // of ringing past the stop point.
    bool wasPlaying_ = false;

    // Seek detection: tracks the expected start of the next audio buffer.
    // When bufStart != lastBufferEnd_, the playhead jumped — release all
    // held pattern notes so stale voices don't ring past the seek point.
    int64_t lastBufferEnd_ = -1;

    // Transport stop/seek reset request for latent effect processors.
    // Audio-thread only; serviced after chainsMutex_ is acquired.
    bool pendingEffectChainReset_ = false;

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

    // Block-exit voice cutting: tracks which {trackId, regionId} keys had
    // active blocks on the previous processBlock call. When a key drops out
    // (no longer has any active block — block deleted, moved, or playhead
    // jumped away), fire allNotesOff() on that pair's sampler. Keyed per
    // {trackId, regionId} so cutting a different-region block on the same
    // track never cuts voices that belong to a different region's sampler.
    std::unordered_set<TrackRegionKey, TrackRegionKeyHash> prevActiveKeys_;

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

    // Debug logging throttle
    MixDebugLog debugLog_;
    int64_t     debugSampleCounter_ = 0;
    double      debugSampleRate_    = 44100.0;


    void maybeLogDebug(int numSamples, double sampleRate);
};
