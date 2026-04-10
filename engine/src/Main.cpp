#include <juce_core/juce_core.h>
#include <juce_events/juce_events.h>

#include "AudioEngine.h"
#include "FrameCache.h"
#include "SampleBank.h"
#include "SyncManager.h"
#include "VideoDecoder.h"
#include "VideoCompositor.h"
#include "ProxyTranscoder.h"

#include <algorithm>
#include <atomic>
#include <chrono>
#include <cstdio>
#include <filesystem>
#include <iostream>
#include <random>
#include <string>
#include <thread>
#include <vector>

#if defined(_WIN32) || defined(_WIN64)
  #include <conio.h>   // _getch()
#endif

// ── Video decode benchmark ───────────────────────────────────────────────────

static void runVideoDecodeTest(const std::string& videoPath)
{
    std::cout << "\n=== Video Decode Benchmark ===\n";
    std::cout << "File: " << videoPath << "\n\n";

    VideoDecoder decoder;
    if (!decoder.open(videoPath))
    {
        std::cerr << "[VideoTest] Failed to open video file.\n";
        return;
    }

    std::cout << "\nVideo info:\n"
              << "  " << decoder.getWidth() << "x" << decoder.getHeight()
              << " @ " << decoder.getFPS() << " fps\n"
              << "  Duration: " << decoder.getDuration() << " s"
              << " (" << decoder.getTotalFrames() << " frames)\n\n";

    const double duration = decoder.getDuration();

    // ── 5 random seek + decode ────────────────────────────────────────────────
    std::cout << "--- Seek benchmark (5 random timestamps) ---\n";

    std::mt19937 rng(42);
    std::uniform_real_distribution<double> dist(0.0, duration > 0.0 ? duration : 1.0);

    double totalSeekMs = 0.0;
    VideoDecoder::DecodedFrame frame;

    for (int i = 0; i < 5; ++i)
    {
        const double t = dist(rng);
        const auto t0  = std::chrono::high_resolution_clock::now();
        const bool ok  = decoder.seekAndDecode(t, frame);
        const auto t1  = std::chrono::high_resolution_clock::now();

        const double ms = std::chrono::duration<double, std::milli>(t1 - t0).count();
        totalSeekMs += ms;

        std::printf("  Seek #%d  t=%.3fs  frame=%-5d  %s  %.1f ms\n",
                    i + 1, t, frame.frameNumber,
                    ok ? "OK  " : "FAIL",
                    ms);
    }
    std::printf("  Average seek time: %.1f ms\n\n", totalSeekMs / 5.0);

    // ── 30 sequential frames ─────────────────────────────────────────────────
    std::cout << "--- Sequential decode benchmark (30 frames) ---\n";

    // Reopen to reset position to the beginning
    decoder.close();
    if (!decoder.open(videoPath))
    {
        std::cerr << "[VideoTest] Failed to reopen for sequential test.\n";
        return;
    }

    double totalSeqMs = 0.0;
    int    decoded    = 0;

    for (int i = 0; i < 30; ++i)
    {
        const auto t0 = std::chrono::high_resolution_clock::now();
        const bool ok = decoder.decodeNext(frame);
        const auto t1 = std::chrono::high_resolution_clock::now();

        if (!ok) break;

        const double ms = std::chrono::duration<double, std::milli>(t1 - t0).count();
        totalSeqMs += ms;
        ++decoded;
    }

    if (decoded > 0)
    {
        std::printf("  Decoded %d frames, average: %.2f ms/frame\n",
                    decoded, totalSeqMs / decoded);
        if ((totalSeqMs / decoded) < 5.0)
            std::cout << "  [PASS] Average sequential decode < 5 ms\n";
        else
            std::cout << "  [NOTE] Average sequential decode >= 5 ms (may be normal for this codec/resolution)\n";
    }

    std::cout << "\n=== Benchmark complete ===\n\n";
    decoder.close();
}

// ── Proxy transcode benchmark ────────────────────────────────────────────────

struct SeekStats {
    double minMs  = 0.0;
    double maxMs  = 0.0;
    double avgMs  = 0.0;
    double medMs  = 0.0;
};

static SeekStats benchmarkSeeks(VideoDecoder& dec,
                                const std::vector<double>& timestamps)
{
    std::vector<double> times;
    times.reserve(timestamps.size());
    VideoDecoder::DecodedFrame frame;

    for (double t : timestamps)
    {
        auto t0 = std::chrono::high_resolution_clock::now();
        dec.seekAndDecode(t, frame);
        auto t1 = std::chrono::high_resolution_clock::now();
        times.push_back(std::chrono::duration<double, std::milli>(t1 - t0).count());
    }

    std::sort(times.begin(), times.end());

    SeekStats s;
    s.minMs = times.front();
    s.maxMs = times.back();

    double sum = 0.0;
    for (double v : times) sum += v;
    s.avgMs = sum / static_cast<double>(times.size());

    size_t mid = times.size() / 2;
    s.medMs = (times.size() % 2 == 0)
                  ? (times[mid - 1] + times[mid]) / 2.0
                  : times[mid];
    return s;
}

static void runProxyBenchmark(const std::string& videoPath)
{
    namespace fs = std::filesystem;

    std::cout << "\n===================================================\n"
              << "  PROXY TRANSCODE BENCHMARK\n"
              << "===================================================\n\n";

    // ── Open source ──────────────────────────────────────────────────────────
    VideoDecoder srcDec;
    if (!srcDec.open(videoPath))
    {
        std::cerr << "[ProxyBench] Cannot open source: " << videoPath << "\n";
        return;
    }

    const double duration = srcDec.getDuration();
    std::cout << "Source: " << videoPath << "\n"
              << "  " << srcDec.getWidth() << "x" << srcDec.getHeight()
              << " @ " << srcDec.getFPS() << " fps, "
              << duration << " s\n\n";

    // ── Generate 100 random seek timestamps ──────────────────────────────────
    std::mt19937 rng(12345);
    std::uniform_real_distribution<double> dist(0.0, duration > 0.0 ? duration : 1.0);
    std::vector<double> timestamps(100);
    for (auto& t : timestamps) t = dist(rng);

    // ── Benchmark H.264 ──────────────────────────────────────────────────────
    std::cout << "Benchmarking H.264 seeks (100 random timestamps)...\n";
    SeekStats h264 = benchmarkSeeks(srcDec, timestamps);
    srcDec.close();

    std::printf("  H.264 — avg: %.1f ms  min: %.1f ms  max: %.1f ms  median: %.1f ms\n\n",
                h264.avgMs, h264.minMs, h264.maxMs, h264.medMs);

    // ── Transcode to DNxHR LB ────────────────────────────────────────────────
    std::string proxyDir = fs::path(videoPath).parent_path().string();
    if (proxyDir.empty()) proxyDir = ".";

    std::cout << "Transcoding to DNxHR LB proxy...\n";
    auto transcodeStart = std::chrono::high_resolution_clock::now();

    std::string proxyPath = ProxyTranscoder::transcode(videoPath, proxyDir,
        [](float p) {
            int pct = static_cast<int>(p * 100.0f);
            std::printf("\r  Progress: %3d%%", pct);
            std::fflush(stdout);
        });

    auto transcodeEnd = std::chrono::high_resolution_clock::now();
    double transcodeSec = std::chrono::duration<double>(transcodeEnd - transcodeStart).count();

    std::cout << "\n";

    if (proxyPath.empty())
    {
        std::cerr << "[ProxyBench] Transcode failed.\n";
        return;
    }

    std::cout << "Proxy ready: " << proxyPath << "\n\n";

    // ── Benchmark DNxHR ──────────────────────────────────────────────────────
    VideoDecoder proxyDec;
    if (!proxyDec.open(proxyPath))
    {
        std::cerr << "[ProxyBench] Cannot open proxy: " << proxyPath << "\n";
        return;
    }

    std::cout << "Benchmarking DNxHR seeks (same 100 timestamps)...\n";
    SeekStats dnxhr = benchmarkSeeks(proxyDec, timestamps);
    proxyDec.close();

    std::printf("  DNxHR — avg: %.1f ms  min: %.1f ms  max: %.1f ms  median: %.1f ms\n\n",
                dnxhr.avgMs, dnxhr.minMs, dnxhr.maxMs, dnxhr.medMs);

    // ── File sizes ───────────────────────────────────────────────────────────
    double srcSizeMB   = static_cast<double>(fs::file_size(videoPath))  / (1024.0 * 1024.0);
    double proxySizeMB = static_cast<double>(fs::file_size(proxyPath))  / (1024.0 * 1024.0);
    double speedup     = (dnxhr.avgMs > 0.0) ? (h264.avgMs / dnxhr.avgMs) : 0.0;

    // ── Pretty-print results ─────────────────────────────────────────────────
    std::printf(
        "\n"
        "+---------------------------------------------+\n"
        "| PROXY TRANSCODE BENCHMARK                   |\n"
        "+---------------------+---------+---------+\n"
        "|                     |  H.264  |  DNxHR  |\n"
        "+---------------------+---------+---------+\n"
        "| Avg seek time       | %5.1fms | %5.1fms |\n"
        "| Max seek time       | %5.1fms | %5.1fms |\n"
        "| Min seek time       | %5.1fms | %5.1fms |\n"
        "| Median seek time    | %5.1fms | %5.1fms |\n"
        "| Speedup factor      |   1.0x  | %5.1fx  |\n"
        "+---------------------+---------+---------+\n"
        "| Source file size     |       %7.1f MB   |\n"
        "| Proxy file size      |       %7.1f MB   |\n"
        "| Transcode time       |       %7.1f s    |\n"
        "+---------------------+---------+---------+\n"
        "\n",
        h264.avgMs,  dnxhr.avgMs,
        h264.maxMs,  dnxhr.maxMs,
        h264.minMs,  dnxhr.minMs,
        h264.medMs,  dnxhr.medMs,
        speedup,
        srcSizeMB,
        proxySizeMB,
        transcodeSec);

    if (speedup >= 10.0)
        std::cout << "[PASS] DNxHR seek is " << static_cast<int>(speedup)
                  << "x faster — proxy transcoding works!\n\n";
    else if (speedup > 1.0)
        std::cout << "[NOTE] DNxHR is faster but speedup < 10x."
                  << " Try a longer clip for more dramatic results.\n\n";
    else
        std::cout << "[WARN] DNxHR was not faster. Something may be wrong.\n\n";
}

// ── Frame cache simulation benchmark ─────────────────────────────────────────

struct ClipEvent {
    int    sourceId;
    int    startFrame;
    int    numFrames;
    double timelinePos;  // seconds — for sorting
};

static CachedFrame makeDummyFrame(int width, int height)
{
    CachedFrame f;
    f.width   = width;
    f.height  = height;
    f.yStride = width;
    f.uStride = width / 2;
    f.vStride = width / 2;
    f.yPlane.resize(static_cast<size_t>(width) * height);
    f.uPlane.resize(static_cast<size_t>(width / 2) * (height / 2));
    f.vPlane.resize(static_cast<size_t>(width / 2) * (height / 2));
    return f;
}

static void runCacheBenchmark()
{
    std::cout << "\n===================================================\n"
              << "  FRAME CACHE SIMULATION — Sparta Remix\n"
              << "===================================================\n\n";

    // --- Setup: 3 source videos, 5 min @ 30fps each ---
    constexpr int NUM_SOURCES     = 3;
    constexpr int FPS             = 30;
    constexpr int SOURCE_DURATION = 5 * 60;  // seconds
    constexpr int FRAMES_PER_SRC  = SOURCE_DURATION * FPS;  // 9000
    constexpr int NUM_EVENTS      = 500;
    constexpr int WIDTH           = 1920;
    constexpr int HEIGHT          = 1080;

    std::cout << "Sources: " << NUM_SOURCES << " videos, "
              << FRAMES_PER_SRC << " frames each (" << SOURCE_DURATION << "s @ " << FPS << "fps)\n"
              << "Events:  " << NUM_EVENTS << " clip events\n"
              << "Frame:   " << WIDTH << "x" << HEIGHT << " YUV420\n\n";

    // --- Generate simulated timeline ---
    std::mt19937 rng(2024);
    std::uniform_int_distribution<int> srcDist(0, NUM_SOURCES - 1);
    std::uniform_int_distribution<int> frameDist(0, FRAMES_PER_SRC - 10);
    std::uniform_int_distribution<int> durDist(2, 9);  // 50-300ms at 30fps

    std::vector<ClipEvent> events(NUM_EVENTS);
    double timelinePos = 0.0;
    for (auto& ev : events)
    {
        ev.sourceId   = srcDist(rng);
        ev.startFrame = frameDist(rng);
        ev.numFrames  = durDist(rng);
        ev.timelinePos = timelinePos;
        timelinePos += static_cast<double>(ev.numFrames) / FPS;
    }

    // Sort by timeline position (already ordered, but be explicit)
    std::sort(events.begin(), events.end(),
              [](const ClipEvent& a, const ClipEvent& b) { return a.timelinePos < b.timelinePos; });

    // --- Pass 1: play through the timeline ---
    FrameCache cache;  // default 2GB budget

    auto runPass = [&](const char* passName)
    {
        size_t totalRequested = 0;
        size_t hitsBefore     = cache.hitCount();
        size_t missesBefore   = cache.missCount();

        for (const auto& ev : events)
        {
            for (int f = 0; f < ev.numFrames; ++f)
            {
                FrameKey key{ ev.sourceId, ev.startFrame + f };
                const CachedFrame* cached = cache.get(key);
                if (!cached)
                {
                    CachedFrame dummy = makeDummyFrame(WIDTH, HEIGHT);
                    cache.put(key, std::move(dummy));
                }
                ++totalRequested;
            }
        }

        size_t passHits   = cache.hitCount()  - hitsBefore;
        size_t passMisses = cache.missCount() - missesBefore;
        double passRate   = (totalRequested > 0)
            ? static_cast<double>(passHits) / static_cast<double>(totalRequested) * 100.0
            : 0.0;

        double cacheMB = static_cast<double>(cache.currentBytes()) / (1024.0 * 1024.0);

        std::printf(
            "\n"
            "+--------------------------------+\n"
            "| %-30s |\n"
            "+--------------------------------+\n"
            "| Total frames requested: %-6zu |\n"
            "| Cache hits:             %-6zu |\n"
            "| Cache misses:           %-6zu |\n"
            "| Hit rate:              %5.1f%%  |\n"
            "| Cache size:          %6.0f MB |\n"
            "| Entries in cache:       %-6zu |\n"
            "+--------------------------------+\n",
            passName,
            totalRequested,
            passHits,
            passMisses,
            passRate,
            cacheMB,
            cache.entryCount());
    };

    auto t0 = std::chrono::high_resolution_clock::now();

    runPass("PASS 1 — First playthrough");
    runPass("PASS 2 — Repeated playthrough");

    auto t1 = std::chrono::high_resolution_clock::now();
    double elapsedMs = std::chrono::duration<double, std::milli>(t1 - t0).count();

    std::printf("\nOverall cache stats (2 GB budget):\n"
                "  Total hits:   %zu\n"
                "  Total misses: %zu\n"
                "  Hit rate:     %.1f%%\n"
                "  Elapsed:      %.1f ms\n\n",
                cache.hitCount(), cache.missCount(),
                cache.hitRate(),
                elapsedMs);

    // Verify budget compliance
    std::cout << "Verification:\n";

    {
        double cacheMB  = static_cast<double>(cache.currentBytes()) / (1024.0 * 1024.0);
        double budgetMB = static_cast<double>(cache.maxBytes()) / (1024.0 * 1024.0);
        if (cacheMB <= budgetMB)
            std::cout << "  [PASS] Cache within budget (" << static_cast<int>(cacheMB) << " / " << static_cast<int>(budgetMB) << " MB)\n";
        else
            std::cout << "  [FAIL] Cache exceeds budget!\n";
    }

    // --- Re-run with a budget large enough to hold ALL unique frames ---
    // This demonstrates the expected 90%+ second-pass hit rate
    std::cout << "\n--- Re-running with 10 GB budget (fits all unique frames) ---\n";

    FrameCache bigCache(10ULL * 1024 * 1024 * 1024);

    auto runPassOn = [&](FrameCache& c, const char* passName)
    {
        size_t totalRequested = 0;
        size_t hitsBefore     = c.hitCount();
        size_t missesBefore   = c.missCount();

        for (const auto& ev : events)
        {
            for (int f = 0; f < ev.numFrames; ++f)
            {
                FrameKey key{ ev.sourceId, ev.startFrame + f };
                const CachedFrame* cached = c.get(key);
                if (!cached)
                {
                    CachedFrame dummy = makeDummyFrame(WIDTH, HEIGHT);
                    c.put(key, std::move(dummy));
                }
                ++totalRequested;
            }
        }

        size_t passHits   = c.hitCount()  - hitsBefore;
        size_t passMisses = c.missCount() - missesBefore;
        double passRate   = (totalRequested > 0)
            ? static_cast<double>(passHits) / static_cast<double>(totalRequested) * 100.0
            : 0.0;
        double cacheMB = static_cast<double>(c.currentBytes()) / (1024.0 * 1024.0);

        std::printf(
            "\n"
            "+--------------------------------+\n"
            "| %-30s |\n"
            "+--------------------------------+\n"
            "| Total frames requested: %-6zu |\n"
            "| Cache hits:             %-6zu |\n"
            "| Cache misses:           %-6zu |\n"
            "| Hit rate:              %5.1f%%  |\n"
            "| Cache size:          %6.0f MB |\n"
            "| Entries in cache:       %-6zu |\n"
            "+--------------------------------+\n",
            passName,
            totalRequested,
            passHits,
            passMisses,
            passRate,
            cacheMB,
            c.entryCount());

        return passRate;
    };

    runPassOn(bigCache, "PASS 1 — First playthrough");
    double pass2Rate = runPassOn(bigCache, "PASS 2 — Repeated playthrough");

    if (pass2Rate > 90.0)
        std::cout << "  [PASS] Second-pass hit rate > 90% (" << static_cast<int>(pass2Rate) << "%)\n";
    else
        std::cout << "  [WARN] Second-pass hit rate < 90%\n";

    // Verify nullptr for frames never inserted
    FrameKey bogus{ 99, 99999 };
    if (cache.get(bogus) == nullptr)
        std::cout << "  [PASS] get() returns nullptr for unknown keys\n";
    else
        std::cout << "  [FAIL] get() returned non-null for unknown key!\n";

    std::cout << "\n=== Cache benchmark complete ===\n\n";
}

// ── Video display test ──────────────────────────────────────────────────────

static void runVideoDisplayTest(const std::string& videoPath)
{
    std::cout << "\n=== Video Display Test ===\n";
    std::cout << "File: " << videoPath << "\n\n";

    VideoDecoder decoder;
    if (!decoder.open(videoPath))
    {
        std::cerr << "[VideoDisplay] Failed to open video file.\n";
        return;
    }

    const int vidW = decoder.getWidth();
    const int vidH = decoder.getHeight();
    const double fps = decoder.getFPS();

    std::cout << "Video: " << vidW << "x" << vidH
              << " @ " << fps << " fps, "
              << decoder.getDuration() << " s\n\n";

    // Window size: use video dimensions, capped to 1280x720
    int winW = vidW;
    int winH = vidH;
    if (winW > 1280 || winH > 720)
    {
        double scale = std::min(1280.0 / winW, 720.0 / winH);
        winW = static_cast<int>(winW * scale);
        winH = static_cast<int>(winH * scale);
    }

    VideoCompositor compositor;
    if (!compositor.initialize(winW, winH, "Xleth — Video Display"))
    {
        std::cerr << "[VideoDisplay] Failed to initialize compositor.\n";
        decoder.close();
        return;
    }

    const double frameDuration = (fps > 0.0) ? (1.0 / fps) : (1.0 / 30.0);
    int frameCount = 0;
    double totalUploadMs = 0.0;
    double totalRenderMs = 0.0;

    VideoDecoder::DecodedFrame frame;

    while (!compositor.shouldClose())
    {
        auto frameStart = std::chrono::high_resolution_clock::now();

        compositor.pollEvents();

        if (decoder.decodeNext(frame))
        {
            compositor.uploadFrame(
                frame.yPlane.data(), frame.uPlane.data(), frame.vPlane.data(),
                frame.width, frame.height,
                frame.yStride, frame.uStride, frame.vStride);

            compositor.render();

            ++frameCount;
            totalUploadMs += compositor.getLastUploadTimeMs();
            totalRenderMs += compositor.getLastRenderTimeMs();

            if (frameCount % 60 == 0)
            {
                std::printf("[Frame %d] upload: %.2f ms  render: %.2f ms  (avg upload: %.2f ms  avg render: %.2f ms)\n",
                            frameCount,
                            compositor.getLastUploadTimeMs(),
                            compositor.getLastRenderTimeMs(),
                            totalUploadMs / frameCount,
                            totalRenderMs / frameCount);
            }
        }
        else
        {
            // End of video — break out
            std::cout << "\n[VideoDisplay] End of video reached.\n";
            break;
        }

        // Sleep for remaining frame time to target source fps
        auto frameEnd = std::chrono::high_resolution_clock::now();
        double elapsed = std::chrono::duration<double>(frameEnd - frameStart).count();
        double sleepTime = frameDuration - elapsed;
        if (sleepTime > 0.0)
            std::this_thread::sleep_for(std::chrono::duration<double>(sleepTime));
    }

    std::printf("\n--- Summary ---\n"
                "Frames displayed: %d\n"
                "Avg upload time:  %.2f ms\n"
                "Avg render time:  %.2f ms\n"
                "Avg total:        %.2f ms\n\n",
                frameCount,
                frameCount > 0 ? totalUploadMs / frameCount : 0.0,
                frameCount > 0 ? totalRenderMs / frameCount : 0.0,
                frameCount > 0 ? (totalUploadMs + totalRenderMs) / frameCount : 0.0);

    if (frameCount > 0 && (totalUploadMs + totalRenderMs) / frameCount < 5.0)
        std::cout << "[PASS] Average upload + render < 5 ms per frame\n";
    else if (frameCount > 0)
        std::cout << "[NOTE] Average upload + render >= 5 ms per frame\n";

    compositor.shutdown();
    decoder.close();
    std::cout << "\n=== Video display test complete ===\n\n";
}

// ── Multi-layer composite test ──────────────────────────────────────────────

static void runCompositeTest(const std::string& videoPath)
{
    std::cout << "\n=== Multi-Layer Composite Test ===\n";
    std::cout << "File: " << videoPath << "\n\n";

    // Open 2 decoder instances (same file, different seek positions)
    VideoDecoder dec0, dec1;
    if (!dec0.open(videoPath) || !dec1.open(videoPath))
    {
        std::cerr << "[CompositeTest] Failed to open video file.\n";
        return;
    }

    const double duration = dec0.getDuration();
    std::cout << "Video: " << dec0.getWidth() << "x" << dec0.getHeight()
              << " @ " << dec0.getFPS() << " fps, " << duration << " s\n\n";

    // Create compositor window
    VideoCompositor compositor;
    if (!compositor.initialize(1280, 720, "Xleth — Composite Test"))
    {
        std::cerr << "[CompositeTest] Failed to initialize compositor.\n";
        dec0.close(); dec1.close();
        return;
    }

    // Create 2 texture sets (one per "source")
    int ts0 = compositor.createTextureSet(dec0.getWidth(), dec0.getHeight());
    int ts1 = compositor.createTextureSet(dec1.getWidth(), dec1.getHeight());

    // Seek to different positions and decode one frame each
    VideoDecoder::DecodedFrame frame0, frame1, frame2, frame3;

    double seekTimes[4] = { 0.0, 5.0, 10.0, 15.0 };
    // Clamp seek times to video duration
    for (auto& t : seekTimes)
        if (t >= duration) t = std::fmod(t, std::max(duration, 0.1));

    std::cout << "Decoding 4 frames at t=" << seekTimes[0] << "s, "
              << seekTimes[1] << "s, " << seekTimes[2] << "s, "
              << seekTimes[3] << "s\n";

    dec0.seekAndDecode(seekTimes[0], frame0);  // source 0, t=0:00
    dec1.seekAndDecode(seekTimes[1], frame1);  // source 1, t=0:05
    dec0.seekAndDecode(seekTimes[2], frame2);  // source 0, t=0:10
    dec1.seekAndDecode(seekTimes[3], frame3);  // source 1, t=0:15

    // We need 4 texture sets total (one per quadrant since each has different frame data)
    // ts0 already created, ts1 already created, create 2 more
    int ts2 = compositor.createTextureSet(dec0.getWidth(), dec0.getHeight());
    int ts3 = compositor.createTextureSet(dec1.getWidth(), dec1.getHeight());

    // Upload all 4 frames
    compositor.uploadFrameToSet(ts0,
        frame0.yPlane.data(), frame0.uPlane.data(), frame0.vPlane.data(),
        frame0.width, frame0.height, frame0.yStride, frame0.uStride, frame0.vStride);

    compositor.uploadFrameToSet(ts1,
        frame1.yPlane.data(), frame1.uPlane.data(), frame1.vPlane.data(),
        frame1.width, frame1.height, frame1.yStride, frame1.uStride, frame1.vStride);

    compositor.uploadFrameToSet(ts2,
        frame2.yPlane.data(), frame2.uPlane.data(), frame2.vPlane.data(),
        frame2.width, frame2.height, frame2.yStride, frame2.uStride, frame2.vStride);

    compositor.uploadFrameToSet(ts3,
        frame3.yPlane.data(), frame3.uPlane.data(), frame3.vPlane.data(),
        frame3.width, frame3.height, frame3.yStride, frame3.uStride, frame3.vStride);

    std::cout << "Upload complete. Last upload time: " << compositor.getLastUploadTimeMs() << " ms\n\n";

    // Configure 4 layers in a 2x2 grid
    // uPosition is the center of the quad, uScale is half-extent
    // Top-left:     center (-0.5, +0.5), scale (0.5, 0.5)
    // Top-right:    center (+0.5, +0.5), scale (0.5, 0.5)
    // Bottom-left:  center (-0.5, -0.5), scale (0.5, 0.5)
    // Bottom-right: center (+0.5, -0.5), scale (0.5, 0.5)

    compositor.setLayerCount(4);

    VideoLayer layer0 = { ts0, -0.5f,  0.5f, 0.5f, 0.5f, 1.0f, 0, true };  // top-left
    VideoLayer layer1 = { ts1,  0.5f,  0.5f, 0.5f, 0.5f, 1.0f, 1, true };  // top-right
    VideoLayer layer2 = { ts2, -0.5f, -0.5f, 0.5f, 0.5f, 1.0f, 2, true };  // bottom-left
    VideoLayer layer3 = { ts3,  0.5f, -0.5f, 0.5f, 0.5f, 1.0f, 3, true };  // bottom-right

    compositor.setLayer(0, layer0);
    compositor.setLayer(1, layer1);
    compositor.setLayer(2, layer2);
    compositor.setLayer(3, layer3);

    std::cout << "--- Phase 1: 2x2 grid (5 seconds) ---\n";

    auto phaseStart = std::chrono::high_resolution_clock::now();
    int renderCount = 0;
    double totalRenderMs = 0.0;

    // Phase 1: display 2x2 grid for 5 seconds
    while (!compositor.shouldClose())
    {
        compositor.pollEvents();
        compositor.renderComposite();

        ++renderCount;
        totalRenderMs += compositor.getLastRenderTimeMs();

        if (renderCount % 60 == 0)
        {
            std::printf("[Frame %d] render: %.2f ms  (avg: %.2f ms)\n",
                        renderCount,
                        compositor.getLastRenderTimeMs(),
                        totalRenderMs / renderCount);
        }

        auto now = std::chrono::high_resolution_clock::now();
        double elapsed = std::chrono::duration<double>(now - phaseStart).count();
        if (elapsed >= 5.0) break;

        std::this_thread::sleep_for(std::chrono::milliseconds(16)); // ~60fps
    }

    if (compositor.shouldClose())
    {
        std::cout << "\nWindow closed by user.\n";
        compositor.shutdown();
        dec0.close(); dec1.close();
        return;
    }

    // Phase 2: add 5th overlay layer at opacity 0.5, full screen
    std::cout << "\n--- Phase 2: adding full-screen overlay at 50%% opacity (5 seconds) ---\n";

    // Use ts0 (frame at t=0:00) as the overlay source
    compositor.setLayerCount(5);
    VideoLayer overlay = { ts0, 0.0f, 0.0f, 1.0f, 1.0f, 0.5f, 10, true };
    compositor.setLayer(4, overlay);

    auto phase2Start = std::chrono::high_resolution_clock::now();
    int phase2Renders = 0;
    double phase2RenderMs = 0.0;

    while (!compositor.shouldClose())
    {
        compositor.pollEvents();
        compositor.renderComposite();

        ++phase2Renders;
        phase2RenderMs += compositor.getLastRenderTimeMs();

        if (phase2Renders % 60 == 0)
        {
            std::printf("[Frame %d] render: %.2f ms  (avg: %.2f ms)\n",
                        renderCount + phase2Renders,
                        compositor.getLastRenderTimeMs(),
                        phase2RenderMs / phase2Renders);
        }

        auto now = std::chrono::high_resolution_clock::now();
        double elapsed = std::chrono::duration<double>(now - phase2Start).count();
        if (elapsed >= 5.0) break;

        std::this_thread::sleep_for(std::chrono::milliseconds(16));
    }

    // Summary
    int totalFrames = renderCount + phase2Renders;
    double allRenderMs = totalRenderMs + phase2RenderMs;

    std::printf("\n--- Summary ---\n"
                "Phase 1 (4 layers): %d frames, avg render: %.2f ms\n"
                "Phase 2 (5 layers): %d frames, avg render: %.2f ms\n"
                "Overall:            %d frames, avg render: %.2f ms\n\n",
                renderCount, renderCount > 0 ? totalRenderMs / renderCount : 0.0,
                phase2Renders, phase2Renders > 0 ? phase2RenderMs / phase2Renders : 0.0,
                totalFrames, totalFrames > 0 ? allRenderMs / totalFrames : 0.0);

    double avgComposite = totalFrames > 0 ? allRenderMs / totalFrames : 0.0;
    if (avgComposite < 8.0)
        std::cout << "[PASS] Average composite render < 8 ms\n";
    else
        std::cout << "[NOTE] Average composite render >= 8 ms\n";

    compositor.shutdown();
    dec0.close();
    dec1.close();
    std::cout << "\n=== Composite test complete ===\n\n";
}

// ── A/V sync test ───────────────────────────────────────────────────────────

static std::string findMediaPath()
{
    juce::File dir = juce::File::getSpecialLocation(
                         juce::File::currentExecutableFile)
                         .getParentDirectory();
    for (int d = 0; d < 8; ++d)
    {
        juce::File candidate = dir.getChildFile("media/source_clip.mp4");
        if (candidate.existsAsFile())
            return candidate.getFullPathName().toStdString();
        dir = dir.getParentDirectory();
    }
    return {};
}

static juce::File findMediaDir()
{
    juce::File dir = juce::File::getSpecialLocation(
                         juce::File::currentExecutableFile)
                         .getParentDirectory();
    for (int d = 0; d < 8; ++d)
    {
        if (dir.getChildFile("media").isDirectory())
            return dir.getChildFile("media");
        dir = dir.getParentDirectory();
    }
    return juce::File::getCurrentWorkingDirectory().getChildFile("media");
}

static void runAVSyncTest(const std::string& videoPath)
{
    std::cout << "\n===================================================\n"
              << "  A/V SYNC TEST — Drum Flash Visualizer\n"
              << "===================================================\n\n";

    constexpr double BPM         = 140.0;
    constexpr int    TOTAL_BEATS = 32;   // 8 bars of 4/4
    constexpr double TOTAL_SEC   = TOTAL_BEATS * (60.0 / BPM);

    // ── 1. Initialize audio engine ──────────────────────────────────────────
    AudioEngine audioEngine;
    if (!audioEngine.initialize())
    {
        std::cerr << "[AVSync] Failed to initialize audio engine.\n";
        return;
    }

    Transport& transport = audioEngine.getTransport();
    transport.setBPM(BPM);

    // ── 2. Load samples ─────────────────────────────────────────────────────
    SampleBank bank;
    juce::File mediaDir = findMediaDir();

    const char* sampleFiles[] = { "KICK_ssedit.wav", "SNARE_ssedit.wav", "hihat 1.wav" };
    for (const auto* fname : sampleFiles)
        bank.loadSample(mediaDir.getChildFile(fname), audioEngine.getSampleRate());

    if (bank.getNumSamples() < 3)
    {
        std::cerr << "[AVSync] Need 3 samples (kick/snare/hihat). Found "
                  << bank.getNumSamples() << ".\n";
        audioEngine.shutdown();
        return;
    }

    audioEngine.setSampleBank(&bank);

    std::cout << "Audio: " << audioEngine.getSampleRate() << " Hz, "
              << audioEngine.getBufferSize() << " samples buffer, "
              << audioEngine.getLatencyMs() << " ms latency\n";
    std::cout << "BPM: " << BPM << "  |  Duration: " << TOTAL_SEC << " s ("
              << TOTAL_BEATS << " beats)\n\n";

    // ── 3. Pre-load audio events into the scheduler ──────────────────────────
    // 8th-note 4-on-the-floor pattern for 8 bars:
    //   every 0.5 beats: kick / hihat / snare / hihat (repeating)
    // Events are queued before playback and fired sample-accurately from the
    // audio thread — no scheduler thread, no polling.
    std::vector<AudioEvent> events;
    events.reserve(TOTAL_BEATS * 2);

    AudioScheduler& scheduler = audioEngine.getAudioScheduler();
    for (int i = 0; i < TOTAL_BEATS * 2; ++i)
    {
        AudioEvent ev;
        ev.beatPosition = i * 0.5;
        ev.velocity     = 1.0f;
        switch (i % 4)
        {
            case 0: ev.sampleId = 0; break;  // kick
            case 1: ev.sampleId = 2; break;  // hihat
            case 2: ev.sampleId = 1; break;  // snare
            case 3: ev.sampleId = 2; break;  // hihat
        }
        events.push_back(ev);
        scheduler.addEvent(ev);
    }

    std::cout << "Scheduled " << events.size() << " events (sample-accurate, audio-thread-driven).\n\n";

    // ── 4. Initialize compositor ─────────────────────────────────────────────
    VideoCompositor compositor;
    if (!compositor.initialize(1280, 720, "Xleth — A/V Sync Test"))
    {
        std::cerr << "[AVSync] Failed to initialize compositor.\n";
        audioEngine.shutdown();
        return;
    }

    // ── 5. Decode thumbnail frames from the source video ────────────────────────
    // Kick @ 25 s, hihat @ 90 s, snare @ 121 s.
    // Decoding runs here on the main thread, before any audio/video threads start.
    VideoDecoder::DecodedFrame kickVF, hihatVF, snareVF;
    bool videoOk = false;

    if (!videoPath.empty())
    {
        VideoDecoder vdec;
        if (vdec.open(videoPath))
        {
            videoOk = vdec.seekAndDecode(25.0,  kickVF)
                   && vdec.seekAndDecode(90.0,  hihatVF)
                   && vdec.seekAndDecode(121.0, snareVF);
            vdec.close();
        }
        if (!videoOk)
            std::cerr << "[AVSync] Warning: video frame decode failed — using solid-color fallback.\n";
        else
            std::cout << "[AVSync] Decoded thumbnails: kick@25s, hihat@90s, snare@121s\n";
    }

    // ── 5b. Create texture sets and upload frames ────────────────────────────
    // Black background is always a tiny solid-color frame.
    constexpr int FBW = 64, FBH = 64;

    auto makeColorFrame = [](int w, int h, uint8_t y, uint8_t u, uint8_t v) -> CachedFrame
    {
        CachedFrame f;
        f.width = w; f.height = h;
        f.yStride = w; f.uStride = w / 2; f.vStride = w / 2;
        f.yPlane.assign(static_cast<size_t>(w * h), y);
        f.uPlane.assign(static_cast<size_t>((w / 2) * (h / 2)), u);
        f.vPlane.assign(static_cast<size_t>((w / 2) * (h / 2)), v);
        return f;
    };

    auto uploadFrame = [&](int ts, const CachedFrame& f)
    {
        compositor.uploadFrameToSet(ts,
            f.yPlane.data(), f.uPlane.data(), f.vPlane.data(),
            f.width, f.height, f.yStride, f.uStride, f.vStride);
    };

    // Black background
    CachedFrame blackFrame = makeColorFrame(FBW, FBH, 16, 128, 128);
    int tsBg = compositor.createTextureSet(FBW, FBH);
    uploadFrame(tsBg, blackFrame);

    // Drum thumbnails — real video frames if available, solid-color fallback otherwise
    int tsKick, tsHihat, tsSnare;

    if (videoOk)
    {
        tsKick  = compositor.createTextureSet(kickVF.width,  kickVF.height);
        tsHihat = compositor.createTextureSet(hihatVF.width, hihatVF.height);
        tsSnare = compositor.createTextureSet(snareVF.width, snareVF.height);

        compositor.uploadFrameToSet(tsKick,
            kickVF.yPlane.data(),  kickVF.uPlane.data(),  kickVF.vPlane.data(),
            kickVF.width,  kickVF.height,  kickVF.yStride,  kickVF.uStride,  kickVF.vStride);

        compositor.uploadFrameToSet(tsHihat,
            hihatVF.yPlane.data(), hihatVF.uPlane.data(), hihatVF.vPlane.data(),
            hihatVF.width, hihatVF.height, hihatVF.yStride, hihatVF.uStride, hihatVF.vStride);

        compositor.uploadFrameToSet(tsSnare,
            snareVF.yPlane.data(), snareVF.uPlane.data(), snareVF.vPlane.data(),
            snareVF.width, snareVF.height, snareVF.yStride, snareVF.uStride, snareVF.vStride);
    }
    else
    {
        // Solid-color fallback: red / pink / dark-green (BT.601 full-range)
        constexpr int FW = 64, FH = 64;
        CachedFrame kickCF  = makeColorFrame(FW, FH, 82,  90,  240);
        CachedFrame hihatCF = makeColorFrame(FW, FH, 192, 122, 159);
        CachedFrame snareCF = makeColorFrame(FW, FH, 93,  118, 72);
        tsKick  = compositor.createTextureSet(FW, FH);
        tsHihat = compositor.createTextureSet(FW, FH);
        tsSnare = compositor.createTextureSet(FW, FH);
        uploadFrame(tsKick,  kickCF);
        uploadFrame(tsHihat, hihatCF);
        uploadFrame(tsSnare, snareCF);
    }

    // ── 6. Configure layers — 3×3 grid, bottom row = drums ──────────────────
    // 16:9 screen (1280×720) divided into a 3×3 grid:
    //   NDC cell half-extents: 1/3 in x and y → each cell is 426×240 px (16:9)
    //   Column centres (x): -2/3, 0, +2/3
    //   Row centres   (y): +2/3 (top), 0 (mid), -2/3 (bottom)
    // Bottom row left→right: kick, hihat, snare.
    // Rows 0 and 1 show only the black background.
    compositor.setLayerCount(4);

    VideoLayer bgLayer    = { tsBg,     0.0000f,  0.0000f, 1.0000f, 1.0000f, 1.0f, 0, true  };
    VideoLayer kickLayer  = { tsKick,  -0.6667f, -0.6667f, 0.3333f, 0.3333f, 1.0f, 1, false };
    VideoLayer hihatLayer = { tsHihat,  0.0000f, -0.6667f, 0.3333f, 0.3333f, 1.0f, 2, false };
    VideoLayer snareLayer = { tsSnare,  0.6667f, -0.6667f, 0.3333f, 0.3333f, 1.0f, 3, false };

    compositor.setLayer(0, bgLayer);
    compositor.setLayer(1, kickLayer);
    compositor.setLayer(2, hihatLayer);
    compositor.setLayer(3, snareLayer);

    // Release GL context from main thread so the video thread can acquire it.
    compositor.releaseContext();

    // ── 6b. Set up playback decoders ─────────────────────────────────────────
    // Each decoder is opened once here. On every trigger (rising edge of
    // visibility) the video thread seeks back to the start timestamp and
    // decodes forward frame-by-frame while the box is visible.
    VideoDecoder kickDecoder, hihatDecoder, snareDecoder;
    bool kickDecodeOk = false, hihatDecodeOk = false, snareDecodeOk = false;
    constexpr double KICK_START  = 25.0;
    constexpr double HIHAT_START = 90.0;
    constexpr double SNARE_START = 121.0;

    if (videoOk)
    {
        kickDecodeOk  = kickDecoder.open(videoPath);
        hihatDecodeOk = hihatDecoder.open(videoPath);
        snareDecodeOk = snareDecoder.open(videoPath);

        if (kickDecodeOk && hihatDecodeOk && snareDecodeOk)
            std::cout << "[AVSync] Playback decoders ready: kick@25s  hihat@90s  snare@121s\n";
        else
            std::cerr << "[AVSync] Warning: one or more playback decoders failed to open.\n";
    }

    std::cout << "Layout: black bg + 3 boxes (kick/hihat/snare) at bottom.\n";
    std::cout << "Boxes flash on each beat trigger.\n\n";
    std::cout << "Controls: SPACE = start/pause   Z/X/C = kick/snare/hihat   R = reset   Q = quit\n\n"
              << std::flush;

    // ── 7. Shared state ──────────────────────────────────────────────────────
    std::atomic<bool> running     { true  };
    std::atomic<bool> started     { false };
    std::atomic<bool> windowClosed{ false };

    // ── 8. Input thread ──────────────────────────────────────────────────────
    std::thread inputThread([&]()
    {
        while (running.load(std::memory_order_relaxed))
        {
#if defined(_WIN32) || defined(_WIN64)
            if (!_kbhit()) { std::this_thread::sleep_for(std::chrono::milliseconds(10)); continue; }
            int ch = _getch();
#else
            int ch = std::getchar();
            if (ch == EOF) { std::this_thread::sleep_for(std::chrono::milliseconds(10)); continue; }
#endif
            switch (ch)
            {
                case ' ':
                    if (!started.load(std::memory_order_relaxed))
                    {
                        started.store(true, std::memory_order_relaxed);
                        transport.play();
                        std::cout << "[AVSync] Playback started!\n" << std::flush;
                    }
                    else if (transport.isPlaying())
                    {
                        transport.pause();
                        std::cout << "[AVSync] Paused\n" << std::flush;
                    }
                    else
                    {
                        transport.play();
                        std::cout << "[AVSync] Resumed\n" << std::flush;
                    }
                    break;
                case 'z': case 'Z': audioEngine.queueTrigger(0); break;  // kick
                case 'x': case 'X': audioEngine.queueTrigger(1); break;  // snare
                case 'c': case 'C': audioEngine.queueTrigger(2); break;  // hihat
                case 'r': case 'R':
                    // stop() resets position to 0; AudioScheduler detects the backward
                    // seek on the next audio buffer and re-arms all triggered_ flags.
                    transport.stop();
                    started.store(false, std::memory_order_relaxed);
                    std::cout << "[AVSync] Reset — all events re-armed. Press SPACE to start.\n"
                              << std::flush;
                    break;
                case 'q': case 'Q':
                    running.store(false, std::memory_order_relaxed);
                    break;
                default: break;
            }
        }
    });

    // (No scheduler thread — events fire sample-accurately from the audio callback.)

    // ── 9. Video thread (owns the GL context) ────────────────────────────────
    int videoTickCount = 0;

    std::thread videoThread([&]()
    {
        compositor.makeContextCurrent();

        VideoDecoder::DecodedFrame drumFrame;

        // Rising-edge detection: was each drum visible on the previous tick?
        bool wasKickVis = false, wasHihatVis = false, wasSnareVis = false;

        while (running.load(std::memory_order_relaxed))
        {
            if (windowClosed.load(std::memory_order_relaxed))
            {
                running.store(false, std::memory_order_relaxed);
                break;
            }

            ++videoTickCount;

            // ── Beat-driven layer visibility ──────────────────────────────────
            const double beat = transport.getPositionBeats();
            constexpr double FLASH = 0.5;

            bool kickVis = false, hihatVis = false, snareVis = false;
            for (const auto& ev : events)
            {
                const double age = beat - ev.beatPosition;
                if (age >= 0.0 && age < FLASH)
                {
                    if      (ev.sampleId == 0) kickVis  = true;
                    else if (ev.sampleId == 1) snareVis = true;
                    else if (ev.sampleId == 2) hihatVis = true;
                }
            }

            // ── Video playback: seek on trigger, decode forward while visible ─
            // Rising edge → seekAndDecode back to the start timestamp.
            // While still visible → decodeNext to advance one frame.
            // When hidden → do nothing (freeze; next trigger re-seeks).
            auto updateDrum = [&](bool vis, bool& wasVis, bool decodeOk,
                                  VideoDecoder& dec, double startSec, int tsId)
            {
                if (!decodeOk) return;

                if (vis && !wasVis)
                {
                    // Rising edge: seek back to start timestamp
                    dec.seekAndDecode(startSec, drumFrame);
                    compositor.uploadFrameToSet(tsId,
                        drumFrame.yPlane.data(), drumFrame.uPlane.data(), drumFrame.vPlane.data(),
                        drumFrame.width, drumFrame.height,
                        drumFrame.yStride, drumFrame.uStride, drumFrame.vStride);
                }
                else if (vis && wasVis)
                {
                    // Sustain: decode next frame forward
                    if (dec.decodeNext(drumFrame))
                        compositor.uploadFrameToSet(tsId,
                            drumFrame.yPlane.data(), drumFrame.uPlane.data(), drumFrame.vPlane.data(),
                            drumFrame.width, drumFrame.height,
                            drumFrame.yStride, drumFrame.uStride, drumFrame.vStride);
                }
                wasVis = vis;
            };

            updateDrum(kickVis,  wasKickVis,  kickDecodeOk,  kickDecoder,  KICK_START,  tsKick);
            updateDrum(hihatVis, wasHihatVis, hihatDecodeOk, hihatDecoder, HIHAT_START, tsHihat);
            updateDrum(snareVis, wasSnareVis, snareDecodeOk, snareDecoder, SNARE_START, tsSnare);

            kickLayer.visible  = kickVis;
            hihatLayer.visible = hihatVis;
            snareLayer.visible = snareVis;
            compositor.setLayer(1, kickLayer);
            compositor.setLayer(2, hihatLayer);
            compositor.setLayer(3, snareLayer);

            compositor.renderComposite();

            if (started.load(std::memory_order_relaxed) &&
                transport.getPositionBeats() >= static_cast<double>(TOTAL_BEATS))
            {
                transport.pause();
                running.store(false, std::memory_order_relaxed);
                break;
            }

            std::this_thread::sleep_for(std::chrono::microseconds(16000)); // ~60 Hz
        }
    });

    // ── 10. Main loop — GLFW events + JUCE messages ──────────────────────────
    auto* mm = juce::MessageManager::getInstance();
    while (running.load(std::memory_order_relaxed))
    {
        compositor.pollEvents();
        if (compositor.shouldClose())
        {
            windowClosed.store(true, std::memory_order_relaxed);
            running.store(false, std::memory_order_relaxed);
            break;
        }
        mm->runDispatchLoopUntil(8);
    }

    // ── 11. Shutdown ─────────────────────────────────────────────────────────
    inputThread.join();
    videoThread.join();

    // ── 12. Sync report ──────────────────────────────────────────────────────
    const double durationSec = transport.getPositionSeconds();
    const double actualFps   = (durationSec > 0.0)
                               ? static_cast<double>(videoTickCount) / durationSec
                               : 0.0;
    const bool passFps = actualFps > 55.0;

    std::printf(
        "\n"
        "+------------------------------------+\n"
        "| A/V SYNC REPORT                    |\n"
        "+------------------------------------+\n"
        "| Duration:        %5.1f seconds     |\n"
        "| Video tick rate: %5.1f fps         |\n"
        "| Scheduled events: %-3d              |\n"
        "| RESULT: %-27s|\n"
        "+------------------------------------+\n\n",
        durationSec,
        actualFps,
        static_cast<int>(events.size()),
        passFps ? "[PASS]" : "[FAIL]");

    if (!passFps) std::printf("  [FAIL] Video tick rate < 55 fps (%.1f fps)\n", actualFps);
    if (passFps)  std::cout << "  All criteria passed!\n";

    compositor.shutdown();
    audioEngine.shutdown();

    std::cout << "\n=== A/V sync test complete ===\n\n";
}

// ── main ─────────────────────────────────────────────────────────────────────

int main(int argc, char** argv)
{
    juce::ScopedJuceInitialiser_GUI juceInit;

    std::cout << "Xleth Engine v0.0.1 — Phase 0\n" << std::endl;

    // ── Video decode test mode (--video-test [path]) ──────────────────────────
    for (int i = 1; i < argc; ++i)
    {
        if (std::string(argv[i]) == "--video-test")
        {
            std::string path = "media/source_clip.mp4";

            // Walk up from exe to find the media folder, same logic as samples below
            {
                juce::File dir = juce::File::getSpecialLocation(
                                     juce::File::currentExecutableFile)
                                     .getParentDirectory();
                for (int d = 0; d < 8; ++d)
                {
                    juce::File candidate = dir.getChildFile("media/source_clip.mp4");
                    if (candidate.existsAsFile())
                    {
                        path = candidate.getFullPathName().toStdString();
                        break;
                    }
                    dir = dir.getParentDirectory();
                }
                // Allow explicit override: --video-test /path/to/file.mp4
                if (i + 1 < argc && argv[i + 1][0] != '-')
                    path = argv[++i];
            }

            runVideoDecodeTest(path);
            return 0;
        }

        if (std::string(argv[i]) == "--cache-bench")
        {
            runCacheBenchmark();
            return 0;
        }

        if (std::string(argv[i]) == "--proxy-bench")
        {
            std::string path;

            // Walk up from exe to find media/source_clip.mp4 as default
            {
                juce::File dir = juce::File::getSpecialLocation(
                                     juce::File::currentExecutableFile)
                                     .getParentDirectory();
                for (int d = 0; d < 8; ++d)
                {
                    juce::File candidate = dir.getChildFile("media/source_clip.mp4");
                    if (candidate.existsAsFile())
                    {
                        path = candidate.getFullPathName().toStdString();
                        break;
                    }
                    dir = dir.getParentDirectory();
                }
                // Allow explicit path: --proxy-bench /path/to/file.mp4
                if (i + 1 < argc && argv[i + 1][0] != '-')
                    path = argv[++i];
            }

            if (path.empty())
            {
                std::cerr << "Usage: XlethEngine --proxy-bench [path_to_video]\n";
                return 1;
            }

            runProxyBenchmark(path);
            return 0;
        }

        if (std::string(argv[i]) == "--video-display")
        {
            std::string path;

            // Walk up from exe to find media/source_clip.mp4 as default
            {
                juce::File dir = juce::File::getSpecialLocation(
                                     juce::File::currentExecutableFile)
                                     .getParentDirectory();
                for (int d = 0; d < 8; ++d)
                {
                    juce::File candidate = dir.getChildFile("media/source_clip.mp4");
                    if (candidate.existsAsFile())
                    {
                        path = candidate.getFullPathName().toStdString();
                        break;
                    }
                    dir = dir.getParentDirectory();
                }
                // Allow explicit path: --video-display /path/to/file.mp4
                if (i + 1 < argc && argv[i + 1][0] != '-')
                    path = argv[++i];
            }

            if (path.empty())
            {
                std::cerr << "Usage: XlethEngine --video-display [path_to_video]\n";
                return 1;
            }

            runVideoDisplayTest(path);
            return 0;
        }

        if (std::string(argv[i]) == "--composite-test")
        {
            std::string path;

            {
                juce::File dir = juce::File::getSpecialLocation(
                                     juce::File::currentExecutableFile)
                                     .getParentDirectory();
                for (int d = 0; d < 8; ++d)
                {
                    juce::File candidate = dir.getChildFile("media/source_clip.mp4");
                    if (candidate.existsAsFile())
                    {
                        path = candidate.getFullPathName().toStdString();
                        break;
                    }
                    dir = dir.getParentDirectory();
                }
                if (i + 1 < argc && argv[i + 1][0] != '-')
                    path = argv[++i];
            }

            if (path.empty())
            {
                std::cerr << "Usage: XlethEngine --composite-test [path_to_video]\n";
                return 1;
            }

            runCompositeTest(path);
            return 0;
        }

        if (std::string(argv[i]) == "--av-sync")
        {
            std::string path;

            // Try auto-detect, allow explicit override
            path = findMediaPath();
            if (i + 1 < argc && argv[i + 1][0] != '-')
                path = argv[++i];

            if (path.empty())
            {
                std::cerr << "Usage: XlethEngine --av-sync [path_to_video]\n";
                return 1;
            }

            runAVSyncTest(path);
            return 0;
        }
    }

    // ── Audio engine ──────────────────────────────────────────────────────────
    AudioEngine engine;
    if (!engine.initialize())
    {
        std::cerr << "Failed to initialize audio engine. Exiting.\n";
        return 1;
    }

    // ── Sample bank ───────────────────────────────────────────────────────────
    SampleBank bank;
    // Media lives at the project root, not next to the exe.
    // Walk up from the exe until we find the media/ folder.
    juce::File mediaDir;
    {
        juce::File dir = juce::File::getSpecialLocation(juce::File::currentExecutableFile)
                             .getParentDirectory();
        for (int i = 0; i < 8; ++i)
        {
            if (dir.getChildFile("media").isDirectory())
                { mediaDir = dir.getChildFile("media"); break; }
            dir = dir.getParentDirectory();
        }
        if (mediaDir == juce::File{})
        {
            std::cerr << "Could not find media/ folder.\n";
            mediaDir = juce::File::getCurrentWorkingDirectory().getChildFile("media");
        }
    }

    const char* testFiles[] = { "KICK_ssedit.wav", "SNARE_ssedit.wav", "hihat 1.wav" };
    for (const auto* fname : testFiles)
        bank.loadSample(mediaDir.getChildFile(fname), engine.getSampleRate());

    std::cout << "\nLoaded " << bank.getNumSamples() << " sample(s).\n";

    // Connect bank to engine — must happen before audio thread starts reading it
    engine.setSampleBank(&bank);

    // Convenience reference to transport
    Transport& transport = engine.getTransport();

    // ── Key input thread ──────────────────────────────────────────────────────
    std::cout << "\nControls:\n"
              << "  Z = kick   X = snare   C = hihat\n"
              << "  SPACE = play/pause   R = stop (reset)\n"
              << "  Q = quit\n\n" << std::flush;

    std::atomic<bool> running{ true };

    std::thread inputThread([&]()
    {
        while (running.load(std::memory_order_relaxed))
        {
#if defined(_WIN32) || defined(_WIN64)
            const int ch = _getch();
            if (ch == -1) { juce::Thread::sleep(10); continue; } // EOF / no console
#else
            const int ch = std::getchar();
            if (ch == EOF) { juce::Thread::sleep(10); continue; }
#endif
            switch (ch)
            {
                case 'z': case 'Z': engine.queueTrigger(0); break;
                case 'x': case 'X': engine.queueTrigger(1); break;
                case 'c': case 'C': engine.queueTrigger(2); break;
                case ' ':
                    if (transport.isPlaying())
                    {
                        transport.pause();
                        std::cout << "[Transport] Paused\n" << std::flush;
                    }
                    else
                    {
                        transport.play();
                        std::cout << "[Transport] Playing\n" << std::flush;
                    }
                    break;
                case 'r': case 'R':
                    transport.stop();
                    std::cout << "[Transport] Stopped — position reset to 00:00.000\n" << std::flush;
                    break;
                case 'q': case 'Q':
                    running.store(false, std::memory_order_relaxed);
                    break;
                default: break;
            }
        }
    });

    // ── Transport monitor thread — prints state every 500 ms while playing ───
    std::thread monitorThread([&]()
    {
        while (running.load(std::memory_order_relaxed))
        {
            if (transport.isPlaying())
            {
                const double secs    = transport.getPositionSeconds();
                const int    totalMs = static_cast<int>(secs * 1000.0);
                const int    mm      = totalMs / 60000;
                const int    ss      = (totalMs % 60000) / 1000;
                const int    ms      = totalMs % 1000;
                const double beats   = transport.getPositionBeats();
                const int    bar     = transport.getPositionBars();
                const double bpm     = transport.getBPM();

                std::printf("Position: %02d:%02d.%03d | Beat: %5.2f | Bar: %d | BPM: %.0f\n",
                            mm, ss, ms, beats, bar, bpm);
                std::fflush(stdout);
            }
            std::this_thread::sleep_for(std::chrono::milliseconds(500));
        }
    });

    // ── Main loop — pump JUCE messages until quit ─────────────────────────────
    auto* mm = juce::MessageManager::getInstance();
    while (running.load(std::memory_order_relaxed))
        mm->runDispatchLoopUntil(50);

    inputThread.join();
    monitorThread.join();
    engine.shutdown();

    std::cout << "Done. Clean exit.\n";
    return 0;
}
