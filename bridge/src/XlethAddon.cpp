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
#include "Transport.h"
#include "VideoDecoder.h"
#include "video/FrameOutput.h"
#include "video/FrameServer.h"

// Phase 1 — model, commands, project
#include "model/Timeline.h"
#include "model/TimelineTypes.h"
#include "commands/UndoManager.h"
#include "commands/TimelineCommands.h"
#include "project/ProjectManager.h"
#include "export/AudioExporter.h"
#include "audio/WaveformMipmap.h"
#include "audio/XlethEQEffect.h"
#include "audio/XlethWaveshaperEffect.h"
#include "audio/SmartBalanceEffect.h"
#include "render/GpuDeviceManager.h"
#include "render/HwEncoderDetector.h"
#include "render/OfflineRenderer.h"
#include "export/FFmpegMuxer.h"       // ExportSettings

#include "XlethDebug.h"

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
#include <vector>

#include <nlohmann/json.hpp>

extern "C" {
#include <libavformat/avformat.h>
#include <libavutil/avutil.h>
#include <libswscale/swscale.h>
#include <libavutil/pixfmt.h>
}

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

std::unique_ptr<SyncManager> syncManager;

// ── Video thread ──────────────────────────────────────────────────────────
std::thread       videoThread;
std::atomic<bool> videoRunning{false};

// Guards both SyncManager event mutations (main thread) and videoTick() calls
// (video thread) to prevent data races on events_ / driftSamples_ etc.
std::mutex syncEventsMutex;

// ── Frame output (double-buffered, lock-free) ─────────────────────────────
FrameOutput frameOutput;

// ── GPU device (D3D11 — adapter enum + device for decode/composite) ──────
std::unique_ptr<GpuDeviceManager> g_gpuDevice;

// ── Hardware encoder detection (NVENC/AMF/QSV probing) ──────────────────
std::unique_ptr<HwEncoderDetector> g_hwEncoderDetector;

// ── CPU YUV420P → RGBA conversion + compositing ─────────────────────────

// Output canvas size (fixed)
constexpr int CANVAS_W = 960;
constexpr int CANVAS_H = 540;

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
            mix.invalidateClipCache(c->id);
    }
}

// ── Global clip-processing defaults bridge functions ─────────────────────────

// engine_setGlobalStretchMethod(method: number) — 1=PSOLA, 2=Rubber, 3=WSOLA, 4=PhaseVocoder
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

    // If we opened the original, spawn a watchdog that swaps to the proxy
    // as soon as the transcode finishes. Dies naturally at shutdown when
    // g_timeline is nulled.
    if (!useProxy) {
        std::thread([sourceId]() {
            for (int i = 0; i < 600; ++i) { // up to ~5 min
                std::this_thread::sleep_for(std::chrono::milliseconds(500));
                if (!g_timeline) return;
                SourceMedia* s = g_timeline->getSourceMutable(sourceId);
                if (!s || !s->proxyReady || s->proxyPath.empty()) continue;

                auto proxyDec = std::make_unique<VideoDecoder>();
                if (!proxyDec->open(s->proxyPath)) {
                    std::cerr << "[Bridge] Proxy open failed: "
                              << s->proxyPath << "\n" << std::flush;
                    return;
                }

                std::lock_guard<std::mutex> lock(syncEventsMutex);
                if (static_cast<size_t>(sourceId) < decoderPtrs.size()
                    && decoderPtrs[static_cast<size_t>(sourceId)]) {
                    decoderPtrs[static_cast<size_t>(sourceId)]->close();
                }
                if (static_cast<size_t>(sourceId) >= decoderPtrs.size())
                    decoderPtrs.resize(static_cast<size_t>(sourceId) + 1, nullptr);
                decoderPtrs[static_cast<size_t>(sourceId)] = proxyDec.get();
                decoderOwner.push_back(std::move(proxyDec));

                if (frameCache) frameCache->clear();
                std::cout << "[Bridge] Swapped sourceId=" << sourceId
                          << " to proxy: " << s->proxyPath << "\n" << std::flush;
                return;
            }
        }).detach();
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
            ev.sourceStartTime = sourceTime;
            ev.sourceEndTime   = region->endTime;
            ev.layerIndex      = 0;          // Phase 1: all fullscreen, last-iterated wins
            ev.x = 0.0f; ev.y = 0.0f;
            ev.width = 1.0f; ev.height = 1.0f;
            ev.opacity = 1.0f;
            ev.globalNoteIndex = counter++;
            syncManager->addEvent(ev);
            ++added;
        }
        const TrackInfo* tInfo = g_timeline->getTrack(trackId);
        std::cout << "[Bridge] Clip track " << trackId
                  << " (flipMode=" << (tInfo ? videoFlipModeToString(tInfo->videoFlipMode) : "?")
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
                        region->startTime, region->endTime,
                        counter);
                    for (const auto& ve : arpEvts)
                        syncManager->addEvent(ve);
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

                            VideoEvent ev;
                            ev.startBeat       = timelineBeats;
                            ev.durationBeats   = durationBeats;
                            ev.sourceId        = region->sourceId;
                            ev.trackId         = block->trackId;
                            ev.sourceStartTime = region->startTime;
                            ev.sourceEndTime   = region->endTime;
                            ev.layerIndex      = 0;
                            ev.x = 0.0f; ev.y = 0.0f;
                            ev.width = 1.0f; ev.height = 1.0f;
                            ev.opacity         = note->velocity;
                            ev.globalNoteIndex = counter++;
                            syncManager->addEvent(ev);
                            ++notesAdded;
                        }
                    }
                }
            }
        }
    }

    std::cout << "[Bridge] Rebuilt video events: "
              << added << " clip(s), " << notesAdded << " note(s) added; "
              << skipped << "/" << blocksSkipped << " skipped\n" << std::flush;
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
    o.Set("order",             Napi::Number::New(env, t.order));
    o.Set("type",              Napi::String::New(env, trackTypeToString(t.type)));
    o.Set("videoFlipMode",     Napi::String::New(env, videoFlipModeToString(t.videoFlipMode)));
    o.Set("videoHoldLastFrame", Napi::Boolean::New(env, t.videoHoldLastFrame));
    return o;
}

static Napi::Object patternNoteToJs(Napi::Env env, const PatternNote& n) {
    Napi::Object o = Napi::Object::New(env);
    o.Set("id",            Napi::Number::New(env, n.id));
    o.Set("positionTicks", Napi::Number::New(env, static_cast<double>(n.position.ticks)));
    o.Set("durationTicks", Napi::Number::New(env, static_cast<double>(n.duration.ticks)));
    o.Set("pitch",         Napi::Number::New(env, n.pitch));
    o.Set("velocity",      Napi::Number::New(env, n.velocity));
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
    o.Set("declickSamples",   Napi::Number::New(env, r.declickSamples));
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

    // Wire MixEngine to Timeline (safe before playback starts)
    audioEngine->getMixEngine().setTimeline(g_timeline.get());

    // Sync transport BPM from timeline default
    audioEngine->getTransport().setBPM(g_timeline->getBPM());

    // Sync clip boundary fade from timeline default
    syncClipFadeToMixEngine();

    // 8. Video thread (preview FPS is user-controlled via GridLayout.previewFps)
    videoRunning = true;
    videoThread = std::thread([] {
        bool blackWritten = false;           // only swap to black once per stop transition
        std::vector<uint8_t> canvasScratch;  // reused per-tick RGBA compositing buffer

        while (videoRunning) {
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
                double beatPos = tickBeatPos;
                double bpm     = t.getBPM();

                const int canvasW = frameOutput.getWidth();
                const int canvasH = frameOutput.getHeight();

                if (isPlaying && !events.empty() && !decoderPtrs.empty()) {
                    // Snapshot the grid layout under the mutex we already hold.
                    const GridLayout layout = g_timeline
                        ? g_timeline->getGridLayout() : GridLayout{};

                    uint8_t* canvas = frameOutput.getBackBuffer();
                    if (canvas) {
                        const size_t bufSize = static_cast<size_t>(frameOutput.getBufferSize());
                        if (canvasScratch.size() != bufSize) canvasScratch.resize(bufSize);
                        std::memset(canvasScratch.data(), 0, bufSize); // black background

                        // a) CHORUS LAYER — fullscreen, behind grid.
                        if (layout.chorusTrackId >= 0) {
                            if (auto* ev = findActiveEventOnTrack(events, layout.chorusTrackId, beatPos)) {
                                if (auto* cf = getCachedFrameForEvent(*ev, beatPos, bpm)) {
                                    bool cFlipX = false, cFlipY = false;
                                    if (const TrackInfo* ct = g_timeline->getTrack(layout.chorusTrackId)) {
                                        const int cidx = ev->globalNoteIndex;
                                        switch (ct->videoFlipMode) {
                                            case VideoFlipMode::None: break;
                                            case VideoFlipMode::HorizontalEven:
                                                cFlipX = (cidx % 2) == 1;
                                                break;
                                            case VideoFlipMode::Clockwise:
                                                switch (((cidx % 4) + 4) % 4) {
                                                    case 1: cFlipY = true; break;
                                                    case 2: cFlipX = true; cFlipY = true; break;
                                                    case 3: cFlipX = true; break;
                                                }
                                                break;
                                            case VideoFlipMode::CounterClockwise:
                                                switch (((cidx % 4) + 4) % 4) {
                                                    case 1: cFlipX = true; break;
                                                    case 2: cFlipX = true; cFlipY = true; break;
                                                    case 3: cFlipY = true; break;
                                                }
                                                break;
                                        }
                                        // Diagnostic: chorus layer flip (throttled)
                                        if (ct->videoFlipMode != VideoFlipMode::None) {
                                            static int lastChorusIdx = -1;
                                            if (cidx != lastChorusIdx) {
                                                std::cout << "[Video] Chorus track " << layout.chorusTrackId
                                                          << " flip: mode=" << videoFlipModeToString(ct->videoFlipMode)
                                                          << " idx=" << cidx
                                                          << " flipX=" << cFlipX
                                                          << " flipY=" << cFlipY << "\n";
                                                lastChorusIdx = cidx;
                                            }
                                        }
                                    }
                                    blitYuvToCanvas(canvasScratch, *cf,
                                                    0, 0, canvasW, canvasH, canvasW,
                                                    1.0f, cFlipX, cFlipY);
                                    // Save chorus frame for hold-through-gap
                                    if (ev->sourceId >= 0 &&
                                        static_cast<size_t>(ev->sourceId) < decoderPtrs.size()) {
                                        VideoDecoder* dec = decoderPtrs[static_cast<size_t>(ev->sourceId)];
                                        if (dec && dec->isOpen()) {
                                            const double bs = beatPos - ev->startBeat;
                                            const double ss = bs * (60.0 / bpm);
                                            const double st = ev->sourceStartTime + ss;
                                            syncManager->previewLastChorusFrame = dec->timeToFrame(st);
                                            syncManager->previewLastChorusSourceId = ev->sourceId;
                                        }
                                    }
                                }
                            } else {
                                // Chorus gap — hold last frame if videoHoldLastFrame is enabled
                                if (g_timeline && syncManager->previewLastChorusFrame >= 0
                                    && syncManager->previewLastChorusSourceId >= 0) {
                                    const TrackInfo* ct = g_timeline->getTrack(layout.chorusTrackId);
                                    if (ct && ct->videoHoldLastFrame) {
                                        FrameKey key = { syncManager->previewLastChorusSourceId,
                                                         static_cast<int>(syncManager->previewLastChorusFrame) };
                                        if (const CachedFrame* cf = frameCache ? frameCache->get(key) : nullptr) {
                                            blitYuvToCanvas(canvasScratch, *cf,
                                                            0, 0, canvasW, canvasH, canvasW, 1.0f);
                                        }
                                    }
                                }
                            }
                        }

                        // b) GRID CELLS — sorted by zOrder (stable sort so equal zOrder
                        //    keeps insertion order).
                        std::vector<GridSlot> slots = layout.slots;
                        std::stable_sort(slots.begin(), slots.end(),
                            [](const GridSlot& a, const GridSlot& b){ return a.zOrder < b.zOrder; });

                        const int cols  = std::max(1, layout.columns);
                        const int rows  = std::max(1, layout.rows);
                        const int halfW = canvasW / (cols * 2);
                        const int halfH = canvasH / (rows * 2);

                        for (const GridSlot& slot : slots) {
                            if (slot.trackId < 0) continue;
                            const VideoEvent* ev =
                                findActiveEventOnTrack(events, slot.trackId, beatPos);
                            if (!ev) continue;                 // no active clip → cell invisible

                            // Hold-last-frame: if past the trim end, always clamp
                            // to the last frame so active notes never go black.
                            FrameKey resolvedKey = {};
                            const CachedFrame* cf = nullptr;
                            if (ev->sourceEndTime > 0.0) {
                                const double bs2 = beatPos - ev->startBeat;
                                const double ss2 = bs2 * (60.0 / bpm);
                                const double st2 = ev->sourceStartTime + ss2;
                                if (st2 >= ev->sourceEndTime) {
                                    cf = getCachedFrameAtSourceTime(ev->sourceId,
                                                                    ev->sourceEndTime - 0.001,
                                                                    &resolvedKey);
                                    std::fprintf(stderr, "[Preview] Track %d: frame clamped to last frame\n",
                                                 slot.trackId);
                                }
                            }
                            if (!cf) cf = getCachedFrameForEvent(*ev, beatPos, bpm, &resolvedKey);

                            if (cf) {
                                // Save resolved key for hold-last-frame fallback
                                syncManager->previewLastGridCellKey[slot.trackId] = resolvedKey;
                            } else {
                                // Cache miss — try last-good frame for this track
                                auto it = syncManager->previewLastGridCellKey.find(slot.trackId);
                                if (it != syncManager->previewLastGridCellKey.end() && frameCache) {
                                    cf = frameCache->get(it->second);
                                }
                                if (!cf) continue;
                            }

                            const int dx = slot.gridX * halfW;
                            const int dy = slot.gridY * halfH;
                            const int dw = slot.spanX * halfW;
                            const int dh = slot.spanY * halfH;

                            // Per-note/clip video-flip cycling. Both pattern notes
                            // and clips assign incrementing globalNoteIndex per-track,
                            // so flip modes cycle correctly for all track types.
                            bool flipX = false, flipY = false;
                            if (g_timeline) {
                                if (const TrackInfo* t = g_timeline->getTrack(slot.trackId)) {
                                    const int idx = ev->globalNoteIndex;
                                    switch (t->videoFlipMode) {
                                        case VideoFlipMode::None: break;
                                        case VideoFlipMode::HorizontalEven:
                                            flipX = (idx % 2) == 1;
                                            break;
                                        case VideoFlipMode::Clockwise:
                                            switch (((idx % 4) + 4) % 4) {
                                                case 1: flipY = true; break;
                                                case 2: flipX = true; flipY = true; break;
                                                case 3: flipX = true; break;
                                            }
                                            break;
                                        case VideoFlipMode::CounterClockwise:
                                            switch (((idx % 4) + 4) % 4) {
                                                case 1: flipX = true; break;
                                                case 2: flipX = true; flipY = true; break;
                                                case 3: flipY = true; break;
                                            }
                                            break;
                                    }
                                    // Diagnostic: log flip state when mode is active (throttled)
                                    if (t->videoFlipMode != VideoFlipMode::None) {
                                        static int lastLoggedTrackId = -1;
                                        static int lastLoggedIdx = -1;
                                        if (slot.trackId != lastLoggedTrackId || idx != lastLoggedIdx) {
                                            std::cout << "[Video] Track " << slot.trackId
                                                      << " type=" << (t->type == TrackInfo::Type::Clip ? "Clip" : "Pattern")
                                                      << " flip: mode=" << videoFlipModeToString(t->videoFlipMode)
                                                      << " idx=" << idx
                                                      << " flipX=" << flipX
                                                      << " flipY=" << flipY << "\n";
                                            lastLoggedTrackId = slot.trackId;
                                            lastLoggedIdx = idx;
                                        }
                                    }
                                }
                            }

                            // ev->opacity carries note.velocity for pattern events,
                            // 1.0 for clip events. Clamp to [0,1] since slot.opacity
                            // could be malformed in a loaded project.
                            const float finalOpacity = std::min(1.0f,
                                std::max(0.0f, slot.opacity * ev->opacity));

                            blitYuvToCanvas(canvasScratch, *cf, dx, dy, dw, dh, canvasW,
                                            finalOpacity, flipX, flipY);
                        }

                        // c) CRASH OVERLAY — fullscreen, on top, semi-transparent.
                        if (layout.crashEnabled && layout.crashTrackId >= 0) {
                            if (auto* ev = findActiveEventOnTrack(events, layout.crashTrackId, beatPos)) {
                                if (auto* cf = getCachedFrameForEvent(*ev, beatPos, bpm))
                                    blitYuvToCanvas(canvasScratch, *cf,
                                                    0, 0, canvasW, canvasH, canvasW,
                                                    layout.crashOpacity);
                            }
                        }

                        std::memcpy(canvas, canvasScratch.data(), bufSize);
                        frameOutput.swapBuffers();
                        blackWritten = false;
                    }
                } else if (!isPlaying) {
                    if (!blackWritten) {
                        frameOutput.writeBlackFrame();
                        blackWritten = true;
                    }
                }
            }

            {
                std::lock_guard<std::mutex> lock(statsMutex);
                statsSnapshot.avgDriftMs  = syncManager->getAvgDriftMs();
                statsSnapshot.maxDriftMs  = syncManager->getMaxDriftMs();
                statsSnapshot.frameDrops  = syncManager->getFrameDropCount();
                statsSnapshot.cacheHitRate = frameCache->hitRate();
            }

            // Preview FPS control — reads GridLayout.previewFps without locking
            // (int reads are atomic on x86; worst case we sleep one tick at the
            // old value after a change).
            int previewFps = 30;
            if (g_timeline) {
                int f = g_timeline->getGridLayout().previewFps;
                if (f >= 1 && f <= 120) previewFps = f;
            }
            std::this_thread::sleep_for(std::chrono::microseconds(1000000 / previewFps));
        }
    });

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

    for (auto& [k, sc] : scalerCache) {
        if (sc.ctx) sws_freeContext(sc.ctx);
    }
    scalerCache.clear();

    frameOutput.shutdown();
    syncManager.reset();

    for (auto& d : decoderOwner)
        d->close();
    decoderOwner.clear();
    decoderPtrs.clear();

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

    if (!frameOutput.initSharedMemory(name.c_str(), width, height)) {
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

// Writes all non-empty effect chains to <projectDir>/effects.json.
// Called from both Project_Save and Project_SaveAs.
static void writeEffectsJSON(const std::string& projectDir,
                              MixEngine& mix,
                              const Timeline& timeline)
{
    nlohmann::json effects;
    nlohmann::json trackEffects = nlohmann::json::object();
    for (const auto* t : timeline.getAllTracks()) {
        nlohmann::json chainJson = mix.getEffectChainJSON(t->id);
        if (chainJson.contains("nodes") && !chainJson["nodes"].empty())
            trackEffects[std::to_string(t->id)] = chainJson;
    }
    effects["tracks"] = trackEffects;
    nlohmann::json masterJson = mix.getMasterEffectChainJSON();
    if (masterJson.contains("nodes") && !masterJson["nodes"].empty())
        effects["master"] = masterJson;

    std::string path = (std::filesystem::path(projectDir) / "effects.json").string();
    std::ofstream f(path);
    if (f.is_open()) f << effects.dump(4);
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
    bool ok = g_projectManager->saveProject(*g_timeline);
    if (ok && audioEngine)
        writeEffectsJSON(g_projectManager->getProjectDir(),
                         audioEngine->getMixEngine(), *g_timeline);
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
    bool ok = g_projectManager->saveProjectAs(dir, name, *g_timeline);
    if (ok && audioEngine)
        writeEffectsJSON(g_projectManager->getProjectDir(),
                         audioEngine->getMixEngine(), *g_timeline);
    log.done(ok ? "true" : "false");
    return Napi::Boolean::New(env, ok);
}

Napi::Value Project_HasProjectDir(const Napi::CallbackInfo& info)
{
    Napi::Env env = info.Env();
    if (!g_projectManager) return Napi::Boolean::New(env, false);
    return Napi::Boolean::New(env, g_projectManager->hasProjectDir());
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

    *g_timeline = std::move(*loaded);
    if (g_undoManager) g_undoManager->clear();

    // Re-wire MixEngine and sync transport BPM
    if (audioEngine) {
        auto& mix = audioEngine->getMixEngine();
        mix.setTimeline(g_timeline.get());
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
            for (const SampleRegion* region : g_timeline->getAllRegions()) {
                if (!region) continue;

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
                if (sid >= 0)
                    mix.mapRegionToSample(region->id, sid);
            }
        }

        mix.rebuildAllSamplers();
        refreshAllClipCaches();

        // Restore effect chains from effects.json (absent in old projects — graceful no-op)
        std::string effectsPath = (std::filesystem::path(dir) / "effects.json").string();
        if (std::filesystem::exists(effectsPath)) {
            std::ifstream ef(effectsPath);
            if (ef.is_open()) {
                try {
                    nlohmann::json effects;
                    ef >> effects;
                    if (effects.contains("tracks") && effects["tracks"].is_object()) {
                        for (auto it = effects["tracks"].begin();
                             it != effects["tracks"].end(); ++it)
                            mix.loadEffectChainFromJSON(std::stoi(it.key()), it.value());
                    }
                    if (effects.contains("master"))
                        mix.loadMasterEffectChainFromJSON(effects["master"]);
                } catch (...) {}
            }
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
        if (src && src->hasVideo)
            ensureSourceDecoder(id);
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
    Napi::Env env = info.Env();
    if (!g_timeline) {
        Napi::Error::New(env, "Engine not initialised.").ThrowAsJavaScriptException();
        return env.Undefined();
    }

    auto tracks = g_timeline->getAllTracks();
    Napi::Array arr = Napi::Array::New(env, tracks.size());
    for (size_t i = 0; i < tracks.size(); ++i)
        arr.Set(static_cast<uint32_t>(i), trackToJs(env, *tracks[i]));
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
    log.done(std::to_string(bpm));
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
    // Release every sampler pair this track owned (no-op if it was a clip track).
    if (audioEngine) audioEngine->getMixEngine().unloadSamplersForTrack(id);
    log.done();
}

// timeline_addClip({ trackId, regionId, positionTicks, durationTicks, velocity? }) → id
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
            (sm >= 0 && sm <= 4) ? sm : 0 /*Global*/);
    }
    if (o.Has("formantPreserve") && o.Get("formantPreserve").IsBoolean())
        clip.formantPreserve = o.Get("formantPreserve").As<Napi::Boolean>().Value();

    g_undoManager->execute(std::make_unique<AddClipCommand>(clip), *g_timeline);

    auto clips = g_timeline->getAllClips();
    int newId = clips.empty() ? -1 : clips.back()->id;
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
        audioEngine->getMixEngine().invalidateClipCache(id);
    g_undoManager->execute(std::make_unique<RemoveClipCommand>(id, *g_timeline), *g_timeline);
    log.done();
}

// timeline_setClipParams(clipId: number, params: object) → clipObject
// params: { pitchOffset?, pitchOffsetCents?, reversed?, stretchRatio?,
//           stretchMethod?, formantPreserve? }
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
            (sm >= 0 && sm <= 4) ? sm : 0 /*Global*/);
    }
    if (o.Has("formantPreserve") && o.Get("formantPreserve").IsBoolean())
        p.formantPreserve = o.Get("formantPreserve").As<Napi::Boolean>().Value();

    g_undoManager->execute(
        std::make_unique<SetClipParamsCommand>(clipId, p, *g_timeline),
        *g_timeline);

    if (audioEngine)
        audioEngine->getMixEngine().invalidateClipCache(clipId);

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
    if (audioEngine) audioEngine->getMixEngine().invalidateClipCache(id);
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
    if (audioEngine) audioEngine->getMixEngine().invalidateClipCache(id);
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
    if (audioEngine) audioEngine->getMixEngine().invalidateClipCache(id);
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
    if (audioEngine) audioEngine->getMixEngine().invalidateClipCache(id);
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

    if (audioEngine) audioEngine->getMixEngine().invalidateClipCache(clipId);
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

    if (audioEngine) audioEngine->getMixEngine().invalidateClipCache(clipId);
#ifdef XLETH_DEBUG
    fprintf(stderr, "[BridgeStretch] timeline_reverseClip → reversed=%d\n", (int)newReversed);
#endif

    const Clip* updated = g_timeline->getClip(clipId);
    if (!updated) return env.Undefined();
    log.done(std::to_string(clipId));
    return clipToJs(env, *updated);
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
    s.declickSamples   = r->declickSamples;
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
    if (o.Has("declickSamples") && o.Get("declickSamples").IsNumber())
        s.declickSamples = o.Get("declickSamples").As<Napi::Number>().Int32Value();
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

// timeline_setVideoFlipMode(trackId, mode)
void Timeline_SetVideoFlipMode(const Napi::CallbackInfo& info)
{
    Napi::Env env = info.Env();
    if (!isInitialised() || !g_timeline || !g_undoManager) {
        Napi::Error::New(env, "Engine not initialised.").ThrowAsJavaScriptException();
        return;
    }
    if (info.Length() < 2 || !info[0].IsNumber() || !info[1].IsString()) {
        Napi::TypeError::New(env, "timeline_setVideoFlipMode(trackId: number, mode: string)")
            .ThrowAsJavaScriptException();
        return;
    }
    int           trackId = info[0].As<Napi::Number>().Int32Value();
    std::string   modeStr = info[1].As<Napi::String>().Utf8Value();
    VideoFlipMode mode    = stringToVideoFlipMode(modeStr);
    BridgeCallLog log("timeline.setVideoFlipMode");
    g_undoManager->execute(
        std::make_unique<SetVideoFlipModeCommand>(trackId, mode, *g_timeline),
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

    SampleRegion newState = jsToRegion(info[1].As<Napi::Object>());
    g_undoManager->execute(
        std::make_unique<ModifyRegionCommand>(id, newState, *g_timeline),
        *g_timeline);
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
//                     startBeat, endBeat }) → bool
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
    }

    o.Set("running",      Napi::Boolean::New(env, isRunning));
    o.Set("percentage",   Napi::Number::New(env, static_cast<double>(p.percentage.load())));
    o.Set("phase",        Napi::Number::New(env, p.phase.load()));
    o.Set("currentFrame", Napi::Number::New(env, static_cast<double>(p.currentFrame.load())));
    o.Set("totalFrames",  Napi::Number::New(env, static_cast<double>(p.totalFrames.load())));
    o.Set("speed",        Napi::Number::New(env, static_cast<double>(p.speedMultiplier.load())));
    o.Set("eta",          Napi::Number::New(env, static_cast<double>(p.etaSeconds.load())));
    o.Set("error",        Napi::String::New(env, p.getError()));
    o.Set("complete",     Napi::Boolean::New(env, p.complete.load()));
    o.Set("failed",       Napi::Boolean::New(env, p.failed.load()));

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
struct ProbedAudioInfo { int sampleRate; double duration; };
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

    region->swappedAudioPath = destPath;
    region->hasSwappedAudio  = true;

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

    region->swappedAudioPath = "";
    region->hasSwappedAudio  = false;

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
            if (needs) mix.invalidateClipCache(c->id);
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
        o.Set("vramMB",     Napi::Number::New(env, static_cast<double>(a.dedicatedVideoMemoryMB)));
        o.Set("isDiscrete", Napi::Boolean::New(env, a.isDiscrete));
        o.Set("isDefault",  Napi::Boolean::New(env, a.isDefault));
        o.Set("index",      Napi::Number::New(env, a.adapterIndex));
        arr.Set(static_cast<uint32_t>(i), o);
    }

    log.done(std::to_string(adapters.size()) + " adapters");
    return arr;
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
    exports.Set("project_create",        Napi::Function::New(env, Project_Create));
    exports.Set("project_save",          Napi::Function::New(env, Project_Save));
    exports.Set("project_saveAs",        Napi::Function::New(env, Project_SaveAs));
    exports.Set("project_hasProjectDir", Napi::Function::New(env, Project_HasProjectDir));
    exports.Set("project_load",          Napi::Function::New(env, Project_Load));
    exports.Set("project_importSource",  Napi::Function::New(env, Project_ImportSource));
    exports.Set("project_validateMedia", Napi::Function::New(env, Project_ValidateMedia));
    exports.Set("project_getInfo",       Napi::Function::New(env, Project_GetInfo));

    // ── Phase 1 — Timeline queries ───────────────────────────────────────────
    exports.Set("timeline_getBPM",           Napi::Function::New(env, Timeline_GetBPM));
    exports.Set("timeline_getDeclickMs",     Napi::Function::New(env, Timeline_GetDeclickMs));
    exports.Set("timeline_getSources",       Napi::Function::New(env, Timeline_GetSources));
    exports.Set("timeline_getRegions",       Napi::Function::New(env, Timeline_GetRegions));
    exports.Set("timeline_getRegionsByLabel",Napi::Function::New(env, Timeline_GetRegionsByLabel));
    exports.Set("timeline_getTracks",        Napi::Function::New(env, Timeline_GetTracks));
    exports.Set("timeline_getClips",         Napi::Function::New(env, Timeline_GetClips));
    exports.Set("timeline_getClipsOnTrack",  Napi::Function::New(env, Timeline_GetClipsOnTrack));
    exports.Set("timeline_getClipsInRange",  Napi::Function::New(env, Timeline_GetClipsInRange));

    // ── Phase 1 — Timeline mutations (via UndoManager) ───────────────────────
    exports.Set("timeline_setBPM",       Napi::Function::New(env, Timeline_SetBPM));
    exports.Set("timeline_setDeclickMs", Napi::Function::New(env, Timeline_SetDeclickMs));
    exports.Set("timeline_addTrack",     Napi::Function::New(env, Timeline_AddTrack));
    exports.Set("timeline_removeTrack",  Napi::Function::New(env, Timeline_RemoveTrack));
    exports.Set("timeline_setTrackMuted",Napi::Function::New(env, Timeline_SetTrackMuted));
    exports.Set("timeline_setTrackSolo", Napi::Function::New(env, Timeline_SetTrackSolo));
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
    exports.Set("timeline_reverseClip",      Napi::Function::New(env, Timeline_ReverseClip));
    exports.Set("timeline_autoTrimClip",     Napi::Function::New(env, Timeline_AutoTrimClip));
    exports.Set("timeline_addRegion",    Napi::Function::New(env, Timeline_AddRegion));
    exports.Set("timeline_modifyRegion", Napi::Function::New(env, Timeline_ModifyRegion));
    exports.Set("timeline_setSyllables", Napi::Function::New(env, Timeline_SetSyllables));
    exports.Set("timeline_getSyllables", Napi::Function::New(env, Timeline_GetSyllables));
    exports.Set("timeline_removeRegion", Napi::Function::New(env, Timeline_RemoveRegion));

    // ── Grid Layout ──────────────────────────────────────────────────────────
    exports.Set("timeline_getGridLayout",       Napi::Function::New(env, Timeline_GetGridLayout));
    exports.Set("timeline_setGridLayout",       Napi::Function::New(env, Timeline_SetGridLayout));
    exports.Set("timeline_assignTrackToGrid",   Napi::Function::New(env, Timeline_AssignTrackToGrid));
    exports.Set("timeline_removeTrackFromGrid", Napi::Function::New(env, Timeline_RemoveTrackFromGrid));
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
    exports.Set("timeline_resizeNote",             Napi::Function::New(env, Timeline_ResizeNote));
    exports.Set("timeline_setNoteVelocity",        Napi::Function::New(env, Timeline_SetNoteVelocity));
    exports.Set("timeline_previewNote",            Napi::Function::New(env, Timeline_PreviewNote));
    exports.Set("timeline_previewNoteOff",         Napi::Function::New(env, Timeline_PreviewNoteOff));
    exports.Set("timeline_previewAllNotesOff",     Napi::Function::New(env, Timeline_PreviewAllNotesOff));
    exports.Set("timeline_convertToPatternTrack",  Napi::Function::New(env, Timeline_ConvertToPatternTrack));
    exports.Set("timeline_convertToClipTrack",     Napi::Function::New(env, Timeline_ConvertToClipTrack));
    exports.Set("timeline_setVideoFlipMode",       Napi::Function::New(env, Timeline_SetVideoFlipMode));
    exports.Set("timeline_setVideoHoldLastFrame", Napi::Function::New(env, Timeline_SetVideoHoldLastFrame));

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
    exports.Set("audio_exportStart",       Napi::Function::New(env, Audio_ExportStart));
    exports.Set("audio_exportGetProgress", Napi::Function::New(env, Audio_ExportGetProgress));
    exports.Set("audio_exportCancel",      Napi::Function::New(env, Audio_ExportCancel));
    exports.Set("video_exportStart",       Napi::Function::New(env, Video_ExportStart));
    exports.Set("video_exportGetProgress", Napi::Function::New(env, Video_ExportGetProgress));
    exports.Set("video_exportCancel",      Napi::Function::New(env, Video_ExportCancel));
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

    // ── Hardware encoder detection ───────────────────────────────────────────
    exports.Set("hwenc_getAvailableEncoders", Napi::Function::New(env, HwEnc_GetAvailableEncoders));
    exports.Set("hwenc_getDefaultEncoder",    Napi::Function::New(env, HwEnc_GetDefaultEncoder));
    exports.Set("hwenc_refresh",              Napi::Function::New(env, HwEnc_Refresh));

    return exports;
}

NODE_API_MODULE(xleth_native, Init)
