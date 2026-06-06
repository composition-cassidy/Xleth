// test_offline_render.cpp — Integration test for the OfflineRenderer pipeline.
// Creates a minimal project: one track with a 1-second pattern block,
// renders to MP4, and verifies the output contains both audio and video streams.

#include "render/OfflineRenderer.h"
#include "render/RenderScope.h"
#include "render/FrameCollector.h"
#include "export/FFmpegMuxer.h"
#include "model/Timeline.h"
#include "model/TimelineTypes.h"
#include "audio/MixEngine.h"
#include "render/GpuDeviceManager.h"
#include "SyncManager.h"

extern "C" {
#include <libavformat/avformat.h>
}

// Force assert even in Release builds
#undef NDEBUG
#include <cassert>
#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstdio>
#include <filesystem>
#include <thread>

// Helper: probe an MP4 file for stream count and duration
struct ProbeResult {
    int streamCount = 0;
    bool hasVideo = false;
    bool hasAudio = false;
    double duration = 0.0;
    int videoWidth = 0;
    int videoHeight = 0;
};

static ProbeResult probeFile(const std::string& path)
{
    ProbeResult r;
    AVFormatContext* ctx = nullptr;
    if (avformat_open_input(&ctx, path.c_str(), nullptr, nullptr) != 0) return r;
    if (avformat_find_stream_info(ctx, nullptr) < 0) {
        avformat_close_input(&ctx);
        return r;
    }

    r.streamCount = static_cast<int>(ctx->nb_streams);
    r.duration = static_cast<double>(ctx->duration) / AV_TIME_BASE;

    for (unsigned i = 0; i < ctx->nb_streams; ++i) {
        auto* par = ctx->streams[i]->codecpar;
        if (par->codec_type == AVMEDIA_TYPE_VIDEO) {
            r.hasVideo = true;
            r.videoWidth = par->width;
            r.videoHeight = par->height;
        } else if (par->codec_type == AVMEDIA_TYPE_AUDIO) {
            r.hasAudio = true;
        }
    }

    avformat_close_input(&ctx);
    return r;
}

struct ExportTrimWindow
{
    int64_t requestedDuration = 0;
    int64_t totalPrerollSamples = 0;
    int64_t historyPreroll = 0;
    int64_t renderStart = 0;
    int64_t totalDiscard = 0;
    int64_t renderSamplesNeeded = 0;
    int64_t renderEnd = 0;
};

// Phase 2: trim window now flows through the shared render/RenderScope.h helper
// with an explicit warm-up start. warmUpStartSample == startSample reproduces the
// legacy latency-only pre-roll; warmUpStartSample == 0 is the scoped absolute
// window (warm up from tick 0).
static ExportTrimWindow computeExportTrimWindow(int64_t startSample, int64_t endSample,
                                                int64_t warmUpStartSample,
                                                int trackLatency, int masterLatency)
{
    const auto plan = xleth::computeRenderPrerollPlan(
        warmUpStartSample, startSample, trackLatency, masterLatency);
    ExportTrimWindow window;
    window.requestedDuration   = endSample - startSample;
    window.totalPrerollSamples = plan.totalPrerollSamples;
    window.historyPreroll      = plan.availablePrerollSamples;
    window.renderStart         = plan.renderStartSample;
    window.totalDiscard        = plan.discardSamples;
    window.renderSamplesNeeded = window.requestedDuration + window.totalDiscard;
    window.renderEnd           = window.renderStart + window.renderSamplesNeeded;
    return window;
}

static void verifyExportTrimWindowMath()
{
    // ── Legacy latency-only pre-roll (warm-up == capture start) ──────────────
    const auto projectStartWithPdc = computeExportTrimWindow(0, 48000, 0, 1024, 0);
    assert(projectStartWithPdc.historyPreroll == 0);
    assert(projectStartWithPdc.renderStart == 0);
    assert(projectStartWithPdc.totalDiscard == 1024);
    assert(projectStartWithPdc.renderSamplesNeeded == projectStartWithPdc.requestedDuration + 1024);

    const auto midProjectWithPdc = computeExportTrimWindow(48000, 96000, 48000, 1024, 0);
    assert(midProjectWithPdc.historyPreroll == 1024);
    assert(midProjectWithPdc.renderStart == 48000 - 1024);
    assert(midProjectWithPdc.totalDiscard == 2048);
    assert(midProjectWithPdc.renderSamplesNeeded == midProjectWithPdc.requestedDuration + 2048);

    const auto noPdc = computeExportTrimWindow(0, 48000, 0, 0, 0);
    assert(noPdc.historyPreroll == 0);
    assert(noPdc.totalDiscard == 0);
    assert(noPdc.renderStart == 0);
    assert(noPdc.renderSamplesNeeded == noPdc.requestedDuration);

    const auto masterLatencyOnly = computeExportTrimWindow(0, 48000, 0, 0, 1024);
    assert(masterLatencyOnly.historyPreroll == 0);
    assert(masterLatencyOnly.totalDiscard == 1024);
    assert(masterLatencyOnly.renderSamplesNeeded == masterLatencyOnly.requestedDuration + 1024);

    // ── Phase 2 scoped absolute window (warm up from tick 0) ─────────────────
    // Region [48000, 96000), warm-up from sample 0 → the engine processes the
    // full [0, 48000) history (discarded) before capture begins. This is the
    // cold-start regression guard: if someone reverts to cold-start
    // (renderStart == startSample), renderStart would be 48000, not 0.
    const auto absScoped = computeExportTrimWindow(48000, 96000, /*warmUp*/0, 0, 0);
    assert(absScoped.renderStart == 0 && "absolute window MUST warm up from sample 0 (not cold-start at startSample)");
    assert(absScoped.totalDiscard == 48000 && "discard covers all of [0, startSample)");
    assert(absScoped.renderSamplesNeeded == absScoped.requestedDuration + 48000);
    // Output begins at 0: captured length equals exactly the region length.
    assert(absScoped.requestedDuration == 48000);

    // With latency on top of warm-up, the latency is flushed before capture too.
    const auto absScopedPdc = computeExportTrimWindow(48000, 96000, /*warmUp*/0, 1024, 0);
    assert(absScopedPdc.renderStart == 0 && "warm-up from 0 keeps renderStart clamped at 0");
    assert(absScopedPdc.totalDiscard == 48000 + 1024 && "discard = warm-up history + latency");
}

// Phase 2: prove the video event path keeps clips that began BEFORE the scoped
// window start but are still active at it — i.e. the events are NOT re-timed to
// region-zero, and findActiveEvent resolves an in-flight clip at the absolute
// window-start beat.
static void verifyVideoInFlightEvent()
{
    Timeline timeline(120.0, 48000.0);

    SourceMedia src;
    src.filePath = "inflight.mp4";
    src.hasVideo = true;
    src.fps = 30.0;
    src.duration = 30.0;
    src.totalFrames = 900;
    src.width = 320; src.height = 240;
    int sourceId = timeline.addSource(src);

    SampleRegion region;
    region.sourceId = sourceId;
    region.startTime = 0.0;
    region.endTime = 30.0;
    int regionId = timeline.addRegion(region);

    TrackInfo track;
    track.name = "Held";
    track.videoOpacity = 1.0f;
    int trackId = timeline.addTrack(track);

    // Grid with this track in a single cell.
    GridLayout grid;
    grid.columns = 1; grid.rows = 1;
    GridSlot slot;
    slot.trackId = trackId;
    slot.gridX = 0; slot.gridY = 0;
    slot.spanX = kGridSubUnitsPerColumn;
    slot.spanY = kGridSubUnitsPerRow;
    grid.slots.push_back(slot);
    timeline.setGridLayout(grid);

    // A long clip from beat 0 → beat 16 (4 bars). The scoped window starts at
    // beat 8, mid-clip.
    Clip clip;
    clip.trackId = trackId;
    clip.regionId = regionId;
    clip.position = TickTime::fromBeats(0.0);
    clip.duration = TickTime::fromBeats(16.0);
    timeline.addClip(clip);

    auto events = OfflineRenderer::buildVideoEvents(timeline);
    assert(events.size() == 1);
    // Event start beat is ABSOLUTE (0), not shifted to the window start.
    assert(std::abs(events[0].startBeat - 0.0) < 1e-6 && "video events keep absolute start beats");

    // Scoped window starts at beat 8 → 4.0s → 192000 samples @ 120bpm/48kHz.
    // Output frame 0 maps to the absolute window start via projectStartSample,
    // exactly as OfflineRenderer drives the collector during a scoped render.
    const int sampleRate = 48000;
    const AVRational fps = { 30, 1 };
    const int64_t windowStartSample = 192000;
    FrameCollector collector;
    auto requests = collector.collectRequests(
        /*outputFrameIndex=*/0, timeline, sampleRate, fps, events,
        /*allowProxy=*/false, /*projectStartSample=*/windowStartSample);

    bool foundInFlight = false;
    for (const auto& r : requests)
        if (r.trackId == trackId) foundInFlight = true;
    assert(foundInFlight && "in-flight clip must be active at the scoped window start "
                            "(no cold start, no re-time-to-zero)");

    // Source frame must reflect the clip having played ~4s, NOT frame 0 — proof
    // the window samples absolute project time, not region-relative zero.
    for (const auto& r : requests) {
        if (r.trackId != trackId) continue;
        assert(r.sourceFrameIndex > 0 &&
               "in-flight clip must be sampled mid-source, not from frame 0");
    }

    std::fprintf(stderr, "[TEST:Renderer] Video in-flight event: PASSED\n");
}

int main()
{
    std::fprintf(stderr, "\n[TEST:Renderer] Starting offline render tests...\n");

    // ── Shared GPU device (created once, never destroyed — std::_Exit skips) ──
    // D3D11 device cleanup can crash after render pipeline use (COM ref
    // counting edge cases with DXGI). Since std::_Exit(0) at end of main
    // bypasses all destructors, we create the GPU device at main scope.
    GpuDeviceManager gpu;
    gpu.detectAdapters();
    bool hasGpu = gpu.createDevice();
    std::fprintf(stderr, "[TEST:Renderer] GPU available: %s\n", hasGpu ? "YES" : "NO");
    std::fprintf(stderr, "\n[TEST:Renderer] --- Test 0: Export trim window math ---\n");
    verifyExportTrimWindowMath();
    verifyVideoInFlightEvent();
    std::fprintf(stderr, "[TEST:Renderer] Test 0: PASSED\n");

    // ── Test 1: Build video events from timeline ────────────────────────
    {
        std::fprintf(stderr, "\n[TEST:Renderer] --- Test 1: Build video events ---\n");

        Timeline timeline(140.0, 48000.0);

        // Add a source
        SourceMedia src;
        src.filePath   = "test_video.mp4";
        src.hasVideo   = true;
        src.fps        = 30.0;
        src.duration   = 10.0;
        src.totalFrames = 300;
        src.width      = 320;
        src.height     = 240;
        int sourceId = timeline.addSource(src);

        // Add a region
        SampleRegion region;
        region.sourceId   = sourceId;
        region.name       = "TestRegion";
        region.startTime  = 0.0;
        region.endTime    = 10.0;
        region.startFrame = 0;
        region.endFrame   = 300;
        int regionId = timeline.addRegion(region);

        // Add a track
        TrackInfo track;
        track.name         = "Track1";
        track.videoOpacity = 1.0f;
        int trackId = timeline.addTrack(track);

        // Add a clip (1 beat duration)
        Clip clip;
        clip.trackId  = trackId;
        clip.regionId = regionId;
        clip.position = TickTime::fromBeats(0.0);
        clip.duration = TickTime::fromBeats(2.0);
        timeline.addClip(clip);

        // Add another clip
        Clip clip2;
        clip2.trackId  = trackId;
        clip2.regionId = regionId;
        clip2.position = TickTime::fromBeats(2.0);
        clip2.duration = TickTime::fromBeats(2.0);
        timeline.addClip(clip2);

        auto events = OfflineRenderer::buildVideoEvents(timeline);
        std::fprintf(stderr, "[TEST:Renderer] Built %d events\n", static_cast<int>(events.size()));
        assert(events.size() == 2 && "Should have 2 events for 2 clips");

        // Verify event properties
        assert(events[0].sourceId == sourceId);
        assert(events[0].trackId == trackId);
        assert(std::abs(events[0].startBeat - 0.0) < 0.001);
        assert(std::abs(events[0].durationBeats - 2.0) < 0.001);
        assert(events[1].globalNoteIndex == 1);

        std::fprintf(stderr, "[TEST:Renderer] Test 1: PASSED\n");
    }

    // ── Test 2: Build events from pattern blocks ────────────────────────
    {
        std::fprintf(stderr, "\n[TEST:Renderer] --- Test 2: Pattern block events ---\n");

        Timeline timeline(140.0, 48000.0);

        SourceMedia src;
        src.filePath = "test.mp4";
        src.hasVideo = true;
        src.fps = 30.0;
        src.duration = 5.0;
        src.totalFrames = 150;
        int sourceId = timeline.addSource(src);

        SampleRegion region;
        region.sourceId = sourceId;
        region.startTime = 0.0;
        region.endTime = 5.0;
        int regionId = timeline.addRegion(region);

        TrackInfo track;
        track.name = "PatTrack";
        track.type = TrackInfo::Type::Pattern;
        track.videoOpacity = 0.8f;
        int trackId = timeline.addTrack(track);

        // Create a pattern with 2 notes
        Pattern pat;
        pat.regionId = regionId;
        pat.length = TickTime::fromBeats(4.0);
        PatternNote n1;
        n1.position = TickTime::fromBeats(0.0);
        n1.duration = TickTime::fromBeats(1.0);
        n1.velocity = 1.0f;
        pat.notes.push_back(n1);
        PatternNote n2;
        n2.position = TickTime::fromBeats(2.0);
        n2.duration = TickTime::fromBeats(1.0);
        n2.velocity = 0.5f;
        pat.notes.push_back(n2);
        int patternId = timeline.addPattern(pat);

        // Place pattern block
        PatternBlock block;
        block.trackId   = trackId;
        block.patternId = patternId;
        block.position  = TickTime::fromBeats(0.0);
        block.duration  = TickTime::fromBeats(4.0);
        timeline.addPatternBlock(block);

        auto events = OfflineRenderer::buildVideoEvents(timeline);
        std::fprintf(stderr, "[TEST:Renderer] Built %d events from patterns\n",
                     static_cast<int>(events.size()));
        assert(events.size() == 2 && "2 notes in 1 pattern block");
        assert(std::abs(events[0].opacity - 0.8f) < 0.01);  // track opacity * note velocity
        assert(std::abs(events[1].opacity - 0.4f) < 0.01);  // 0.8 * 0.5

        std::fprintf(stderr, "[TEST:Renderer] Test 2: PASSED\n");
    }

    // ── Test 3: RenderProgress struct ───────────────────────────────────
    {
        std::fprintf(stderr, "\n[TEST:Renderer] --- Test 3: RenderProgress atomics ---\n");

        RenderProgress progress;
        assert(progress.phase.load() == 0);
        assert(!progress.complete.load());
        assert(!progress.failed.load());
        assert(!progress.cancelRequested.load());

        progress.phase.store(2);
        progress.percentage.store(50.0f);
        progress.setError("test error");

        assert(progress.phase.load() == 2);
        assert(std::abs(progress.percentage.load() - 50.0f) < 0.01);
        assert(progress.getError() == "test error");

        std::fprintf(stderr, "[TEST:Renderer] Test 3: PASSED\n");
    }

    // ── Test 4: Minimal render with GPU ─────────────────────────────────
    {
        std::fprintf(stderr, "\n[TEST:Renderer] --- Test 4: Minimal render (audio path) ---\n");

        // Create a minimal timeline with 1 second of content
        Timeline timeline(140.0, 48000.0);

        // Add source (video will be black since no actual file exists)
        SourceMedia src;
        src.filePath = "nonexistent.mp4";
        src.hasVideo = true;
        src.fps = 30.0;
        src.duration = 5.0;
        src.totalFrames = 150;
        src.width = 320;
        src.height = 240;
        int sourceId = timeline.addSource(src);

        SampleRegion region;
        region.sourceId = sourceId;
        region.startTime = 0.0;
        region.endTime = 5.0;
        int regionId = timeline.addRegion(region);

        TrackInfo track;
        track.name = "TestTrack";
        track.videoOpacity = 1.0f;
        int trackId = timeline.addTrack(track);

        // Set up grid
        GridLayout grid;
        grid.columns = 1;
        grid.rows = 1;
        GridSlot slot;
        slot.trackId = trackId;
        slot.gridX = 0;
        slot.gridY = 0;
        slot.spanX = kGridSubUnitsPerColumn;
        slot.spanY = kGridSubUnitsPerRow;
        grid.slots.push_back(slot);
        timeline.setGridLayout(grid);

        // Clip: 4 beats at 140 BPM ≈ 1.71 seconds
        Clip clip;
        clip.trackId = trackId;
        clip.regionId = regionId;
        clip.position = TickTime::fromBeats(0.0);
        clip.duration = TickTime::fromBeats(4.0);
        timeline.addClip(clip);

        // Set up MixEngine (no samplers loaded = silence, that's OK for this test)
        MixEngine mixer;
        mixer.setTimeline(&timeline);
        mixer.prepare(48000.0, 512);
        mixer.setNonRealtime(true);

        const int masterRsNode = mixer.addMasterEffect("resonancesuppressor", 0);
        assert(masterRsNode >= 0 && "master RS should be added for trim regression");
        assert(mixer.setMasterEffectParameter(masterRsNode, "processing_mode", 1.0f));
        assert(mixer.setMasterEffectParameter(masterRsNode, "quality", 2.0f));
        assert(mixer.setMasterEffectParameter(masterRsNode, "depth", 0.0f));
        assert(mixer.setMasterEffectParameter(masterRsNode, "mix", 100.0f));
        assert(mixer.setMasterEffectParameter(masterRsNode, "delta", 0.0f));
        mixer.prepare(48000.0, 512);
        mixer.setNonRealtime(true);

        const auto latencySnapshot = mixer.getLatencyCompensationSnapshot();
        assert(latencySnapshot.maxAudibleTrackLatencySamples == 0);
        assert(latencySnapshot.masterInsertLatencySamples == 2048);

        // Export settings
        ExportSettings settings;
        settings.outputPath  = "test_offline_render_output.mp4";
        settings.videoCodec  = ExportSettings::VideoCodec::MPEG4;
        settings.width       = 320;
        settings.height      = 240;
        settings.fpsNum      = 30;
        settings.fpsDen      = 1;
        settings.crf         = -1;
        settings.videoBitrate = 500000;
        settings.audioCodec  = ExportSettings::AudioCodec::AAC;
        settings.sampleRate  = 48000;
        settings.audioBitrate = 128;

        // Render 1 second = 48000 samples
        OfflineRenderer renderer(timeline, mixer, gpu);
        bool started = renderer.startRender(0, 48000, settings);
        assert(started && "startRender should succeed");

        // Poll progress until complete or timeout
        auto& progress = renderer.getProgress();
        auto start = std::chrono::steady_clock::now();
        while (!progress.complete.load() && !progress.failed.load()) {
            std::this_thread::sleep_for(std::chrono::milliseconds(100));
            std::fprintf(stderr, "[TEST:Renderer] %.1f%% phase=%d frame=%lld/%lld\n",
                         progress.percentage.load(),
                         progress.phase.load(),
                         (long long)progress.currentFrame.load(),
                         (long long)progress.totalFrames.load());

            auto elapsed = std::chrono::steady_clock::now() - start;
            if (elapsed > std::chrono::seconds(30)) {
                std::fprintf(stderr, "[TEST:Renderer] TIMEOUT!\n");
                renderer.requestCancel();
                break;
            }
        }

        if (progress.failed.load()) {
            std::fprintf(stderr, "[TEST:Renderer] Render failed: %s\n",
                         progress.getError().c_str());
        }

        // The render may fail if GPU is not available (compositor can't init).
        // That's expected on some CI environments.
        if (hasGpu) {
            assert(progress.complete.load() && "Render should complete with GPU");
            assert(!progress.failed.load() && "Render should not fail with GPU");

            // Verify output file
            assert(std::filesystem::exists(settings.outputPath));
            auto fileSize = std::filesystem::file_size(settings.outputPath);
            std::fprintf(stderr, "[TEST:Renderer] Output: %lld bytes\n", (long long)fileSize);
            assert(fileSize > 0);

            // Probe the output
            auto probe = probeFile(settings.outputPath);
            std::fprintf(stderr, "[TEST:Renderer] Streams: %d, video=%s, audio=%s, duration=%.2fs\n",
                         probe.streamCount,
                         probe.hasVideo ? "yes" : "no",
                         probe.hasAudio ? "yes" : "no",
                         probe.duration);
            assert(probe.streamCount == 2 && "Should have 2 streams");
            assert(probe.hasVideo && "Must have video stream");
            assert(probe.hasAudio && "Must have audio stream");
            assert(probe.duration > 0.9 && probe.duration < 1.2
                   && "Duration should stay close to the requested 1 second after trim");

            // Cleanup
            std::filesystem::remove(settings.outputPath);
        } else {
            std::fprintf(stderr, "[TEST:Renderer] Skipping output verification (no GPU)\n");
            // Clean up any partial files
            std::filesystem::remove(settings.outputPath);
            std::filesystem::remove(settings.outputPath + ".frag.mp4");
        }

        std::fprintf(stderr, "[TEST:Renderer] Test 4: PASSED\n");
    }

    // ── Test 5: Cancel mid-render ───────────────────────────────────────
    {
        std::fprintf(stderr, "\n[TEST:Renderer] --- Test 5: Cancel mid-render ---\n");

        Timeline timeline(140.0, 48000.0);
        MixEngine mixer;
        mixer.setTimeline(&timeline);
        mixer.prepare(48000.0, 512);

        ExportSettings settings;
        settings.outputPath  = "test_cancel.mp4";
        settings.videoCodec  = ExportSettings::VideoCodec::MPEG4;
        settings.width       = 320;
        settings.height      = 240;
        settings.fpsNum      = 30;
        settings.fpsDen      = 1;
        settings.crf         = -1;
        settings.videoBitrate = 500000;
        settings.audioCodec  = ExportSettings::AudioCodec::AAC;
        settings.sampleRate  = 48000;
        settings.audioBitrate = 128;

        // Render a long duration, then cancel immediately
        OfflineRenderer renderer(timeline, mixer, gpu);
        renderer.startRender(0, 48000 * 60, settings);  // 60 seconds

        // Cancel after 200ms
        std::this_thread::sleep_for(std::chrono::milliseconds(200));
        renderer.requestCancel();

        // Wait for thread to finish
        auto start = std::chrono::steady_clock::now();
        while (renderer.isRunning()) {
            std::this_thread::sleep_for(std::chrono::milliseconds(50));
            if (std::chrono::steady_clock::now() - start > std::chrono::seconds(10)) break;
        }
        assert(!renderer.isRunning() && "Renderer should stop after cancel");

        auto& progress = renderer.getProgress();
        // Should NOT be complete (was cancelled) and should NOT be failed
        assert(!progress.complete.load() && "Should not be complete after cancel");
        assert(!progress.failed.load() && "Should not be failed after cancel");

        // Cleanup any files
        std::filesystem::remove("test_cancel.mp4");
        std::filesystem::remove("test_cancel.mp4.frag.mp4");

        std::fprintf(stderr, "[TEST:Renderer] Test 5: PASSED\n");
    }

    // ── Test 6: Double-start prevention ─────────────────────────────────
    {
        std::fprintf(stderr, "\n[TEST:Renderer] --- Test 6: Double-start prevention ---\n");

        Timeline timeline(140.0, 48000.0);
        MixEngine mixer;
        mixer.setTimeline(&timeline);
        mixer.prepare(48000.0, 512);

        ExportSettings settings;
        settings.outputPath = "test_double.mp4";
        settings.videoCodec = ExportSettings::VideoCodec::MPEG4;
        settings.width = 320; settings.height = 240;
        settings.fpsNum = 30; settings.fpsDen = 1;
        settings.crf = -1; settings.videoBitrate = 500000;
        settings.audioCodec = ExportSettings::AudioCodec::AAC;
        settings.sampleRate = 48000; settings.audioBitrate = 128;

        OfflineRenderer renderer(timeline, mixer, gpu);
        renderer.startRender(0, 48000 * 60, settings);

        // Try to start again while running
        bool secondStart = renderer.startRender(0, 48000, settings);
        assert(!secondStart && "Should reject double-start");

        renderer.requestCancel();
        // Wait for completion
        while (renderer.isRunning())
            std::this_thread::sleep_for(std::chrono::milliseconds(50));

        std::filesystem::remove("test_double.mp4");
        std::filesystem::remove("test_double.mp4.frag.mp4");

        std::fprintf(stderr, "[TEST:Renderer] Test 6: PASSED\n");
    }

    std::fprintf(stderr, "\n[TEST:Renderer] ALL TESTS PASSED\n");
    std::_Exit(0);
}
