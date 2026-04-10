// test_real_render.cpp — Integration test: render bars 1-17 of the real test project.
//
// Loads XLETH\test\project.json, wires up MixEngine + SampleBank + GPU,
// renders 16 bars (64 beats) at 1920x1080 60fps H.264+AAC, then verifies
// the output MP4.  The file is left in place for manual playback.

#include "render/OfflineRenderer.h"
#include "render/RenderClock.h"
#include "render/GpuDeviceManager.h"
#include "render/HwEncoderDetector.h"
#include "export/FFmpegMuxer.h"
#include "model/Timeline.h"
#include "model/TimelineTypes.h"
#include "project/ProjectManager.h"
#include "audio/MixEngine.h"
#include "SampleBank.h"
#include "SyncManager.h"

extern "C" {
#include <libavformat/avformat.h>
#include <libavutil/mathematics.h>
}

#undef NDEBUG
#include <nlohmann/json.hpp>

#include <cassert>
#include <chrono>
#include <cmath>
#include <cstdio>
#include <filesystem>
#include <fstream>
#include <string>
#include <thread>

// ---------------------------------------------------------------------------
// Probe helper (reused from test_offline_render)
// ---------------------------------------------------------------------------
struct ProbeResult {
    int    streamCount  = 0;
    bool   hasVideo     = false;
    bool   hasAudio     = false;
    double duration     = 0.0;
    int    videoWidth   = 0;
    int    videoHeight  = 0;
    double videoFps     = 0.0;
    int    audioRate    = 0;
    int    audioChannels = 0;
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
    r.duration    = static_cast<double>(ctx->duration) / AV_TIME_BASE;

    for (unsigned i = 0; i < ctx->nb_streams; ++i) {
        auto* par = ctx->streams[i]->codecpar;
        if (par->codec_type == AVMEDIA_TYPE_VIDEO) {
            r.hasVideo    = true;
            r.videoWidth  = par->width;
            r.videoHeight = par->height;
            if (ctx->streams[i]->avg_frame_rate.den > 0)
                r.videoFps = av_q2d(ctx->streams[i]->avg_frame_rate);
        } else if (par->codec_type == AVMEDIA_TYPE_AUDIO) {
            r.hasAudio     = true;
            r.audioRate    = par->sample_rate;
            r.audioChannels = par->ch_layout.nb_channels;
        }
    }

    avformat_close_input(&ctx);
    return r;
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------
int main(int argc, char* argv[])
{
    // ── Parse optional CLI args ──────────────────────────────────────────
    int         width      = 1920;
    int         height     = 1080;
    std::string outputArg;

    for (int i = 1; i < argc; ++i) {
        std::string a = argv[i];
        if ((a == "--width")  && i + 1 < argc) { width  = std::stoi(argv[++i]); }
        else if ((a == "--height") && i + 1 < argc) { height = std::stoi(argv[++i]); }
        else if ((a == "--output") && i + 1 < argc) { outputArg = argv[++i]; }
    }

    std::fprintf(stderr, "\n================================================================\n");
    std::fprintf(stderr, "[TEST:RealRender] Starting REAL project render test\n");
    std::fprintf(stderr, "================================================================\n\n");

    // ── Step 1: Load the project ─────────────────────────────────────────
    const std::string projectDir = "C:\\Users\\Krasen\\Desktop\\XLETH\\test";
    std::string outputPath = outputArg.empty()
        ? projectDir + "\\test_render_bars1to17.mp4"
        : outputArg;

    ProjectManager pm;
    auto loaded = pm.loadProject(projectDir);
    assert(loaded.has_value() && "Failed to load project.json");
    Timeline timeline = std::move(*loaded);

    // Log project info
    auto allTracks  = timeline.getAllTracks();
    auto allClips   = timeline.getAllClips();
    auto allBlocks  = timeline.getAllPatternBlocks();
    auto allSources = timeline.getAllSources();
    auto allRegions = timeline.getAllRegions();
    const auto& grid = timeline.getGridLayout();

    std::fprintf(stderr, "[TEST:RealRender] Project loaded: %d tracks, BPM=%.1f, "
                 "%d clips, %d pattern blocks, %d sources, %d regions\n",
                 (int)allTracks.size(), timeline.getBPM(),
                 (int)allClips.size(), (int)allBlocks.size(),
                 (int)allSources.size(), (int)allRegions.size());
    std::fprintf(stderr, "[TEST:RealRender] Grid layout: %dx%d, %d cells assigned\n",
                 grid.columns, grid.rows, (int)grid.slots.size());
    std::fprintf(stderr, "[TEST:RealRender] Chorus track: %d\n", grid.chorusTrackId);

    // Log sources and check file existence
    for (const auto* src : allSources) {
        bool origExists  = std::filesystem::exists(src->filePath);
        bool proxyExists = !src->proxyPath.empty() && std::filesystem::exists(src->proxyPath);
        std::fprintf(stderr, "[TEST:RealRender] Source %d: '%s' %dx%d %.1ffps "
                     "proxy=%s original=%s\n",
                     src->id, src->fileName.c_str(), src->width, src->height, src->fps,
                     proxyExists ? "YES" : "no",
                     origExists  ? "YES" : "no");
    }

    // ── Step 2: Load audio samples ───────────────────────────────────────
    // For each region, determine the audio path and load into SampleBank.
    SampleBank sampleBank;
    MixEngine mixer;
    mixer.setTimeline(&timeline);
    mixer.setSampleBank(&sampleBank);

    int samplesLoaded = 0, samplesFailed = 0;
    const double engineSR = 48000.0;

    for (const auto* region : allRegions) {
        // Determine audio source path
        std::string audioPath;
        double audioStart = 0.0, audioEnd = 0.0;

        if (region->hasSwappedAudio && !region->swappedAudioPath.empty()) {
            // Swapped audio: standalone file, read entire contents
            audioPath  = region->swappedAudioPath;
            audioStart = 0.0;
            audioEnd   = 99999.0;  // large value — SampleBank stops at EOF
        } else {
            // Original source
            const auto* src = timeline.getSource(region->sourceId);
            if (!src) continue;
            audioPath  = src->filePath;
            audioStart = region->startTime;
            audioEnd   = region->endTime;
        }

        if (audioPath.empty()) continue;

        // Check file exists
        if (!std::filesystem::exists(audioPath)) {
            // Try proxy for video sources (proxy MOV may have audio)
            const auto* src = timeline.getSource(region->sourceId);
            if (src && src->proxyReady && !src->proxyPath.empty() &&
                std::filesystem::exists(src->proxyPath)) {
                audioPath = src->proxyPath;
            } else {
                std::fprintf(stderr, "[TEST:RealRender] WARN: Audio file missing: '%s' "
                             "(region %d '%s')\n", audioPath.c_str(), region->id, region->name.c_str());
                samplesFailed++;
                continue;
            }
        }

        int sampleId = sampleBank.loadSampleFromSource(
            audioPath, audioStart, audioEnd, engineSR);

        if (sampleId >= 0) {
            mixer.mapRegionToSample(region->id, sampleId);
            samplesLoaded++;
        } else {
            std::fprintf(stderr, "[TEST:RealRender] WARN: Failed to load audio for region %d '%s'\n",
                         region->id, region->name.c_str());
            samplesFailed++;
        }
    }

    std::fprintf(stderr, "[TEST:RealRender] Audio: %d samples loaded, %d failed\n",
                 samplesLoaded, samplesFailed);

    // Rebuild samplers for pattern tracks
    mixer.rebuildAllSamplers();
    mixer.prepare(engineSR, 512);
    std::fprintf(stderr, "[TEST:RealRender] MixEngine prepared (SR=%.0f, blockSize=512)\n", engineSR);

    // Restore effect chains from effects.json (absent in old projects — graceful no-op)
    {
        std::string effectsPath = (std::filesystem::path(projectDir) / "effects.json").string();
        if (std::filesystem::exists(effectsPath)) {
            std::ifstream ef(effectsPath);
            if (ef.is_open()) {
                try {
                    nlohmann::json effects;
                    ef >> effects;
                    int chainsLoaded = 0;
                    if (effects.contains("tracks") && effects["tracks"].is_object()) {
                        for (auto it = effects["tracks"].begin();
                             it != effects["tracks"].end(); ++it) {
                            mixer.loadEffectChainFromJSON(std::stoi(it.key()), it.value());
                            ++chainsLoaded;
                        }
                    }
                    if (effects.contains("master")) {
                        mixer.loadMasterEffectChainFromJSON(effects["master"]);
                        ++chainsLoaded;
                    }
                    std::fprintf(stderr, "[TEST:RealRender] Loaded %d effect chains from effects.json\n",
                                 chainsLoaded);
                } catch (...) {
                    std::fprintf(stderr, "[TEST:RealRender] WARN: Failed to parse effects.json\n");
                }
            }
            // Re-prepare so AudioProcessorGraphs get prepareToPlay with correct SR/blockSize
            mixer.prepare(engineSR, 512);
        } else {
            std::fprintf(stderr, "[TEST:RealRender] No effects.json found (effects will be skipped)\n");
        }
    }

    // ── Step 3: GPU + encoder setup ──────────────────────────────────────
    // GPU device in main scope — std::_Exit(0) avoids D3D11 cleanup crash
    GpuDeviceManager gpu;
    gpu.detectAdapters();
    bool hasGpu = gpu.createDevice();
    std::fprintf(stderr, "[TEST:RealRender] GPU available: %s\n", hasGpu ? "YES" : "NO");
    assert(hasGpu && "This test requires a GPU");

    // Detect hardware encoders
    HwEncoderDetector hwDetector;
    if (!gpu.getAdapters().empty()) {
        hwDetector.setGpuVendorId(gpu.getAdapters()[0].vendorId);
    }
    hwDetector.detect();

    int h264CodecId = HwEncoderDetector::codecNameToId("h264");
    std::string h264Encoder = hwDetector.getDefaultEncoder(h264CodecId);
    std::fprintf(stderr, "[TEST:RealRender] H.264 encoder: '%s'\n", h264Encoder.c_str());

    // ── Step 4: Compute render range ─────────────────────────────────────
    const int    barsToRender  = 16;
    const int    beatsPerBar   = 4;
    const int64_t beatsToRender = static_cast<int64_t>(barsToRender) * beatsPerBar;  // 64
    const int    sampleRate    = 48000;
    const double bpm           = timeline.getBPM();  // 140.0

    // endSample = beatsToRender * (60 / bpm) * sampleRate
    //           = 64 * 60 * 48000 / 140
    // Use av_rescale for integer accuracy
    const int64_t startSample = 0;
    const int64_t endSample   = av_rescale(beatsToRender * 60, sampleRate,
                                           static_cast<int64_t>(bpm));

    // PPQ verification: 64 beats * 960 PPQ/beat = 61440
    const int64_t ppqAtEnd = RenderClock::sampleToPPQ(endSample, sampleRate, bpm);
    const double  durationSec = RenderClock::sampleToSeconds(endSample, sampleRate);

    std::fprintf(stderr, "[TEST:RealRender] Region: bars 1-%d = %lld beats = samples 0 -> %lld "
                 "(%.2fs, PPQ=%lld, expect ~61440)\n",
                 barsToRender + 1, (long long)beatsToRender,
                 (long long)endSample, durationSec, (long long)ppqAtEnd);
    assert(ppqAtEnd >= 61400 && ppqAtEnd <= 61500 && "PPQ should be ~61440 for 64 beats");

    // Expected video frame count
    const AVRational fps60 = { 60, 1 };
    const int64_t expectedFrames = RenderClock::sampleToVideoFrame(
        endSample - startSample, sampleRate, fps60);
    std::fprintf(stderr, "[TEST:RealRender] Expected ~%lld video frames at 60fps\n",
                 (long long)expectedFrames);

    // ── Step 5: Configure export settings ────────────────────────────────
    ExportSettings settings;
    settings.outputPath    = outputPath;
    settings.videoCodec    = ExportSettings::VideoCodec::H264;
    settings.hwEncoderName = h264Encoder;
    settings.width         = width;
    settings.height        = height;
    settings.fpsNum        = 60;
    settings.fpsDen        = 1;
    settings.crf           = -1;               // use bitrate mode
    settings.videoBitrate  = 20000000;         // 20 Mbps
    settings.audioCodec    = ExportSettings::AudioCodec::AAC;
    settings.sampleRate    = sampleRate;
    settings.audioBitrate  = 384;              // kbps
    settings.audioChannels = 2;

    std::fprintf(stderr, "[TEST:RealRender] Rendering %dx%d %dfps H.264 encoder='%s' "
                 "bitrate=%.0fMbps audio=AAC %dkHz %dkbps\n",
                 settings.width, settings.height, settings.fpsNum,
                 settings.hwEncoderName.c_str(),
                 settings.videoBitrate / 1e6,
                 settings.sampleRate, settings.audioBitrate);

    // ── Step 6: Run the render ───────────────────────────────────────────
    OfflineRenderer renderer(timeline, mixer, gpu);
    bool started = renderer.startRender(startSample, endSample, settings);
    assert(started && "startRender should succeed");

    auto& progress = renderer.getProgress();
    auto wallStart = std::chrono::steady_clock::now();

    while (!progress.complete.load() && !progress.failed.load()) {
        std::this_thread::sleep_for(std::chrono::milliseconds(500));

        auto wallNow = std::chrono::steady_clock::now();
        double wallSec = std::chrono::duration<double>(wallNow - wallStart).count();

        std::fprintf(stderr, "[TEST:RealRender] %.1f%% | frame %lld/%lld | "
                     "%.1fx realtime | phase=%d | wall=%.0fs\n",
                     progress.percentage.load(),
                     (long long)progress.currentFrame.load(),
                     (long long)progress.totalFrames.load(),
                     progress.speedMultiplier.load(),
                     progress.phase.load(),
                     wallSec);

        // Timeout: 5 minutes
        if (wallSec > 300.0) {
            std::fprintf(stderr, "[TEST:RealRender] TIMEOUT after 5 minutes!\n");
            renderer.requestCancel();
            // Wait for thread to stop
            while (renderer.isRunning())
                std::this_thread::sleep_for(std::chrono::milliseconds(100));
            std::fprintf(stderr, "[TEST:RealRender] RENDER TIMED OUT\n");
            std::_Exit(1);
        }
    }

    if (progress.failed.load()) {
        std::fprintf(stderr, "[TEST:RealRender] RENDER FAILED: %s\n",
                     progress.getError().c_str());
        std::_Exit(1);
    }

    // ── Step 7: Verify the output ────────────────────────────────────────
    double wallSeconds = std::chrono::duration<double>(
        std::chrono::steady_clock::now() - wallStart).count();
    std::fprintf(stderr, "\n[TEST:RealRender] Rendered in %.1fs (%.1fx realtime)\n",
                 wallSeconds, durationSec / wallSeconds);

    // File size
    assert(std::filesystem::exists(outputPath) && "Output file must exist");
    auto fileSize = std::filesystem::file_size(outputPath);
    std::fprintf(stderr, "[TEST:RealRender] Output: %lld bytes (%.1f MB)\n",
                 (long long)fileSize, fileSize / 1048576.0);
    assert(fileSize > 1000000 && "Output must be > 1 MB");

    // Probe with FFmpeg
    auto probe = probeFile(outputPath);
    std::fprintf(stderr, "[TEST:RealRender] Probe: streams=%d video=%s(%dx%d@%.1ffps) "
                 "audio=%s(%dHz %dch) duration=%.2fs\n",
                 probe.streamCount,
                 probe.hasVideo ? "yes" : "no", probe.videoWidth, probe.videoHeight, probe.videoFps,
                 probe.hasAudio ? "yes" : "no", probe.audioRate, probe.audioChannels,
                 probe.duration);

    assert(probe.streamCount == 2 && "Should have 2 streams (video + audio)");
    assert(probe.hasVideo && "Must have video stream");
    assert(probe.hasAudio && "Must have audio stream");
    assert(probe.videoWidth == width && "Video width should match requested width");
    assert(probe.videoHeight == height && "Video height should match requested height");
    assert(probe.audioRate == 48000 && "Audio sample rate should be 48000");

    // Duration check: should be ~27.4 seconds (64 beats at 140 BPM)
    std::fprintf(stderr, "[TEST:RealRender] Expected duration: %.2fs, got: %.2fs\n",
                 durationSec, probe.duration);
    assert(probe.duration > durationSec - 0.5 && "Duration too short");
    assert(probe.duration < durationSec + 0.5 && "Duration too long");

    // Frame count from renderer
    std::fprintf(stderr, "[TEST:RealRender] Expected %lld frames, rendered %lld\n",
                 (long long)expectedFrames, (long long)progress.currentFrame.load());

    // ── Final report ─────────────────────────────────────────────────────
    std::fprintf(stderr, "\n================================================================\n");
    std::fprintf(stderr, "[TEST:RealRender] RENDER COMPLETE\n");
    std::fprintf(stderr, "[TEST:RealRender]   Duration:     %.2f seconds\n", durationSec);
    std::fprintf(stderr, "[TEST:RealRender]   Wall time:    %.1f seconds\n", wallSeconds);
    std::fprintf(stderr, "[TEST:RealRender]   Speed:        %.1fx realtime\n", durationSec / wallSeconds);
    std::fprintf(stderr, "[TEST:RealRender]   Frames:       %lld\n", (long long)progress.currentFrame.load());
    std::fprintf(stderr, "[TEST:RealRender]   File size:    %.1f MB\n", fileSize / 1048576.0);
    std::fprintf(stderr, "[TEST:RealRender]   Output:       %s\n", outputPath.c_str());
    std::fprintf(stderr, "[TEST:RealRender]\n");
    std::fprintf(stderr, "[TEST:RealRender] >>> PLAY THE FILE: %s\n", outputPath.c_str());
    std::fprintf(stderr, "[TEST:RealRender] >>> Manual check: audio correct, grid cells flash,\n");
    std::fprintf(stderr, "[TEST:RealRender] >>>               chorus behind, no desync\n");
    std::fprintf(stderr, "================================================================\n\n");

    std::fprintf(stderr, "[TEST:RealRender] ALL TESTS PASSED\n");
    std::_Exit(0);
}
