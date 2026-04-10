// test_offline_render.cpp — Integration test for the OfflineRenderer pipeline.
// Creates a minimal project: one track with a 1-second pattern block,
// renders to MP4, and verifies the output contains both audio and video streams.

#include "render/OfflineRenderer.h"
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
        slot.spanX = 2;
        slot.spanY = 2;
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
            assert(probe.duration > 0.5 && probe.duration < 2.0 && "Duration ~1 second");

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
