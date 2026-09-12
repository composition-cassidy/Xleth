#include <juce_core/juce_core.h>
#include <juce_events/juce_events.h>

#include "AudioEngine.h"
#include "FrameCache.h"
#include "SampleBank.h"
#include "VideoDecoder.h"
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
