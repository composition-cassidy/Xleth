// XlethAddon.cpp — Node-API bridge for the Xleth engine  (Phase 1)
//
// Uses node-addon-api (C++ wrapper around raw N-API).
// NAPI_DISABLE_CPP_EXCEPTIONS is defined via CMake; functions that can fail
// call Napi::Error::New(env, msg).ThrowAsJavaScriptException() and return early.
//
// Threading model:
//   Node.js main thread  — all N-API exported functions
//   JUCE audio RT thread — AudioEngine callback (no N-API calls)
//   Video thread         — SyncManager::videoTick at ~60 Hz (no N-API calls)
//
// Phase 1 additions:
//   • Timeline data model (tracks, clips, regions, sources)
//   • UndoManager — ALL mutations go through execute(Command)
//   • ProjectManager — create / save / load project
//   • MixEngine wired to Timeline + peak meters
//   • Transport seek

#include <napi.h>

// Engine headers — XlethEngineCore only (no VideoCompositor/GLFW/GLEW/OpenGL)
#include "AudioEngine.h"
#include "AudioScheduler.h"
#include "FrameCache.h"
#include "ProxyTranscoder.h"
#include "SampleBank.h"
#include "audio/SampleProcessor.h"
#include "SyncManager.h"
#include "render/ArpVideoExpander.h"
#include "render/VideoFlipApplier.h"
#include "Transport.h"
#include "VideoDecoder.h"
#include "video/FrameOutput.h"
#include "video/FrameServer.h"

// Phase 1 — model, commands, project
#include "midi/MidiImporter.h"
#include "model/Timeline.h"
#include "model/TimelineTypes.h"
#include "commands/ImportMidiCommand.h"
#include "commands/UndoManager.h"
#include "commands/TimelineCommands.h"
#include "commands/QuantizeClipsBatchCommand.h"
#include "project/ProjectManager.h"
#include "project/ProxyManager.h"
#include "export/AudioExporter.h"
#include "audio/WaveformMipmap.h"
#include "audio/XlethEQEffect.h"
#include "audio/XlethWaveshaperEffect.h"
#include "audio/SmartBalanceEffect.h"
#include "audio/PluginRegistry.h"
#include "audio/viz/DynamicsVizFrame.h"
#include "audio/viz/DynamicsVizCollector.h"
#include "render/GpuDeviceManager.h"
#include "render/HwEncoderDetector.h"
#include "render/OfflineRenderer.h"
// [PreviewUnify] GPU compositor pipeline for unified preview
#include "render/GridCompositor.h"
#include "render/FrameCollector.h"
#include "render/FrameCache.h"          // RenderFrameCache
#include "render/RenderVideoDecoder.h"
#include "render/AnimationManager.h"
#include "render/RenderClock.h"
#include "export/FFmpegMuxer.h"       // ExportSettings

#include "XlethDebug.h"

#ifdef _WIN32
#  ifndef NOMINMAX
#    define NOMINMAX
#  endif
#  ifndef WIN32_LEAN_AND_MEAN
#    define WIN32_LEAN_AND_MEAN
#  endif
#  include <windows.h>
#endif

#include <algorithm>
#include <atomic>
#include <chrono>
#include <cstdio>
#include <cstring>
#include <deque>
#include <filesystem>
#include <fstream>
#include <memory>
#include <mutex>
#include <string>
#include <thread>
#include <unordered_map>
#include <unordered_set>
#include <vector>

#include <nlohmann/json.hpp>

extern "C" {
#include <libavformat/avformat.h>
#include <libavutil/avutil.h>
#include <libswscale/swscale.h>
#include <libavutil/pixfmt.h>
}

// ─────────────────────────────────────────────────────────────────────────────
// IPC slow-call diagnostic
// ─────────────────────────────────────────────────────────────────────────────
// The N-API main thread is also the JUCE message thread.  Any N-API call that
// blocks this thread for >5ms delays JUCE timer/paint dispatch for VST editors.
// At 30+ IPC calls/second (peak meter loop) even 5ms stalls add up and can cause
// Win32 to mark the Electron main window as "Not Responding".
//
// IPC_TIME_START / IPC_TIME_END bracket a function's body.  If the call exceeds
// IPC_SLOW_THRESHOLD_US microseconds, a [IPC-SLOW] line is printed to stderr so
// you can identify which function is the bottleneck in production.
#ifdef XLETH_DEBUG
  #define IPC_SLOW_THRESHOLD_US  10000   // 10 ms
  #define IPC_TIME_START \
    const auto _ipc_t0 = std::chrono::steady_clock::now()
  #define IPC_TIME_END(name) \
    do { \
        const auto _ipc_dt = std::chrono::duration_cast<std::chrono::microseconds>( \
            std::chrono::steady_clock::now() - _ipc_t0).count(); \
        if (_ipc_dt > IPC_SLOW_THRESHOLD_US) \
            std::fprintf(stderr, "[IPC-SLOW] %s took %lld us\n", \
                         (name), static_cast<long long>(_ipc_dt)); \
    } while(0)
  // IPC_GAP_CHECK(fname) — tracks wall-clock gaps between successive calls to
  // the same N-API function.  A gap > 1 s means the N-API thread (= JUCE
  // message thread) was blocked for that interval between polls.
  #define IPC_GAP_CHECK(fname) \
    do { \
        static auto _gap_last = std::chrono::steady_clock::now(); \
        auto _gap_now = std::chrono::steady_clock::now(); \
        auto _gap_ms  = std::chrono::duration_cast<std::chrono::milliseconds>( \
                          _gap_now - _gap_last).count(); \
        _gap_last = _gap_now; \
        if (_gap_ms > 1000) \
            std::fprintf(stderr, \
                "[MsgThread] Gap of %lldms between calls to %s — N-API thread was blocked\n", \
                (long long)_gap_ms, (fname)); \
    } while(0)
#else
  #define IPC_TIME_START      do {} while(0)
  #define IPC_TIME_END(name)  do {} while(0)
  #define IPC_GAP_CHECK(fname) do {} while(0)
#endif

// Forward declaration — defined near the plugin scanner code below.
static juce::File getThisModuleDir();

// ─────────────────────────────────────────────────────────────────────────────
// Global engine state
// ─────────────────────────────────────────────────────────────────────────────
namespace {

// JUCE must be initialised before any JUCE objects are created and torn down
// last. ScopedJuceInitialiser_GUI also initialises COM on Windows which is
// required by JUCE's Windows audio device layer.
std::unique_ptr<juce::ScopedJuceInitialiser_GUI> juceInit;

std::unique_ptr<SampleBank>  sampleBank;
std::unique_ptr<AudioEngine> audioEngine;
std::unique_ptr<FrameCache>  frameCache;

// Waveform mipmap cache — multi-resolution peak data for waveform display.
// Keyed by std::to_string(sampleBankId). Accessible from N-API bindings.
std::unique_ptr<WaveformMipmapCache> g_mipmapCache;

// Phase 1 — data model, undo, project
std::unique_ptr<Timeline>       g_timeline;
std::unique_ptr<UndoManager>    g_undoManager;
std::unique_ptr<ProjectManager> g_projectManager;

// Phase 1B — FrameServer (fast frame extraction for SamplePicker)
std::unique_ptr<FrameServer> g_frameServer;

// Phase 0: no GPU compositor in the Electron process.
// SyncManager accepts nullptr — it still decodes frames into FrameCache
// but skips all GL upload/render calls (XLETH_CORE_ONLY compile guard).

// Decoder ownership uses std::deque so that push_back never invalidates
// existing element pointers. SyncManager holds std::vector<VideoDecoder*>&
// (a reference to the vector itself), which remains valid across push_backs.
std::deque<std::unique_ptr<VideoDecoder>> decoderOwner;
std::vector<VideoDecoder*>                decoderPtrs;

// Per-region proxy decoders. Keyed by regionId.
//   regionDecoderOwner : actual ownership (unique_ptr); erase == clean close.
//   regionDecoderPtrs  : raw-pointer view shared with SyncManager by ref.
// Both must be mutated together under syncEventsMutex so SyncManager never
// sees a raw pointer whose owning unique_ptr has been destroyed.
std::unordered_map<int, std::unique_ptr<VideoDecoder>> regionDecoderOwner;
std::unordered_map<int, VideoDecoder*>                 regionDecoderPtrs;

std::unique_ptr<ProxyManager> g_proxyManager;

std::unique_ptr<SyncManager> syncManager;

// ── Video thread ──────────────────────────────────────────────────────────
std::thread       videoThread;
std::atomic<bool> videoRunning{false};
std::atomic<bool> g_previewDirty{false};  // set by bridge functions to force a re-render while stopped

// Guards both SyncManager event mutations (main thread) and videoTick() calls
// (video thread) to prevent data races on events_ / driftSamples_ etc.
std::mutex syncEventsMutex;

// ── Frame output (double-buffered, lock-free) ─────────────────────────────
FrameOutput frameOutput;

// ── GPU device (D3D11 — adapter enum + device for decode/composite) ──────
std::unique_ptr<GpuDeviceManager> g_gpuDevice;

// [PreviewUnify] GPU compositor pipeline for real-time preview
std::unique_ptr<GridCompositor>     g_previewCompositor;
std::unique_ptr<RenderFrameCache>   g_previewRenderCache;
std::unique_ptr<RenderVideoDecoder> g_previewRenderDecoder;
std::unique_ptr<AnimationManager>   g_previewAnimMgr;
std::unique_ptr<FrameCollector>     g_previewCollector;

std::mutex          g_previewCompositorMutex;
std::atomic<bool>   g_previewCompositorReady{false};
std::atomic<bool>   g_previewPauseForExport{false};
std::atomic<bool>   g_previewPauseForVisibility{false};   // Phase 7

// ── Visual preview diagnostic counters ───────────────────────────────────────
// Lightweight instrumentation to support Settings → Graphics → Export Visual
// Preview Diagnostic Log. Read by Diag_GetVisualPreviewDiagnostic on the JS
// thread, written by the video thread; all counters are std::atomic.
struct PreviewDiagCounters {
    std::atomic<uint64_t> videoTickCount        {0};
    std::atomic<uint64_t> compositorPathEntered {0};
    std::atomic<uint64_t> compositeFrameCount   {0};
    std::atomic<uint64_t> readbackValidCount    {0};
    std::atomic<uint64_t> readbackInvalidCount  {0};
    std::atomic<uint64_t> canvasCopyCount       {0};
    std::atomic<uint64_t> blackFrameCount       {0};
    std::atomic<uint64_t> initInitFailures      {0};
    std::atomic<int32_t>  lastReadbackHRESULT   {0};  // S_OK(0) or failing HRESULT
    std::atomic<int>      lastReadbackWidth     {0};
    std::atomic<int>      lastReadbackHeight    {0};
    std::atomic<int>      lastRequestCount      {0};
    std::atomic<int>      lastDecodeMissCount   {0};
    std::atomic<int>      lastLayoutColumns     {0};
    std::atomic<int>      lastLayoutRows        {0};
    std::atomic<int>      lastCompositorWidth   {0};
    std::atomic<int>      lastCompositorHeight  {0};
    std::atomic<int>      lastInitW             {0};
    std::atomic<int>      lastInitH             {0};
};
PreviewDiagCounters g_previewDiag;

// ── Hardware encoder detection (NVENC/AMF/QSV probing) ──────────────────
std::unique_ptr<HwEncoderDetector> g_hwEncoderDetector;

// ── CPU YUV420P → RGBA conversion + compositing ─────────────────────────

// Output canvas size (fixed)
constexpr int CANVAS_W = 960;
constexpr int CANVAS_H = 540;

// ── Preview performance settings (workstation-local, NOT per-project) ────────
// Persisted in xleth-settings.json via the existing settings store; the engine
// holds a live copy so it can resize the compositor and set the bypass flag.
static float g_previewResolutionScale = 1.0f;  // 1.0 / 0.75 / 0.5 / 0.25
static bool  g_previewEffectsBypass   = false;

// Per-source scaler cache (source dimensions may differ)
struct ScalerEntry {
    SwsContext* ctx = nullptr;
    int srcW = 0, srcH = 0;
    int dstW = 0, dstH = 0;
};
std::unordered_map<int, ScalerEntry> scalerCache;

// Convert a YUV CachedFrame and blit it onto the canvas at (dx,dy,dw,dh).
// opacity < 1.0f performs per-pixel alpha blending into the existing canvas;
// opacity >= 1.0f uses memcpy (fast path).
void blitYuvToCanvas(std::vector<uint8_t>& canvas,
                     const CachedFrame& cf,
                     int dx, int dy, int dw, int dh,
                     int canvasW,
                     float opacity = 1.0f,
                     bool  flipX   = false,
                     bool  flipY   = false)
{
    if (dw <= 0 || dh <= 0) return;

    int key = cf.width * 10000 + cf.height * 100 + dw * 10 + dh;

    auto& sc = scalerCache[key];
    if (!sc.ctx || sc.srcW != cf.width || sc.srcH != cf.height || sc.dstW != dw || sc.dstH != dh) {
        if (sc.ctx) sws_freeContext(sc.ctx);
        sc.ctx = sws_getContext(cf.width, cf.height, AV_PIX_FMT_YUV420P,
                                dw, dh, AV_PIX_FMT_RGBA,
                                SWS_BILINEAR, nullptr, nullptr, nullptr);
        sc.srcW = cf.width; sc.srcH = cf.height;
        sc.dstW = dw;       sc.dstH = dh;
    }
    if (!sc.ctx) return;

    const uint8_t* srcSlice[3] = { cf.yPlane.data(), cf.uPlane.data(), cf.vPlane.data() };
    int srcStride[3] = { cf.yStride, cf.uStride, cf.vStride };

    // Decode into a temp buffer at target cell size
    std::vector<uint8_t> cellBuf(static_cast<size_t>(dw) * dh * 4);
    uint8_t* dstSlice[1] = { cellBuf.data() };
    int dstStride[1] = { dw * 4 };
    sws_scale(sc.ctx, srcSlice, srcStride, 0, cf.height, dstSlice, dstStride);

    const bool blend = (opacity < 0.999f);
    const int  alpha = blend ? static_cast<int>(opacity * 256.0f + 0.5f) : 256;

    const int invA = 256 - alpha;

    // Blit onto canvas. flipX/flipY mirror the source via index remap — no
    // extra buffers, no extra memcpy.
    for (int row = 0; row < dh; ++row) {
        int cy = dy + row;
        if (cy < 0 || cy >= CANVAS_H) continue;
        if (dx < 0) continue;
        int copyW = std::min(dw, canvasW - dx);
        if (copyW <= 0) continue;
        const int srcRow = flipY ? (dh - 1 - row) : row;
        int dstOff = (cy * canvasW + dx) * 4;

        if (!flipX) {
            // Contiguous source walk — memcpy fast path or per-pixel blend.
            int srcOff = srcRow * dw * 4;
            if (!blend) {
                std::memcpy(&canvas[static_cast<size_t>(dstOff)],
                            &cellBuf[static_cast<size_t>(srcOff)],
                            static_cast<size_t>(copyW) * 4);
            } else {
                uint8_t*       dp = &canvas[static_cast<size_t>(dstOff)];
                const uint8_t* sp = &cellBuf[static_cast<size_t>(srcOff)];
                for (int px = 0; px < copyW; ++px) {
                    dp[0] = static_cast<uint8_t>((sp[0] * alpha + dp[0] * invA) >> 8);
                    dp[1] = static_cast<uint8_t>((sp[1] * alpha + dp[1] * invA) >> 8);
                    dp[2] = static_cast<uint8_t>((sp[2] * alpha + dp[2] * invA) >> 8);
                    // dp[3] (alpha) left as-is (canvas is opaque RGBA)
                    dp += 4; sp += 4;
                }
            }
        } else {
            // flipX: walk source right-to-left. Per-pixel inner loop either way.
            uint8_t* dp = &canvas[static_cast<size_t>(dstOff)];
            for (int px = 0; px < copyW; ++px) {
                const int srcX = dw - 1 - px;
                const uint8_t* sp = &cellBuf[static_cast<size_t>((srcRow * dw + srcX) * 4)];
                if (!blend) {
                    dp[0] = sp[0]; dp[1] = sp[1]; dp[2] = sp[2]; dp[3] = sp[3];
                } else {
                    dp[0] = static_cast<uint8_t>((sp[0] * alpha + dp[0] * invA) >> 8);
                    dp[1] = static_cast<uint8_t>((sp[1] * alpha + dp[1] * invA) >> 8);
                    dp[2] = static_cast<uint8_t>((sp[2] * alpha + dp[2] * invA) >> 8);
                }
                dp += 4;
            }
        }
    }
}

// Find the active VideoEvent on the given track at beatPos (mute-aware).
// Returns nullptr when no event is active, or when the track is muted.
// If multiple events on the same track are active (shouldn't happen with
// non-overlapping clips, but be defensive), the latest-starting one wins.
static const VideoEvent* findActiveEventOnTrack(
    const std::vector<VideoEvent>& events, int trackId, double beatPos)
{
    if (trackId < 0 || !g_timeline) return nullptr;
    const TrackInfo* track = g_timeline->getTrack(trackId);
    if (track && track->muted) return nullptr;

    const VideoEvent* best = nullptr;
    for (const auto& ev : events) {
        if (ev.trackId != trackId) continue;
        if (beatPos < ev.startBeat) continue;
        if (beatPos >= ev.startBeat + ev.durationBeats) continue;
        if (!best || ev.startBeat > best->startBeat) best = &ev;
    }
    return best;
}

// Fetch the cached decoded frame for an event at beatPos. Returns nullptr
// on any failure (no decoder, no cache entry). Does not decode — relies on
// syncManager->videoTick() having already populated the cache this tick.
static const CachedFrame* getCachedFrameForEvent(
    const VideoEvent& ev, double beatPos, double bpm,
    FrameKey* outKey = nullptr)
{
    if (ev.sourceId < 0 ||
        static_cast<size_t>(ev.sourceId) >= decoderPtrs.size()) return nullptr;
    VideoDecoder* dec = decoderPtrs[static_cast<size_t>(ev.sourceId)];
    if (!dec || !dec->isOpen()) return nullptr;

    const double beatsSince = beatPos - ev.startBeat;
    const double secsSince  = beatsSince * (60.0 / bpm);
    const double sourceTime = ev.sourceStartTime + secsSince;
    const int    targetFrame = dec->timeToFrame(sourceTime);

    FrameKey key = { ev.sourceId, targetFrame };
    if (outKey) *outKey = key;
    return frameCache ? frameCache->get(key) : nullptr;
}

// Look up a cached frame at an absolute source time (seconds).
// Used for hold-last-frame clamping when the note sustains past trim end.
static const CachedFrame* getCachedFrameAtSourceTime(
    int sourceId, double sourceTimeSec,
    FrameKey* outKey = nullptr)
{
    if (sourceId < 0 ||
        static_cast<size_t>(sourceId) >= decoderPtrs.size()) return nullptr;
    VideoDecoder* dec = decoderPtrs[static_cast<size_t>(sourceId)];
    if (!dec || !dec->isOpen()) return nullptr;
    const int targetFrame = dec->timeToFrame(sourceTimeSec);
    FrameKey key = { sourceId, targetFrame };
    if (outKey) *outKey = key;
    return frameCache ? frameCache->get(key) : nullptr;
}

// ── Sync stats snapshot ───────────────────────────────────────────────────
struct StatsSnapshot {
    double avgDriftMs  = 0.0;
    double maxDriftMs  = 0.0;
    int    frameDrops  = 0;
    double cacheHitRate = 0.0;
};
std::mutex    statsMutex;
StatsSnapshot statsSnapshot;

// ── Audio export state (accessed from bridge thread + export worker thread) ─
struct ExportProgressSnapshot {
    bool        running    = false;
    float       percent    = 0.0f;
    std::string phase;         // "rendering" | "encoding" | "done" | "error" | "cancelled" | ""
    std::string outputPath;
    std::string error;
};
std::mutex                   g_exportStateMutex;
ExportProgressSnapshot       g_exportProgress;
std::atomic<bool>            g_exportCancel{false};
std::atomic<bool>            g_exportRunning{false};
std::unique_ptr<std::thread> g_exportThread;

// ── Video export (offline A/V render via OfflineRenderer) ───────────────
std::unique_ptr<OfflineRenderer> g_videoRenderer;
std::atomic<bool>                g_audioSuspendedForExport{false};

} // anonymous namespace

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

static bool isInitialised() { return audioEngine != nullptr; }

// Rebuild every per-{track,region} sampler referenced by a PatternBlock on
// the given track. Pattern tracks no longer bind to a single region — samplers
// are per-{trackId, regionId} pair, one for each unique region used by blocks
// on that track. No-op if audioEngine/timeline are null or track is missing.
static void refreshSamplerForTrack(int trackId)
{
    if (!audioEngine || !g_timeline) return;
    auto& mix = audioEngine->getMixEngine();
    const TrackInfo* t = g_timeline->getTrack(trackId);
    if (t == nullptr || t->type != TrackInfo::Type::Pattern) {
        mix.unloadSamplersForTrack(trackId);
        return;
    }
    // Walk every block on this track, load a sampler per unique regionId.
    // Delegating to rebuildAllSamplers keeps things consistent with any
    // state elsewhere in the timeline (prune + reload).
    mix.rebuildAllSamplers();
}

// Refresh every sampler pair using this region, plus the region's preview
// sampler. Called after region settings (ADSR/loop/root) change so every
// block sharing the region picks up the new settings.
static void refreshSamplerForRegion(int regionId)
{
    if (!audioEngine || !g_timeline) return;
    auto& mix = audioEngine->getMixEngine();

    // Preview sampler (piano roll audition path).
    const SampleRegion* r = g_timeline->getRegion(regionId);
    if (r) mix.ensurePreviewSampler(regionId);
    else   mix.unloadPreviewSampler(regionId);

    // Reload every {trackId, regionId} sampler pair that uses this region.
    // rebuildAllSamplers prunes stale pairs and recreates every needed one
    // from scratch — settings are re-read from the region in the process.
    mix.rebuildAllSamplers();
}

// Look up a pattern's region and refresh every sampler pair bound to it.
// Used after pattern-level mutations (including Pattern.regionId changes).
static void refreshSamplerForPattern(int patternId)
{
    if (!audioEngine || !g_timeline) return;
    const Pattern* p = g_timeline->getPattern(patternId);
    if (p == nullptr) return;
    refreshSamplerForRegion(p->regionId);
}

// Unload every sampler pair bound to this region, plus its preview sampler.
// Used when a region is deleted outright.
static void unloadSamplersForRegion(int regionId)
{
    if (!audioEngine || !g_timeline) return;
    auto& mix = audioEngine->getMixEngine();
    mix.unloadPreviewSampler(regionId);
    mix.unloadSamplersForRegion(regionId);
}

// Rebuild every pattern's Sampler. Used after project_load, undo, redo.
static void rebuildAllSamplers()
{
    if (!audioEngine) return;
    audioEngine->getMixEngine().rebuildAllSamplers();
}

// Invalidate and re-submit render cache for every clip that needs processing.
// Call after project_load, undo, redo, or any clip-params change.
static void refreshAllClipCaches()
{
    if (!audioEngine || !g_timeline) return;
    auto& mix = audioEngine->getMixEngine();
    for (const Clip* c : g_timeline->getAllClips()) {
        if (!c) continue;
        const bool needs = (c->pitchOffset != 0 || c->pitchOffsetCents != 0
                         || c->reversed || c->stretchRatio != 1.0);
        if (needs)
            mix.invalidateClipCache(c->id, "refreshAllClipCaches");
    }
}

// ── WORLD processing indicator ───────────────────────────────────────────────

// cache_getWorldActiveJobs() → number[]
// Returns the clip IDs currently being processed by a WORLD render job.
// Called by the main-process poll (100ms interval) to drive the UI spinner.
Napi::Value Cache_GetWorldActiveJobIds(const Napi::CallbackInfo& info)
{
    auto env = info.Env();
    if (!audioEngine) return Napi::Array::New(env, 0);
    const auto ids = audioEngine->getMixEngine().getWorldActiveJobIds();
    auto arr = Napi::Array::New(env, ids.size());
    for (size_t i = 0; i < ids.size(); ++i)
        arr.Set(static_cast<uint32_t>(i), Napi::Number::New(env, ids[i]));
    return arr;
}

// ── Global clip-processing defaults bridge functions ─────────────────────────

// engine_setGlobalStretchMethod(method: number) — 1=PSOLA, 2=Rubber, 3=WSOLA, 4=PhaseVocoder, 5=WORLD
void Engine_SetGlobalStretchMethod(const Napi::CallbackInfo& info)
{
    if (!audioEngine) return;
    int m = (info.Length() > 0 && info[0].IsNumber())
            ? info[0].As<Napi::Number>().Int32Value() : 1;
    audioEngine->getMixEngine().setGlobalStretchMethod(m);
    audioEngine->getMixEngine().invalidateAllGlobalMethodClips();
}

// engine_getGlobalStretchMethod() → number
Napi::Value Engine_GetGlobalStretchMethod(const Napi::CallbackInfo& info)
{
    if (!audioEngine)
        return Napi::Number::New(info.Env(), 1);
    return Napi::Number::New(info.Env(),
        audioEngine->getMixEngine().getGlobalStretchMethod());
}

// engine_setGlobalFormantPreserve(enabled: boolean)
void Engine_SetGlobalFormantPreserve(const Napi::CallbackInfo& info)
{
    if (!audioEngine) return;
    bool v = (info.Length() > 0 && info[0].IsBoolean())
             && info[0].As<Napi::Boolean>().Value();
    audioEngine->getMixEngine().setGlobalFormantPreserve(v);
    audioEngine->getMixEngine().invalidateAllGlobalMethodClips();
}

// engine_getGlobalFormantPreserve() → boolean
Napi::Value Engine_GetGlobalFormantPreserve(const Napi::CallbackInfo& info)
{
    if (!audioEngine)
        return Napi::Boolean::New(info.Env(), false);
    return Napi::Boolean::New(info.Env(),
        audioEngine->getMixEngine().getGlobalFormantPreserve());
}

// Sync Timeline's declickMs → MixEngine clip boundary fade samples.
// Uses transport sample rate (authoritative live rate; may differ from
// timeline's serialised m_sampleRate if audio device opened at a different rate).
static void syncClipFadeToMixEngine()
{
    if (!g_timeline || !audioEngine) return;
    const double sr = audioEngine->getTransport().getSampleRate();
    const int n = static_cast<int>(std::round(g_timeline->getDeclickMs() * sr / 1000.0));
    audioEngine->getMixEngine().setClipBoundaryFadeSamples(n);
}

// Simple timing wrapper for debug logging
struct BridgeCallLog {
    const char* name;
    std::chrono::high_resolution_clock::time_point t0;
    explicit BridgeCallLog(const char* n) : name(n) {
        t0 = std::chrono::high_resolution_clock::now();
        std::cout << "[Bridge] → " << name << "\n" << std::flush;
    }
    void done(const std::string& summary = "") {
        auto us = std::chrono::duration_cast<std::chrono::microseconds>(
            std::chrono::high_resolution_clock::now() - t0).count();
        std::cout << "[Bridge] ← " << name
                  << (summary.empty() ? "" : " = " + summary)
                  << " (" << us << "µs)\n" << std::flush;
    }
};

// Ensure a VideoDecoder is open for the given source and slot it into
// decoderPtrs[id]. Opens the proxy if ready, else the original file.
// If the original was opened, spawns a detached watchdog that swaps in
// the proxy decoder when the transcode finishes. Does NOT add any
// VideoEvent — clip-driven events are rebuilt separately at play-time.
// Safe to call from any thread — takes syncEventsMutex internally.
static void ensureSourceDecoder(int sourceId) {
    if (!g_timeline || !audioEngine || !syncManager) return;
    SourceMedia* src = g_timeline->getSourceMutable(sourceId);
    if (!src || !src->hasVideo) return;

    const bool useProxy = src->proxyReady && !src->proxyPath.empty();
    const std::string openPath = useProxy ? src->proxyPath : src->filePath;

    auto decoder = std::make_unique<VideoDecoder>();
    if (!decoder->open(openPath)) {
        std::cerr << "[Bridge] ERROR: could not open video decoder: "
                  << openPath << "\n" << std::flush;
        return;
    }

    {
        std::lock_guard<std::mutex> lock(syncEventsMutex);

        if (static_cast<size_t>(sourceId) >= decoderPtrs.size())
            decoderPtrs.resize(static_cast<size_t>(sourceId) + 1, nullptr);
        if (decoderPtrs[static_cast<size_t>(sourceId)])
            decoderPtrs[static_cast<size_t>(sourceId)]->close();
        decoderPtrs[static_cast<size_t>(sourceId)] = decoder.get();
        decoderOwner.push_back(std::move(decoder));

        std::cout << "[Bridge] Decoder ready: sourceId=" << sourceId
                  << " proxy=" << (useProxy ? "yes" : "no")
                  << " path=" << openPath << "\n" << std::flush;
    }

}

// Rebuild SyncManager's VideoEvent list from the current clips on the
// timeline. Each clip with a video-backed region produces one fullscreen
// VideoEvent mapping the clip's beat range to the correct source-time.
// Called before transport.play() so edits are reflected on every Play.
// Takes syncEventsMutex internally; safe to call from the main thread.
static void rebuildVideoEventsFromClips() {
    if (!g_timeline || !audioEngine || !syncManager) return;

    std::lock_guard<std::mutex> lock(syncEventsMutex);
    syncManager->clearEvents();

    const double bpm = audioEngine->getTransport().getBPM();
    auto clips = g_timeline->getAllClips();
    int added = 0, skipped = 0;

    int notesAdded = 0, blocksSkipped = 0;

    // Collect every emitted VideoEvent here first so VideoFlipApplier can run
    // a single per-track resolver pass before we hand events to SyncManager.
    std::vector<VideoEvent> eventsBuf;
    eventsBuf.reserve(clips.size() + 256);

    // Group clips by trackId and sort each track's clips by timeline position
    // so globalNoteIndex is assigned in a deterministic per-track order. This
    // mirrors the pattern-note counter below and lets the grid compositor
    // cycle video-flip modes on clip tracks.
    std::unordered_map<int, std::vector<const Clip*>> clipsByTrack;
    for (const Clip* clip : clips) {
        if (!clip) { ++skipped; continue; }
        clipsByTrack[clip->trackId].push_back(clip);
    }
    // Iterate track ids in ascending order for stable cross-run behaviour.
    std::vector<int> clipTrackIds;
    clipTrackIds.reserve(clipsByTrack.size());
    for (const auto& kv : clipsByTrack) clipTrackIds.push_back(kv.first);
    std::sort(clipTrackIds.begin(), clipTrackIds.end());

    for (int trackId : clipTrackIds) {
        auto& trackClips = clipsByTrack[trackId];
        std::sort(trackClips.begin(), trackClips.end(),
            [](const Clip* a, const Clip* b) {
                return a->position.ticks < b->position.ticks;
            });

        int counter = 0;
        int trackSkipped = 0;
        for (const Clip* clip : trackClips) {
            const SampleRegion* region = g_timeline->getRegion(clip->regionId);
            if (!region) { ++skipped; ++trackSkipped; continue; }

            // Mute is no longer checked at rebuild time — the grid compositor
            // honours mute live per tick so toggling mute during playback
            // updates the preview immediately without rebuilding events.

            const SourceMedia* src = g_timeline->getSource(region->sourceId);
            if (!src || !src->hasVideo) { ++skipped; ++trackSkipped; continue; }

            // Require an open decoder slot for this source
            if (region->sourceId < 0
                || static_cast<size_t>(region->sourceId) >= decoderPtrs.size()
                || !decoderPtrs[static_cast<size_t>(region->sourceId)]) {
                ++skipped; ++trackSkipped; continue;
            }

            // Clip.position/duration/regionOffset are TickTime (960 PPQ).
            // region->startTime/endTime are seconds in the source.
            const double startBeat     = clip->position.toBeats();
            const double durationBeats = clip->duration.toBeats();
            const double offsetSec     = clip->regionOffset.toSeconds(bpm);

            // For syllable clips, anchor the source playhead to the syllable's
            // startTime. Syllable times are REGION-RELATIVE seconds (0 = start of
            // region) — this matches how MixEngine treats them at
            // MixEngine.cpp:133-150 (srcBuf is the region-only audio loaded via
            // SampleBank::loadSampleFromSource, so sample 0 == region->startTime).
            // Frames are derived from time inside the decoder — no separate frame
            // storage on Syllable.
            double sourceTime = region->startTime + offsetSec;
            if (clip->syllableIndex >= 0
                && clip->syllableIndex < static_cast<int>(region->syllables.size())) {
                const auto& syl = region->syllables[clip->syllableIndex];
                sourceTime = region->startTime + syl.startTime + offsetSec;
            }

            VideoEvent ev;
            ev.startBeat       = startBeat;
            ev.durationBeats   = durationBeats;
            ev.sourceId        = region->sourceId;
            ev.trackId         = clip->trackId;
            ev.regionId        = clip->regionId;   // route to per-region proxy if ready
            ev.sourceStartTime = sourceTime;
            ev.sourceEndTime   = region->endTime;
            ev.layerIndex      = 0;          // Phase 1: all fullscreen, last-iterated wins
            ev.x = 0.0f; ev.y = 0.0f;
            ev.width = 1.0f; ev.height = 1.0f;
            ev.opacity = 1.0f;
            ev.globalNoteIndex = counter++;
            ev.pitch           = clip->pitchOffset;  // flip-v2 resolver input (spec §1)
            eventsBuf.push_back(ev);
            ++added;
        }
        const TrackInfo* tInfo = g_timeline->getTrack(trackId);
        std::cout << "[Bridge] Clip track " << trackId
                  << " (flipMode=" << (tInfo ? videoFlipConfigToLegacyMode(tInfo->videoFlipConfig) : "?")
                  << "): " << counter << " video events (indices 0.."
                  << (counter > 0 ? counter - 1 : 0) << "), "
                  << trackSkipped << " skipped of " << trackClips.size()
                  << " total clips\n" << std::flush;
    }

    // ── Pattern-block per-note video events ─────────────────────────────────
    // For each PatternBlock on a pattern-type track, emit one VideoEvent per
    // note-instance visible in the block's [offset, offset+duration) window.
    // globalNoteIndex is a per-track counter in timeline order — so the
    // video-flip cycle (HorizontalEven / Clockwise / CounterClockwise) is
    // stable across block boundaries.
    {
        // Collect pattern tracks in deterministic (ascending trackId) order.
        auto allTracks = g_timeline->getAllTracks();
        std::vector<int> patternTrackIds;
        patternTrackIds.reserve(allTracks.size());
        for (const TrackInfo* t : allTracks) {
            if (t && t->type == TrackInfo::Type::Pattern)
                patternTrackIds.push_back(t->id);
        }
        std::sort(patternTrackIds.begin(), patternTrackIds.end());

        auto allBlocks = g_timeline->getAllPatternBlocks();

        for (int trackId : patternTrackIds) {
            // Blocks on this track, sorted by timeline position.
            std::vector<const PatternBlock*> blocks;
            blocks.reserve(allBlocks.size());
            for (const PatternBlock* b : allBlocks) {
                if (b && b->trackId == trackId) blocks.push_back(b);
            }
            std::sort(blocks.begin(), blocks.end(),
                [](const PatternBlock* a, const PatternBlock* b) {
                    return a->position.ticks < b->position.ticks;
                });

            int counter = 0;
            for (const PatternBlock* block : blocks) {
                const Pattern* pattern = g_timeline->getPattern(block->patternId);
                if (!pattern) { ++blocksSkipped; continue; }

                const int64_t patternLenTicks = pattern->length.ticks;
                const int64_t blockDurationTicks = block->duration.ticks;
                if (patternLenTicks <= 0 || blockDurationTicks <= 0) {
                    ++blocksSkipped; continue;
                }

                const SampleRegion* region = g_timeline->getRegion(pattern->regionId);
                if (!region) { ++blocksSkipped; continue; }

                const SourceMedia* src = g_timeline->getSource(region->sourceId);
                const bool hasVideo = src && src->hasVideo
                    && region->sourceId >= 0
                    && static_cast<size_t>(region->sourceId) < decoderPtrs.size()
                    && decoderPtrs[static_cast<size_t>(region->sourceId)];
                if (!hasVideo) { ++blocksSkipped; continue; }

                // Sort notes by position within the pattern (stable iteration order).
                std::vector<const PatternNote*> notes;
                notes.reserve(pattern->notes.size());
                for (const auto& n : pattern->notes) notes.push_back(&n);
                std::sort(notes.begin(), notes.end(),
                    [](const PatternNote* a, const PatternNote* b) {
                        return a->position.ticks < b->position.ticks;
                    });

                const int64_t blockPosTicks    = block->position.ticks;
                const int64_t blockOffsetTicks = block->offset.ticks;
                const int64_t windowStart      = blockOffsetTicks;
                const int64_t windowEnd        = blockOffsetTicks + blockDurationTicks;

                const int64_t firstLoopIdx = windowStart / patternLenTicks;
                int64_t lastLoopIdx        = (windowEnd - 1) / patternLenTicks;

                // When loop is disabled, only iteration 0 emits notes. Any
                // block span past pattern.length renders as empty space.
                // Must match MixEngine.cpp clamp so audio/video stay in sync.
                if (!block->loopEnabled)
                    lastLoopIdx = std::min<int64_t>(lastLoopIdx, 0);

                if (region->arpEnabled) {
                    // Arp-subdivided: simulate arpeggiator in beat-space and
                    // emit one VideoEvent per arp step instead of per note.
                    auto arpEvts = ArpVideoExpander::expandArpVideoEvents(
                        notes, blockPosTicks, blockDurationTicks,
                        patternLenTicks, block->loopEnabled,
                        firstLoopIdx, lastLoopIdx,
                        windowStart, windowEnd,
                        region->arpTempoSync, region->arpDivision,
                        region->arpFreeTimeMs, region->arpGate,
                        region->arpRange, region->arpDirection,
                        bpm,
                        region->sourceId, block->trackId,
                        pattern->regionId,
                        region->startTime, region->endTime,
                        counter);
                    eventsBuf.insert(eventsBuf.end(), arpEvts.begin(), arpEvts.end());
                    notesAdded += static_cast<int>(arpEvts.size());
                } else {
                    for (int64_t L = firstLoopIdx; L <= lastLoopIdx; ++L) {
                        for (const PatternNote* note : notes) {
                            const int64_t tapePos = L * patternLenTicks + note->position.ticks;
                            if (tapePos < windowStart) continue;
                            if (tapePos >= windowEnd) continue;

                            const int64_t timelineTicks = blockPosTicks + (tapePos - windowStart);
                            const double  timelineBeats = static_cast<double>(timelineTicks) / 960.0;
                            const double  durationBeats = static_cast<double>(note->duration.ticks) / 960.0;

                            // Slide notes don't spawn a video cell — they fire a
                            // per-track visual effect (ZPR/Bounce/TVSim) on the
                            // existing cell at their startBeat. Emit a parallel
                            // SlideAnimationEvent and skip the VideoEvent.
                            if (note->isSlide) {
                                SlideAnimationEvent se;
                                se.startBeat     = timelineBeats;
                                se.durationBeats = durationBeats;
                                se.trackId       = block->trackId;
                                se.slideVelocity = note->velocity;
                                se.slideCurveCx  = note->slideCurveCx;
                                se.slideCurveCy  = note->slideCurveCy;
                                syncManager->addSlideEvent(se);
                                continue;
                            }

                            VideoEvent ev;
                            ev.startBeat       = timelineBeats;
                            ev.durationBeats   = durationBeats;
                            ev.sourceId        = region->sourceId;
                            ev.trackId         = block->trackId;
                            ev.regionId        = pattern->regionId;  // route to region proxy
                            ev.sourceStartTime = region->startTime;
                            ev.sourceEndTime   = region->endTime;
                            ev.layerIndex      = 0;
                            ev.x = 0.0f; ev.y = 0.0f;
                            ev.width = 1.0f; ev.height = 1.0f;
                            ev.opacity         = note->velocity;
                            ev.globalNoteIndex = counter++;
                            ev.pitch           = note->pitch;  // flip-v2 resolver input
                            eventsBuf.push_back(ev);
                            ++notesAdded;
                        }
                    }
                }
            }
        }
    }

    // Phase 3: single-pass per-track flip resolution. Runs ONCE for the whole
    // event list — chord detection, mono-only resolver call, and write-back of
    // monoOrdinal / stateIndex / orientation. After this, eventsBuf is the
    // final immutable input for SyncManager's video tick.
    videoFlipApplier::applyAll(eventsBuf, *g_timeline);

    for (const VideoEvent& ev : eventsBuf)
        syncManager->addEvent(ev);

    std::cout << "[Bridge] Rebuilt video events: "
              << added << " clip(s), " << notesAdded << " note(s) added; "
              << skipped << "/" << blocksSkipped << " skipped\n" << std::flush;
}

// ─── Region proxy triggers ───────────────────────────────────────────────────
// Called from Timeline_AddClip / Timeline_AssignTrackToGrid / Timeline_ModifyRegion
// to schedule a per-region DNxHR LB proxy when a quote region lands on a
// normal (non-Chorus/non-Crash) grid cell.

// Drop the current proxy for a region: close the decoder, delete the file,
// clear the metadata. Caller may re-enqueue afterwards if appropriate.
// Takes syncEventsMutex internally for the decoder map mutation.
static void invalidateRegionProxy(int regionId) {
    if (!g_timeline) return;
    SampleRegion* r = g_timeline->getRegionMutable(regionId);
    if (!r) return;

    std::string oldPath;
    {
        std::lock_guard<std::mutex> lk(syncEventsMutex);
        regionDecoderPtrs.erase(regionId);
        regionDecoderOwner.erase(regionId);   // unique_ptr dtor → close()
        oldPath = r->proxyPath;
        r->proxyPath.clear();
        r->proxyReady     = false;
        r->proxyStartTime = 0.0;
        r->proxyEndTime   = 0.0;
    }
    if (!oldPath.empty()) {
        std::error_code ec;
        std::filesystem::remove(oldPath, ec);
    }
}

// Request a proxy transcode for a region that just landed on a
// non-Chorus/non-Crash cell. No-op if:
//   • region has no video source
//   • a usable proxy file is already on disk
// Does NOT take syncEventsMutex — reads region data lock-free and delegates
// the actual enqueue to ProxyManager (which has its own internal mutex).
static void maybeEnqueueRegionProxy(int regionId, int trackId) {
    if (!g_proxyManager || !g_timeline || !g_projectManager) return;

    const GridLayout& gl = g_timeline->getGridLayout();
    if (trackId == gl.chorusTrackId) return;       // chorus always streams original
    if (gl.crashEnabled && trackId == gl.crashTrackId) return;

    SampleRegion* r = g_timeline->getRegionMutable(regionId);
    if (!r) return;

    // If the region already claims a ready proxy but the file is gone (swept
    // away, project folder moved, etc.), treat as not-ready and re-enqueue.
    if (r->proxyReady && !r->proxyPath.empty()) {
        if (std::filesystem::exists(r->proxyPath)) return;   // already good
        r->proxyReady = false;
        r->proxyPath.clear();
    }

    const SourceMedia* src = g_timeline->getSource(r->sourceId);
    if (!src || !src->hasVideo) return;
    if (src->width <= 0 || src->height <= 0) return;

    if ((src->width & 1) || (src->height & 1)) {
        std::cerr << "[Proxy] WARNING: source " << src->id
                  << " has odd dimensions " << src->width << "x" << src->height
                  << " — forcing even target size\n";
    }

    ProxyManager::Request req;
    req.regionId   = regionId;
    req.inputPath  = src->filePath;
    req.outputPath = (std::filesystem::path(g_projectManager->getProxiesDir())
                     / (std::to_string(regionId) + ".mxf")).string();
    req.startTime  = r->startTime;
    req.endTime    = r->endTime;
    req.targetW    = (src->width  / 2) & ~1;   // even dims required by yuv422p
    req.targetH    = (src->height / 2) & ~1;
    g_proxyManager->enqueue(req);
}

// Open a VideoDecoder for a finished proxy and install it into the
// regionDecoderOwner/Ptrs maps; update SampleRegion metadata.
// Split into three phases so we never hold syncEventsMutex while calling
// avformat_open_input (5-50 ms blocking I/O).
static void drainProxyResults() {
    if (!g_proxyManager) return;

    // Phase 1: swap the finished-results vector out under ProxyManager's
    // internal mutex (independent of syncEventsMutex — no contention).
    std::vector<ProxyManager::Result> results = g_proxyManager->drainResults();
    if (results.empty()) return;

    // Phase 2: open decoders WITHOUT syncEventsMutex held.
    struct Ready {
        int                           regionId;
        bool                          ok;
        std::string                   outputPath;
        double                        startTime;
        double                        endTime;
        std::unique_ptr<VideoDecoder> dec;   // nullptr if open failed
    };
    std::vector<Ready> ready;
    ready.reserve(results.size());

    for (auto& r : results) {
        Ready out{ r.regionId, r.ok, r.outputPath, r.startTime, r.endTime, nullptr };
        if (r.ok && !r.outputPath.empty() && std::filesystem::exists(r.outputPath)) {
            auto dec = std::make_unique<VideoDecoder>();
            if (dec->open(r.outputPath)) {
                out.dec = std::move(dec);
            } else {
                std::cerr << "[Proxy] region=" << r.regionId
                          << " — decoder open failed on " << r.outputPath << "\n";
                out.ok = false;
            }
        } else if (r.ok) {
            std::cerr << "[Proxy] region=" << r.regionId
                      << " — reported OK but file missing: " << r.outputPath << "\n";
            out.ok = false;
        }
        ready.push_back(std::move(out));
    }

    // Phase 3: install under syncEventsMutex — pure pointer/map mutations.
    std::lock_guard<std::mutex> lk(syncEventsMutex);
    for (auto& r : ready) {
        SampleRegion* region = g_timeline ? g_timeline->getRegionMutable(r.regionId) : nullptr;
        if (!region) continue;

        // Close any previous region decoder first (invalidation / re-transcode).
        regionDecoderPtrs.erase(r.regionId);
        regionDecoderOwner.erase(r.regionId);   // unique_ptr dtor closes it

        if (!r.ok) {
            region->proxyPath.clear();
            region->proxyReady     = false;
            region->proxyStartTime = 0.0;
            region->proxyEndTime   = 0.0;
            std::cerr << "[Proxy] region=" << r.regionId
                      << " FAILED — will stream from original\n";
            continue;
        }

        region->proxyPath      = r.outputPath;
        region->proxyReady     = true;
        region->proxyStartTime = r.startTime;
        region->proxyEndTime   = r.endTime;

        VideoDecoder* raw = r.dec.get();
        regionDecoderOwner[r.regionId] = std::move(r.dec);
        regionDecoderPtrs[r.regionId]  = raw;
        std::cout << "[Proxy] region=" << r.regionId
                  << " ready -> " << r.outputPath << "\n";
    }
}

// JS↔C++ conversion helpers (model types)

static Napi::Object clipToJs(Napi::Env env, const Clip& c) {
    Napi::Object o = Napi::Object::New(env);
    o.Set("id",                Napi::Number::New(env, c.id));
    o.Set("trackId",           Napi::Number::New(env, c.trackId));
    o.Set("regionId",          Napi::Number::New(env, c.regionId));
    o.Set("positionTicks",     Napi::Number::New(env, static_cast<double>(c.position.ticks)));
    o.Set("durationTicks",     Napi::Number::New(env, static_cast<double>(c.duration.ticks)));
    o.Set("regionOffsetTicks", Napi::Number::New(env, static_cast<double>(c.regionOffset.ticks)));
    o.Set("syllableIndex",     Napi::Number::New(env, c.syllableIndex));
    o.Set("velocity",          Napi::Number::New(env, c.velocity));
    o.Set("pitchOffset",       Napi::Number::New(env, c.pitchOffset));
    o.Set("pitchOffsetCents",  Napi::Number::New(env, c.pitchOffsetCents));
    o.Set("reversed",          Napi::Boolean::New(env, c.reversed));
    o.Set("stretchRatio",      Napi::Number::New(env, c.stretchRatio));
    o.Set("stretchMethod",     Napi::Number::New(env, static_cast<int>(c.stretchMethod)));
    o.Set("formantPreserve",   Napi::Boolean::New(env, c.formantPreserve));
    float fadeInPercent = c.fadeInPercent;
    float fadeOutPercent = c.fadeOutPercent;
    normalizeClipFadePercents(fadeInPercent, fadeOutPercent);
    o.Set("fadeInPercent",     Napi::Number::New(env, fadeInPercent));
    o.Set("fadeOutPercent",    Napi::Number::New(env, fadeOutPercent));
    o.Set("fadeInX1",          Napi::Number::New(env, c.fadeInX1));
    o.Set("fadeInY1",          Napi::Number::New(env, c.fadeInY1));
    o.Set("fadeInX2",          Napi::Number::New(env, c.fadeInX2));
    o.Set("fadeInY2",          Napi::Number::New(env, c.fadeInY2));
    o.Set("fadeOutX1",         Napi::Number::New(env, c.fadeOutX1));
    o.Set("fadeOutY1",         Napi::Number::New(env, c.fadeOutY1));
    o.Set("fadeOutX2",         Napi::Number::New(env, c.fadeOutX2));
    o.Set("fadeOutY2",         Napi::Number::New(env, c.fadeOutY2));
    return o;
}

static Napi::Object trackToJs(Napi::Env env, const TrackInfo& t) {
    Napi::Object o = Napi::Object::New(env);
    o.Set("id",                Napi::Number::New(env, t.id));
    o.Set("name",              Napi::String::New(env, t.name));
    o.Set("volume",            Napi::Number::New(env, t.volume));
    o.Set("pan",               Napi::Number::New(env, t.pan));
    o.Set("stereoSpread",      Napi::Number::New(env, t.stereoSpread));
    o.Set("muted",             Napi::Boolean::New(env, t.muted));
    o.Set("solo",              Napi::Boolean::New(env, t.solo));
    o.Set("visualOnly",        Napi::Boolean::New(env, t.visualOnly));
    o.Set("order",             Napi::Number::New(env, t.order));
    o.Set("type",              Napi::String::New(env, trackTypeToString(t.type)));
    // videoFlipMode: derived from videoFlipConfig for UI backward compatibility
    // until Phase 5 replaces the context-menu submenu with the v2 Flip Properties panel.
    o.Set("videoFlipMode", Napi::String::New(env, videoFlipConfigToLegacyMode(t.videoFlipConfig)));
    {
        // videoFlipConfig: full v2 configuration object (new API).
        const VideoFlipConfig& cfg = t.videoFlipConfig;
        Napi::Object fc = Napi::Object::New(env);
        fc.Set("enabled",         Napi::Boolean::New(env, cfg.enabled));
        fc.Set("startStateIndex", Napi::Number::New(env, cfg.startStateIndex));

        Napi::Array states = Napi::Array::New(env, cfg.states.size());
        for (uint32_t i = 0; i < static_cast<uint32_t>(cfg.states.size()); ++i) {
            Napi::Object s = Napi::Object::New(env);
            s.Set("id",          Napi::String::New(env, cfg.states[i].id));
            s.Set("orientation", Napi::String::New(env, orientationToString(cfg.states[i].orientation)));
            s.Set("label",       Napi::String::New(env, cfg.states[i].label));
            states[i] = s;
        }
        fc.Set("states", states);

        Napi::Object mod = Napi::Object::New(env);
        mod.Set("type", Napi::String::New(env, videoFlipModifierTypeToString(cfg.modifier.type)));
        Napi::Object mcfg = Napi::Object::New(env);
        if (cfg.modifier.type == VideoFlipModifier::Type::SpecificPitches) {
            Napi::Array pitches = Napi::Array::New(env, cfg.modifier.pitches.size());
            for (uint32_t i = 0; i < static_cast<uint32_t>(cfg.modifier.pitches.size()); ++i)
                pitches[i] = Napi::Number::New(env, cfg.modifier.pitches[i]);
            mcfg.Set("pitches", pitches);
        } else if (cfg.modifier.type == VideoFlipModifier::Type::EveryNBeats) {
            mcfg.Set("n",           Napi::Number::New(env, cfg.modifier.n));
            mcfg.Set("subdivision", Napi::String::New(env,
                videoFlipSubdivisionToString(cfg.modifier.subdivision)));
        }
        mod.Set("config", mcfg);
        fc.Set("modifier", mod);
        o.Set("videoFlipConfig", fc);
    }
    o.Set("videoHoldLastFrame", Napi::Boolean::New(env, t.videoHoldLastFrame));
    o.Set("cornerRadius",      Napi::Number::New(env, t.cornerRadius));
    o.Set("gapScaleOverride",  Napi::Number::New(env, t.gapScaleOverride));
    o.Set("subdivisionFactor", Napi::Number::New(env, t.subdivisionFactor));
    {
        Napi::Object b = Napi::Object::New(env);
        b.Set("enabled",      Napi::Boolean::New(env, t.bounce.enabled));
        b.Set("directionDeg", Napi::Number::New(env, t.bounce.directionDeg));
        b.Set("distance",     Napi::Number::New(env, t.bounce.distance));
        b.Set("durationMs",   Napi::Number::New(env, t.bounce.durationMs));
        b.Set("squashAmount", Napi::Number::New(env, t.bounce.squashAmount));
        b.Set("overshoot",    Napi::Number::New(env, t.bounce.overshoot));
        b.Set("repeatCount",  Napi::Number::New(env, t.bounce.repeatCount));
        b.Set("easingType",   Napi::Number::New(env, t.bounce.easingType));
        o.Set("bounce", b);
    }
    {
        // Serialize ZoomPanRot settings
        Napi::Object z = Napi::Object::New(env);
        const auto& zpr = t.zoomPanRot;
        z.Set("enabled",        Napi::Boolean::New(env, zpr.enabled));
        z.Set("startZoom",      Napi::Number::New(env, zpr.startZoom));
        z.Set("targetZoom",     Napi::Number::New(env, zpr.targetZoom));
        z.Set("startPanX",      Napi::Number::New(env, zpr.startPanX));
        z.Set("startPanY",      Napi::Number::New(env, zpr.startPanY));
        z.Set("targetPanX",     Napi::Number::New(env, zpr.targetPanX));
        z.Set("targetPanY",     Napi::Number::New(env, zpr.targetPanY));
        z.Set("startRotation",  Napi::Number::New(env, zpr.startRotation));
        z.Set("targetRotation", Napi::Number::New(env, zpr.targetRotation));
        z.Set("durationMs",     Napi::Number::New(env, zpr.durationMs));
        z.Set("zoomEasing",     Napi::Number::New(env, zpr.zoomEasing));
        z.Set("panEasing",      Napi::Number::New(env, zpr.panEasing));
        z.Set("rotEasing",      Napi::Number::New(env, zpr.rotEasing));
        z.Set("overshoot",      Napi::Number::New(env, zpr.overshoot));
        o.Set("zoomPanRot", z);
    }
    {
        // Serialize PingPong settings
        Napi::Object p = Napi::Object::New(env);
        const auto& pp = t.pingPong;
        p.Set("enabled",         Napi::Boolean::New(env, pp.enabled));
        p.Set("regionStartPct",  Napi::Number::New(env, pp.regionStartPct));
        p.Set("regionEndPct",    Napi::Number::New(env, pp.regionEndPct));
        p.Set("crossfadeFrames", Napi::Number::New(env, pp.crossfadeFrames));
        p.Set("reverseSpeed",    Napi::Number::New(env, pp.reverseSpeed));
        p.Set("maxLoops",        Napi::Number::New(env, pp.maxLoops));
        o.Set("pingPong", p);
    }
    {
        // Serialize SlideNoteEffect settings
        Napi::Object s = Napi::Object::New(env);
        const auto& sl = t.slideNoteEffect;
        s.Set("type",            Napi::Number::New(env, static_cast<int>(sl.type)));
        s.Set("durationMode",    Napi::Number::New(env, static_cast<int>(sl.durationMode)));
        s.Set("fixedDurationMs", Napi::Number::New(env, sl.fixedDurationMs));
        o.Set("slideNoteEffect", s);
    }
    {
        // Serialize visual effect chain
        Napi::Array chainArr = Napi::Array::New(env, t.visualEffectChain.size());
        for (size_t i = 0; i < t.visualEffectChain.size(); ++i) {
            const VisualEffect& fx = t.visualEffectChain[i];
            Napi::Object fxObj = Napi::Object::New(env);
            fxObj.Set("type",     Napi::Number::New(env, static_cast<int>(fx.type)));
            fxObj.Set("bypassed", Napi::Boolean::New(env, fx.bypassed));
            Napi::Array paramsArr = Napi::Array::New(env, 16);
            for (int pi = 0; pi < 16; ++pi)
                paramsArr.Set(static_cast<uint32_t>(pi), Napi::Number::New(env, fx.params[pi]));
            fxObj.Set("params", paramsArr);
            chainArr.Set(static_cast<uint32_t>(i), fxObj);
        }
        o.Set("visualEffectChain", chainArr);
    }
    return o;
}

static Napi::Object patternNoteToJs(Napi::Env env, const PatternNote& n) {
    Napi::Object o = Napi::Object::New(env);
    o.Set("id",            Napi::Number::New(env, n.id));
    o.Set("positionTicks", Napi::Number::New(env, static_cast<double>(n.position.ticks)));
    o.Set("durationTicks", Napi::Number::New(env, static_cast<double>(n.duration.ticks)));
    o.Set("pitch",         Napi::Number::New(env, n.pitch));
    o.Set("velocity",      Napi::Number::New(env, n.velocity));
    o.Set("isSlide",       Napi::Boolean::New(env, n.isSlide));
    o.Set("slideCurveCx",  Napi::Number::New(env, n.slideCurveCx));
    o.Set("slideCurveCy",  Napi::Number::New(env, n.slideCurveCy));
    return o;
}

static PatternNote jsToPatternNote(const Napi::Object& o) {
    PatternNote n;
    if (o.Has("positionTicks") && o.Get("positionTicks").IsNumber())
        n.position.ticks = static_cast<int64_t>(o.Get("positionTicks").As<Napi::Number>().DoubleValue());
    if (o.Has("durationTicks") && o.Get("durationTicks").IsNumber())
        n.duration.ticks = static_cast<int64_t>(o.Get("durationTicks").As<Napi::Number>().DoubleValue());
    if (o.Has("pitch") && o.Get("pitch").IsNumber())
        n.pitch = o.Get("pitch").As<Napi::Number>().Int32Value();
    if (o.Has("velocity") && o.Get("velocity").IsNumber())
        n.velocity = o.Get("velocity").As<Napi::Number>().FloatValue();
    if (o.Has("isSlide") && o.Get("isSlide").IsBoolean())
        n.isSlide = o.Get("isSlide").As<Napi::Boolean>().Value();
    if (o.Has("slideCurveCx") && o.Get("slideCurveCx").IsNumber())
        n.slideCurveCx = o.Get("slideCurveCx").As<Napi::Number>().FloatValue();
    if (o.Has("slideCurveCy") && o.Get("slideCurveCy").IsNumber())
        n.slideCurveCy = o.Get("slideCurveCy").As<Napi::Number>().FloatValue();
    return n;
}

static Napi::Object patternToJs(Napi::Env env, const Pattern& p) {
    Napi::Object o = Napi::Object::New(env);
    o.Set("id",               Napi::Number::New(env, p.id));
    o.Set("name",             Napi::String::New(env, p.name));
    o.Set("regionId",         Napi::Number::New(env, p.regionId));
    o.Set("lengthTicks",      Napi::Number::New(env, static_cast<double>(p.length.ticks)));
    o.Set("nextNoteId",       Napi::Number::New(env, p.nextNoteId));

    Napi::Array arr = Napi::Array::New(env, p.notes.size());
    for (size_t i = 0; i < p.notes.size(); ++i)
        arr.Set(static_cast<uint32_t>(i), patternNoteToJs(env, p.notes[i]));
    o.Set("notes", arr);
    return o;
}

static Napi::Object patternBlockToJs(Napi::Env env, const PatternBlock& b) {
    Napi::Object o = Napi::Object::New(env);
    o.Set("id",            Napi::Number::New(env, b.id));
    o.Set("trackId",       Napi::Number::New(env, b.trackId));
    o.Set("patternId",     Napi::Number::New(env, b.patternId));
    o.Set("positionTicks", Napi::Number::New(env, static_cast<double>(b.position.ticks)));
    o.Set("durationTicks", Napi::Number::New(env, static_cast<double>(b.duration.ticks)));
    o.Set("offsetTicks",   Napi::Number::New(env, static_cast<double>(b.offset.ticks)));
    o.Set("loopEnabled",   Napi::Boolean::New(env, b.loopEnabled));
    return o;
}

static Napi::Object syllableToJs(Napi::Env env, const SampleRegion::Syllable& s) {
    Napi::Object o = Napi::Object::New(env);
    o.Set("startTime", Napi::Number::New(env, s.startTime));
    o.Set("endTime",   Napi::Number::New(env, s.endTime));
    o.Set("number",    Napi::Number::New(env, s.number));
    o.Set("text",      Napi::String::New(env, s.text));
    return o;
}

static SampleRegion::Syllable jsToSyllable(const Napi::Object& o) {
    SampleRegion::Syllable s;
    if (o.Has("startTime") && o.Get("startTime").IsNumber())
        s.startTime = o.Get("startTime").As<Napi::Number>().DoubleValue();
    if (o.Has("endTime")   && o.Get("endTime").IsNumber())
        s.endTime   = o.Get("endTime").As<Napi::Number>().DoubleValue();
    if (o.Has("number")    && o.Get("number").IsNumber())
        s.number    = o.Get("number").As<Napi::Number>().Int32Value();
    if (o.Has("text")      && o.Get("text").IsString())
        s.text      = o.Get("text").As<Napi::String>().Utf8Value();
    return s;
}

static Napi::Object regionToJs(Napi::Env env, const SampleRegion& r) {
    Napi::Object o = Napi::Object::New(env);
    o.Set("id",            Napi::Number::New(env, r.id));
    o.Set("sourceId",      Napi::Number::New(env, r.sourceId));
    o.Set("name",          Napi::String::New(env, r.name));
    o.Set("label",         Napi::String::New(env, sampleLabelToString(r.label)));
    o.Set("startTime",     Napi::Number::New(env, r.startTime));
    o.Set("endTime",       Napi::Number::New(env, r.endTime));
    o.Set("startFrame",    Napi::Number::New(env, r.startFrame));
    o.Set("endFrame",      Napi::Number::New(env, r.endFrame));
    o.Set("audioFilePath", Napi::String::New(env, r.audioFilePath));
    o.Set("swappedAudioPath",        Napi::String::New(env, r.swappedAudioPath));
    o.Set("hasSwappedAudio",         Napi::Boolean::New(env, r.hasSwappedAudio));
    o.Set("swappedAudioDurationSec", Napi::Number::New(env, r.swappedAudioDurationSec));
    o.Set("rootNote",         Napi::Number::New(env, r.rootNote));
    o.Set("attackMs",         Napi::Number::New(env, r.attackMs));
    o.Set("decayMs",          Napi::Number::New(env, r.decayMs));
    o.Set("sustain",          Napi::Number::New(env, r.sustain));
    o.Set("releaseMs",        Napi::Number::New(env, r.releaseMs));
    o.Set("delayMs",          Napi::Number::New(env, r.delayMs));
    o.Set("holdMs",           Napi::Number::New(env, r.holdMs));
    o.Set("attackTension",    Napi::Number::New(env, r.attackTension));
    o.Set("decayTension",     Napi::Number::New(env, r.decayTension));
    o.Set("releaseTension",   Napi::Number::New(env, r.releaseTension));
    o.Set("pitchEnvEnabled",        Napi::Boolean::New(env, r.pitchEnvEnabled));
    o.Set("pitchEnvAmount",         Napi::Number::New(env, r.pitchEnvAmount));
    o.Set("pitchEnvDelayMs",        Napi::Number::New(env, r.pitchEnvDelayMs));
    o.Set("pitchEnvAttackMs",       Napi::Number::New(env, r.pitchEnvAttackMs));
    o.Set("pitchEnvHoldMs",         Napi::Number::New(env, r.pitchEnvHoldMs));
    o.Set("pitchEnvDecayMs",        Napi::Number::New(env, r.pitchEnvDecayMs));
    o.Set("pitchEnvSustain",        Napi::Number::New(env, r.pitchEnvSustain));
    o.Set("pitchEnvReleaseMs",      Napi::Number::New(env, r.pitchEnvReleaseMs));
    o.Set("pitchEnvAttackTension",  Napi::Number::New(env, r.pitchEnvAttackTension));
    o.Set("pitchEnvDecayTension",   Napi::Number::New(env, r.pitchEnvDecayTension));
    o.Set("pitchEnvReleaseTension", Napi::Number::New(env, r.pitchEnvReleaseTension));
    o.Set("loopEnabled",      Napi::Boolean::New(env, r.loopEnabled));
    o.Set("loopStart",        Napi::Number::New(env, static_cast<double>(r.loopStart)));
    o.Set("loopEnd",          Napi::Number::New(env, static_cast<double>(r.loopEnd)));
    o.Set("crossfadeEnabled", Napi::Boolean::New(env, r.crossfadeEnabled));
    o.Set("smpStart",         Napi::Number::New(env, static_cast<double>(r.smpStart)));
    o.Set("smpLength",        Napi::Number::New(env, static_cast<double>(r.smpLength)));
    o.Set("declickMs",        Napi::Number::New(env, r.declickMs));
    o.Set("fadeInMs",         Napi::Number::New(env, r.fadeInMs));
    o.Set("fadeOutMs",        Napi::Number::New(env, r.fadeOutMs));
    o.Set("crossfadeSamples", Napi::Number::New(env, static_cast<double>(r.crossfadeSamples)));
    o.Set("dcOffsetRemoved",  Napi::Boolean::New(env, r.dcOffsetRemoved));
    o.Set("normalized",       Napi::Boolean::New(env, r.normalized));
    o.Set("polarityReversed", Napi::Boolean::New(env, r.polarityReversed));
    o.Set("reversed",         Napi::Boolean::New(env, r.reversed));
    o.Set("monoEnabled",       Napi::Boolean::New(env, r.monoEnabled));
    o.Set("portamentoEnabled", Napi::Boolean::New(env, r.portamentoEnabled));
    o.Set("portamentoTimeMs",  Napi::Number::New(env, r.portamentoTimeMs));
    o.Set("arpEnabled",        Napi::Boolean::New(env, r.arpEnabled));
    o.Set("arpTempoSync",      Napi::Boolean::New(env, r.arpTempoSync));
    o.Set("arpDivision",       Napi::Number::New(env, r.arpDivision));
    o.Set("arpFreeTimeMs",     Napi::Number::New(env, r.arpFreeTimeMs));
    o.Set("arpGate",           Napi::Number::New(env, r.arpGate));
    o.Set("arpRange",          Napi::Number::New(env, r.arpRange));
    o.Set("arpDirection",      Napi::Number::New(env, r.arpDirection));
    // ── LFO ─────────────────────────────────────────────────────────────────
    auto serializeLfoWaveform = [&](const std::vector<SampleRegion::LfoBreakpoint>& wf) {
        Napi::Array a = Napi::Array::New(env, wf.size());
        for (size_t i = 0; i < wf.size(); ++i) {
            Napi::Object pt = Napi::Object::New(env);
            pt.Set("t", Napi::Number::New(env, wf[i].time));
            pt.Set("v", Napi::Number::New(env, wf[i].value));
            a.Set((uint32_t)i, pt);
        }
        return a;
    };
    // Volume LFO
    o.Set("lfoVolEnabled",       Napi::Boolean::New(env, r.lfoVolEnabled));
    o.Set("lfoVolAmount",        Napi::Number::New(env, r.lfoVolAmount));
    o.Set("lfoVolSpeedHz",       Napi::Number::New(env, r.lfoVolSpeedHz));
    o.Set("lfoVolTempoSync",     Napi::Boolean::New(env, r.lfoVolTempoSync));
    o.Set("lfoVolTempoDivision", Napi::Number::New(env, r.lfoVolTempoDivision));
    o.Set("lfoVolAttackMs",      Napi::Number::New(env, r.lfoVolAttackMs));
    o.Set("lfoVolDelayMs",       Napi::Number::New(env, r.lfoVolDelayMs));
    o.Set("lfoVolWaveform",      serializeLfoWaveform(r.lfoVolWaveform));
    // Panning LFO
    o.Set("lfoPanEnabled",       Napi::Boolean::New(env, r.lfoPanEnabled));
    o.Set("lfoPanAmount",        Napi::Number::New(env, r.lfoPanAmount));
    o.Set("lfoPanSpeedHz",       Napi::Number::New(env, r.lfoPanSpeedHz));
    o.Set("lfoPanTempoSync",     Napi::Boolean::New(env, r.lfoPanTempoSync));
    o.Set("lfoPanTempoDivision", Napi::Number::New(env, r.lfoPanTempoDivision));
    o.Set("lfoPanAttackMs",      Napi::Number::New(env, r.lfoPanAttackMs));
    o.Set("lfoPanDelayMs",       Napi::Number::New(env, r.lfoPanDelayMs));
    o.Set("lfoPanWaveform",      serializeLfoWaveform(r.lfoPanWaveform));
    // Pitch LFO
    o.Set("lfoPitchEnabled",       Napi::Boolean::New(env, r.lfoPitchEnabled));
    o.Set("lfoPitchAmount",        Napi::Number::New(env, r.lfoPitchAmount));
    o.Set("lfoPitchSpeedHz",       Napi::Number::New(env, r.lfoPitchSpeedHz));
    o.Set("lfoPitchTempoSync",     Napi::Boolean::New(env, r.lfoPitchTempoSync));
    o.Set("lfoPitchTempoDivision", Napi::Number::New(env, r.lfoPitchTempoDivision));
    o.Set("lfoPitchAttackMs",      Napi::Number::New(env, r.lfoPitchAttackMs));
    o.Set("lfoPitchDelayMs",       Napi::Number::New(env, r.lfoPitchDelayMs));
    o.Set("lfoPitchWaveform",      serializeLfoWaveform(r.lfoPitchWaveform));
    Napi::Array arr = Napi::Array::New(env, r.syllables.size());
    for (size_t i = 0; i < r.syllables.size(); ++i)
        arr.Set((uint32_t)i, syllableToJs(env, r.syllables[i]));
    o.Set("syllables", arr);
    return o;
}

static TrackInfo jsToTrack(const Napi::Object& o) {
    TrackInfo t;
    if (o.Has("name")   && o.Get("name").IsString())
        t.name   = o.Get("name").As<Napi::String>().Utf8Value();
    if (o.Has("volume") && o.Get("volume").IsNumber())
        t.volume = o.Get("volume").As<Napi::Number>().FloatValue();
    if (o.Has("pan")    && o.Get("pan").IsNumber())
        t.pan    = o.Get("pan").As<Napi::Number>().FloatValue();
    if (o.Has("stereoSpread") && o.Get("stereoSpread").IsNumber())
        t.stereoSpread = o.Get("stereoSpread").As<Napi::Number>().FloatValue();
    if (o.Has("muted")  && o.Get("muted").IsBoolean())
        t.muted  = o.Get("muted").As<Napi::Boolean>().Value();
    if (o.Has("solo")   && o.Get("solo").IsBoolean())
        t.solo   = o.Get("solo").As<Napi::Boolean>().Value();
    if (o.Has("order")  && o.Get("order").IsNumber())
        t.order  = o.Get("order").As<Napi::Number>().Int32Value();
    if (o.Has("videoHoldLastFrame") && o.Get("videoHoldLastFrame").IsBoolean())
        t.videoHoldLastFrame = o.Get("videoHoldLastFrame").As<Napi::Boolean>().Value();
    return t;
}

// ─── GridLayout JS bridge helpers ─────────────────────────────────────────────

static Napi::Object gridSlotToJs(Napi::Env env, const GridSlot& s) {
    Napi::Object o = Napi::Object::New(env);
    o.Set("trackId", Napi::Number::New(env, s.trackId));
    o.Set("gridX",   Napi::Number::New(env, s.gridX));
    o.Set("gridY",   Napi::Number::New(env, s.gridY));
    o.Set("spanX",   Napi::Number::New(env, s.spanX));
    o.Set("spanY",   Napi::Number::New(env, s.spanY));
    o.Set("opacity", Napi::Number::New(env, s.opacity));
    o.Set("zOrder",  Napi::Number::New(env, s.zOrder));
    return o;
}

static Napi::Object gridLayoutToJs(Napi::Env env, const GridLayout& g) {
    Napi::Object o = Napi::Object::New(env);
    o.Set("columns",       Napi::Number::New(env, g.columns));
    o.Set("rows",          Napi::Number::New(env, g.rows));
    o.Set("chorusTrackId", Napi::Number::New(env, g.chorusTrackId));
    o.Set("crashEnabled",  Napi::Boolean::New(env, g.crashEnabled));
    o.Set("crashTrackId",  Napi::Number::New(env, g.crashTrackId));
    o.Set("crashOpacity",  Napi::Number::New(env, g.crashOpacity));
    o.Set("previewFps",    Napi::Number::New(env, g.previewFps));
    o.Set("gapScale",      Napi::Number::New(env, g.gapScale));
    Napi::Array arr = Napi::Array::New(env, g.slots.size());
    for (size_t i = 0; i < g.slots.size(); ++i)
        arr.Set((uint32_t)i, gridSlotToJs(env, g.slots[i]));
    o.Set("slots", arr);
    return o;
}

static GridSlot jsToGridSlot(const Napi::Object& o) {
    GridSlot s;
    if (o.Has("trackId") && o.Get("trackId").IsNumber())
        s.trackId = o.Get("trackId").As<Napi::Number>().Int32Value();
    if (o.Has("gridX")   && o.Get("gridX").IsNumber())
        s.gridX   = o.Get("gridX").As<Napi::Number>().Int32Value();
    if (o.Has("gridY")   && o.Get("gridY").IsNumber())
        s.gridY   = o.Get("gridY").As<Napi::Number>().Int32Value();
    if (o.Has("spanX")   && o.Get("spanX").IsNumber())
        s.spanX   = o.Get("spanX").As<Napi::Number>().Int32Value();
    if (o.Has("spanY")   && o.Get("spanY").IsNumber())
        s.spanY   = o.Get("spanY").As<Napi::Number>().Int32Value();
    if (o.Has("opacity") && o.Get("opacity").IsNumber())
        s.opacity = o.Get("opacity").As<Napi::Number>().FloatValue();
    if (o.Has("zOrder")  && o.Get("zOrder").IsNumber())
        s.zOrder  = o.Get("zOrder").As<Napi::Number>().Int32Value();
    return s;
}

static GridLayout jsToGridLayout(const Napi::Object& o) {
    GridLayout g;
    if (o.Has("columns")       && o.Get("columns").IsNumber())
        g.columns       = o.Get("columns").As<Napi::Number>().Int32Value();
    if (o.Has("rows")          && o.Get("rows").IsNumber())
        g.rows          = o.Get("rows").As<Napi::Number>().Int32Value();
    if (o.Has("chorusTrackId") && o.Get("chorusTrackId").IsNumber())
        g.chorusTrackId = o.Get("chorusTrackId").As<Napi::Number>().Int32Value();
    if (o.Has("crashEnabled")  && o.Get("crashEnabled").IsBoolean())
        g.crashEnabled  = o.Get("crashEnabled").As<Napi::Boolean>().Value();
    if (o.Has("crashTrackId")  && o.Get("crashTrackId").IsNumber())
        g.crashTrackId  = o.Get("crashTrackId").As<Napi::Number>().Int32Value();
    if (o.Has("crashOpacity")  && o.Get("crashOpacity").IsNumber())
        g.crashOpacity  = o.Get("crashOpacity").As<Napi::Number>().FloatValue();
    if (o.Has("previewFps")    && o.Get("previewFps").IsNumber())
        g.previewFps    = o.Get("previewFps").As<Napi::Number>().Int32Value();
    if (o.Has("gapScale")      && o.Get("gapScale").IsNumber()) {
        float v = o.Get("gapScale").As<Napi::Number>().FloatValue();
        // Validate range C++-side (Prompt 11): gapScale ∈ [0.0, 0.5].
        if (v < 0.0f) v = 0.0f;
        if (v > 0.5f) v = 0.5f;
        g.gapScale      = v;
    }
    if (o.Has("slots") && o.Get("slots").IsArray()) {
        Napi::Array arr = o.Get("slots").As<Napi::Array>();
        for (uint32_t i = 0; i < arr.Length(); ++i) {
            if (arr.Get(i).IsObject())
                g.slots.push_back(jsToGridSlot(arr.Get(i).As<Napi::Object>()));
        }
    }
    return g;
}

static SampleRegion jsToRegion(const Napi::Object& o) {
    SampleRegion r;
    if (o.Has("sourceId")      && o.Get("sourceId").IsNumber())
        r.sourceId = o.Get("sourceId").As<Napi::Number>().Int32Value();
    if (o.Has("name")          && o.Get("name").IsString())
        r.name     = o.Get("name").As<Napi::String>().Utf8Value();
    if (o.Has("label")         && o.Get("label").IsString())
        r.label    = stringToSampleLabel(o.Get("label").As<Napi::String>().Utf8Value());
    if (o.Has("startTime")     && o.Get("startTime").IsNumber())
        r.startTime = o.Get("startTime").As<Napi::Number>().DoubleValue();
    if (o.Has("endTime")       && o.Get("endTime").IsNumber())
        r.endTime   = o.Get("endTime").As<Napi::Number>().DoubleValue();
    if (o.Has("startFrame")    && o.Get("startFrame").IsNumber())
        r.startFrame = o.Get("startFrame").As<Napi::Number>().Int32Value();
    if (o.Has("endFrame")      && o.Get("endFrame").IsNumber())
        r.endFrame   = o.Get("endFrame").As<Napi::Number>().Int32Value();
    if (o.Has("audioFilePath") && o.Get("audioFilePath").IsString())
        r.audioFilePath = o.Get("audioFilePath").As<Napi::String>().Utf8Value();
    if (o.Has("rootNote")      && o.Get("rootNote").IsNumber())
        r.rootNote = o.Get("rootNote").As<Napi::Number>().Int32Value();
    if (o.Has("syllables") && o.Get("syllables").IsArray()) {
        Napi::Array arr = o.Get("syllables").As<Napi::Array>();
        r.syllables.reserve(arr.Length());
        for (uint32_t i = 0; i < arr.Length(); ++i) {
            if (arr.Get(i).IsObject())
                r.syllables.push_back(jsToSyllable(arr.Get(i).As<Napi::Object>()));
        }
    }
    return r;
}

// After a command that adds an entity, find the newly inserted ID by comparing
// to maxIdBefore (IDs are monotonically increasing in Timeline).
static int findNewId(const std::vector<int>& idsBefore, int maxBefore) {
    (void)idsBefore;
    (void)maxBefore;
    return maxBefore; // placeholder — actual callers use getAllX().back()->id
}

// ─────────────────────────────────────────────────────────────────────────────
// Engine lifecycle
// ─────────────────────────────────────────────────────────────────────────────

// ─── Video thread lifecycle ──────────────────────────────────────────────
// Extracted from an inline lambda so InitVideoSharedMemory can safely stop
// the thread, reconfigure `frameOutput` (which calls FrameOutput::shutdown
// internally, freeing the heap buffer), and restart it. The video thread
// touches `frameOutput` with no mutex, so any reconfiguration must happen
// while this thread is joined.

static void videoThreadBody()
{
    bool blackWritten = false;
    // [PreviewUnify] Wall-clock delta for animation advance
    auto lastTickTime = std::chrono::steady_clock::now();

    // [PreviewUnify] Bind GPU render cache to this thread (debug assert)
    if (g_previewRenderCache)
        g_previewRenderCache->bindToCurrentThread();

    while (videoRunning) {
        g_previewDiag.videoTickCount.fetch_add(1, std::memory_order_relaxed);
        // Drain any finished proxy transcodes and install new region
        // decoders BEFORE locking syncEventsMutex — phase 2 of the drain
        // does blocking FFmpeg I/O (5-50 ms per open) that must never
        // happen under the lock shared with the audio thread path.
        drainProxyResults();

        double tickBeatPos = -1.0;
        {
            std::lock_guard<std::mutex> lock(syncEventsMutex);
            tickBeatPos = syncManager->videoTick();
        }

        if (audioEngine && syncManager && frameOutput.isInitialized()) {
            std::lock_guard<std::mutex> eLock(syncEventsMutex);
            const auto& events = syncManager->getEvents();

            Transport& t = audioEngine->getTransport();
            bool isPlaying = t.isPlaying();

            bool forceRender = g_previewDirty.exchange(false);

            if ((isPlaying || forceRender) && !events.empty()) {

                const bool previewPaused =
                    g_previewPauseForExport || g_previewPauseForVisibility;

                // [PreviewUnify] GPU compositor path
                if (g_previewCompositorReady && !previewPaused) {
                    g_previewDiag.compositorPathEntered.fetch_add(1, std::memory_order_relaxed);
                    const GridLayout layout = g_timeline
                        ? g_timeline->getGridLayout() : GridLayout{};
                    g_previewDiag.lastLayoutColumns.store(layout.columns, std::memory_order_relaxed);
                    g_previewDiag.lastLayoutRows.store(layout.rows, std::memory_order_relaxed);

                    // Wall-clock delta for animation (cap at 200ms for debugger pauses)
                    auto now = std::chrono::steady_clock::now();
                    float deltaMs = std::chrono::duration<float, std::milli>(
                        now - lastTickTime).count();
                    lastTickTime = now;
                    if (deltaMs > 200.0f) deltaMs = 200.0f;

                    // Advance animations only while playing
                    if (isPlaying && g_previewAnimMgr)
                        g_previewAnimMgr->advanceAll(deltaMs);

                    // Compute output frame index from transport sample position
                    int64_t samplePos  = t.getPositionSamples();
                    int     sampleRate = static_cast<int>(t.getSampleRate());
                    int previewFps = layout.previewFps;
                    if (previewFps < 1 || previewFps > 120) previewFps = 30;
                    AVRational fpsRat = { previewFps, 1 };
                    int64_t outputFrame = RenderClock::sampleToVideoFrame(
                        samplePos, sampleRate, fpsRat);

                    // ── Slide-note beat-crossing dispatch ─────────────
                    // Fire SlideAnimationEvents whose startBeat fell between
                    // the previous tick's beat and the current tick's beat.
                    // Reset on stop / seek-back / first run so loop wraparound
                    // and seek-and-replay both re-fire.
                    static double s_previewPrevBeat = -1.0;
                    const double curBpm = t.getBPM();
                    const double currentBeat = (sampleRate > 0 && curBpm > 0.0)
                        ? (static_cast<double>(samplePos) * curBpm) / (60.0 * sampleRate)
                        : 0.0;
                    if (!isPlaying) {
                        s_previewPrevBeat = -1.0;
                    } else {
                        if (s_previewPrevBeat < 0.0
                            || currentBeat + 1e-6 < s_previewPrevBeat) {
                            s_previewPrevBeat = currentBeat - 1e-6;
                        }
                        const auto& slideEvts = syncManager->getSlideEvents();
                        for (const auto& se : slideEvts) {
                            if (se.startBeat > s_previewPrevBeat
                                && se.startBeat <= currentBeat) {
                                const TrackInfo* tr = g_timeline->getTrack(se.trackId);
                                if (!tr) continue;
                                const auto& cfg = tr->slideNoteEffect;
                                if (cfg.type == SlideNoteEffectSettings::EffectType::None)
                                    continue;
                                double durationMs;
                                if (cfg.durationMode
                                    == SlideNoteEffectSettings::DurationMode::FollowSlide) {
                                    durationMs = se.durationBeats * (60000.0 / curBpm);
                                } else {
                                    durationMs = cfg.fixedDurationMs;
                                }
                                if (g_previewAnimMgr) {
                                    g_previewAnimMgr->onSlideEvent(
                                        se.trackId,
                                        static_cast<float>(durationMs),
                                        static_cast<int>(cfg.type),
                                        tr->zoomPanRot, tr->bounce,
                                        se.slideCurveCx, se.slideCurveCy);
                                }
                            }
                        }
                        s_previewPrevBeat = currentBeat;
                    }

                    // Lock compositor mutex for D3D11 immediate context
                    std::lock_guard<std::mutex> compLock(g_previewCompositorMutex);

                    // Collect → dedup → resolve → decode misses → composite → readback
                    auto requests = g_previewCollector->collectRequests(
                        outputFrame, *g_timeline, sampleRate, fpsRat, events);
                    g_previewDiag.lastRequestCount.store(static_cast<int>(requests.size()),
                                                         std::memory_order_relaxed);

                    auto deduplicated = FrameCollector::deduplicateRequests(requests);
                    auto misses = FrameCollector::resolveFrames(
                        deduplicated, *g_previewRenderCache);
                    g_previewDiag.lastDecodeMissCount.store(static_cast<int>(misses.size()),
                                                            std::memory_order_relaxed);

                    auto* device = g_gpuDevice->getDevice();
                    auto* devCtx = g_gpuDevice->getContext();
                    if (device && devCtx) {
                        for (const auto& key : misses) {
                            auto entry = g_previewRenderDecoder->decode(
                                key.sourcePath, key.frameIndex, device, devCtx);
                            if (entry.texture)
                                g_previewRenderCache->put(key, std::move(entry));
                        }
                    }

                    if (g_previewCompositor->isInitialized()) {
                        float currentTime = static_cast<float>(outputFrame)
                            * static_cast<float>(fpsRat.den)
                            / static_cast<float>(fpsRat.num);

                        g_previewCompositor->compositeFrame(
                            requests, *g_previewRenderCache,
                            layout.columns, layout.rows,
                            currentTime, layout.gapScale);
                        g_previewDiag.compositeFrameCount.fetch_add(1, std::memory_order_relaxed);

                        auto rb = g_previewCompositor->readback();
                        g_previewDiag.lastReadbackWidth.store(rb.width, std::memory_order_relaxed);
                        g_previewDiag.lastReadbackHeight.store(rb.height, std::memory_order_relaxed);
                        g_previewDiag.lastReadbackHRESULT.store(
                            static_cast<int32_t>(g_previewCompositor->getLastReadbackHRESULT()),
                            std::memory_order_relaxed);
                        if (rb.valid) {
                            g_previewDiag.readbackValidCount.fetch_add(1, std::memory_order_relaxed);
                            uint8_t* canvas = frameOutput.getBackBuffer();
                            if (canvas) {
                                g_previewDiag.canvasCopyCount.fetch_add(1, std::memory_order_relaxed);
                                const uint8_t* src = rb.pixels.data();
                                if (rb.width == CANVAS_W && rb.height == CANVAS_H) {
                                    // Fast path: compositor at full res — direct swizzle copy
                                    const size_t pixelCount =
                                        static_cast<size_t>(CANVAS_W) * CANVAS_H;
                                    for (size_t i = 0; i < pixelCount; ++i) {
                                        const size_t o = i * 4;
                                        canvas[o + 0] = src[o + 2]; // R ← B
                                        canvas[o + 1] = src[o + 1]; // G ← G
                                        canvas[o + 2] = src[o + 0]; // B ← R
                                        canvas[o + 3] = src[o + 3]; // A ← A
                                    }
                                } else {
                                    // Scaled path: nearest-neighbor upscale + swizzle.
                                    // The preview canvas is always CANVAS_W×CANVAS_H;
                                    // the compositor rendered at lower res for performance.
                                    for (int dy = 0; dy < CANVAS_H; ++dy) {
                                        const int sy = (dy * rb.height) / CANVAS_H;
                                        for (int dx = 0; dx < CANVAS_W; ++dx) {
                                            const int sx = (dx * rb.width) / CANVAS_W;
                                            const size_t si =
                                                (static_cast<size_t>(sy) * rb.width + sx) * 4;
                                            const size_t di =
                                                (static_cast<size_t>(dy) * CANVAS_W + dx) * 4;
                                            canvas[di + 0] = src[si + 2]; // R ← B
                                            canvas[di + 1] = src[si + 1]; // G ← G
                                            canvas[di + 2] = src[si + 0]; // B ← R
                                            canvas[di + 3] = src[si + 3]; // A ← A
                                        }
                                    }
                                }
                                frameOutput.swapBuffers();
                                blackWritten = isPlaying ? false : true;
                            }
                        } else {
                            g_previewDiag.readbackInvalidCount.fetch_add(1, std::memory_order_relaxed);
                        }
                    }
                }
                // Export OR visibility pause: write one black frame, then idle
                else if (previewPaused) {
                    if (!blackWritten) {
                        frameOutput.writeBlackFrame();
                        g_previewDiag.blackFrameCount.fetch_add(1, std::memory_order_relaxed);
                        blackWritten = true;
                    }
                }

#if 0 // [PreviewUnify] legacy CPU blit path, kept as fallback reference
                // === BEGIN LEGACY CPU PATH ===
                std::vector<uint8_t> canvasScratch;
                const int canvasW = frameOutput.getWidth();
                const int canvasH = frameOutput.getHeight();
                const GridLayout layout = g_timeline
                    ? g_timeline->getGridLayout() : GridLayout{};
                double beatPos = tickBeatPos;
                double bpm     = t.getBPM();
                uint8_t* canvas = frameOutput.getBackBuffer();
                if (canvas) {
                    const size_t bufSize = static_cast<size_t>(frameOutput.getBufferSize());
                    if (canvasScratch.size() != bufSize) canvasScratch.resize(bufSize);
                    std::memset(canvasScratch.data(), 0, bufSize);
                    // chorus/grid/crash blit calls were here
                    std::memcpy(canvas, canvasScratch.data(), bufSize);
                    frameOutput.swapBuffers();
                    blackWritten = isPlaying ? false : true;
                }
                // === END LEGACY CPU PATH ===
#endif

            } else if (!isPlaying) {
                if (!blackWritten) {
                    frameOutput.writeBlackFrame();
                    blackWritten = true;
                }
            }
        }

        // Stats (unchanged)
        {
            std::lock_guard<std::mutex> lock(statsMutex);
            statsSnapshot.avgDriftMs  = syncManager->getAvgDriftMs();
            statsSnapshot.maxDriftMs  = syncManager->getMaxDriftMs();
            statsSnapshot.frameDrops  = syncManager->getFrameDropCount();
            statsSnapshot.cacheHitRate = frameCache->hitRate();
        }

        // Preview FPS sleep (unchanged)
        int previewFps = 30;
        if (g_timeline) {
            int f = g_timeline->getGridLayout().previewFps;
            if (f >= 1 && f <= 120) previewFps = f;
        }
        std::this_thread::sleep_for(
            std::chrono::microseconds(1000000 / previewFps));
    }
}

static void startVideoThread()
{
    if (videoThread.joinable()) return;   // already running
    videoRunning = true;
    videoThread  = std::thread(&videoThreadBody);
}

static void stopVideoThread()
{
    videoRunning = false;
    if (videoThread.joinable())
        videoThread.join();
}

Napi::Value Initialize(const Napi::CallbackInfo& info)
{
    Napi::Env env = info.Env();
    BridgeCallLog log("initialize");

    if (isInitialised()) {
        log.done("already init");
        return Napi::Boolean::New(env, true);
    }

    // 1. JUCE init (must be first)
    juceInit = std::make_unique<juce::ScopedJuceInitialiser_GUI>();

    // 2. Sample bank + waveform mipmap cache
    sampleBank = std::make_unique<SampleBank>();
    g_mipmapCache = std::make_unique<WaveformMipmapCache>();

    // 3. Audio engine
    audioEngine = std::make_unique<AudioEngine>();
    audioEngine->setSampleBank(sampleBank.get());

    if (!audioEngine->initialize(false)) {
        audioEngine.reset();
        sampleBank.reset();
        juceInit.reset();
        Napi::Error::New(env, "AudioEngine::initialize() failed — no audio device?")
            .ThrowAsJavaScriptException();
        return Napi::Boolean::New(env, false);
    }

    // Wire the editor-host exe path so MixEngine::openPluginEditor can use it.
    // xleth-editor-host.exe lives next to xleth_native.node in the bridge/build/Release/ dir.
    audioEngine->getMixEngine().setEditorHostExe(
        getThisModuleDir().getChildFile("xleth-editor-host.exe")
            .getFullPathName().toStdString());

    // 4. Frame cache (512 MB)
    frameCache = std::make_unique<FrameCache>(512ULL * 1024 * 1024);

    // 4b. FrameServer (shares cache — fast frame extraction for SamplePicker)
    g_frameServer = std::make_unique<FrameServer>(*frameCache);

    // 5. SyncManager (Phase 0 — no GPU compositor)
    syncManager = std::make_unique<SyncManager>(
        audioEngine->getTransport(),
        decoderPtrs,
        *frameCache,
        nullptr
    );

    // 6. Initialize FrameOutput (double-buffered RGBA)
    if (!frameOutput.isInitialized())
        frameOutput.initialize(CANVAS_W, CANVAS_H);

    // 7. Phase 1 — Timeline, UndoManager, ProjectManager
    g_timeline       = std::make_unique<Timeline>(140.0, audioEngine->getSampleRate());
    g_undoManager    = std::make_unique<UndoManager>(100);
    g_projectManager = std::make_unique<ProjectManager>();
    g_proxyManager   = std::make_unique<ProxyManager>();

    // Wire region-proxy lookup sources into SyncManager so videoTick() can
    // prefer per-region proxy decoders when they are ready.
    syncManager->setRegionProxySources(&regionDecoderPtrs, g_timeline.get());

    // Wire MixEngine to Timeline (safe before playback starts)
    audioEngine->getMixEngine().setTimeline(g_timeline.get());

    // Bind Timeline's per-clip cache-invalidation hook to MixEngine so that
    // addClip/restoreClip automatically enqueue a render-cache rebuild.
    // Captures audioEngine by raw pointer — same lifetime as g_timeline.
    {
        auto* ae = audioEngine.get();
        g_timeline->setClipCacheInvalidator([ae](int clipId, const char* tag) {
            if (ae) ae->getMixEngine().invalidateClipCache(clipId, tag);
        });
    }

    // Sync transport BPM from timeline default
    audioEngine->getTransport().setBPM(g_timeline->getBPM());

    // Sync clip boundary fade from timeline default
    syncClipFadeToMixEngine();

    // 7b. [PreviewUnify] Create GPU device + preview compositor pipeline
    if (!g_gpuDevice) {
        g_gpuDevice = std::make_unique<GpuDeviceManager>();
        if (g_gpuDevice->detectAdapters()) {
            int defaultIdx = g_gpuDevice->getDefaultAdapterIndex();
            g_gpuDevice->createDevice(defaultIdx >= 0 ? defaultIdx : -1);
        }
    }

    if (g_gpuDevice && g_gpuDevice->hasDevice()) {
        auto* device = g_gpuDevice->getDevice();
        auto* devCtx = g_gpuDevice->getContext();

        g_previewCompositor    = std::make_unique<GridCompositor>();
        g_previewRenderCache   = std::make_unique<RenderFrameCache>();
        g_previewRenderDecoder = std::make_unique<RenderVideoDecoder>();
        g_previewAnimMgr       = std::make_unique<AnimationManager>();
        g_previewCollector     = std::make_unique<FrameCollector>();

        g_previewCollector->setAnimationManager(g_previewAnimMgr.get());
        g_previewRenderDecoder->initHwDevice(device, devCtx);

        int initW = frameOutput.getWidth();
        int initH = frameOutput.getHeight();
        if (initW <= 0 || initH <= 0) { initW = CANVAS_W; initH = CANVAS_H; }

        // Apply preview resolution scale (workstation preference, not project data)
        int scaledW = std::max(1, static_cast<int>(initW * g_previewResolutionScale));
        int scaledH = std::max(1, static_cast<int>(initH * g_previewResolutionScale));

        g_previewDiag.lastInitW.store(scaledW, std::memory_order_relaxed);
        g_previewDiag.lastInitH.store(scaledH, std::memory_order_relaxed);
        if (g_previewCompositor->init(device, devCtx, scaledW, scaledH)) {
            if (g_previewEffectsBypass)
                g_previewCompositor->setEffectsBypass(true);
            g_previewCompositorReady = true;
            g_previewDiag.lastCompositorWidth.store(scaledW, std::memory_order_relaxed);
            g_previewDiag.lastCompositorHeight.store(scaledH, std::memory_order_relaxed);
            std::fprintf(stderr, "[PreviewUnify] GPU compositor initialized %dx%d (scale=%.2f)\n",
                         scaledW, scaledH, g_previewResolutionScale);
        } else {
            g_previewDiag.initInitFailures.fetch_add(1, std::memory_order_relaxed);
            std::fprintf(stderr, "[PreviewUnify] WARNING: GPU compositor init failed\n");
            g_previewCompositor.reset();
            g_previewRenderDecoder.reset();
            g_previewRenderCache.reset();
            g_previewCollector.reset();
            g_previewAnimMgr.reset();
        }
    } else {
        g_previewDiag.initInitFailures.fetch_add(1, std::memory_order_relaxed);
        std::fprintf(stderr, "[PreviewUnify] WARNING: No GPU device, CPU fallback\n");
    }

    // 8. Video thread (preview FPS is user-controlled via GridLayout.previewFps)
    //    Body lives in videoThreadBody(); lifecycle helpers defined above.
    startVideoThread();

    log.done("true");
    return Napi::Boolean::New(env, true);
}

void Shutdown(const Napi::CallbackInfo& info)
{
    BridgeCallLog log("shutdown");
    if (!isInitialised()) { log.done("noop"); return; }

    videoRunning = false;
    if (videoThread.joinable())
        videoThread.join();

    // [PreviewUnify] Destroy GPU preview pipeline (after thread join, before g_gpuDevice)
    g_previewCompositorReady = false;
    g_previewPauseForExport     = false;
    g_previewPauseForVisibility = false;   // Phase 7
    g_previewCompositor.reset();
    g_previewRenderDecoder.reset();
    g_previewRenderCache.reset();
    g_previewCollector.reset();
    g_previewAnimMgr.reset();

    for (auto& [k, sc] : scalerCache) {
        if (sc.ctx) sws_freeContext(sc.ctx);
    }
    scalerCache.clear();

    frameOutput.shutdown();

    // Tear down the proxy pool before SyncManager — proxy jobs can still be
    // running ffmpeg subprocesses, and shutdown() waits up to 10 s for them.
    if (g_proxyManager) g_proxyManager->shutdown();
    g_proxyManager.reset();

    syncManager.reset();

    for (auto& d : decoderOwner)
        d->close();
    decoderOwner.clear();
    decoderPtrs.clear();

    // Region decoders are owned by unique_ptr — destructor closes each cleanly.
    regionDecoderPtrs.clear();
    regionDecoderOwner.clear();

    // Phase 1B teardown — FrameServer (before frameCache)
    g_frameServer.reset();

    // Phase 1 teardown (before audioEngine, after video thread)
    g_undoManager.reset();
    g_timeline.reset();
    g_projectManager.reset();

    audioEngine->shutdown();
    audioEngine.reset();

    g_mipmapCache.reset();  // release mipmaps before SampleBank (they hold buffer ptrs)
    sampleBank.reset();
    frameCache.reset();

    juceInit.reset();
    log.done();
}

// ─────────────────────────────────────────────────────────────────────────────
// Waveform mipmap helper — triggers background generation after sample loads.
// Key = std::to_string(sampleBankId) so the N-API query layer can look up by ID.
// ─────────────────────────────────────────────────────────────────────────────
static void triggerMipmapGeneration(int sampleBankId,
                                     const std::string& sourcePath,
                                     bool saveXlpeak)
{
    if (!g_mipmapCache || !sampleBank || sampleBankId < 0) return;
    const auto* buf = sampleBank->getSample(sampleBankId);
    if (!buf || buf->getNumSamples() == 0) return;

    int sr = audioEngine ? static_cast<int>(audioEngine->getSampleRate()) : 44100;
    g_mipmapCache->generateFromBuffer(
        std::to_string(sampleBankId), buf, sr,
        juce::File(juce::String(sourcePath)), saveXlpeak);
}

// ─────────────────────────────────────────────────────────────────────────────
// Sample management
// ─────────────────────────────────────────────────────────────────────────────

Napi::Value LoadSample(const Napi::CallbackInfo& info)
{
    Napi::Env env = info.Env();

    if (!isInitialised()) {
        Napi::Error::New(env, "Engine not initialised. Call initialize() first.")
            .ThrowAsJavaScriptException();
        return Napi::Number::New(env, -1);
    }

    if (info.Length() < 1 || !info[0].IsString()) {
        Napi::TypeError::New(env, "loadSample(filePath: string)")
            .ThrowAsJavaScriptException();
        return Napi::Number::New(env, -1);
    }

    std::string path = info[0].As<Napi::String>().Utf8Value();
    BridgeCallLog log("audio.loadSample");

    juce::File file{juce::String(path)};
    if (!file.existsAsFile()) {
        Napi::Error::New(env, "File not found: " + path)
            .ThrowAsJavaScriptException();
        return Napi::Number::New(env, -1);
    }

    int id = sampleBank->loadSample(file, audioEngine->getSampleRate());
    triggerMipmapGeneration(id, path, /*saveXlpeak=*/true);
    log.done(std::to_string(id));
    return Napi::Number::New(env, id);
}

void TriggerSample(const Napi::CallbackInfo& info)
{
    Napi::Env env = info.Env();

    if (!isInitialised()) {
        Napi::Error::New(env, "Engine not initialised.").ThrowAsJavaScriptException();
        return;
    }

    if (info.Length() < 1 || !info[0].IsNumber()) {
        Napi::TypeError::New(env, "triggerSample(sampleId: number, velocity?: number)")
            .ThrowAsJavaScriptException();
        return;
    }

    int   sampleId = info[0].As<Napi::Number>().Int32Value();
    float velocity = (info.Length() > 1 && info[1].IsNumber())
                         ? info[1].As<Napi::Number>().FloatValue()
                         : 1.0f;

    audioEngine->queueTrigger(sampleId, velocity);
}

// ─────────────────────────────────────────────────────────────────────────────
// Video management
// ─────────────────────────────────────────────────────────────────────────────

Napi::Value LoadVideo(const Napi::CallbackInfo& info)
{
    Napi::Env env = info.Env();

    if (!isInitialised()) {
        Napi::Error::New(env, "Engine not initialised.").ThrowAsJavaScriptException();
        return Napi::Number::New(env, -1);
    }

    if (info.Length() < 1 || !info[0].IsString()) {
        Napi::TypeError::New(env, "loadVideo(filePath: string)")
            .ThrowAsJavaScriptException();
        return Napi::Number::New(env, -1);
    }

    std::string srcPath  = info[0].As<Napi::String>().Utf8Value();
    std::string proxyDir = "proxies";
    BridgeCallLog log("video.loadVideo");

    std::string openPath = ProxyTranscoder::proxyExists(srcPath, proxyDir)
                               ? ProxyTranscoder::getProxyPath(srcPath, proxyDir)
                               : srcPath;

    if (!ProxyTranscoder::proxyExists(srcPath, proxyDir)) {
        std::thread([srcPath, proxyDir]() {
            ProxyTranscoder::transcode(srcPath, proxyDir, nullptr);
        }).detach();
    }

    auto decoder = std::make_unique<VideoDecoder>();
    if (!decoder->open(openPath)) {
        Napi::Error::New(env, "Failed to open video: " + openPath)
            .ThrowAsJavaScriptException();
        return Napi::Number::New(env, -1);
    }

    int sourceId = static_cast<int>(decoderPtrs.size());
    decoderPtrs.push_back(decoder.get());
    decoderOwner.push_back(std::move(decoder));

    log.done(std::to_string(sourceId));
    return Napi::Number::New(env, sourceId);
}

Napi::Value GetVideoDuration(const Napi::CallbackInfo& info)
{
    Napi::Env env = info.Env();

    if (!isInitialised()) {
        Napi::Error::New(env, "Engine not initialised.").ThrowAsJavaScriptException();
        return Napi::Number::New(env, 0.0);
    }

    if (info.Length() < 1 || !info[0].IsNumber()) {
        Napi::TypeError::New(env, "getVideoDuration(sourceId: number)")
            .ThrowAsJavaScriptException();
        return Napi::Number::New(env, 0.0);
    }

    int sourceId = info[0].As<Napi::Number>().Int32Value();
    if (sourceId < 0 || sourceId >= static_cast<int>(decoderPtrs.size()))
        return Napi::Number::New(env, 0.0);

    VideoDecoder* dec = decoderPtrs[static_cast<size_t>(sourceId)];
    if (!dec || !dec->isOpen())
        return Napi::Number::New(env, 0.0);

    return Napi::Number::New(env, dec->getDuration());
}

// ─────────────────────────────────────────────────────────────────────────────
// Transport
// ─────────────────────────────────────────────────────────────────────────────

void Play(const Napi::CallbackInfo& info)
{
    Napi::Env env = info.Env();
    if (!isInitialised()) {
        Napi::Error::New(env, "Engine not initialised.").ThrowAsJavaScriptException();
        return;
    }
    std::cout << "[Bridge] → transport.play\n" << std::flush;

    // Ensure every {trackId, regionId} sampler pair referenced by a
    // PatternBlock is loaded before audio starts. Defensive — rebuildAllSamplers
    // already fires on mutation / load / undo, but this catches edge cases
    // (blocks added before audio engine was initialised, region→sample
    // mapping updated post-creation, etc.). Main-thread only — never
    // allocates on the audio thread.
    audioEngine->getMixEngine().rebuildAllSamplers();

    rebuildVideoEventsFromClips();
    audioEngine->getTransport().play();
}

void Stop(const Napi::CallbackInfo& info)
{
    Napi::Env env = info.Env();
    if (!isInitialised()) {
        Napi::Error::New(env, "Engine not initialised.").ThrowAsJavaScriptException();
        return;
    }
    std::cout << "[Bridge] → transport.stop\n" << std::flush;
    audioEngine->getTransport().stop();
    // Main-thread safety net: kill all sampler voices immediately so no
    // sustained note rings past the stop click.
    audioEngine->getMixEngine().silenceAllSamplers();
}

void Pause(const Napi::CallbackInfo& info)
{
    Napi::Env env = info.Env();
    if (!isInitialised()) {
        Napi::Error::New(env, "Engine not initialised.").ThrowAsJavaScriptException();
        return;
    }
    std::cout << "[Bridge] → transport.pause\n" << std::flush;
    audioEngine->getTransport().pause();
    // Main-thread safety net: kill all sampler voices on pause too.
    audioEngine->getMixEngine().silenceAllSamplers();
}

// Legacy setBPM — sets transport BPM directly (no undo, for startup/audio-event use).
// Use timeline_setBPM for undo-tracked mutations from the UI.
void SetBPM(const Napi::CallbackInfo& info)
{
    Napi::Env env = info.Env();
    if (!isInitialised()) {
        Napi::Error::New(env, "Engine not initialised.").ThrowAsJavaScriptException();
        return;
    }
    if (info.Length() < 1 || !info[0].IsNumber()) {
        Napi::TypeError::New(env, "setBPM(bpm: number)").ThrowAsJavaScriptException();
        return;
    }
    double bpm = info[0].As<Napi::Number>().DoubleValue();
    audioEngine->getTransport().setBPM(bpm);
    // Keep timeline in sync if available
    if (g_timeline) g_timeline->setBPM(bpm);
}

Napi::Value GetTransportState(const Napi::CallbackInfo& info)
{
    Napi::Env env = info.Env();

    if (!isInitialised()) {
        Napi::Error::New(env, "Engine not initialised.").ThrowAsJavaScriptException();
        return Napi::Object::New(env);
    }

    Transport& t = audioEngine->getTransport();

    Napi::Object obj = Napi::Object::New(env);
    obj.Set("positionMs",    Napi::Number::New(env, t.getPositionSeconds() * 1000.0));
    obj.Set("positionBeats", Napi::Number::New(env, t.getPositionBeats()));
    obj.Set("positionBars",  Napi::Number::New(env, t.getPositionBars()));
    obj.Set("isPlaying",     Napi::Boolean::New(env, t.isPlaying()));
    obj.Set("bpm",           Napi::Number::New(env, t.getBPM()));
    return obj;
}

// transport_seek(beatPos) — seek to a beat position
void Transport_Seek(const Napi::CallbackInfo& info)
{
    Napi::Env env = info.Env();
    if (!isInitialised()) {
        Napi::Error::New(env, "Engine not initialised.").ThrowAsJavaScriptException();
        return;
    }
    if (info.Length() < 1 || !info[0].IsNumber()) {
        Napi::TypeError::New(env, "transport_seek(beatPos: number)").ThrowAsJavaScriptException();
        return;
    }
    double beatPos = info[0].As<Napi::Number>().DoubleValue();
    std::cout << "[Bridge] → transport.seek beatPos=" << beatPos << "\n" << std::flush;
    audioEngine->getTransport().seekToBeat(beatPos);
}

// ─────────────────────────────────────────────────────────────────────────────
// Video frame
// ─────────────────────────────────────────────────────────────────────────────

// Initialize FrameOutput with an externally-owned buffer (typically a
// SharedArrayBuffer from the renderer, wrapped in a Uint8Array view).
// After this call, the engine writes frames directly into that memory,
// giving the renderer zero-copy access.
Napi::Value InitFrameOutput(const Napi::CallbackInfo& info)
{
    Napi::Env env = info.Env();

    if (info.Length() < 3 || !info[0].IsTypedArray() || !info[1].IsNumber() || !info[2].IsNumber()) {
        Napi::TypeError::New(env, "initFrameOutput(view: Uint8Array, width: number, height: number)")
            .ThrowAsJavaScriptException();
        return env.Undefined();
    }

    Napi::Uint8Array view = info[0].As<Napi::Uint8Array>();
    int width  = info[1].As<Napi::Number>().Int32Value();
    int height = info[2].As<Napi::Number>().Int32Value();

    uint8_t* ptr = view.Data();
    size_t bytes = view.ByteLength();

    const size_t required = static_cast<size_t>(width) * static_cast<size_t>(height) * 4u * 2u + sizeof(int32_t);
    if (bytes < required) {
        Napi::RangeError::New(env, "initFrameOutput: buffer too small").ThrowAsJavaScriptException();
        return env.Undefined();
    }

    frameOutput.initializeExternal(ptr, bytes, width, height);

    Napi::Object obj = Napi::Object::New(env);
    obj.Set("width",       Napi::Number::New(env, frameOutput.getWidth()));
    obj.Set("height",      Napi::Number::New(env, frameOutput.getHeight()));
    obj.Set("bufferSize",  Napi::Number::New(env, frameOutput.getBufferSize()));
    obj.Set("indexOffset", Napi::Number::New(env, static_cast<double>(frameOutput.getIndexOffset())));
    return obj;
}

// Back the FrameOutput with a Windows named file mapping. Other processes that
// open the same name see the same physical pages — the basis for zero-copy
// delivery to the Electron main process / preload when this addon runs in a
// forked worker. Control region is 64 bytes; indexOffset = W*H*4*2.
Napi::Value InitVideoSharedMemory(const Napi::CallbackInfo& info)
{
    Napi::Env env = info.Env();

    if (info.Length() < 3 || !info[0].IsString() || !info[1].IsNumber() || !info[2].IsNumber()) {
        Napi::TypeError::New(env, "initVideoSharedMemory(name: string, width: number, height: number)")
            .ThrowAsJavaScriptException();
        return env.Undefined();
    }

    std::string name = info[0].As<Napi::String>().Utf8Value();
    int width  = info[1].As<Napi::Number>().Int32Value();
    int height = info[2].As<Napi::Number>().Int32Value();

    // Stop the video thread before reconfiguring frameOutput. Otherwise
    // FrameOutput::shutdown() (called from initSharedMemory) frees the
    // backing buffers while the video thread is still dereferencing them,
    // producing an ACCESS_VIOLATION. See the fix notes for details.
    stopVideoThread();

    const bool shmOk = frameOutput.initSharedMemory(name.c_str(), width, height);

    // Restart the video thread regardless of success — on failure it will
    // simply idle (frameOutput.isInitialized() == false).
    startVideoThread();

    if (!shmOk) {
        Napi::Error::New(env, "initSharedMemory failed").ThrowAsJavaScriptException();
        return env.Undefined();
    }

    const size_t totalSize = static_cast<size_t>(width) * static_cast<size_t>(height) * 4u * 2u + 64u;

    Napi::Object obj = Napi::Object::New(env);
    obj.Set("name",        Napi::String::New(env, name));
    obj.Set("width",       Napi::Number::New(env, frameOutput.getWidth()));
    obj.Set("height",      Napi::Number::New(env, frameOutput.getHeight()));
    obj.Set("bufferSize",  Napi::Number::New(env, frameOutput.getBufferSize()));
    obj.Set("indexOffset", Napi::Number::New(env, static_cast<double>(frameOutput.getIndexOffset())));
    obj.Set("totalSize",   Napi::Number::New(env, static_cast<double>(totalSize)));
    return obj;
}

Napi::Value GetFrameBuffer(const Napi::CallbackInfo& info)
{
    Napi::Env env = info.Env();

    if (!frameOutput.isInitialized()) {
        Napi::Object obj = Napi::Object::New(env);
        obj.Set("width",  Napi::Number::New(env, 0));
        obj.Set("height", Napi::Number::New(env, 0));
        return obj;
    }

    Napi::ArrayBuffer ab = Napi::ArrayBuffer::New(
        env,
        frameOutput.getRawBuffer(),
        frameOutput.getRawBufferSize());

    Napi::Object obj = Napi::Object::New(env);
    obj.Set("buffer",      ab);
    obj.Set("width",       Napi::Number::New(env, frameOutput.getWidth()));
    obj.Set("height",      Napi::Number::New(env, frameOutput.getHeight()));
    obj.Set("bufferSize",  Napi::Number::New(env, frameOutput.getBufferSize()));
    obj.Set("indexOffset", Napi::Number::New(env, static_cast<double>(frameOutput.getIndexOffset())));
    return obj;
}

Napi::Value GetCurrentFrameRGBA(const Napi::CallbackInfo& info)
{
    Napi::Env env = info.Env();

    if (!frameOutput.isInitialized()) {
        Napi::Object obj = Napi::Object::New(env);
        obj.Set("width",  Napi::Number::New(env, 0));
        obj.Set("height", Napi::Number::New(env, 0));
        obj.Set("data",   Napi::Buffer<uint8_t>::New(env, 0));
        return obj;
    }

    const uint8_t* frame = frameOutput.getCurrentFrame();
    const int size = frameOutput.getBufferSize();

    Napi::Object obj = Napi::Object::New(env);
    obj.Set("width",  Napi::Number::New(env, frameOutput.getWidth()));
    obj.Set("height", Napi::Number::New(env, frameOutput.getHeight()));
    obj.Set("data",   Napi::Buffer<uint8_t>::Copy(env, frame, static_cast<size_t>(size)));
    return obj;
}

Napi::Value GetCurrentFrame(const Napi::CallbackInfo& info)
{
    return GetCurrentFrameRGBA(info);
}

void SetVideoResolution(const Napi::CallbackInfo& info)
{
    Napi::Env env = info.Env();

    if (info.Length() < 2 || !info[0].IsNumber() || !info[1].IsNumber()) {
        Napi::TypeError::New(env, "setVideoResolution(width: number, height: number)")
            .ThrowAsJavaScriptException();
        return;
    }

    int w = info[0].As<Napi::Number>().Int32Value();
    int h = info[1].As<Napi::Number>().Int32Value();

    if (w <= 0 || h <= 0 || w > 7680 || h > 4320) {
        Napi::RangeError::New(env, "Resolution must be 1x1 to 7680x4320")
            .ThrowAsJavaScriptException();
        return;
    }

    frameOutput.initialize(w, h);

    // [PreviewUnify] Reinitialize GPU compositor at new resolution
    if (g_previewCompositor && g_gpuDevice && g_gpuDevice->hasDevice()) {
        std::lock_guard<std::mutex> lock(g_previewCompositorMutex);
        g_previewCompositorReady = false;
        g_previewCompositor->shutdown();
        auto* device = g_gpuDevice->getDevice();
        auto* devCtx = g_gpuDevice->getContext();
        if (g_previewCompositor->init(device, devCtx, w, h)) {
            g_previewCompositorReady = true;
            std::fprintf(stderr, "[PreviewUnify] Compositor reinitialized %dx%d\n", w, h);
        } else {
            std::fprintf(stderr, "[PreviewUnify] WARNING: Compositor reinit failed %dx%d\n", w, h);
        }
    }

    std::cout << "[Bridge] video.setResolution " << w << "x" << h << "\n" << std::flush;
}

// ─────────────────────────────────────────────────────────────────────────────
// Legacy timeline events (AudioScheduler / SyncManager)
// ─────────────────────────────────────────────────────────────────────────────

void AddAudioEvent(const Napi::CallbackInfo& info)
{
    Napi::Env env = info.Env();

    if (!isInitialised()) {
        Napi::Error::New(env, "Engine not initialised.").ThrowAsJavaScriptException();
        return;
    }

    if (info.Length() < 3 || !info[0].IsNumber() || !info[1].IsNumber() || !info[2].IsNumber()) {
        Napi::TypeError::New(env, "addAudioEvent(beatPosition: number, sampleId: number, velocity: number)")
            .ThrowAsJavaScriptException();
        return;
    }

    AudioEvent ev;
    ev.beatPosition = info[0].As<Napi::Number>().DoubleValue();
    ev.sampleId     = info[1].As<Napi::Number>().Int32Value();
    ev.velocity     = info[2].As<Napi::Number>().FloatValue();
    audioEngine->getAudioScheduler().addEvent(ev);
}

void AddVideoEvent(const Napi::CallbackInfo& info)
{
    Napi::Env env = info.Env();

    if (!isInitialised()) {
        Napi::Error::New(env, "Engine not initialised.").ThrowAsJavaScriptException();
        return;
    }

    if (!syncManager) return;

    if (info.Length() < 1 || !info[0].IsObject()) {
        Napi::TypeError::New(env, "addVideoEvent({ startBeat, durationBeats, sourceId, "
                                  "sourceStartTime, layerIndex, x, y, width, height, opacity })")
            .ThrowAsJavaScriptException();
        return;
    }

    Napi::Object o = info[0].As<Napi::Object>();

    VideoEvent ev;
    ev.startBeat       = o.Get("startBeat").As<Napi::Number>().DoubleValue();
    ev.durationBeats   = o.Get("durationBeats").As<Napi::Number>().DoubleValue();
    ev.sourceId        = o.Get("sourceId").As<Napi::Number>().Int32Value();
    ev.sourceStartTime = o.Get("sourceStartTime").As<Napi::Number>().DoubleValue();
    ev.layerIndex      = o.Get("layerIndex").As<Napi::Number>().Int32Value();
    ev.x       = o.Get("x").As<Napi::Number>().FloatValue();
    ev.y       = o.Get("y").As<Napi::Number>().FloatValue();
    ev.width   = o.Get("width").As<Napi::Number>().FloatValue();
    ev.height  = o.Get("height").As<Napi::Number>().FloatValue();
    ev.opacity = o.Get("opacity").As<Napi::Number>().FloatValue();

    {
        std::lock_guard<std::mutex> lock(syncEventsMutex);
        syncManager->addEvent(ev);
    }
}

void ClearTimeline(const Napi::CallbackInfo& info)
{
    Napi::Env env = info.Env();

    if (!isInitialised()) {
        Napi::Error::New(env, "Engine not initialised.").ThrowAsJavaScriptException();
        return;
    }

    audioEngine->getAudioScheduler().clearEvents();

    {
        std::lock_guard<std::mutex> lock(syncEventsMutex);
        if (syncManager) syncManager->clearEvents();

        for (auto& d : decoderOwner)
            d->close();
        decoderOwner.clear();
        decoderPtrs.clear();
    }

    if (frameCache) frameCache->clear();

    // [PreviewUnify] Clear GPU render pipeline state
    {
        std::lock_guard<std::mutex> lock(g_previewCompositorMutex);
        if (g_previewRenderCache)   g_previewRenderCache->clear();
        if (g_previewRenderDecoder) g_previewRenderDecoder->closeAll();
    }

    if (frameOutput.isInitialized()) frameOutput.writeBlackFrame();
}

// ─────────────────────────────────────────────────────────────────────────────
// Stats
// ─────────────────────────────────────────────────────────────────────────────

Napi::Value GetSyncStats(const Napi::CallbackInfo& info)
{
    Napi::Env env = info.Env();
    Napi::Object obj = Napi::Object::New(env);

    StatsSnapshot snap;
    {
        std::lock_guard<std::mutex> lock(statsMutex);
        snap = statsSnapshot;
    }

    obj.Set("avgDriftMs",   Napi::Number::New(env, snap.avgDriftMs));
    obj.Set("maxDriftMs",   Napi::Number::New(env, snap.maxDriftMs));
    obj.Set("frameDrops",   Napi::Number::New(env, snap.frameDrops));
    obj.Set("cacheHitRate", Napi::Number::New(env, snap.cacheHitRate));
    return obj;
}

// ─────────────────────────────────────────────────────────────────────────────
// Phase 1 — Project management
// ─────────────────────────────────────────────────────────────────────────────

// Builds per-track effect chain JSON keyed by trackId string.
// Only includes chains that have at least one non-IO node.
static nlohmann::json buildEffectChainsJSON(MixEngine& mix, const Timeline& timeline)
{
    nlohmann::json chains = nlohmann::json::object();
    for (const auto* t : timeline.getAllTracks()) {
        nlohmann::json chainJson = mix.getEffectChainJSON(t->id);
        if (chainJson.contains("nodes") && !chainJson["nodes"].empty())
            chains[std::to_string(t->id)] = chainJson;
    }
    return chains;
}

Napi::Value Project_Create(const Napi::CallbackInfo& info)
{
    Napi::Env env = info.Env();
    if (!isInitialised() || !g_projectManager) {
        Napi::Error::New(env, "Engine not initialised.").ThrowAsJavaScriptException();
        return env.Undefined();
    }
    if (info.Length() < 2 || !info[0].IsString() || !info[1].IsString()) {
        Napi::TypeError::New(env, "project_create(dir: string, name: string)")
            .ThrowAsJavaScriptException();
        return env.Undefined();
    }

    std::string dir  = info[0].As<Napi::String>().Utf8Value();
    std::string name = info[1].As<Napi::String>().Utf8Value();
    BridgeCallLog log("project.create");

    bool ok = g_projectManager->createProject(dir, name);
    log.done(ok ? "true" : "false");
    return Napi::Boolean::New(env, ok);
}

Napi::Value Project_Save(const Napi::CallbackInfo& info)
{
    Napi::Env env = info.Env();
    if (!isInitialised() || !g_projectManager || !g_timeline) {
        Napi::Error::New(env, "Engine not initialised.").ThrowAsJavaScriptException();
        return env.Undefined();
    }
    BridgeCallLog log("project.save");
    nlohmann::json effectChains, masterChain;
    if (audioEngine) {
        auto& mix   = audioEngine->getMixEngine();
        effectChains = buildEffectChainsJSON(mix, *g_timeline);
        masterChain  = mix.getMasterEffectChainJSON();
    }
    bool ok = g_projectManager->saveProject(*g_timeline, effectChains, masterChain);
    if (ok && g_undoManager) g_undoManager->markSavepoint();
    log.done(ok ? "true" : "false");
    return Napi::Boolean::New(env, ok);
}

Napi::Value Project_SaveAs(const Napi::CallbackInfo& info)
{
    Napi::Env env = info.Env();
    if (!isInitialised() || !g_projectManager || !g_timeline) {
        Napi::Error::New(env, "Engine not initialised.").ThrowAsJavaScriptException();
        return env.Undefined();
    }
    if (info.Length() < 2 || !info[0].IsString() || !info[1].IsString()) {
        Napi::TypeError::New(env, "project_saveAs(dir: string, name: string)")
            .ThrowAsJavaScriptException();
        return env.Undefined();
    }
    std::string dir  = info[0].As<Napi::String>().Utf8Value();
    std::string name = info[1].As<Napi::String>().Utf8Value();
    BridgeCallLog log("project.saveAs");
    nlohmann::json effectChains, masterChain;
    if (audioEngine) {
        auto& mix   = audioEngine->getMixEngine();
        effectChains = buildEffectChainsJSON(mix, *g_timeline);
        masterChain  = mix.getMasterEffectChainJSON();
    }
    bool ok = g_projectManager->saveProjectAs(dir, name, *g_timeline, effectChains, masterChain);
    if (ok && g_undoManager) g_undoManager->markSavepoint();
    log.done(ok ? "true" : "false");
    return Napi::Boolean::New(env, ok);
}

Napi::Value Project_HasProjectDir(const Napi::CallbackInfo& info)
{
    Napi::Env env = info.Env();
    if (!g_projectManager) return Napi::Boolean::New(env, false);
    return Napi::Boolean::New(env, g_projectManager->hasProjectDir());
}

// project_isDirty() → bool. True when there are edits past the last savepoint.
Napi::Value Project_IsDirty(const Napi::CallbackInfo& info)
{
    Napi::Env env = info.Env();
    if (!g_undoManager) return Napi::Boolean::New(env, false);
    return Napi::Boolean::New(env, g_undoManager->isDirty());
}

// project_isExportRunning() → bool
Napi::Value Project_IsExportRunning(const Napi::CallbackInfo& info)
{
    Napi::Env env = info.Env();
    const bool running = g_videoRenderer && g_videoRenderer->isRunning();
    return Napi::Boolean::New(env, running);
}

// project_newBlank() → { ok: bool, error?: string }
// In-memory full reset: stops transport, joins proxy pool, tears down effect
// chains, clears the Timeline (object identity preserved), clears undo,
// closes decoders and frame caches, and resets ProjectManager metadata.
Napi::Value Project_NewBlank(const Napi::CallbackInfo& info)
{
    Napi::Env env = info.Env();
    auto ret = Napi::Object::New(env);

    if (!isInitialised() || !g_projectManager || !g_timeline) {
        ret.Set("ok", Napi::Boolean::New(env, false));
        ret.Set("error", Napi::String::New(env, "Engine not initialised"));
        return ret;
    }

    // Guard: refuse to reset while an export is in flight.
    if (g_videoRenderer && g_videoRenderer->isRunning()) {
        ret.Set("ok", Napi::Boolean::New(env, false));
        ret.Set("error", Napi::String::New(env, "Export in progress"));
        return ret;
    }

    BridgeCallLog log("project.newBlank");

    // 1. Stop playback (Transport::stop rewinds position to 0) and silence
    //    any sustained sampler voices so there is no audible carry-over.
    if (audioEngine) {
        audioEngine->getTransport().stop();
        audioEngine->getMixEngine().silenceAllSamplers();
    }

    // 2. Tear down the ProxyManager pool. shutdown() is one-shot (sets an
    //    internal flag), so rebuild a fresh instance for the next project.
    //    This joins the 2-thread pool — cannot preempt an in-flight FFmpeg
    //    subprocess, but waits for it to complete.
    if (g_proxyManager) {
        g_proxyManager->shutdown();
        g_proxyManager.reset();
    }
    g_proxyManager = std::make_unique<ProxyManager>();

    // 3. Close plugin editors, destroy all effect chains, clear the
    //    region→sample map so nothing references stale regions.
    if (audioEngine) {
        auto& mix = audioEngine->getMixEngine();
        mix.closeAllPluginEditors();
        mix.destroyAllEffectChains();
        mix.clearRegionToSampleMap();
    }

    // 4. Clear the Timeline in place — preserves object identity so
    //    MixEngine / SyncManager / UI references remain valid.
    g_timeline->clear();

    // 5. Clear undo/redo history. markSavepoint at the end so the empty
    //    project starts out "clean".
    if (g_undoManager) g_undoManager->clear();

    // 6. Drop decoders, video events, frame caches. Must happen under
    //    syncEventsMutex so the video thread never sees a dangling pointer.
    {
        std::lock_guard<std::mutex> lock(syncEventsMutex);
        if (syncManager) syncManager->clearEvents();
        for (auto& d : decoderOwner)
            if (d) d->close();
        decoderOwner.clear();
        decoderPtrs.clear();
        for (auto& kv : regionDecoderOwner)
            if (kv.second) kv.second->close();
        regionDecoderOwner.clear();
        regionDecoderPtrs.clear();
        if (frameCache) frameCache->clear();
    }

    // 7. FrameServer (fast-frame decoder pool for SamplePicker).
    if (g_frameServer) g_frameServer->closeAll();

    // 8. GPU preview pipeline state.
    {
        std::lock_guard<std::mutex> lock(g_previewCompositorMutex);
        if (g_previewRenderCache)   g_previewRenderCache->clear();
        if (g_previewRenderDecoder) g_previewRenderDecoder->closeAll();
    }

    // 9. Rewire MixEngine to the (now-empty) timeline, sync transport BPM,
    //    rebuild samplers so the empty track list is reflected.
    if (audioEngine) {
        auto& mix = audioEngine->getMixEngine();
        mix.setTimeline(g_timeline.get());
        auto* ae = audioEngine.get();
        g_timeline->setClipCacheInvalidator([ae](int clipId, const char* tag) {
            if (ae) ae->getMixEngine().invalidateClipCache(clipId, tag);
        });
        audioEngine->getTransport().setBPM(g_timeline->getBPM());
        syncClipFadeToMixEngine();
        mix.rebuildAllSamplers();
    }

    // 10. Reset ProjectManager (project dir / name / timestamps).
    g_projectManager->resetToBlank();

    // 11. Savepoint on the blank state — isDirty() must return false now.
    if (g_undoManager) g_undoManager->markSavepoint();

    // 12. Request a preview repaint so any stale frame is cleared.
    g_previewDirty.store(true);

    log.done("true");
    ret.Set("ok", Napi::Boolean::New(env, true));
    return ret;
}

// Forward declaration: probeAudioInfo lives in an anonymous namespace further
// down (~line 8079). Re-declare in an anonymous namespace here so the call in
// Project_Load resolves to the same internal-linkage symbol.
namespace {
    struct ProbedAudioInfo { int sampleRate; double duration; };
    ProbedAudioInfo probeAudioInfo(const std::string& filePath);
}

Napi::Value Project_Load(const Napi::CallbackInfo& info)
{
    Napi::Env env = info.Env();
    if (!isInitialised() || !g_projectManager) {
        Napi::Error::New(env, "Engine not initialised.").ThrowAsJavaScriptException();
        return env.Undefined();
    }
    if (info.Length() < 1 || !info[0].IsString()) {
        Napi::TypeError::New(env, "project_load(dir: string)")
            .ThrowAsJavaScriptException();
        return env.Undefined();
    }

    std::string dir = info[0].As<Napi::String>().Utf8Value();
    BridgeCallLog log("project.load");

    auto loaded = g_projectManager->loadProject(dir);
    if (!loaded) {
        log.done("false");
        return Napi::Boolean::New(env, false);
    }

    // Close all plugin editor windows from the previous project before
    // replacing the timeline — editors hold AudioProcessor* references that
    // will be dangling once the old chains are torn down.
    if (audioEngine)
        audioEngine->getMixEngine().closeAllPluginEditors();

    *g_timeline = std::move(*loaded);
    if (g_undoManager) g_undoManager->clear();

    // Re-wire MixEngine and sync transport BPM
    if (audioEngine) {
        auto& mix = audioEngine->getMixEngine();
        mix.setTimeline(g_timeline.get());
        // Re-register the cache-invalidation hook: the move-assign above
        // overwrote Timeline's m_clipCacheInvalidator with the loaded
        // project's (empty) one.
        auto* ae = audioEngine.get();
        g_timeline->setClipCacheInvalidator([ae](int clipId, const char* tag) {
            if (ae) ae->getMixEngine().invalidateClipCache(clipId, tag);
        });
        audioEngine->getTransport().setBPM(g_timeline->getBPM());
        syncClipFadeToMixEngine();

        // Option A fix: rebuild regionToSampleMap_ from the loaded project before
        // calling refreshAllClipCaches(). Without this, invalidateClipCache() silently
        // skips submitJob for every clip because the map is empty (or has stale entries
        // from a previously-open project). We clear first to discard stale entries, then
        // decode each region's audio — swap-aware, same logic as audio_loadRegionAudio.
        mix.clearRegionToSampleMap();
        if (sampleBank) {
            const double engineRate = g_timeline->getSampleRate();
            for (SampleRegion* region : g_timeline->getAllRegionsMutable()) {
                if (!region) continue;

                // Migration: projects saved before swappedAudioDurationSec existed
                // have hasSwappedAudio=true but the field at 0. Probe the file once
                // and fill it in so the UI clip-resize cap can extend past video-end.
                if (region->hasSwappedAudio && !region->swappedAudioPath.empty()
                    && region->swappedAudioDurationSec == 0.0) {
                    const auto probed = probeAudioInfo(region->swappedAudioPath);
                    if (probed.duration > 0.0) {
                        region->swappedAudioDurationSec = probed.duration;
                    } else {
                        std::fprintf(stderr,
                            "[project_load] swap-audio probe failed for region %d "
                            "(swappedAudioPath='%s') — keeping video-cap behavior\n",
                            region->id, region->swappedAudioPath.c_str());
                    }
                }

                std::string audioPath;
                double startT = 0.0, endT = 0.0;

                if (region->hasSwappedAudio && !region->swappedAudioPath.empty()) {
                    // Swapped audio: full file from 0. Use large endT — loadSampleFromSource
                    // stops at EOF regardless, same fallback as Audio_SwapRegionAudio.
                    audioPath = region->swappedAudioPath;
                    startT = 0.0;
                    endT   = 3600.0;
                } else {
                    const SourceMedia* source = g_timeline->getSource(region->sourceId);
                    if (!source || source->filePath.empty()) continue;
                    audioPath = source->filePath;
                    startT = region->startTime;
                    endT   = region->endTime;
                }

                if (startT >= endT) continue;

                const int sid = sampleBank->loadSampleFromSource(
                    audioPath, startT, endT, engineRate);
                if (sid >= 0) {
                    fprintf(stderr, "[PITCHDBG] projectLoad: mapRegionToSample region=%d sampleId=%d\n",
                            region->id, sid);
                    fflush(stderr);
                    mix.mapRegionToSample(region->id, sid);
                }
            }
        }

        mix.rebuildAllSamplers();
        refreshAllClipCaches();

        // Restore effect chains from project.json (absent in older projects — graceful no-op)
        {
            const auto& chains = g_projectManager->getLoadedEffectChains();
            if (chains.is_object()) {
                for (auto it = chains.begin(); it != chains.end(); ++it) {
                    try { mix.loadEffectChainFromJSON(std::stoi(it.key()), it.value()); }
                    catch (...) {}
                }
            }
            const auto& masterChain = g_projectManager->getLoadedMasterEffectChain();
            if (masterChain.is_object() && !masterChain.is_null())
                mix.loadMasterEffectChainFromJSON(masterChain);
        }
    }

    // Drop any stale decoders/events from before the load, then re-wire every
    // video source in the loaded project. Most will already have a ready proxy
    // (saved after transcode finished); ensureSourceDecoder picks the proxy
    // path automatically and skips the watchdog in that case.
    {
        std::lock_guard<std::mutex> lock(syncEventsMutex);
        if (syncManager) syncManager->clearEvents();
        for (auto& d : decoderOwner)
            if (d) d->close();
        decoderOwner.clear();
        decoderPtrs.clear();
        if (frameCache) frameCache->clear();
    }

    // [PreviewUnify] Clear GPU render pipeline state on project load
    {
        std::lock_guard<std::mutex> lock(g_previewCompositorMutex);
        if (g_previewRenderCache)   g_previewRenderCache->clear();
        if (g_previewRenderDecoder) g_previewRenderDecoder->closeAll();
    }

    auto sources = g_timeline->getAllSources();
    for (const SourceMedia* s : sources) {
        if (s && s->hasVideo)
            ensureSourceDecoder(s->id);
    }

    log.done("true");
    return Napi::Boolean::New(env, true);
}

Napi::Value Project_ImportSource(const Napi::CallbackInfo& info)
{
    Napi::Env env = info.Env();
    if (!isInitialised() || !g_projectManager || !g_timeline) {
        Napi::Error::New(env, "Engine not initialised.").ThrowAsJavaScriptException();
        return env.Undefined();
    }
    if (info.Length() < 1 || !info[0].IsString()) {
        Napi::TypeError::New(env, "project_importSource(filePath: string)")
            .ThrowAsJavaScriptException();
        return env.Undefined();
    }

    std::string filePath = info[0].As<Napi::String>().Utf8Value();
    BridgeCallLog log("project.importSource");

    int id = g_projectManager->importSource(*g_timeline, filePath);
    if (id >= 0) {
        const SourceMedia* src = g_timeline->getSource(id);
        if (src && src->hasVideo) {
            ensureSourceDecoder(id);
            if (g_frameServer)
                g_frameServer->openSourceFromTimeline(id, *g_timeline);
        }
    }

    log.done(std::to_string(id));
    return Napi::Number::New(env, id);
}

Napi::Value Project_ValidateMedia(const Napi::CallbackInfo& info)
{
    Napi::Env env = info.Env();
    if (!isInitialised() || !g_projectManager || !g_timeline) {
        Napi::Error::New(env, "Engine not initialised.").ThrowAsJavaScriptException();
        return env.Undefined();
    }
    BridgeCallLog log("project.validateMedia");

    auto statuses = g_projectManager->validateMedia(*g_timeline);
    Napi::Array arr = Napi::Array::New(env, statuses.size());
    for (size_t i = 0; i < statuses.size(); ++i) {
        Napi::Object o = Napi::Object::New(env);
        o.Set("sourceId", Napi::Number::New(env, statuses[i].sourceId));
        o.Set("filePath", Napi::String::New(env, statuses[i].filePath));
        o.Set("found",    Napi::Boolean::New(env, statuses[i].found));
        o.Set("error",    Napi::String::New(env, statuses[i].error));
        arr.Set(static_cast<uint32_t>(i), o);
    }
    log.done(std::to_string(statuses.size()) + " sources");
    return arr;
}

Napi::Value Project_GetInfo(const Napi::CallbackInfo& info)
{
    Napi::Env env = info.Env();
    if (!g_projectManager) {
        Napi::Error::New(env, "Engine not initialised.").ThrowAsJavaScriptException();
        return env.Undefined();
    }

    Napi::Object o = Napi::Object::New(env);
    o.Set("projectDir",  Napi::String::New(env, g_projectManager->getProjectDir()));
    o.Set("proxiesDir",  Napi::String::New(env, g_projectManager->getProxiesDir()));
    o.Set("exportsDir",  Napi::String::New(env, g_projectManager->getExportsDir()));
    o.Set("swappedDir",  Napi::String::New(env, g_projectManager->getSwappedDir()));
    return o;
}

// ─────────────────────────────────────────────────────────────────────────────
// Phase 1 — Timeline queries
// ─────────────────────────────────────────────────────────────────────────────

Napi::Value Timeline_GetBPM(const Napi::CallbackInfo& info)
{
    Napi::Env env = info.Env();
    if (!g_timeline) {
        Napi::Error::New(env, "Engine not initialised.").ThrowAsJavaScriptException();
        return env.Undefined();
    }
    return Napi::Number::New(env, g_timeline->getBPM());
}

// timeline_getDeclickMs() → number
Napi::Value Timeline_GetDeclickMs(const Napi::CallbackInfo& info)
{
    Napi::Env env = info.Env();
    if (!g_timeline) {
        Napi::Error::New(env, "Engine not initialised.").ThrowAsJavaScriptException();
        return env.Undefined();
    }
    return Napi::Number::New(env, g_timeline->getDeclickMs());
}

// timeline_setDeclickMs(ms: number) → void
// Intentionally bypasses UndoManager — clip boundary fade is a render preference,
// not a creative timeline edit. Applies immediately to the audio thread via atomic.
void Timeline_SetDeclickMs(const Napi::CallbackInfo& info)
{
    Napi::Env env = info.Env();
    if (!isInitialised() || !g_timeline) {
        Napi::Error::New(env, "Engine not initialised.").ThrowAsJavaScriptException();
        return;
    }
    if (info.Length() < 1 || !info[0].IsNumber()) {
        Napi::TypeError::New(env, "timeline_setDeclickMs(ms: number)")
            .ThrowAsJavaScriptException();
        return;
    }
    const double ms = info[0].As<Napi::Number>().DoubleValue();
    g_timeline->setDeclickMs(ms);
    syncClipFadeToMixEngine();
}

Napi::Value Timeline_GetSources(const Napi::CallbackInfo& info)
{
    Napi::Env env = info.Env();
    if (!g_timeline) {
        Napi::Error::New(env, "Engine not initialised.").ThrowAsJavaScriptException();
        return env.Undefined();
    }

    auto sources = g_timeline->getAllSources();
    Napi::Array arr = Napi::Array::New(env, sources.size());
    for (size_t i = 0; i < sources.size(); ++i) {
        const SourceMedia& s = *sources[i];
        Napi::Object o = Napi::Object::New(env);
        o.Set("id",         Napi::Number::New(env, s.id));
        o.Set("filePath",   Napi::String::New(env, s.filePath));
        o.Set("fileName",   Napi::String::New(env, s.fileName));
        o.Set("duration",   Napi::Number::New(env, s.duration));
        o.Set("width",      Napi::Number::New(env, s.width));
        o.Set("height",     Napi::Number::New(env, s.height));
        o.Set("fps",        Napi::Number::New(env, s.fps));
        o.Set("hasVideo",   Napi::Boolean::New(env, s.hasVideo));
        o.Set("proxyReady", Napi::Boolean::New(env, s.proxyReady));
        arr.Set(static_cast<uint32_t>(i), o);
    }
    return arr;
}

Napi::Value Timeline_GetRegions(const Napi::CallbackInfo& info)
{
    Napi::Env env = info.Env();
    if (!g_timeline) {
        Napi::Error::New(env, "Engine not initialised.").ThrowAsJavaScriptException();
        return env.Undefined();
    }

    auto regions = g_timeline->getAllRegions();
    Napi::Array arr = Napi::Array::New(env, regions.size());
    for (size_t i = 0; i < regions.size(); ++i)
        arr.Set(static_cast<uint32_t>(i), regionToJs(env, *regions[i]));
    return arr;
}

Napi::Value Timeline_GetRegionsByLabel(const Napi::CallbackInfo& info)
{
    Napi::Env env = info.Env();
    if (!g_timeline) {
        Napi::Error::New(env, "Engine not initialised.").ThrowAsJavaScriptException();
        return env.Undefined();
    }
    if (info.Length() < 1 || !info[0].IsString()) {
        Napi::TypeError::New(env, "timeline_getRegionsByLabel(label: string)")
            .ThrowAsJavaScriptException();
        return env.Undefined();
    }

    SampleLabel label = stringToSampleLabel(info[0].As<Napi::String>().Utf8Value());
    auto regions = g_timeline->getRegionsByLabel(label);
    Napi::Array arr = Napi::Array::New(env, regions.size());
    for (size_t i = 0; i < regions.size(); ++i)
        arr.Set(static_cast<uint32_t>(i), regionToJs(env, *regions[i]));
    return arr;
}

Napi::Value Timeline_GetTracks(const Napi::CallbackInfo& info)
{
    IPC_TIME_START;
    IPC_GAP_CHECK("timeline_getTracks");
    Napi::Env env = info.Env();
    if (!g_timeline) {
        Napi::Error::New(env, "Engine not initialised.").ThrowAsJavaScriptException();
        return env.Undefined();
    }

    auto tracks = g_timeline->getAllTracks();
    Napi::Array arr = Napi::Array::New(env, tracks.size());
    for (size_t i = 0; i < tracks.size(); ++i)
        arr.Set(static_cast<uint32_t>(i), trackToJs(env, *tracks[i]));
    IPC_TIME_END("timeline_getTracks");
    return arr;
}

Napi::Value Timeline_GetClips(const Napi::CallbackInfo& info)
{
    Napi::Env env = info.Env();
    if (!g_timeline) {
        Napi::Error::New(env, "Engine not initialised.").ThrowAsJavaScriptException();
        return env.Undefined();
    }

    auto clips = g_timeline->getAllClips();
    Napi::Array arr = Napi::Array::New(env, clips.size());
    for (size_t i = 0; i < clips.size(); ++i)
        arr.Set(static_cast<uint32_t>(i), clipToJs(env, *clips[i]));
    return arr;
}

Napi::Value Timeline_GetClipsOnTrack(const Napi::CallbackInfo& info)
{
    Napi::Env env = info.Env();
    if (!g_timeline) {
        Napi::Error::New(env, "Engine not initialised.").ThrowAsJavaScriptException();
        return env.Undefined();
    }
    if (info.Length() < 1 || !info[0].IsNumber()) {
        Napi::TypeError::New(env, "timeline_getClipsOnTrack(trackId: number)")
            .ThrowAsJavaScriptException();
        return env.Undefined();
    }

    int trackId = info[0].As<Napi::Number>().Int32Value();
    auto clips = g_timeline->getClipsOnTrack(trackId);
    Napi::Array arr = Napi::Array::New(env, clips.size());
    for (size_t i = 0; i < clips.size(); ++i)
        arr.Set(static_cast<uint32_t>(i), clipToJs(env, *clips[i]));
    return arr;
}

Napi::Value Timeline_GetClipsInRange(const Napi::CallbackInfo& info)
{
    Napi::Env env = info.Env();
    if (!g_timeline) {
        Napi::Error::New(env, "Engine not initialised.").ThrowAsJavaScriptException();
        return env.Undefined();
    }
    if (info.Length() < 2 || !info[0].IsNumber() || !info[1].IsNumber()) {
        Napi::TypeError::New(env, "timeline_getClipsInRange(startBeat: number, endBeat: number)")
            .ThrowAsJavaScriptException();
        return env.Undefined();
    }

    double startBeat = info[0].As<Napi::Number>().DoubleValue();
    double endBeat   = info[1].As<Napi::Number>().DoubleValue();

    auto clips = g_timeline->getClipsInRange(
        TickTime::fromBeats(startBeat),
        TickTime::fromBeats(endBeat));

    Napi::Array arr = Napi::Array::New(env, clips.size());
    for (size_t i = 0; i < clips.size(); ++i)
        arr.Set(static_cast<uint32_t>(i), clipToJs(env, *clips[i]));
    return arr;
}

// ─────────────────────────────────────────────────────────────────────────────
// Phase 1 — Timeline mutations (all via UndoManager)
// ─────────────────────────────────────────────────────────────────────────────

// timeline_setBPM(bpm) — undo-tracked BPM change, syncs transport
void Timeline_SetBPM(const Napi::CallbackInfo& info)
{
    Napi::Env env = info.Env();
    if (!isInitialised() || !g_timeline || !g_undoManager) {
        Napi::Error::New(env, "Engine not initialised.").ThrowAsJavaScriptException();
        return;
    }
    if (info.Length() < 1 || !info[0].IsNumber()) {
        Napi::TypeError::New(env, "timeline_setBPM(bpm: number)").ThrowAsJavaScriptException();
        return;
    }
    double bpm = info[0].As<Napi::Number>().DoubleValue();
    BridgeCallLog log("timeline.setBPM");

    g_undoManager->execute(std::make_unique<SetBPMCommand>(bpm, *g_timeline), *g_timeline);
    // Sync live transport to match the timeline's committed BPM
    audioEngine->getTransport().setBPM(g_timeline->getBPM());
    // Invalidate all stretched clips on BPM change. Required because the render
    // loop never submits new jobs on cache miss — only explicit invalidation
    // triggers job resubmission. Without this, stretched clips fall back to raw
    // PCM permanently after a tempo change.
    // tempoLocked clips also have their stretchRatio rescaled by SetBPMCommand,
    // so their new job picks up both the corrected ratio and the new durationSamples.
    if (audioEngine && g_timeline) {
        for (const Clip* c : g_timeline->getAllClips()) {
            if (!c) continue;
            const bool stretched = (c->pitchOffset != 0 || c->pitchOffsetCents != 0
                                 || c->reversed || c->stretchRatio != 1.0);
            if (stretched)
                audioEngine->getMixEngine().invalidateClipCache(c->id, "setBPM");
        }
    }
    log.done(std::to_string(bpm));
}

// timeline_getTempoLocked() → boolean
Napi::Value Timeline_GetTempoLocked(const Napi::CallbackInfo& info)
{
    Napi::Env env = info.Env();
    if (!isInitialised() || !g_timeline) {
        Napi::Error::New(env, "Engine not initialised.").ThrowAsJavaScriptException();
        return env.Undefined();
    }
    return Napi::Boolean::New(env, g_timeline->getTempoLocked());
}

// timeline_setTempoLocked(locked: boolean) → void
void Timeline_SetTempoLocked(const Napi::CallbackInfo& info)
{
    Napi::Env env = info.Env();
    if (!isInitialised() || !g_timeline) {
        Napi::Error::New(env, "Engine not initialised.").ThrowAsJavaScriptException();
        return;
    }
    if (info.Length() < 1 || !info[0].IsBoolean()) {
        Napi::TypeError::New(env, "timeline_setTempoLocked(locked: boolean)")
            .ThrowAsJavaScriptException();
        return;
    }
    g_timeline->setTempoLocked(info[0].As<Napi::Boolean>().Value());
}

// ─── Grid Layout bridge functions ─────────────────────────────────────────────

// timeline_getGridLayout() → { columns, rows, slots, chorusTrackId, ... }
Napi::Value Timeline_GetGridLayout(const Napi::CallbackInfo& info)
{
    Napi::Env env = info.Env();
    if (!g_timeline) {
        Napi::Error::New(env, "Engine not initialised.").ThrowAsJavaScriptException();
        return env.Undefined();
    }
    return gridLayoutToJs(env, g_timeline->getGridLayout());
}

// timeline_setGridLayout(layout) — replaces entire grid layout, undo-tracked
void Timeline_SetGridLayout(const Napi::CallbackInfo& info)
{
    Napi::Env env = info.Env();
    if (!isInitialised() || !g_timeline || !g_undoManager) {
        Napi::Error::New(env, "Engine not initialised.").ThrowAsJavaScriptException();
        return;
    }
    if (info.Length() < 1 || !info[0].IsObject()) {
        Napi::TypeError::New(env, "timeline_setGridLayout(layout: object)")
            .ThrowAsJavaScriptException();
        return;
    }
    BridgeCallLog log("timeline.setGridLayout");
    GridLayout layout = jsToGridLayout(info[0].As<Napi::Object>());
    {
        std::lock_guard<std::mutex> lock(syncEventsMutex);
        g_undoManager->execute(
            std::make_unique<SetGridLayoutCommand>(std::move(layout), *g_timeline),
            *g_timeline);
    }
    log.done();
}

// timeline_assignTrackToGrid(trackId, gridX, gridY, spanX, spanY)
void Timeline_AssignTrackToGrid(const Napi::CallbackInfo& info)
{
    Napi::Env env = info.Env();
    if (!isInitialised() || !g_timeline || !g_undoManager) {
        Napi::Error::New(env, "Engine not initialised.").ThrowAsJavaScriptException();
        return;
    }
    if (info.Length() < 5 || !info[0].IsNumber() || !info[1].IsNumber() ||
        !info[2].IsNumber() || !info[3].IsNumber() || !info[4].IsNumber()) {
        Napi::TypeError::New(env,
            "timeline_assignTrackToGrid(trackId, gridX, gridY, spanX, spanY)")
            .ThrowAsJavaScriptException();
        return;
    }
    int trackId = info[0].As<Napi::Number>().Int32Value();
    int gridX   = info[1].As<Napi::Number>().Int32Value();
    int gridY   = info[2].As<Napi::Number>().Int32Value();
    int spanX   = info[3].As<Napi::Number>().Int32Value();
    int spanY   = info[4].As<Napi::Number>().Int32Value();
    BridgeCallLog log("timeline.assignTrackToGrid");
    {
        std::lock_guard<std::mutex> lock(syncEventsMutex);
        g_undoManager->execute(
            std::make_unique<AssignTrackToGridCommand>(trackId, gridX, gridY, spanX, spanY, *g_timeline),
            *g_timeline);
    }

    // Track is now on a normal grid cell (AssignTrackToGridCommand never
    // targets chorus/crash — those use SetChorusTrack / SetCrashOverlay).
    // Enqueue proxies for every unique region referenced by clips on this
    // track. maybeEnqueueRegionProxy is idempotent (skips regions that
    // already have a valid on-disk proxy), so no-op for unchanged regions.
    {
        std::unordered_set<int> seenRegions;
        for (const Clip* c : g_timeline->getAllClips()) {
            if (!c || c->trackId != trackId) continue;
            if (!seenRegions.insert(c->regionId).second) continue;
            maybeEnqueueRegionProxy(c->regionId, trackId);
        }
    }

    log.done(std::to_string(trackId));
}

// timeline_assignTrackToGridWithZOrder(trackId, gridX, gridY, spanX, spanY, zOrder)
// Atomic placement with explicit zOrder — used by drag-to-place so the new
// slot can land on top in a single undo step.
void Timeline_AssignTrackToGridWithZOrder(const Napi::CallbackInfo& info)
{
    Napi::Env env = info.Env();
    if (!isInitialised() || !g_timeline || !g_undoManager) {
        Napi::Error::New(env, "Engine not initialised.").ThrowAsJavaScriptException();
        return;
    }
    if (info.Length() < 6 || !info[0].IsNumber() || !info[1].IsNumber() ||
        !info[2].IsNumber() || !info[3].IsNumber() || !info[4].IsNumber() ||
        !info[5].IsNumber()) {
        Napi::TypeError::New(env,
            "timeline_assignTrackToGridWithZOrder(trackId, gridX, gridY, spanX, spanY, zOrder)")
            .ThrowAsJavaScriptException();
        return;
    }
    int trackId = info[0].As<Napi::Number>().Int32Value();
    int gridX   = info[1].As<Napi::Number>().Int32Value();
    int gridY   = info[2].As<Napi::Number>().Int32Value();
    int spanX   = info[3].As<Napi::Number>().Int32Value();
    int spanY   = info[4].As<Napi::Number>().Int32Value();
    int zOrder  = info[5].As<Napi::Number>().Int32Value();
    BridgeCallLog log("timeline.assignTrackToGridWithZOrder");
    {
        std::lock_guard<std::mutex> lock(syncEventsMutex);
        g_undoManager->execute(
            std::make_unique<AssignTrackToGridCommand>(trackId, gridX, gridY,
                                                       spanX, spanY, zOrder,
                                                       *g_timeline),
            *g_timeline);
    }

    // Mirror the proxy enqueue side effect from the standard assign path —
    // ensures clips on this track have on-disk proxies for the preview.
    {
        std::unordered_set<int> seenRegions;
        for (const Clip* c : g_timeline->getAllClips()) {
            if (!c || c->trackId != trackId) continue;
            if (!seenRegions.insert(c->regionId).second) continue;
            maybeEnqueueRegionProxy(c->regionId, trackId);
        }
    }

    log.done(std::to_string(trackId));
}

// timeline_removeTrackFromGrid(trackId)
void Timeline_RemoveTrackFromGrid(const Napi::CallbackInfo& info)
{
    Napi::Env env = info.Env();
    if (!isInitialised() || !g_timeline || !g_undoManager) {
        Napi::Error::New(env, "Engine not initialised.").ThrowAsJavaScriptException();
        return;
    }
    if (info.Length() < 1 || !info[0].IsNumber()) {
        Napi::TypeError::New(env, "timeline_removeTrackFromGrid(trackId: number)")
            .ThrowAsJavaScriptException();
        return;
    }
    int trackId = info[0].As<Napi::Number>().Int32Value();
    BridgeCallLog log("timeline.removeTrackFromGrid");
    {
        std::lock_guard<std::mutex> lock(syncEventsMutex);
        g_undoManager->execute(
            std::make_unique<RemoveTrackFromGridCommand>(trackId, *g_timeline),
            *g_timeline);
    }
    log.done(std::to_string(trackId));
}

// timeline_setChorusTrack(trackId) — -1 to disable
void Timeline_SetChorusTrack(const Napi::CallbackInfo& info)
{
    Napi::Env env = info.Env();
    if (!isInitialised() || !g_timeline || !g_undoManager) {
        Napi::Error::New(env, "Engine not initialised.").ThrowAsJavaScriptException();
        return;
    }
    if (info.Length() < 1 || !info[0].IsNumber()) {
        Napi::TypeError::New(env, "timeline_setChorusTrack(trackId: number)")
            .ThrowAsJavaScriptException();
        return;
    }
    int trackId = info[0].As<Napi::Number>().Int32Value();
    BridgeCallLog log("timeline.setChorusTrack");
    {
        std::lock_guard<std::mutex> lock(syncEventsMutex);
        g_undoManager->execute(
            std::make_unique<SetChorusTrackCommand>(trackId, *g_timeline),
            *g_timeline);
    }

    // Track is now the chorus track — chorus always streams from the
    // original. Invalidate any existing region proxies on this track so we
    // stop wasting disk & decoder slots on them.
    if (trackId >= 0) {
        std::unordered_set<int> seenRegions;
        for (const Clip* c : g_timeline->getAllClips()) {
            if (!c || c->trackId != trackId) continue;
            if (!seenRegions.insert(c->regionId).second) continue;
            invalidateRegionProxy(c->regionId);
        }
    }

    log.done(std::to_string(trackId));
}

// timeline_setCrashOverlay(enabled, trackId, opacity)
void Timeline_SetCrashOverlay(const Napi::CallbackInfo& info)
{
    Napi::Env env = info.Env();
    if (!isInitialised() || !g_timeline || !g_undoManager) {
        Napi::Error::New(env, "Engine not initialised.").ThrowAsJavaScriptException();
        return;
    }
    if (info.Length() < 3 || !info[0].IsBoolean() || !info[1].IsNumber() || !info[2].IsNumber()) {
        Napi::TypeError::New(env,
            "timeline_setCrashOverlay(enabled: boolean, trackId: number, opacity: number)")
            .ThrowAsJavaScriptException();
        return;
    }
    bool  enabled = info[0].As<Napi::Boolean>().Value();
    int   trackId = info[1].As<Napi::Number>().Int32Value();
    float opacity = info[2].As<Napi::Number>().FloatValue();
    BridgeCallLog log("timeline.setCrashOverlay");
    {
        std::lock_guard<std::mutex> lock(syncEventsMutex);
        g_undoManager->execute(
            std::make_unique<SetCrashOverlayCommand>(enabled, trackId, opacity, *g_timeline),
            *g_timeline);
    }

    // Crash overlay always streams from the original — drop any existing
    // region proxies for clips on the newly-designated crash track.
    if (enabled && trackId >= 0) {
        std::unordered_set<int> seenRegions;
        for (const Clip* c : g_timeline->getAllClips()) {
            if (!c || c->trackId != trackId) continue;
            if (!seenRegions.insert(c->regionId).second) continue;
            invalidateRegionProxy(c->regionId);
        }
    }

    log.done(std::string(enabled ? "on" : "off") + " track=" + std::to_string(trackId));
}

// timeline_setPreviewFps(fps)
void Timeline_SetPreviewFps(const Napi::CallbackInfo& info)
{
    Napi::Env env = info.Env();
    if (!isInitialised() || !g_timeline || !g_undoManager) {
        Napi::Error::New(env, "Engine not initialised.").ThrowAsJavaScriptException();
        return;
    }
    if (info.Length() < 1 || !info[0].IsNumber()) {
        Napi::TypeError::New(env, "timeline_setPreviewFps(fps: number)")
            .ThrowAsJavaScriptException();
        return;
    }
    int fps = info[0].As<Napi::Number>().Int32Value();
    BridgeCallLog log("timeline.setPreviewFps");
    {
        std::lock_guard<std::mutex> lock(syncEventsMutex);
        g_undoManager->execute(
            std::make_unique<SetPreviewFpsCommand>(fps, *g_timeline),
            *g_timeline);
    }
    log.done(std::to_string(fps));
}

// timeline_setTrackMuted(trackId, muted) — undo-tracked mute toggle
void Timeline_SetTrackMuted(const Napi::CallbackInfo& info)
{
    Napi::Env env = info.Env();
    if (!isInitialised() || !g_timeline || !g_undoManager) {
        Napi::Error::New(env, "Engine not initialised.").ThrowAsJavaScriptException();
        return;
    }
    if (info.Length() < 2 || !info[0].IsNumber() || !info[1].IsBoolean()) {
        Napi::TypeError::New(env, "timeline_setTrackMuted(trackId: number, muted: boolean)")
            .ThrowAsJavaScriptException();
        return;
    }
    int  trackId = info[0].As<Napi::Number>().Int32Value();
    bool muted   = info[1].As<Napi::Boolean>().Value();
    BridgeCallLog log("timeline.setTrackMuted");

    g_undoManager->execute(
        std::make_unique<SetTrackMutedCommand>(trackId, muted, *g_timeline),
        *g_timeline);
    // Grid compositor checks track mute live per tick, so no rebuild needed.
    log.done(std::to_string(trackId) + "=" + (muted ? "1" : "0"));
}

// timeline_setTrackVisualOnly(trackId, visualOnly) — undo-tracked visual-only toggle
void Timeline_SetTrackVisualOnly(const Napi::CallbackInfo& info)
{
    Napi::Env env = info.Env();
    if (!isInitialised() || !g_timeline || !g_undoManager) {
        Napi::Error::New(env, "Engine not initialised.").ThrowAsJavaScriptException();
        return;
    }
    if (info.Length() < 2 || !info[0].IsNumber() || !info[1].IsBoolean()) {
        Napi::TypeError::New(env, "timeline_setTrackVisualOnly(trackId: number, visualOnly: boolean)")
            .ThrowAsJavaScriptException();
        return;
    }
    int  trackId    = info[0].As<Napi::Number>().Int32Value();
    bool visualOnly = info[1].As<Napi::Boolean>().Value();
    BridgeCallLog log("timeline.setTrackVisualOnly");

    g_undoManager->execute(
        std::make_unique<SetTrackVisualOnlyCommand>(trackId, visualOnly, *g_timeline),
        *g_timeline);
    log.done(std::to_string(trackId) + "=" + (visualOnly ? "1" : "0"));
}

// timeline_setTrackSolo(trackId, solo) — undo-tracked solo toggle (audio only)
void Timeline_SetTrackSolo(const Napi::CallbackInfo& info)
{
    Napi::Env env = info.Env();
    if (!isInitialised() || !g_timeline || !g_undoManager) {
        Napi::Error::New(env, "Engine not initialised.").ThrowAsJavaScriptException();
        return;
    }
    if (info.Length() < 2 || !info[0].IsNumber() || !info[1].IsBoolean()) {
        Napi::TypeError::New(env, "timeline_setTrackSolo(trackId: number, solo: boolean)")
            .ThrowAsJavaScriptException();
        return;
    }
    int  trackId = info[0].As<Napi::Number>().Int32Value();
    bool solo    = info[1].As<Napi::Boolean>().Value();
    BridgeCallLog log("timeline.setTrackSolo");

    g_undoManager->execute(
        std::make_unique<SetTrackSoloCommand>(trackId, solo, *g_timeline),
        *g_timeline);
    // Solo does not affect video — do NOT rebuild video events.
    log.done(std::to_string(trackId) + "=" + (solo ? "1" : "0"));
}

// timeline_setTrackName(trackId, name) — undo-tracked rename
void Timeline_SetTrackName(const Napi::CallbackInfo& info)
{
    Napi::Env env = info.Env();
    if (!isInitialised() || !g_timeline || !g_undoManager) {
        Napi::Error::New(env, "Engine not initialised.").ThrowAsJavaScriptException();
        return;
    }
    if (info.Length() < 2 || !info[0].IsNumber() || !info[1].IsString()) {
        Napi::TypeError::New(env, "timeline_setTrackName(trackId: number, name: string)")
            .ThrowAsJavaScriptException();
        return;
    }
    int         trackId = info[0].As<Napi::Number>().Int32Value();
    std::string name    = info[1].As<Napi::String>().Utf8Value();
    BridgeCallLog log("timeline.setTrackName");

    g_undoManager->execute(
        std::make_unique<SetTrackNameCommand>(trackId, name, *g_timeline),
        *g_timeline);
    log.done(std::to_string(trackId) + "=\"" + name + "\"");
}

// timeline_setPatternName(patternId, name) — undo-tracked rename
void Timeline_SetPatternName(const Napi::CallbackInfo& info)
{
    Napi::Env env = info.Env();
    if (!isInitialised() || !g_timeline || !g_undoManager) {
        Napi::Error::New(env, "Engine not initialised.").ThrowAsJavaScriptException();
        return;
    }
    if (info.Length() < 2 || !info[0].IsNumber() || !info[1].IsString()) {
        Napi::TypeError::New(env, "timeline_setPatternName(patternId: number, name: string)")
            .ThrowAsJavaScriptException();
        return;
    }
    int         patternId = info[0].As<Napi::Number>().Int32Value();
    std::string name      = info[1].As<Napi::String>().Utf8Value();
    BridgeCallLog log("timeline.setPatternName");

    g_undoManager->execute(
        std::make_unique<SetPatternNameCommand>(patternId, name, *g_timeline),
        *g_timeline);
    log.done(std::to_string(patternId) + "=\"" + name + "\"");
}

// timeline_setPatternRegion(patternId, regionId) — undo-tracked region change
void Timeline_SetPatternRegion(const Napi::CallbackInfo& info)
{
    Napi::Env env = info.Env();
    if (!isInitialised() || !g_timeline || !g_undoManager) {
        Napi::Error::New(env, "Engine not initialised.").ThrowAsJavaScriptException();
        return;
    }
    if (info.Length() < 2 || !info[0].IsNumber() || !info[1].IsNumber()) {
        Napi::TypeError::New(env, "timeline_setPatternRegion(patternId: number, regionId: number)")
            .ThrowAsJavaScriptException();
        return;
    }
    int patternId = info[0].As<Napi::Number>().Int32Value();
    int regionId  = info[1].As<Napi::Number>().Int32Value();
    BridgeCallLog log("timeline.setPatternRegion");

    g_undoManager->execute(
        std::make_unique<SetPatternRegionCommand>(patternId, regionId, *g_timeline),
        *g_timeline);
    refreshSamplerForPattern(patternId);
    log.done(std::to_string(patternId) + " region=" + std::to_string(regionId));
}

// timeline_addTrack({ name, volume?, pan?, muted?, solo?, order? }) → id
Napi::Value Timeline_AddTrack(const Napi::CallbackInfo& info)
{
    Napi::Env env = info.Env();
    if (!isInitialised() || !g_timeline || !g_undoManager) {
        Napi::Error::New(env, "Engine not initialised.").ThrowAsJavaScriptException();
        return env.Undefined();
    }
    if (info.Length() < 1 || !info[0].IsObject()) {
        Napi::TypeError::New(env, "timeline_addTrack({ name, volume?, pan?, muted?, solo?, order? })")
            .ThrowAsJavaScriptException();
        return env.Undefined();
    }
    BridgeCallLog log("timeline.addTrack");

    TrackInfo t = jsToTrack(info[0].As<Napi::Object>());
    g_undoManager->execute(std::make_unique<AddTrackCommand>(t), *g_timeline);

    // The newly added track always has the highest ID in the sorted map
    auto tracks = g_timeline->getAllTracks();
    int newId = tracks.empty() ? -1 : tracks.back()->id;
    log.done(std::to_string(newId));
    return Napi::Number::New(env, newId);
}

// timeline_removeTrack(id) — cascades to clips on that track
void Timeline_RemoveTrack(const Napi::CallbackInfo& info)
{
    Napi::Env env = info.Env();
    if (!isInitialised() || !g_timeline || !g_undoManager) {
        Napi::Error::New(env, "Engine not initialised.").ThrowAsJavaScriptException();
        return;
    }
    if (info.Length() < 1 || !info[0].IsNumber()) {
        Napi::TypeError::New(env, "timeline_removeTrack(id: number)").ThrowAsJavaScriptException();
        return;
    }
    int id = info[0].As<Napi::Number>().Int32Value();
    BridgeCallLog log("timeline.removeTrack");
    {
        // Cascades into grid slots / chorus / crash — hold syncEventsMutex
        // so the video thread sees a consistent GridLayout.
        std::lock_guard<std::mutex> lock(syncEventsMutex);
        g_undoManager->execute(std::make_unique<RemoveTrackCommand>(id, *g_timeline), *g_timeline);
    }
    // Close any open plugin editor windows for this track before tearing it down.
    if (audioEngine) audioEngine->getMixEngine().closePluginEditorsForTrack(id);
    // Release every sampler pair this track owned (no-op if it was a clip track).
    if (audioEngine) audioEngine->getMixEngine().unloadSamplersForTrack(id);
    log.done();
}

// timeline_addClip({ trackId, regionId, positionTicks, durationTicks,
//                    regionOffsetTicks?, syllableIndex?, velocity?, pitchOffset?,
//                    pitchOffsetCents?, reversed?, stretchRatio?, stretchMethod?, formantPreserve?,
//                    fadeInPercent?, fadeOutPercent?, fadeInX1?, fadeInY1?, fadeInX2?, fadeInY2?,
//                    fadeOutX1?, fadeOutY1?, fadeOutX2?, fadeOutY2? }) → id
Napi::Value Timeline_AddClip(const Napi::CallbackInfo& info)
{
    Napi::Env env = info.Env();
    if (!isInitialised() || !g_timeline || !g_undoManager) {
        Napi::Error::New(env, "Engine not initialised.").ThrowAsJavaScriptException();
        return env.Undefined();
    }
    if (info.Length() < 1 || !info[0].IsObject()) {
        Napi::TypeError::New(env, "timeline_addClip({ trackId, regionId, positionTicks, durationTicks, velocity? })")
            .ThrowAsJavaScriptException();
        return env.Undefined();
    }
    BridgeCallLog log("timeline.addClip");

    Napi::Object o = info[0].As<Napi::Object>();
    Clip clip;
    clip.trackId         = o.Get("trackId").As<Napi::Number>().Int32Value();
    clip.regionId        = o.Get("regionId").As<Napi::Number>().Int32Value();
    clip.position.ticks  = static_cast<int64_t>(o.Get("positionTicks").As<Napi::Number>().DoubleValue());
    clip.duration.ticks  = static_cast<int64_t>(o.Get("durationTicks").As<Napi::Number>().DoubleValue());
    if (o.Has("regionOffsetTicks") && o.Get("regionOffsetTicks").IsNumber())
        clip.regionOffset.ticks = static_cast<int64_t>(o.Get("regionOffsetTicks").As<Napi::Number>().DoubleValue());
    if (o.Has("syllableIndex") && o.Get("syllableIndex").IsNumber())
        clip.syllableIndex = o.Get("syllableIndex").As<Napi::Number>().Int32Value();
    if (o.Has("pitchOffset") && o.Get("pitchOffset").IsNumber())
        clip.pitchOffset = o.Get("pitchOffset").As<Napi::Number>().Int32Value();
    if (o.Has("velocity") && o.Get("velocity").IsNumber())
        clip.velocity = o.Get("velocity").As<Napi::Number>().FloatValue();
    if (o.Has("pitchOffsetCents") && o.Get("pitchOffsetCents").IsNumber()) {
        int cents = o.Get("pitchOffsetCents").As<Napi::Number>().Int32Value();
        clip.pitchOffsetCents = std::max(-99, std::min(99, cents));
    }
    if (o.Has("reversed") && o.Get("reversed").IsBoolean())
        clip.reversed = o.Get("reversed").As<Napi::Boolean>().Value();
    if (o.Has("stretchRatio") && o.Get("stretchRatio").IsNumber()) {
        double ratio = o.Get("stretchRatio").As<Napi::Number>().DoubleValue();
        clip.stretchRatio = (ratio <= 0.0) ? 1.0 : ratio;
    }
    if (o.Has("stretchMethod") && o.Get("stretchMethod").IsNumber()) {
        int sm = o.Get("stretchMethod").As<Napi::Number>().Int32Value();
        clip.stretchMethod = static_cast<StretchMethod>(
            (sm >= 0 && sm <= 5) ? sm : 0 /*Global*/);
    }
    if (o.Has("formantPreserve") && o.Get("formantPreserve").IsBoolean())
        clip.formantPreserve = o.Get("formantPreserve").As<Napi::Boolean>().Value();

    // Fade envelope — optional, mirrors Timeline_SetClipParams field handling.
    // Legacy tick fields are converted to percentages using the clip duration.
    if (o.Has("fadeInPercent") && o.Get("fadeInPercent").IsNumber())
        clip.fadeInPercent = o.Get("fadeInPercent").As<Napi::Number>().FloatValue();
    else if (o.Has("fadeInTicks") && o.Get("fadeInTicks").IsNumber())
        clip.fadeInPercent = legacyFadeTicksToPercent(
            o.Get("fadeInTicks").As<Napi::Number>().FloatValue(), clip.duration.ticks);
    if (o.Has("fadeOutPercent") && o.Get("fadeOutPercent").IsNumber())
        clip.fadeOutPercent = o.Get("fadeOutPercent").As<Napi::Number>().FloatValue();
    else if (o.Has("fadeOutTicks") && o.Get("fadeOutTicks").IsNumber())
        clip.fadeOutPercent = legacyFadeTicksToPercent(
            o.Get("fadeOutTicks").As<Napi::Number>().FloatValue(), clip.duration.ticks);
    normalizeClipFadePercents(clip);
    if (o.Has("fadeInX1")  && o.Get("fadeInX1").IsNumber())  clip.fadeInX1  = o.Get("fadeInX1").As<Napi::Number>().FloatValue();
    if (o.Has("fadeInY1")  && o.Get("fadeInY1").IsNumber())  clip.fadeInY1  = o.Get("fadeInY1").As<Napi::Number>().FloatValue();
    if (o.Has("fadeInX2")  && o.Get("fadeInX2").IsNumber())  clip.fadeInX2  = o.Get("fadeInX2").As<Napi::Number>().FloatValue();
    if (o.Has("fadeInY2")  && o.Get("fadeInY2").IsNumber())  clip.fadeInY2  = o.Get("fadeInY2").As<Napi::Number>().FloatValue();
    if (o.Has("fadeOutX1") && o.Get("fadeOutX1").IsNumber()) clip.fadeOutX1 = o.Get("fadeOutX1").As<Napi::Number>().FloatValue();
    if (o.Has("fadeOutY1") && o.Get("fadeOutY1").IsNumber()) clip.fadeOutY1 = o.Get("fadeOutY1").As<Napi::Number>().FloatValue();
    if (o.Has("fadeOutX2") && o.Get("fadeOutX2").IsNumber()) clip.fadeOutX2 = o.Get("fadeOutX2").As<Napi::Number>().FloatValue();
    if (o.Has("fadeOutY2") && o.Get("fadeOutY2").IsNumber()) clip.fadeOutY2 = o.Get("fadeOutY2").As<Napi::Number>().FloatValue();

#ifdef XLETH_DEBUG
    // Per-field "present/defaulted" map — reveals whether a missing JS key
    // or a wrong type (IsNumber/IsBoolean guard failure) caused a default.
    auto presence = [&](const char* key) -> const char* {
        if (!o.Has(key))                    return "MISSING";
        auto v = o.Get(key);
        if (v.IsUndefined() || v.IsNull())  return "undef/null";
        if (v.IsNumber())                   return "number";
        if (v.IsBoolean())                  return "bool";
        return "OTHER-TYPE";
    };
    fprintf(stderr,
        "[XlethAddon_AddClip] presence: regionOffsetTicks=%s syllableIndex=%s "
        "pitchOffset=%s pitchOffsetCents=%s reversed=%s stretchRatio=%s "
        "stretchMethod=%s formantPreserve=%s velocity=%s "
        "fadeInPercent=%s fadeOutPercent=%s legacyFadeInTicks=%s legacyFadeOutTicks=%s "
        "fadeInX1=%s fadeInY1=%s fadeInX2=%s fadeInY2=%s "
        "fadeOutX1=%s fadeOutY1=%s fadeOutX2=%s fadeOutY2=%s\n",
        presence("regionOffsetTicks"), presence("syllableIndex"),
        presence("pitchOffset"),       presence("pitchOffsetCents"),
        presence("reversed"),          presence("stretchRatio"),
        presence("stretchMethod"),     presence("formantPreserve"),
        presence("velocity"),
        presence("fadeInPercent"),     presence("fadeOutPercent"),
        presence("fadeInTicks"),       presence("fadeOutTicks"),
        presence("fadeInX1"),          presence("fadeInY1"),
        presence("fadeInX2"),          presence("fadeInY2"),
        presence("fadeOutX1"),         presence("fadeOutY1"),
        presence("fadeOutX2"),         presence("fadeOutY2"));
    fprintf(stderr,
        "[XlethAddon_AddClip] received: trackId=%d regionId=%d pos=%lld dur=%lld "
        "pitchOffset=%d pitchCents=%d reversed=%d stretchRatio=%.3f "
        "stretchMethod=%d formantPreserve=%d velocity=%.3f "
        "fadeIn=%.2f fadeOut=%.2f bezierIn=[%.2f,%.2f,%.2f,%.2f] "
        "bezierOut=[%.2f,%.2f,%.2f,%.2f]\n",
        clip.trackId, clip.regionId,
        (long long)clip.position.ticks, (long long)clip.duration.ticks,
        clip.pitchOffset, clip.pitchOffsetCents,
        clip.reversed ? 1 : 0, clip.stretchRatio,
        (int)clip.stretchMethod, clip.formantPreserve ? 1 : 0, clip.velocity,
        clip.fadeInPercent, clip.fadeOutPercent,
        clip.fadeInX1, clip.fadeInY1, clip.fadeInX2, clip.fadeInY2,
        clip.fadeOutX1, clip.fadeOutY1, clip.fadeOutX2, clip.fadeOutY2);
    fflush(stderr);
#endif

    fprintf(stderr, "[PITCHDBG] Timeline_AddClip ENTRY: trackId=%d regionId=%d "
            "pitchSemi=%d cents=%d reversed=%d stretch=%.3f\n",
            clip.trackId, clip.regionId,
            clip.pitchOffset, clip.pitchOffsetCents,
            clip.reversed ? 1 : 0, clip.stretchRatio);
    fflush(stderr);

    g_undoManager->execute(std::make_unique<AddClipCommand>(clip), *g_timeline);

    auto clips = g_timeline->getAllClips();
    int newId = clips.empty() ? -1 : clips.back()->id;

    fprintf(stderr, "[PITCHDBG] Timeline_AddClip EXIT: newId=%d regionId=%d\n",
            newId, clip.regionId);
    fflush(stderr);

    if (audioEngine && newId >= 0)
        audioEngine->getMixEngine().invalidateClipCache(newId, "addClip");

    // Trigger on-demand region proxy generation if this clip is on a
    // non-Chorus / non-Crash cell. No-op when region already has a ready proxy.
    maybeEnqueueRegionProxy(clip.regionId, clip.trackId);

    log.done(std::to_string(newId));
    return Napi::Number::New(env, newId);
}

// timeline_removeClip(id)
void Timeline_RemoveClip(const Napi::CallbackInfo& info)
{
    Napi::Env env = info.Env();
    if (!isInitialised() || !g_timeline || !g_undoManager) {
        Napi::Error::New(env, "Engine not initialised.").ThrowAsJavaScriptException();
        return;
    }
    if (info.Length() < 1 || !info[0].IsNumber()) {
        Napi::TypeError::New(env, "timeline_removeClip(id: number)").ThrowAsJavaScriptException();
        return;
    }
    int id = info[0].As<Napi::Number>().Int32Value();
    BridgeCallLog log("timeline.removeClip");
    if (audioEngine)
        audioEngine->getMixEngine().invalidateClipCache(id, "removeClip");
    g_undoManager->execute(std::make_unique<RemoveClipCommand>(id, *g_timeline), *g_timeline);
    log.done();
}

// timeline_setClipParams(clipId: number, params: object) → clipObject
// params: { pitchOffset?, pitchOffsetCents?, reversed?, stretchRatio?,
//           stretchMethod?, formantPreserve?, fadeInPercent?, fadeOutPercent? }
Napi::Value Timeline_SetClipParams(const Napi::CallbackInfo& info)
{
    Napi::Env env = info.Env();
    if (!isInitialised() || !g_timeline || !g_undoManager) {
        Napi::Error::New(env, "Engine not initialised.").ThrowAsJavaScriptException();
        return env.Undefined();
    }
    if (info.Length() < 2 || !info[0].IsNumber() || !info[1].IsObject()) {
        Napi::TypeError::New(env, "timeline_setClipParams(clipId: number, params: object)")
            .ThrowAsJavaScriptException();
        return env.Undefined();
    }

    int clipId = info[0].As<Napi::Number>().Int32Value();
    BridgeCallLog log("timeline.setClipParams");

    const Clip* existing = g_timeline->getClip(clipId);
    if (!existing) {
        Napi::Error::New(env, "Clip not found").ThrowAsJavaScriptException();
        return env.Undefined();
    }

    Napi::Object o = info[1].As<Napi::Object>();
    SetClipParamsCommand::Params p;
    p.pitchOffsetSemis = existing->pitchOffset;
    p.pitchOffsetCents = existing->pitchOffsetCents;
    p.reversed         = existing->reversed;
    p.stretchRatio     = existing->stretchRatio;
    p.stretchMethod    = existing->stretchMethod;
    p.formantPreserve  = existing->formantPreserve;
    p.velocity         = existing->velocity;
    p.fadeInPercent    = existing->fadeInPercent;
    p.fadeOutPercent   = existing->fadeOutPercent;
    p.fadeInX1         = existing->fadeInX1;
    p.fadeInY1         = existing->fadeInY1;
    p.fadeInX2         = existing->fadeInX2;
    p.fadeInY2         = existing->fadeInY2;
    p.fadeOutX1        = existing->fadeOutX1;
    p.fadeOutY1        = existing->fadeOutY1;
    p.fadeOutX2        = existing->fadeOutX2;
    p.fadeOutY2        = existing->fadeOutY2;

    if (o.Has("pitchOffset") && o.Get("pitchOffset").IsNumber())
        p.pitchOffsetSemis = o.Get("pitchOffset").As<Napi::Number>().Int32Value();
    if (o.Has("pitchOffsetCents") && o.Get("pitchOffsetCents").IsNumber()) {
        int c = o.Get("pitchOffsetCents").As<Napi::Number>().Int32Value();
        p.pitchOffsetCents = std::max(-99, std::min(99, c));
    }
    if (o.Has("reversed") && o.Get("reversed").IsBoolean())
        p.reversed = o.Get("reversed").As<Napi::Boolean>().Value();
    if (o.Has("stretchRatio") && o.Get("stretchRatio").IsNumber()) {
        double r = o.Get("stretchRatio").As<Napi::Number>().DoubleValue();
        p.stretchRatio = (r <= 0.0) ? 1.0 : r;
    }
    if (o.Has("stretchMethod") && o.Get("stretchMethod").IsNumber()) {
        int sm = o.Get("stretchMethod").As<Napi::Number>().Int32Value();
        p.stretchMethod = static_cast<StretchMethod>(
            (sm >= 0 && sm <= 5) ? sm : 0 /*Global*/);
    }
    if (o.Has("formantPreserve") && o.Get("formantPreserve").IsBoolean())
        p.formantPreserve = o.Get("formantPreserve").As<Napi::Boolean>().Value();
    if (o.Has("velocity") && o.Get("velocity").IsNumber())
        p.velocity = o.Get("velocity").As<Napi::Number>().FloatValue();
    if (o.Has("fadeInPercent") && o.Get("fadeInPercent").IsNumber())
        p.fadeInPercent = o.Get("fadeInPercent").As<Napi::Number>().FloatValue();
    else if (o.Has("fadeInTicks") && o.Get("fadeInTicks").IsNumber())
        p.fadeInPercent = legacyFadeTicksToPercent(
            o.Get("fadeInTicks").As<Napi::Number>().FloatValue(), existing->duration.ticks);
    if (o.Has("fadeOutPercent") && o.Get("fadeOutPercent").IsNumber())
        p.fadeOutPercent = o.Get("fadeOutPercent").As<Napi::Number>().FloatValue();
    else if (o.Has("fadeOutTicks") && o.Get("fadeOutTicks").IsNumber())
        p.fadeOutPercent = legacyFadeTicksToPercent(
            o.Get("fadeOutTicks").As<Napi::Number>().FloatValue(), existing->duration.ticks);
    normalizeClipFadePercents(p.fadeInPercent, p.fadeOutPercent);
    if (o.Has("fadeInX1") && o.Get("fadeInX1").IsNumber())
        p.fadeInX1 = o.Get("fadeInX1").As<Napi::Number>().FloatValue();
    if (o.Has("fadeInY1") && o.Get("fadeInY1").IsNumber())
        p.fadeInY1 = o.Get("fadeInY1").As<Napi::Number>().FloatValue();
    if (o.Has("fadeInX2") && o.Get("fadeInX2").IsNumber())
        p.fadeInX2 = o.Get("fadeInX2").As<Napi::Number>().FloatValue();
    if (o.Has("fadeInY2") && o.Get("fadeInY2").IsNumber())
        p.fadeInY2 = o.Get("fadeInY2").As<Napi::Number>().FloatValue();
    if (o.Has("fadeOutX1") && o.Get("fadeOutX1").IsNumber())
        p.fadeOutX1 = o.Get("fadeOutX1").As<Napi::Number>().FloatValue();
    if (o.Has("fadeOutY1") && o.Get("fadeOutY1").IsNumber())
        p.fadeOutY1 = o.Get("fadeOutY1").As<Napi::Number>().FloatValue();
    if (o.Has("fadeOutX2") && o.Get("fadeOutX2").IsNumber())
        p.fadeOutX2 = o.Get("fadeOutX2").As<Napi::Number>().FloatValue();
    if (o.Has("fadeOutY2") && o.Get("fadeOutY2").IsNumber())
        p.fadeOutY2 = o.Get("fadeOutY2").As<Napi::Number>().FloatValue();

    // Only invalidate render cache for pitch/stretch/reverse changes (not volume/fade)
    const bool needsCacheInvalidation =
        p.pitchOffsetSemis != existing->pitchOffset ||
        p.pitchOffsetCents != existing->pitchOffsetCents ||
        p.reversed         != existing->reversed ||
        std::abs(p.stretchRatio - existing->stretchRatio) > 1e-9 ||
        p.stretchMethod    != existing->stretchMethod ||
        p.formantPreserve  != existing->formantPreserve;

    g_undoManager->execute(
        std::make_unique<SetClipParamsCommand>(clipId, p, *g_timeline),
        *g_timeline);

    if (audioEngine && needsCacheInvalidation)
        audioEngine->getMixEngine().invalidateClipCache(clipId, "setClipParams");

    const Clip* updated = g_timeline->getClip(clipId);
    if (!updated) return env.Undefined();
    log.done(std::to_string(clipId));
    return clipToJs(env, *updated);
}

// timeline_moveClip(id, trackId, posTicks)
// trackId is accepted but not yet used (Timeline::moveClip only moves position).
void Timeline_MoveClip(const Napi::CallbackInfo& info)
{
    Napi::Env env = info.Env();
    if (!isInitialised() || !g_timeline || !g_undoManager) {
        Napi::Error::New(env, "Engine not initialised.").ThrowAsJavaScriptException();
        return;
    }
    if (info.Length() < 3 || !info[0].IsNumber() || !info[1].IsNumber() || !info[2].IsNumber()) {
        Napi::TypeError::New(env, "timeline_moveClip(id: number, trackId: number, posTicks: number)")
            .ThrowAsJavaScriptException();
        return;
    }
    int     id       = info[0].As<Napi::Number>().Int32Value();
    // info[1] = trackId — reserved for future cross-track moves
    int64_t posTicks = static_cast<int64_t>(info[2].As<Napi::Number>().DoubleValue());
    BridgeCallLog log("timeline.moveClip");

    TickTime newPos; newPos.ticks = posTicks;
    g_undoManager->execute(std::make_unique<MoveClipCommand>(id, newPos, *g_timeline), *g_timeline);
    if (audioEngine) audioEngine->getMixEngine().invalidateClipCache(id, "moveClip");
    log.done();
}

// timeline_resizeClip(id, durTicks)
void Timeline_ResizeClip(const Napi::CallbackInfo& info)
{
    Napi::Env env = info.Env();
    if (!isInitialised() || !g_timeline || !g_undoManager) {
        Napi::Error::New(env, "Engine not initialised.").ThrowAsJavaScriptException();
        return;
    }
    if (info.Length() < 2 || !info[0].IsNumber() || !info[1].IsNumber()) {
        Napi::TypeError::New(env, "timeline_resizeClip(id: number, durTicks: number)")
            .ThrowAsJavaScriptException();
        return;
    }
    int     id       = info[0].As<Napi::Number>().Int32Value();
    int64_t durTicks = static_cast<int64_t>(info[1].As<Napi::Number>().DoubleValue());
    BridgeCallLog log("timeline.resizeClip");

    TickTime newDur; newDur.ticks = durTicks;
    g_undoManager->execute(std::make_unique<ResizeClipCommand>(id, newDur, *g_timeline), *g_timeline);
    if (audioEngine) audioEngine->getMixEngine().invalidateClipCache(id, "resizeClip");
    log.done();
}

// timeline_resizeClipLeft(id, posTicks, durTicks, regionOffsetTicks)
void Timeline_ResizeClipLeft(const Napi::CallbackInfo& info)
{
    Napi::Env env = info.Env();
    if (!isInitialised() || !g_timeline || !g_undoManager) {
        Napi::Error::New(env, "Engine not initialised.").ThrowAsJavaScriptException();
        return;
    }
    if (info.Length() < 4 || !info[0].IsNumber() || !info[1].IsNumber() ||
        !info[2].IsNumber() || !info[3].IsNumber()) {
        Napi::TypeError::New(env,
            "timeline_resizeClipLeft(id: number, posTicks: number, durTicks: number, regionOffsetTicks: number)")
            .ThrowAsJavaScriptException();
        return;
    }
    int     id          = info[0].As<Napi::Number>().Int32Value();
    int64_t posTicks    = static_cast<int64_t>(info[1].As<Napi::Number>().DoubleValue());
    int64_t durTicks    = static_cast<int64_t>(info[2].As<Napi::Number>().DoubleValue());
    int64_t offsetTicks = static_cast<int64_t>(info[3].As<Napi::Number>().DoubleValue());
    BridgeCallLog log("timeline.resizeClipLeft");
#ifdef XLETH_DEBUG
    fprintf(stderr, "[BridgeStretch] timeline_resizeClipLeft(clip=%d, pos=%lld, dur=%lld, offset=%lld)\n",
            id, (long long)posTicks, (long long)durTicks, (long long)offsetTicks);
#endif

    TickTime newPos;    newPos.ticks    = posTicks;
    TickTime newDur;    newDur.ticks    = durTicks;
    TickTime newOffset; newOffset.ticks = offsetTicks;
    g_undoManager->execute(
        std::make_unique<ResizeClipLeftCommand>(id, newPos, newDur, newOffset, *g_timeline),
        *g_timeline);
    if (audioEngine) audioEngine->getMixEngine().invalidateClipCache(id, "resizeClipLeft");
    log.done();
}

// timeline_stretchClip(id, durTicks)
// Changes duration + recomputes stretchRatio so audio fills the new length.
void Timeline_StretchClip(const Napi::CallbackInfo& info)
{
    Napi::Env env = info.Env();
    if (!isInitialised() || !g_timeline || !g_undoManager) {
        Napi::Error::New(env, "Engine not initialised.").ThrowAsJavaScriptException();
        return;
    }
    if (info.Length() < 2 || !info[0].IsNumber() || !info[1].IsNumber()) {
        Napi::TypeError::New(env, "timeline_stretchClip(id: number, durTicks: number)")
            .ThrowAsJavaScriptException();
        return;
    }
    int     id       = info[0].As<Napi::Number>().Int32Value();
    int64_t durTicks = static_cast<int64_t>(info[1].As<Napi::Number>().DoubleValue());
    BridgeCallLog log("timeline.stretchClip");
#ifdef XLETH_DEBUG
    fprintf(stderr, "[BridgeStretch] timeline_stretchClip(clip=%d, newDur=%lld)\n",
            id, (long long)durTicks);
#endif

    TickTime newDur; newDur.ticks = durTicks;
    g_undoManager->execute(std::make_unique<StretchClipCommand>(id, newDur, *g_timeline), *g_timeline);
    if (audioEngine) audioEngine->getMixEngine().invalidateClipCache(id, "stretchClip");
    log.done();
}

// timeline_stretchClipLeft(id, posTicks, durTicks)
// Left-edge stretch: changes position + duration, recomputes stretchRatio.
void Timeline_StretchClipLeft(const Napi::CallbackInfo& info)
{
    Napi::Env env = info.Env();
    if (!isInitialised() || !g_timeline || !g_undoManager) {
        Napi::Error::New(env, "Engine not initialised.").ThrowAsJavaScriptException();
        return;
    }
    if (info.Length() < 3 || !info[0].IsNumber() || !info[1].IsNumber() || !info[2].IsNumber()) {
        Napi::TypeError::New(env,
            "timeline_stretchClipLeft(id: number, posTicks: number, durTicks: number)")
            .ThrowAsJavaScriptException();
        return;
    }
    int     id       = info[0].As<Napi::Number>().Int32Value();
    int64_t posTicks = static_cast<int64_t>(info[1].As<Napi::Number>().DoubleValue());
    int64_t durTicks = static_cast<int64_t>(info[2].As<Napi::Number>().DoubleValue());
    BridgeCallLog log("timeline.stretchClipLeft");
#ifdef XLETH_DEBUG
    fprintf(stderr, "[BridgeStretch] timeline_stretchClipLeft(clip=%d, newPos=%lld, newDur=%lld)\n",
            id, (long long)posTicks, (long long)durTicks);
#endif

    TickTime newPos; newPos.ticks = posTicks;
    TickTime newDur; newDur.ticks = durTicks;
    g_undoManager->execute(
        std::make_unique<StretchClipLeftCommand>(id, newPos, newDur, *g_timeline),
        *g_timeline);
    if (audioEngine) audioEngine->getMixEngine().invalidateClipCache(id, "stretchClipLeft");
    log.done();
}

// timeline_pitchShiftClip(clipId, semitoneDelta, centsDelta) → clipObject
// Applies pitch delta with cents→semitone carry/wrap. Semitones clamped [-48,48].
Napi::Value Timeline_PitchShiftClip(const Napi::CallbackInfo& info)
{
    Napi::Env env = info.Env();
    if (!isInitialised() || !g_timeline || !g_undoManager) {
        Napi::Error::New(env, "Engine not initialised.").ThrowAsJavaScriptException();
        return env.Undefined();
    }
    if (info.Length() < 3 || !info[0].IsNumber() || !info[1].IsNumber() || !info[2].IsNumber()) {
        Napi::TypeError::New(env,
            "timeline_pitchShiftClip(clipId: number, semitoneDelta: number, centsDelta: number)")
            .ThrowAsJavaScriptException();
        return env.Undefined();
    }
    int clipId       = info[0].As<Napi::Number>().Int32Value();
    int semiDelta    = info[1].As<Napi::Number>().Int32Value();
    int centsDelta   = info[2].As<Napi::Number>().Int32Value();
    BridgeCallLog log("timeline.pitchShiftClip");
#ifdef XLETH_DEBUG
    fprintf(stderr, "[BridgeStretch] timeline_pitchShiftClip(clip=%d, semiDelta=%d, centsDelta=%d)\n",
            clipId, semiDelta, centsDelta);
#endif

    const Clip* existing = g_timeline->getClip(clipId);
    if (!existing) {
        Napi::Error::New(env, "Clip not found").ThrowAsJavaScriptException();
        return env.Undefined();
    }

    // Carry cents overflow into semitones
    int newCents = existing->pitchOffsetCents + centsDelta;
    int carry    = newCents / 100;   // truncation toward zero — correct for ±
    newCents     = newCents % 100;
    int newSemis = std::max(-48, std::min(48, existing->pitchOffset + semiDelta + carry));

    g_undoManager->execute(
        std::make_unique<PitchShiftClipCommand>(clipId, newSemis, newCents, *g_timeline),
        *g_timeline);

    if (audioEngine) audioEngine->getMixEngine().invalidateClipCache(clipId, "pitchShiftClip");
#ifdef XLETH_DEBUG
    fprintf(stderr, "[BridgeStretch] timeline_pitchShiftClip → result: %dst %dc\n",
            newSemis, newCents);
#endif

    const Clip* updated = g_timeline->getClip(clipId);
    if (!updated) return env.Undefined();
    log.done(std::to_string(clipId));
    return clipToJs(env, *updated);
}

// timeline_reverseClip(clipId) → clipObject
// Toggles the reversed flag on the clip.
Napi::Value Timeline_ReverseClip(const Napi::CallbackInfo& info)
{
    Napi::Env env = info.Env();
    if (!isInitialised() || !g_timeline || !g_undoManager) {
        Napi::Error::New(env, "Engine not initialised.").ThrowAsJavaScriptException();
        return env.Undefined();
    }
    if (info.Length() < 1 || !info[0].IsNumber()) {
        Napi::TypeError::New(env, "timeline_reverseClip(clipId: number)")
            .ThrowAsJavaScriptException();
        return env.Undefined();
    }
    int clipId = info[0].As<Napi::Number>().Int32Value();
    BridgeCallLog log("timeline.reverseClip");
#ifdef XLETH_DEBUG
    fprintf(stderr, "[BridgeStretch] timeline_reverseClip(clip=%d)\n", clipId);
#endif

    const Clip* existing = g_timeline->getClip(clipId);
    if (!existing) {
        Napi::Error::New(env, "Clip not found").ThrowAsJavaScriptException();
        return env.Undefined();
    }

    bool newReversed = !existing->reversed;
    g_undoManager->execute(
        std::make_unique<ReverseClipCommand>(clipId, newReversed, *g_timeline),
        *g_timeline);

    if (audioEngine) audioEngine->getMixEngine().invalidateClipCache(clipId, "reverseClip");
#ifdef XLETH_DEBUG
    fprintf(stderr, "[BridgeStretch] timeline_reverseClip → reversed=%d\n", (int)newReversed);
#endif

    const Clip* updated = g_timeline->getClip(clipId);
    if (!updated) return env.Undefined();
    log.done(std::to_string(clipId));
    return clipToJs(env, *updated);
}

// timeline_spliceClipsAtPlayhead([{clipId, splitTick}, ...])
//   → [[leftId, rightId], ...]   (one pair per successfully split clip)
// Splits N clips atomically in a single undo step. Clips where splitTick is
// exactly at the start or end are silently skipped (zero-length would be invalid).
Napi::Value Timeline_SpliceClipsAtPlayhead(const Napi::CallbackInfo& info)
{
    Napi::Env env = info.Env();
    if (!isInitialised() || !g_timeline || !g_undoManager) {
        Napi::Error::New(env, "Engine not initialised.").ThrowAsJavaScriptException();
        return env.Null();
    }
    if (info.Length() < 1 || !info[0].IsArray()) {
        Napi::TypeError::New(env,
            "timeline_spliceClipsAtPlayhead(entries: [{clipId, splitTick}])")
            .ThrowAsJavaScriptException();
        return env.Null();
    }

    auto arr = info[0].As<Napi::Array>();
    std::vector<SpliceClipsCommand::Entry> entries;
    entries.reserve(arr.Length());

    for (uint32_t i = 0; i < arr.Length(); ++i) {
        Napi::Value item = arr.Get(i);
        if (!item.IsObject()) continue;
        auto obj = item.As<Napi::Object>();
        if (!obj.Has("clipId") || !obj.Has("splitTick")) continue;
        if (!obj.Get("clipId").IsNumber() || !obj.Get("splitTick").IsNumber()) continue;

        int     clipId    = obj.Get("clipId").As<Napi::Number>().Int32Value();
        int64_t splitTick = static_cast<int64_t>(
            obj.Get("splitTick").As<Napi::Number>().Int64Value());

        const Clip* c = g_timeline->getClip(clipId);
        if (!c) continue;

        int64_t clipStart = c->position.ticks;
        int64_t clipEnd   = c->position.ticks + c->duration.ticks;

        // Skip edge-exactly cases — zero-length result would be invalid
        if (splitTick <= clipStart || splitTick >= clipEnd) continue;

        int64_t leftDur  = splitTick - clipStart;
        int64_t rightDur = clipEnd   - splitTick;

        SpliceClipsCommand::Entry e;
        e.original = *c;

        e.left            = *c;
        e.left.id         = 0;
        e.left.duration   = TickTime{leftDur};

        e.right                    = *c;
        e.right.id                 = 0;
        e.right.position           = TickTime{splitTick};
        e.right.regionOffset       = TickTime{c->regionOffset.ticks + leftDur};
        e.right.duration           = TickTime{rightDur};

        entries.push_back(std::move(e));
    }

    if (entries.empty()) {
        return Napi::Array::New(env, 0);
    }

    std::vector<std::pair<int,int>> outIds;
    outIds.reserve(entries.size());
    BridgeCallLog log("timeline.spliceClipsAtPlayhead");
    g_undoManager->execute(
        std::make_unique<SpliceClipsCommand>(std::move(entries), &outIds),
        *g_timeline);

    // Invalidate render cache for all new clip IDs
    if (audioEngine) {
        for (const auto& p : outIds) {
            audioEngine->getMixEngine().invalidateClipCache(p.first,  "spliceLeft");
            audioEngine->getMixEngine().invalidateClipCache(p.second, "spliceRight");
        }
    }

    auto result = Napi::Array::New(env, outIds.size());
    for (size_t i = 0; i < outIds.size(); ++i) {
        auto pair = Napi::Array::New(env, 2);
        pair.Set(0u, Napi::Number::New(env, outIds[i].first));
        pair.Set(1u, Napi::Number::New(env, outIds[i].second));
        result.Set(static_cast<uint32_t>(i), pair);
    }
    log.done(std::to_string(outIds.size()) + " clips split");
    return result;
}

// ─────────────────────────────────────────────────────────────────────────────
// Pattern / PatternBlock / Note bridge methods
// ─────────────────────────────────────────────────────────────────────────────

// timeline_addPattern({ name, regionId, lengthTicks }) → patternId
// Note: sampler fields (rootNote/ADSR/loop/crossfade) now live on SampleRegion.
// Use timeline_updateSamplerSettings(regionId, …) to configure them.
Napi::Value Timeline_AddPattern(const Napi::CallbackInfo& info)
{
    Napi::Env env = info.Env();
    if (!isInitialised() || !g_timeline || !g_undoManager) {
        Napi::Error::New(env, "Engine not initialised.").ThrowAsJavaScriptException();
        return env.Undefined();
    }
    if (info.Length() < 1 || !info[0].IsObject()) {
        Napi::TypeError::New(env, "timeline_addPattern({ name, regionId, lengthTicks, ... })")
            .ThrowAsJavaScriptException();
        return env.Undefined();
    }
    BridgeCallLog log("timeline.addPattern");

    Napi::Object o = info[0].As<Napi::Object>();
    Pattern p;
    if (o.Has("name") && o.Get("name").IsString())
        p.name = o.Get("name").As<Napi::String>().Utf8Value();
    p.regionId       = o.Get("regionId").As<Napi::Number>().Int32Value();
    p.length.ticks   = static_cast<int64_t>(o.Get("lengthTicks").As<Napi::Number>().DoubleValue());

    g_undoManager->execute(std::make_unique<AddPatternCommand>(p), *g_timeline);

    // Recover the newly assigned ID by scanning patterns for the max.
    int newId = -1;
    for (const auto& [id, pat] : g_timeline->getAllPatterns())
        if (id > newId) newId = id;
    refreshSamplerForPattern(newId);
    log.done(std::to_string(newId));
    return Napi::Number::New(env, newId);
}

// timeline_getPattern(patternId) → Pattern | null
Napi::Value Timeline_GetPattern(const Napi::CallbackInfo& info)
{
    Napi::Env env = info.Env();
    if (!g_timeline) {
        Napi::Error::New(env, "Engine not initialised.").ThrowAsJavaScriptException();
        return env.Undefined();
    }
    if (info.Length() < 1 || !info[0].IsNumber()) {
        Napi::TypeError::New(env, "timeline_getPattern(id: number)").ThrowAsJavaScriptException();
        return env.Undefined();
    }
    int id = info[0].As<Napi::Number>().Int32Value();
    const Pattern* p = g_timeline->getPattern(id);
    if (!p) return env.Null();
    return patternToJs(env, *p);
}

// timeline_getPatternAudioInfo(patternId)
//   → { audioFilePath, numSamples, originalSampleRate, duration } | null
// Returns info needed by the UI to render a waveform for the pattern's sample
// and to map loop-point sample indices (engine-rate) onto pixel positions.
Napi::Value Timeline_GetPatternAudioInfo(const Napi::CallbackInfo& info)
{
    Napi::Env env = info.Env();
    if (!g_timeline || !audioEngine || !sampleBank) {
        Napi::Error::New(env, "Engine not initialised.").ThrowAsJavaScriptException();
        return env.Undefined();
    }
    if (info.Length() < 1 || !info[0].IsNumber()) {
        Napi::TypeError::New(env, "timeline_getPatternAudioInfo(patternId: number)")
            .ThrowAsJavaScriptException();
        return env.Undefined();
    }
    int patternId = info[0].As<Napi::Number>().Int32Value();
    const Pattern* p = g_timeline->getPattern(patternId);
    if (!p) return env.Null();
    const SampleRegion* r = g_timeline->getRegion(p->regionId);
    if (!r) return env.Null();

    const double engineSR = audioEngine->getSampleRate();
    const int sampleBankId = audioEngine->getMixEngine().getSampleIdForRegion(p->regionId);

    Napi::Object out = Napi::Object::New(env);
    out.Set("audioFilePath",      r->audioFilePath);
    out.Set("engineSampleRate",   engineSR);

    if (sampleBankId >= 0 && sampleBank != nullptr) {
        const auto sInfo = sampleBank->getSampleInfo(sampleBankId);
        const double duration = engineSR > 0.0
                              ? static_cast<double>(sInfo.numSamples) / engineSR
                              : 0.0;
        out.Set("numSamples",         sInfo.numSamples);
        out.Set("originalSampleRate", sInfo.originalSampleRate);
        out.Set("duration",           duration);
    } else {
        // Region not yet mapped to a SampleBank slot — UI still needs the file
        // path to render a waveform preview via getWaveformData.
        out.Set("numSamples",         0);
        out.Set("originalSampleRate", 0);
        out.Set("duration",           0.0);
    }
    return out;
}

// timeline_getRegionAudioInfo(regionId)
//   → { audioFilePath, numSamples, originalSampleRate, duration, engineSampleRate } | null
// Region-keyed variant of Timeline_GetPatternAudioInfo. Used by SamplerPanel
// opened from the Sample Selector (which has no pattern in scope).
Napi::Value Timeline_GetRegionAudioInfo(const Napi::CallbackInfo& info)
{
    Napi::Env env = info.Env();
    if (!g_timeline || !audioEngine || !sampleBank) {
        Napi::Error::New(env, "Engine not initialised.").ThrowAsJavaScriptException();
        return env.Undefined();
    }
    if (info.Length() < 1 || !info[0].IsNumber()) {
        Napi::TypeError::New(env, "timeline_getRegionAudioInfo(regionId: number)")
            .ThrowAsJavaScriptException();
        return env.Undefined();
    }
    int regionId = info[0].As<Napi::Number>().Int32Value();
    const SampleRegion* r = g_timeline->getRegion(regionId);
    if (!r) return env.Null();

    const double engineSR = audioEngine->getSampleRate();
    const int sampleBankId = audioEngine->getMixEngine().getSampleIdForRegion(regionId);

    Napi::Object out = Napi::Object::New(env);
    out.Set("audioFilePath",      r->audioFilePath);
    out.Set("engineSampleRate",   engineSR);

    if (sampleBankId >= 0 && sampleBank != nullptr) {
        const auto sInfo = sampleBank->getSampleInfo(sampleBankId);
        const double duration = engineSR > 0.0
                              ? static_cast<double>(sInfo.numSamples) / engineSR
                              : 0.0;
        out.Set("numSamples",         sInfo.numSamples);
        out.Set("originalSampleRate", sInfo.originalSampleRate);
        out.Set("duration",           duration);
    } else {
        out.Set("numSamples",         0);
        out.Set("originalSampleRate", 0);
        out.Set("duration",           0.0);
    }
    return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Waveform mipmap bindings — multi-resolution peak data from WaveformMipmap.
// (Pipeline B retired — all callers now use Waveform_GetRegionPeaks instead.)
// ─────────────────────────────────────────────────────────────────────────────

#ifdef XLETH_DEBUG
namespace {
void wfbLog(const char* fmt, ...) {
    va_list args;
    va_start(args, fmt);
    fprintf(stderr, "[WaveformBridge] ");
    vfprintf(stderr, fmt, args);
    fprintf(stderr, "\n");
    va_end(args);
    fflush(stderr);
}
}
#define WFB_LOG(...) wfbLog(__VA_ARGS__)
#else
#define WFB_LOG(...) ((void)0)
#endif

// Helper: apply SampleProcessor display transforms to peak output in-place.
// Only polarity-invert and reverse can be applied to cached peak data.
// DC removal and normalize require the actual buffer data and cannot be
// applied to pre-computed peaks — see TODO comments below.
static void applyPeakTransforms(float* peaks, int numCols,
                                 const SampleRegion* region)
{
    if (!region) return;

    // TODO: DC removal shifts all samples by a constant, but the offset is
    // computed dynamically from the full buffer (mean of all samples).  The
    // mipmap doesn't store the DC value, so we can't adjust peaks here.
    // The visual difference is negligible for most content.

    // TODO: Normalize scales all samples by (1.0 / peakMagnitude), but the
    // gain factor is computed dynamically.  Applying it here would require
    // scanning the mipmap to find the global peak — possible but deferred
    // to avoid per-query overhead.  Peaks will appear un-normalized.

    // Polarity invert: negate min/max and swap them.  RMS is unaffected.
    if (region->polarityReversed) {
        for (int i = 0; i < numCols; ++i) {
            const int idx = i * 3;
            const float oldMin = peaks[idx];
            const float oldMax = peaks[idx + 1];
            peaks[idx]     = -oldMax;
            peaks[idx + 1] = -oldMin;
            // peaks[idx + 2] (rms) unchanged
        }
    }

    // Reverse: reverse the order of [min,max,rms] triples.
    if (region->reversed) {
        for (int i = 0; i < numCols / 2; ++i) {
            const int a = i * 3;
            const int b = (numCols - 1 - i) * 3;
            std::swap(peaks[a],     peaks[b]);
            std::swap(peaks[a + 1], peaks[b + 1]);
            std::swap(peaks[a + 2], peaks[b + 2]);
        }
    }
}

// waveform_getRegionPeaks(regionId, startTime, endTime, targetPixels, channel)
// Returns { peaks: Float32Array, needsRawSamples, ready, sampleRate, totalSamples }
Napi::Value Waveform_GetRegionPeaks(const Napi::CallbackInfo& info)
{
    Napi::Env env = info.Env();

    // ── Build empty/not-ready result ─────────────────────────────────────
    auto makeResult = [&](bool ready, int sr = 0, int64_t total = 0) {
        auto obj = Napi::Object::New(env);
        auto ab = Napi::ArrayBuffer::New(env, 0);
        obj.Set("peaks",          Napi::Float32Array::New(env, 0, ab, 0));
        obj.Set("needsRawSamples", Napi::Boolean::New(env, false));
        obj.Set("ready",          Napi::Boolean::New(env, ready));
        obj.Set("sampleRate",     Napi::Number::New(env, sr));
        obj.Set("totalSamples",   Napi::Number::New(env, static_cast<double>(total)));
        return obj;
    };

    if (!g_timeline || !audioEngine || !sampleBank || !g_mipmapCache) {
        WFB_LOG("getRegionPeaks: engine/timeline not initialised");
        return makeResult(false);
    }
    if (info.Length() < 5 || !info[0].IsNumber() || !info[1].IsNumber() ||
        !info[2].IsNumber() || !info[3].IsNumber() || !info[4].IsNumber()) {
        Napi::TypeError::New(env,
            "waveform_getRegionPeaks(regionId, startTime, endTime, targetPixels, channel)")
            .ThrowAsJavaScriptException();
        return env.Undefined();
    }

    const int    regionId     = info[0].As<Napi::Number>().Int32Value();
    const double startTime    = info[1].As<Napi::Number>().DoubleValue();
    const double endTime      = info[2].As<Napi::Number>().DoubleValue();
    const int    targetPixels = std::max(1, std::min(info[3].As<Napi::Number>().Int32Value(), 16000));
    const int    channel      = info[4].As<Napi::Number>().Int32Value();

    WFB_LOG("getRegionPeaks: region=%d t=%.3f–%.3f px=%d ch=%d",
            regionId, startTime, endTime, targetPixels, channel);

    // ── Look up mipmap ───────────────────────────────────────────────────
    const int sampleBankId =
        audioEngine->getMixEngine().getSampleIdForRegion(regionId);
    if (sampleBankId < 0) {
        WFB_LOG("getRegionPeaks: region %d -> sampleBankId=-1 (not mapped)", regionId);
        return makeResult(false);
    }

    auto* mm = g_mipmapCache->get(std::to_string(sampleBankId));
    if (!mm) {
        WFB_LOG("getRegionPeaks: region %d -> sampleBankId=%d, mipmap not ready", regionId, sampleBankId);
        return makeResult(false);
    }

    const int sr = mm->getSampleRate();
    const int64_t totalSamples = mm->getTotalSamples();
    const int numChannels = mm->getNumChannels();

    // ── Convert time to sample positions ─────────────────────────────────
    // endTime < 0 means "to end of sample" (same convention as getFilePeaks)
    double effectiveEnd = endTime;
    if (effectiveEnd < 0.0 && sr > 0)
        effectiveEnd = static_cast<double>(totalSamples) / sr;

    int64_t startSample = static_cast<int64_t>(startTime * sr);
    int64_t endSample   = static_cast<int64_t>(effectiveEnd * sr);
    startSample = std::max(int64_t(0), std::min(startSample, totalSamples));
    endSample   = std::max(startSample, std::min(endSample, totalSamples));

    if (startSample >= endSample) {
        WFB_LOG("getRegionPeaks: region %d empty range after clamping (start=%lld end=%lld)",
                regionId, (long long)startSample, (long long)endSample);
        return makeResult(true, sr, totalSamples);
    }

    // ── Allocate output ──────────────────────────────────────────────────
    const size_t floatCount = static_cast<size_t>(targetPixels) * 3;
    auto ab = Napi::ArrayBuffer::New(env, floatCount * sizeof(float));
    float* outBuf = static_cast<float*>(ab.Data());
    std::memset(outBuf, 0, floatCount * sizeof(float));

    bool needsRaw = false;
    int cols = 0;

    if (channel >= 0 && channel < numChannels) {
        // ── Single channel ───────────────────────────────────────────────
        cols = mm->getPeaks(channel, startSample, endSample,
                            targetPixels, outBuf, static_cast<int>(floatCount),
                            needsRaw);
    } else {
        // ── Merge all channels (channel == -1) ───────────────────────────
        // Query ch0 into outBuf, then merge remaining channels
        cols = mm->getPeaks(0, startSample, endSample,
                            targetPixels, outBuf, static_cast<int>(floatCount),
                            needsRaw);

        if (numChannels > 1 && cols > 0) {
            std::vector<float> chBuf(static_cast<size_t>(cols) * 3);
            for (int ch = 1; ch < numChannels; ++ch) {
                bool nr = false;
                mm->getPeaks(ch, startSample, endSample,
                             targetPixels, chBuf.data(),
                             static_cast<int>(chBuf.size()), nr);
                if (nr) needsRaw = true;
                for (int c = 0; c < cols; ++c) {
                    const int idx = c * 3;
                    if (chBuf[idx]     < outBuf[idx])     outBuf[idx]     = chBuf[idx];     // min
                    if (chBuf[idx + 1] > outBuf[idx + 1]) outBuf[idx + 1] = chBuf[idx + 1]; // max
                    // RMS: sqrt(mean of per-channel rms^2)
                    const float r0 = outBuf[idx + 2];
                    const float r1 = chBuf[idx + 2];
                    outBuf[idx + 2] = std::sqrt((r0 * r0 + r1 * r1) / 2.0f);
                }
            }
        }
    }

    // ── Apply SampleProcessor display transforms ─────────────────────────
    const SampleRegion* region = g_timeline->getRegion(regionId);
    applyPeakTransforms(outBuf, cols, region);

    // ── Return result ────────────────────────────────────────────────────
    auto result = Napi::Object::New(env);
    result.Set("peaks",          Napi::Float32Array::New(env, floatCount, ab, 0));
    result.Set("needsRawSamples", Napi::Boolean::New(env, needsRaw));
    result.Set("ready",          Napi::Boolean::New(env, true));
    result.Set("sampleRate",     Napi::Number::New(env, sr));
    result.Set("totalSamples",   Napi::Number::New(env, static_cast<double>(totalSamples)));
    return result;
}

// waveform_getRawSamples(regionId, startSample, endSample, channel)
// Returns { samples: Float32Array, sampleRate: number }
Napi::Value Waveform_GetRawSamples(const Napi::CallbackInfo& info)
{
    Napi::Env env = info.Env();

    auto makeEmpty = [&]() {
        auto obj = Napi::Object::New(env);
        auto ab = Napi::ArrayBuffer::New(env, 0);
        obj.Set("samples",    Napi::Float32Array::New(env, 0, ab, 0));
        obj.Set("sampleRate", Napi::Number::New(env, 0));
        return obj;
    };

    if (!g_timeline || !audioEngine || !sampleBank || !g_mipmapCache) return makeEmpty();
    if (info.Length() < 4 || !info[0].IsNumber() || !info[1].IsNumber() ||
        !info[2].IsNumber() || !info[3].IsNumber()) {
        Napi::TypeError::New(env,
            "waveform_getRawSamples(regionId, startSample, endSample, channel)")
            .ThrowAsJavaScriptException();
        return env.Undefined();
    }

    const int     regionId    = info[0].As<Napi::Number>().Int32Value();
    const int64_t startSample = static_cast<int64_t>(info[1].As<Napi::Number>().DoubleValue());
    const int64_t endSample   = static_cast<int64_t>(info[2].As<Napi::Number>().DoubleValue());
    const int     channel     = info[3].As<Napi::Number>().Int32Value();

    const int sampleBankId =
        audioEngine->getMixEngine().getSampleIdForRegion(regionId);
    if (sampleBankId < 0) return makeEmpty();

    auto* mm = g_mipmapCache->get(std::to_string(sampleBankId));
    if (!mm) return makeEmpty();

    const int sr = mm->getSampleRate();
    const int numChannels = mm->getNumChannels();
    const int count = static_cast<int>(std::max(int64_t(0), endSample - startSample));
    if (count == 0) return makeEmpty();

    auto ab = Napi::ArrayBuffer::New(env, static_cast<size_t>(count) * sizeof(float));
    float* outBuf = static_cast<float*>(ab.Data());
    int written = 0;

    if (channel >= 0 && channel < numChannels) {
        written = mm->getRawSamples(channel, startSample, endSample,
                                     outBuf, count);
    } else if (numChannels > 0) {
        // Merge: average all channels sample-by-sample
        written = mm->getRawSamples(0, startSample, endSample, outBuf, count);
        if (numChannels > 1 && written > 0) {
            std::vector<float> chBuf(static_cast<size_t>(written));
            for (int ch = 1; ch < numChannels; ++ch) {
                mm->getRawSamples(ch, startSample, endSample,
                                   chBuf.data(), written);
                for (int i = 0; i < written; ++i)
                    outBuf[i] += chBuf[i];
            }
            const float invCh = 1.0f / static_cast<float>(numChannels);
            for (int i = 0; i < written; ++i)
                outBuf[i] *= invCh;
        }
    }

    // Apply polarity/reverse transforms
    const SampleRegion* region = g_timeline->getRegion(regionId);
    if (region) {
        if (region->polarityReversed) {
            for (int i = 0; i < written; ++i)
                outBuf[i] = -outBuf[i];
        }
        if (region->reversed) {
            std::reverse(outBuf, outBuf + written);
        }
    }

    auto result = Napi::Object::New(env);
    result.Set("samples",    Napi::Float32Array::New(env, static_cast<size_t>(count), ab, 0));
    result.Set("sampleRate", Napi::Number::New(env, sr));
    return result;
}

// waveform_getClipPeaks(clipId, startSec, endSec, numPeaks)
// Returns peaks from the ClipRenderCache processed buffer (stretch/pitch/reverse output).
// Returns { peaks: Float32Array, ready: bool, sampleRate: number, totalSamples: number }
// ready=false means the cache is a miss (buffer still building) — JS should fall back to
// the raw region waveform and retry after a short delay.
// Channels are merged (same as channel==-1 in getRegionPeaks).
// Peak format: [min, max, rms, min, max, rms, ...] — 3 floats per column.
Napi::Value Waveform_GetClipPeaks(const Napi::CallbackInfo& info)
{
    Napi::Env env = info.Env();

    auto makeResult = [&](bool ready, int sr = 0, int64_t total = 0) {
        auto obj = Napi::Object::New(env);
        auto ab  = Napi::ArrayBuffer::New(env, 0);
        obj.Set("peaks",        Napi::Float32Array::New(env, 0, ab, 0));
        obj.Set("ready",        Napi::Boolean::New(env, ready));
        obj.Set("sampleRate",   Napi::Number::New(env, sr));
        obj.Set("totalSamples", Napi::Number::New(env, static_cast<double>(total)));
        return obj;
    };

    if (!g_timeline || !audioEngine) {
        return makeResult(false);
    }
    if (info.Length() < 4 || !info[0].IsNumber() || !info[1].IsNumber() ||
        !info[2].IsNumber() || !info[3].IsNumber()) {
        Napi::TypeError::New(env,
            "waveform_getClipPeaks(clipId, startSec, endSec, numPeaks)")
            .ThrowAsJavaScriptException();
        return env.Undefined();
    }

    const int    clipId   = info[0].As<Napi::Number>().Int32Value();
    const double startSec = info[1].As<Napi::Number>().DoubleValue();
    const double endSec   = info[2].As<Napi::Number>().DoubleValue();
    const int    numPeaks = std::max(1, std::min(info[3].As<Napi::Number>().Int32Value(), 16000));

    const auto& mix = audioEngine->getMixEngine();
    const juce::AudioBuffer<float>* buf = mix.getClipProcessedBuffer(clipId);
    if (!buf) {
        // Cache miss (buffer building) or clip has identity params — signal not-ready.
        return makeResult(false);
    }

    const double sr         = mix.getPreparedSampleRate();
    const int    numCh      = buf->getNumChannels();
    const int    numSamples = buf->getNumSamples();

    // Map time window to sample range.  endSec <= 0 means "full buffer".
    const double effEnd = (endSec > 0.0) ? endSec
                                          : (sr > 0.0 ? static_cast<double>(numSamples) / sr : 0.0);
    int64_t startSamp = static_cast<int64_t>(startSec * sr);
    int64_t endSamp   = static_cast<int64_t>(effEnd   * sr);
    startSamp = std::max(int64_t(0), std::min(startSamp, static_cast<int64_t>(numSamples)));
    endSamp   = std::max(startSamp,  std::min(endSamp,   static_cast<int64_t>(numSamples)));

    if (startSamp >= endSamp || numCh == 0) {
        return makeResult(true, static_cast<int>(sr), numSamples);
    }

    const size_t floatCount = static_cast<size_t>(numPeaks) * 3;
    auto   ab     = Napi::ArrayBuffer::New(env, floatCount * sizeof(float));
    float* outBuf = static_cast<float*>(ab.Data());
    std::memset(outBuf, 0, floatCount * sizeof(float));

    const int64_t rangeLen    = endSamp - startSamp;
    const double  sampPerCol  = static_cast<double>(rangeLen) / numPeaks;

    for (int col = 0; col < numPeaks; ++col) {
        const int64_t cs = startSamp + static_cast<int64_t>(col       * sampPerCol);
        const int64_t ce = startSamp + static_cast<int64_t>((col + 1) * sampPerCol);
        const int64_t csClamped = std::max(int64_t(0), std::min(cs, static_cast<int64_t>(numSamples)));
        const int64_t ceClamped = std::max(csClamped,  std::min(ce, static_cast<int64_t>(numSamples)));

        float mn = 0.0f, mx = 0.0f, rmsAcc = 0.0f;
        int   count = 0;
        bool  firstSamp = true;

        for (int ch = 0; ch < numCh; ++ch) {
            const float* data = buf->getReadPointer(ch);
            for (int64_t s = csClamped; s < ceClamped; ++s) {
                const float v = data[s];
                if (firstSamp) { mn = mx = v; firstSamp = false; }
                else { if (v < mn) mn = v; if (v > mx) mx = v; }
                rmsAcc += v * v;
                ++count;
            }
        }

        const int idx   = col * 3;
        outBuf[idx]     = mn;
        outBuf[idx + 1] = mx;
        outBuf[idx + 2] = count > 0 ? std::sqrt(rmsAcc / static_cast<float>(count)) : 0.0f;
    }

    auto result = Napi::Object::New(env);
    result.Set("peaks",        Napi::Float32Array::New(env, floatCount, ab, 0));
    result.Set("ready",        Napi::Boolean::New(env, true));
    result.Set("sampleRate",   Napi::Number::New(env, static_cast<int>(sr)));
    result.Set("totalSamples", Napi::Number::New(env, static_cast<double>(numSamples)));
    return result;
}

// waveform_getFilePeaks(filePath, startTime, endTime, targetPixels, channel)
// For files not yet imported (SamplePicker, SyllableSplitter browsing).
// Returns same shape as waveform_getRegionPeaks.
Napi::Value Waveform_GetFilePeaks(const Napi::CallbackInfo& info)
{
    Napi::Env env = info.Env();

    auto makeResult = [&](bool ready, int sr = 0, int64_t total = 0, bool error = false) {
        auto obj = Napi::Object::New(env);
        auto ab = Napi::ArrayBuffer::New(env, 0);
        obj.Set("peaks",          Napi::Float32Array::New(env, 0, ab, 0));
        obj.Set("needsRawSamples", Napi::Boolean::New(env, false));
        obj.Set("ready",          Napi::Boolean::New(env, ready));
        obj.Set("error",          Napi::Boolean::New(env, error));
        obj.Set("sampleRate",     Napi::Number::New(env, sr));
        obj.Set("totalSamples",   Napi::Number::New(env, static_cast<double>(total)));
        obj.Set("duration",       Napi::Number::New(env, sr > 0 ? static_cast<double>(total) / sr : 0.0));
        return obj;
    };

    if (!g_mipmapCache) return makeResult(false);
    if (info.Length() < 5 || !info[0].IsString() || !info[1].IsNumber() ||
        !info[2].IsNumber() || !info[3].IsNumber() || !info[4].IsNumber()) {
        Napi::TypeError::New(env,
            "waveform_getFilePeaks(filePath, startTime, endTime, targetPixels, channel)")
            .ThrowAsJavaScriptException();
        return env.Undefined();
    }

    const std::string filePath     = info[0].As<Napi::String>().Utf8Value();
    const double      startTime    = info[1].As<Napi::Number>().DoubleValue();
    double            endTime      = info[2].As<Napi::Number>().DoubleValue();
    const int         targetPixels = std::max(1, std::min(info[3].As<Napi::Number>().Int32Value(), 16000));
    const int         channel      = info[4].As<Napi::Number>().Int32Value();

    WFB_LOG("getFilePeaks: %s t=%.3f–%.3f px=%d ch=%d",
            filePath.c_str(), startTime, endTime, targetPixels, channel);

    auto audioFile = juce::File(juce::String(filePath));
    if (!audioFile.existsAsFile()) return makeResult(true);

    // ── Get or generate mipmap (synchronous for SamplePicker) ────────────
    const std::string key = "file:" + filePath;
    auto* mm = g_mipmapCache->get(key);
    if (!mm) {
        // Generate synchronously — SamplePicker expects blocking call
        auto mipmap = std::make_unique<WaveformMipmap>();
        if (!mipmap->generateFromFile(audioFile)) {
            WFB_LOG("getFilePeaks: generation failed for %s", filePath.c_str());
            return makeResult(true, 0, 0, true);
        }
        // Insert into cache (move ownership)
        // We need a raw pointer before moving
        WaveformMipmap* rawPtr = mipmap.get();
        {
            // Direct cache insertion — we already generated synchronously
            // so we bypass generateFromFile's async path.
            g_mipmapCache->remove(key);  // ensure clean slate
        }
        // Use generateFromFile on cache which will try .xlpeak first
        g_mipmapCache->generateFromFile(key, audioFile);
        // But that's async... We need synchronous insertion.
        // Instead, directly check the cache after triggering, OR
        // just generate inline and query the mipmap directly.
        // Since we already have the mipmap, query it directly.
        const int sr = rawPtr->getSampleRate();
        const int64_t totalSamples = rawPtr->getTotalSamples();
        const int numChannels = rawPtr->getNumChannels();

        if (endTime < 0.0) endTime = static_cast<double>(totalSamples) / sr;

        int64_t startSmp = static_cast<int64_t>(startTime * sr);
        int64_t endSmp   = static_cast<int64_t>(endTime * sr);
        startSmp = std::max(int64_t(0), std::min(startSmp, totalSamples));
        endSmp   = std::max(startSmp, std::min(endSmp, totalSamples));
        if (startSmp >= endSmp) {
            return makeResult(true, sr, totalSamples);
        }

        const size_t floatCount = static_cast<size_t>(targetPixels) * 3;
        auto ab = Napi::ArrayBuffer::New(env, floatCount * sizeof(float));
        float* outBuf = static_cast<float*>(ab.Data());
        std::memset(outBuf, 0, floatCount * sizeof(float));
        bool needsRaw = false;

        if (channel >= 0 && channel < numChannels) {
            rawPtr->getPeaks(channel, startSmp, endSmp,
                             targetPixels, outBuf, static_cast<int>(floatCount),
                             needsRaw);
        } else {
            rawPtr->getPeaks(0, startSmp, endSmp,
                             targetPixels, outBuf, static_cast<int>(floatCount),
                             needsRaw);
            if (numChannels > 1) {
                std::vector<float> chBuf(floatCount);
                for (int ch = 1; ch < numChannels; ++ch) {
                    bool nr = false;
                    rawPtr->getPeaks(ch, startSmp, endSmp,
                                     targetPixels, chBuf.data(),
                                     static_cast<int>(chBuf.size()), nr);
                    for (int c = 0; c < targetPixels; ++c) {
                        const int idx = c * 3;
                        if (chBuf[idx]     < outBuf[idx])     outBuf[idx]     = chBuf[idx];
                        if (chBuf[idx + 1] > outBuf[idx + 1]) outBuf[idx + 1] = chBuf[idx + 1];
                        const float r0 = outBuf[idx + 2], r1 = chBuf[idx + 2];
                        outBuf[idx + 2] = std::sqrt((r0 * r0 + r1 * r1) / 2.0f);
                    }
                }
            }
        }

        // Save .xlpeak for next time (async in background)
        rawPtr->saveToFile(juce::File(audioFile.getFullPathName() + ".xlpeak"));

        auto result = Napi::Object::New(env);
        result.Set("peaks",          Napi::Float32Array::New(env, floatCount, ab, 0));
        result.Set("needsRawSamples", Napi::Boolean::New(env, needsRaw));
        result.Set("ready",          Napi::Boolean::New(env, true));
        result.Set("error",          Napi::Boolean::New(env, false));
        result.Set("sampleRate",     Napi::Number::New(env, sr));
        result.Set("totalSamples",   Napi::Number::New(env, static_cast<double>(totalSamples)));
        result.Set("duration",       Napi::Number::New(env, static_cast<double>(totalSamples) / sr));

        // Now cache for future calls (move the unique_ptr)
        // We can't easily insert into WaveformMipmapCache from outside since
        // it only exposes generateFromFile/generateFromBuffer.
        // The next call to getFilePeaks will trigger cache's async generation
        // and the .xlpeak file we just saved will be loaded instantly.
        // For THIS call, we already have the result above. Done.
        return result;
    }

    // ── Mipmap is cached and ready ───────────────────────────────────────
    const int sr = mm->getSampleRate();
    const int64_t totalSamples = mm->getTotalSamples();
    const int numChannels = mm->getNumChannels();

    if (endTime < 0.0) endTime = static_cast<double>(totalSamples) / sr;

    int64_t startSmp = static_cast<int64_t>(startTime * sr);
    int64_t endSmp   = static_cast<int64_t>(endTime * sr);
    startSmp = std::max(int64_t(0), std::min(startSmp, totalSamples));
    endSmp   = std::max(startSmp, std::min(endSmp, totalSamples));
    if (startSmp >= endSmp) return makeResult(true, sr, totalSamples);

    const size_t floatCount = static_cast<size_t>(targetPixels) * 3;
    auto ab = Napi::ArrayBuffer::New(env, floatCount * sizeof(float));
    float* outBuf = static_cast<float*>(ab.Data());
    std::memset(outBuf, 0, floatCount * sizeof(float));
    bool needsRaw = false;

    if (channel >= 0 && channel < numChannels) {
        mm->getPeaks(channel, startSmp, endSmp,
                     targetPixels, outBuf, static_cast<int>(floatCount),
                     needsRaw);
    } else {
        mm->getPeaks(0, startSmp, endSmp,
                     targetPixels, outBuf, static_cast<int>(floatCount),
                     needsRaw);
        if (numChannels > 1) {
            std::vector<float> chBuf(floatCount);
            for (int ch = 1; ch < numChannels; ++ch) {
                bool nr = false;
                mm->getPeaks(ch, startSmp, endSmp,
                             targetPixels, chBuf.data(),
                             static_cast<int>(chBuf.size()), nr);
                for (int c = 0; c < targetPixels; ++c) {
                    const int idx = c * 3;
                    if (chBuf[idx]     < outBuf[idx])     outBuf[idx]     = chBuf[idx];
                    if (chBuf[idx + 1] > outBuf[idx + 1]) outBuf[idx + 1] = chBuf[idx + 1];
                    const float r0 = outBuf[idx + 2], r1 = chBuf[idx + 2];
                    outBuf[idx + 2] = std::sqrt((r0 * r0 + r1 * r1) / 2.0f);
                }
            }
        }
    }

    auto result = Napi::Object::New(env);
    result.Set("peaks",          Napi::Float32Array::New(env, floatCount, ab, 0));
    result.Set("needsRawSamples", Napi::Boolean::New(env, needsRaw));
    result.Set("ready",          Napi::Boolean::New(env, true));
    result.Set("error",          Napi::Boolean::New(env, false));
    result.Set("sampleRate",     Napi::Number::New(env, sr));
    result.Set("totalSamples",   Napi::Number::New(env, static_cast<double>(totalSamples)));
    result.Set("duration",       Napi::Number::New(env, static_cast<double>(totalSamples) / sr));
    return result;
}

// timeline_getAllPatterns() → Pattern[]
Napi::Value Timeline_GetAllPatterns(const Napi::CallbackInfo& info)
{
    Napi::Env env = info.Env();
    if (!g_timeline) {
        Napi::Error::New(env, "Engine not initialised.").ThrowAsJavaScriptException();
        return env.Undefined();
    }
    const auto& patterns = g_timeline->getAllPatterns();
    Napi::Array arr = Napi::Array::New(env, patterns.size());
    uint32_t i = 0;
    for (const auto& [id, p] : patterns)
        arr.Set(i++, patternToJs(env, p));
    return arr;
}

// timeline_removePattern(id)
void Timeline_RemovePattern(const Napi::CallbackInfo& info)
{
    Napi::Env env = info.Env();
    if (!isInitialised() || !g_timeline || !g_undoManager) {
        Napi::Error::New(env, "Engine not initialised.").ThrowAsJavaScriptException();
        return;
    }
    if (info.Length() < 1 || !info[0].IsNumber()) {
        Napi::TypeError::New(env, "timeline_removePattern(id: number)").ThrowAsJavaScriptException();
        return;
    }
    int id = info[0].As<Napi::Number>().Int32Value();
    BridgeCallLog log("timeline.removePattern");
    // Samplers are per-track now, so pattern deletion doesn't orphan a sampler
    // — the track still owns its sampler regardless of which pattern(s) it
    // references. Just execute the command and return.
    g_undoManager->execute(std::make_unique<RemovePatternCommand>(id, *g_timeline), *g_timeline);
    log.done();
}

// timeline_updateSamplerSettings(regionId, { rootNote?, attackMs?, decayMs?, sustain?,
//                                             releaseMs?, loopEnabled?, loopStart?,
//                                             loopEnd?, crossfadeEnabled? })
// Sampler settings are per-SampleRegion (per-instrument) — every pattern that
// binds to this region shares the same sampler and the same settings.
void Timeline_UpdateSamplerSettings(const Napi::CallbackInfo& info)
{
    Napi::Env env = info.Env();
    if (!isInitialised() || !g_timeline || !g_undoManager) {
        Napi::Error::New(env, "Engine not initialised.").ThrowAsJavaScriptException();
        return;
    }
    if (info.Length() < 2 || !info[0].IsNumber() || !info[1].IsObject()) {
        Napi::TypeError::New(env, "timeline_updateSamplerSettings(regionId: number, settings: object)")
            .ThrowAsJavaScriptException();
        return;
    }
    int regionId = info[0].As<Napi::Number>().Int32Value();
    const SampleRegion* r = g_timeline->getRegion(regionId);
    if (!r) {
        Napi::Error::New(env, "Region not found.").ThrowAsJavaScriptException();
        return;
    }
    Napi::Object o = info[1].As<Napi::Object>();
    BridgeCallLog log("timeline.updateSamplerSettings");

    // Start from the region's current settings so caller can supply a partial object.
    SamplerSettings s;
    s.rootNote         = r->rootNote;
    s.attackMs         = r->attackMs;
    s.decayMs          = r->decayMs;
    s.sustain          = r->sustain;
    s.releaseMs        = r->releaseMs;
    s.delayMs          = r->delayMs;
    s.holdMs           = r->holdMs;
    s.attackTension    = r->attackTension;
    s.decayTension     = r->decayTension;
    s.releaseTension   = r->releaseTension;
    s.pitchEnvEnabled       = r->pitchEnvEnabled;
    s.pitchEnvAmount        = r->pitchEnvAmount;
    s.pitchEnvDelayMs       = r->pitchEnvDelayMs;
    s.pitchEnvAttackMs      = r->pitchEnvAttackMs;
    s.pitchEnvHoldMs        = r->pitchEnvHoldMs;
    s.pitchEnvDecayMs       = r->pitchEnvDecayMs;
    s.pitchEnvSustain       = r->pitchEnvSustain;
    s.pitchEnvReleaseMs     = r->pitchEnvReleaseMs;
    s.pitchEnvAttackTension = r->pitchEnvAttackTension;
    s.pitchEnvDecayTension  = r->pitchEnvDecayTension;
    s.pitchEnvReleaseTension = r->pitchEnvReleaseTension;
    s.loopEnabled      = r->loopEnabled;
    s.loopStart        = r->loopStart;
    s.loopEnd          = r->loopEnd;
    s.crossfadeEnabled = r->crossfadeEnabled;
    s.smpStart         = r->smpStart;
    s.smpLength        = r->smpLength;
    s.declickMs         = r->declickMs;
    s.fadeInMs         = r->fadeInMs;
    s.fadeOutMs        = r->fadeOutMs;
    s.crossfadeSamples = r->crossfadeSamples;
    s.dcOffsetRemoved  = r->dcOffsetRemoved;
    s.normalized       = r->normalized;
    s.polarityReversed = r->polarityReversed;
    s.reversed         = r->reversed;
    s.monoEnabled       = r->monoEnabled;
    s.portamentoEnabled = r->portamentoEnabled;
    s.portamentoTimeMs  = r->portamentoTimeMs;
    s.arpEnabled        = r->arpEnabled;
    s.arpTempoSync      = r->arpTempoSync;
    s.arpDivision       = r->arpDivision;
    s.arpFreeTimeMs     = r->arpFreeTimeMs;
    s.arpGate           = r->arpGate;
    s.arpRange          = r->arpRange;
    s.arpDirection      = r->arpDirection;
    // LFO — initial copy
    s.lfoVolEnabled       = r->lfoVolEnabled;
    s.lfoVolAmount        = r->lfoVolAmount;
    s.lfoVolSpeedHz       = r->lfoVolSpeedHz;
    s.lfoVolTempoSync     = r->lfoVolTempoSync;
    s.lfoVolTempoDivision = r->lfoVolTempoDivision;
    s.lfoVolAttackMs      = r->lfoVolAttackMs;
    s.lfoVolDelayMs       = r->lfoVolDelayMs;
    s.lfoVolWaveform      = r->lfoVolWaveform;
    s.lfoPanEnabled       = r->lfoPanEnabled;
    s.lfoPanAmount        = r->lfoPanAmount;
    s.lfoPanSpeedHz       = r->lfoPanSpeedHz;
    s.lfoPanTempoSync     = r->lfoPanTempoSync;
    s.lfoPanTempoDivision = r->lfoPanTempoDivision;
    s.lfoPanAttackMs      = r->lfoPanAttackMs;
    s.lfoPanDelayMs       = r->lfoPanDelayMs;
    s.lfoPanWaveform      = r->lfoPanWaveform;
    s.lfoPitchEnabled       = r->lfoPitchEnabled;
    s.lfoPitchAmount        = r->lfoPitchAmount;
    s.lfoPitchSpeedHz       = r->lfoPitchSpeedHz;
    s.lfoPitchTempoSync     = r->lfoPitchTempoSync;
    s.lfoPitchTempoDivision = r->lfoPitchTempoDivision;
    s.lfoPitchAttackMs      = r->lfoPitchAttackMs;
    s.lfoPitchDelayMs       = r->lfoPitchDelayMs;
    s.lfoPitchWaveform      = r->lfoPitchWaveform;
    if (o.Has("rootNote")         && o.Get("rootNote").IsNumber())
        s.rootNote         = o.Get("rootNote").As<Napi::Number>().Int32Value();
    if (o.Has("attackMs")         && o.Get("attackMs").IsNumber())
        s.attackMs         = o.Get("attackMs").As<Napi::Number>().FloatValue();
    if (o.Has("decayMs")          && o.Get("decayMs").IsNumber())
        s.decayMs          = o.Get("decayMs").As<Napi::Number>().FloatValue();
    if (o.Has("sustain")          && o.Get("sustain").IsNumber())
        s.sustain          = o.Get("sustain").As<Napi::Number>().FloatValue();
    if (o.Has("releaseMs")        && o.Get("releaseMs").IsNumber())
        s.releaseMs        = o.Get("releaseMs").As<Napi::Number>().FloatValue();
    if (o.Has("delayMs")          && o.Get("delayMs").IsNumber())
        s.delayMs          = o.Get("delayMs").As<Napi::Number>().FloatValue();
    if (o.Has("holdMs")           && o.Get("holdMs").IsNumber())
        s.holdMs           = o.Get("holdMs").As<Napi::Number>().FloatValue();
    if (o.Has("attackTension")    && o.Get("attackTension").IsNumber())
        s.attackTension    = o.Get("attackTension").As<Napi::Number>().FloatValue();
    if (o.Has("decayTension")     && o.Get("decayTension").IsNumber())
        s.decayTension     = o.Get("decayTension").As<Napi::Number>().FloatValue();
    if (o.Has("releaseTension")   && o.Get("releaseTension").IsNumber())
        s.releaseTension   = o.Get("releaseTension").As<Napi::Number>().FloatValue();
    if (o.Has("pitchEnvEnabled")        && o.Get("pitchEnvEnabled").IsBoolean())
        s.pitchEnvEnabled        = o.Get("pitchEnvEnabled").As<Napi::Boolean>().Value();
    if (o.Has("pitchEnvAmount")         && o.Get("pitchEnvAmount").IsNumber())
        s.pitchEnvAmount         = o.Get("pitchEnvAmount").As<Napi::Number>().FloatValue();
    if (o.Has("pitchEnvDelayMs")        && o.Get("pitchEnvDelayMs").IsNumber())
        s.pitchEnvDelayMs        = o.Get("pitchEnvDelayMs").As<Napi::Number>().FloatValue();
    if (o.Has("pitchEnvAttackMs")       && o.Get("pitchEnvAttackMs").IsNumber())
        s.pitchEnvAttackMs       = o.Get("pitchEnvAttackMs").As<Napi::Number>().FloatValue();
    if (o.Has("pitchEnvHoldMs")         && o.Get("pitchEnvHoldMs").IsNumber())
        s.pitchEnvHoldMs         = o.Get("pitchEnvHoldMs").As<Napi::Number>().FloatValue();
    if (o.Has("pitchEnvDecayMs")        && o.Get("pitchEnvDecayMs").IsNumber())
        s.pitchEnvDecayMs        = o.Get("pitchEnvDecayMs").As<Napi::Number>().FloatValue();
    if (o.Has("pitchEnvSustain")        && o.Get("pitchEnvSustain").IsNumber())
        s.pitchEnvSustain        = o.Get("pitchEnvSustain").As<Napi::Number>().FloatValue();
    if (o.Has("pitchEnvReleaseMs")      && o.Get("pitchEnvReleaseMs").IsNumber())
        s.pitchEnvReleaseMs      = o.Get("pitchEnvReleaseMs").As<Napi::Number>().FloatValue();
    if (o.Has("pitchEnvAttackTension")  && o.Get("pitchEnvAttackTension").IsNumber())
        s.pitchEnvAttackTension  = o.Get("pitchEnvAttackTension").As<Napi::Number>().FloatValue();
    if (o.Has("pitchEnvDecayTension")   && o.Get("pitchEnvDecayTension").IsNumber())
        s.pitchEnvDecayTension   = o.Get("pitchEnvDecayTension").As<Napi::Number>().FloatValue();
    if (o.Has("pitchEnvReleaseTension") && o.Get("pitchEnvReleaseTension").IsNumber())
        s.pitchEnvReleaseTension = o.Get("pitchEnvReleaseTension").As<Napi::Number>().FloatValue();
    if (o.Has("loopEnabled")      && o.Get("loopEnabled").IsBoolean())
        s.loopEnabled      = o.Get("loopEnabled").As<Napi::Boolean>().Value();
    if (o.Has("loopStart")        && o.Get("loopStart").IsNumber())
        s.loopStart        = static_cast<int64_t>(o.Get("loopStart").As<Napi::Number>().DoubleValue());
    if (o.Has("loopEnd")          && o.Get("loopEnd").IsNumber())
        s.loopEnd          = static_cast<int64_t>(o.Get("loopEnd").As<Napi::Number>().DoubleValue());
    if (o.Has("crossfadeEnabled") && o.Get("crossfadeEnabled").IsBoolean())
        s.crossfadeEnabled = o.Get("crossfadeEnabled").As<Napi::Boolean>().Value();
    if (o.Has("smpStart")       && o.Get("smpStart").IsNumber())
        s.smpStart       = static_cast<int64_t>(o.Get("smpStart").As<Napi::Number>().DoubleValue());
    if (o.Has("smpLength")      && o.Get("smpLength").IsNumber())
        s.smpLength      = static_cast<int64_t>(o.Get("smpLength").As<Napi::Number>().DoubleValue());
    if (o.Has("declickMs")      && o.Get("declickMs").IsNumber())
        s.declickMs      = o.Get("declickMs").As<Napi::Number>().FloatValue();
    if (o.Has("fadeInMs")  && o.Get("fadeInMs").IsNumber())
        s.fadeInMs  = o.Get("fadeInMs").As<Napi::Number>().FloatValue();
    if (o.Has("fadeOutMs") && o.Get("fadeOutMs").IsNumber())
        s.fadeOutMs = o.Get("fadeOutMs").As<Napi::Number>().FloatValue();
    if (o.Has("crossfadeSamples") && o.Get("crossfadeSamples").IsNumber())
        s.crossfadeSamples = static_cast<int64_t>(o.Get("crossfadeSamples").As<Napi::Number>().DoubleValue());
    if (o.Has("dcOffsetRemoved")  && o.Get("dcOffsetRemoved").IsBoolean())
        s.dcOffsetRemoved  = o.Get("dcOffsetRemoved").As<Napi::Boolean>().Value();
    if (o.Has("normalized")       && o.Get("normalized").IsBoolean())
        s.normalized       = o.Get("normalized").As<Napi::Boolean>().Value();
    if (o.Has("polarityReversed") && o.Get("polarityReversed").IsBoolean())
        s.polarityReversed = o.Get("polarityReversed").As<Napi::Boolean>().Value();
    if (o.Has("reversed")         && o.Get("reversed").IsBoolean())
        s.reversed         = o.Get("reversed").As<Napi::Boolean>().Value();
    if (o.Has("monoEnabled")       && o.Get("monoEnabled").IsBoolean())
        s.monoEnabled       = o.Get("monoEnabled").As<Napi::Boolean>().Value();
    if (o.Has("portamentoEnabled") && o.Get("portamentoEnabled").IsBoolean())
        s.portamentoEnabled = o.Get("portamentoEnabled").As<Napi::Boolean>().Value();
    if (o.Has("portamentoTimeMs")  && o.Get("portamentoTimeMs").IsNumber())
        s.portamentoTimeMs  = o.Get("portamentoTimeMs").As<Napi::Number>().FloatValue();
    if (o.Has("arpEnabled")        && o.Get("arpEnabled").IsBoolean())
        s.arpEnabled        = o.Get("arpEnabled").As<Napi::Boolean>().Value();
    if (o.Has("arpTempoSync")      && o.Get("arpTempoSync").IsBoolean())
        s.arpTempoSync      = o.Get("arpTempoSync").As<Napi::Boolean>().Value();
    if (o.Has("arpDivision")       && o.Get("arpDivision").IsNumber())
        s.arpDivision       = o.Get("arpDivision").As<Napi::Number>().Int32Value();
    if (o.Has("arpFreeTimeMs")     && o.Get("arpFreeTimeMs").IsNumber())
        s.arpFreeTimeMs     = o.Get("arpFreeTimeMs").As<Napi::Number>().FloatValue();
    if (o.Has("arpGate")           && o.Get("arpGate").IsNumber())
        s.arpGate           = o.Get("arpGate").As<Napi::Number>().FloatValue();
    if (o.Has("arpRange")          && o.Get("arpRange").IsNumber())
        s.arpRange          = o.Get("arpRange").As<Napi::Number>().Int32Value();
    if (o.Has("arpDirection")      && o.Get("arpDirection").IsNumber())
        s.arpDirection      = o.Get("arpDirection").As<Napi::Number>().Int32Value();
    // ── LFO merge ───────────────────────────────────────────────────────────
    auto parseLfoWaveform = [&](const char* key, std::vector<SampleRegion::LfoBreakpoint>& out) {
        if (o.Has(key) && o.Get(key).IsArray()) {
            Napi::Array a = o.Get(key).As<Napi::Array>();
            out.clear();
            out.reserve(a.Length());
            for (uint32_t i = 0; i < a.Length(); ++i) {
                if (!a.Get(i).IsObject()) continue;
                Napi::Object pt = a.Get(i).As<Napi::Object>();
                SampleRegion::LfoBreakpoint bp;
                bp.time  = pt.Has("t") && pt.Get("t").IsNumber() ? pt.Get("t").As<Napi::Number>().FloatValue() : 0.0f;
                bp.value = pt.Has("v") && pt.Get("v").IsNumber() ? pt.Get("v").As<Napi::Number>().FloatValue() : 0.0f;
                out.push_back(bp);
            }
        }
    };
    // Volume LFO
    if (o.Has("lfoVolEnabled")       && o.Get("lfoVolEnabled").IsBoolean())
        s.lfoVolEnabled       = o.Get("lfoVolEnabled").As<Napi::Boolean>().Value();
    if (o.Has("lfoVolAmount")        && o.Get("lfoVolAmount").IsNumber())
        s.lfoVolAmount        = o.Get("lfoVolAmount").As<Napi::Number>().FloatValue();
    if (o.Has("lfoVolSpeedHz")       && o.Get("lfoVolSpeedHz").IsNumber())
        s.lfoVolSpeedHz       = o.Get("lfoVolSpeedHz").As<Napi::Number>().FloatValue();
    if (o.Has("lfoVolTempoSync")     && o.Get("lfoVolTempoSync").IsBoolean())
        s.lfoVolTempoSync     = o.Get("lfoVolTempoSync").As<Napi::Boolean>().Value();
    if (o.Has("lfoVolTempoDivision") && o.Get("lfoVolTempoDivision").IsNumber())
        s.lfoVolTempoDivision = o.Get("lfoVolTempoDivision").As<Napi::Number>().Int32Value();
    if (o.Has("lfoVolAttackMs")      && o.Get("lfoVolAttackMs").IsNumber())
        s.lfoVolAttackMs      = o.Get("lfoVolAttackMs").As<Napi::Number>().FloatValue();
    if (o.Has("lfoVolDelayMs")       && o.Get("lfoVolDelayMs").IsNumber())
        s.lfoVolDelayMs       = o.Get("lfoVolDelayMs").As<Napi::Number>().FloatValue();
    parseLfoWaveform("lfoVolWaveform", s.lfoVolWaveform);
    // Panning LFO
    if (o.Has("lfoPanEnabled")       && o.Get("lfoPanEnabled").IsBoolean())
        s.lfoPanEnabled       = o.Get("lfoPanEnabled").As<Napi::Boolean>().Value();
    if (o.Has("lfoPanAmount")        && o.Get("lfoPanAmount").IsNumber())
        s.lfoPanAmount        = o.Get("lfoPanAmount").As<Napi::Number>().FloatValue();
    if (o.Has("lfoPanSpeedHz")       && o.Get("lfoPanSpeedHz").IsNumber())
        s.lfoPanSpeedHz       = o.Get("lfoPanSpeedHz").As<Napi::Number>().FloatValue();
    if (o.Has("lfoPanTempoSync")     && o.Get("lfoPanTempoSync").IsBoolean())
        s.lfoPanTempoSync     = o.Get("lfoPanTempoSync").As<Napi::Boolean>().Value();
    if (o.Has("lfoPanTempoDivision") && o.Get("lfoPanTempoDivision").IsNumber())
        s.lfoPanTempoDivision = o.Get("lfoPanTempoDivision").As<Napi::Number>().Int32Value();
    if (o.Has("lfoPanAttackMs")      && o.Get("lfoPanAttackMs").IsNumber())
        s.lfoPanAttackMs      = o.Get("lfoPanAttackMs").As<Napi::Number>().FloatValue();
    if (o.Has("lfoPanDelayMs")       && o.Get("lfoPanDelayMs").IsNumber())
        s.lfoPanDelayMs       = o.Get("lfoPanDelayMs").As<Napi::Number>().FloatValue();
    parseLfoWaveform("lfoPanWaveform", s.lfoPanWaveform);
    // Pitch LFO
    if (o.Has("lfoPitchEnabled")       && o.Get("lfoPitchEnabled").IsBoolean())
        s.lfoPitchEnabled       = o.Get("lfoPitchEnabled").As<Napi::Boolean>().Value();
    if (o.Has("lfoPitchAmount")        && o.Get("lfoPitchAmount").IsNumber())
        s.lfoPitchAmount        = o.Get("lfoPitchAmount").As<Napi::Number>().FloatValue();
    if (o.Has("lfoPitchSpeedHz")       && o.Get("lfoPitchSpeedHz").IsNumber())
        s.lfoPitchSpeedHz       = o.Get("lfoPitchSpeedHz").As<Napi::Number>().FloatValue();
    if (o.Has("lfoPitchTempoSync")     && o.Get("lfoPitchTempoSync").IsBoolean())
        s.lfoPitchTempoSync     = o.Get("lfoPitchTempoSync").As<Napi::Boolean>().Value();
    if (o.Has("lfoPitchTempoDivision") && o.Get("lfoPitchTempoDivision").IsNumber())
        s.lfoPitchTempoDivision = o.Get("lfoPitchTempoDivision").As<Napi::Number>().Int32Value();
    if (o.Has("lfoPitchAttackMs")      && o.Get("lfoPitchAttackMs").IsNumber())
        s.lfoPitchAttackMs      = o.Get("lfoPitchAttackMs").As<Napi::Number>().FloatValue();
    if (o.Has("lfoPitchDelayMs")       && o.Get("lfoPitchDelayMs").IsNumber())
        s.lfoPitchDelayMs       = o.Get("lfoPitchDelayMs").As<Napi::Number>().FloatValue();
    parseLfoWaveform("lfoPitchWaveform", s.lfoPitchWaveform);

    g_undoManager->execute(std::make_unique<SetSamplerSettingsCommand>(regionId, s, *g_timeline),
                           *g_timeline);
    refreshSamplerForRegion(regionId);
    log.done();
}

// timeline_addPatternBlock({ trackId, patternId, positionTicks, durationTicks, offsetTicks? })
//   → blockId
Napi::Value Timeline_AddPatternBlock(const Napi::CallbackInfo& info)
{
    Napi::Env env = info.Env();
    if (!isInitialised() || !g_timeline || !g_undoManager) {
        Napi::Error::New(env, "Engine not initialised.").ThrowAsJavaScriptException();
        return env.Undefined();
    }
    if (info.Length() < 1 || !info[0].IsObject()) {
        Napi::TypeError::New(env, "timeline_addPatternBlock({ trackId, patternId, positionTicks, durationTicks, offsetTicks? })")
            .ThrowAsJavaScriptException();
        return env.Undefined();
    }
    BridgeCallLog log("timeline.addPatternBlock");

    Napi::Object o = info[0].As<Napi::Object>();
    PatternBlock b;
    b.trackId        = o.Get("trackId").As<Napi::Number>().Int32Value();
    b.patternId      = o.Get("patternId").As<Napi::Number>().Int32Value();
    b.position.ticks = static_cast<int64_t>(o.Get("positionTicks").As<Napi::Number>().DoubleValue());
    b.duration.ticks = static_cast<int64_t>(o.Get("durationTicks").As<Napi::Number>().DoubleValue());
    if (o.Has("offsetTicks") && o.Get("offsetTicks").IsNumber())
        b.offset.ticks = static_cast<int64_t>(o.Get("offsetTicks").As<Napi::Number>().DoubleValue());

    g_undoManager->execute(std::make_unique<AddPatternBlockCommand>(b), *g_timeline);

    auto blocks = g_timeline->getAllPatternBlocks();
    int newId = blocks.empty() ? -1 : blocks.back()->id;
    log.done(std::to_string(newId));
    return Napi::Number::New(env, newId);
}

// timeline_getPatternBlocks() → PatternBlock[]
Napi::Value Timeline_GetPatternBlocks(const Napi::CallbackInfo& info)
{
    Napi::Env env = info.Env();
    if (!g_timeline) {
        Napi::Error::New(env, "Engine not initialised.").ThrowAsJavaScriptException();
        return env.Undefined();
    }
    auto blocks = g_timeline->getAllPatternBlocks();
    Napi::Array arr = Napi::Array::New(env, blocks.size());
    for (size_t i = 0; i < blocks.size(); ++i)
        arr.Set(static_cast<uint32_t>(i), patternBlockToJs(env, *blocks[i]));
    return arr;
}

// timeline_removePatternBlock(id)
void Timeline_RemovePatternBlock(const Napi::CallbackInfo& info)
{
    Napi::Env env = info.Env();
    if (!isInitialised() || !g_timeline || !g_undoManager) {
        Napi::Error::New(env, "Engine not initialised.").ThrowAsJavaScriptException();
        return;
    }
    if (info.Length() < 1 || !info[0].IsNumber()) {
        Napi::TypeError::New(env, "timeline_removePatternBlock(id: number)").ThrowAsJavaScriptException();
        return;
    }
    int id = info[0].As<Napi::Number>().Int32Value();
    BridgeCallLog log("timeline.removePatternBlock");
    g_undoManager->execute(std::make_unique<RemovePatternBlockCommand>(id, *g_timeline), *g_timeline);
    log.done();
}

// timeline_movePatternBlock(id, trackId, posTicks)
void Timeline_MovePatternBlock(const Napi::CallbackInfo& info)
{
    Napi::Env env = info.Env();
    if (!isInitialised() || !g_timeline || !g_undoManager) {
        Napi::Error::New(env, "Engine not initialised.").ThrowAsJavaScriptException();
        return;
    }
    if (info.Length() < 3 || !info[0].IsNumber() || !info[1].IsNumber() || !info[2].IsNumber()) {
        Napi::TypeError::New(env, "timeline_movePatternBlock(id, trackId, posTicks)")
            .ThrowAsJavaScriptException();
        return;
    }
    int     id       = info[0].As<Napi::Number>().Int32Value();
    int     trackId  = info[1].As<Napi::Number>().Int32Value();
    int64_t posTicks = static_cast<int64_t>(info[2].As<Napi::Number>().DoubleValue());
    BridgeCallLog log("timeline.movePatternBlock");

    TickTime newPos; newPos.ticks = posTicks;
    g_undoManager->execute(std::make_unique<MovePatternBlockCommand>(id, trackId, newPos, *g_timeline),
                           *g_timeline);
    log.done();
}

// timeline_resizePatternBlock(id, durTicks)
void Timeline_ResizePatternBlock(const Napi::CallbackInfo& info)
{
    Napi::Env env = info.Env();
    if (!isInitialised() || !g_timeline || !g_undoManager) {
        Napi::Error::New(env, "Engine not initialised.").ThrowAsJavaScriptException();
        return;
    }
    if (info.Length() < 2 || !info[0].IsNumber() || !info[1].IsNumber()) {
        Napi::TypeError::New(env, "timeline_resizePatternBlock(id, durTicks)")
            .ThrowAsJavaScriptException();
        return;
    }
    int     id       = info[0].As<Napi::Number>().Int32Value();
    int64_t durTicks = static_cast<int64_t>(info[1].As<Napi::Number>().DoubleValue());
    BridgeCallLog log("timeline.resizePatternBlock");

    TickTime newDur; newDur.ticks = durTicks;
    g_undoManager->execute(std::make_unique<ResizePatternBlockCommand>(id, newDur, *g_timeline),
                           *g_timeline);
    log.done();
}

// timeline_resizePatternBlockLeft(id, newPosTicks, newDurTicks, newOffsetTicks)
void Timeline_ResizePatternBlockLeft(const Napi::CallbackInfo& info)
{
    Napi::Env env = info.Env();
    if (!isInitialised() || !g_timeline || !g_undoManager) {
        Napi::Error::New(env, "Engine not initialised.").ThrowAsJavaScriptException();
        return;
    }
    if (info.Length() < 4 || !info[0].IsNumber() || !info[1].IsNumber() ||
        !info[2].IsNumber() || !info[3].IsNumber()) {
        Napi::TypeError::New(env, "timeline_resizePatternBlockLeft(id, newPosTicks, newDurTicks, newOffsetTicks)")
            .ThrowAsJavaScriptException();
        return;
    }
    int     id             = info[0].As<Napi::Number>().Int32Value();
    int64_t newPosTicks    = static_cast<int64_t>(info[1].As<Napi::Number>().DoubleValue());
    int64_t newDurTicks    = static_cast<int64_t>(info[2].As<Napi::Number>().DoubleValue());
    int64_t newOffsetTicks = static_cast<int64_t>(info[3].As<Napi::Number>().DoubleValue());
    BridgeCallLog log("timeline.resizePatternBlockLeft");

    TickTime newPos; newPos.ticks = newPosTicks;
    TickTime newDur; newDur.ticks = newDurTicks;
    TickTime newOff; newOff.ticks = newOffsetTicks;
    g_undoManager->execute(
        std::make_unique<ResizePatternBlockLeftCommand>(id, newPos, newDur, newOff, *g_timeline),
        *g_timeline);
    log.done();
}

// timeline_setPatternBlockLoop(id, enabled)
void Timeline_SetPatternBlockLoop(const Napi::CallbackInfo& info)
{
    Napi::Env env = info.Env();
    if (!isInitialised() || !g_timeline || !g_undoManager) {
        Napi::Error::New(env, "Engine not initialised.").ThrowAsJavaScriptException();
        return;
    }
    if (info.Length() < 2 || !info[0].IsNumber() || !info[1].IsBoolean()) {
        Napi::TypeError::New(env, "timeline_setPatternBlockLoop(id, enabled: boolean)")
            .ThrowAsJavaScriptException();
        return;
    }
    int  id      = info[0].As<Napi::Number>().Int32Value();
    bool enabled = info[1].As<Napi::Boolean>().Value();
    BridgeCallLog log("timeline.setPatternBlockLoop");
    g_undoManager->execute(std::make_unique<SetPatternBlockLoopCommand>(id, enabled, *g_timeline),
                           *g_timeline);
    log.done();
}

// timeline_addNote(patternId, { positionTicks, durationTicks, pitch, velocity? }) → noteId
Napi::Value Timeline_AddNote(const Napi::CallbackInfo& info)
{
    Napi::Env env = info.Env();
    if (!isInitialised() || !g_timeline || !g_undoManager) {
        Napi::Error::New(env, "Engine not initialised.").ThrowAsJavaScriptException();
        return env.Undefined();
    }
    if (info.Length() < 2 || !info[0].IsNumber() || !info[1].IsObject()) {
        Napi::TypeError::New(env, "timeline_addNote(patternId: number, note: object)")
            .ThrowAsJavaScriptException();
        return env.Undefined();
    }
    int patternId = info[0].As<Napi::Number>().Int32Value();
    BridgeCallLog log("timeline.addNote");

    PatternNote n = jsToPatternNote(info[1].As<Napi::Object>());
    g_undoManager->execute(std::make_unique<AddNoteCommand>(patternId, n), *g_timeline);

    // Recover new note ID: it's the last note in the pattern.
    const Pattern* p = g_timeline->getPattern(patternId);
    int newId = (p && !p->notes.empty()) ? p->notes.back().id : -1;
    log.done(std::to_string(newId));
    return Napi::Number::New(env, newId);
}

// timeline_removeNote(patternId, noteId)
void Timeline_RemoveNote(const Napi::CallbackInfo& info)
{
    Napi::Env env = info.Env();
    if (!isInitialised() || !g_timeline || !g_undoManager) {
        Napi::Error::New(env, "Engine not initialised.").ThrowAsJavaScriptException();
        return;
    }
    if (info.Length() < 2 || !info[0].IsNumber() || !info[1].IsNumber()) {
        Napi::TypeError::New(env, "timeline_removeNote(patternId, noteId)")
            .ThrowAsJavaScriptException();
        return;
    }
    int patternId = info[0].As<Napi::Number>().Int32Value();
    int noteId    = info[1].As<Napi::Number>().Int32Value();
    BridgeCallLog log("timeline.removeNote");
    g_undoManager->execute(std::make_unique<RemoveNoteCommand>(patternId, noteId, *g_timeline),
                           *g_timeline);
    log.done();
}

// timeline_moveNote(patternId, noteId, posTicks, pitch)
void Timeline_MoveNote(const Napi::CallbackInfo& info)
{
    Napi::Env env = info.Env();
    if (!isInitialised() || !g_timeline || !g_undoManager) {
        Napi::Error::New(env, "Engine not initialised.").ThrowAsJavaScriptException();
        return;
    }
    if (info.Length() < 4 || !info[0].IsNumber() || !info[1].IsNumber()
        || !info[2].IsNumber() || !info[3].IsNumber()) {
        Napi::TypeError::New(env, "timeline_moveNote(patternId, noteId, posTicks, pitch)")
            .ThrowAsJavaScriptException();
        return;
    }
    int     patternId = info[0].As<Napi::Number>().Int32Value();
    int     noteId    = info[1].As<Napi::Number>().Int32Value();
    int64_t posTicks  = static_cast<int64_t>(info[2].As<Napi::Number>().DoubleValue());
    int     pitch     = info[3].As<Napi::Number>().Int32Value();
    BridgeCallLog log("timeline.moveNote");

    TickTime newPos; newPos.ticks = posTicks;
    g_undoManager->execute(
        std::make_unique<MoveNoteCommand>(patternId, noteId, newPos, pitch, *g_timeline),
        *g_timeline);
    log.done();
}

// timeline_moveNotesBatch(patternId, moves[])
// moves = [{ noteId, positionTicks, pitch }, ...]
// Folds N moves into a single undo entry.
void Timeline_MoveNotesBatch(const Napi::CallbackInfo& info)
{
    Napi::Env env = info.Env();
    if (!isInitialised() || !g_timeline || !g_undoManager) {
        Napi::Error::New(env, "Engine not initialised.").ThrowAsJavaScriptException();
        return;
    }
    if (info.Length() < 2 || !info[0].IsNumber() || !info[1].IsArray()) {
        Napi::TypeError::New(env, "timeline_moveNotesBatch(patternId, moves: array)")
            .ThrowAsJavaScriptException();
        return;
    }
    int patternId = info[0].As<Napi::Number>().Int32Value();
    Napi::Array arr = info[1].As<Napi::Array>();
    std::vector<MoveNotesBatchCommand::Move> moves;
    moves.reserve(arr.Length());
    for (uint32_t i = 0; i < arr.Length(); ++i) {
        Napi::Value v = arr.Get(i);
        if (!v.IsObject()) continue;
        Napi::Object o = v.As<Napi::Object>();
        if (!o.Has("noteId") || !o.Has("positionTicks") || !o.Has("pitch")) continue;
        MoveNotesBatchCommand::Move m;
        m.noteId = o.Get("noteId").As<Napi::Number>().Int32Value();
        m.newPosition.ticks = static_cast<int64_t>(
            o.Get("positionTicks").As<Napi::Number>().DoubleValue());
        m.newPitch = o.Get("pitch").As<Napi::Number>().Int32Value();
        moves.push_back(m);
    }
    if (moves.empty()) return;
    BridgeCallLog log("timeline.moveNotesBatch");
    g_undoManager->execute(
        std::make_unique<MoveNotesBatchCommand>(patternId, std::move(moves), *g_timeline),
        *g_timeline);
    log.done();
}

// timeline_quantizeClipsBatch(specs[])
// specs = [{ id, isPatternBlock, newStartTicks, newEndTicks, newOffsetTicks,
//            newStretchRatio }, ...]
// The UI pre-computes the new geometry; this handler snapshots the current
// state for undo and applies all changes in one atomic command.
void Timeline_QuantizeClipsBatch(const Napi::CallbackInfo& info)
{
    Napi::Env env = info.Env();
    if (!isInitialised() || !g_timeline || !g_undoManager) {
        Napi::Error::New(env, "Engine not initialised.").ThrowAsJavaScriptException();
        return;
    }
    if (info.Length() < 1 || !info[0].IsArray()) {
        Napi::TypeError::New(env, "timeline_quantizeClipsBatch(specs: array)")
            .ThrowAsJavaScriptException();
        return;
    }
    Napi::Array arr = info[0].As<Napi::Array>();
    std::vector<QuantizeClipsBatchCommand::QuantizeClipSnapshot> snaps;
    snaps.reserve(arr.Length());
    for (uint32_t i = 0; i < arr.Length(); ++i) {
        Napi::Value v = arr.Get(i);
        if (!v.IsObject()) continue;
        Napi::Object o = v.As<Napi::Object>();
        if (!o.Has("id") || !o.Has("isPatternBlock")
            || !o.Has("newStartTicks") || !o.Has("newEndTicks")
            || !o.Has("newOffsetTicks")) continue;

        QuantizeClipsBatchCommand::QuantizeClipSnapshot s;
        s.id             = o.Get("id").As<Napi::Number>().Int32Value();
        s.isPatternBlock = o.Get("isPatternBlock").As<Napi::Boolean>().Value();
        s.newStart       = static_cast<int64_t>(o.Get("newStartTicks").As<Napi::Number>().DoubleValue());
        s.newEnd         = static_cast<int64_t>(o.Get("newEndTicks").As<Napi::Number>().DoubleValue());
        s.newOffset      = static_cast<int64_t>(o.Get("newOffsetTicks").As<Napi::Number>().DoubleValue());
        s.newStretch     = o.Has("newStretchRatio")
            ? o.Get("newStretchRatio").As<Napi::Number>().DoubleValue()
            : 1.0;

        // Capture old state from the timeline.
        if (s.isPatternBlock) {
            const PatternBlock* pb = g_timeline->getPatternBlock(s.id);
            if (!pb) {
                std::cerr << "[Quantize] patternBlock id=" << s.id << " not found, skipping\n";
                continue;
            }
            s.oldStart   = pb->position.ticks;
            s.oldEnd     = pb->position.ticks + pb->duration.ticks;
            s.oldOffset  = pb->offset.ticks;
            s.oldStretch = 1.0;
            s.newStretch = 1.0; // ignored for pattern blocks
        } else {
            const Clip* c = g_timeline->getClip(s.id);
            if (!c) {
                std::cerr << "[Quantize] clip id=" << s.id << " not found, skipping\n";
                continue;
            }
            s.oldStart   = c->position.ticks;
            s.oldEnd     = c->position.ticks + c->duration.ticks;
            s.oldOffset  = c->regionOffset.ticks;
            s.oldStretch = c->stretchRatio;
        }
        snaps.push_back(s);
    }
    if (snaps.empty()) return;
    BridgeCallLog log("timeline.quantizeClipsBatch");
    g_undoManager->execute(
        std::make_unique<QuantizeClipsBatchCommand>(std::move(snaps)),
        *g_timeline);
    log.done();
}

// timeline_resizeNotesBatch(patternId, resizes[])
// resizes = [{ noteId, durationTicks }, ...]
// Folds N resizes into a single undo entry.
void Timeline_ResizeNotesBatch(const Napi::CallbackInfo& info)
{
    Napi::Env env = info.Env();
    if (!isInitialised() || !g_timeline || !g_undoManager) {
        Napi::Error::New(env, "Engine not initialised.").ThrowAsJavaScriptException();
        return;
    }
    if (info.Length() < 2 || !info[0].IsNumber() || !info[1].IsArray()) {
        Napi::TypeError::New(env, "timeline_resizeNotesBatch(patternId, resizes: array)")
            .ThrowAsJavaScriptException();
        return;
    }
    int patternId = info[0].As<Napi::Number>().Int32Value();
    Napi::Array arr = info[1].As<Napi::Array>();
    std::vector<ResizeNotesBatchCommand::Resize> resizes;
    resizes.reserve(arr.Length());
    for (uint32_t i = 0; i < arr.Length(); ++i) {
        Napi::Value v = arr.Get(i);
        if (!v.IsObject()) continue;
        Napi::Object o = v.As<Napi::Object>();
        if (!o.Has("noteId") || !o.Has("durationTicks")) continue;
        ResizeNotesBatchCommand::Resize r;
        r.noteId = o.Get("noteId").As<Napi::Number>().Int32Value();
        r.newDuration.ticks = static_cast<int64_t>(
            o.Get("durationTicks").As<Napi::Number>().DoubleValue());
        resizes.push_back(r);
    }
    if (resizes.empty()) return;
    BridgeCallLog log("timeline.resizeNotesBatch");
    g_undoManager->execute(
        std::make_unique<ResizeNotesBatchCommand>(patternId, std::move(resizes), *g_timeline),
        *g_timeline);
    log.done();
}

// timeline_resizeNote(patternId, noteId, durTicks)
void Timeline_ResizeNote(const Napi::CallbackInfo& info)
{
    Napi::Env env = info.Env();
    if (!isInitialised() || !g_timeline || !g_undoManager) {
        Napi::Error::New(env, "Engine not initialised.").ThrowAsJavaScriptException();
        return;
    }
    if (info.Length() < 3 || !info[0].IsNumber() || !info[1].IsNumber() || !info[2].IsNumber()) {
        Napi::TypeError::New(env, "timeline_resizeNote(patternId, noteId, durTicks)")
            .ThrowAsJavaScriptException();
        return;
    }
    int     patternId = info[0].As<Napi::Number>().Int32Value();
    int     noteId    = info[1].As<Napi::Number>().Int32Value();
    int64_t durTicks  = static_cast<int64_t>(info[2].As<Napi::Number>().DoubleValue());
    BridgeCallLog log("timeline.resizeNote");

    TickTime newDur; newDur.ticks = durTicks;
    g_undoManager->execute(
        std::make_unique<ResizeNoteCommand>(patternId, noteId, newDur, *g_timeline),
        *g_timeline);
    log.done();
}

// timeline_setNoteVelocity(patternId, noteId, velocity)
void Timeline_SetNoteVelocity(const Napi::CallbackInfo& info)
{
    Napi::Env env = info.Env();
    if (!isInitialised() || !g_timeline || !g_undoManager) {
        Napi::Error::New(env, "Engine not initialised.").ThrowAsJavaScriptException();
        return;
    }
    if (info.Length() < 3 || !info[0].IsNumber() || !info[1].IsNumber() || !info[2].IsNumber()) {
        Napi::TypeError::New(env, "timeline_setNoteVelocity(patternId, noteId, velocity)")
            .ThrowAsJavaScriptException();
        return;
    }
    int   patternId = info[0].As<Napi::Number>().Int32Value();
    int   noteId    = info[1].As<Napi::Number>().Int32Value();
    float velocity  = info[2].As<Napi::Number>().FloatValue();
    BridgeCallLog log("timeline.setNoteVelocity");
    g_undoManager->execute(
        std::make_unique<SetNoteVelocityCommand>(patternId, noteId, velocity, *g_timeline),
        *g_timeline);
    log.done();
}

// timeline_previewNote(regionId, pitch, velocity) — fires noteOn on the
// region's Sampler for audition while transport is stopped. Not undoable.
void Timeline_PreviewNote(const Napi::CallbackInfo& info)
{
    Napi::Env env = info.Env();
    if (!isInitialised() || !g_timeline) {
        Napi::Error::New(env, "Engine not initialised.").ThrowAsJavaScriptException();
        return;
    }
    if (info.Length() < 3 || !info[0].IsNumber() || !info[1].IsNumber() || !info[2].IsNumber()) {
        Napi::TypeError::New(env, "timeline_previewNote(regionId, pitch, velocity)")
            .ThrowAsJavaScriptException();
        return;
    }
    int   regionId = info[0].As<Napi::Number>().Int32Value();
    int   pitch    = info[1].As<Napi::Number>().Int32Value();
    float velocity = info[2].As<Napi::Number>().FloatValue();

    auto& mix = audioEngine->getMixEngine();
    if (!mix.hasPreviewSampler(regionId)) mix.ensurePreviewSampler(regionId);
    Sampler* s = mix.getPreviewSamplerPtr(regionId);
    if (s == nullptr) return;
    s->noteOn(pitch, velocity);
}

// timeline_previewNoteOff(regionId, pitch) — fires noteOff for a previously
// auditioned note so sustained envelopes release cleanly. Not undoable.
void Timeline_PreviewNoteOff(const Napi::CallbackInfo& info)
{
    Napi::Env env = info.Env();
    if (!isInitialised() || !g_timeline) {
        Napi::Error::New(env, "Engine not initialised.").ThrowAsJavaScriptException();
        return;
    }
    if (info.Length() < 2 || !info[0].IsNumber() || !info[1].IsNumber()) {
        Napi::TypeError::New(env, "timeline_previewNoteOff(regionId, pitch)")
            .ThrowAsJavaScriptException();
        return;
    }
    int regionId = info[0].As<Napi::Number>().Int32Value();
    int pitch    = info[1].As<Napi::Number>().Int32Value();

    auto& mix = audioEngine->getMixEngine();
    if (!mix.hasPreviewSampler(regionId)) return;
    Sampler* s = mix.getPreviewSamplerPtr(regionId);
    if (s == nullptr) return;
    s->noteOff(pitch);
}

// timeline_previewAllNotesOff(regionId) — releases every held preview note on
// the region's Sampler. Used when the piano roll loses focus/unmounts to
// prevent stuck notes. Not undoable.
void Timeline_PreviewAllNotesOff(const Napi::CallbackInfo& info)
{
    Napi::Env env = info.Env();
    if (!isInitialised() || !g_timeline) {
        Napi::Error::New(env, "Engine not initialised.").ThrowAsJavaScriptException();
        return;
    }
    if (info.Length() < 1 || !info[0].IsNumber()) {
        Napi::TypeError::New(env, "timeline_previewAllNotesOff(regionId)")
            .ThrowAsJavaScriptException();
        return;
    }
    int regionId = info[0].As<Napi::Number>().Int32Value();

    auto& mix = audioEngine->getMixEngine();
    if (!mix.hasPreviewSampler(regionId)) return;
    Sampler* s = mix.getPreviewSamplerPtr(regionId);
    if (s == nullptr) return;
    s->allNotesOff();
}

// timeline_convertToPatternTrack(trackId)
void Timeline_ConvertToPatternTrack(const Napi::CallbackInfo& info)
{
    Napi::Env env = info.Env();
    if (!isInitialised() || !g_timeline || !g_undoManager) {
        Napi::Error::New(env, "Engine not initialised.").ThrowAsJavaScriptException();
        return;
    }
    if (info.Length() < 1 || !info[0].IsNumber()) {
        Napi::TypeError::New(env, "timeline_convertToPatternTrack(trackId)")
            .ThrowAsJavaScriptException();
        return;
    }
    int trackId = info[0].As<Napi::Number>().Int32Value();
    BridgeCallLog log("timeline.convertToPatternTrack");
    g_undoManager->execute(
        std::make_unique<ConvertTrackTypeCommand>(trackId, TrackInfo::Type::Pattern,
                                                  *g_timeline),
        *g_timeline);
    // Pattern tracks are now sample-agnostic — samplers get created lazily
    // per {trackId, regionId} as PatternBlocks are dropped onto the track.
    log.done();
}

// timeline_convertToClipTrack(trackId)
void Timeline_ConvertToClipTrack(const Napi::CallbackInfo& info)
{
    Napi::Env env = info.Env();
    if (!isInitialised() || !g_timeline || !g_undoManager) {
        Napi::Error::New(env, "Engine not initialised.").ThrowAsJavaScriptException();
        return;
    }
    if (info.Length() < 1 || !info[0].IsNumber()) {
        Napi::TypeError::New(env, "timeline_convertToClipTrack(trackId)").ThrowAsJavaScriptException();
        return;
    }
    int trackId = info[0].As<Napi::Number>().Int32Value();
    BridgeCallLog log("timeline.convertToClipTrack");
    g_undoManager->execute(
        std::make_unique<ConvertTrackTypeCommand>(trackId, TrackInfo::Type::Clip, *g_timeline),
        *g_timeline);
    // Release every sampler pair this track owned — clip tracks don't need any.
    if (audioEngine) audioEngine->getMixEngine().unloadSamplersForTrack(trackId);
    log.done();
}

// timeline_setVideoFlipConfig(trackId, configObj)
// New v2 entry: accepts a full VideoFlipConfig object from the renderer.
void Timeline_SetVideoFlipConfig(const Napi::CallbackInfo& info)
{
    Napi::Env env = info.Env();
    if (!isInitialised() || !g_timeline || !g_undoManager) {
        Napi::Error::New(env, "Engine not initialised.").ThrowAsJavaScriptException();
        return;
    }
    if (info.Length() < 2 || !info[0].IsNumber() || !info[1].IsObject()) {
        Napi::TypeError::New(env,
            "timeline_setVideoFlipConfig(trackId: number, config: VideoFlipConfig)")
            .ThrowAsJavaScriptException();
        return;
    }
    int          trackId = info[0].As<Napi::Number>().Int32Value();
    Napi::Object obj     = info[1].As<Napi::Object>();

    VideoFlipConfig cfg;

    if (obj.Has("enabled") && obj.Get("enabled").IsBoolean())
        cfg.enabled = obj.Get("enabled").As<Napi::Boolean>().Value();
    if (obj.Has("startStateIndex") && obj.Get("startStateIndex").IsNumber())
        cfg.startStateIndex = obj.Get("startStateIndex").As<Napi::Number>().Int32Value();

    if (obj.Has("states") && obj.Get("states").IsArray()) {
        cfg.states.clear();
        auto arr = obj.Get("states").As<Napi::Array>();
        for (uint32_t i = 0; i < arr.Length(); ++i) {
            if (!arr.Get(i).IsObject()) continue;
            Napi::Object s = arr.Get(i).As<Napi::Object>();
            VideoFlipState st;
            if (s.Has("id") && s.Get("id").IsString())
                st.id = s.Get("id").As<Napi::String>().Utf8Value();
            if (s.Has("orientation") && s.Get("orientation").IsString())
                st.orientation = stringToOrientation(
                    s.Get("orientation").As<Napi::String>().Utf8Value());
            if (s.Has("label") && s.Get("label").IsString())
                st.label = s.Get("label").As<Napi::String>().Utf8Value();
            cfg.states.push_back(st);
        }
    }
    if (cfg.states.empty())
        cfg.states = { {"s0", Orientation::None, ""} };

    if (obj.Has("modifier") && obj.Get("modifier").IsObject()) {
        Napi::Object mod = obj.Get("modifier").As<Napi::Object>();
        if (mod.Has("type") && mod.Get("type").IsString())
            cfg.modifier.type = stringToVideoFlipModifierType(
                mod.Get("type").As<Napi::String>().Utf8Value());
        if (mod.Has("config") && mod.Get("config").IsObject()) {
            Napi::Object c = mod.Get("config").As<Napi::Object>();
            if (cfg.modifier.type == VideoFlipModifier::Type::SpecificPitches) {
                if (c.Has("pitches") && c.Get("pitches").IsArray()) {
                    cfg.modifier.pitches.clear();
                    auto pa = c.Get("pitches").As<Napi::Array>();
                    for (uint32_t i = 0; i < pa.Length(); ++i)
                        if (pa.Get(i).IsNumber())
                            cfg.modifier.pitches.push_back(
                                pa.Get(i).As<Napi::Number>().Int32Value());
                }
            } else if (cfg.modifier.type == VideoFlipModifier::Type::EveryNBeats) {
                if (c.Has("n") && c.Get("n").IsNumber())
                    cfg.modifier.n = c.Get("n").As<Napi::Number>().Int32Value();
                if (c.Has("subdivision") && c.Get("subdivision").IsString())
                    cfg.modifier.subdivision = stringToVideoFlipSubdivision(
                        c.Get("subdivision").As<Napi::String>().Utf8Value());
            }
        }
    }

    // Clamp startStateIndex after parsing.
    if (!cfg.states.empty()) {
        if (cfg.startStateIndex < 0) cfg.startStateIndex = 0;
        if (cfg.startStateIndex >= static_cast<int>(cfg.states.size()))
            cfg.startStateIndex = static_cast<int>(cfg.states.size()) - 1;
    }

    BridgeCallLog log("timeline.setVideoFlipConfig");
    g_undoManager->execute(
        std::make_unique<SetVideoFlipConfigCommand>(trackId, std::move(cfg), *g_timeline),
        *g_timeline);
    log.done();
}

// timeline_setVideoHoldLastFrame(trackId, hold)
void Timeline_SetVideoHoldLastFrame(const Napi::CallbackInfo& info)
{
    Napi::Env env = info.Env();
    if (!isInitialised() || !g_timeline || !g_undoManager) {
        Napi::Error::New(env, "Engine not initialised.").ThrowAsJavaScriptException();
        return;
    }
    if (info.Length() < 2 || !info[0].IsNumber() || !info[1].IsBoolean()) {
        Napi::TypeError::New(env, "timeline_setVideoHoldLastFrame(trackId: number, hold: boolean)")
            .ThrowAsJavaScriptException();
        return;
    }
    int  trackId = info[0].As<Napi::Number>().Int32Value();
    bool hold    = info[1].As<Napi::Boolean>().Value();
    BridgeCallLog log("timeline.setVideoHoldLastFrame");
    g_undoManager->execute(
        std::make_unique<SetTrackVideoHoldLastFrameCommand>(trackId, hold, *g_timeline),
        *g_timeline);
    log.done();
}

// timeline_setTrackCornerRadius(trackId, value)
void Timeline_SetTrackCornerRadius(const Napi::CallbackInfo& info)
{
    Napi::Env env = info.Env();
    if (!isInitialised() || !g_timeline || !g_undoManager) {
        Napi::Error::New(env, "Engine not initialised.").ThrowAsJavaScriptException();
        return;
    }
    if (info.Length() < 2 || !info[0].IsNumber() || !info[1].IsNumber()) {
        Napi::TypeError::New(env, "timeline_setTrackCornerRadius(trackId: number, value: number)")
            .ThrowAsJavaScriptException();
        return;
    }
    int   trackId = info[0].As<Napi::Number>().Int32Value();
    float value   = info[1].As<Napi::Number>().FloatValue();
    BridgeCallLog log("timeline.setTrackCornerRadius");
    g_undoManager->execute(
        std::make_unique<SetTrackCornerRadiusCommand>(trackId, value, *g_timeline),
        *g_timeline);
    g_previewDirty = true;
    log.done();
}

// timeline_setTrackGapScaleOverride(trackId, value)
void Timeline_SetTrackGapScaleOverride(const Napi::CallbackInfo& info)
{
    Napi::Env env = info.Env();
    if (!isInitialised() || !g_timeline || !g_undoManager) {
        Napi::Error::New(env, "Engine not initialised.").ThrowAsJavaScriptException();
        return;
    }
    if (info.Length() < 2 || !info[0].IsNumber() || !info[1].IsNumber()) {
        Napi::TypeError::New(env, "timeline_setTrackGapScaleOverride(trackId: number, value: number)")
            .ThrowAsJavaScriptException();
        return;
    }
    int   trackId = info[0].As<Napi::Number>().Int32Value();
    float value   = info[1].As<Napi::Number>().FloatValue();
    BridgeCallLog log("timeline.setTrackGapScaleOverride");
    g_undoManager->execute(
        std::make_unique<SetTrackGapScaleOverrideCommand>(trackId, value, *g_timeline),
        *g_timeline);
    g_previewDirty = true;
    log.done();
}

// timeline_setTrackSubdivisionFactor(trackId, factor)
//
// Sets the per-track subdivisionFactor (1, 2, 4, or 8). Existing GridSlots
// are NOT resized retroactively — only future placements use the new factor.
// Undo-tracked. Invalid factors are rejected by the Timeline setter.
void Timeline_SetTrackSubdivisionFactor(const Napi::CallbackInfo& info)
{
    Napi::Env env = info.Env();
    if (!isInitialised() || !g_timeline || !g_undoManager) {
        Napi::Error::New(env, "Engine not initialised.").ThrowAsJavaScriptException();
        return;
    }
    if (info.Length() < 2 || !info[0].IsNumber() || !info[1].IsNumber()) {
        Napi::TypeError::New(env,
            "timeline_setTrackSubdivisionFactor(trackId: number, factor: 1|2|4|8)")
            .ThrowAsJavaScriptException();
        return;
    }
    int trackId = info[0].As<Napi::Number>().Int32Value();
    int factor  = info[1].As<Napi::Number>().Int32Value();
    if (factor != 1 && factor != 2 && factor != 4 && factor != 8) {
        Napi::RangeError::New(env, "subdivisionFactor must be 1, 2, 4, or 8")
            .ThrowAsJavaScriptException();
        return;
    }
    BridgeCallLog log("timeline.setTrackSubdivisionFactor");
    g_undoManager->execute(
        std::make_unique<SetTrackSubdivisionFactorCommand>(trackId, factor, *g_timeline),
        *g_timeline);
    g_previewDirty = true;
    log.done();
}

static BounceSettings jsToBounceSettings(Napi::Object o) {
    BounceSettings b;
    if (o.Has("enabled")      && o.Get("enabled").IsBoolean())
        b.enabled       = o.Get("enabled").As<Napi::Boolean>().Value();
    if (o.Has("directionDeg") && o.Get("directionDeg").IsNumber())
        b.directionDeg  = o.Get("directionDeg").As<Napi::Number>().FloatValue();
    if (o.Has("distance")     && o.Get("distance").IsNumber())
        b.distance      = o.Get("distance").As<Napi::Number>().FloatValue();
    if (o.Has("durationMs")   && o.Get("durationMs").IsNumber())
        b.durationMs    = o.Get("durationMs").As<Napi::Number>().FloatValue();
    if (o.Has("squashAmount") && o.Get("squashAmount").IsNumber())
        b.squashAmount  = o.Get("squashAmount").As<Napi::Number>().FloatValue();
    if (o.Has("overshoot")    && o.Get("overshoot").IsNumber())
        b.overshoot     = o.Get("overshoot").As<Napi::Number>().FloatValue();
    if (o.Has("repeatCount")  && o.Get("repeatCount").IsNumber())
        b.repeatCount   = o.Get("repeatCount").As<Napi::Number>().Int32Value();
    if (o.Has("easingType")   && o.Get("easingType").IsNumber())
        b.easingType    = o.Get("easingType").As<Napi::Number>().Int32Value();
    return b;
}

// timeline_setTrackBounceSettings(trackId, bounceObj)
void Timeline_SetTrackBounceSettings(const Napi::CallbackInfo& info)
{
    Napi::Env env = info.Env();
    if (!isInitialised() || !g_timeline || !g_undoManager) {
        Napi::Error::New(env, "Engine not initialised.").ThrowAsJavaScriptException();
        return;
    }
    if (info.Length() < 2 || !info[0].IsNumber() || !info[1].IsObject()) {
        Napi::TypeError::New(env, "timeline_setTrackBounceSettings(trackId: number, bounce: object)")
            .ThrowAsJavaScriptException();
        return;
    }
    int   trackId = info[0].As<Napi::Number>().Int32Value();
    BounceSettings settings = jsToBounceSettings(info[1].As<Napi::Object>());
    BridgeCallLog log("timeline.setTrackBounceSettings");
    g_undoManager->execute(
        std::make_unique<SetTrackBounceSettingsCommand>(trackId, settings, *g_timeline),
        *g_timeline);
    g_previewDirty = true;
    log.done();
}

static ZoomPanRotSettings jsToZoomPanRotSettings(Napi::Object o) {
    ZoomPanRotSettings z;
    auto getF = [&](const char* k, float& v) {
        if (o.Has(k) && o.Get(k).IsNumber()) v = o.Get(k).As<Napi::Number>().FloatValue();
    };
    auto getB = [&](const char* k, bool& v) {
        if (o.Has(k) && o.Get(k).IsBoolean()) v = o.Get(k).As<Napi::Boolean>().Value();
    };
    auto getI = [&](const char* k, int& v) {
        if (o.Has(k) && o.Get(k).IsNumber()) v = o.Get(k).As<Napi::Number>().Int32Value();
    };
    getB("enabled",        z.enabled);
    getF("startZoom",      z.startZoom);
    getF("targetZoom",     z.targetZoom);
    getF("startPanX",      z.startPanX);
    getF("startPanY",      z.startPanY);
    getF("targetPanX",     z.targetPanX);
    getF("targetPanY",     z.targetPanY);
    getF("startRotation",  z.startRotation);
    getF("targetRotation", z.targetRotation);
    getF("durationMs",     z.durationMs);
    getI("zoomEasing",     z.zoomEasing);
    getI("panEasing",      z.panEasing);
    getI("rotEasing",      z.rotEasing);
    getF("overshoot",      z.overshoot);
    return z;
}

// timeline_setTrackZoomPanRotSettings(trackId, zprObj)
void Timeline_SetTrackZoomPanRotSettings(const Napi::CallbackInfo& info)
{
    Napi::Env env = info.Env();
    if (!isInitialised() || !g_timeline || !g_undoManager) {
        Napi::Error::New(env, "Engine not initialised.").ThrowAsJavaScriptException();
        return;
    }
    if (info.Length() < 2 || !info[0].IsNumber() || !info[1].IsObject()) {
        Napi::TypeError::New(env, "timeline_setTrackZoomPanRotSettings(trackId: number, zpr: object)")
            .ThrowAsJavaScriptException();
        return;
    }
    int trackId = info[0].As<Napi::Number>().Int32Value();
    ZoomPanRotSettings settings = jsToZoomPanRotSettings(info[1].As<Napi::Object>());
    BridgeCallLog log("timeline.setTrackZoomPanRotSettings");
    g_undoManager->execute(
        std::make_unique<SetTrackZoomPanRotSettingsCommand>(trackId, settings, *g_timeline),
        *g_timeline);
    g_previewDirty = true;
    log.done();
}

static PingPongSettings jsToPingPongSettings(Napi::Object o) {
    PingPongSettings p;
    auto getF = [&](const char* k, float& v) {
        if (o.Has(k) && o.Get(k).IsNumber()) v = o.Get(k).As<Napi::Number>().FloatValue();
    };
    auto getB = [&](const char* k, bool& v) {
        if (o.Has(k) && o.Get(k).IsBoolean()) v = o.Get(k).As<Napi::Boolean>().Value();
    };
    auto getI = [&](const char* k, int& v) {
        if (o.Has(k) && o.Get(k).IsNumber()) v = o.Get(k).As<Napi::Number>().Int32Value();
    };
    getB("enabled",         p.enabled);
    getF("regionStartPct",  p.regionStartPct);
    getF("regionEndPct",    p.regionEndPct);
    getI("crossfadeFrames", p.crossfadeFrames);
    getF("reverseSpeed",    p.reverseSpeed);
    getI("maxLoops",        p.maxLoops);
    return p;
}

// timeline_setTrackPingPongSettings(trackId, ppObj)
void Timeline_SetTrackPingPongSettings(const Napi::CallbackInfo& info)
{
    Napi::Env env = info.Env();
    if (!isInitialised() || !g_timeline || !g_undoManager) {
        Napi::Error::New(env, "Engine not initialised.").ThrowAsJavaScriptException();
        return;
    }
    if (info.Length() < 2 || !info[0].IsNumber() || !info[1].IsObject()) {
        Napi::TypeError::New(env, "timeline_setTrackPingPongSettings(trackId: number, pp: object)")
            .ThrowAsJavaScriptException();
        return;
    }
    int trackId = info[0].As<Napi::Number>().Int32Value();
    PingPongSettings settings = jsToPingPongSettings(info[1].As<Napi::Object>());
    BridgeCallLog log("timeline.setTrackPingPongSettings");
    g_undoManager->execute(
        std::make_unique<SetTrackPingPongSettingsCommand>(trackId, settings, *g_timeline),
        *g_timeline);
    g_previewDirty = true;
    log.done();
}

static SlideNoteEffectSettings jsToSlideNoteEffectSettings(Napi::Object o) {
    SlideNoteEffectSettings s;
    if (o.Has("type") && o.Get("type").IsNumber()) {
        int t = o.Get("type").As<Napi::Number>().Int32Value();
        if (t < 0) t = 0;
        if (t > 3) t = 3;
        s.type = static_cast<SlideNoteEffectSettings::EffectType>(t);
    }
    if (o.Has("durationMode") && o.Get("durationMode").IsNumber()) {
        int d = o.Get("durationMode").As<Napi::Number>().Int32Value();
        if (d < 0) d = 0;
        if (d > 1) d = 1;
        s.durationMode = static_cast<SlideNoteEffectSettings::DurationMode>(d);
    }
    if (o.Has("fixedDurationMs") && o.Get("fixedDurationMs").IsNumber())
        s.fixedDurationMs = o.Get("fixedDurationMs").As<Napi::Number>().FloatValue();
    return s;
}

// timeline_setTrackSlideNoteEffect(trackId, sObj)
void Timeline_SetTrackSlideNoteEffect(const Napi::CallbackInfo& info)
{
    Napi::Env env = info.Env();
    if (!isInitialised() || !g_timeline || !g_undoManager) {
        Napi::Error::New(env, "Engine not initialised.").ThrowAsJavaScriptException();
        return;
    }
    if (info.Length() < 2 || !info[0].IsNumber() || !info[1].IsObject()) {
        Napi::TypeError::New(env, "timeline_setTrackSlideNoteEffect(trackId: number, s: object)")
            .ThrowAsJavaScriptException();
        return;
    }
    int trackId = info[0].As<Napi::Number>().Int32Value();
    SlideNoteEffectSettings settings = jsToSlideNoteEffectSettings(info[1].As<Napi::Object>());
    BridgeCallLog log("timeline.setTrackSlideNoteEffect");
    g_undoManager->execute(
        std::make_unique<SetTrackSlideNoteEffectCommand>(trackId, settings, *g_timeline),
        *g_timeline);
    g_previewDirty = true;
    log.done();
}

// timeline_setNoteSlide(patternId, noteId, isSlide, curveCx?, curveCy?)
void Timeline_SetNoteSlide(const Napi::CallbackInfo& info)
{
    Napi::Env env = info.Env();
    if (!isInitialised() || !g_timeline || !g_undoManager) {
        Napi::Error::New(env, "Engine not initialised.").ThrowAsJavaScriptException();
        return;
    }
    if (info.Length() < 3 || !info[0].IsNumber() || !info[1].IsNumber() || !info[2].IsBoolean()) {
        Napi::TypeError::New(env, "timeline_setNoteSlide(patternId, noteId, isSlide, cx?, cy?)")
            .ThrowAsJavaScriptException();
        return;
    }
    int   patternId = info[0].As<Napi::Number>().Int32Value();
    int   noteId    = info[1].As<Napi::Number>().Int32Value();
    bool  isSlide   = info[2].As<Napi::Boolean>().Value();
    float cx = 0.5f, cy = 0.5f;
    if (info.Length() >= 4 && info[3].IsNumber()) cx = info[3].As<Napi::Number>().FloatValue();
    if (info.Length() >= 5 && info[4].IsNumber()) cy = info[4].As<Napi::Number>().FloatValue();

    BridgeCallLog log("timeline.setNoteSlide");
    g_undoManager->execute(
        std::make_unique<SetNoteSlideCommand>(patternId, noteId, isSlide, cx, cy, *g_timeline),
        *g_timeline);
    g_previewDirty = true;
    log.done();
}

// ── Preview Performance Controls ─────────────────────────────────────────────
// These settings are workstation-local (not per-project). The engine applies
// them immediately; the UI persists them to xleth-settings.json separately.

Napi::Value Timeline_GetPreviewResolutionScale(const Napi::CallbackInfo& info)
{
    return Napi::Number::New(info.Env(), g_previewResolutionScale);
}

void Timeline_SetPreviewResolutionScale(const Napi::CallbackInfo& info)
{
    if (info.Length() < 1 || !info[0].IsNumber()) return;
    float scale = info[0].As<Napi::Number>().FloatValue();
    // Snap to supported levels
    if (scale <= 0.30f)       scale = 0.25f;
    else if (scale <= 0.625f) scale = 0.50f;
    else if (scale <= 0.875f) scale = 0.75f;
    else                      scale = 1.00f;

    if (g_previewResolutionScale == scale) {
        g_previewDirty = true;
        return;
    }
    g_previewResolutionScale = scale;

    // Re-initialise compositor at new scaled resolution
    if (g_previewCompositor && g_gpuDevice && g_gpuDevice->hasDevice()) {
        const int sw = std::max(1, static_cast<int>(CANVAS_W * scale));
        const int sh = std::max(1, static_cast<int>(CANVAS_H * scale));
        auto* device = g_gpuDevice->getDevice();
        auto* devCtx = g_gpuDevice->getContext();
        std::lock_guard<std::mutex> lk(g_previewCompositorMutex);
        g_previewCompositorReady = false;
        g_previewCompositor->shutdown();
        if (g_previewCompositor->init(device, devCtx, sw, sh)) {
            if (g_previewEffectsBypass)
                g_previewCompositor->setEffectsBypass(true);
            g_previewCompositorReady = true;
            std::fprintf(stderr, "[Preview] Resolution scale %.2f → compositor %dx%d\n",
                         scale, sw, sh);
        } else {
            std::fprintf(stderr, "[Preview] ERROR: compositor re-init at %dx%d failed\n", sw, sh);
        }
    }
    g_previewDirty = true;
}

Napi::Value Timeline_GetPreviewEffectsBypass(const Napi::CallbackInfo& info)
{
    return Napi::Boolean::New(info.Env(), g_previewEffectsBypass);
}

void Timeline_SetPreviewEffectsBypass(const Napi::CallbackInfo& info)
{
    if (info.Length() < 1 || !info[0].IsBoolean()) return;
    g_previewEffectsBypass = info[0].As<Napi::Boolean>().Value();
    if (g_previewCompositor)
        g_previewCompositor->setEffectsBypass(g_previewEffectsBypass);
    g_previewDirty = true;
    std::fprintf(stderr, "[Preview] Effects bypass: %s\n",
                 g_previewEffectsBypass ? "ON" : "OFF");
}

// ── Visual Effect Chain ───────────────────────────────────────────────────────

// Helper: serialise chain → Napi::Array (shared by trackToJs and Timeline_GetVisualEffectChain)
static Napi::Array visualChainToJs(Napi::Env env, const std::vector<VisualEffect>& chain)
{
    Napi::Array arr = Napi::Array::New(env, chain.size());
    for (size_t i = 0; i < chain.size(); ++i) {
        const VisualEffect& fx = chain[i];
        Napi::Object fxObj = Napi::Object::New(env);
        fxObj.Set("type",     Napi::Number::New(env, static_cast<int>(fx.type)));
        fxObj.Set("bypassed", Napi::Boolean::New(env, fx.bypassed));
        Napi::Array paramsArr = Napi::Array::New(env, 16);
        for (int pi = 0; pi < 16; ++pi)
            paramsArr.Set(static_cast<uint32_t>(pi), Napi::Number::New(env, fx.params[pi]));
        fxObj.Set("params", paramsArr);
        arr.Set(static_cast<uint32_t>(i), fxObj);
    }
    return arr;
}

// timeline_addVisualEffect(trackId, effectType) → number (new effect index)
Napi::Value Timeline_AddVisualEffect(const Napi::CallbackInfo& info)
{
    Napi::Env env = info.Env();
    if (!isInitialised() || !g_timeline || !g_undoManager) {
        Napi::Error::New(env, "Engine not initialised.").ThrowAsJavaScriptException();
        return env.Undefined();
    }
    if (info.Length() < 2 || !info[0].IsNumber() || !info[1].IsNumber()) {
        Napi::TypeError::New(env, "timeline_addVisualEffect(trackId: number, effectType: number)")
            .ThrowAsJavaScriptException();
        return env.Undefined();
    }
    int trackId    = info[0].As<Napi::Number>().Int32Value();
    int effectType = info[1].As<Napi::Number>().Int32Value();
    if (effectType < 0 || effectType > 4) {
        Napi::RangeError::New(env, "effectType must be 0-4").ThrowAsJavaScriptException();
        return env.Undefined();
    }
    BridgeCallLog log("timeline.addVisualEffect");
    auto* cmd = new AddVisualEffectCommand(trackId,
        static_cast<VisualEffect::Type>(effectType));
    g_undoManager->execute(std::unique_ptr<Command>(cmd), *g_timeline);
    g_previewDirty = true;
    int idx = cmd->getAddedIndex();
    log.done(std::to_string(idx));
    return Napi::Number::New(env, idx);
}

// timeline_removeVisualEffect(trackId, effectIndex)
void Timeline_RemoveVisualEffect(const Napi::CallbackInfo& info)
{
    Napi::Env env = info.Env();
    if (!isInitialised() || !g_timeline || !g_undoManager) {
        Napi::Error::New(env, "Engine not initialised.").ThrowAsJavaScriptException();
        return;
    }
    if (info.Length() < 2 || !info[0].IsNumber() || !info[1].IsNumber()) {
        Napi::TypeError::New(env, "timeline_removeVisualEffect(trackId: number, effectIndex: number)")
            .ThrowAsJavaScriptException();
        return;
    }
    int trackId     = info[0].As<Napi::Number>().Int32Value();
    int effectIndex = info[1].As<Napi::Number>().Int32Value();
    BridgeCallLog log("timeline.removeVisualEffect");
    g_undoManager->execute(
        std::make_unique<RemoveVisualEffectCommand>(trackId, effectIndex, *g_timeline),
        *g_timeline);
    g_previewDirty = true;
    log.done();
}

// timeline_reorderVisualEffect(trackId, fromIndex, toIndex)
void Timeline_ReorderVisualEffect(const Napi::CallbackInfo& info)
{
    Napi::Env env = info.Env();
    if (!isInitialised() || !g_timeline || !g_undoManager) {
        Napi::Error::New(env, "Engine not initialised.").ThrowAsJavaScriptException();
        return;
    }
    if (info.Length() < 3 || !info[0].IsNumber() || !info[1].IsNumber() || !info[2].IsNumber()) {
        Napi::TypeError::New(env, "timeline_reorderVisualEffect(trackId, fromIndex, toIndex)")
            .ThrowAsJavaScriptException();
        return;
    }
    int trackId   = info[0].As<Napi::Number>().Int32Value();
    int fromIndex = info[1].As<Napi::Number>().Int32Value();
    int toIndex   = info[2].As<Napi::Number>().Int32Value();
    BridgeCallLog log("timeline.reorderVisualEffect");
    g_undoManager->execute(
        std::make_unique<ReorderVisualEffectCommand>(trackId, fromIndex, toIndex),
        *g_timeline);
    g_previewDirty = true;
    log.done();
}

// timeline_setTrackVisualEffectChainOrder(trackId, newOrder[])
void Timeline_SetTrackVisualEffectChainOrder(const Napi::CallbackInfo& info)
{
    Napi::Env env = info.Env();
    if (!isInitialised() || !g_timeline || !g_undoManager) {
        Napi::Error::New(env, "Engine not initialised.").ThrowAsJavaScriptException();
        return;
    }
    if (info.Length() < 2 || !info[0].IsNumber() || !info[1].IsArray()) {
        Napi::TypeError::New(env, "timeline_setTrackVisualEffectChainOrder(trackId, newOrder[])")
            .ThrowAsJavaScriptException();
        return;
    }
    int trackId = info[0].As<Napi::Number>().Int32Value();
    Napi::Array arr = info[1].As<Napi::Array>();
    std::vector<int> newOrder;
    newOrder.reserve(arr.Length());
    for (uint32_t i = 0; i < arr.Length(); ++i) {
        Napi::Value val = arr[i];
        if (!val.IsNumber()) {
            Napi::TypeError::New(env, "newOrder must be an array of numbers")
                .ThrowAsJavaScriptException();
            return;
        }
        newOrder.push_back(val.As<Napi::Number>().Int32Value());
    }
    BridgeCallLog log("timeline.setTrackVisualEffectChainOrder");
    g_undoManager->execute(
        std::make_unique<SetTrackVfxChainOrderCommand>(trackId, newOrder, *g_timeline),
        *g_timeline);
    g_previewDirty = true;
    log.done();
}

// timeline_setVisualEffectParam(trackId, effectIndex, paramIndex, value)
void Timeline_SetVisualEffectParam(const Napi::CallbackInfo& info)
{
    Napi::Env env = info.Env();
    if (!isInitialised() || !g_timeline || !g_undoManager) {
        Napi::Error::New(env, "Engine not initialised.").ThrowAsJavaScriptException();
        return;
    }
    if (info.Length() < 4 || !info[0].IsNumber() || !info[1].IsNumber()
                          || !info[2].IsNumber() || !info[3].IsNumber()) {
        Napi::TypeError::New(env,
            "timeline_setVisualEffectParam(trackId, effectIndex, paramIndex, value)")
            .ThrowAsJavaScriptException();
        return;
    }
    int   trackId     = info[0].As<Napi::Number>().Int32Value();
    int   effectIndex = info[1].As<Napi::Number>().Int32Value();
    int   paramIndex  = info[2].As<Napi::Number>().Int32Value();
    float value       = info[3].As<Napi::Number>().FloatValue();
    BridgeCallLog log("timeline.setVisualEffectParam");
    g_undoManager->execute(
        std::make_unique<SetVisualEffectParamCommand>(trackId, effectIndex,
                                                     paramIndex, value, *g_timeline),
        *g_timeline);
    g_previewDirty = true;
    log.done();
}

// timeline_setVisualEffectBypassed(trackId, effectIndex, bypassed)
void Timeline_SetVisualEffectBypassed(const Napi::CallbackInfo& info)
{
    Napi::Env env = info.Env();
    if (!isInitialised() || !g_timeline || !g_undoManager) {
        Napi::Error::New(env, "Engine not initialised.").ThrowAsJavaScriptException();
        return;
    }
    if (info.Length() < 3 || !info[0].IsNumber() || !info[1].IsNumber() || !info[2].IsBoolean()) {
        Napi::TypeError::New(env,
            "timeline_setVisualEffectBypassed(trackId, effectIndex, bypassed)")
            .ThrowAsJavaScriptException();
        return;
    }
    int  trackId     = info[0].As<Napi::Number>().Int32Value();
    int  effectIndex = info[1].As<Napi::Number>().Int32Value();
    bool bypassed    = info[2].As<Napi::Boolean>().Value();
    BridgeCallLog log("timeline.setVisualEffectBypassed");
    g_undoManager->execute(
        std::make_unique<SetVisualEffectBypassedCommand>(trackId, effectIndex,
                                                        bypassed, *g_timeline),
        *g_timeline);
    g_previewDirty = true;
    log.done();
}

// timeline_getVisualEffectChain(trackId) → array of {type, bypassed, params[]}
Napi::Value Timeline_GetVisualEffectChain(const Napi::CallbackInfo& info)
{
    Napi::Env env = info.Env();
    if (!isInitialised() || !g_timeline) {
        Napi::Error::New(env, "Engine not initialised.").ThrowAsJavaScriptException();
        return env.Undefined();
    }
    if (info.Length() < 1 || !info[0].IsNumber()) {
        Napi::TypeError::New(env, "timeline_getVisualEffectChain(trackId: number)")
            .ThrowAsJavaScriptException();
        return env.Undefined();
    }
    int trackId = info[0].As<Napi::Number>().Int32Value();
    const auto* chain = g_timeline->getVisualEffectChain(trackId);
    if (!chain) return Napi::Array::New(env, 0);
    return visualChainToJs(env, *chain);
}

// timeline_autoTrimClip(clipId, thresholdDb) →
//   { success, trimmed, newOffset?, newDuration?, reason? }
// Detects leading silence in the sample backing this clip's region and shifts
// the clip's regionOffset forward + shrinks its duration by the silence amount.
// The clip's timeline position is NOT touched — audible content now begins at
// the clip's left edge.
Napi::Value Timeline_AutoTrimClip(const Napi::CallbackInfo& info)
{
    Napi::Env env = info.Env();
    if (!isInitialised() || !g_timeline || !g_undoManager || !sampleBank || !audioEngine) {
        Napi::Error::New(env, "Engine not initialised.").ThrowAsJavaScriptException();
        return env.Undefined();
    }
    if (info.Length() < 2 || !info[0].IsNumber() || !info[1].IsNumber()) {
        Napi::TypeError::New(env, "timeline_autoTrimClip(clipId: number, thresholdDb: number)")
            .ThrowAsJavaScriptException();
        return env.Undefined();
    }

    int   clipId      = info[0].As<Napi::Number>().Int32Value();
    float thresholdDb = static_cast<float>(info[1].As<Napi::Number>().DoubleValue());
    BridgeCallLog log("timeline.autoTrimClip");

    auto makeFailure = [&](const char* reason) {
        Napi::Object o = Napi::Object::New(env);
        o.Set("success", Napi::Boolean::New(env, false));
        o.Set("reason",  Napi::String::New(env, reason));
        log.done(reason);
        return o;
    };

    const Clip* clip = g_timeline->getClip(clipId);
    if (!clip)                     return makeFailure("clip not found");
    const int sampleId = audioEngine->getMixEngine().getSampleIdForRegion(clip->regionId);
    if (sampleId < 0)              return makeFailure("sample not loaded");

    int64_t silenceSamples = sampleBank->getLeadingSilenceSamples(sampleId, thresholdDb);
    if (silenceSamples < 0)        return makeFailure("invalid sample");

    // Convert samples → ticks using current BPM and engine sample rate.
    const double bpm        = audioEngine->getTransport().getBPM();
    const double sampleRate = audioEngine->getSampleRate();
    int64_t silenceTicks = 0;
    if (silenceSamples > 0 && sampleRate > 0.0 && bpm > 0.0) {
        const double beats = (silenceSamples / sampleRate) * (bpm / 60.0);
        silenceTicks = static_cast<int64_t>(beats * 960.0);
    }

    if (silenceTicks <= 0) {
        Napi::Object o = Napi::Object::New(env);
        o.Set("success", Napi::Boolean::New(env, true));
        o.Set("trimmed", Napi::Number::New(env, 0));
        log.done("trimmed=0");
        return o;
    }

    // Clamp so at least a minimal audible tail remains (1/32 note ≈ 120 ticks).
    constexpr int64_t kMinClipTicks = 120;
    if (silenceTicks >= clip->duration.ticks - kMinClipTicks) {
        silenceTicks = std::max<int64_t>(0, clip->duration.ticks - kMinClipTicks);
    }

    std::cout << "[AutoTrim] clipId=" << clipId
              << " silence=" << silenceSamples << " samples ("
              << silenceTicks << " ticks)\n" << std::flush;

    g_undoManager->execute(
        std::make_unique<AutoTrimClipCommand>(clipId, silenceTicks, silenceTicks),
        *g_timeline);

    // Re-read clip state for return payload.
    const Clip* updated = g_timeline->getClip(clipId);
    Napi::Object o = Napi::Object::New(env);
    o.Set("success",     Napi::Boolean::New(env, true));
    o.Set("trimmed",     Napi::Number::New(env, static_cast<double>(silenceTicks)));
    if (updated) {
        o.Set("newOffset",   Napi::Number::New(env, static_cast<double>(updated->regionOffset.ticks)));
        o.Set("newDuration", Napi::Number::New(env, static_cast<double>(updated->duration.ticks)));
    }
    log.done("trimmed=" + std::to_string(silenceTicks));
    return o;
}

// timeline_addRegion({ sourceId?, name, label?, startTime?, endTime?, audioFilePath? }) → id
Napi::Value Timeline_AddRegion(const Napi::CallbackInfo& info)
{
    Napi::Env env = info.Env();
    if (!isInitialised() || !g_timeline || !g_undoManager) {
        Napi::Error::New(env, "Engine not initialised.").ThrowAsJavaScriptException();
        return env.Undefined();
    }
    if (info.Length() < 1 || !info[0].IsObject()) {
        Napi::TypeError::New(env, "timeline_addRegion({ name, label?, sourceId?, startTime?, endTime?, audioFilePath? })")
            .ThrowAsJavaScriptException();
        return env.Undefined();
    }
    BridgeCallLog log("timeline.addRegion");

    SampleRegion region = jsToRegion(info[0].As<Napi::Object>());
    g_undoManager->execute(std::make_unique<AddRegionCommand>(region), *g_timeline);

    auto regions = g_timeline->getAllRegions();
    int newId = regions.empty() ? -1 : regions.back()->id;
    log.done(std::to_string(newId));
    return Napi::Number::New(env, newId);
}

// timeline_modifyRegion(id, { name?, label?, startTime?, endTime?, ... })
void Timeline_ModifyRegion(const Napi::CallbackInfo& info)
{
    Napi::Env env = info.Env();
    if (!isInitialised() || !g_timeline || !g_undoManager) {
        Napi::Error::New(env, "Engine not initialised.").ThrowAsJavaScriptException();
        return;
    }
    if (info.Length() < 2 || !info[0].IsNumber() || !info[1].IsObject()) {
        Napi::TypeError::New(env, "timeline_modifyRegion(id: number, region: object)")
            .ThrowAsJavaScriptException();
        return;
    }
    int id = info[0].As<Napi::Number>().Int32Value();
    BridgeCallLog log("timeline.modifyRegion");

    // Snapshot the region's trim range before executing so we can detect
    // whether a proxy-invalidating change occurred (startTime/endTime).
    double oldStartTime = 0.0, oldEndTime = 0.0;
    bool hadRegion = false;
    if (const SampleRegion* prev = g_timeline->getRegion(id)) {
        oldStartTime = prev->startTime;
        oldEndTime   = prev->endTime;
        hadRegion    = true;
    }

    SampleRegion newState = jsToRegion(info[1].As<Napi::Object>());
    g_undoManager->execute(
        std::make_unique<ModifyRegionCommand>(id, newState, *g_timeline),
        *g_timeline);

    // If the quote's trim window changed, any existing proxy no longer maps
    // to the right source range — invalidate it and, if the region is still
    // referenced by a clip on a non-Chorus/non-Crash cell, schedule a fresh
    // transcode with the new bounds.
    if (hadRegion) {
        const SampleRegion* now = g_timeline->getRegion(id);
        if (now && (now->startTime != oldStartTime || now->endTime != oldEndTime)) {
            invalidateRegionProxy(id);
            // NOTE: invalidateRegionProxy releases syncEventsMutex before
            // returning — safe to call maybeEnqueueRegionProxy after.
            // maybeEnqueueRegionProxy does NOT take syncEventsMutex today
            // (reads region data lock-free, delegates to ProxyManager which
            // has its own internal mutex). If that ever changes, this
            // ordering will deadlock — keep the two calls sequential and
            // unlocked, or refactor into one helper that takes the lock
            // exactly once.
            const GridLayout& gl = g_timeline->getGridLayout();
            for (const Clip* c : g_timeline->getAllClips()) {
                if (!c || c->regionId != id) continue;
                if (c->trackId == gl.chorusTrackId) continue;
                if (gl.crashEnabled && c->trackId == gl.crashTrackId) continue;
                maybeEnqueueRegionProxy(id, c->trackId);
                break;  // dedup in ProxyManager; one trigger is enough
            }
        }
    }

    log.done();
}

// timeline_setSyllables(id, syllables[]) — undoable
void Timeline_SetSyllables(const Napi::CallbackInfo& info)
{
    Napi::Env env = info.Env();
    if (!isInitialised() || !g_timeline || !g_undoManager) {
        Napi::Error::New(env, "Engine not initialised.").ThrowAsJavaScriptException();
        return;
    }
    if (info.Length() < 2 || !info[0].IsNumber() || !info[1].IsArray()) {
        Napi::TypeError::New(env, "timeline_setSyllables(id: number, syllables: array)")
            .ThrowAsJavaScriptException();
        return;
    }
    int id = info[0].As<Napi::Number>().Int32Value();
    BridgeCallLog log("timeline.setSyllables");

    Napi::Array arr = info[1].As<Napi::Array>();
    std::vector<SampleRegion::Syllable> syllables;
    syllables.reserve(arr.Length());
    for (uint32_t i = 0; i < arr.Length(); ++i) {
        if (arr.Get(i).IsObject())
            syllables.push_back(jsToSyllable(arr.Get(i).As<Napi::Object>()));
    }

    g_undoManager->execute(
        std::make_unique<SetSyllablesCommand>(id, std::move(syllables), *g_timeline),
        *g_timeline);
    log.done(std::to_string(arr.Length()));
}

// timeline_getSyllables(id) → syllables[]
Napi::Value Timeline_GetSyllables(const Napi::CallbackInfo& info)
{
    Napi::Env env = info.Env();
    if (!isInitialised() || !g_timeline) {
        Napi::Error::New(env, "Engine not initialised.").ThrowAsJavaScriptException();
        return env.Undefined();
    }
    if (info.Length() < 1 || !info[0].IsNumber()) {
        Napi::TypeError::New(env, "timeline_getSyllables(id: number)")
            .ThrowAsJavaScriptException();
        return env.Undefined();
    }
    int id = info[0].As<Napi::Number>().Int32Value();

    const SampleRegion* r = g_timeline->getRegion(id);
    if (!r) return Napi::Array::New(env, 0);

    Napi::Array arr = Napi::Array::New(env, r->syllables.size());
    for (size_t i = 0; i < r->syllables.size(); ++i)
        arr.Set((uint32_t)i, syllableToJs(env, r->syllables[i]));
    return arr;
}

// timeline_removeRegion(id)
void Timeline_RemoveRegion(const Napi::CallbackInfo& info)
{
    Napi::Env env = info.Env();
    if (!isInitialised() || !g_timeline || !g_undoManager) {
        Napi::Error::New(env, "Engine not initialised.").ThrowAsJavaScriptException();
        return;
    }
    if (info.Length() < 1 || !info[0].IsNumber()) {
        Napi::TypeError::New(env, "timeline_removeRegion(id: number)").ThrowAsJavaScriptException();
        return;
    }
    int id = info[0].As<Napi::Number>().Int32Value();
    BridgeCallLog log("timeline.removeRegion");
    g_undoManager->execute(std::make_unique<RemoveRegionCommand>(id, *g_timeline), *g_timeline);
    log.done();
}

// ─────────────────────────────────────────────────────────────────────────────
// Phase 1 — Undo / Redo
// ─────────────────────────────────────────────────────────────────────────────

Napi::Value Undo_Undo(const Napi::CallbackInfo& info)
{
    Napi::Env env = info.Env();
    if (!g_undoManager || !g_timeline) {
        Napi::Error::New(env, "Engine not initialised.").ThrowAsJavaScriptException();
        return env.Undefined();
    }
    BridgeCallLog log("undo.undo");
    bool ok;
    {
        // Undo may touch GridLayout (grid-slot/chorus/crash/preview-fps commands) —
        // hold syncEventsMutex so the video thread sees consistent state.
        std::lock_guard<std::mutex> lock(syncEventsMutex);
        ok = g_undoManager->undo(*g_timeline);
    }
    // Sync transport BPM in case a SetBPMCommand was undone
    if (ok && audioEngine)
        audioEngine->getTransport().setBPM(g_timeline->getBPM());
    // Patterns may have been restored/mutated — rebuild samplers to stay in sync.
    if (ok) rebuildAllSamplers();
    if (ok) refreshAllClipCaches();
    log.done(ok ? "true" : "false (nothing to undo)");
    return Napi::Boolean::New(env, ok);
}

Napi::Value Undo_Redo(const Napi::CallbackInfo& info)
{
    Napi::Env env = info.Env();
    if (!g_undoManager || !g_timeline) {
        Napi::Error::New(env, "Engine not initialised.").ThrowAsJavaScriptException();
        return env.Undefined();
    }
    BridgeCallLog log("undo.redo");
    bool ok;
    {
        std::lock_guard<std::mutex> lock(syncEventsMutex);
        ok = g_undoManager->redo(*g_timeline);
    }
    if (ok && audioEngine)
        audioEngine->getTransport().setBPM(g_timeline->getBPM());
    if (ok) rebuildAllSamplers();
    if (ok) refreshAllClipCaches();
    log.done(ok ? "true" : "false (nothing to redo)");
    return Napi::Boolean::New(env, ok);
}

Napi::Value Undo_CanUndo(const Napi::CallbackInfo& info)
{
    Napi::Env env = info.Env();
    if (!g_undoManager) return Napi::Boolean::New(env, false);
    return Napi::Boolean::New(env, g_undoManager->canUndo());
}

Napi::Value Undo_CanRedo(const Napi::CallbackInfo& info)
{
    Napi::Env env = info.Env();
    if (!g_undoManager) return Napi::Boolean::New(env, false);
    return Napi::Boolean::New(env, g_undoManager->canRedo());
}

Napi::Value Undo_GetUndoDescription(const Napi::CallbackInfo& info)
{
    Napi::Env env = info.Env();
    if (!g_undoManager) return Napi::String::New(env, "");
    return Napi::String::New(env, g_undoManager->getUndoDescription());
}

Napi::Value Undo_GetRedoDescription(const Napi::CallbackInfo& info)
{
    Napi::Env env = info.Env();
    if (!g_undoManager) return Napi::String::New(env, "");
    return Napi::String::New(env, g_undoManager->getRedoDescription());
}

// ─────────────────────────────────────────────────────────────────────────────
// Phase 1 — Audio (MixEngine)
// ─────────────────────────────────────────────────────────────────────────────

// audio_mapRegionToSample(regionId, sampleBankId) — links a Timeline region to
// a SampleBank slot so MixEngine can play timeline clips.
void Audio_MapRegionToSample(const Napi::CallbackInfo& info)
{
    Napi::Env env = info.Env();
    if (!isInitialised()) {
        Napi::Error::New(env, "Engine not initialised.").ThrowAsJavaScriptException();
        return;
    }
    if (info.Length() < 2 || !info[0].IsNumber() || !info[1].IsNumber()) {
        Napi::TypeError::New(env, "audio_mapRegionToSample(regionId: number, sampleBankId: number)")
            .ThrowAsJavaScriptException();
        return;
    }
    int regionId    = info[0].As<Napi::Number>().Int32Value();
    int sampleBankId = info[1].As<Napi::Number>().Int32Value();
    std::cout << "[Bridge] → audio.mapRegionToSample region=" << regionId
              << " sample=" << sampleBankId << "\n" << std::flush;
    audioEngine->getMixEngine().mapRegionToSample(regionId, sampleBankId);
}

// audio_loadSourceRegion(filePath, startTime, endTime) → sampleId
// Decodes a time range from any media file via FFmpeg and stores in SampleBank.
Napi::Value Audio_LoadSourceRegion(const Napi::CallbackInfo& info)
{
    Napi::Env env = info.Env();
    if (!isInitialised()) {
        Napi::Error::New(env, "Engine not initialised.").ThrowAsJavaScriptException();
        return Napi::Number::New(env, -1);
    }
    if (info.Length() < 3 || !info[0].IsString() || !info[1].IsNumber() || !info[2].IsNumber()) {
        Napi::TypeError::New(env, "audio_loadSourceRegion(filePath: string, startTime: number, endTime: number)")
            .ThrowAsJavaScriptException();
        return Napi::Number::New(env, -1);
    }

    std::string filePath = info[0].As<Napi::String>().Utf8Value();
    double startTime     = info[1].As<Napi::Number>().DoubleValue();
    double endTime       = info[2].As<Napi::Number>().DoubleValue();

    BridgeCallLog log("audio.loadSourceRegion");
    int id = sampleBank->loadSampleFromSource(filePath, startTime, endTime,
                                               audioEngine->getSampleRate());
    triggerMipmapGeneration(id, filePath, /*saveXlpeak=*/false);
    log.done(std::to_string(id));
    return Napi::Number::New(env, id);
}

// audio_getOutputDevices() → string[]
Napi::Value Audio_GetOutputDevices(const Napi::CallbackInfo& info)
{
    Napi::Env env = info.Env();
    if (!audioEngine) return env.Null();
    auto names = audioEngine->getOutputDevices();
    auto arr = Napi::Array::New(env, names.size());
    for (size_t i = 0; i < names.size(); ++i)
        arr.Set((uint32_t)i, Napi::String::New(env, names[i]));
    return arr;
}

// audio_getCurrentOutputDevice() → string
Napi::Value Audio_GetCurrentOutputDevice(const Napi::CallbackInfo& info)
{
    Napi::Env env = info.Env();
    if (!audioEngine) return env.Null();
    return Napi::String::New(env, audioEngine->getCurrentOutputDevice());
}

// audio_setOutputDevice(name) → { ok: bool, error: string }
Napi::Value Audio_SetOutputDevice(const Napi::CallbackInfo& info)
{
    Napi::Env env = info.Env();
    if (info.Length() < 1 || !info[0].IsString()) {
        Napi::TypeError::New(env, "audio_setOutputDevice(name: string)").ThrowAsJavaScriptException();
        return env.Undefined();
    }
    if (!audioEngine) return env.Null();
    auto err = audioEngine->setOutputDevice(info[0].As<Napi::String>().Utf8Value());
    auto obj = Napi::Object::New(env);
    obj.Set("ok",    Napi::Boolean::New(env, err.empty()));
    obj.Set("error", Napi::String::New(env, err));
    return obj;
}

// audio_getMasterPeak() → { peakL, peakR }
Napi::Value Audio_GetMasterPeak(const Napi::CallbackInfo& info)
{
    Napi::Env env = info.Env();
    if (!isInitialised()) {
        Napi::Error::New(env, "Engine not initialised.").ThrowAsJavaScriptException();
        return env.Undefined();
    }
    Napi::Object o = Napi::Object::New(env);
    o.Set("peakL", Napi::Number::New(env, audioEngine->getMixEngine().getMasterPeakL()));
    o.Set("peakR", Napi::Number::New(env, audioEngine->getMixEngine().getMasterPeakR()));
    return o;
}

// audio_getTrackPeak(trackId) → { peakL, peakR }
Napi::Value Audio_GetTrackPeak(const Napi::CallbackInfo& info)
{
    Napi::Env env = info.Env();
    if (!isInitialised()) {
        Napi::Error::New(env, "Engine not initialised.").ThrowAsJavaScriptException();
        return env.Undefined();
    }
    if (info.Length() < 1 || !info[0].IsNumber()) {
        Napi::TypeError::New(env, "audio_getTrackPeak(trackId: number)")
            .ThrowAsJavaScriptException();
        return env.Undefined();
    }
    int trackId = info[0].As<Napi::Number>().Int32Value();
    Napi::Object o = Napi::Object::New(env);
    o.Set("peakL", Napi::Number::New(env, audioEngine->getMixEngine().getTrackPeakL(trackId)));
    o.Set("peakR", Napi::Number::New(env, audioEngine->getMixEngine().getTrackPeakR(trackId)));
    return o;
}

// audio_getAllPeaks() → { master: {peakL, peakR}, tracks: { [trackId]: {peakL, peakR} } }
// Single batched call for mixer UI — avoids N+1 IPC round-trips per poll cycle.
Napi::Value Audio_GetAllPeaks(const Napi::CallbackInfo& info)
{
    IPC_TIME_START;
    Napi::Env env = info.Env();
    if (!isInitialised()) {
        Napi::Error::New(env, "Engine not initialised.").ThrowAsJavaScriptException();
        return env.Undefined();
    }
    auto& mix = audioEngine->getMixEngine();
    Napi::Object result = Napi::Object::New(env);

    // Master peaks
    Napi::Object master = Napi::Object::New(env);
    master.Set("peakL", Napi::Number::New(env, mix.getMasterPeakL()));
    master.Set("peakR", Napi::Number::New(env, mix.getMasterPeakR()));
    result.Set("master", master);

    // Per-track peaks — iterate active tracks from timeline
    auto allTracks = g_timeline->getAllTracks();
    Napi::Object tracks = Napi::Object::New(env);
    for (size_t i = 0; i < allTracks.size(); ++i) {
        const auto& t = *allTracks[i];
        Napi::Object tp = Napi::Object::New(env);
        tp.Set("peakL", Napi::Number::New(env, mix.getTrackPeakL(t.id)));
        tp.Set("peakR", Napi::Number::New(env, mix.getTrackPeakR(t.id)));
        tracks.Set(static_cast<uint32_t>(t.id), tp);
    }
    result.Set("tracks", tracks);
    IPC_TIME_END("audio_getAllPeaks");
    return result;
}

// ── Direct audio parameter setters ───────────────────────────────────────────

// audio_setTrackVolume(trackId, volume) → undefined
// Writes the atomic RT parameter and the model's TrackInfo in one call.
// No undo tracking — use for continuous fader moves and automation.
Napi::Value Audio_SetTrackVolume(const Napi::CallbackInfo& info)
{
    Napi::Env env = info.Env();
    if (!isInitialised()) {
        Napi::Error::New(env, "Engine not initialised.").ThrowAsJavaScriptException();
        return env.Undefined();
    }
    if (info.Length() < 2 || !info[0].IsNumber() || !info[1].IsNumber()) {
        Napi::TypeError::New(env, "audio_setTrackVolume(trackId: number, volume: number)")
            .ThrowAsJavaScriptException();
        return env.Undefined();
    }
    const int   trackId = info[0].As<Napi::Number>().Int32Value();
    const float vol     = info[1].As<Napi::Number>().FloatValue();
    BridgeCallLog log("audio.setTrackVolume");

    audioEngine->getMixEngine().setTrackVolume(trackId, vol);
    if (auto* t = g_timeline->getTrackMutable(trackId))
        t->volume = vol;

    log.done(std::to_string(trackId) + "=" + std::to_string(vol));
    return env.Undefined();
}

// audio_setTrackPan(trackId, pan) → undefined
// pan clamped to [-1, +1] — out-of-range input would corrupt panning math.
Napi::Value Audio_SetTrackPan(const Napi::CallbackInfo& info)
{
    Napi::Env env = info.Env();
    if (!isInitialised()) {
        Napi::Error::New(env, "Engine not initialised.").ThrowAsJavaScriptException();
        return env.Undefined();
    }
    if (info.Length() < 2 || !info[0].IsNumber() || !info[1].IsNumber()) {
        Napi::TypeError::New(env, "audio_setTrackPan(trackId: number, pan: number [-1..+1])")
            .ThrowAsJavaScriptException();
        return env.Undefined();
    }
    const int   trackId = info[0].As<Napi::Number>().Int32Value();
    const float pan     = std::clamp(info[1].As<Napi::Number>().FloatValue(), -1.0f, 1.0f);
    BridgeCallLog log("audio.setTrackPan");

    audioEngine->getMixEngine().setTrackPan(trackId, pan);
    if (auto* t = g_timeline->getTrackMutable(trackId))
        t->pan = pan;

    log.done(std::to_string(trackId) + "=" + std::to_string(pan));
    return env.Undefined();
}

// audio_setTrackSpread(trackId, spread) → undefined
// spread: 0.0 = mono, 1.0 = original, 2.0 = exaggerated stereo.
Napi::Value Audio_SetTrackSpread(const Napi::CallbackInfo& info)
{
    Napi::Env env = info.Env();
    if (!isInitialised()) {
        Napi::Error::New(env, "Engine not initialised.").ThrowAsJavaScriptException();
        return env.Undefined();
    }
    if (info.Length() < 2 || !info[0].IsNumber() || !info[1].IsNumber()) {
        Napi::TypeError::New(env, "audio_setTrackSpread(trackId: number, spread: number [0..2])")
            .ThrowAsJavaScriptException();
        return env.Undefined();
    }
    const int   trackId = info[0].As<Napi::Number>().Int32Value();
    const float spread  = info[1].As<Napi::Number>().FloatValue();
    BridgeCallLog log("audio.setTrackSpread");

    audioEngine->getMixEngine().setTrackSpread(trackId, spread);
    if (auto* t = g_timeline->getTrackMutable(trackId))
        t->stereoSpread = spread;

    log.done(std::to_string(trackId) + "=" + std::to_string(spread));
    return env.Undefined();
}

// audio_setMasterVolume(volume) → undefined
// volume: 0..1+ linear gain applied post-effect-chain on the master bus.
Napi::Value Audio_SetMasterVolume(const Napi::CallbackInfo& info)
{
    Napi::Env env = info.Env();
    if (!isInitialised()) {
        Napi::Error::New(env, "Engine not initialised.").ThrowAsJavaScriptException();
        return env.Undefined();
    }
    if (info.Length() < 1 || !info[0].IsNumber()) {
        Napi::TypeError::New(env, "audio_setMasterVolume(volume: number)")
            .ThrowAsJavaScriptException();
        return env.Undefined();
    }
    const float vol = info[0].As<Napi::Number>().FloatValue();
    audioEngine->getMixEngine().setMasterVolume(vol);
    return env.Undefined();
}

// ── Effect chain management ─────────────────────────────────────────────────

// audio_addEffect(trackId, pluginId, position) → { nodeId: number }
Napi::Value Audio_AddEffect(const Napi::CallbackInfo& info)
{
    Napi::Env env = info.Env();
    if (!isInitialised()) {
        Napi::Error::New(env, "Engine not initialised.").ThrowAsJavaScriptException();
        return env.Undefined();
    }
    if (info.Length() < 3 || !info[0].IsNumber() || !info[1].IsString() || !info[2].IsNumber()) {
        Napi::TypeError::New(env, "audio_addEffect(trackId: number, pluginId: string, position: number)")
            .ThrowAsJavaScriptException();
        return env.Undefined();
    }
    const int trackId          = info[0].As<Napi::Number>().Int32Value();
    const std::string pluginId = info[1].As<Napi::String>().Utf8Value();
    const int position         = info[2].As<Napi::Number>().Int32Value();
    BridgeCallLog log("audio.addEffect");

    const int nodeId = audioEngine->getMixEngine().addEffect(trackId, pluginId, position);
    if (nodeId < 0) {
        Napi::Error::New(env, "Failed to add effect (unknown pluginId or chain full)").ThrowAsJavaScriptException();
        return env.Undefined();
    }

    Napi::Object result = Napi::Object::New(env);
    result.Set("nodeId", Napi::Number::New(env, nodeId));
    log.done(std::to_string(trackId) + " " + pluginId + " → " + std::to_string(nodeId));
    return result;
}

// audio_removeEffect(trackId, nodeId) → bool
Napi::Value Audio_RemoveEffect(const Napi::CallbackInfo& info)
{
    Napi::Env env = info.Env();
    if (!isInitialised()) {
        Napi::Error::New(env, "Engine not initialised.").ThrowAsJavaScriptException();
        return env.Undefined();
    }
    if (info.Length() < 2 || !info[0].IsNumber() || !info[1].IsNumber()) {
        Napi::TypeError::New(env, "audio_removeEffect(trackId: number, nodeId: number)")
            .ThrowAsJavaScriptException();
        return env.Undefined();
    }
    const int trackId = info[0].As<Napi::Number>().Int32Value();
    const int nodeId  = info[1].As<Napi::Number>().Int32Value();
    BridgeCallLog log("audio.removeEffect");

    const bool ok = audioEngine->getMixEngine().removeEffect(trackId, nodeId);
#ifdef XLETH_DEBUG
    if (!ok) DBG("[Bridge] removeEffect FAILED track=" + std::to_string(trackId) + " node=" + std::to_string(nodeId));
#endif
    log.done(std::to_string(trackId) + " node=" + std::to_string(nodeId));
    return Napi::Boolean::New(env, ok);
}

// audio_moveEffect(trackId, nodeId, newPosition) → bool
Napi::Value Audio_MoveEffect(const Napi::CallbackInfo& info)
{
    Napi::Env env = info.Env();
    if (!isInitialised()) {
        Napi::Error::New(env, "Engine not initialised.").ThrowAsJavaScriptException();
        return env.Undefined();
    }
    if (info.Length() < 3 || !info[0].IsNumber() || !info[1].IsNumber() || !info[2].IsNumber()) {
        Napi::TypeError::New(env, "audio_moveEffect(trackId: number, nodeId: number, newPosition: number)")
            .ThrowAsJavaScriptException();
        return env.Undefined();
    }
    const int trackId     = info[0].As<Napi::Number>().Int32Value();
    const int nodeId      = info[1].As<Napi::Number>().Int32Value();
    const int newPosition = info[2].As<Napi::Number>().Int32Value();
    BridgeCallLog log("audio.moveEffect");

    const bool ok = audioEngine->getMixEngine().moveEffect(trackId, nodeId, newPosition);
#ifdef XLETH_DEBUG
    if (!ok) DBG("[Bridge] moveEffect FAILED track=" + std::to_string(trackId) + " node=" + std::to_string(nodeId));
#endif
    log.done(std::to_string(trackId) + " node=" + std::to_string(nodeId) + " → pos=" + std::to_string(newPosition));
    return Napi::Boolean::New(env, ok);
}

// audio_setEffectBypass(trackId, nodeId, bypassed) → bool
Napi::Value Audio_SetEffectBypass(const Napi::CallbackInfo& info)
{
    Napi::Env env = info.Env();
    if (!isInitialised()) {
        Napi::Error::New(env, "Engine not initialised.").ThrowAsJavaScriptException();
        return env.Undefined();
    }
    if (info.Length() < 3 || !info[0].IsNumber() || !info[1].IsNumber() || !info[2].IsBoolean()) {
        Napi::TypeError::New(env, "audio_setEffectBypass(trackId: number, nodeId: number, bypassed: boolean)")
            .ThrowAsJavaScriptException();
        return env.Undefined();
    }
    const int  trackId  = info[0].As<Napi::Number>().Int32Value();
    const int  nodeId   = info[1].As<Napi::Number>().Int32Value();
    const bool bypassed = info[2].As<Napi::Boolean>().Value();
    BridgeCallLog log("audio.setEffectBypass");

    const bool ok = audioEngine->getMixEngine().setEffectBypass(trackId, nodeId, bypassed);
#ifdef XLETH_DEBUG
    if (!ok) DBG("[Bridge] setEffectBypass FAILED track=" + std::to_string(trackId) + " node=" + std::to_string(nodeId) + " bypassed=" + (bypassed ? "true" : "false"));
#endif
    log.done(std::to_string(trackId) + " node=" + std::to_string(nodeId) + " bypass=" + (bypassed ? "true" : "false") + " ok=" + (ok ? "true" : "false"));
    return Napi::Boolean::New(env, ok);
}

// audio_getEffectChain(trackId) → JSON array [{nodeId, pluginId, position, bypassed}, ...]
Napi::Value Audio_GetEffectChain(const Napi::CallbackInfo& info)
{
    IPC_TIME_START;
    IPC_GAP_CHECK("audio_getEffectChain");
    Napi::Env env = info.Env();
    if (!isInitialised()) {
        Napi::Error::New(env, "Engine not initialised.").ThrowAsJavaScriptException();
        return env.Undefined();
    }
    if (info.Length() < 1 || !info[0].IsNumber()) {
        Napi::TypeError::New(env, "audio_getEffectChain(trackId: number)")
            .ThrowAsJavaScriptException();
        return env.Undefined();
    }
    const int trackId = info[0].As<Napi::Number>().Int32Value();

    const std::string json = audioEngine->getMixEngine().getEffectChainState(trackId);
    IPC_TIME_END("audio_getEffectChain");
    return Napi::String::New(env, json);
}

// ── Effect parameter / meter N-API surface ──────────────────────────────────

// audio_getEffectParameters(trackId, nodeId) → JSON string
// Returns [{id, name, min, max, default, value, unit}, ...] for a track effect node.
Napi::Value Audio_GetEffectParameters(const Napi::CallbackInfo& info)
{
    Napi::Env env = info.Env();
    if (!isInitialised()) {
        Napi::Error::New(env, "Engine not initialised.").ThrowAsJavaScriptException();
        return env.Undefined();
    }
    if (info.Length() < 2 || !info[0].IsNumber() || !info[1].IsNumber()) {
        Napi::TypeError::New(env, "audio_getEffectParameters(trackId: number, nodeId: number)")
            .ThrowAsJavaScriptException();
        return env.Undefined();
    }
    const int trackId = info[0].As<Napi::Number>().Int32Value();
    const int nodeId  = info[1].As<Napi::Number>().Int32Value();

    const std::string json = audioEngine->getMixEngine().getEffectParameters(trackId, nodeId);
    return Napi::String::New(env, json);
}

// audio_setEffectParameter(trackId, nodeId, paramId, value) → bool
Napi::Value Audio_SetEffectParameter(const Napi::CallbackInfo& info)
{
    Napi::Env env = info.Env();
    if (!isInitialised()) {
        Napi::Error::New(env, "Engine not initialised.").ThrowAsJavaScriptException();
        return env.Undefined();
    }
    if (info.Length() < 4 || !info[0].IsNumber() || !info[1].IsNumber()
                           || !info[2].IsString() || !info[3].IsNumber()) {
        Napi::TypeError::New(env, "audio_setEffectParameter(trackId: number, nodeId: number, paramId: string, value: number)")
            .ThrowAsJavaScriptException();
        return env.Undefined();
    }
    const int         trackId = info[0].As<Napi::Number>().Int32Value();
    const int         nodeId  = info[1].As<Napi::Number>().Int32Value();
    const std::string paramId = info[2].As<Napi::String>().Utf8Value();
    const float       value   = info[3].As<Napi::Number>().FloatValue();
    BridgeCallLog log("audio.setEffectParameter");

    const bool ok = audioEngine->getMixEngine().setEffectParameter(trackId, nodeId, paramId, value);
#ifdef XLETH_DEBUG
    if (!ok) DBG("[Bridge] setEffectParameter FAILED track=" + std::to_string(trackId) + " node=" + std::to_string(nodeId) + " param=" + paramId);
#endif
    log.done(std::to_string(trackId) + " node=" + std::to_string(nodeId)
             + " " + paramId + "=" + std::to_string(value));
    return Napi::Boolean::New(env, ok);
}

// audio_getEffectMeter(trackId, nodeId) → JSON string
// Returns [slot0, slot1, ..., slot7] (8 floats).
Napi::Value Audio_GetEffectMeter(const Napi::CallbackInfo& info)
{
    Napi::Env env = info.Env();
    if (!isInitialised()) {
        Napi::Error::New(env, "Engine not initialised.").ThrowAsJavaScriptException();
        return env.Undefined();
    }
    if (info.Length() < 2 || !info[0].IsNumber() || !info[1].IsNumber()) {
        Napi::TypeError::New(env, "audio_getEffectMeter(trackId: number, nodeId: number)")
            .ThrowAsJavaScriptException();
        return env.Undefined();
    }
    const int trackId = info[0].As<Napi::Number>().Int32Value();
    const int nodeId  = info[1].As<Napi::Number>().Int32Value();

    const std::string json = audioEngine->getMixEngine().getEffectMeter(trackId, nodeId);
#ifdef XLETH_DEBUG
    std::fprintf(stderr, "[MeterSlots] track=%d node=%d len=%zu\n",
                 trackId, nodeId, json.size());
#endif
    return Napi::String::New(env, json);
}

// ── Effect visualization (dynamics; opt-in per instance) ────────────────────
//
// audio_setEffectVisualizationEnabled(trackId, nodeId, enabled) → bool
// Allocates / tears down the per-instance ring on the main thread and atomically
// publishes / unpublishes it to the audio thread. While disabled, the audio
// path pays only an acquire-load + null-check per block.
Napi::Value Audio_SetEffectVisualizationEnabled(const Napi::CallbackInfo& info)
{
    Napi::Env env = info.Env();
    if (!isInitialised()) {
        Napi::Error::New(env, "Engine not initialised.").ThrowAsJavaScriptException();
        return env.Undefined();
    }
    if (info.Length() < 3 || !info[0].IsNumber() || !info[1].IsNumber() || !info[2].IsBoolean()) {
        Napi::TypeError::New(env,
            "audio_setEffectVisualizationEnabled(trackId: number, nodeId: number, enabled: boolean)")
            .ThrowAsJavaScriptException();
        return env.Undefined();
    }
    const int  trackId = info[0].As<Napi::Number>().Int32Value();
    const int  nodeId  = info[1].As<Napi::Number>().Int32Value();
    const bool enabled = info[2].As<Napi::Boolean>().Value();

    const bool ok = audioEngine->getMixEngine()
                        .setEffectVisualizationEnabled(trackId, nodeId, enabled);
    return Napi::Boolean::New(env, ok);
}

// audio_drainEffectVizFrames(trackId, nodeId, maxBuckets) →
//   { type: "compressor"|"unknown", schema: number, bucketSize: number,
//     count: number, frames: ArrayBuffer }
//
// Returns a binary payload (ArrayBuffer) of `count` × `bucketSize` bytes.
// On any error / no frames / unknown type, returns a valid object with count=0
// and an empty ArrayBuffer — never throws on empty.
Napi::Value Audio_DrainEffectVizFrames(const Napi::CallbackInfo& info)
{
    Napi::Env env = info.Env();
    if (!isInitialised()) {
        Napi::Error::New(env, "Engine not initialised.").ThrowAsJavaScriptException();
        return env.Undefined();
    }
    if (info.Length() < 3 || !info[0].IsNumber() || !info[1].IsNumber() || !info[2].IsNumber()) {
        Napi::TypeError::New(env,
            "audio_drainEffectVizFrames(trackId: number, nodeId: number, maxBuckets: number)")
            .ThrowAsJavaScriptException();
        return env.Undefined();
    }
    const int trackId    = info[0].As<Napi::Number>().Int32Value();
    const int nodeId     = info[1].As<Napi::Number>().Int32Value();
    const int maxBuckets = info[2].As<Napi::Number>().Int32Value();

    auto& mix = audioEngine->getMixEngine();
    const std::uint32_t typeTag = mix.getEffectVisualizationType(trackId, nodeId);
    const std::uint32_t schema  = mix.getEffectVisualizationSchemaVersion(trackId, nodeId);

    // Resolve bucket size from type tag. Each effect class returns its own
    // type tag from getVisualizationType(); add a branch here when a new
    // dynamics plugin gains a viz pipeline. Unknown types fall through to an
    // empty payload so the JS side renders a safe placeholder.
    std::size_t bucketSize = 0;
    const char* typeStr    = "unknown";
    if (typeTag == xleth::viz::kVizTypeCompressor)
    {
        bucketSize = sizeof(xleth::viz::CompressorBucket);
        typeStr    = "compressor";
    }
    else if (typeTag == xleth::viz::kVizTypeLimiter)
    {
        bucketSize = sizeof(xleth::viz::LimiterBucket);
        typeStr    = "limiter";
    }
    else if (typeTag == xleth::viz::kVizTypeTransient)
    {
        bucketSize = sizeof(xleth::viz::TransientBucket);
        typeStr    = "transient";
    }
    else if (typeTag == xleth::viz::kVizTypeMultiband)
    {
        bucketSize = sizeof(xleth::viz::MultibandBucket);
        typeStr    = "multiband";
    }
    else if (typeTag == xleth::viz::kVizTypeResonance)
    {
        bucketSize = sizeof(xleth::viz::ResonanceBucket);
        typeStr    = "resonance";
    }

    Napi::Object result = Napi::Object::New(env);
    result.Set("type",       Napi::String::New(env, typeStr));
    result.Set("schema",     Napi::Number::New(env, static_cast<double>(schema)));
    result.Set("bucketSize", Napi::Number::New(env, static_cast<double>(bucketSize)));

    if (bucketSize == 0 || maxBuckets <= 0)
    {
        // Always return a valid empty payload — never throw on empty.
        result.Set("count",  Napi::Number::New(env, 0));
        result.Set("frames", Napi::ArrayBuffer::New(env, 0));
        return result;
    }

    // Cap maxBuckets at a sane upper bound to avoid wild allocations from the
    // bridge caller (the ring depth is 1024; one drain should never need
    // more, but we double it for safety).
    const std::size_t cappedBuckets = std::min<std::size_t>(
        static_cast<std::size_t>(maxBuckets),
        static_cast<std::size_t>(xleth::viz::kDynamicsVizRingDepth) * 2);
    const std::size_t maxBytes = cappedBuckets * bucketSize;

    // Allocate the ArrayBuffer once and drain directly into it. JS owns the
    // memory; engine never touches it again after we return.
    Napi::ArrayBuffer ab = Napi::ArrayBuffer::New(env, maxBytes);
    auto* dst = static_cast<std::uint8_t*>(ab.Data());
    const std::size_t bytesWritten = mix.drainEffectVizFrames(trackId, nodeId, dst, maxBytes);
    const std::size_t count        = bytesWritten / bucketSize;

    // If we wrote fewer bytes than allocated, slice the ArrayBuffer to the
    // exact size used. Avoids handing JS a buffer with trailing garbage.
    if (bytesWritten == 0)
    {
        result.Set("count",  Napi::Number::New(env, 0));
        result.Set("frames", Napi::ArrayBuffer::New(env, 0));
        return result;
    }

    if (bytesWritten < maxBytes)
    {
        // Copy the used prefix into a tightly-sized ArrayBuffer.
        Napi::ArrayBuffer trimmed = Napi::ArrayBuffer::New(env, bytesWritten);
        std::memcpy(trimmed.Data(), dst, bytesWritten);
        result.Set("count",  Napi::Number::New(env, static_cast<double>(count)));
        result.Set("frames", trimmed);
        return result;
    }

    result.Set("count",  Napi::Number::New(env, static_cast<double>(count)));
    result.Set("frames", ab);
    return result;
}

// ── Master effect chain variants ────────────────────────────────────────────

// audio_addMasterEffect(pluginId, position) → { nodeId: number }
Napi::Value Audio_AddMasterEffect(const Napi::CallbackInfo& info)
{
    Napi::Env env = info.Env();
    if (!isInitialised()) {
        Napi::Error::New(env, "Engine not initialised.").ThrowAsJavaScriptException();
        return env.Undefined();
    }
    if (info.Length() < 2 || !info[0].IsString() || !info[1].IsNumber()) {
        Napi::TypeError::New(env, "audio_addMasterEffect(pluginId: string, position: number)")
            .ThrowAsJavaScriptException();
        return env.Undefined();
    }
    const std::string pluginId = info[0].As<Napi::String>().Utf8Value();
    const int position         = info[1].As<Napi::Number>().Int32Value();
    BridgeCallLog log("audio.addMasterEffect");

    const int nodeId = audioEngine->getMixEngine().addMasterEffect(pluginId, position);
    if (nodeId < 0) {
        Napi::Error::New(env, "Failed to add master effect (unknown pluginId or chain full)").ThrowAsJavaScriptException();
        return env.Undefined();
    }

    Napi::Object result = Napi::Object::New(env);
    result.Set("nodeId", Napi::Number::New(env, nodeId));
    log.done(pluginId + " → " + std::to_string(nodeId));
    return result;
}

// audio_removeMasterEffect(nodeId) → bool
Napi::Value Audio_RemoveMasterEffect(const Napi::CallbackInfo& info)
{
    Napi::Env env = info.Env();
    if (!isInitialised()) {
        Napi::Error::New(env, "Engine not initialised.").ThrowAsJavaScriptException();
        return env.Undefined();
    }
    if (info.Length() < 1 || !info[0].IsNumber()) {
        Napi::TypeError::New(env, "audio_removeMasterEffect(nodeId: number)")
            .ThrowAsJavaScriptException();
        return env.Undefined();
    }
    const int nodeId = info[0].As<Napi::Number>().Int32Value();
    BridgeCallLog log("audio.removeMasterEffect");

    const bool ok = audioEngine->getMixEngine().removeMasterEffect(nodeId);
#ifdef XLETH_DEBUG
    if (!ok) DBG("[Bridge] removeMasterEffect FAILED node=" + std::to_string(nodeId));
#endif
    log.done("node=" + std::to_string(nodeId));
    return Napi::Boolean::New(env, ok);
}

// audio_moveMasterEffect(nodeId, newPosition) → bool
Napi::Value Audio_MoveMasterEffect(const Napi::CallbackInfo& info)
{
    Napi::Env env = info.Env();
    if (!isInitialised()) {
        Napi::Error::New(env, "Engine not initialised.").ThrowAsJavaScriptException();
        return env.Undefined();
    }
    if (info.Length() < 2 || !info[0].IsNumber() || !info[1].IsNumber()) {
        Napi::TypeError::New(env, "audio_moveMasterEffect(nodeId: number, newPosition: number)")
            .ThrowAsJavaScriptException();
        return env.Undefined();
    }
    const int nodeId      = info[0].As<Napi::Number>().Int32Value();
    const int newPosition = info[1].As<Napi::Number>().Int32Value();
    BridgeCallLog log("audio.moveMasterEffect");

    const bool ok = audioEngine->getMixEngine().moveMasterEffect(nodeId, newPosition);
#ifdef XLETH_DEBUG
    if (!ok) DBG("[Bridge] moveMasterEffect FAILED node=" + std::to_string(nodeId));
#endif
    log.done("node=" + std::to_string(nodeId) + " → pos=" + std::to_string(newPosition));
    return Napi::Boolean::New(env, ok);
}

// audio_setMasterEffectBypass(nodeId, bypassed) → bool
Napi::Value Audio_SetMasterEffectBypass(const Napi::CallbackInfo& info)
{
    Napi::Env env = info.Env();
    if (!isInitialised()) {
        Napi::Error::New(env, "Engine not initialised.").ThrowAsJavaScriptException();
        return env.Undefined();
    }
    if (info.Length() < 2 || !info[0].IsNumber() || !info[1].IsBoolean()) {
        Napi::TypeError::New(env, "audio_setMasterEffectBypass(nodeId: number, bypassed: boolean)")
            .ThrowAsJavaScriptException();
        return env.Undefined();
    }
    const int  nodeId   = info[0].As<Napi::Number>().Int32Value();
    const bool bypassed = info[1].As<Napi::Boolean>().Value();
    BridgeCallLog log("audio.setMasterEffectBypass");

    const bool ok = audioEngine->getMixEngine().setMasterEffectBypass(nodeId, bypassed);
#ifdef XLETH_DEBUG
    if (!ok) DBG("[Bridge] setMasterEffectBypass FAILED node=" + std::to_string(nodeId) + " bypassed=" + (bypassed ? "true" : "false"));
#endif
    log.done("node=" + std::to_string(nodeId) + " bypass=" + (bypassed ? "true" : "false") + " ok=" + (ok ? "true" : "false"));
    return Napi::Boolean::New(env, ok);
}

// audio_getMasterEffectChain() → JSON array
Napi::Value Audio_GetMasterEffectChain(const Napi::CallbackInfo& info)
{
    Napi::Env env = info.Env();
    if (!isInitialised()) {
        Napi::Error::New(env, "Engine not initialised.").ThrowAsJavaScriptException();
        return env.Undefined();
    }

    const std::string json = audioEngine->getMixEngine().getMasterEffectChainState();
    return Napi::String::New(env, json);
}

// ── Graph-mode routing ───────────────────────────────────────────────────────

// audio_addConnection(trackId, sourceNodeId, destNodeId) → bool
Napi::Value Audio_AddConnection(const Napi::CallbackInfo& info)
{
    Napi::Env env = info.Env();
    if (!isInitialised()) {
        Napi::Error::New(env, "Engine not initialised.").ThrowAsJavaScriptException();
        return env.Undefined();
    }
    if (info.Length() < 3 || !info[0].IsNumber() || !info[1].IsNumber() || !info[2].IsNumber()) {
        Napi::TypeError::New(env, "audio_addConnection(trackId: number, sourceNodeId: number, destNodeId: number)")
            .ThrowAsJavaScriptException();
        return env.Undefined();
    }
    const int trackId = info[0].As<Napi::Number>().Int32Value();
    const int srcId   = info[1].As<Napi::Number>().Int32Value();
    const int dstId   = info[2].As<Napi::Number>().Int32Value();

    const bool ok = audioEngine->getMixEngine().addConnection(trackId, srcId, dstId);
    return Napi::Boolean::New(env, ok);
}

// audio_removeConnection(trackId, sourceNodeId, destNodeId) → bool
Napi::Value Audio_RemoveConnection(const Napi::CallbackInfo& info)
{
    Napi::Env env = info.Env();
    if (!isInitialised()) {
        Napi::Error::New(env, "Engine not initialised.").ThrowAsJavaScriptException();
        return env.Undefined();
    }
    if (info.Length() < 3 || !info[0].IsNumber() || !info[1].IsNumber() || !info[2].IsNumber()) {
        Napi::TypeError::New(env, "audio_removeConnection(trackId: number, sourceNodeId: number, destNodeId: number)")
            .ThrowAsJavaScriptException();
        return env.Undefined();
    }
    const int trackId = info[0].As<Napi::Number>().Int32Value();
    const int srcId   = info[1].As<Napi::Number>().Int32Value();
    const int dstId   = info[2].As<Napi::Number>().Int32Value();

    const bool ok = audioEngine->getMixEngine().removeConnection(trackId, srcId, dstId);
    return Napi::Boolean::New(env, ok);
}

// audio_setWireGain(trackId, sourceNodeId, destNodeId, gain) → bool
Napi::Value Audio_SetWireGain(const Napi::CallbackInfo& info)
{
    Napi::Env env = info.Env();
    if (!isInitialised()) {
        Napi::Error::New(env, "Engine not initialised.").ThrowAsJavaScriptException();
        return env.Undefined();
    }
    if (info.Length() < 4 || !info[0].IsNumber() || !info[1].IsNumber()
        || !info[2].IsNumber() || !info[3].IsNumber()) {
        Napi::TypeError::New(env, "audio_setWireGain(trackId, srcId, dstId, gain)")
            .ThrowAsJavaScriptException();
        return env.Undefined();
    }
    const int   trackId = info[0].As<Napi::Number>().Int32Value();
    const int   srcId   = info[1].As<Napi::Number>().Int32Value();
    const int   dstId   = info[2].As<Napi::Number>().Int32Value();
    const float gain    = info[3].As<Napi::Number>().FloatValue();

    const bool ok = audioEngine->getMixEngine().setWireGain(trackId, srcId, dstId, gain);
    return Napi::Boolean::New(env, ok);
}

// audio_setWireMute(trackId, sourceNodeId, destNodeId, muted) → bool
Napi::Value Audio_SetWireMute(const Napi::CallbackInfo& info)
{
    Napi::Env env = info.Env();
    if (!isInitialised()) {
        Napi::Error::New(env, "Engine not initialised.").ThrowAsJavaScriptException();
        return env.Undefined();
    }
    if (info.Length() < 4 || !info[0].IsNumber() || !info[1].IsNumber()
        || !info[2].IsNumber() || !info[3].IsBoolean()) {
        Napi::TypeError::New(env, "audio_setWireMute(trackId, srcId, dstId, muted)")
            .ThrowAsJavaScriptException();
        return env.Undefined();
    }
    const int  trackId = info[0].As<Napi::Number>().Int32Value();
    const int  srcId   = info[1].As<Napi::Number>().Int32Value();
    const int  dstId   = info[2].As<Napi::Number>().Int32Value();
    const bool muted   = info[3].As<Napi::Boolean>().Value();

    const bool ok = audioEngine->getMixEngine().setWireMute(trackId, srcId, dstId, muted);
    return Napi::Boolean::New(env, ok);
}

// audio_getGraphTopology(trackId) → string (JSON)
Napi::Value Audio_GetGraphTopology(const Napi::CallbackInfo& info)
{
    Napi::Env env = info.Env();
    if (!isInitialised()) {
        Napi::Error::New(env, "Engine not initialised.").ThrowAsJavaScriptException();
        return env.Undefined();
    }
    if (info.Length() < 1 || !info[0].IsNumber()) {
        Napi::TypeError::New(env, "audio_getGraphTopology(trackId: number)")
            .ThrowAsJavaScriptException();
        return env.Undefined();
    }
    const int trackId = info[0].As<Napi::Number>().Int32Value();
    return Napi::String::New(env, audioEngine->getMixEngine().getGraphTopology(trackId));
}

// audio_setNodePosition(trackId, nodeId, x, y)
Napi::Value Audio_SetNodePosition(const Napi::CallbackInfo& info)
{
    Napi::Env env = info.Env();
    if (!isInitialised()) {
        Napi::Error::New(env, "Engine not initialised.").ThrowAsJavaScriptException();
        return env.Undefined();
    }
    if (info.Length() < 4 || !info[0].IsNumber() || !info[1].IsNumber()
        || !info[2].IsNumber() || !info[3].IsNumber()) {
        Napi::TypeError::New(env, "audio_setNodePosition(trackId, nodeId, x, y)")
            .ThrowAsJavaScriptException();
        return env.Undefined();
    }
    const int   trackId = info[0].As<Napi::Number>().Int32Value();
    const int   nodeId  = info[1].As<Napi::Number>().Int32Value();
    const float x       = info[2].As<Napi::Number>().FloatValue();
    const float y       = info[3].As<Napi::Number>().FloatValue();

    audioEngine->getMixEngine().setNodePosition(trackId, nodeId, x, y);
    return env.Undefined();
}

// audio_isGraphLinear(trackId) → bool
Napi::Value Audio_IsGraphLinear(const Napi::CallbackInfo& info)
{
    Napi::Env env = info.Env();
    if (!isInitialised()) {
        Napi::Error::New(env, "Engine not initialised.").ThrowAsJavaScriptException();
        return env.Undefined();
    }
    if (info.Length() < 1 || !info[0].IsNumber()) {
        Napi::TypeError::New(env, "audio_isGraphLinear(trackId: number)")
            .ThrowAsJavaScriptException();
        return env.Undefined();
    }
    const int trackId = info[0].As<Napi::Number>().Int32Value();
    return Napi::Boolean::New(env, audioEngine->getMixEngine().isGraphLinear(trackId));
}

// ── Master graph-mode routing ────────────────────────────────────────────────

Napi::Value Audio_AddMasterConnection(const Napi::CallbackInfo& info)
{
    Napi::Env env = info.Env();
    if (!isInitialised()) {
        Napi::Error::New(env, "Engine not initialised.").ThrowAsJavaScriptException();
        return env.Undefined();
    }
    if (info.Length() < 2 || !info[0].IsNumber() || !info[1].IsNumber()) {
        Napi::TypeError::New(env, "audio_addMasterConnection(srcId, dstId)")
            .ThrowAsJavaScriptException();
        return env.Undefined();
    }
    const int srcId = info[0].As<Napi::Number>().Int32Value();
    const int dstId = info[1].As<Napi::Number>().Int32Value();
    return Napi::Boolean::New(env, audioEngine->getMixEngine().addMasterConnection(srcId, dstId));
}

Napi::Value Audio_RemoveMasterConnection(const Napi::CallbackInfo& info)
{
    Napi::Env env = info.Env();
    if (!isInitialised()) {
        Napi::Error::New(env, "Engine not initialised.").ThrowAsJavaScriptException();
        return env.Undefined();
    }
    if (info.Length() < 2 || !info[0].IsNumber() || !info[1].IsNumber()) {
        Napi::TypeError::New(env, "audio_removeMasterConnection(srcId, dstId)")
            .ThrowAsJavaScriptException();
        return env.Undefined();
    }
    const int srcId = info[0].As<Napi::Number>().Int32Value();
    const int dstId = info[1].As<Napi::Number>().Int32Value();
    return Napi::Boolean::New(env, audioEngine->getMixEngine().removeMasterConnection(srcId, dstId));
}

Napi::Value Audio_SetMasterWireGain(const Napi::CallbackInfo& info)
{
    Napi::Env env = info.Env();
    if (!isInitialised()) {
        Napi::Error::New(env, "Engine not initialised.").ThrowAsJavaScriptException();
        return env.Undefined();
    }
    if (info.Length() < 3 || !info[0].IsNumber() || !info[1].IsNumber() || !info[2].IsNumber()) {
        Napi::TypeError::New(env, "audio_setMasterWireGain(srcId, dstId, gain)")
            .ThrowAsJavaScriptException();
        return env.Undefined();
    }
    const int   srcId = info[0].As<Napi::Number>().Int32Value();
    const int   dstId = info[1].As<Napi::Number>().Int32Value();
    const float gain  = info[2].As<Napi::Number>().FloatValue();
    return Napi::Boolean::New(env, audioEngine->getMixEngine().setMasterWireGain(srcId, dstId, gain));
}

Napi::Value Audio_SetMasterWireMute(const Napi::CallbackInfo& info)
{
    Napi::Env env = info.Env();
    if (!isInitialised()) {
        Napi::Error::New(env, "Engine not initialised.").ThrowAsJavaScriptException();
        return env.Undefined();
    }
    if (info.Length() < 3 || !info[0].IsNumber() || !info[1].IsNumber() || !info[2].IsBoolean()) {
        Napi::TypeError::New(env, "audio_setMasterWireMute(srcId, dstId, muted)")
            .ThrowAsJavaScriptException();
        return env.Undefined();
    }
    const int  srcId = info[0].As<Napi::Number>().Int32Value();
    const int  dstId = info[1].As<Napi::Number>().Int32Value();
    const bool muted = info[2].As<Napi::Boolean>().Value();
    return Napi::Boolean::New(env, audioEngine->getMixEngine().setMasterWireMute(srcId, dstId, muted));
}

Napi::Value Audio_GetMasterGraphTopology(const Napi::CallbackInfo& info)
{
    Napi::Env env = info.Env();
    if (!isInitialised()) {
        Napi::Error::New(env, "Engine not initialised.").ThrowAsJavaScriptException();
        return env.Undefined();
    }
    return Napi::String::New(env, audioEngine->getMixEngine().getMasterGraphTopology());
}

Napi::Value Audio_SetMasterNodePosition(const Napi::CallbackInfo& info)
{
    Napi::Env env = info.Env();
    if (!isInitialised()) {
        Napi::Error::New(env, "Engine not initialised.").ThrowAsJavaScriptException();
        return env.Undefined();
    }
    if (info.Length() < 3 || !info[0].IsNumber() || !info[1].IsNumber() || !info[2].IsNumber()) {
        Napi::TypeError::New(env, "audio_setMasterNodePosition(nodeId, x, y)")
            .ThrowAsJavaScriptException();
        return env.Undefined();
    }
    const int   nodeId = info[0].As<Napi::Number>().Int32Value();
    const float x      = info[1].As<Napi::Number>().FloatValue();
    const float y      = info[2].As<Napi::Number>().FloatValue();
    audioEngine->getMixEngine().setMasterNodePosition(nodeId, x, y);
    return env.Undefined();
}

Napi::Value Audio_IsMasterGraphLinear(const Napi::CallbackInfo& info)
{
    Napi::Env env = info.Env();
    if (!isInitialised()) {
        Napi::Error::New(env, "Engine not initialised.").ThrowAsJavaScriptException();
        return env.Undefined();
    }
    return Napi::Boolean::New(env, audioEngine->getMixEngine().isMasterGraphLinear());
}

// ── VST3 plugin scanner ──────────────────────────────────────────────────────

// Returns the directory that contains this .node module (xleth_native.node).
// Used to locate xleth-plugin-scanner.exe which is deployed as a sibling.
static juce::File getThisModuleDir()
{
#ifdef _WIN32
    wchar_t path[MAX_PATH] = {};
    HMODULE hm = nullptr;
    ::GetModuleHandleExW(
        GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS |
        GET_MODULE_HANDLE_EX_FLAG_UNCHANGED_REFCOUNT,
        reinterpret_cast<LPCWSTR>(&getThisModuleDir),
        &hm);
    ::GetModuleFileNameW(hm, path, MAX_PATH);
    return juce::File(juce::String(path)).getParentDirectory();
#else
    return juce::File::getSpecialLocation(
               juce::File::currentApplicationFile).getParentDirectory();
#endif
}

// audio_scanPlugins(paths: string[]) → void
// Replaces the search path list and starts an async background scan.
// If paths is empty or omitted, the scan is skipped.
Napi::Value Audio_ScanPlugins(const Napi::CallbackInfo& info)
{
    Napi::Env env = info.Env();
    if (!isInitialised() || !audioEngine) {
        Napi::Error::New(env, "Engine not initialised.").ThrowAsJavaScriptException();
        return env.Undefined();
    }

    auto& registry = audioEngine->getMixEngine().getPluginRegistry();

    // Replace (not append) the search path list with the caller-supplied paths.
    registry.clearSearchPaths();
    if (info.Length() >= 1 && info[0].IsArray()) {
        const auto arr = info[0].As<Napi::Array>();
        for (uint32_t i = 0; i < arr.Length(); ++i) {
            if (arr.Get(i).IsString())
                registry.addSearchPath(
                    juce::String(arr.Get(i).As<Napi::String>().Utf8Value()));
        }
    }

    // No paths → no-op. scanPlugins() has the same guard internally,
    // but returning early here avoids launching the scanner exe at all.
    if (registry.getSearchPaths().isEmpty())
        return env.Undefined();

    const juce::File scannerExe =
        getThisModuleDir().getChildFile("xleth-plugin-scanner.exe");
    registry.scanPlugins(scannerExe);
    return env.Undefined();
}

// audio_getScanProgress() → { scanning: bool, scanned: number, total: number, failedCount: number }
Napi::Value Audio_GetScanProgress(const Napi::CallbackInfo& info)
{
    IPC_TIME_START;
    IPC_GAP_CHECK("audio_getScanProgress");
    Napi::Env env = info.Env();
    if (!isInitialised() || !audioEngine) {
        Napi::Error::New(env, "Engine not initialised.").ThrowAsJavaScriptException();
        return env.Undefined();
    }
    const auto& reg = audioEngine->getMixEngine().getPluginRegistry();
    auto obj = Napi::Object::New(env);
    obj.Set("scanning",    Napi::Boolean::New(env, reg.isScanning()));
    obj.Set("scanned",     Napi::Number::New(env,  reg.getScannedCount()));
    obj.Set("total",       Napi::Number::New(env,  reg.getTotalCount()));
    obj.Set("failedCount", Napi::Number::New(env,  (int)reg.getFailedPlugins().size()));
    IPC_TIME_END("audio_getScanProgress");
    return obj;
}

// audio_getScannedPlugins() → JSON string (array of plugin descriptors)
Napi::Value Audio_GetScannedPlugins(const Napi::CallbackInfo& info)
{
    Napi::Env env = info.Env();
    if (!isInitialised() || !audioEngine) {
        Napi::Error::New(env, "Engine not initialised.").ThrowAsJavaScriptException();
        return env.Undefined();
    }
    const juce::String json =
        audioEngine->getMixEngine().getPluginRegistry().getPluginListAsJSON();
    return Napi::String::New(env, json.toStdString());
}

// audio_getFailedPlugins() → JSON string (array of { filePath: string })
Napi::Value Audio_GetFailedPlugins(const Napi::CallbackInfo& info)
{
    Napi::Env env = info.Env();
    if (!isInitialised() || !audioEngine) {
        Napi::Error::New(env, "Engine not initialised.").ThrowAsJavaScriptException();
        return env.Undefined();
    }
    const auto failed = audioEngine->getMixEngine().getPluginRegistry().getFailedPlugins();
    juce::String json = "[";
    for (int i = 0; i < failed.size(); ++i) {
        if (i > 0) json += ",";
        const auto esc = failed[i].replace("\\", "\\\\").replace("\"", "\\\"");
        json += "{\"filePath\":\"" + esc + "\"}";
    }
    json += "]";
    return Napi::String::New(env, json.toStdString());
}

// ── Main window HWND (for VST editor parenting) ───────────────────────────────
//
// Stored here so Audio_SetMainWindowHandle can also push the value into the
// MixEngine; MixEngine then passes it to EditorProcessCoordinator so each
// editor-host.exe can call SetWindowLongPtrW(GWLP_HWNDPARENT).

#ifdef _WIN32
static std::atomic<uintptr_t> g_mainXlethHwnd{0};
#endif

// audio_setMainWindowHandle(hwndHex: string) → void
// Called once from main.js after the BrowserWindow is created.
Napi::Value Audio_SetMainWindowHandle(const Napi::CallbackInfo& info)
{
    Napi::Env env = info.Env();
    if (info.Length() < 1 || !info[0].IsString())
    {
        Napi::TypeError::New(env, "audio_setMainWindowHandle(hwndHex: string)")
            .ThrowAsJavaScriptException();
        return env.Undefined();
    }

    const std::string hexStr = info[0].As<Napi::String>().Utf8Value();
    uintptr_t hwnd = 0;
    try { hwnd = (uintptr_t)std::stoull(hexStr, nullptr, 16); } catch (...) {}

#ifdef _WIN32
    g_mainXlethHwnd.store(hwnd);
#endif

    std::fprintf(stderr, "[HWND] Main window handle: 0x%llX\n",
                 (unsigned long long)hwnd);

    if (audioEngine && hwnd != 0)
        audioEngine->getMixEngine().setMainWindowHandle(hwnd);

    return env.Undefined();
}

// ── Plugin editor windows ─────────────────────────────────────────────────────

// audio_openPluginEditor(trackId, nodeId) → { hasEditor: boolean }
// trackId = -1 for master chain.
// hasEditor = true if the editor window was opened (or was already open),
//             false if the plugin has no GUI.
Napi::Value Audio_OpenPluginEditor(const Napi::CallbackInfo& info)
{
    Napi::Env env = info.Env();
    if (!isInitialised() || !audioEngine) {
        Napi::Error::New(env, "Engine not initialised.").ThrowAsJavaScriptException();
        return env.Undefined();
    }
    if (info.Length() < 2 || !info[0].IsNumber() || !info[1].IsNumber()) {
        Napi::TypeError::New(env, "audio_openPluginEditor(trackId: number, nodeId: number)")
            .ThrowAsJavaScriptException();
        return env.Undefined();
    }
    const int trackId = info[0].As<Napi::Number>().Int32Value();
    const int nodeId  = info[1].As<Napi::Number>().Int32Value();
    BridgeCallLog log("audio.openPluginEditor");

    const bool opened = audioEngine->getMixEngine().openPluginEditor(trackId, nodeId);

    Napi::Object result = Napi::Object::New(env);
    result.Set("hasEditor", Napi::Boolean::New(env, opened));
    log.done(std::to_string(trackId) + " node=" + std::to_string(nodeId)
             + " hasEditor=" + (opened ? "true" : "false"));
    return result;
}

// audio_closePluginEditor(trackId, nodeId) → boolean
Napi::Value Audio_ClosePluginEditor(const Napi::CallbackInfo& info)
{
    Napi::Env env = info.Env();
    if (!isInitialised() || !audioEngine) {
        Napi::Error::New(env, "Engine not initialised.").ThrowAsJavaScriptException();
        return env.Undefined();
    }
    if (info.Length() < 2 || !info[0].IsNumber() || !info[1].IsNumber()) {
        Napi::TypeError::New(env, "audio_closePluginEditor(trackId: number, nodeId: number)")
            .ThrowAsJavaScriptException();
        return env.Undefined();
    }
    const int trackId = info[0].As<Napi::Number>().Int32Value();
    const int nodeId  = info[1].As<Napi::Number>().Int32Value();
    BridgeCallLog log("audio.closePluginEditor");

    const bool wasOpen = audioEngine->getMixEngine().isPluginEditorOpen(trackId, nodeId);
    audioEngine->getMixEngine().closePluginEditor(trackId, nodeId);
    log.done(std::to_string(trackId) + " node=" + std::to_string(nodeId));
    return Napi::Boolean::New(env, wasOpen);
}

// audio_closeAllPluginEditors() → void
Napi::Value Audio_CloseAllPluginEditors(const Napi::CallbackInfo& info)
{
    Napi::Env env = info.Env();
    if (!isInitialised() || !audioEngine) {
        Napi::Error::New(env, "Engine not initialised.").ThrowAsJavaScriptException();
        return env.Undefined();
    }
    BridgeCallLog log("audio.closeAllPluginEditors");
    audioEngine->getMixEngine().closeAllPluginEditors();
    log.done();
    return env.Undefined();
}

// audio_isPluginEditorOpen(trackId, nodeId) → boolean
Napi::Value Audio_IsPluginEditorOpen(const Napi::CallbackInfo& info)
{
    Napi::Env env = info.Env();
    if (!isInitialised() || !audioEngine) {
        Napi::Error::New(env, "Engine not initialised.").ThrowAsJavaScriptException();
        return env.Undefined();
    }
    if (info.Length() < 2 || !info[0].IsNumber() || !info[1].IsNumber()) {
        Napi::TypeError::New(env, "audio_isPluginEditorOpen(trackId: number, nodeId: number)")
            .ThrowAsJavaScriptException();
        return env.Undefined();
    }
    const int trackId = info[0].As<Napi::Number>().Int32Value();
    const int nodeId  = info[1].As<Napi::Number>().Int32Value();
    return Napi::Boolean::New(env,
        audioEngine->getMixEngine().isPluginEditorOpen(trackId, nodeId));
}

// ── Missing-plugin helpers ────────────────────────────────────────────────────

// audio_getMissingPlugins() → JSON string
// Returns array of { trackId, nodeId, pluginId, pluginName, pluginVendor, filePath }.
// trackId == -1 means master chain.
// Enrichment (pluginName/pluginVendor/filePath) is done in MixEngine::getMissingPluginsJSON().
Napi::Value Audio_GetMissingPlugins(const Napi::CallbackInfo& info)
{
    Napi::Env env = info.Env();
    if (!isInitialised() || !audioEngine) {
        Napi::Error::New(env, "Engine not initialised.").ThrowAsJavaScriptException();
        return env.Undefined();
    }
    BridgeCallLog log("audio.getMissingPlugins");
    const std::string json = audioEngine->getMixEngine().getMissingPluginsJSON();
    log.done();
    return Napi::String::New(env, json);
}

// audio_retryMissingPlugin(trackId: number, nodeId: number) → { success: boolean }
Napi::Value Audio_RetryMissingPlugin(const Napi::CallbackInfo& info)
{
    Napi::Env env = info.Env();
    if (!isInitialised() || !audioEngine) {
        Napi::Error::New(env, "Engine not initialised.").ThrowAsJavaScriptException();
        return env.Undefined();
    }
    if (info.Length() < 2 || !info[0].IsNumber() || !info[1].IsNumber()) {
        Napi::TypeError::New(env, "audio_retryMissingPlugin(trackId: number, nodeId: number)")
            .ThrowAsJavaScriptException();
        return env.Undefined();
    }
    const int trackId = info[0].As<Napi::Number>().Int32Value();
    const int nodeId  = info[1].As<Napi::Number>().Int32Value();
    BridgeCallLog log("audio.retryMissingPlugin");

    const bool ok = audioEngine->getMixEngine().tryResolvePlugin(trackId, nodeId);

    Napi::Object result = Napi::Object::New(env);
    result.Set("success", Napi::Boolean::New(env, ok));
    log.done("trackId=" + std::to_string(trackId) + " nodeId=" + std::to_string(nodeId)
             + " success=" + (ok ? "true" : "false"));
    return result;
}

// audio_removeAllMissing() → void
Napi::Value Audio_RemoveAllMissing(const Napi::CallbackInfo& info)
{
    Napi::Env env = info.Env();
    if (!isInitialised() || !audioEngine) {
        Napi::Error::New(env, "Engine not initialised.").ThrowAsJavaScriptException();
        return env.Undefined();
    }
    BridgeCallLog log("audio.removeAllMissing");
    audioEngine->getMixEngine().removeAllMissingPlugins();
    log.done();
    return env.Undefined();
}

// audio_resetCrashedPlugin(trackId, nodeId) → boolean
// Attempts to recover a VST node that crashed inside processBlock.
// Returns true if the plugin is healthy again, false if it still faults.
Napi::Value Audio_ResetCrashedPlugin(const Napi::CallbackInfo& info)
{
    Napi::Env env = info.Env();
    if (!isInitialised() || !audioEngine) {
        Napi::Error::New(env, "Engine not initialised.").ThrowAsJavaScriptException();
        return env.Undefined();
    }
    if (info.Length() < 2 || !info[0].IsNumber() || !info[1].IsNumber()) {
        Napi::TypeError::New(env, "audio_resetCrashedPlugin(trackId: number, nodeId: number)")
            .ThrowAsJavaScriptException();
        return env.Undefined();
    }
    const int trackId = info[0].As<Napi::Number>().Int32Value();
    const int nodeId  = info[1].As<Napi::Number>().Int32Value();
    BridgeCallLog log("audio.resetCrashedPlugin");

    // Close any open editor first — if the plugin crashed, the editor may hold
    // dangling pointers into crashed state.  Reopening happens lazily on demand.
    audioEngine->getMixEngine().closePluginEditor(trackId, nodeId);

    const bool ok = audioEngine->getMixEngine().resetCrashedPlugin(trackId, nodeId);
    log.done("trackId=" + std::to_string(trackId) + " nodeId=" + std::to_string(nodeId)
             + " success=" + (ok ? "true" : "false"));
    return Napi::Boolean::New(env, ok);
}

// ── Audio export (offline render to WAV/MP3/FLAC) ────────────────────────────

// audio_exportStart({ outputPath, format, sampleRate, bitDepth, mp3Bitrate,
//                     flacLevel, startBeat, endBeat }) → bool
Napi::Value Audio_ExportStart(const Napi::CallbackInfo& info)
{
    Napi::Env env = info.Env();
    if (!isInitialised() || !g_timeline || !sampleBank) {
        Napi::Error::New(env, "Engine not initialised.").ThrowAsJavaScriptException();
        return Napi::Boolean::New(env, false);
    }
    if (info.Length() < 1 || !info[0].IsObject()) {
        Napi::TypeError::New(env, "audio_exportStart({...config})").ThrowAsJavaScriptException();
        return Napi::Boolean::New(env, false);
    }
    if (g_exportRunning.load()) {
        return Napi::Boolean::New(env, false); // already running
    }

    Napi::Object o = info[0].As<Napi::Object>();

    AudioExporter::Config cfg;
    if (o.Has("outputPath")) cfg.outputPath = o.Get("outputPath").As<Napi::String>().Utf8Value();
    if (cfg.outputPath.empty()) {
        Napi::TypeError::New(env, "outputPath required").ThrowAsJavaScriptException();
        return Napi::Boolean::New(env, false);
    }

    if (o.Has("format")) {
        std::string fmt = o.Get("format").As<Napi::String>().Utf8Value();
        if (fmt == "mp3")       cfg.format = AudioExporter::Format::MP3;
        else if (fmt == "flac") cfg.format = AudioExporter::Format::FLAC;
        else                    cfg.format = AudioExporter::Format::WAV;
    }
    if (o.Has("sampleRate")) cfg.sampleRate = o.Get("sampleRate").As<Napi::Number>().Int32Value();
    if (o.Has("bitDepth"))   cfg.bitDepth   = o.Get("bitDepth").As<Napi::Number>().Int32Value();
    if (o.Has("mp3Bitrate")) cfg.mp3Bitrate = o.Get("mp3Bitrate").As<Napi::Number>().Int32Value();
    if (o.Has("flacLevel"))  cfg.flacLevel  = o.Get("flacLevel").As<Napi::Number>().Int32Value();
    if (o.Has("startBeat"))  cfg.startBeat  = o.Get("startBeat").As<Napi::Number>().DoubleValue();
    if (o.Has("endBeat"))    cfg.endBeat    = o.Get("endBeat").As<Napi::Number>().DoubleValue();

    // Reset state
    {
        std::lock_guard<std::mutex> lk(g_exportStateMutex);
        g_exportProgress.running    = true;
        g_exportProgress.percent    = 0.0f;
        g_exportProgress.phase      = "rendering";
        g_exportProgress.outputPath = cfg.outputPath;
        g_exportProgress.error.clear();
    }
    g_exportCancel.store(false);
    g_exportRunning.store(true);

    // Join any prior thread handle before replacing it
    if (g_exportThread && g_exportThread->joinable()) {
        g_exportThread->detach();
    }

    // Suspend audio device callback so the render thread has exclusive
    // MixEngine access — prevents concurrent processBlock() races that
    // corrupt pattern-track sampler state and timing.
    audioEngine->suspendCallback();

    // Prepare the MixEngine HERE, on the N-API main thread, which is also the
    // JUCE message thread (ScopedJuceInitialiser_GUI was created on it).
    // JUCE's AudioProcessorGraph::prepareToPlay() only builds its render
    // sequence synchronously when called from the message thread; from any
    // other thread it defers via triggerAsyncUpdate().  If we called prepare()
    // inside the spawned thread, processBlock() would fire with a stale render
    // sequence whose settings don't match, causing JUCE to call audio.clear()
    // on every track buffer that has an effect chain — silencing the export.
    {
        auto& mixer = audioEngine->getMixEngine();
        const int sr = cfg.sampleRate > 0 ? cfg.sampleRate : 44100;
        mixer.setNonRealtime(true);
        mixer.prepare(static_cast<double>(sr), 4096);
    }

    g_exportThread = std::make_unique<std::thread>([cfg]() {
        std::cout << "[Bridge] → audio.export start path=" << cfg.outputPath << "\n" << std::flush;

        auto& mixer = audioEngine->getMixEngine();
        // setNonRealtime(true) and prepare() already called on the message
        // thread above — do NOT repeat here (would re-trigger async rebuild).

        AudioExporter exporter;
        bool ok = false;
        try {
            ok = exporter.exportAudio(
                *g_timeline,
                *sampleBank,
                mixer,
                cfg,
                [](float p) {
                    std::lock_guard<std::mutex> lk(g_exportStateMutex);
                    g_exportProgress.percent = p;
                    g_exportProgress.phase = (p < 0.7f) ? "rendering" : "encoding";
                },
                g_exportCancel
            );
        } catch (const std::exception& e) {
            std::lock_guard<std::mutex> lk(g_exportStateMutex);
            g_exportProgress.error = e.what();
            ok = false;
        } catch (...) {
            std::lock_guard<std::mutex> lk(g_exportStateMutex);
            g_exportProgress.error = "unknown exception";
            ok = false;
        }

        // Restore MixEngine state and resume audio device callback
        mixer.setNonRealtime(false);
        audioEngine->resumeCallback();

        {
            std::lock_guard<std::mutex> lk(g_exportStateMutex);
            if (g_exportCancel.load())      g_exportProgress.phase = "cancelled";
            else if (ok)                    { g_exportProgress.phase = "done"; g_exportProgress.percent = 1.0f; }
            else if (g_exportProgress.phase != "cancelled") g_exportProgress.phase = "error";
            g_exportProgress.running = false;
        }
        g_exportRunning.store(false);

        std::cout << "[Bridge] ← audio.export " << (ok ? "done" : "stopped") << "\n" << std::flush;
    });

    return Napi::Boolean::New(env, true);
}

// audio_exportGetProgress() → { running, percent, phase, outputPath, error }
Napi::Value Audio_ExportGetProgress(const Napi::CallbackInfo& info)
{
    Napi::Env env = info.Env();
    Napi::Object o = Napi::Object::New(env);
    std::lock_guard<std::mutex> lk(g_exportStateMutex);
    o.Set("running",    Napi::Boolean::New(env, g_exportProgress.running));
    o.Set("percent",    Napi::Number::New(env, g_exportProgress.percent));
    o.Set("phase",      Napi::String::New(env, g_exportProgress.phase));
    o.Set("outputPath", Napi::String::New(env, g_exportProgress.outputPath));
    o.Set("error",      Napi::String::New(env, g_exportProgress.error));
    return o;
}

// audio_exportCancel() → bool
Napi::Value Audio_ExportCancel(const Napi::CallbackInfo& info)
{
    Napi::Env env = info.Env();
    g_exportCancel.store(true);
    return Napi::Boolean::New(env, true);
}

// ── Video export (offline A/V render via OfflineRenderer) ────────────────────

// video_exportStart({ outputPath, videoCodec, hwEncoder, width, height,
//                     fpsNum, fpsDen, crf, videoBitrate,
//                     audioCodec, sampleRate, audioBitrate,
//                     startBeat, endBeat,
//                     useSourceMedia /* bool, default true — when false the
//                                       render reads DNxHR proxy media instead
//                                       of original-source files. Final export
//                                       must leave this true so CRF/bitrate
//                                       settings operate on full-quality
//                                       pixels. */ }) → bool
Napi::Value Video_ExportStart(const Napi::CallbackInfo& info)
{
    Napi::Env env = info.Env();

    // Auto-init GPU device if not yet created (UI doesn't expose GPU selection yet)
    if (!g_gpuDevice) {
        g_gpuDevice = std::make_unique<GpuDeviceManager>();
        if (g_gpuDevice->detectAdapters()) {
            int defaultIdx = g_gpuDevice->getDefaultAdapterIndex();
            g_gpuDevice->createDevice(defaultIdx >= 0 ? defaultIdx : -1);
        }
    }

    if (!isInitialised() || !g_timeline || !g_gpuDevice) {
        Napi::Error::New(env, "Engine not initialised.").ThrowAsJavaScriptException();
        return Napi::Boolean::New(env, false);
    }
    if (info.Length() < 1 || !info[0].IsObject()) {
        Napi::TypeError::New(env, "video_exportStart({...config})").ThrowAsJavaScriptException();
        return Napi::Boolean::New(env, false);
    }

    // Reject if already running
    if (g_videoRenderer && g_videoRenderer->isRunning()) {
        return Napi::Boolean::New(env, false);
    }

    Napi::Object o = info[0].As<Napi::Object>();

    ExportSettings settings;
    if (o.Has("outputPath")) settings.outputPath = o.Get("outputPath").As<Napi::String>().Utf8Value();
    if (settings.outputPath.empty()) {
        Napi::TypeError::New(env, "outputPath required").ThrowAsJavaScriptException();
        return Napi::Boolean::New(env, false);
    }

    // Video codec
    if (o.Has("videoCodec")) {
        std::string vc = o.Get("videoCodec").As<Napi::String>().Utf8Value();
        if      (vc == "h264")   settings.videoCodec = ExportSettings::VideoCodec::H264;
        else if (vc == "h265")   settings.videoCodec = ExportSettings::VideoCodec::H265;
        else if (vc == "av1")    settings.videoCodec = ExportSettings::VideoCodec::AV1;
        else if (vc == "dnxhd")  settings.videoCodec = ExportSettings::VideoCodec::DNXHD;
        else if (vc == "prores") settings.videoCodec = ExportSettings::VideoCodec::PRORES;
        else                     settings.videoCodec = ExportSettings::VideoCodec::MPEG4;
    }
    if (o.Has("hwEncoder")) settings.hwEncoderName = o.Get("hwEncoder").As<Napi::String>().Utf8Value();
    if (o.Has("videoMode")) {
        std::string vm = o.Get("videoMode").As<Napi::String>().Utf8Value();
        if      (vm == "software") settings.videoMode = ExportSettings::VideoMode::Software;
        else if (vm == "hardware") settings.videoMode = ExportSettings::VideoMode::Hardware;
        else                       settings.videoMode = ExportSettings::VideoMode::Auto;
    }
    if (o.Has("width"))     settings.width     = o.Get("width").As<Napi::Number>().Int32Value();
    if (o.Has("height"))    settings.height    = o.Get("height").As<Napi::Number>().Int32Value();
    if (o.Has("fpsNum"))    settings.fpsNum    = o.Get("fpsNum").As<Napi::Number>().Int32Value();
    if (o.Has("fpsDen"))    settings.fpsDen    = o.Get("fpsDen").As<Napi::Number>().Int32Value();
    if (o.Has("crf"))       settings.crf       = o.Get("crf").As<Napi::Number>().Int32Value();
    if (o.Has("videoBitrate")) settings.videoBitrate = o.Get("videoBitrate").As<Napi::Number>().Int64Value();

    // Audio codec
    if (o.Has("audioCodec")) {
        std::string ac = o.Get("audioCodec").As<Napi::String>().Utf8Value();
        if      (ac == "opus")      settings.audioCodec = ExportSettings::AudioCodec::OPUS;
        else if (ac == "flac")      settings.audioCodec = ExportSettings::AudioCodec::FLAC;
        else if (ac == "pcm_s16le") settings.audioCodec = ExportSettings::AudioCodec::PCM_S16LE;
        else                        settings.audioCodec = ExportSettings::AudioCodec::AAC;
    }
    if (o.Has("sampleRate"))   settings.sampleRate   = o.Get("sampleRate").As<Napi::Number>().Int32Value();
    if (o.Has("audioBitrate")) settings.audioBitrate  = o.Get("audioBitrate").As<Napi::Number>().Int32Value();

    // Render input: default true → original source media. UI sets this
    // explicitly; engine struct also defaults to true so a missing field is
    // safe. Set false only for a deliberate preview-quality export.
    if (o.Has("useSourceMedia"))
        settings.useSourceMedia = o.Get("useSourceMedia").As<Napi::Boolean>().Value();

    // Sample range from beats (0 = start of timeline)
    double startBeat = 0.0, endBeat = -1.0;
    if (o.Has("startBeat")) startBeat = o.Get("startBeat").As<Napi::Number>().DoubleValue();
    if (o.Has("endBeat"))   endBeat   = o.Get("endBeat").As<Napi::Number>().DoubleValue();

    // Convert beats → samples
    const double bpm = g_timeline->getBPM();
    const double sampleRate = static_cast<double>(settings.sampleRate);
    const double beatsToSamples = 60.0 / bpm * sampleRate;
    int64_t startSample = static_cast<int64_t>(startBeat * beatsToSamples);

    // If endBeat not specified, use the timeline's total length
    int64_t endSample;
    if (endBeat < 0.0) {
        // Find the last clip/block end
        double lastBeat = 0.0;
        for (const auto* clip : g_timeline->getAllClips()) {
            double clipEnd = clip->position.toBeats() + clip->duration.toBeats();
            if (clipEnd > lastBeat) lastBeat = clipEnd;
        }
        for (const auto* block : g_timeline->getAllPatternBlocks()) {
            double blockEnd = block->position.toBeats() + block->duration.toBeats();
            if (blockEnd > lastBeat) lastBeat = blockEnd;
        }
        endSample = static_cast<int64_t>(lastBeat * beatsToSamples);
    } else {
        endSample = static_cast<int64_t>(endBeat * beatsToSamples);
    }

    if (endSample <= startSample) {
        Napi::Error::New(env, "Export range is empty (endSample <= startSample)").ThrowAsJavaScriptException();
        return Napi::Boolean::New(env, false);
    }

    // Suspend audio device callback so the render thread has exclusive
    // MixEngine access — prevents concurrent processBlock() races that
    // corrupt pattern-track sampler state and timing.
    audioEngine->suspendCallback();
    g_audioSuspendedForExport.store(true);

    // [PreviewUnify] Pause GPU preview to avoid D3D11 context contention
    g_previewPauseForExport.store(true);

    // Prepare the MixEngine on the message thread before the render thread
    // starts — same reason as Audio_ExportStart above.  512 matches the
    // OfflineRenderer's kBufferSize constant.  The OfflineRenderer will call
    // prepare() again inside renderImpl() on the render thread; because the
    // params are identical, JUCE's signature check skips a redundant rebuild
    // so the render sequence built here remains valid for the first block.
    {
        auto& mixer = audioEngine->getMixEngine();
        mixer.setNonRealtime(true);
        mixer.prepare(static_cast<double>(settings.sampleRate), 512);
    }

    // Create the renderer (destroys any prior instance — joins its thread via dtor)
    g_videoRenderer = std::make_unique<OfflineRenderer>(
        *g_timeline,
        audioEngine->getMixEngine(),
        *g_gpuDevice
    );

    bool ok = g_videoRenderer->startRender(startSample, endSample, settings);
    if (!ok) {
        Napi::Error::New(env, "Failed to start video render").ThrowAsJavaScriptException();
        g_videoRenderer.reset();
        audioEngine->resumeCallback();
        g_audioSuspendedForExport.store(false);
        return Napi::Boolean::New(env, false);
    }

    std::fprintf(stderr, "[Bridge] → video.export start path=%s range=%lld–%lld samples\n",
                 settings.outputPath.c_str(), (long long)startSample, (long long)endSample);
    return Napi::Boolean::New(env, true);
}

// video_exportGetProgress() → { running, percentage, phase, currentFrame,
//                                totalFrames, speed, eta, error, complete, failed }
Napi::Value Video_ExportGetProgress(const Napi::CallbackInfo& info)
{
    Napi::Env env = info.Env();
    Napi::Object o = Napi::Object::New(env);

    if (!g_videoRenderer) {
        o.Set("running",      Napi::Boolean::New(env, false));
        o.Set("percentage",   Napi::Number::New(env, 0.0));
        o.Set("phase",        Napi::Number::New(env, 0));
        o.Set("currentFrame", Napi::Number::New(env, 0));
        o.Set("totalFrames",  Napi::Number::New(env, 0));
        o.Set("speed",        Napi::Number::New(env, 0.0));
        o.Set("eta",          Napi::Number::New(env, 0.0));
        o.Set("error",        Napi::String::New(env, ""));
        o.Set("complete",     Napi::Boolean::New(env, false));
        o.Set("failed",       Napi::Boolean::New(env, false));
        return o;
    }

    const auto& p = g_videoRenderer->getProgress();
    const bool isRunning = g_videoRenderer->isRunning();

    // Resume audio device callback once the render thread has stopped
    if (!isRunning && g_audioSuspendedForExport.exchange(false)) {
        audioEngine->resumeCallback();
        std::fprintf(stderr, "[Bridge] Audio callback resumed after video export\n");

        // [PreviewUnify] Resume GPU preview compositing
        g_previewPauseForExport.store(false);
    }

    o.Set("running",      Napi::Boolean::New(env, isRunning));
    o.Set("percentage",   Napi::Number::New(env, static_cast<double>(p.percentage.load())));
    o.Set("phase",        Napi::Number::New(env, p.phase.load()));
    o.Set("currentFrame", Napi::Number::New(env, static_cast<double>(p.currentFrame.load())));
    o.Set("totalFrames",  Napi::Number::New(env, static_cast<double>(p.totalFrames.load())));
    o.Set("speed",        Napi::Number::New(env, static_cast<double>(p.speedMultiplier.load())));
    o.Set("eta",          Napi::Number::New(env, static_cast<double>(p.etaSeconds.load())));
    o.Set("error",                Napi::String::New(env, p.getError()));
    o.Set("videoEncoderName",     Napi::String::New(env, p.getVideoEncoderName()));
    o.Set("videoEncoderFallback", Napi::Boolean::New(env, p.videoEncoderFallback.load()));
    o.Set("complete",             Napi::Boolean::New(env, p.complete.load()));
    o.Set("failed",               Napi::Boolean::New(env, p.failed.load()));

    return o;
}

// video_exportCancel() → bool
Napi::Value Video_ExportCancel(const Napi::CallbackInfo& info)
{
    Napi::Env env = info.Env();
    if (g_videoRenderer) {
        g_videoRenderer->requestCancel();
        return Napi::Boolean::New(env, true);
    }
    return Napi::Boolean::New(env, false);
}

// video_computeDurationSeconds(startBeat, endBeat) → number
// Resolves the length of an export range in seconds, using the Timeline's
// current BPM. If endBeat < 0, end-of-project is computed from the last
// clip / pattern block end (same logic as Video_ExportStart).
// NOTE: Assumes constant tempo. Update if tempo automation lands.
Napi::Value Video_ComputeDurationSeconds(const Napi::CallbackInfo& info)
{
    Napi::Env env = info.Env();
    if (!g_timeline) return Napi::Number::New(env, 0.0);

    double startBeat = 0.0, endBeat = -1.0;
    if (info.Length() >= 1 && info[0].IsNumber())
        startBeat = info[0].As<Napi::Number>().DoubleValue();
    if (info.Length() >= 2 && info[1].IsNumber())
        endBeat = info[1].As<Napi::Number>().DoubleValue();

    if (endBeat < 0.0) {
        double lastBeat = 0.0;
        for (const auto* clip : g_timeline->getAllClips()) {
            if (!clip) continue;
            double e = clip->position.toBeats() + clip->duration.toBeats();
            if (e > lastBeat) lastBeat = e;
        }
        for (const auto* block : g_timeline->getAllPatternBlocks()) {
            if (!block) continue;
            double e = block->position.toBeats() + block->duration.toBeats();
            if (e > lastBeat) lastBeat = e;
        }
        endBeat = lastBeat;
    }

    const double bpm  = g_timeline->getBPM();
    if (bpm <= 0.0) return Napi::Number::New(env, 0.0);
    const double dur  = std::max(0.0, (endBeat - startBeat) * 60.0 / bpm);
    return Napi::Number::New(env, dur);
}

// ── Sample Export / Swap ──────────────────────────────────────────────────────

namespace {

// Replace non-alphanumeric chars (except - and _) with underscores.
std::string sanitizeFilename(const std::string& s)
{
    std::string out;
    out.reserve(s.size());
    for (unsigned char c : s) {
        if (std::isalnum(c) || c == '-' || c == '_')
            out += static_cast<char>(c);
        else if (c == ' ')
            out += '_';
    }
    return out;
}

// Probe audio stream info (native sample rate + duration) via FFmpeg.
// Returns { 44100, 0.0 } on failure.
// (Struct + forward declaration live above Project_Load — see ~line 2724.)
ProbedAudioInfo probeAudioInfo(const std::string& filePath)
{
    ProbedAudioInfo out{ 44100, 0.0 };
    AVFormatContext* fmt = nullptr;
    if (avformat_open_input(&fmt, filePath.c_str(), nullptr, nullptr) < 0)
        return out;
    if (avformat_find_stream_info(fmt, nullptr) >= 0) {
        if (fmt->duration != AV_NOPTS_VALUE)
            out.duration = static_cast<double>(fmt->duration) / AV_TIME_BASE;
        for (unsigned int i = 0; i < fmt->nb_streams; ++i) {
            if (fmt->streams[i]->codecpar->codec_type == AVMEDIA_TYPE_AUDIO) {
                out.sampleRate = fmt->streams[i]->codecpar->sample_rate;
                break;
            }
        }
    }
    avformat_close_input(&fmt);
    return out;
}

// Append a WAV smpl chunk (root note) to an existing WAV file, then update
// the RIFF size field at offset 4. The smpl chunk is 44 bytes (8 hdr + 36 data).
void appendSmplChunk(const juce::File& file, int rootNote, double sampleRate)
{
    if (rootNote < 0 || !file.existsAsFile()) return;

    juce::FileOutputStream fout(file, 0); // 0 = unbuffered, supports setPosition
    if (!fout.openedOk()) return;

    const int64_t fileSize = file.getSize();

    auto writeLe32 = [&](uint32_t v) {
        uint8_t b[4] = { (uint8_t)v, (uint8_t)(v>>8), (uint8_t)(v>>16), (uint8_t)(v>>24) };
        fout.write(b, 4);
    };

    // Append smpl chunk at end
    fout.setPosition(fileSize);
    fout.write("smpl", 4);
    writeLe32(36);                                                // chunk data size
    writeLe32(0);                                                 // Manufacturer
    writeLe32(0);                                                 // Product
    writeLe32(sampleRate > 0
        ? static_cast<uint32_t>(1000000000.0 / sampleRate) : 0); // Sample Period (ns)
    writeLe32(static_cast<uint32_t>(rootNote));                   // MIDI Unity Note
    writeLe32(0);                                                 // MIDI Pitch Fraction
    writeLe32(0);                                                 // SMPTE Format
    writeLe32(0);                                                 // SMPTE Offset
    writeLe32(0);                                                 // Num Sample Loops
    writeLe32(0);                                                 // Sampler Data

    // Update RIFF size at offset 4: new RIFF size = (fileSize + 44) - 8
    const uint32_t newRiffSize = static_cast<uint32_t>(fileSize - 8 + 44);
    fout.setPosition(4);
    writeLe32(newRiffSize);
    fout.flush();
}

} // namespace

// audio_exportRegion(regionId) → { success, path, duration }
// Decodes the region audio at native source sample rate and writes it to
// exports/{SourceName}_{Label}_{RegionName}.wav. Appends a smpl chunk if
// region.rootNote >= 0.
Napi::Value Audio_ExportRegion(const Napi::CallbackInfo& info)
{
    Napi::Env env = info.Env();
    auto fail = [&](const char* msg) -> Napi::Value {
        Napi::Object o = Napi::Object::New(env);
        o.Set("success", Napi::Boolean::New(env, false));
        o.Set("error",   Napi::String::New(env, msg));
        return o;
    };

    if (!isInitialised() || !g_timeline || !sampleBank || !g_projectManager)
        return fail("Engine not initialised.");
    if (info.Length() < 1 || !info[0].IsNumber())
        return fail("audio_exportRegion(regionId: number)");
    if (!g_projectManager->hasProjectDir())
        return fail("No project directory — save project first.");

    const int regionId = info[0].As<Napi::Number>().Int32Value();
    BridgeCallLog log("audio.exportRegion");

    const SampleRegion* region = g_timeline->getRegion(regionId);
    if (!region) return fail("Region not found.");

    const SourceMedia* source = g_timeline->getSource(region->sourceId);
    if (!source) return fail("Source not found for region.");

    // Build filename: {SourceName}_{Label}_{RegionName}.wav
    const std::string srcStem = juce::File(juce::String(source->fileName))
                                     .getFileNameWithoutExtension()
                                     .toStdString();
    const std::string labelStr = sampleLabelToString(region->label);
    std::string filename = sanitizeFilename(srcStem)   + "_"
                         + sanitizeFilename(labelStr)  + "_"
                         + sanitizeFilename(region->name) + ".wav";
    if (filename.size() <= 4) filename = "export.wav"; // safety fallback

    const std::string outputPath = g_projectManager->getExportsDir() + "/" + filename;

    // Probe the source's native sample rate — export at native rate, no resampling.
    const int nativeRate = probeAudioInfo(source->filePath).sampleRate;

    // Decode region audio with nativeRate as target so SWR is a no-op (src==dst).
    const int sampleId = sampleBank->loadSampleFromSource(
        source->filePath, region->startTime, region->endTime,
        static_cast<double>(nativeRate));
    if (sampleId < 0) return fail("Audio decode failed.");

    const juce::AudioBuffer<float>* buf = sampleBank->getSample(sampleId);
    if (!buf || buf->getNumSamples() == 0) return fail("Empty audio buffer.");

    // Write WAV using JUCE (clean, cross-platform, handles format correctly)
    juce::WavAudioFormat wavFmt;
    auto outFile = juce::File(juce::String(outputPath)); // auto avoids most-vexing-parse
    auto outStream = outFile.createOutputStream();
    if (!outStream || !outStream->openedOk())
        return fail("Cannot create output file.");

    std::unique_ptr<juce::AudioFormatWriter> writer(
        wavFmt.createWriterFor(
            outStream.release(),                          // WavAudioFormat takes ownership
            static_cast<double>(nativeRate),
            static_cast<unsigned int>(buf->getNumChannels()),
            16, {}, 0));
    if (!writer) return fail("WAV writer creation failed.");

    writer->writeFromAudioSampleBuffer(*buf, 0, buf->getNumSamples());
    writer.reset(); // flush + close file

    // Append smpl chunk with root note (file must be closed first)
    if (region->rootNote >= 0)
        appendSmplChunk(outFile, region->rootNote, static_cast<double>(nativeRate));

    const double duration = region->endTime - region->startTime;
    log.done(filename);

    Napi::Object result = Napi::Object::New(env);
    result.Set("success",  Napi::Boolean::New(env, true));
    result.Set("path",     Napi::String::New(env, outputPath));
    result.Set("duration", Napi::Number::New(env, duration));
    return result;
}

// audio_swapRegionAudio(regionId, processedFilePath) → { success, swappedPath }
// Copies the processed WAV to swapped/, loads it into SampleBank at engine rate,
// remaps the region in MixEngine, and sets region.hasSwappedAudio = true.
Napi::Value Audio_SwapRegionAudio(const Napi::CallbackInfo& info)
{
    Napi::Env env = info.Env();
    auto fail = [&](const char* msg) -> Napi::Value {
        Napi::Object o = Napi::Object::New(env);
        o.Set("success", Napi::Boolean::New(env, false));
        o.Set("error",   Napi::String::New(env, msg));
        return o;
    };

    if (!isInitialised() || !g_timeline || !sampleBank || !audioEngine || !g_projectManager)
        return fail("Engine not initialised.");
    if (info.Length() < 2 || !info[0].IsNumber() || !info[1].IsString())
        return fail("audio_swapRegionAudio(regionId: number, processedFilePath: string)");
    if (!g_projectManager->hasProjectDir())
        return fail("No project directory — save project first.");

    const int regionId = info[0].As<Napi::Number>().Int32Value();
    const std::string srcPath = info[1].As<Napi::String>().Utf8Value();
    BridgeCallLog log("audio.swapRegionAudio");

    SampleRegion* region = g_timeline->getRegionMutable(regionId);
    if (!region) return fail("Region not found.");

    auto srcFile = juce::File(juce::String(srcPath));
    if (!srcFile.existsAsFile()) return fail("Processed file not found.");

    // Copy to swapped/, overwriting any previous swap for this filename
    const std::string destPath = g_projectManager->getSwappedDir() + "/"
                                 + srcFile.getFileName().toStdString();
    auto destFile = juce::File(juce::String(destPath));
    if (destFile.existsAsFile()) destFile.deleteFile();
    if (!srcFile.copyFileTo(destFile)) return fail("File copy to swapped/ failed.");

    // Load swapped audio at engine rate. Probe real file duration first —
    // passing a huge endTime (e.g. 999999.0) makes SampleBank reserve a buffer
    // sized for that duration, which blows the allocator.
    const auto probed = probeAudioInfo(destPath);
    const double endT = probed.duration > 0.0 ? probed.duration : 3600.0;
    const double engineRate = g_timeline->getSampleRate();
    const int sampleId = sampleBank->loadSampleFromSource(destPath, 0.0, endT, engineRate);
    if (sampleId < 0) return fail("Failed to decode swapped audio.");
    triggerMipmapGeneration(sampleId, destPath, /*saveXlpeak=*/true);

    audioEngine->getMixEngine().mapRegionToSample(regionId, sampleId);
    refreshSamplerForRegion(regionId);

    region->swappedAudioPath        = destPath;
    region->hasSwappedAudio         = true;
    region->swappedAudioDurationSec = probed.duration > 0.0 ? probed.duration : 0.0;

    log.done(destFile.getFileName().toStdString());

    Napi::Object result = Napi::Object::New(env);
    result.Set("success",     Napi::Boolean::New(env, true));
    result.Set("swappedPath", Napi::String::New(env, destPath));
    return result;
}

// audio_revertRegionAudio(regionId) → { success }
// Reloads the original region audio from its source file, remaps it in
// MixEngine, and clears region.hasSwappedAudio.
Napi::Value Audio_RevertRegionAudio(const Napi::CallbackInfo& info)
{
    Napi::Env env = info.Env();
    auto fail = [&](const char* msg) -> Napi::Value {
        Napi::Object o = Napi::Object::New(env);
        o.Set("success", Napi::Boolean::New(env, false));
        o.Set("error",   Napi::String::New(env, msg));
        return o;
    };

    if (!isInitialised() || !g_timeline || !sampleBank || !audioEngine)
        return fail("Engine not initialised.");
    if (info.Length() < 1 || !info[0].IsNumber())
        return fail("audio_revertRegionAudio(regionId: number)");

    const int regionId = info[0].As<Napi::Number>().Int32Value();
    BridgeCallLog log("audio.revertRegionAudio");

    SampleRegion* region = g_timeline->getRegionMutable(regionId);
    if (!region) return fail("Region not found.");

    const SourceMedia* source = g_timeline->getSource(region->sourceId);
    if (!source) return fail("Source not found for region.");

    const double engineRate = g_timeline->getSampleRate();
    const int sampleId = sampleBank->loadSampleFromSource(
        source->filePath, region->startTime, region->endTime, engineRate);
    if (sampleId < 0) return fail("Failed to decode original audio.");
    triggerMipmapGeneration(sampleId, source->filePath, /*saveXlpeak=*/false);

    audioEngine->getMixEngine().mapRegionToSample(regionId, sampleId);
    refreshSamplerForRegion(regionId);

    region->swappedAudioPath        = "";
    region->hasSwappedAudio         = false;
    region->swappedAudioDurationSec = 0.0;

    log.done(region->name);

    Napi::Object result = Napi::Object::New(env);
    result.Set("success", Napi::Boolean::New(env, true));
    return result;
}

// audio_loadRegionAudio(regionId) → sampleId
// Swap-aware: decodes from the region's swappedAudioPath if hasSwappedAudio is
// set, otherwise from the region's source at [startTime, endTime]. Loads into
// SampleBank and maps the region → sample in MixEngine. Returns -1 on failure.
Napi::Value Audio_LoadRegionAudio(const Napi::CallbackInfo& info)
{
    Napi::Env env = info.Env();
    if (!isInitialised() || !g_timeline || !sampleBank || !audioEngine) {
        Napi::Error::New(env, "Engine not initialised.").ThrowAsJavaScriptException();
        return Napi::Number::New(env, -1);
    }
    if (info.Length() < 1 || !info[0].IsNumber()) {
        Napi::TypeError::New(env, "audio_loadRegionAudio(regionId: number)")
            .ThrowAsJavaScriptException();
        return Napi::Number::New(env, -1);
    }

    const int regionId = info[0].As<Napi::Number>().Int32Value();
    BridgeCallLog log("audio.loadRegionAudio");

    const SampleRegion* region = g_timeline->getRegion(regionId);
    if (!region) {
        log.done("no region");
        return Napi::Number::New(env, -1);
    }

    const double engineRate = audioEngine->getSampleRate();
    int sampleId = -1;

    std::string mipmapSourcePath;
    bool mipmapSaveXlpeak = false;

    if (region->hasSwappedAudio && !region->swappedAudioPath.empty()) {
        const auto probed = probeAudioInfo(region->swappedAudioPath);
        const double endT = probed.duration > 0.0 ? probed.duration : 3600.0;
        sampleId = sampleBank->loadSampleFromSource(
            region->swappedAudioPath, 0.0, endT, engineRate);
        mipmapSourcePath = region->swappedAudioPath;
        mipmapSaveXlpeak = true;
    } else {
        const SourceMedia* source = g_timeline->getSource(region->sourceId);
        if (!source) { log.done("no source"); return Napi::Number::New(env, -1); }
        sampleId = sampleBank->loadSampleFromSource(
            source->filePath, region->startTime, region->endTime, engineRate);
        mipmapSourcePath = source->filePath;
    }

    if (sampleId < 0) { log.done("decode failed"); return Napi::Number::New(env, -1); }
    triggerMipmapGeneration(sampleId, mipmapSourcePath, mipmapSaveXlpeak);

    fprintf(stderr, "[PITCHDBG] audio_loadRegionAudio: mapRegionToSample region=%d sampleId=%d\n",
            regionId, sampleId);
    fflush(stderr);
    audioEngine->getMixEngine().mapRegionToSample(regionId, sampleId);

    // Now that this region's audio is mapped, warm clip caches for any clips
    // referencing it that have non-identity processing params (pitch/stretch/reverse).
    // This is critical for project reload — refreshAllClipCaches() runs before
    // region audio is loaded, so clips miss their initial cache warm.
    {
        auto& mix = audioEngine->getMixEngine();
        for (const Clip* c : g_timeline->getAllClips()) {
            if (!c || c->regionId != regionId) continue;
            const bool needs = (c->pitchOffset != 0 || c->pitchOffsetCents != 0
                             || c->reversed || c->stretchRatio != 1.0);
            if (needs) mix.invalidateClipCache(c->id, "audio_loadRegionAudio");
        }
    }

    log.done(std::to_string(sampleId));
    return Napi::Number::New(env, sampleId);
}

// audio_probeAudioDuration(filePath) → number (seconds, 0 on failure)
// Needed by UI to fetch waveform peaks from a swapped audio file.
Napi::Value Audio_ProbeAudioDuration(const Napi::CallbackInfo& info)
{
    Napi::Env env = info.Env();
    if (info.Length() < 1 || !info[0].IsString()) {
        Napi::TypeError::New(env, "audio_probeAudioDuration(filePath: string)")
            .ThrowAsJavaScriptException();
        return Napi::Number::New(env, 0.0);
    }
    const std::string path = info[0].As<Napi::String>().Utf8Value();
    return Napi::Number::New(env, probeAudioInfo(path).duration);
}

// ── Phase 1B — SourcePlayer (Sample Picker preview) ─────────────────────────

// source_loadSource(filePath) → { success, duration }
Napi::Value Source_LoadSource(const Napi::CallbackInfo& info)
{
    Napi::Env env = info.Env();
    if (!isInitialised()) {
        Napi::Error::New(env, "Engine not initialised.").ThrowAsJavaScriptException();
        return env.Undefined();
    }
    if (info.Length() < 1 || !info[0].IsString()) {
        Napi::TypeError::New(env, "source_loadSource(filePath: string)")
            .ThrowAsJavaScriptException();
        return env.Undefined();
    }

    std::string path = info[0].As<Napi::String>().Utf8Value();
    BridgeCallLog log("source.loadSource");

    auto& sp = audioEngine->getSourcePlayer();
    bool ok = sp.loadSource(path, audioEngine->getSampleRate());

    Napi::Object o = Napi::Object::New(env);
    o.Set("success",  Napi::Boolean::New(env, ok));
    o.Set("duration", Napi::Number::New(env, ok ? sp.getDuration() : 0.0));
    log.done(ok ? "ok" : "failed");
    return o;
}

// source_playSource(startTime)
void Source_PlaySource(const Napi::CallbackInfo& info)
{
    Napi::Env env = info.Env();
    if (!isInitialised()) {
        Napi::Error::New(env, "Engine not initialised.").ThrowAsJavaScriptException();
        return;
    }
    double startTime = 0.0;
    if (info.Length() >= 1 && info[0].IsNumber())
        startTime = info[0].As<Napi::Number>().DoubleValue();
    audioEngine->getSourcePlayer().play(startTime);
}

// source_pauseSource()
void Source_PauseSource(const Napi::CallbackInfo& info)
{
    Napi::Env env = info.Env();
    if (!isInitialised()) {
        Napi::Error::New(env, "Engine not initialised.").ThrowAsJavaScriptException();
        return;
    }
    audioEngine->getSourcePlayer().pause();
}

// source_resumeSource()
void Source_ResumeSource(const Napi::CallbackInfo& info)
{
    Napi::Env env = info.Env();
    if (!isInitialised()) {
        Napi::Error::New(env, "Engine not initialised.").ThrowAsJavaScriptException();
        return;
    }
    audioEngine->getSourcePlayer().resume();
}

// source_seekSource(timeSeconds)
void Source_SeekSource(const Napi::CallbackInfo& info)
{
    Napi::Env env = info.Env();
    if (!isInitialised()) {
        Napi::Error::New(env, "Engine not initialised.").ThrowAsJavaScriptException();
        return;
    }
    if (info.Length() < 1 || !info[0].IsNumber()) {
        Napi::TypeError::New(env, "source_seekSource(timeSeconds: number)")
            .ThrowAsJavaScriptException();
        return;
    }
    audioEngine->getSourcePlayer().seek(info[0].As<Napi::Number>().DoubleValue());
}

// source_stopSource()
void Source_StopSource(const Napi::CallbackInfo& info)
{
    Napi::Env env = info.Env();
    if (!isInitialised()) {
        Napi::Error::New(env, "Engine not initialised.").ThrowAsJavaScriptException();
        return;
    }
    audioEngine->getSourcePlayer().stop();
}

// source_getPosition() → number (seconds)
Napi::Value Source_GetPosition(const Napi::CallbackInfo& info)
{
    Napi::Env env = info.Env();
    if (!isInitialised()) return Napi::Number::New(env, 0.0);
    return Napi::Number::New(env, audioEngine->getSourcePlayer().getPosition());
}

// source_isPlaying() → boolean
Napi::Value Source_IsPlaying(const Napi::CallbackInfo& info)
{
    Napi::Env env = info.Env();
    if (!isInitialised()) return Napi::Boolean::New(env, false);
    return Napi::Boolean::New(env, audioEngine->getSourcePlayer().isPlaying());
}

// source_unloadSource()
void Source_UnloadSource(const Napi::CallbackInfo& info)
{
    Napi::Env env = info.Env();
    if (!isInitialised()) {
        Napi::Error::New(env, "Engine not initialised.").ThrowAsJavaScriptException();
        return;
    }
    audioEngine->getSourcePlayer().unloadSource();
}

// ── Phase 1B — FrameServer (fast frame extraction for SamplePicker) ─────────

// video_openSource(sourceId) → { success, width, height, fps, duration }
Napi::Value Video_OpenSource(const Napi::CallbackInfo& info)
{
    Napi::Env env = info.Env();
    if (!isInitialised() || !g_frameServer || !g_timeline) {
        Napi::Error::New(env, "Engine not initialised.").ThrowAsJavaScriptException();
        return env.Undefined();
    }
    if (info.Length() < 1 || !info[0].IsNumber()) {
        Napi::TypeError::New(env, "video_openSource(sourceId: number)")
            .ThrowAsJavaScriptException();
        return env.Undefined();
    }

    int sourceId = info[0].As<Napi::Number>().Int32Value();
    BridgeCallLog log("video.openSource");

    bool ok = g_frameServer->openSourceFromTimeline(sourceId, *g_timeline);

    Napi::Object o = Napi::Object::New(env);
    o.Set("success", Napi::Boolean::New(env, ok));
    if (ok) {
        auto si = g_frameServer->getSourceInfo(sourceId);
        o.Set("width",    Napi::Number::New(env, si.width));
        o.Set("height",   Napi::Number::New(env, si.height));
        o.Set("fps",      Napi::Number::New(env, si.fps));
        o.Set("duration", Napi::Number::New(env, si.duration));
    }
    log.done(ok ? "ok" : "failed");
    return o;
}

// video_closeSource(sourceId)
void Video_CloseSource(const Napi::CallbackInfo& info)
{
    if (!g_frameServer) return;
    if (info.Length() < 1 || !info[0].IsNumber()) return;
    int sourceId = info[0].As<Napi::Number>().Int32Value();
    g_frameServer->closeSource(sourceId);
}

// video_getFrame(sourceId, timeSeconds, [maxWidth], [maxHeight], [quality])
//   → Buffer (JPEG bytes) or null
Napi::Value Video_GetFrame(const Napi::CallbackInfo& info)
{
    Napi::Env env = info.Env();
    if (!isInitialised() || !g_frameServer) return env.Null();

    if (info.Length() < 2 || !info[0].IsNumber() || !info[1].IsNumber()) {
        Napi::TypeError::New(env,
            "video_getFrame(sourceId, timeSeconds, [maxWidth], [maxHeight], [quality])")
            .ThrowAsJavaScriptException();
        return env.Undefined();
    }

    int    sourceId = info[0].As<Napi::Number>().Int32Value();
    double time     = info[1].As<Napi::Number>().DoubleValue();
    int    maxW     = (info.Length() > 2 && info[2].IsNumber()) ? info[2].As<Napi::Number>().Int32Value() : 480;
    int    maxH     = (info.Length() > 3 && info[3].IsNumber()) ? info[3].As<Napi::Number>().Int32Value() : 270;
    int    quality  = (info.Length() > 4 && info[4].IsNumber()) ? info[4].As<Napi::Number>().Int32Value() : 75;

    std::vector<uint8_t> jpeg = g_frameServer->getFrameJPEG(sourceId, time, maxW, maxH, quality);

    if (jpeg.empty()) return env.Null();

    return Napi::Buffer<uint8_t>::Copy(env, jpeg.data(), jpeg.size());
}

// ── EQ-specific N-API functions ─────────────────────────────────────────────

// Helper: retrieve the EQ effect from a track chain by trackId + nodeId.
static XlethParametricEQ* getEQ(Napi::Env env, int trackId, int nodeId)
{
    auto* base = (trackId < 0)
        ? audioEngine->getMixEngine().getMasterEffectPtr(nodeId)
        : audioEngine->getMixEngine().getEffectPtr(trackId, nodeId);
    if (!base) return nullptr;
    return dynamic_cast<XlethParametricEQ*>(base);
}

// audio_eqAddBand(trackId, nodeId) → number (band index or -1)
Napi::Value Audio_EQ_AddBand(const Napi::CallbackInfo& info)
{
    Napi::Env env = info.Env();
    if (!isInitialised()) {
        Napi::Error::New(env, "Engine not initialised.").ThrowAsJavaScriptException();
        return env.Undefined();
    }
    if (info.Length() < 2 || !info[0].IsNumber() || !info[1].IsNumber()) {
        Napi::TypeError::New(env, "audio_eqAddBand(trackId: number, nodeId: number)")
            .ThrowAsJavaScriptException();
        return env.Undefined();
    }
    const int trackId = info[0].As<Napi::Number>().Int32Value();
    const int nodeId  = info[1].As<Napi::Number>().Int32Value();
    BridgeCallLog log("audio.eqAddBand");

    auto* eq = getEQ(env, trackId, nodeId);
    if (!eq) return Napi::Number::New(env, -1);
    return Napi::Number::New(env, eq->addBand());
}

// audio_eqRemoveBand(trackId, nodeId, bandIndex) → boolean
Napi::Value Audio_EQ_RemoveBand(const Napi::CallbackInfo& info)
{
    Napi::Env env = info.Env();
    if (!isInitialised()) {
        Napi::Error::New(env, "Engine not initialised.").ThrowAsJavaScriptException();
        return env.Undefined();
    }
    if (info.Length() < 3 || !info[0].IsNumber() || !info[1].IsNumber() || !info[2].IsNumber()) {
        Napi::TypeError::New(env, "audio_eqRemoveBand(trackId: number, nodeId: number, bandIndex: number)")
            .ThrowAsJavaScriptException();
        return env.Undefined();
    }
    const int trackId   = info[0].As<Napi::Number>().Int32Value();
    const int nodeId    = info[1].As<Napi::Number>().Int32Value();
    const int bandIndex = info[2].As<Napi::Number>().Int32Value();
    BridgeCallLog log("audio.eqRemoveBand");

    auto* eq = getEQ(env, trackId, nodeId);
    if (!eq) return Napi::Boolean::New(env, false);
    return Napi::Boolean::New(env, eq->removeBand(bandIndex));
}

// audio_eqSetBandParam(trackId, nodeId, bandIndex, paramName, value) → boolean
Napi::Value Audio_EQ_SetBandParam(const Napi::CallbackInfo& info)
{
    Napi::Env env = info.Env();
    if (!isInitialised()) {
        Napi::Error::New(env, "Engine not initialised.").ThrowAsJavaScriptException();
        return env.Undefined();
    }
    if (info.Length() < 5 || !info[0].IsNumber() || !info[1].IsNumber()
        || !info[2].IsNumber() || !info[3].IsString() || !info[4].IsNumber()) {
        Napi::TypeError::New(env, "audio_eqSetBandParam(trackId, nodeId, bandIndex, paramName, value)")
            .ThrowAsJavaScriptException();
        return env.Undefined();
    }
    const int trackId        = info[0].As<Napi::Number>().Int32Value();
    const int nodeId         = info[1].As<Napi::Number>().Int32Value();
    const int bandIndex      = info[2].As<Napi::Number>().Int32Value();
    const std::string pName  = info[3].As<Napi::String>().Utf8Value();
    const float value        = info[4].As<Napi::Number>().FloatValue();
    BridgeCallLog log("audio.eqSetBandParam");

    auto* eq = getEQ(env, trackId, nodeId);
    if (!eq) return Napi::Boolean::New(env, false);
    return Napi::Boolean::New(env, eq->setBandParam(bandIndex, pName, value));
}

// audio_eqGetResponseCurve(trackId, nodeId) → Float32Array (512 floats, dB)
Napi::Value Audio_EQ_GetResponseCurve(const Napi::CallbackInfo& info)
{
    Napi::Env env = info.Env();
    if (!isInitialised()) {
        Napi::Error::New(env, "Engine not initialised.").ThrowAsJavaScriptException();
        return env.Undefined();
    }
    if (info.Length() < 2 || !info[0].IsNumber() || !info[1].IsNumber()) {
        Napi::TypeError::New(env, "audio_eqGetResponseCurve(trackId: number, nodeId: number)")
            .ThrowAsJavaScriptException();
        return env.Undefined();
    }
    const int trackId = info[0].As<Napi::Number>().Int32Value();
    const int nodeId  = info[1].As<Napi::Number>().Int32Value();

    auto* eq = getEQ(env, trackId, nodeId);
    if (!eq) {
        auto ab = Napi::ArrayBuffer::New(env, sizeof(float) * XlethParametricEQ::kResponseSize);
        std::memset(ab.Data(), 0, ab.ByteLength());
        return Napi::Float32Array::New(env, XlethParametricEQ::kResponseSize, ab, 0);
    }
    auto ab = Napi::ArrayBuffer::New(env, sizeof(float) * XlethParametricEQ::kResponseSize);
    eq->getResponseCurve(static_cast<float*>(ab.Data()), XlethParametricEQ::kResponseSize);
    return Napi::Float32Array::New(env, XlethParametricEQ::kResponseSize, ab, 0);
}

// audio_eqGetSpectrumData(trackId, nodeId) → { post: Float32Array, pre: Float32Array | null }
Napi::Value Audio_EQ_GetSpectrumData(const Napi::CallbackInfo& info)
{
    Napi::Env env = info.Env();
    if (!isInitialised()) {
        Napi::Error::New(env, "Engine not initialised.").ThrowAsJavaScriptException();
        return env.Undefined();
    }
    if (info.Length() < 2 || !info[0].IsNumber() || !info[1].IsNumber()) {
        Napi::TypeError::New(env, "audio_eqGetSpectrumData(trackId: number, nodeId: number)")
            .ThrowAsJavaScriptException();
        return env.Undefined();
    }
    const int trackId = info[0].As<Napi::Number>().Int32Value();
    const int nodeId  = info[1].As<Napi::Number>().Int32Value();

    constexpr int bins = XlethParametricEQ::kSpecBins;

    Napi::Object result = Napi::Object::New(env);

    auto* eq = getEQ(env, trackId, nodeId);
    if (!eq) {
        auto postAb = Napi::ArrayBuffer::New(env, sizeof(float) * bins);
        std::memset(postAb.Data(), 0, postAb.ByteLength());
        result.Set("post", Napi::Float32Array::New(env, bins, postAb, 0));
        result.Set("pre", env.Null());
        return result;
    }

    // Post-EQ spectrum (always present)
    auto postAb = Napi::ArrayBuffer::New(env, sizeof(float) * bins);
    eq->getPostSpectrum(static_cast<float*>(postAb.Data()), bins);
    result.Set("post", Napi::Float32Array::New(env, bins, postAb, 0));

    // Pre-EQ spectrum (only if toggled on)
    if (eq->isPreSpectrumEnabled()) {
        auto preAb = Napi::ArrayBuffer::New(env, sizeof(float) * bins);
        eq->getPreSpectrum(static_cast<float*>(preAb.Data()), bins);
        result.Set("pre", Napi::Float32Array::New(env, bins, preAb, 0));
    } else {
        result.Set("pre", env.Null());
    }

    return result;
}

// audio_eqSetPreSpectrum(trackId, nodeId, enabled) → boolean
Napi::Value Audio_EQ_SetPreSpectrum(const Napi::CallbackInfo& info)
{
    Napi::Env env = info.Env();
    if (!isInitialised()) {
        Napi::Error::New(env, "Engine not initialised.").ThrowAsJavaScriptException();
        return env.Undefined();
    }
    if (info.Length() < 3 || !info[0].IsNumber() || !info[1].IsNumber() || !info[2].IsNumber()) {
        Napi::TypeError::New(env, "audio_eqSetPreSpectrum(trackId: number, nodeId: number, enabled: number)")
            .ThrowAsJavaScriptException();
        return env.Undefined();
    }
    const int trackId  = info[0].As<Napi::Number>().Int32Value();
    const int nodeId   = info[1].As<Napi::Number>().Int32Value();
    const bool enabled = info[2].As<Napi::Number>().Int32Value() != 0;

    auto* eq = getEQ(env, trackId, nodeId);
    if (!eq) return Napi::Boolean::New(env, false);
    eq->setPreSpectrumEnabled(enabled);
    return Napi::Boolean::New(env, true);
}

// audio_eqGetBands(trackId, nodeId) → JSON string [{index, freq, gain, q, type, enabled}, ...]
Napi::Value Audio_EQ_GetBands(const Napi::CallbackInfo& info)
{
    Napi::Env env = info.Env();
    if (!isInitialised()) {
        Napi::Error::New(env, "Engine not initialised.").ThrowAsJavaScriptException();
        return env.Undefined();
    }
    if (info.Length() < 2 || !info[0].IsNumber() || !info[1].IsNumber()) {
        Napi::TypeError::New(env, "audio_eqGetBands(trackId: number, nodeId: number)")
            .ThrowAsJavaScriptException();
        return env.Undefined();
    }
    const int trackId = info[0].As<Napi::Number>().Int32Value();
    const int nodeId  = info[1].As<Napi::Number>().Int32Value();

    auto* eq = getEQ(env, trackId, nodeId);
    if (!eq) return Napi::String::New(env, "[]");
    return Napi::String::New(env, eq->getBandsAsJSON());
}

// audio_eqGetBandGR(trackId, nodeId) → Float32Array[16] (per-band GR in dB)
Napi::Value Audio_EQ_GetBandGR(const Napi::CallbackInfo& info)
{
    Napi::Env env = info.Env();
    if (!isInitialised()) {
        Napi::Error::New(env, "Engine not initialised.").ThrowAsJavaScriptException();
        return env.Undefined();
    }
    if (info.Length() < 2 || !info[0].IsNumber() || !info[1].IsNumber()) {
        Napi::TypeError::New(env, "audio_eqGetBandGR(trackId: number, nodeId: number)")
            .ThrowAsJavaScriptException();
        return env.Undefined();
    }
    const int trackId = info[0].As<Napi::Number>().Int32Value();
    const int nodeId  = info[1].As<Napi::Number>().Int32Value();

    constexpr int kMax = XlethParametricEQ::kMaxBands;
    auto ab = Napi::ArrayBuffer::New(env, sizeof(float) * kMax);
    auto* data = static_cast<float*>(ab.Data());

    auto* eq = getEQ(env, trackId, nodeId);
    if (eq) {
        for (int i = 0; i < kMax; ++i)
            data[i] = eq->getBandGR(i);
    } else {
        std::memset(data, 0, sizeof(float) * kMax);
    }
    return Napi::Float32Array::New(env, kMax, ab, 0);
}

// audio_eqSetGlobalParam(trackId, nodeId, paramName, value) → boolean
Napi::Value Audio_EQ_SetGlobalParam(const Napi::CallbackInfo& info)
{
    Napi::Env env = info.Env();
    if (!isInitialised()) {
        Napi::Error::New(env, "Engine not initialised.").ThrowAsJavaScriptException();
        return env.Undefined();
    }
    if (info.Length() < 4 || !info[0].IsNumber() || !info[1].IsNumber()
        || !info[2].IsString() || !info[3].IsNumber()) {
        Napi::TypeError::New(env, "audio_eqSetGlobalParam(trackId, nodeId, paramName, value)")
            .ThrowAsJavaScriptException();
        return env.Undefined();
    }
    const int trackId       = info[0].As<Napi::Number>().Int32Value();
    const int nodeId        = info[1].As<Napi::Number>().Int32Value();
    const std::string pName = info[2].As<Napi::String>().Utf8Value();
    const float value       = info[3].As<Napi::Number>().FloatValue();

    auto* eq = getEQ(env, trackId, nodeId);
    if (!eq) return Napi::Boolean::New(env, false);
    return Napi::Boolean::New(env, eq->setParameterValue(pName, value));
}

// audio_eqGetGlobalParams(trackId, nodeId) → JSON string {linphase, oversample}
Napi::Value Audio_EQ_GetGlobalParams(const Napi::CallbackInfo& info)
{
    Napi::Env env = info.Env();
    if (!isInitialised()) {
        Napi::Error::New(env, "Engine not initialised.").ThrowAsJavaScriptException();
        return env.Undefined();
    }
    if (info.Length() < 2 || !info[0].IsNumber() || !info[1].IsNumber()) {
        Napi::TypeError::New(env, "audio_eqGetGlobalParams(trackId: number, nodeId: number)")
            .ThrowAsJavaScriptException();
        return env.Undefined();
    }
    const int trackId = info[0].As<Napi::Number>().Int32Value();
    const int nodeId  = info[1].As<Napi::Number>().Int32Value();

    auto* eq = getEQ(env, trackId, nodeId);
    if (!eq) return Napi::String::New(env, R"({"linphase":false,"oversample":0})");
    return Napi::String::New(env, eq->getGlobalParamsAsJSON());
}

// audio_eqGetSampleRate(trackId, nodeId) → number (sample rate in Hz)
Napi::Value Audio_EQ_GetSampleRate(const Napi::CallbackInfo& info)
{
    Napi::Env env = info.Env();
    if (!isInitialised()) {
        Napi::Error::New(env, "Engine not initialised.").ThrowAsJavaScriptException();
        return env.Undefined();
    }
    if (info.Length() < 2 || !info[0].IsNumber() || !info[1].IsNumber()) {
        Napi::TypeError::New(env, "audio_eqGetSampleRate(trackId: number, nodeId: number)")
            .ThrowAsJavaScriptException();
        return env.Undefined();
    }
    const int trackId = info[0].As<Napi::Number>().Int32Value();
    const int nodeId  = info[1].As<Napi::Number>().Int32Value();

    auto* eq = getEQ(env, trackId, nodeId);
    if (!eq) return Napi::Number::New(env, 44100.0);
    return Napi::Number::New(env, eq->getSampleRate());
}

// ── Waveshaper-specific N-API functions ─────────────────────────────────────

// Helper: retrieve the Waveshaper effect from a track chain by trackId + nodeId.
static XlethWaveshaperEffect* getWS(Napi::Env env, int trackId, int nodeId)
{
    auto* base = (trackId < 0)
        ? audioEngine->getMixEngine().getMasterEffectPtr(nodeId)
        : audioEngine->getMixEngine().getEffectPtr(trackId, nodeId);
    if (!base) return nullptr;
    return dynamic_cast<XlethWaveshaperEffect*>(base);
}

// audio_wsGetCurvePoints(trackId, nodeId) → JSON string [[x,y], ...]
Napi::Value Audio_WS_GetCurvePoints(const Napi::CallbackInfo& info)
{
    Napi::Env env = info.Env();
    if (!isInitialised()) {
        Napi::Error::New(env, "Engine not initialised.").ThrowAsJavaScriptException();
        return env.Undefined();
    }
    if (info.Length() < 2 || !info[0].IsNumber() || !info[1].IsNumber()) {
        Napi::TypeError::New(env, "audio_wsGetCurvePoints(trackId, nodeId)")
            .ThrowAsJavaScriptException();
        return env.Undefined();
    }
    const int trackId = info[0].As<Napi::Number>().Int32Value();
    const int nodeId  = info[1].As<Napi::Number>().Int32Value();
    BridgeCallLog log("audio.wsGetCurvePoints");

    auto* ws = getWS(env, trackId, nodeId);
    if (!ws) return Napi::String::New(env, "[]");

    auto pts = ws->getControlPoints();
    nlohmann::json arr = nlohmann::json::array();
    for (const auto& [x, y] : pts)
        arr.push_back({x, y});
    return Napi::String::New(env, arr.dump());
}

// audio_wsSetCurvePoints(trackId, nodeId, pointsJSON) → boolean
Napi::Value Audio_WS_SetCurvePoints(const Napi::CallbackInfo& info)
{
    Napi::Env env = info.Env();
    if (!isInitialised()) {
        Napi::Error::New(env, "Engine not initialised.").ThrowAsJavaScriptException();
        return env.Undefined();
    }
    if (info.Length() < 3 || !info[0].IsNumber() || !info[1].IsNumber() || !info[2].IsString()) {
        Napi::TypeError::New(env, "audio_wsSetCurvePoints(trackId, nodeId, pointsJSON)")
            .ThrowAsJavaScriptException();
        return env.Undefined();
    }
    const int trackId = info[0].As<Napi::Number>().Int32Value();
    const int nodeId  = info[1].As<Napi::Number>().Int32Value();
    const std::string json = info[2].As<Napi::String>().Utf8Value();
    BridgeCallLog log("audio.wsSetCurvePoints");

    auto* ws = getWS(env, trackId, nodeId);
    if (!ws) return Napi::Boolean::New(env, false);

    try {
        auto parsed = nlohmann::json::parse(json);
        if (!parsed.is_array()) return Napi::Boolean::New(env, false);

        std::vector<std::pair<float,float>> pts;
        for (const auto& p : parsed) {
            if (!p.is_array() || p.size() < 2) continue;
            pts.push_back({p[0].get<float>(), p[1].get<float>()});
        }
        return Napi::Boolean::New(env, ws->setControlPoints(pts));
    } catch (...) {
        return Napi::Boolean::New(env, false);
    }
}

// audio_wsSetPreset(trackId, nodeId, presetIndex) → boolean
Napi::Value Audio_WS_SetPreset(const Napi::CallbackInfo& info)
{
    Napi::Env env = info.Env();
    if (!isInitialised()) {
        Napi::Error::New(env, "Engine not initialised.").ThrowAsJavaScriptException();
        return env.Undefined();
    }
    if (info.Length() < 3 || !info[0].IsNumber() || !info[1].IsNumber() || !info[2].IsNumber()) {
        Napi::TypeError::New(env, "audio_wsSetPreset(trackId, nodeId, presetIndex)")
            .ThrowAsJavaScriptException();
        return env.Undefined();
    }
    const int trackId     = info[0].As<Napi::Number>().Int32Value();
    const int nodeId      = info[1].As<Napi::Number>().Int32Value();
    const int presetIndex = info[2].As<Napi::Number>().Int32Value();
    BridgeCallLog log("audio.wsSetPreset");

    auto* ws = getWS(env, trackId, nodeId);
    if (!ws) return Napi::Boolean::New(env, false);

    ws->setPreset(presetIndex);
    // If switching to Custom (0), the audio thread sets lutDirty_ instead of
    // calling regenerateLUT(). Trigger the real regeneration here on the
    // message thread.
    if (presetIndex == 0)
        ws->checkAndRegenerateLUT();
    return Napi::Boolean::New(env, true);
}

// ── SmartBalance-specific N-API functions ────────────────────────────────────

// Helper: retrieve SmartBalanceEffect from a track or master chain.
static SmartBalanceEffect* getSmartBalance(Napi::Env env, int trackId, int nodeId)
{
    auto* base = (trackId < 0)
        ? audioEngine->getMixEngine().getMasterEffectPtr(nodeId)
        : audioEngine->getMixEngine().getEffectPtr(trackId, nodeId);
    if (!base) return nullptr;
    return dynamic_cast<SmartBalanceEffect*>(base);
}

// audio_smartBalanceGetDebug(trackId, nodeId)
// → { dryRms: [f,f,f,f], dynDelta: [f,f,f,f], transient: [b,b,b,b], overallRms: f }
// Polled at ~30 fps from React — only atomic reads, no locks.
Napi::Value Audio_SmartBalance_GetDebug(const Napi::CallbackInfo& info)
{
    Napi::Env env = info.Env();
    if (!isInitialised()) {
        Napi::Error::New(env, "Engine not initialised.").ThrowAsJavaScriptException();
        return env.Undefined();
    }
    if (info.Length() < 2 || !info[0].IsNumber() || !info[1].IsNumber()) {
        Napi::TypeError::New(env, "audio_smartBalanceGetDebug(trackId: number, nodeId: number)")
            .ThrowAsJavaScriptException();
        return env.Undefined();
    }
    const int trackId = info[0].As<Napi::Number>().Int32Value();
    const int nodeId  = info[1].As<Napi::Number>().Int32Value();

    auto* sb = getSmartBalance(env, trackId, nodeId);
    if (!sb) return env.Null();

    Napi::Array dryRms    = Napi::Array::New(env, 4);
    Napi::Array dynDelta  = Napi::Array::New(env, 4);
    Napi::Array transient = Napi::Array::New(env, 4);

    for (uint32_t b = 0; b < 4; ++b)
    {
        dryRms.Set(b,    Napi::Number::New(env, sb->debugDryRms_[b].load(std::memory_order_relaxed)));
        dynDelta.Set(b,  Napi::Number::New(env, sb->debugDynDelta_[b].load(std::memory_order_relaxed)));
        transient.Set(b, Napi::Boolean::New(env, sb->debugTransient_[b].load(std::memory_order_relaxed) > 0.5f));
    }

    Napi::Object result = Napi::Object::New(env);
    result.Set("dryRms",    dryRms);
    result.Set("dynDelta",  dynDelta);
    result.Set("transient", transient);
    result.Set("overallRms", Napi::Number::New(env, sb->debugOverallRms_.load(std::memory_order_relaxed)));
    return result;
}

// ─────────────────────────────────────────────────────────────────────────────
// GPU device management (D3D11)
// ─────────────────────────────────────────────────────────────────────────────

// gpu_getAvailableGpus() → [{name, vendor, vendorId, vramMB, isDiscrete, isDefault}]
Napi::Value Gpu_GetAvailableGpus(const Napi::CallbackInfo& info)
{
    Napi::Env env = info.Env();
    BridgeCallLog log("gpu.getAvailableGpus");

    // Lazy-init: detect adapters on first call
    if (!g_gpuDevice) {
        g_gpuDevice = std::make_unique<GpuDeviceManager>();
        if (!g_gpuDevice->detectAdapters()) {
            Napi::Error::New(env, "Failed to enumerate DXGI adapters").ThrowAsJavaScriptException();
            return env.Undefined();
        }
    }

    const auto& adapters = g_gpuDevice->getAdapters();
    std::fprintf(stderr, "[GpuDevice] N-API getAvailableGpus: returning %zu adapters\n",
                 adapters.size());

    Napi::Array arr = Napi::Array::New(env, adapters.size());
    for (size_t i = 0; i < adapters.size(); ++i) {
        const auto& a = adapters[i];

        // Convert wstring name to narrow string for JS
        // GPU names are ASCII in practice (vendor model strings)
        std::string nameUtf8;
        nameUtf8.reserve(a.name.size());
        for (wchar_t wc : a.name)
            nameUtf8.push_back(static_cast<char>(wc & 0x7F));

        // Vendor string
        const char* vendorStr = "Unknown";
        if (a.vendorId == GpuVendor::NVIDIA) vendorStr = "NVIDIA";
        else if (a.vendorId == GpuVendor::AMD)    vendorStr = "AMD";
        else if (a.vendorId == GpuVendor::Intel)  vendorStr = "Intel";

        Napi::Object o = Napi::Object::New(env);
        o.Set("name",       Napi::String::New(env, nameUtf8));
        o.Set("vendor",     Napi::String::New(env, vendorStr));
        o.Set("vendorId",   Napi::Number::New(env, a.vendorId));
        o.Set("deviceId",   Napi::Number::New(env, a.deviceId));
        o.Set("vramMB",     Napi::Number::New(env, static_cast<double>(a.dedicatedVideoMemoryMB)));
        o.Set("sharedSystemMemoryMB",
                            Napi::Number::New(env, static_cast<double>(a.sharedSystemMemoryMB)));
        o.Set("isDiscrete", Napi::Boolean::New(env, a.isDiscrete));
        o.Set("isDefault",  Napi::Boolean::New(env, a.isDefault));
        o.Set("index",      Napi::Number::New(env, a.adapterIndex));
        o.Set("luidHighPart", Napi::Number::New(env, a.luidHighPart));
        o.Set("luidLowPart",  Napi::Number::New(env, a.luidLowPart));
        arr.Set(static_cast<uint32_t>(i), o);
    }

    log.done(std::to_string(adapters.size()) + " adapters");
    return arr;
}

// ─────────────────────────────────────────────────────────────────────────────
// diag_getVisualPreviewDiagnostic()
//
// Returns a structured snapshot of the live preview / grid pipeline state for
// the Settings → Graphics → Export Visual Preview Diagnostic Log feature.
// All counters are atomic and read without locking the compositor mutex so
// the call is safe to invoke from the JS thread mid-playback.
//
// The shape is intentionally flat-ish so JSON.stringify in the renderer can
// turn the whole object into a plain-text section in the .txt log.
// ─────────────────────────────────────────────────────────────────────────────
Napi::Value Diag_GetVisualPreviewDiagnostic(const Napi::CallbackInfo& info)
{
    Napi::Env env = info.Env();
    Napi::Object o = Napi::Object::New(env);

    // ── Adapter list (mirrors gpu_getAvailableGpus output, included so the
    //    diagnostic .txt is self-contained without a second N-API call) ───────
    Napi::Array adapterArr;
    if (g_gpuDevice) {
        const auto& adapters = g_gpuDevice->getAdapters();
        adapterArr = Napi::Array::New(env, adapters.size());
        for (size_t i = 0; i < adapters.size(); ++i) {
            const auto& a = adapters[i];
            std::string nameUtf8;
            nameUtf8.reserve(a.name.size());
            for (wchar_t wc : a.name)
                nameUtf8.push_back(static_cast<char>(wc & 0x7F));
            const char* vendorStr = "Unknown";
            if (a.vendorId == GpuVendor::NVIDIA)      vendorStr = "NVIDIA";
            else if (a.vendorId == GpuVendor::AMD)    vendorStr = "AMD";
            else if (a.vendorId == GpuVendor::Intel)  vendorStr = "Intel";

            Napi::Object ao = Napi::Object::New(env);
            ao.Set("name",       Napi::String::New(env, nameUtf8));
            ao.Set("vendor",     Napi::String::New(env, vendorStr));
            ao.Set("vendorId",   Napi::Number::New(env, a.vendorId));
            ao.Set("deviceId",   Napi::Number::New(env, a.deviceId));
            ao.Set("vramMB",     Napi::Number::New(env, static_cast<double>(a.dedicatedVideoMemoryMB)));
            ao.Set("sharedSystemMemoryMB",
                                 Napi::Number::New(env, static_cast<double>(a.sharedSystemMemoryMB)));
            ao.Set("isDiscrete", Napi::Boolean::New(env, a.isDiscrete));
            ao.Set("isDefault",  Napi::Boolean::New(env, a.isDefault));
            ao.Set("index",      Napi::Number::New(env, a.adapterIndex));
            ao.Set("luidHighPart", Napi::Number::New(env, a.luidHighPart));
            ao.Set("luidLowPart",  Napi::Number::New(env, a.luidLowPart));
            adapterArr.Set(static_cast<uint32_t>(i), ao);
        }
        o.Set("activeAdapterIndex",
              Napi::Number::New(env, g_gpuDevice->getActiveAdapterIndex()));
        o.Set("hasD3D11Device", Napi::Boolean::New(env, g_gpuDevice->hasDevice()));
    } else {
        adapterArr = Napi::Array::New(env, 0);
        o.Set("activeAdapterIndex", Napi::Number::New(env, -1));
        o.Set("hasD3D11Device", Napi::Boolean::New(env, false));
    }
    o.Set("adapters", adapterArr);

    // ── Compositor lifecycle / state ─────────────────────────────────────────
    o.Set("compositorReady",
          Napi::Boolean::New(env, g_previewCompositorReady.load()));
    o.Set("compositorPresent",
          Napi::Boolean::New(env, g_previewCompositor != nullptr));
    o.Set("decoderPresent",
          Napi::Boolean::New(env, g_previewRenderDecoder != nullptr));
    o.Set("collectorPresent",
          Napi::Boolean::New(env, g_previewCollector != nullptr));
    o.Set("renderCachePresent",
          Napi::Boolean::New(env, g_previewRenderCache != nullptr));
    o.Set("animMgrPresent",
          Napi::Boolean::New(env, g_previewAnimMgr != nullptr));
    o.Set("pauseForExport",
          Napi::Boolean::New(env, g_previewPauseForExport.load()));
    o.Set("pauseForVisibility",
          Napi::Boolean::New(env, g_previewPauseForVisibility.load()));
    o.Set("previewResolutionScale",
          Napi::Number::New(env, g_previewResolutionScale));
    o.Set("previewEffectsBypass",
          Napi::Boolean::New(env, g_previewEffectsBypass));

    // ── Canvas / FrameOutput ─────────────────────────────────────────────────
    o.Set("canvasWidth",  Napi::Number::New(env, CANVAS_W));
    o.Set("canvasHeight", Napi::Number::New(env, CANVAS_H));
    o.Set("frameOutputInitialized",
          Napi::Boolean::New(env, frameOutput.isInitialized()));
    o.Set("frameOutputWidth",  Napi::Number::New(env, frameOutput.getWidth()));
    o.Set("frameOutputHeight", Napi::Number::New(env, frameOutput.getHeight()));
    o.Set("frameOutputBufferSize", Napi::Number::New(env, frameOutput.getBufferSize()));
    o.Set("frameOutputCurrentIndex", Napi::Number::New(env, frameOutput.getCurrentBufferIndex()));

    // ── Counters (since process start) ───────────────────────────────────────
    Napi::Object c = Napi::Object::New(env);
    c.Set("videoTickCount",
          Napi::Number::New(env, static_cast<double>(g_previewDiag.videoTickCount.load())));
    c.Set("compositorPathEntered",
          Napi::Number::New(env, static_cast<double>(g_previewDiag.compositorPathEntered.load())));
    c.Set("compositeFrameCount",
          Napi::Number::New(env, static_cast<double>(g_previewDiag.compositeFrameCount.load())));
    c.Set("readbackValidCount",
          Napi::Number::New(env, static_cast<double>(g_previewDiag.readbackValidCount.load())));
    c.Set("readbackInvalidCount",
          Napi::Number::New(env, static_cast<double>(g_previewDiag.readbackInvalidCount.load())));
    c.Set("canvasCopyCount",
          Napi::Number::New(env, static_cast<double>(g_previewDiag.canvasCopyCount.load())));
    c.Set("blackFrameCount",
          Napi::Number::New(env, static_cast<double>(g_previewDiag.blackFrameCount.load())));
    c.Set("compositorInitFailures",
          Napi::Number::New(env, static_cast<double>(g_previewDiag.initInitFailures.load())));
    o.Set("counters", c);

    // ── Last-tick snapshot ───────────────────────────────────────────────────
    Napi::Object last = Napi::Object::New(env);
    last.Set("readbackWidth",  Napi::Number::New(env, g_previewDiag.lastReadbackWidth.load()));
    last.Set("readbackHeight", Napi::Number::New(env, g_previewDiag.lastReadbackHeight.load()));
    last.Set("requestCount",   Napi::Number::New(env, g_previewDiag.lastRequestCount.load()));
    last.Set("decodeMissCount",Napi::Number::New(env, g_previewDiag.lastDecodeMissCount.load()));
    last.Set("layoutColumns",  Napi::Number::New(env, g_previewDiag.lastLayoutColumns.load()));
    last.Set("layoutRows",     Napi::Number::New(env, g_previewDiag.lastLayoutRows.load()));
    last.Set("compositorWidth",  Napi::Number::New(env, g_previewDiag.lastCompositorWidth.load()));
    last.Set("compositorHeight", Napi::Number::New(env, g_previewDiag.lastCompositorHeight.load()));
    last.Set("initWidth",  Napi::Number::New(env, g_previewDiag.lastInitW.load()));
    last.Set("initHeight", Napi::Number::New(env, g_previewDiag.lastInitH.load()));
    {
        const int32_t hr = g_previewDiag.lastReadbackHRESULT.load();
        char hrHex[12];
        std::snprintf(hrHex, sizeof(hrHex), "0x%08X", static_cast<unsigned int>(hr));
        last.Set("lastReadbackHRESULT", Napi::String::New(env, hrHex));
        const char* hrTxt;
        switch (static_cast<unsigned int>(hr)) {
            case 0x00000000U: hrTxt = "S_OK"; break;
            case 0x887A0001U: hrTxt = "DXGI_ERROR_WAS_STILL_DRAWING"; break;
            case 0x887A0005U: hrTxt = "DXGI_ERROR_DEVICE_REMOVED"; break;
            case 0x887A0006U: hrTxt = "DXGI_ERROR_DEVICE_HUNG"; break;
            case 0x887A0007U: hrTxt = "DXGI_ERROR_DEVICE_RESET"; break;
            case 0x80070057U: hrTxt = "E_INVALIDARG"; break;
            case 0x80004003U: hrTxt = "E_POINTER"; break;
            case 0x8007000EU: hrTxt = "E_OUTOFMEMORY"; break;
            default:          hrTxt = "(unknown)"; break;
        }
        last.Set("lastReadbackHRESULTText", Napi::String::New(env, hrTxt));
    }
    o.Set("lastTick", last);

    // ── Timeline / grid summary (best-effort, optional) ──────────────────────
    if (g_timeline) {
        const auto layout = g_timeline->getGridLayout();
        Napi::Object gl = Napi::Object::New(env);
        gl.Set("columns",    Napi::Number::New(env, layout.columns));
        gl.Set("rows",       Napi::Number::New(env, layout.rows));
        gl.Set("previewFps", Napi::Number::New(env, layout.previewFps));
        gl.Set("gapScale",   Napi::Number::New(env, layout.gapScale));
        o.Set("gridLayout", gl);
    }

    return o;
}

// gpu_setAdapter(index) → {success, name, vramMB}
Napi::Value Gpu_SetAdapter(const Napi::CallbackInfo& info)
{
    Napi::Env env = info.Env();
    if (info.Length() < 1 || !info[0].IsNumber()) {
        Napi::TypeError::New(env, "gpu_setAdapter(index: number)")
            .ThrowAsJavaScriptException();
        return env.Undefined();
    }

    int index = info[0].As<Napi::Number>().Int32Value();
    BridgeCallLog log("gpu.setAdapter");

    std::fprintf(stderr, "[GpuDevice] N-API setGpuAdapter: switching to adapter %d, recreating device...\n",
                 index);

    if (!g_gpuDevice) {
        g_gpuDevice = std::make_unique<GpuDeviceManager>();
        if (!g_gpuDevice->detectAdapters()) {
            Napi::Error::New(env, "Failed to enumerate DXGI adapters").ThrowAsJavaScriptException();
            return env.Undefined();
        }
    }

    bool ok = g_gpuDevice->createDevice(index);

    Napi::Object o = Napi::Object::New(env);
    o.Set("success", Napi::Boolean::New(env, ok));

    if (ok) {
        // Find adapter info for response
        for (const auto& a : g_gpuDevice->getAdapters()) {
            if (a.adapterIndex == g_gpuDevice->getActiveAdapterIndex()) {
                std::string nameUtf8;
                nameUtf8.reserve(a.name.size());
                for (wchar_t wc : a.name)
                    nameUtf8.push_back(static_cast<char>(wc & 0x7F));
                o.Set("name",   Napi::String::New(env, nameUtf8));
                o.Set("vramMB", Napi::Number::New(env, static_cast<double>(a.dedicatedVideoMemoryMB)));
                break;
            }
        }
    }

    log.done(ok ? "ok" : "failed");
    return o;
}

// ─────────────────────────────────────────────────────────────────────────────
// Hardware encoder detection (NVENC, AMF, QSV, software fallbacks)
// ─────────────────────────────────────────────────────────────────────────────

/** Map a JS codec string to AVCodecID using the engine's HwEncoderDetector. */
static int codecNameToId(const std::string& name)
{
    return HwEncoderDetector::codecNameToId(name.c_str());
}

/** Lazy-init the detector — runs detection on first call. */
static HwEncoderDetector& ensureDetector()
{
    if (!g_hwEncoderDetector) {
        g_hwEncoderDetector = std::make_unique<HwEncoderDetector>();
        // Correlate with GPU vendor if device manager is available
        if (g_gpuDevice && g_gpuDevice->getActiveAdapterIndex() >= 0) {
            for (const auto& a : g_gpuDevice->getAdapters()) {
                if (a.adapterIndex == g_gpuDevice->getActiveAdapterIndex()) {
                    g_hwEncoderDetector->setGpuVendorId(a.vendorId);
                    break;
                }
            }
        }
        g_hwEncoderDetector->detect();
    }
    return *g_hwEncoderDetector;
}

// hwenc_getAvailableEncoders(codec: string) → [{name, displayName, isHardware, isAvailable}]
Napi::Value HwEnc_GetAvailableEncoders(const Napi::CallbackInfo& info)
{
    Napi::Env env = info.Env();
    if (info.Length() < 1 || !info[0].IsString()) {
        Napi::TypeError::New(env, "hwenc_getAvailableEncoders(codec: string) — "
                             "codec is one of: h264, hevc, av1, mpeg4, dnxhd, prores, aac")
            .ThrowAsJavaScriptException();
        return env.Undefined();
    }

    std::string codecStr = info[0].As<Napi::String>().Utf8Value();
    int codecId = codecNameToId(codecStr);
    if (codecId < 0) {
        Napi::TypeError::New(env, "Unknown codec: " + codecStr).ThrowAsJavaScriptException();
        return env.Undefined();
    }

    auto& detector = ensureDetector();
    auto encoders = detector.getAvailableEncoders(codecId);

    Napi::Array arr = Napi::Array::New(env, encoders.size());
    for (size_t i = 0; i < encoders.size(); ++i) {
        const auto& e = encoders[i];
        Napi::Object o = Napi::Object::New(env);
        o.Set("name",        Napi::String::New(env, e.name));
        o.Set("displayName", Napi::String::New(env, e.displayName));
        o.Set("isHardware",  Napi::Boolean::New(env, e.isHardware));
        o.Set("isAvailable", Napi::Boolean::New(env, e.isAvailable));
        arr.Set(static_cast<uint32_t>(i), o);
    }

    return arr;
}

// hwenc_getDefaultEncoder(codec: string) → string (encoder name)
Napi::Value HwEnc_GetDefaultEncoder(const Napi::CallbackInfo& info)
{
    Napi::Env env = info.Env();
    if (info.Length() < 1 || !info[0].IsString()) {
        Napi::TypeError::New(env, "hwenc_getDefaultEncoder(codec: string)")
            .ThrowAsJavaScriptException();
        return env.Undefined();
    }

    std::string codecStr = info[0].As<Napi::String>().Utf8Value();
    int codecId = codecNameToId(codecStr);
    if (codecId < 0) {
        Napi::TypeError::New(env, "Unknown codec: " + codecStr).ThrowAsJavaScriptException();
        return env.Undefined();
    }

    auto& detector = ensureDetector();
    return Napi::String::New(env, detector.getDefaultEncoder(codecId));
}

// hwenc_refresh() → void — re-detect all encoders (e.g. after GPU change)
Napi::Value HwEnc_Refresh(const Napi::CallbackInfo& info)
{
    Napi::Env env = info.Env();
    if (g_hwEncoderDetector) {
        // Update vendor preference if GPU changed
        if (g_gpuDevice && g_gpuDevice->getActiveAdapterIndex() >= 0) {
            for (const auto& a : g_gpuDevice->getAdapters()) {
                if (a.adapterIndex == g_gpuDevice->getActiveAdapterIndex()) {
                    g_hwEncoderDetector->setGpuVendorId(a.vendorId);
                    break;
                }
            }
        }
        g_hwEncoderDetector->refresh();
    } else {
        ensureDetector();
    }
    return env.Undefined();
}

// ─────────────────────────────────────────────────────────────────────────────
// Phase 7 — Preview visibility (panel show/hide)
// ─────────────────────────────────────────────────────────────────────────────

// preview_setEnabled(enabled: boolean) → undefined
//   enabled=true  ⇒ panel visible, GPU compositor runs
//   enabled=false ⇒ panel hidden, compositor pauses (one black frame, then idle)
// Independent of g_previewPauseForExport — render path resumes only when BOTH
// flags are clear.
Napi::Value Preview_SetEnabled(const Napi::CallbackInfo& info)
{
    Napi::Env env = info.Env();
    if (info.Length() < 1 || !info[0].IsBoolean()) {
        Napi::TypeError::New(env, "preview_setEnabled(enabled: boolean)")
            .ThrowAsJavaScriptException();
        return env.Undefined();
    }
    const bool enabled = info[0].As<Napi::Boolean>().Value();
    g_previewPauseForVisibility.store(!enabled);
    return env.Undefined();
}

// ─────────────────────────────────────────────────────────────────────────────
// MIDI Import
// ─────────────────────────────────────────────────────────────────────────────

Napi::Value Midi_ParseSummary(const Napi::CallbackInfo& info)
{
    Napi::Env env = info.Env();

    if (info.Length() < 1 || !info[0].IsString()) {
        Napi::TypeError::New(env, "parseMidiSummary(filePath: string)")
            .ThrowAsJavaScriptException();
        return env.Null();
    }

    std::string filePath = info[0].As<Napi::String>().Utf8Value();

#ifdef XLETH_DEBUG
    std::cout << "[MidiImport] parseSummary: " << filePath << std::endl << std::flush;
#endif

    try {
        std::string json = MidiImporter::parseSummary(filePath);
        return Napi::String::New(env, json);
    } catch (const std::exception& e) {
        Napi::Error::New(env, e.what()).ThrowAsJavaScriptException();
        return env.Null();
    }
}

Napi::Value Midi_ImportFull(const Napi::CallbackInfo& info)
{
    Napi::Env env = info.Env();

    if (info.Length() < 2 || !info[0].IsString() || !info[1].IsString()) {
        Napi::TypeError::New(env, "importMidiFull(filePath: string, optionsJson: string)")
            .ThrowAsJavaScriptException();
        return env.Null();
    }

    std::string filePath    = info[0].As<Napi::String>().Utf8Value();
    std::string optionsJson = info[1].As<Napi::String>().Utf8Value();

#ifdef XLETH_DEBUG
    std::cout << "[MidiImport] importFull: " << filePath << std::endl << std::flush;
#endif

    try {
        MidiImportFullResult r = MidiImporter::importFull(filePath, optionsJson);

        size_t sizeBytes = r.notes.getSize();
        Napi::ArrayBuffer ab = Napi::ArrayBuffer::New(env, sizeBytes);
        if (sizeBytes > 0)
            std::memcpy(ab.Data(), r.notes.getData(), sizeBytes);

        Napi::Object out = Napi::Object::New(env);
        out.Set("metadata", Napi::String::New(env, r.metadataJson));
        out.Set("noteData", ab);
        return out;
    } catch (const std::exception& e) {
        Napi::Error::New(env, e.what()).ThrowAsJavaScriptException();
        return env.Null();
    }
}

// midi_executeImport(noteData: ArrayBuffer | Buffer | Uint8Array,
//                    optionsJson: string)
//   Commits a parsed MIDI import (output from midi_importFull) into the
//   live timeline as one Pattern track per output track. Atomic + undoable
//   via ImportMidiCommand. Triggers waveform mipmap generation for each
//   newly-loaded sample slot after dispatch.
void Midi_ExecuteImport(const Napi::CallbackInfo& info)
{
    Napi::Env env = info.Env();

    if (!isInitialised() || !g_timeline || !g_undoManager || !audioEngine || !sampleBank) {
        Napi::Error::New(env, "Engine not initialised.").ThrowAsJavaScriptException();
        return;
    }

    if (info.Length() < 2 || !info[1].IsString()) {
        Napi::TypeError::New(env,
            "midi_executeImport(noteData: ArrayBuffer|Buffer|Uint8Array, optionsJson: string)")
            .ThrowAsJavaScriptException();
        return;
    }

    // Accept ArrayBuffer (renderer path) or Buffer/Uint8Array (worker IPC path).
    const uint8_t* noteBytes  = nullptr;
    size_t         noteLength = 0;
    if (info[0].IsArrayBuffer()) {
        Napi::ArrayBuffer ab = info[0].As<Napi::ArrayBuffer>();
        noteBytes  = static_cast<const uint8_t*>(ab.Data());
        noteLength = ab.ByteLength();
    } else if (info[0].IsBuffer()) {
        Napi::Buffer<uint8_t> b = info[0].As<Napi::Buffer<uint8_t>>();
        noteBytes  = b.Data();
        noteLength = b.Length();
    } else if (info[0].IsTypedArray()) {
        Napi::TypedArray ta = info[0].As<Napi::TypedArray>();
        Napi::ArrayBuffer ab = ta.ArrayBuffer();
        noteBytes  = static_cast<const uint8_t*>(ab.Data()) + ta.ByteOffset();
        noteLength = ta.ByteLength();
    } else {
        Napi::TypeError::New(env,
            "midi_executeImport: noteData must be ArrayBuffer, Buffer, or TypedArray")
            .ThrowAsJavaScriptException();
        return;
    }

    if ((noteLength % 12u) != 0u) {
        Napi::TypeError::New(env,
            "midi_executeImport: noteData length must be a multiple of 12")
            .ThrowAsJavaScriptException();
        return;
    }

    BridgeCallLog log("midi.executeImport");

    const std::string optionsJson = info[1].As<Napi::String>().Utf8Value();

    ImportMidiCommandOptions opts;

    try {
        const auto parsed = nlohmann::json::parse(optionsJson);

        opts.tempoOverride = parsed.value("tempoOverride", false);
        opts.sourceBPM     = parsed.value("sourceBPM",    0.0);
        opts.projectTPQ    = parsed.value("projectTPQ",   960);
        opts.sourcePath    = parsed.value("sourcePath",   std::string{});

        const auto& outputTracksJson = parsed.at("outputTracks");
        if (!outputTracksJson.is_array()) {
            Napi::TypeError::New(env, "midi_executeImport: outputTracks must be an array")
                .ThrowAsJavaScriptException();
            return;
        }

        opts.outputTracks.reserve(outputTracksJson.size());
        for (const auto& entry : outputTracksJson) {
            ImportMidiCommandOptions::OutputTrackSpec spec;
            spec.outputTrackIndex = entry.value("outputTrackIndex", 0);
            spec.name             = entry.value("name",            std::string{});
            spec.visualOnly       = entry.value("visualOnly",      false);
            spec.regionId         = entry.value("regionId",        -1);
            opts.outputTracks.push_back(std::move(spec));
        }
    } catch (const std::exception& e) {
        Napi::TypeError::New(env,
            std::string{"midi_executeImport: invalid options JSON: "} + e.what())
            .ThrowAsJavaScriptException();
        return;
    }

    // Unpack 12-byte PackedNote records, group by outputTrackIndex.
    // Build a lookup outputTrackIndex → spec slot.
    std::unordered_map<int, size_t> indexToSpecSlot;
    indexToSpecSlot.reserve(opts.outputTracks.size());
    for (size_t i = 0; i < opts.outputTracks.size(); ++i) {
        indexToSpecSlot[opts.outputTracks[i].outputTrackIndex] = i;
    }

    auto readU32LE = [](const uint8_t* p) -> uint32_t {
        return  static_cast<uint32_t>(p[0])
             | (static_cast<uint32_t>(p[1]) << 8)
             | (static_cast<uint32_t>(p[2]) << 16)
             | (static_cast<uint32_t>(p[3]) << 24);
    };

    const size_t noteCount = noteLength / 12u;
    for (size_t i = 0; i < noteCount; ++i) {
        const uint8_t* rec = noteBytes + i * 12u;
        const uint32_t tick     = readU32LE(rec + 0);
        const uint32_t duration = readU32LE(rec + 4);
        const uint8_t  noteNum  = rec[8];
        const uint8_t  velocity = rec[9];
        const uint8_t  trackIdx = rec[10];
        // rec[11] = flags (drum-channel marker) — unused at commit time.

        const auto it = indexToSpecSlot.find(static_cast<int>(trackIdx));
        if (it == indexToSpecSlot.end()) continue;

        PatternNote pn;
        pn.position = TickTime{ static_cast<int64_t>(tick) };
        pn.duration = TickTime{ static_cast<int64_t>(duration) };
        pn.pitch    = static_cast<int>(noteNum);
        pn.velocity = static_cast<float>(velocity) / 127.0f;
        opts.outputTracks[it->second].notes.push_back(pn);
    }

#ifdef XLETH_DEBUG
    std::fprintf(stderr,
                 "[MidiImport] Midi_ExecuteImport notes=%zu outputTracks=%zu tempoOverride=%d\n",
                 noteCount, opts.outputTracks.size(), opts.tempoOverride ? 1 : 0);
    std::fflush(stderr);
#endif

    const double engineRate = audioEngine->getSampleRate();
    auto& mixEngine = audioEngine->getMixEngine();

    // Hold a non-owning pointer so we can read created-slot info after dispatch.
    auto cmd = std::make_unique<ImportMidiCommand>(
        std::move(opts), mixEngine, *sampleBank, engineRate);
    ImportMidiCommand* cmdPtr = cmd.get();

    {
        std::lock_guard<std::mutex> lock(syncEventsMutex);
        g_undoManager->execute(std::move(cmd), *g_timeline);
    }

    // Post-pass: trigger waveform mipmap generation for each newly-loaded
    // sample slot. cmdPtr is still valid — UndoManager owns the command on
    // its undo stack and we just pushed it (no possibility of pop).
    for (const auto& slot : cmdPtr->getCreatedSampleSlots()) {
        triggerMipmapGeneration(slot.sampleBankId, slot.filePath, /*saveXlpeak*/false);
    }

    log.done(std::to_string(cmdPtr->getCreatedSampleSlots().size()) + " slots");
}

// ─────────────────────────────────────────────────────────────────────────────
// Module initialisation
// ─────────────────────────────────────────────────────────────────────────────

Napi::Object Init(Napi::Env env, Napi::Object exports)
{
    // ── Phase 0 (backward-compatible) ───────────────────────────────────────
    exports.Set("initialize",         Napi::Function::New(env, Initialize));
    exports.Set("shutdown",           Napi::Function::New(env, Shutdown));
    exports.Set("loadSample",         Napi::Function::New(env, LoadSample));
    exports.Set("triggerSample",      Napi::Function::New(env, TriggerSample));
    exports.Set("loadVideo",          Napi::Function::New(env, LoadVideo));
    exports.Set("getVideoDuration",   Napi::Function::New(env, GetVideoDuration));
    exports.Set("play",               Napi::Function::New(env, Play));
    exports.Set("stop",               Napi::Function::New(env, Stop));
    exports.Set("pause",              Napi::Function::New(env, Pause));
    exports.Set("setBPM",             Napi::Function::New(env, SetBPM));
    exports.Set("getTransportState",  Napi::Function::New(env, GetTransportState));
    exports.Set("getCurrentFrame",    Napi::Function::New(env, GetCurrentFrame));
    exports.Set("getFrameBuffer",     Napi::Function::New(env, GetFrameBuffer));
    exports.Set("initFrameOutput",    Napi::Function::New(env, InitFrameOutput));
    exports.Set("initVideoSharedMemory", Napi::Function::New(env, InitVideoSharedMemory));
    exports.Set("getFrameRGBA",       Napi::Function::New(env, GetCurrentFrameRGBA));
    exports.Set("setVideoResolution", Napi::Function::New(env, SetVideoResolution));
    exports.Set("addAudioEvent",      Napi::Function::New(env, AddAudioEvent));
    exports.Set("addVideoEvent",      Napi::Function::New(env, AddVideoEvent));
    exports.Set("clearTimeline",      Napi::Function::New(env, ClearTimeline));
    exports.Set("getSyncStats",       Napi::Function::New(env, GetSyncStats));

    // ── Phase 1 — Project ────────────────────────────────────────────────────
    exports.Set("project_create",          Napi::Function::New(env, Project_Create));
    exports.Set("project_save",            Napi::Function::New(env, Project_Save));
    exports.Set("project_saveAs",          Napi::Function::New(env, Project_SaveAs));
    exports.Set("project_hasProjectDir",   Napi::Function::New(env, Project_HasProjectDir));
    exports.Set("project_load",            Napi::Function::New(env, Project_Load));
    exports.Set("project_importSource",    Napi::Function::New(env, Project_ImportSource));
    exports.Set("project_validateMedia",   Napi::Function::New(env, Project_ValidateMedia));
    exports.Set("project_getInfo",         Napi::Function::New(env, Project_GetInfo));
    exports.Set("project_isDirty",         Napi::Function::New(env, Project_IsDirty));
    exports.Set("project_newBlank",        Napi::Function::New(env, Project_NewBlank));
    exports.Set("project_isExportRunning", Napi::Function::New(env, Project_IsExportRunning));

    // ── Phase 1 — Timeline queries ───────────────────────────────────────────
    exports.Set("timeline_getBPM",           Napi::Function::New(env, Timeline_GetBPM));
    exports.Set("timeline_getTempoLocked",   Napi::Function::New(env, Timeline_GetTempoLocked));
    exports.Set("timeline_getDeclickMs",     Napi::Function::New(env, Timeline_GetDeclickMs));
    exports.Set("timeline_getSources",       Napi::Function::New(env, Timeline_GetSources));
    exports.Set("timeline_getRegions",       Napi::Function::New(env, Timeline_GetRegions));
    exports.Set("timeline_getRegionsByLabel",Napi::Function::New(env, Timeline_GetRegionsByLabel));
    exports.Set("timeline_getTracks",        Napi::Function::New(env, Timeline_GetTracks));
    exports.Set("timeline_getClips",         Napi::Function::New(env, Timeline_GetClips));
    exports.Set("timeline_getClipsOnTrack",  Napi::Function::New(env, Timeline_GetClipsOnTrack));
    exports.Set("timeline_getClipsInRange",  Napi::Function::New(env, Timeline_GetClipsInRange));

    // ── Phase 1 — Timeline mutations (via UndoManager) ───────────────────────
    exports.Set("timeline_setBPM",         Napi::Function::New(env, Timeline_SetBPM));
    exports.Set("timeline_setTempoLocked", Napi::Function::New(env, Timeline_SetTempoLocked));
    exports.Set("timeline_setDeclickMs",   Napi::Function::New(env, Timeline_SetDeclickMs));
    exports.Set("timeline_addTrack",     Napi::Function::New(env, Timeline_AddTrack));
    exports.Set("timeline_removeTrack",  Napi::Function::New(env, Timeline_RemoveTrack));
    exports.Set("timeline_setTrackMuted",      Napi::Function::New(env, Timeline_SetTrackMuted));
    exports.Set("timeline_setTrackVisualOnly", Napi::Function::New(env, Timeline_SetTrackVisualOnly));
    exports.Set("timeline_setTrackSolo",       Napi::Function::New(env, Timeline_SetTrackSolo));
    exports.Set("timeline_setTrackName", Napi::Function::New(env, Timeline_SetTrackName));
    exports.Set("timeline_setPatternName",   Napi::Function::New(env, Timeline_SetPatternName));
    exports.Set("timeline_setPatternRegion", Napi::Function::New(env, Timeline_SetPatternRegion));
    exports.Set("timeline_addClip",          Napi::Function::New(env, Timeline_AddClip));
    exports.Set("timeline_removeClip",       Napi::Function::New(env, Timeline_RemoveClip));
    exports.Set("timeline_setClipParams",    Napi::Function::New(env, Timeline_SetClipParams));
    exports.Set("timeline_moveClip",         Napi::Function::New(env, Timeline_MoveClip));
    exports.Set("timeline_resizeClip",       Napi::Function::New(env, Timeline_ResizeClip));
    exports.Set("timeline_resizeClipLeft",   Napi::Function::New(env, Timeline_ResizeClipLeft));
    exports.Set("timeline_stretchClip",      Napi::Function::New(env, Timeline_StretchClip));
    exports.Set("timeline_stretchClipLeft",  Napi::Function::New(env, Timeline_StretchClipLeft));
    exports.Set("timeline_pitchShiftClip",   Napi::Function::New(env, Timeline_PitchShiftClip));
    exports.Set("timeline_reverseClip",             Napi::Function::New(env, Timeline_ReverseClip));
    exports.Set("timeline_autoTrimClip",            Napi::Function::New(env, Timeline_AutoTrimClip));
    exports.Set("timeline_spliceClipsAtPlayhead",   Napi::Function::New(env, Timeline_SpliceClipsAtPlayhead));
    exports.Set("timeline_addRegion",    Napi::Function::New(env, Timeline_AddRegion));
    exports.Set("timeline_modifyRegion", Napi::Function::New(env, Timeline_ModifyRegion));
    exports.Set("timeline_setSyllables", Napi::Function::New(env, Timeline_SetSyllables));
    exports.Set("timeline_getSyllables", Napi::Function::New(env, Timeline_GetSyllables));
    exports.Set("timeline_removeRegion", Napi::Function::New(env, Timeline_RemoveRegion));

    // ── Grid Layout ──────────────────────────────────────────────────────────
    exports.Set("timeline_getGridLayout",       Napi::Function::New(env, Timeline_GetGridLayout));
    exports.Set("timeline_setGridLayout",       Napi::Function::New(env, Timeline_SetGridLayout));
    exports.Set("timeline_assignTrackToGrid",            Napi::Function::New(env, Timeline_AssignTrackToGrid));
    exports.Set("timeline_assignTrackToGridWithZOrder",  Napi::Function::New(env, Timeline_AssignTrackToGridWithZOrder));
    exports.Set("timeline_removeTrackFromGrid",          Napi::Function::New(env, Timeline_RemoveTrackFromGrid));
    exports.Set("timeline_setChorusTrack",      Napi::Function::New(env, Timeline_SetChorusTrack));
    exports.Set("timeline_setCrashOverlay",     Napi::Function::New(env, Timeline_SetCrashOverlay));
    exports.Set("timeline_setPreviewFps",       Napi::Function::New(env, Timeline_SetPreviewFps));

    // ── Patterns / PatternBlocks / Notes ─────────────────────────────────────
    exports.Set("timeline_addPattern",             Napi::Function::New(env, Timeline_AddPattern));
    exports.Set("timeline_getPattern",             Napi::Function::New(env, Timeline_GetPattern));
    exports.Set("timeline_getAllPatterns",         Napi::Function::New(env, Timeline_GetAllPatterns));
    exports.Set("timeline_removePattern",          Napi::Function::New(env, Timeline_RemovePattern));
    exports.Set("timeline_updateSamplerSettings",  Napi::Function::New(env, Timeline_UpdateSamplerSettings));
    exports.Set("timeline_getPatternAudioInfo",    Napi::Function::New(env, Timeline_GetPatternAudioInfo));
    exports.Set("timeline_getRegionAudioInfo",      Napi::Function::New(env, Timeline_GetRegionAudioInfo));
    // Pipeline B (timeline_getRegionWaveformPeaks) retired — replaced by waveform_getRegionPeaks
    exports.Set("timeline_addPatternBlock",        Napi::Function::New(env, Timeline_AddPatternBlock));
    exports.Set("timeline_getPatternBlocks",       Napi::Function::New(env, Timeline_GetPatternBlocks));
    exports.Set("timeline_removePatternBlock",     Napi::Function::New(env, Timeline_RemovePatternBlock));
    exports.Set("timeline_movePatternBlock",       Napi::Function::New(env, Timeline_MovePatternBlock));
    exports.Set("timeline_resizePatternBlock",     Napi::Function::New(env, Timeline_ResizePatternBlock));
    exports.Set("timeline_resizePatternBlockLeft", Napi::Function::New(env, Timeline_ResizePatternBlockLeft));
    exports.Set("timeline_setPatternBlockLoop",    Napi::Function::New(env, Timeline_SetPatternBlockLoop));
    exports.Set("timeline_addNote",                Napi::Function::New(env, Timeline_AddNote));
    exports.Set("timeline_removeNote",             Napi::Function::New(env, Timeline_RemoveNote));
    exports.Set("timeline_moveNote",               Napi::Function::New(env, Timeline_MoveNote));
    exports.Set("timeline_moveNotesBatch",         Napi::Function::New(env, Timeline_MoveNotesBatch));
    exports.Set("timeline_quantizeClipsBatch",     Napi::Function::New(env, Timeline_QuantizeClipsBatch));
    exports.Set("timeline_resizeNotesBatch",        Napi::Function::New(env, Timeline_ResizeNotesBatch));
    exports.Set("timeline_resizeNote",             Napi::Function::New(env, Timeline_ResizeNote));
    exports.Set("timeline_setNoteVelocity",        Napi::Function::New(env, Timeline_SetNoteVelocity));
    exports.Set("timeline_previewNote",            Napi::Function::New(env, Timeline_PreviewNote));
    exports.Set("timeline_previewNoteOff",         Napi::Function::New(env, Timeline_PreviewNoteOff));
    exports.Set("timeline_previewAllNotesOff",     Napi::Function::New(env, Timeline_PreviewAllNotesOff));
    exports.Set("timeline_convertToPatternTrack",  Napi::Function::New(env, Timeline_ConvertToPatternTrack));
    exports.Set("timeline_convertToClipTrack",     Napi::Function::New(env, Timeline_ConvertToClipTrack));
    exports.Set("timeline_setVideoFlipConfig", Napi::Function::New(env, Timeline_SetVideoFlipConfig));
    exports.Set("timeline_setVideoHoldLastFrame",     Napi::Function::New(env, Timeline_SetVideoHoldLastFrame));
    exports.Set("timeline_setTrackCornerRadius",      Napi::Function::New(env, Timeline_SetTrackCornerRadius));
    exports.Set("timeline_setTrackGapScaleOverride",  Napi::Function::New(env, Timeline_SetTrackGapScaleOverride));
    exports.Set("timeline_setTrackSubdivisionFactor", Napi::Function::New(env, Timeline_SetTrackSubdivisionFactor));
    exports.Set("timeline_setTrackBounceSettings",       Napi::Function::New(env, Timeline_SetTrackBounceSettings));
    exports.Set("timeline_setTrackZoomPanRotSettings",   Napi::Function::New(env, Timeline_SetTrackZoomPanRotSettings));
    exports.Set("timeline_setTrackPingPongSettings",     Napi::Function::New(env, Timeline_SetTrackPingPongSettings));
    exports.Set("timeline_setTrackSlideNoteEffect",      Napi::Function::New(env, Timeline_SetTrackSlideNoteEffect));
    exports.Set("timeline_setNoteSlide",                 Napi::Function::New(env, Timeline_SetNoteSlide));
    exports.Set("timeline_getPreviewResolutionScale", Napi::Function::New(env, Timeline_GetPreviewResolutionScale));
    exports.Set("timeline_setPreviewResolutionScale", Napi::Function::New(env, Timeline_SetPreviewResolutionScale));
    exports.Set("timeline_getPreviewEffectsBypass",   Napi::Function::New(env, Timeline_GetPreviewEffectsBypass));
    exports.Set("timeline_setPreviewEffectsBypass",   Napi::Function::New(env, Timeline_SetPreviewEffectsBypass));
    exports.Set("timeline_addVisualEffect",           Napi::Function::New(env, Timeline_AddVisualEffect));
    exports.Set("timeline_removeVisualEffect",        Napi::Function::New(env, Timeline_RemoveVisualEffect));
    exports.Set("timeline_reorderVisualEffect",                Napi::Function::New(env, Timeline_ReorderVisualEffect));
    exports.Set("timeline_setTrackVisualEffectChainOrder",     Napi::Function::New(env, Timeline_SetTrackVisualEffectChainOrder));
    exports.Set("timeline_setVisualEffectParam",               Napi::Function::New(env, Timeline_SetVisualEffectParam));
    exports.Set("timeline_setVisualEffectBypassed",   Napi::Function::New(env, Timeline_SetVisualEffectBypassed));
    exports.Set("timeline_getVisualEffectChain",      Napi::Function::New(env, Timeline_GetVisualEffectChain));

    // ── Phase 7 — Preview visibility ────────────────────────────────────────
    exports.Set("preview_setEnabled", Napi::Function::New(env, Preview_SetEnabled));

    // ── Phase 1 — Undo / Redo ────────────────────────────────────────────────
    exports.Set("undo_undo",               Napi::Function::New(env, Undo_Undo));
    exports.Set("undo_redo",               Napi::Function::New(env, Undo_Redo));
    exports.Set("undo_canUndo",            Napi::Function::New(env, Undo_CanUndo));
    exports.Set("undo_canRedo",            Napi::Function::New(env, Undo_CanRedo));
    exports.Set("undo_getUndoDescription", Napi::Function::New(env, Undo_GetUndoDescription));
    exports.Set("undo_getRedoDescription", Napi::Function::New(env, Undo_GetRedoDescription));

    // ── Phase 1 — Transport extensions ──────────────────────────────────────
    exports.Set("transport_seek",      Napi::Function::New(env, Transport_Seek));
    // transport_getState = getTransportState (same function, aliased)
    exports.Set("transport_getState",  Napi::Function::New(env, GetTransportState));

    // ── WORLD processing indicator ───────────────────────────────────────────
    exports.Set("cache_getWorldActiveJobs", Napi::Function::New(env, Cache_GetWorldActiveJobIds));

    // ── Global clip-processing defaults ─────────────────────────────────────
    exports.Set("engine_setGlobalStretchMethod",   Napi::Function::New(env, Engine_SetGlobalStretchMethod));
    exports.Set("engine_getGlobalStretchMethod",   Napi::Function::New(env, Engine_GetGlobalStretchMethod));
    exports.Set("engine_setGlobalFormantPreserve", Napi::Function::New(env, Engine_SetGlobalFormantPreserve));
    exports.Set("engine_getGlobalFormantPreserve", Napi::Function::New(env, Engine_GetGlobalFormantPreserve));

    // ── Phase 1 — Audio / MixEngine ─────────────────────────────────────────
    exports.Set("audio_mapRegionToSample",  Napi::Function::New(env, Audio_MapRegionToSample));
    exports.Set("audio_loadSourceRegion",   Napi::Function::New(env, Audio_LoadSourceRegion));
    exports.Set("audio_getOutputDevices",       Napi::Function::New(env, Audio_GetOutputDevices));
    exports.Set("audio_getCurrentOutputDevice", Napi::Function::New(env, Audio_GetCurrentOutputDevice));
    exports.Set("audio_setOutputDevice",        Napi::Function::New(env, Audio_SetOutputDevice));
    exports.Set("audio_getMasterPeak",      Napi::Function::New(env, Audio_GetMasterPeak));
    exports.Set("audio_getTrackPeak",      Napi::Function::New(env, Audio_GetTrackPeak));
    exports.Set("audio_getAllPeaks",       Napi::Function::New(env, Audio_GetAllPeaks));
    exports.Set("audio_setTrackVolume",    Napi::Function::New(env, Audio_SetTrackVolume));
    exports.Set("audio_setTrackPan",       Napi::Function::New(env, Audio_SetTrackPan));
    exports.Set("audio_setTrackSpread",    Napi::Function::New(env, Audio_SetTrackSpread));
    exports.Set("audio_setMasterVolume",   Napi::Function::New(env, Audio_SetMasterVolume));
    exports.Set("audio_exportStart",       Napi::Function::New(env, Audio_ExportStart));
    exports.Set("audio_exportGetProgress", Napi::Function::New(env, Audio_ExportGetProgress));
    exports.Set("audio_exportCancel",      Napi::Function::New(env, Audio_ExportCancel));
    exports.Set("video_exportStart",            Napi::Function::New(env, Video_ExportStart));
    exports.Set("video_exportGetProgress",      Napi::Function::New(env, Video_ExportGetProgress));
    exports.Set("video_exportCancel",           Napi::Function::New(env, Video_ExportCancel));
    exports.Set("video_computeDurationSeconds", Napi::Function::New(env, Video_ComputeDurationSeconds));
    exports.Set("audio_exportRegion",       Napi::Function::New(env, Audio_ExportRegion));
    exports.Set("audio_swapRegionAudio",    Napi::Function::New(env, Audio_SwapRegionAudio));
    exports.Set("audio_loadRegionAudio",    Napi::Function::New(env, Audio_LoadRegionAudio));
    exports.Set("audio_probeAudioDuration", Napi::Function::New(env, Audio_ProbeAudioDuration));
    exports.Set("audio_revertRegionAudio", Napi::Function::New(env, Audio_RevertRegionAudio));

    // ── P3 — Effect chain ───────────────────────────────────────────────────
    exports.Set("audio_addEffect",            Napi::Function::New(env, Audio_AddEffect));
    exports.Set("audio_removeEffect",         Napi::Function::New(env, Audio_RemoveEffect));
    exports.Set("audio_moveEffect",           Napi::Function::New(env, Audio_MoveEffect));
    exports.Set("audio_setEffectBypass",      Napi::Function::New(env, Audio_SetEffectBypass));
    exports.Set("audio_getEffectChain",       Napi::Function::New(env, Audio_GetEffectChain));
    exports.Set("audio_getEffectParameters",  Napi::Function::New(env, Audio_GetEffectParameters));
    exports.Set("audio_setEffectParameter",   Napi::Function::New(env, Audio_SetEffectParameter));
    exports.Set("audio_getEffectMeter",       Napi::Function::New(env, Audio_GetEffectMeter));
    exports.Set("audio_setEffectVisualizationEnabled",
                Napi::Function::New(env, Audio_SetEffectVisualizationEnabled));
    exports.Set("audio_drainEffectVizFrames",
                Napi::Function::New(env, Audio_DrainEffectVizFrames));
    exports.Set("audio_addMasterEffect",      Napi::Function::New(env, Audio_AddMasterEffect));
    exports.Set("audio_removeMasterEffect",   Napi::Function::New(env, Audio_RemoveMasterEffect));
    exports.Set("audio_moveMasterEffect",     Napi::Function::New(env, Audio_MoveMasterEffect));
    exports.Set("audio_setMasterEffectBypass", Napi::Function::New(env, Audio_SetMasterEffectBypass));
    exports.Set("audio_getMasterEffectChain", Napi::Function::New(env, Audio_GetMasterEffectChain));

    // ── EQ-specific ────────────────────────────────────────────────────────
    exports.Set("audio_eqAddBand",          Napi::Function::New(env, Audio_EQ_AddBand));
    exports.Set("audio_eqRemoveBand",       Napi::Function::New(env, Audio_EQ_RemoveBand));
    exports.Set("audio_eqSetBandParam",     Napi::Function::New(env, Audio_EQ_SetBandParam));
    exports.Set("audio_eqGetResponseCurve", Napi::Function::New(env, Audio_EQ_GetResponseCurve));
    exports.Set("audio_eqGetSpectrumData",  Napi::Function::New(env, Audio_EQ_GetSpectrumData));
    exports.Set("audio_eqSetPreSpectrum",   Napi::Function::New(env, Audio_EQ_SetPreSpectrum));
    exports.Set("audio_eqGetBands",         Napi::Function::New(env, Audio_EQ_GetBands));
    exports.Set("audio_eqGetBandGR",        Napi::Function::New(env, Audio_EQ_GetBandGR));
    exports.Set("audio_eqSetGlobalParam",   Napi::Function::New(env, Audio_EQ_SetGlobalParam));
    exports.Set("audio_eqGetGlobalParams",  Napi::Function::New(env, Audio_EQ_GetGlobalParams));
    exports.Set("audio_eqGetSampleRate",   Napi::Function::New(env, Audio_EQ_GetSampleRate));

    // ── Waveshaper-specific ────────────────────────────────────────────────
    exports.Set("audio_wsGetCurvePoints", Napi::Function::New(env, Audio_WS_GetCurvePoints));
    exports.Set("audio_wsSetCurvePoints", Napi::Function::New(env, Audio_WS_SetCurvePoints));
    exports.Set("audio_wsSetPreset",      Napi::Function::New(env, Audio_WS_SetPreset));

    // ── SmartBalance-specific ──────────────────────────────────────────────
    exports.Set("audio_smartBalanceGetDebug", Napi::Function::New(env, Audio_SmartBalance_GetDebug));

    // ── Graph-mode routing ──────────────────────────────────────────────────
    exports.Set("audio_addConnection",           Napi::Function::New(env, Audio_AddConnection));
    exports.Set("audio_removeConnection",        Napi::Function::New(env, Audio_RemoveConnection));
    exports.Set("audio_setWireGain",             Napi::Function::New(env, Audio_SetWireGain));
    exports.Set("audio_setWireMute",             Napi::Function::New(env, Audio_SetWireMute));
    exports.Set("audio_getGraphTopology",        Napi::Function::New(env, Audio_GetGraphTopology));
    exports.Set("audio_setNodePosition",         Napi::Function::New(env, Audio_SetNodePosition));
    exports.Set("audio_isGraphLinear",           Napi::Function::New(env, Audio_IsGraphLinear));
    exports.Set("audio_addMasterConnection",     Napi::Function::New(env, Audio_AddMasterConnection));
    exports.Set("audio_removeMasterConnection",  Napi::Function::New(env, Audio_RemoveMasterConnection));
    exports.Set("audio_setMasterWireGain",       Napi::Function::New(env, Audio_SetMasterWireGain));
    exports.Set("audio_setMasterWireMute",       Napi::Function::New(env, Audio_SetMasterWireMute));
    exports.Set("audio_getMasterGraphTopology",  Napi::Function::New(env, Audio_GetMasterGraphTopology));
    exports.Set("audio_setMasterNodePosition",   Napi::Function::New(env, Audio_SetMasterNodePosition));
    exports.Set("audio_isMasterGraphLinear",     Napi::Function::New(env, Audio_IsMasterGraphLinear));

    // ── VST3 plugin scanner ─────────────────────────────────────────────────
    exports.Set("audio_scanPlugins",      Napi::Function::New(env, Audio_ScanPlugins));
    exports.Set("audio_getScanProgress",  Napi::Function::New(env, Audio_GetScanProgress));
    exports.Set("audio_getScannedPlugins", Napi::Function::New(env, Audio_GetScannedPlugins));
    exports.Set("audio_getFailedPlugins", Napi::Function::New(env, Audio_GetFailedPlugins));

    // ── VST3 plugin editor windows ──────────────────────────────────────────
    exports.Set("audio_openPluginEditor",    Napi::Function::New(env, Audio_OpenPluginEditor));
    exports.Set("audio_closePluginEditor",   Napi::Function::New(env, Audio_ClosePluginEditor));
    exports.Set("audio_closeAllPluginEditors", Napi::Function::New(env, Audio_CloseAllPluginEditors));
    exports.Set("audio_isPluginEditorOpen",  Napi::Function::New(env, Audio_IsPluginEditorOpen));

    // ── Missing-plugin helpers ──────────────────────────────────────────────
    exports.Set("audio_getMissingPlugins",   Napi::Function::New(env, Audio_GetMissingPlugins));
    exports.Set("audio_retryMissingPlugin",  Napi::Function::New(env, Audio_RetryMissingPlugin));
    exports.Set("audio_removeAllMissing",    Napi::Function::New(env, Audio_RemoveAllMissing));

    // ── VST3 crash recovery ─────────────────────────────────────────────────
    exports.Set("audio_resetCrashedPlugin",  Napi::Function::New(env, Audio_ResetCrashedPlugin));

    // ── Main window handle (for VST editor parenting) ───────────────────────
    exports.Set("audio_setMainWindowHandle", Napi::Function::New(env, Audio_SetMainWindowHandle));

    // ── Phase 1 — Sync ───────────────────────────────────────────────────────
    // sync_getStats = getSyncStats (aliased)
    exports.Set("sync_getStats", Napi::Function::New(env, GetSyncStats));

    // ── Phase 1B — SourcePlayer (Sample Picker preview) ─────────────────────
    exports.Set("source_loadSource",   Napi::Function::New(env, Source_LoadSource));
    exports.Set("source_playSource",   Napi::Function::New(env, Source_PlaySource));
    exports.Set("source_pauseSource",  Napi::Function::New(env, Source_PauseSource));
    exports.Set("source_resumeSource", Napi::Function::New(env, Source_ResumeSource));
    exports.Set("source_seekSource",   Napi::Function::New(env, Source_SeekSource));
    exports.Set("source_stopSource",   Napi::Function::New(env, Source_StopSource));
    exports.Set("source_getPosition",  Napi::Function::New(env, Source_GetPosition));
    exports.Set("source_isPlaying",    Napi::Function::New(env, Source_IsPlaying));
    exports.Set("source_unloadSource", Napi::Function::New(env, Source_UnloadSource));

    // ── Phase 1B — FrameServer (fast frame extraction) ──────────────────────
    exports.Set("video_openSource",  Napi::Function::New(env, Video_OpenSource));
    exports.Set("video_closeSource", Napi::Function::New(env, Video_CloseSource));
    exports.Set("video_getFrame",    Napi::Function::New(env, Video_GetFrame));

    // ── Waveform mipmap bindings ─────────────────────────────────────────────
    exports.Set("waveform_getRegionPeaks", Napi::Function::New(env, Waveform_GetRegionPeaks));
    exports.Set("waveform_getRawSamples",  Napi::Function::New(env, Waveform_GetRawSamples));
    exports.Set("waveform_getFilePeaks",   Napi::Function::New(env, Waveform_GetFilePeaks));
    exports.Set("waveform_getClipPeaks",   Napi::Function::New(env, Waveform_GetClipPeaks));

    // ── GPU device management ────────────────────────────────────────────────
    exports.Set("gpu_getAvailableGpus", Napi::Function::New(env, Gpu_GetAvailableGpus));
    exports.Set("gpu_setAdapter",       Napi::Function::New(env, Gpu_SetAdapter));

    // ── Diagnostics (Settings → Graphics → Export Visual Preview Log) ───────
    exports.Set("diag_getVisualPreviewDiagnostic",
                Napi::Function::New(env, Diag_GetVisualPreviewDiagnostic));

    // ── Hardware encoder detection ───────────────────────────────────────────
    exports.Set("hwenc_getAvailableEncoders", Napi::Function::New(env, HwEnc_GetAvailableEncoders));
    exports.Set("hwenc_getDefaultEncoder",    Napi::Function::New(env, HwEnc_GetDefaultEncoder));
    exports.Set("hwenc_refresh",              Napi::Function::New(env, HwEnc_Refresh));

    // ── MIDI Import ──────────────────────────────────────────────────────────
    exports.Set("midi_parseSummary",  Napi::Function::New(env, Midi_ParseSummary));
    exports.Set("midi_importFull",    Napi::Function::New(env, Midi_ImportFull));
    exports.Set("midi_executeImport", Napi::Function::New(env, Midi_ExecuteImport));

    return exports;
}

NODE_API_MODULE(xleth_native, Init)
