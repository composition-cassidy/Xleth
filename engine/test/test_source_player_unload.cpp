// test_source_player_unload.cpp -- SourcePlayer buffer lifetime under load/unload churn.
//
// Regression for the Sample Picker preview race: unloadSource() freed the
// decoded buffer while the audio callback could still be inside processBlock()
// reading it, so clicking source B while A previewed read freed memory (noise
// burst or crash).
//
// One thread plays the audio-callback role and calls processBlock() back to
// back; the main thread (the bridge's role) loads, plays and unloads three
// sources. Each source is a constant-valued float WAV, so every block must hold
// exactly one source's constant followed by silence. Sources are 10 s stereo
// (3.8 MB) so the Windows heap returns them to the OS on free, which turns a
// use-after-free into an access violation instead of a silent stale read.
// Blocks are large and each switch lands after a random delay so the free
// falls inside processBlock's read loop often enough to matter.
//
// Build: cmake --build build --target test_source_player_unload --config Release
// Run:   ctest --test-dir build -C Release -R "^test_source_player_unload$" -V

#include "audio/SourcePlayer.h"

#include <juce_audio_formats/juce_audio_formats.h>

#include <atomic>
#include <chrono>
#include <iostream>
#include <random>
#include <thread>

static int g_passed = 0;
static int g_failed = 0;

#define CHECK(cond, msg)                                                      \
    do {                                                                      \
        if (cond) {                                                           \
            ++g_passed;                                                       \
        } else {                                                              \
            std::cerr << "  FAIL [" << __LINE__ << "] " << msg << "\n";       \
            ++g_failed;                                                       \
        }                                                                     \
    } while (0)

// The friend SourcePlayer names for tests: reaches the pin (the one-slot hazard
// pointer processBlock sets while it reads a buffer) and the retire list.
struct SourcePlayerTestAccess
{
    using Buffer = juce::AudioBuffer<float>;
    static Buffer* current(SourcePlayer& sp) { return sp.current_.load(std::memory_order_seq_cst); }
    // What a callback stuck inside its block looks like to unloadSource.
    static void holdPin(SourcePlayer& sp, Buffer* b) { sp.inUse_.store(b, std::memory_order_seq_cst); }
    static void releasePin(SourcePlayer& sp) { sp.inUse_.store(nullptr, std::memory_order_release); }
    static size_t   retiredCount(const SourcePlayer& sp)  { return sp.retired_.size(); }
    static uint64_t deferredFrees(const SourcePlayer& sp) { return sp.deferredFrees_; }
    static int      unloadWaitMs() { return SourcePlayer::kUnloadWaitMs; }
};

static constexpr double kRate      = 48000.0;
static constexpr int    kBlock     = 16384;
static constexpr float  kLevels[3] = { 0.25f, 0.5f, 0.75f };   // exact in float WAV

static bool writeConstantWav(const juce::File& file, float level, int numSamples)
{
    juce::AudioBuffer<float> buf(2, numSamples);
    for (int ch = 0; ch < 2; ++ch)
        juce::FloatVectorOperations::fill(buf.getWritePointer(ch), level, numSamples);

    file.deleteFile();
    juce::WavAudioFormat fmt;
    std::unique_ptr<juce::FileOutputStream> out(file.createOutputStream());
    if (!out) return false;
    std::unique_ptr<juce::AudioFormatWriter> writer(
        fmt.createWriterFor(out.get(), kRate, 2, 32, {}, 0));
    if (!writer) return false;
    out.release();   // the writer owns the stream now
    return writer->writeFromAudioSampleBuffer(buf, 0, numSamples);
}

// A block is valid iff both channels are one known level for a prefix, then 0.
static bool blockIsClean(const juce::AudioBuffer<float>& buf, float& levelOut)
{
    const float v = buf.getReadPointer(0)[0];
    if (v != 0.0f && v != kLevels[0] && v != kLevels[1] && v != kLevels[2])
        return false;
    for (int ch = 0; ch < 2; ++ch)
    {
        const float* p = buf.getReadPointer(ch);
        bool tail = (v == 0.0f);
        for (int i = 0; i < kBlock; ++i)
        {
            if (!tail && p[i] == 0.0f) tail = true;
            if (p[i] != (tail ? 0.0f : v)) return false;
        }
    }
    levelOut = v;
    return true;
}

int main()
{
    std::cout << "test_source_player_unload\n";

    const juce::File dir = juce::File::getSpecialLocation(juce::File::tempDirectory)
                               .getChildFile("xleth_source_player_unload");
    dir.createDirectory();
    std::string paths[3];
    for (int i = 0; i < 3; ++i)
    {
        const juce::File f = dir.getChildFile("src" + juce::String(i) + ".wav");
        if (!writeConstantWav(f, kLevels[i], static_cast<int>(kRate) * 10))
        {
            std::cerr << "  could not write " << f.getFullPathName() << "\n";
            return 1;
        }
        paths[i] = f.getFullPathName().toStdString();
    }

    SourcePlayer sp;

    // Sanity: a single load decodes the constant exactly.
    CHECK(sp.loadSource(paths[0], kRate), "load source 0");
    sp.play(0.0);
    {
        juce::AudioBuffer<float> buf(2, kBlock);
        buf.clear();
        sp.processBlock(buf, kBlock);
        CHECK(buf.getReadPointer(0)[0] == kLevels[0]
              && buf.getReadPointer(1)[kBlock - 1] == kLevels[0],
              "single-threaded block is source 0's constant");
    }
    sp.unloadSource();

    // ── Concurrent churn ─────────────────────────────────────────────────────
    std::atomic<bool>     stop    { false };
    std::atomic<uint64_t> blocks  { 0 };
    std::atomic<int>      bad     { 0 };
    std::atomic<int>      heard[3] { {0}, {0}, {0} };

    std::thread audio([&] {
        juce::AudioBuffer<float> buf(2, kBlock);
        while (!stop.load(std::memory_order_acquire))
        {
            buf.clear();
            sp.processBlock(buf, kBlock);
            float level = 0.0f;
            if (!blockIsClean(buf, level))
                bad.fetch_add(1, std::memory_order_relaxed);
            else
                for (int i = 0; i < 3; ++i)
                    if (level == kLevels[i]) heard[i].fetch_add(1, std::memory_order_relaxed);
            blocks.fetch_add(1, std::memory_order_release);
        }
    });

    // Let the callback get into a playing source, then switch after a random
    // busy-wait so the free lands at a random point of the next block's read.
    std::mt19937 rng(1234);
    std::uniform_int_distribution<int> jitterUs(0, 60);
    auto letCallbackRun = [&] {
        const uint64_t target = blocks.load(std::memory_order_acquire) + 2;
        while (blocks.load(std::memory_order_acquire) < target)
            std::this_thread::yield();
        const auto until = std::chrono::steady_clock::now()
                         + std::chrono::microseconds(jitterUs(rng));
        while (std::chrono::steady_clock::now() < until) {}
    };

    constexpr int kIterations = 300;
    int loadFailures = 0;
    for (int it = 0; it < kIterations; ++it)
    {
        if (!sp.loadSource(paths[it % 3], kRate)) ++loadFailures;   // A -> B swap
        sp.play(0.0);
        letCallbackRun();
        if (it % 4 == 3)
        {
            sp.unloadSource();                                       // explicit unload
            letCallbackRun();
        }
    }

    stop.store(true, std::memory_order_release);
    audio.join();

    CHECK(loadFailures == 0, "every load succeeded (" << loadFailures << " failed)");
    CHECK(bad.load() == 0, bad.load() << " of " << blocks.load()
                                      << " blocks held garbage or mixed sources");
    for (int i = 0; i < 3; ++i)
        CHECK(heard[i].load() > 0, "source " << i << " was actually heard");

    sp.unloadSource();
    CHECK(!sp.isLoaded(), "unloaded after churn");
    {
        juce::AudioBuffer<float> buf(2, kBlock);
        buf.clear();
        sp.play(0.0);
        sp.processBlock(buf, kBlock);
        CHECK(buf.getMagnitude(0, kBlock) == 0.0f, "unloaded player renders silence");
    }

    // ── Bounded unload: the callback holds its pin for ~200 ms ───────────────
    // A stalled device leaves processBlock inside its block with the pin set.
    // unloadSource must come back within its bound anyway, must not free the
    // pinned buffer, and the buffer must be freed once the pin is gone.
    {
        using Clock = std::chrono::steady_clock;
        using Access = SourcePlayerTestAccess;
        const auto msSince = [](Clock::time_point t) {
            return std::chrono::duration<double, std::milli>(Clock::now() - t).count();
        };
        const double bound = Access::unloadWaitMs();
        const double slack = 150.0;   // scheduler quantum, and ASAN

        CHECK(sp.loadSource(paths[0], kRate), "load source 0 for the bounded unload");
        Access::Buffer* const held = Access::current(sp);
        CHECK(held != nullptr && Access::retiredCount(sp) == 0, "a buffer is published and nothing is parked");
        if (held == nullptr) return 1;
        const int last = held->getNumSamples() - 1;
        // Reading the buffer is the canary: it holds source 0's constant end to
        // end, and under ASAN a read after a free aborts the test.
        const auto intact = [&] {
            return held->getReadPointer(0)[0] == kLevels[0] && held->getReadPointer(1)[last] == kLevels[0];
        };

        const auto holdStart = Clock::now();
        Access::holdPin(sp, held);

        auto t = Clock::now();
        sp.unloadSource();
        const double waited = msSince(t);
        CHECK(waited >= bound - 5.0, "unloadSource waited for the pin (" << waited << " ms)");
        CHECK(waited <= bound + slack, "unloadSource returned within its bound (" << waited
                                       << " ms, bound " << bound << ")");
        CHECK(!sp.isLoaded(), "the source is unloaded as far as callers can tell");
        CHECK(Access::retiredCount(sp) == 1 && Access::deferredFrees(sp) == 1,
              "the pinned buffer is parked, not freed");
        CHECK(intact(), "and is still intact");

        // Life goes on while it is parked.
        CHECK(sp.loadSource(paths[1], kRate), "another source loads while the old buffer is parked");
        CHECK(Access::current(sp) != held && Access::retiredCount(sp) == 1 && intact(),
              "the parked buffer is untouched by the load");
        t = Clock::now();
        sp.unloadSource();
        const double second = msSince(t);
        CHECK(second < bound - 10.0, "a later unload does not wait for the parked buffer again ("
                                     << second << " ms)");
        CHECK(Access::retiredCount(sp) == 1 && Access::deferredFrees(sp) == 1,
              "its own buffer was freed at once; the parked one stays, counted once");

        while (msSince(holdStart) < 200.0)
            std::this_thread::sleep_for(std::chrono::milliseconds(5));
        CHECK(Access::retiredCount(sp) == 1 && intact(), "still not freed after 200 ms pinned");

        Access::releasePin(sp);
        sp.unloadSource();               // any later load / unload sweeps it up
        CHECK(Access::retiredCount(sp) == 0, "freed once the pin is released");
    }

    // A player destroyed while its buffer is pinned leaks the buffer rather
    // than free it under a thread that may be reading.
    {
        using Access = SourcePlayerTestAccess;
        Access::Buffer* held = nullptr;
        {
            SourcePlayer doomed;
            CHECK(doomed.loadSource(paths[2], kRate), "load a source into a short-lived player");
            held = Access::current(doomed);
            if (held != nullptr) Access::holdPin(doomed, held);
        }
        CHECK(held != nullptr && held->getReadPointer(0)[0] == kLevels[2],
              "a buffer pinned at destruction is left alive");
        delete held;                     // the test owns the deliberate leak
    }

    dir.deleteRecursively();

    std::cout << "  blocks=" << blocks.load()
              << " heard=" << heard[0].load() << "/" << heard[1].load() << "/" << heard[2].load()
              << "\n";
    std::cout << (g_failed == 0 ? "PASS" : "FAIL")
              << " (" << g_passed << " passed, " << g_failed << " failed)\n";
    return g_failed == 0 ? 0 : 1;
}
