// XlethSvcGlobals.h — shared engine-service global state (S2 Stage 1)
//
// INTERNAL header. It lives in engine/src/service/ (NOT engine/include/) on
// purpose: the public XlethEngineService.h keeps its "no host-runtime types
// leak" contract, while this header may freely name engine subsystem types.
//
// S2 Stage 1 extracted every process-global that used to live in the
// XlethEngineService.cpp anonymous namespace (and the five scattered file-scope
// static clusters) into ONE place. Each name is declared `extern` here and
// defined exactly once, in its original relative order, in XlethSvcGlobals.cpp.
//
// This is a linkage change only: internal linkage (anonymous namespace / file
// static) → external linkage (named namespace xleth::svc + extern). No type,
// no initial value, and no threading discipline changed. XlethEngineService.cpp
// keeps every use site compiling untouched via `using namespace xleth::svc;`.
//
// Trap (see docs/S2_SPLIT_PLAN.md §2c): these globals MUST stay in a single
// definitions TU in this order. SyncManager holds a reference to `decoderPtrs`
// (and a pointer to `regionDecoderPtrs`); g_videoRenderer/syncManager/
// g_frameServer reference *g_timeline / MixEngine / *g_gpuDevice / *frameCache.
// Reverse-declaration-order static destruction is the backstop to Shutdown();
// splitting these definitions across TUs would make that order unspecified.
//
// DOCUMENTED LOCK ORDERS (both must be preserved by every later stage —
// see docs/S2_SPLIT_PLAN.md §2c trap 6):
//   1. syncEventsMutex ↔ g_previewCompositorMutex — both taken around
//      SyncManager/compositor work.
//   2. syncEventsMutex → g_posterPrepassMtx; NEVER the reverse. Honored at the
//      one nesting site: drainSourcePosterResults takes syncEventsMutex, then
//      nests g_posterPrepassMtx. buildPosterPrepass does the same.

#pragma once

#ifdef _WIN32
#  ifndef NOMINMAX
#    define NOMINMAX
#  endif
#  ifndef WIN32_LEAN_AND_MEAN
#    define WIN32_LEAN_AND_MEAN
#  endif
#endif

#include <atomic>
#include <chrono>
#include <cstdint>
#include <deque>
#include <fstream>
#include <memory>
#include <mutex>
#include <string>
#include <thread>
#include <unordered_map>
#include <unordered_set>
#include <vector>

#include <nlohmann/json.hpp>

// Engine subsystem headers — pulled in so the extern declarations below name
// complete types and the single definitions TU can construct/destroy them.
#include "AudioEngine.h"
#include "SampleBank.h"
#include "FrameCache.h"
#include "VideoDecoder.h"
#include "SyncManager.h"
#include "audio/WaveformMipmap.h"
#include "audio/MixEngine.h"
#include "model/Timeline.h"
#include "commands/UndoManager.h"
#include "project/ProjectManager.h"
#include "project/ProxyManager.h"
#include "video/FrameServer.h"
#include "video/FrameOutput.h"
#include "render/GpuDeviceManager.h"
#include "render/GridCompositor.h"
#include "render/FrameCache.h"          // RenderFrameCache
#include "render/RenderVideoDecoder.h"
#include "render/AnimationManager.h"
#include "render/FrameCollector.h"
#include "render/HwEncoderDetector.h"
#include "render/OfflineRenderer.h"
#include "render/SnapshotTransitionRenderer.h"  // xleth::TransitionFreezeState (Slice 3b)

struct SwsContext;  // libswscale — forward decl; ScalerEntry only holds a pointer

namespace xleth::svc {

// ─────────────────────────────────────────────────────────────────────────────
// Compile-time constants
// ─────────────────────────────────────────────────────────────────────────────

// Output canvas size (fixed)
inline constexpr int CANVAS_W = 960;
inline constexpr int CANVAS_H = 540;

// ─────────────────────────────────────────────────────────────────────────────
// Types that back the globals below (moved verbatim out of the anon namespace)
// ─────────────────────────────────────────────────────────────────────────────

// ── Visual preview diagnostic counters ───────────────────────────────────────
// Lightweight instrumentation to support Settings → Graphics → Export Visual
// Preview Diagnostic Log. Read by Diag_GetVisualPreviewDiagnostic on the JS
// thread, written by the video thread; all counters are std::atomic.
struct PreviewDiagCounters {
    std::atomic<uint64_t> videoTickCount        {0};
    std::atomic<uint64_t> compositorPathEntered {0};
    // ── Render-gate per-term truth counts (written video thread, read JS thread)
    // Each counter increments once per video tick when that term evaluates true,
    // independently of the gate's short-circuit. Whichever counter is ~0 relative
    // to videoTickCount is the term that keeps the compositor shut during playback.
    std::atomic<uint64_t> gateIsPlayingTrueTicks    {0};
    std::atomic<uint64_t> gateEventsNonEmptyTicks   {0};
    std::atomic<uint64_t> gateForceRenderTicks      {0};
    std::atomic<uint64_t> gatePreviewPausedTicks    {0};
    std::atomic<uint64_t> gateBlockReachedTicks  {0};  // outer if-block entered (audioEngine && syncManager && frameOutput.isInitialized())
    std::atomic<uint64_t> gateBlockSkippedNoInit {0};  // outer if-condition was false
    std::atomic<uint64_t> compositeFrameCount   {0};
    std::atomic<uint64_t> readbackValidCount    {0};
    std::atomic<uint64_t> readbackNotReadyCount {0};
    std::atomic<uint64_t> readbackInvalidCount  {0};
    std::atomic<uint64_t> canvasCopyCount       {0};
    std::atomic<uint64_t> blackFrameCount       {0};
    std::atomic<uint64_t> initInitFailures      {0};
    std::atomic<int32_t>  lastReadbackHRESULT   {0};  // S_OK(0) or failing HRESULT
    std::atomic<int32_t>  lastDeviceRemovedReason {0};
    std::atomic<int>      lastReadbackFailureStage {0};
    std::atomic<int>      lastReadbackMapType   {0};
    std::atomic<int>      lastReadbackMapFlags  {0};
    std::atomic<int>      lastReadbackRowPitch  {0};
    std::atomic<uint64_t> lastReadbackExpectedBytes {0};
    std::atomic<uint64_t> lastReadbackActualCopyBytes {0};
    std::atomic<bool>     lastReadbackDimensionsMatch {false};
    std::atomic<int>      lastReadbackSourceWidth {0};
    std::atomic<int>      lastReadbackSourceHeight {0};
    std::atomic<int>      lastReadbackSourceFormat {0};
    std::atomic<int>      lastReadbackSourceSampleCount {0};
    std::atomic<int>      lastReadbackStagingWidth {0};
    std::atomic<int>      lastReadbackStagingHeight {0};
    std::atomic<int>      lastReadbackStagingFormat {0};
    std::atomic<int>      lastReadbackStagingUsage {0};
    std::atomic<int>      lastReadbackStagingCPUAccessFlags {0};
    std::atomic<int>      lastReadbackStagingBindFlags {0};
    std::atomic<int>      lastReadbackStagingMiscFlags {0};
    std::atomic<int>      lastReadbackStagingSampleCount {0};
    std::atomic<int>      lastReadbackWidth     {0};
    std::atomic<int>      lastReadbackHeight    {0};
    std::atomic<int>      lastRequestCount      {0};
    std::atomic<int>      lastDecodeMissCount   {0};
    // ── Collector content counters (per preview tick) ────────────────────────
    std::atomic<int>      lastActiveVisualEvents {0};  // events fed to collectRequests
    std::atomic<int>      lastDedupKeyCount      {0};  // unique decode keys (frames needed)
    std::atomic<int>      lastCacheHitCount      {0};  // keys already in render cache
    std::atomic<int>      lastDecodeSuccessCount {0};  // misses decoded → texture this tick
    std::atomic<int>      lastDecodeFailCount    {0};  // misses that produced no texture
    std::atomic<int>      lastPreviewTimeMs      {0};  // compositor `time` used (ms)
    std::atomic<int>      lastLayoutColumns     {0};
    std::atomic<int>      lastLayoutRows        {0};
    std::atomic<int>      lastCompositorWidth   {0};
    std::atomic<int>      lastCompositorHeight  {0};
    std::atomic<int>      lastInitW             {0};
    std::atomic<int>      lastInitH             {0};
    // ── Readback policy + timing diagnostics ─────────────────────────────────
    std::atomic<int>      readbackPolicyActive       {0};  // 0=FastImmediate 1=AsyncQueued
    std::atomic<int>      readbackPolicySwitchReason  {0};  // PolicySwitchReason enum (see below)
    std::atomic<uint64_t> droppedPendingFrames        {0};
    std::atomic<int>      pendingSlotsCount           {0};
    std::atomic<int32_t>  lastReadbackUs              {0};  // last readback() call duration (µs)
    std::atomic<int32_t>  avgReadbackUs               {0};  // windowed average (µs)
    std::atomic<int32_t>  maxReadbackUs               {0};  // peak since start
    // ── Preview-tick per-stage wall-clock timing (µs, video thread) ──────────
    // INSTRUMENTATION ONLY. Each stage keeps last / windowed-avg / peak in µs so
    // the dominant cost of a slow preview tick is unambiguous. Stage 5 (readback)
    // reuses lastReadbackUs/avgReadbackUs/maxReadbackUs above — no separate field.
    std::atomic<int32_t>  lastCollectUs    {0};  // 1. collectRequests
    std::atomic<int32_t>  avgCollectUs     {0};
    std::atomic<int32_t>  maxCollectUs     {0};
    std::atomic<int32_t>  lastResolveUs    {0};  // 2. deduplicate + resolveFrames (cache resolve)
    std::atomic<int32_t>  avgResolveUs     {0};
    std::atomic<int32_t>  maxResolveUs     {0};
    std::atomic<int32_t>  lastDecodeUs     {0};  // 3. decode-miss loop
    std::atomic<int32_t>  avgDecodeUs      {0};
    std::atomic<int32_t>  maxDecodeUs      {0};
    std::atomic<int32_t>  lastCompositeUs  {0};  // 4. compositeFrame (GPU submit)
    std::atomic<int32_t>  avgCompositeUs   {0};
    std::atomic<int32_t>  maxCompositeUs   {0};
    std::atomic<int32_t>  lastSwizzleUs    {0};  // 6. CPU swizzle + shared-memory copy
    std::atomic<int32_t>  avgSwizzleUs     {0};
    std::atomic<int32_t>  maxSwizzleUs     {0};
    std::atomic<int32_t>  lastTickUs       {0};  // 7. whole tick (collect → shm copy)
    std::atomic<int32_t>  avgTickUs        {0};
    std::atomic<int32_t>  maxTickUs        {0};
    // Real-wall-clock delivered throughput + per-tick active cell count.
    std::atomic<int32_t>  deliveredFps     {0};  // frames written to shm in the last real second
    std::atomic<int32_t>  lastCellCount    {0};  // active cells (render requests) this tick
    std::atomic<int32_t>  maxCellCount     {0};  // peak active cells since start
    // Cumulative SyncManager::videoTick() blocking-decode call count (mirrors
    // SyncManager::getDecodeAttemptCount() every tick). MUST stay 0 for the
    // lifetime of a .node (bridge/XLETH_CORE_ONLY) process — see the getter's
    // doc comment in SyncManager.h and bridge/test_perf_regression.js, which
    // asserts on this field.
    std::atomic<int32_t>  syncManagerDecodeCount {0};
    // Wall-clock cost of the syncManager->videoTick() call itself (µs),
    // including the syncEventsMutex acquire. Distinct from lastTickUs/
    // avgTickUs/maxTickUs above, which time a LATER, separate stage (the
    // compositor pipeline, collect->shm copy) that only starts after
    // videoTick() has already returned. Added alongside syncManagerDecodeCount
    // to give bridge/test_perf_regression.js a direct budget on this call —
    // see [[project_preview_fps_synctick_dead_decode]].
    std::atomic<int32_t>  lastVideoTickUs  {0};
    std::atomic<int32_t>  avgVideoTickUs   {0};
    std::atomic<int32_t>  maxVideoTickUs   {0};
};

enum class PolicySwitchReason : int {
    None           = 0,
    FatalInvalids  = 1,   // too many fatal readback failures in a window
    MapStallTooSlow = 2,  // avgMs > threshold (blocking Map too slow)
    PoorYield      = 3    // valid frames < 25% of compositor ticks in a window
};

// Per-source scaler cache (source dimensions may differ)
struct ScalerEntry {
    SwsContext* ctx = nullptr;
    int srcW = 0, srcH = 0;
    int dstW = 0, dstH = 0;
};

// ── Sync stats snapshot ───────────────────────────────────────────────────
struct StatsSnapshot {
    double avgDriftMs  = 0.0;
    double maxDriftMs  = 0.0;
    int    frameDrops  = 0;
    double cacheHitRate = 0.0;
};

// ── Audio export state (accessed from bridge thread + export worker thread) ─
struct ExportProgressSnapshot {
    bool        running    = false;
    float       percent    = 0.0f;
    std::string phase;         // "rendering" | "encoding" | "done" | "error" | "cancelled" | ""
    std::string outputPath;
    std::string error;
};

// ── Audio performance capture (self-contained; drain thread + bridge thread) ─
// NOTE: S2 Stage 1 keeps these here rather than in a separate
// XlethSvcAudioPerfCapture.h. The originally-proposed split was justified on
// "drop MixEngine.h + nlohmann/json.hpp from this header", and that rationale is
// void: MixEngine.h arrives transitively via AudioEngine.h (required by
// `audioEngine`, which holds MixEngine by value), and nlohmann/json.hpp arrives
// via model/Timeline.h, project/ProjectManager.h AND audio/MixEngine.h — each
// independently required by a non-perf-capture global. The split would also be a
// deliberate exception to §2c trap 2 (ONE definitions TU). It is DEFERRED to
// Stage 13 (audio core), where it can be re-argued on domain-cohesion grounds.
struct AudioPerformanceCaptureOptions {
    int durationSeconds = 10;
    std::string outputDir;
    bool includeJson = true;
    bool includeMarkdown = true;
    bool strict = false;
    std::string label;
};

struct AudioPerformanceCaptureState {
    bool active = false;
    AudioPerformanceCaptureOptions options;
    std::string capturedAtIso;
    std::chrono::steady_clock::time_point startedAt;
    MixEngine::RealtimeDiagnosticsSnapshot startSnapshot;
    bool previousDiagnosticsEnabled = false;
    int64_t startRawPositionSamples = 0;
    int64_t startPresentationPositionSamples = 0;
    bool startPlaying = false;
    uint64_t minTimingSequence = 1;
    uint64_t accumulatedTimingSampleCount = 0;
    uint64_t accumulatorOverflowDrops = 0;
};

// ─────────────────────────────────────────────────────────────────────────────
// Global engine state — extern declarations, defined in XlethSvcGlobals.cpp.
// Declaration order below matches the original definition order; the .cpp keeps
// that order too (static destruction backstop — see file header).
// ─────────────────────────────────────────────────────────────────────────────

// JUCE must be initialised before any JUCE objects are created and torn down
// last. ScopedJuceInitialiser_GUI also initialises COM on Windows which is
// required by JUCE's Windows audio device layer.
extern std::unique_ptr<juce::ScopedJuceInitialiser_GUI> juceInit;

extern std::unique_ptr<SampleBank>  sampleBank;
extern std::unique_ptr<AudioEngine> audioEngine;
extern std::unique_ptr<FrameCache>  frameCache;

// Waveform mipmap cache — multi-resolution peak data for waveform display.
// Keyed by std::to_string(sampleBankId). Accessible from host bridge bindings.
extern std::unique_ptr<WaveformMipmapCache> g_mipmapCache;

// Phase 1 — data model, undo, project
extern std::unique_ptr<Timeline>       g_timeline;
extern std::unique_ptr<UndoManager>    g_undoManager;
extern std::unique_ptr<ProjectManager> g_projectManager;

// Phase 1B — FrameServer (fast frame extraction for SamplePicker)
extern std::unique_ptr<FrameServer> g_frameServer;

// Decoder ownership uses std::deque so that push_back never invalidates
// existing element pointers. SyncManager holds std::vector<VideoDecoder*>&
// (a reference to the vector itself), which remains valid across push_backs.
extern std::deque<std::unique_ptr<VideoDecoder>> decoderOwner;
extern std::vector<VideoDecoder*>                decoderPtrs;

// Per-region proxy decoders. Keyed by regionId.
//   regionDecoderOwner : actual ownership (unique_ptr); erase == clean close.
//   regionDecoderPtrs  : raw-pointer view shared with SyncManager by ref.
// Both must be mutated together under syncEventsMutex so SyncManager never
// sees a raw pointer whose owning unique_ptr has been destroyed.
extern std::unordered_map<int, std::unique_ptr<VideoDecoder>> regionDecoderOwner;
extern std::unordered_map<int, VideoDecoder*>                 regionDecoderPtrs;

extern std::unique_ptr<ProxyManager> g_proxyManager;

extern std::unique_ptr<SyncManager> syncManager;

// ── Video thread ──────────────────────────────────────────────────────────
extern std::thread       videoThread;
extern std::atomic<bool> videoRunning;
extern std::atomic<uint64_t> videoThreadCompletedTicks;
extern std::atomic<bool> g_previewDirty;  // set by bridge functions to force a re-render while stopped
extern std::atomic<uint64_t> g_latestStoppedPreviewSeq;
extern std::atomic<uint64_t> g_pendingStoppedPreviewSeq;
extern std::atomic<uint64_t> g_publishedStoppedPreviewSeq;
extern std::atomic<uint64_t> g_discardedStoppedPreviewSeq;
extern std::atomic<int64_t>  g_pendingStoppedPreviewSample;

// Guards both SyncManager event mutations (main thread) and videoTick() calls
// (video thread) to prevent data races on events_ / driftSamples_ etc.
extern std::mutex syncEventsMutex;

// ── Frame output (double-buffered, lock-free) ─────────────────────────────
extern FrameOutput frameOutput;

// ── GPU device (D3D11 — adapter enum + device for decode/composite) ──────
extern std::unique_ptr<GpuDeviceManager> g_gpuDevice;

// [PreviewUnify] GPU compositor pipeline for real-time preview
extern std::unique_ptr<GridCompositor>     g_previewCompositor;
extern std::unique_ptr<RenderFrameCache>   g_previewRenderCache;
extern std::unique_ptr<RenderVideoDecoder> g_previewRenderDecoder;
extern std::unique_ptr<AnimationManager>   g_previewAnimMgr;
extern std::unique_ptr<FrameCollector>     g_previewCollector;

// [Slice 3b] Freeze cache for the outgoing snapshot during a live-preview
// transition window. Touched only on the video/preview tick under
// g_previewCompositorMutex; invalidated when no window is active or the pin moves.
//
// Declaration-order note (S2 Stage 1): this observes a render target OWNED by
// g_previewCompositor (texA is a NON-owning identity handle, never dereferenced
// for ownership). Declared AFTER g_previewCompositor it is destroyed BEFORE it —
// observer dies before observed, the correct direction. It is a trivially
// destructible POD today so this is a no-op, but NEVER hoist it above
// g_previewCompositor: a future type change (e.g. adding a ComPtr) would
// silently invert into a use-after-free.
extern xleth::TransitionFreezeState        g_previewTransitionFreeze;

extern std::mutex          g_previewCompositorMutex;
extern std::atomic<bool>   g_previewCompositorReady;
extern std::atomic<bool>   g_previewPauseForExport;
extern std::atomic<bool>   g_previewPauseForVisibility;   // Phase 7
// Poster prepass hold (Option B): true while the one-poster-per-source cache is
// still warming AND the user has pressed Play. Holds the VIDEO compositor only —
// the audio transport keeps running, so audio plays while the preview shows the
// UI "Loading sample previews" overlay. Cleared when the prepass drains (see
// drainSourcePosterResults) or when the user skips to live (PosterPrepass_Skip).
extern std::atomic<bool>   g_previewPauseForPosterLoad;

extern PreviewDiagCounters g_previewDiag;

// ── Hardware encoder detection (NVENC/AMF/QSV probing) ──────────────────
extern std::unique_ptr<HwEncoderDetector> g_hwEncoderDetector;

// ── Preview performance settings (workstation-local, NOT per-project) ────────
// Persisted in xleth-settings.json via the existing settings store; the engine
// holds a live copy so it can resize the compositor and set the bypass flag.
extern float g_previewResolutionScale;  // 1.0 / 0.75 / 0.5 / 0.25
extern bool  g_previewEffectsBypass;
// Poster fast-preview mode (PREVIEW-ONLY). When true, grid cells bind each
// source's cached poster frame instead of live-decoding per frame; flip +
// opacity still apply, fullscreen layers stay live. Default ON. Never reaches
// the render/export path (OfflineRenderer calls collectRequests with the
// default posterMode=false).
//
// Threading (pre-existing, do NOT "fix" during the move — that is a behavior
// change): this plain bool is written on B and read on V (2 sites in the V-body)
// without atomicity. Benign, documented, and out of scope for S2.
extern bool  g_previewPosterMode;

// ── Poster prepass counters (Option B warm-on-engage) ────────────────────────
// One base poster per video source on the timeline. Counters are monotonic for
// the CURRENT prepass run and guarded by g_posterPrepassMtx. active=true while a
// run is in flight (used by the Play gate and the UI overlay). Lock order is
// always syncEventsMutex → g_posterPrepassMtx; never the reverse.
//
// S2 Stage 1 notes: g_posterPrepassMtx must stay declared BEFORE the four it
// guards so the mutex outlives them under reverse-order destruction, and the
// cluster must stay contiguous — all five are one invariant-set. Total/Completed
// are plain ints (mutex-guarded, so no new race) that become cross-TU externs
// here; duplicating them per-TU would silently diverge the Play gate from the
// drain and hang the video hold forever (§2c trap 3).
extern std::mutex g_posterPrepassMtx;
extern int        g_posterPrepassTotal;      // cell thumbnails enqueued this run
extern int        g_posterPrepassCompleted;  // results installed this run (ok OR fail)
extern std::atomic<bool> g_posterPrepassActive;
// Exact set of PER-CELL (source,bucket) thumbnail keys THIS run is still waiting
// on (thumbKey()). Poster mode shows each grid cell its OWN representative frame,
// so the warm-up hold must wait for every distinct cell thumbnail across the
// whole timeline — not one frame per source. Tracking the exact key set (rather
// than counting results) keeps the per-tick self-heal — which can also enqueue
// cell thumbnails — from overshooting completed and releasing the video hold
// early. Base posters are a per-source fallback and are NOT tracked here.
// Guarded by g_posterPrepassMtx.
extern std::unordered_set<long long> g_posterPrepassPending;

// Whole-source preview-proxy target height (PREVIEW-ONLY). On first preview use
// of a source, the engine builds ONE small all-intra proxy of the ENTIRE source
// downscaled to min(this, srcHeight) (aspect-preserved). 720 is the default;
// 480 is exposed for very weak machines (smaller files, even cheaper decode).
// Changing it (Timeline_SetPreviewProxyHeight) re-resolves every source against
// the new height so a fresh proxy is built/engaged at the new size.
extern int   g_previewProxyTargetHeight;

extern std::unordered_map<int, ScalerEntry> scalerCache;

extern std::mutex    statsMutex;
extern StatsSnapshot statsSnapshot;

extern std::mutex                   g_exportStateMutex;
extern ExportProgressSnapshot       g_exportProgress;
extern std::atomic<bool>            g_exportCancel;
extern std::atomic<bool>            g_exportRunning;
extern std::unique_ptr<std::thread> g_exportThread;

// ── Video export (offline A/V render via OfflineRenderer) ───────────────
extern std::unique_ptr<OfflineRenderer> g_videoRenderer;
extern std::atomic<bool>                g_audioSuspendedForExport;

// ── Audio-health diagnostic trace statics (were file-scope anon-ns) ────────
extern std::mutex   g_audioTraceMutex;
extern std::ofstream g_audioTraceFile;
extern bool         g_audioTraceInit;

extern std::thread       g_audioHealthThread;
extern std::atomic<bool> g_audioHealthStop;

// ── Lazy poster/proxy/thumbnail self-heal sets (were file-scope statics) ───
// Threading (corrected in S2 Stage 1 — the plan's §2b thread column previously
// read "B only", which was wrong at its own baseline): these are touched on
// BOTH B and V. The enqueue/drain entry points (drainSourcePosterResults,
// maybeEnqueueSourcePoster, maybeEnqueueCellThumbnail,
// maybeEnqueueSourcePreviewProxy) are all called from videoThreadBody as well as
// from bridge handlers. What makes that safe is the lock discipline below —
// "touched only while holding syncEventsMutex" — which was and remains correct.
//
// Sources whose poster extraction has already been attempted this session
// (success OR failure). Prevents the video thread from re-spawning an ffmpeg
// poster job every tick for a source whose poster cannot be produced (e.g.
// ffmpeg CLI missing). Touched only while holding syncEventsMutex.
extern std::unordered_set<int> g_posterEnqueued;

// Regions for which a preview-time proxy self-heal was already attempted this
// session. The edit-time trigger (maybeEnqueueRegionProxy on clip CRUD) only
// fires for newly placed cells; projects opened with existing cells never had
// it called. This guard lets the video loop attempt a proxy exactly once per
// active region without re-statting the disk every tick. Touched only while
// holding syncEventsMutex.
extern std::unordered_set<int> g_proxyEnqueuedRegions;

// ── Failed-generation backoff (Fix 1) ─────────────────────────────────────────
// Generation can legitimately fail for a source (e.g. a codec this build cannot
// decode even with hwaccel). Without a cap, ProxyManager would keep enqueuing
// ~one job per active region/cell every session and the workers would churn
// forever for nothing, making playback WORSE than plain live decode. So we count
// consecutive poster/proxy/thumbnail failures per source and, after
// kGenMaxFailures, disable ALL further generation for that source this session.
// Any success resets the streak. Touched only while holding syncEventsMutex.
inline constexpr int kGenMaxFailures = 2;
extern std::unordered_map<int,int> g_genFailCount;   // sourceId -> consecutive failures
extern std::unordered_set<int>     g_genDisabled;     // sources with generation off

// One attempt per (sourceId, frameBucket) per session for per-offset thumbnails
// (Fix 2). Mirrors g_posterEnqueued but keyed by source+bucket. Touched only
// while holding syncEventsMutex.
extern std::unordered_set<long long> g_thumbnailEnqueued;

// One whole-source preview-proxy build attempt per source per session. Mirrors
// g_posterEnqueued. Cleared when the target height changes (so the new size is
// rebuilt) and on project new/load. Touched only while holding syncEventsMutex.
extern std::unordered_set<int> g_sourcePreviewEnqueued;

// ── Audio performance capture statics (were anon-ns; self-contained) ───────
extern std::mutex g_audioPerformanceCaptureMutex;
extern AudioPerformanceCaptureState g_audioPerformanceCapture;
extern nlohmann::json g_lastAudioPerformanceCaptureReport;
extern std::string g_lastAudioPerformanceCaptureJsonPath;
extern std::string g_lastAudioPerformanceCaptureMarkdownPath;
extern std::thread g_audioPerformanceCaptureDrainThread;
extern std::atomic<bool> g_audioPerformanceCaptureDrainStop;

// ── Main window HWND (for VST editor parenting) ───────────────────────────────
// Stored here so Audio_SetMainWindowHandle can also push the value into the
// MixEngine; MixEngine then passes it to EditorProcessCoordinator so each
// editor-host.exe can call SetWindowLongPtrW(GWLP_HWNDPARENT).
#ifdef _WIN32
extern std::atomic<uintptr_t> g_mainXlethHwnd;
#endif

}  // namespace xleth::svc
