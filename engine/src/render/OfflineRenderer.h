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

// Forward declarations (avoid pulling heavy headers)
struct ExportSettings;
class  Timeline;
class  MixEngine;
class  GpuDeviceManager;

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

    // Written once on failure from the render thread, read after complete/failed
    std::mutex           errorMutex;
    std::string          errorMessage;

    void setError(const std::string& msg) {
        std::lock_guard<std::mutex> lk(errorMutex);
        errorMessage = msg;
    }
    std::string getError() const {
        std::lock_guard<std::mutex> lk(const_cast<std::mutex&>(errorMutex));
        return errorMessage;
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
     * @param startSample  First sample to include in the output (typically 0)
     * @param endSample    One past the last sample to render
     * @param settings     Export settings (codec, resolution, fps, output path)
     *
     * If a render is already in progress, this returns false.
     */
    bool startRender(int64_t startSample, int64_t endSample,
                     const ExportSettings& settings);

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
    static std::vector<struct VideoEvent> buildVideoEvents(const Timeline& timeline);

private:
    // ── References to engine state ────────────────────────────────────────
    const Timeline&    timeline_;
    MixEngine&         mixer_;
    GpuDeviceManager&  gpu_;

    // ── Thread state ──────────────────────────────────────────────────────
    std::unique_ptr<std::thread> renderThread_;
    RenderProgress               progress_;
    std::atomic<bool>            running_{false};

    // ── Internal ──────────────────────────────────────────────────────────
    void render(int64_t startSample, int64_t endSample,
                const ExportSettings& settings);
    void renderImpl(int64_t startSample, int64_t endSample,
                    const ExportSettings& settings);

    /**
     * Remux fragmented MP4 → standard MP4 with moov at front (faststart).
     * Uses FFmpeg C API stream copy — no re-encoding.
     */
    static bool remuxToFaststart(const std::string& fragPath,
                                 const std::string& outputPath);
};
