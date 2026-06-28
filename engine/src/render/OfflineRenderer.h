#pragma once

/**
 * OfflineRenderer — Drives the entire A/V export pipeline on a dedicated thread.
 *
 * Orchestration: audio processing → frame collection → decode → composite → mux.
 * Audio is the master clock; video frames are emitted at audio-derived frame
 * boundaries via RenderClock::frameBoundsForBuffer.
 *
 * Pipeline per buffer iteration:
 *   1. MixEngine::processBlock  → stereo float audio
 *   2. FFmpegMuxer::writeAudio  → encode + mux audio
 *   3. RenderClock              → which video frames fall in this buffer?
 *   4. FrameCollector           → what does each grid cell need?
 *   5. RenderVideoDecoder       → decode cache misses
 *   6. GridCompositor           → GPU composite → readback
 *   7. FFmpegMuxer::writeVideo  → encode + mux video
 *
 * Thread model:
 *   - startRender() spawns a dedicated std::thread
 *   - RenderProgress is polled by N-API at 10 Hz
 *   - cancelRequested flag stops the loop; muxer is ALWAYS finalized
 *
 * No JUCE AudioIODevice or audio device callback involved — this is a pure
 * offline manual loop with a local Transport.
 */

#include <atomic>
#include <chrono>
#include <cstdint>
#include <memory>
#include <mutex>
#include <string>
#include <thread>
#include <unordered_map>

// Forward declarations (avoid pulling heavy headers)
struct ExportSettings;
struct SlideAnimationEvent;
class  Timeline;
class  MixEngine;
class  GpuDeviceManager;

#include <vector>

#include "render/RenderScope.h"   // xleth::TailRenderPlan (Phase 3A tail policy)

// ---------------------------------------------------------------------------
// RenderProgress — atomic struct for UI polling
// ---------------------------------------------------------------------------
struct RenderProgress {
    std::atomic<float>   percentage{0.0f};      // 0..100
    std::atomic<int64_t> currentFrame{0};
    std::atomic<int64_t> totalFrames{0};
    std::atomic<float>   speedMultiplier{0.0f};  // e.g. 4.2x realtime
    std::atomic<float>   etaSeconds{0.0f};
    std::atomic<int>     phase{0};               // 0=idle, 1=preroll, 2=rendering, 3=finalizing
    std::atomic<bool>    cancelRequested{false};
    std::atomic<bool>    complete{false};
    std::atomic<bool>    failed{false};
    std::atomic<bool>    videoEncoderFallback{false};

    // Written once on failure from the render thread, read after complete/failed
    std::mutex           errorMutex;
    std::string          errorMessage;
    std::string          videoEncoderName;   // set after muxer init

    void setError(const std::string& msg) {
        std::lock_guard<std::mutex> lk(errorMutex);
        errorMessage = msg;
    }
    std::string getError() const {
        std::lock_guard<std::mutex> lk(const_cast<std::mutex&>(errorMutex));
        return errorMessage;
    }
    void setVideoEncoderName(const std::string& name) {
        std::lock_guard<std::mutex> lk(errorMutex);
        videoEncoderName = name;
    }
    std::string getVideoEncoderName() const {
        std::lock_guard<std::mutex> lk(const_cast<std::mutex&>(errorMutex));
        return videoEncoderName;
    }
};

// ---------------------------------------------------------------------------
// OfflineRenderer
// ---------------------------------------------------------------------------
class OfflineRenderer
{
public:
    /**
     * @param timeline   Project data (tracks, clips, patterns, grid, sources)
     * @param mixer      MixEngine to drive for audio rendering
     * @param gpu        GPU device manager for D3D11 access (video decode + composite)
     *
     * Note: MixEngine must have its Timeline and SampleBank set before calling
     * startRender(). The OfflineRenderer does not manage those dependencies.
     */
    OfflineRenderer(const Timeline& timeline,
                    MixEngine& mixer,
                    GpuDeviceManager& gpu);
    ~OfflineRenderer();

    // Non-copyable
    OfflineRenderer(const OfflineRenderer&)            = delete;
    OfflineRenderer& operator=(const OfflineRenderer&) = delete;

    // ── Lifecycle ─────────────────────────────────────────────────────────

    /**
     * Begin rendering on a background thread.
     * @param startSample  First sample to include in the output (capture start)
     * @param endSample    One past the last sample to render (capture end)
     * @param settings     Export settings (codec, resolution, fps, output path)
     *
     * Legacy overload: warm-up begins at startSample (latency-only pre-roll, the
     * pre-Phase-2 behaviour). If a render is already in progress, returns false.
     */
    bool startRender(int64_t startSample, int64_t endSample,
                     const ExportSettings& settings);

    /**
     * Phase 2 windowed render. Separates the engine warm-up position from the
     * capture window so a scoped absolute render warms up from tick 0
     * (warmUpStartSample == 0) while the output file still begins at
     * startSample with no leading silence/black.
     *
     * @param startSample        First sample written to the output (capture start)
     * @param endSample          One past the last sample written (capture end)
     * @param warmUpStartSample  Sample the engine starts simulating from; output
     *                           in [warmUpStartSample, startSample) is discarded.
     *                           Pass 0 for a scoped absolute window, or
     *                           startSample to keep legacy latency-only pre-roll.
     */
    bool startRender(int64_t startSample, int64_t endSample,
                     int64_t warmUpStartSample,
                     const ExportSettings& settings);

    /**
     * Phase 3A tail policy. Must be called BEFORE startRender(); the value is
     * captured into the render thread. Default (HardCut, maxTailSamples == 0)
     * cuts audio + video exactly at captureEnd. TailClamp continues audio past
     * captureEnd (no new triggers — the engine note-trigger ceiling enforces it)
     * until the master bus decays below threshold or the cap is reached, and
     * freezes the last captured video frame for that tail so A/V lengths match.
     * The plan's sample counts must be built at the export sample rate.
     */
    void setTailRenderPlan(const xleth::TailRenderPlan& plan) { tailPlan_ = plan; }

    /**
     * Directory where resolution-aware render proxies are cached/generated
     * (ProjectManager::getProxiesDir()). Must be set BEFORE startRender() to
     * enable proxy-mode renders. When empty, proxy-mode renders fall back to the
     * original source (non-fatal). Ignored entirely for full-quality renders
     * (settings.useSourceMedia == true).
     */
    void setProxiesDir(const std::string& dir) { proxiesDir_ = dir; }

    /** Request cancellation — sets the flag, checked every buffer iteration. */
    void requestCancel();

    /** Poll-friendly progress accessor. */
    RenderProgress& getProgress() { return progress_; }
    const RenderProgress& getProgress() const { return progress_; }

    /** True if a render thread is currently active. */
    bool isRunning() const { return running_.load(); }

    /**
     * Build VideoEvent list from timeline clips and pattern blocks.
     * Produces the event list that FrameCollector::collectRequests expects.
     */
    static std::vector<struct VideoEvent> buildVideoEvents(
        const Timeline& timeline,
        std::vector<SlideAnimationEvent>* outSlideEvents = nullptr,
        double eventSampleRate = 0.0);

private:
    // ── References to engine state ────────────────────────────────────────
    const Timeline&    timeline_;
    MixEngine&         mixer_;
    GpuDeviceManager&  gpu_;

    // ── Thread state ──────────────────────────────────────────────────────
    std::unique_ptr<std::thread> renderThread_;
    RenderProgress               progress_;
    std::atomic<bool>            running_{false};

    // Phase 3A tail policy (set via setTailRenderPlan before startRender). Default
    // = HardCut (no tail), preserving pre-3A behaviour.
    xleth::TailRenderPlan        tailPlan_{};

    // Proxies directory for resolution-aware render proxies (set before render).
    // Empty → proxy-mode renders fall back to original source.
    std::string                  proxiesDir_;

    /**
     * Build the resolution-aware render proxy plan and GENERATE any missing
     * proxies (blocking, on the render thread — offline, so this is fine).
     * For each source referenced by `events`: compute its PEAK on-screen footprint
     * height across the whole timeline (base cell/fullscreen size × peak animation
     * scale), round UP to a resolution bucket, and — unless the footprint is at/
     * above source resolution or the source is single-use — generate/reuse a
     * footprint-sized whole-source proxy (10-bit preserved for 10-bit sources).
     * Returns a map sourceId → proxy path; sources absent from the map are decoded
     * from the original. Non-fatal: a source whose proxy fails to generate is
     * simply omitted (falls back to original).
     */
    std::unordered_map<int, std::string> buildRenderProxyPlan(
        const std::vector<struct VideoEvent>& events,
        const ExportSettings&                 settings);

    // ── Internal ──────────────────────────────────────────────────────────
    void render(int64_t startSample, int64_t endSample,
                int64_t warmUpStartSample,
                const ExportSettings& settings);
    void renderImpl(int64_t startSample, int64_t endSample,
                    int64_t warmUpStartSample,
                    const ExportSettings& settings);

    // Phase 3B wrap (seamless loop tail-fold) A/V path, corrected in 3B-r1. Kept
    // separate from renderImpl so the Phase 3A hardCut/tailClamp pipeline is
    // untouched. Audio is pre-rendered to memory via xleth::renderWrapCore —
    // strictly sequential (Phase-2 absolute warm-up + post-end tail folded onto the
    // region head), with NO looped-region pre-roll and NO backward seek — then the
    // folded region audio is streamed to the muxer alongside the region's video
    // frames. Final A/V duration == region length exactly: NO tail extension, NO
    // video freeze, NO video fold.
    void renderImplWrap(int64_t startSample, int64_t endSample,
                        int64_t warmUpStartSample,
                        const ExportSettings& settings);

    /**
     * Remux fragmented MP4 → standard MP4 with moov at front (faststart).
     * Uses FFmpeg C API stream copy — no re-encoding.
     */
    static bool remuxToFaststart(const std::string& fragPath,
                                 const std::string& outputPath);
};
