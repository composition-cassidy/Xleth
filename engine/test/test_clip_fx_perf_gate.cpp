// test_clip_fx_perf_gate.cpp — Pitch Shifter Clip mode (mode 4): permanent
// perf regression gate.
//
// Build: see engine/CMakeLists.txt target "test_clip_fx_perf_gate"
// Run:   ctest --test-dir build -C Release -R "^test_clip_fx_perf_gate$" -V
// Pass:  prints "ALL TESTS PASSED" and exits 0
//
// Two permanent gates, mirroring bridge/test_perf_regression.js's role for
// preview FPS — this is the equivalent standing guard for mode 4's two
// blast-radius risks: render storm + cache growth, and per-block allocation
// on the audio path. test_clip_fx_transform.cpp's [6]/[7] prove these
// properties hold TODAY; this file exists so a future change that breaks
// either one fails a test by name instead of being noticed as a slowdown.
//
//   [A] 64-clip track, sweep clip_semitones across its full +/-24 st range
//       (PitchShifterPanel.jsx's CLIP_SEMITONES_KNOB) with the settle
//       debounce active: total submitted render jobs for the whole sweep
//       must stay <= 64 (one per clip, not one per clip per sweep step), and
//       the process's peak working set must not grow by more than 256 MB —
//       half of ClipRenderCache::kDefaultMaxBytes (512 MB), which bounds the
//       CACHE's own buffer bytes and is the structural backstop this gate
//       sits in front of. The 64-clip fx-lane footprint here is ~64 buffers
//       of a few tens of KB each (a few MB total); 256 MB leaves roughly two
//       orders of magnitude of headroom for process-level noise (thread pool
//       stacks, CRT heap fragmentation) while still catching a debounce or
//       eviction regression long before it reaches even half the cache's own
//       ceiling.
//   [B] 100-clip session, Clip mode active on every clip's track, steady
//       playback through processBlock(): allocation count must be IDENTICAL,
//       block for block, to the same 100 clips with Clip mode inactive.
//       processBlock already allocates at baseline (measured differentially
//       in test_clip_fx_transform.cpp's [6]) — the gate is that mode 4 adds
//       NONE of its own, the same differential technique scaled from one
//       clip to a session size.
//
// Both reuse the shared driver in clip_fx_test_scenarios.h so a regression
// here cannot be explained by a different render path than the feature tests
// already cover.

#include "clip_fx_test_scenarios.h"

#include "audio/ClipRenderCache.h"

#include <juce_audio_processors/juce_audio_processors.h>
#include <juce_core/juce_core.h>
#include <juce_events/juce_events.h>
#include <juce_gui_basics/juce_gui_basics.h>

#include <atomic>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <iostream>
#include <new>
#include <vector>

#if defined(_WIN32)
  #define WIN32_LEAN_AND_MEAN
  #include <windows.h>
  #include <psapi.h>
#endif

// ─── Counting allocator (this thread only, only while armed) ────────────────

namespace {
thread_local bool      t_countAllocs = false;
std::atomic<long long> g_allocCount { 0 };

inline void countAlloc() noexcept
{
    if (t_countAllocs) g_allocCount.fetch_add(1, std::memory_order_relaxed);
}
} // namespace

void* operator new(std::size_t n)                 { countAlloc(); void* p = std::malloc(n ? n : 1); if (!p) std::abort(); return p; }
void* operator new[](std::size_t n)               { countAlloc(); void* p = std::malloc(n ? n : 1); if (!p) std::abort(); return p; }
void* operator new(std::size_t n, const std::nothrow_t&) noexcept   { countAlloc(); return std::malloc(n ? n : 1); }
void* operator new[](std::size_t n, const std::nothrow_t&) noexcept { countAlloc(); return std::malloc(n ? n : 1); }
void  operator delete(void* p) noexcept                    { std::free(p); }
void  operator delete[](void* p) noexcept                  { std::free(p); }
void  operator delete(void* p, std::size_t) noexcept       { std::free(p); }
void  operator delete[](void* p, std::size_t) noexcept     { std::free(p); }
void  operator delete(void* p, const std::nothrow_t&) noexcept   { std::free(p); }
void  operator delete[](void* p, const std::nothrow_t&) noexcept { std::free(p); }

// ─── Harness ─────────────────────────────────────────────────────────────────

static int g_passed = 0;
static int g_failed = 0;

#define CHECK(cond, msg)                                                 \
    do {                                                                 \
        if (cond) {                                                      \
            ++g_passed;                                                  \
        } else {                                                         \
            std::cerr << "  FAIL [" << __LINE__ << "] " << msg << "\n";  \
            ++g_failed;                                                  \
        }                                                                \
    } while (0)

using namespace clipfx_test;

// kReady/waitUntil are per-file helpers in the driver's own tests (not part of
// clip_fx_test_scenarios.h), so each test file that uses buildRig()/warm=true
// defines its own copy — same as test_clip_fx_transform.cpp's.
static const ReadyFn kReady = [](MixEngine& e, int id) { return e.isClipCacheReady(id); };

static bool waitUntil(const std::function<bool()>& pred, int timeoutMs = 60000)
{
    const auto deadline = std::chrono::steady_clock::now() + std::chrono::milliseconds(timeoutMs);
    while (std::chrono::steady_clock::now() < deadline)
    {
        if (pred()) return true;
        std::this_thread::sleep_for(std::chrono::milliseconds(2));
    }
    return pred();
}

// ─── RSS helper ──────────────────────────────────────────────────────────────

// Peak working set since process start. Monotonic by construction, so
// (after - before) around a test window is exactly that window's contribution
// to the process's high-water mark — no separate "reset peak" API exists on
// Windows, but none is needed for a delta measurement.
static std::size_t peakWorkingSetBytes()
{
#if defined(_WIN32)
    PROCESS_MEMORY_COUNTERS pmc{};
    if (GetProcessMemoryInfo(GetCurrentProcess(), &pmc, sizeof(pmc)))
        return static_cast<std::size_t>(pmc.PeakWorkingSetSize);
    return 0;
#else
    return 0;
#endif
}

// ─── Shared: append (count-1) more clips to a rig's track ─────────────────────
// Distinct, non-overlapping slices so every clip is a distinct CacheKey (no
// byKey_ content-sharing masking the per-clip cost). Mirrors the 64-clip setup
// test_clip_fx_transform.cpp's testRenderStorm uses.
static std::vector<int> addMoreClips(Rig& rig, int count)
{
    std::vector<int> ids { rig.clipId };
    const Clip proto = *rig.timeline->getClip(rig.clipId);
    for (int i = 1; i < count; ++i)
    {
        Clip c = proto;
        c.position     = TickTime::fromBeats(0.25 + 0.1 * i);
        c.duration     = TickTime::fromBeats(0.1);
        c.regionOffset = TickTime::fromBeats(0.01 * i);
        ids.push_back(rig.timeline->addClip(c));
    }
    return ids;
}

// ─── [A] Render storm: bounded job count + bounded peak RSS delta ────────────

static void testBoundedRenderStorm()
{
    std::cout << "\n[A] 64-clip track, full-range semitone sweep: bounded jobs + bounded RSS\n";

    constexpr int         kClips        = 64;
    constexpr std::size_t kRssBoundBytes = 256ull * 1024ull * 1024ull;   // see file header

    Scenario s;
    auto rig = buildRig(s, kReady);
    auto& e = *rig.engine;
    auto& cache = e.getClipRenderCache();
    const auto ids = addMoreClips(rig, kClips);

    const std::size_t rssBefore = peakWorkingSetBytes();

    const int node = e.addEffect(rig.trackId, "pitchshifter", 0);
    e.setEffectParameter(rig.trackId, node, "mode", 3.0f);
    e.setEffectParameter(rig.trackId, node, "clip_semitones", 1.0f);
    const int64_t  t0 = ClipRenderCache::nowMs() + 200000;   // synthetic clock, ahead of real time
    e.pollSourceTransformTableAt(t0, true);
    e.flushSourceTransformInvalidations(t0 + MixEngine::kSourceTransformSettleMs);
    CHECK(waitUntil([&] { for (int id : ids) if (!e.isClipCacheReady(id)) return false; return true; }),
          "initial 64-clip render complete");

    // The gate measures the SWEEP's own job count, not the one-time cost of
    // turning Clip mode on — jobs0 is the baseline AFTER the initial batch
    // (64 jobs, one per clip) has already settled and rendered.
    const uint64_t jobs0 = cache.submittedRenderCount();

    Transport transport;
    transport.setSampleRate(s.exportRate); transport.setBPM(s.bpm);
    transport.seekToSample(0); transport.play();
    juce::AudioBuffer<float> block(2, 512);

    // 25 steps, 2 st apart, covering the full +/-24 st knob range, each 40 ms
    // apart — every step lands inside the previous one's settle window.
    int64_t t = t0 + 1000;
    for (int semis = -24; semis <= 24; semis += 2, t += 40)
    {
        e.setEffectParameter(rig.trackId, node, "clip_semitones", static_cast<float>(semis));
        e.pollSourceTransformTableAt(t, true);
        for (int b = 0; b < 4; ++b)   // play through the track: stale-key misses pile up, like real playback
        {
            block.clear();
            e.processBlock(block, 512, transport);
            transport.advance(512);
        }
        e.serviceClipRenderCache();   // drains those misses — must not resubmit a settling track
    }
    e.flushSourceTransformInvalidations(t - 40 + MixEngine::kSourceTransformSettleMs);
    CHECK(waitUntil([&] { for (int id : ids) if (!e.isClipCacheReady(id)) return false; return true; }),
          "final settled render complete");

    const uint64_t    jobsTotal = cache.submittedRenderCount() - jobs0;
    const std::size_t rssAfter  = peakWorkingSetBytes();
    const std::size_t rssDelta  = (rssAfter > rssBefore) ? (rssAfter - rssBefore) : 0;

    std::cout << "    jobs submitted for the whole sweep: " << jobsTotal
              << " (undebounced would be " << kClips << " clips x 25 steps = " << kClips * 25 << ")\n";
    std::cout << "    peak working set: +" << (rssDelta / 1024) << " KB (bound "
              << (kRssBoundBytes / (1024 * 1024)) << " MB)\n";

    CHECK(jobsTotal <= static_cast<uint64_t>(kClips),
          "bounded: at most one job per clip survives the debounce across the whole sweep (" << jobsTotal << ")");
    CHECK(rssDelta <= kRssBoundBytes,
          "bounded: peak RSS delta " << (rssDelta / 1024 / 1024) << " MB <= "
          << (kRssBoundBytes / 1024 / 1024) << " MB bound");
}

// ─── [B] 100-clip session: zero allocation growth from mode 4 ───────────────

static long long countSessionBlockAllocs(bool shifterActive)
{
    Scenario s;
    s.shifter = shifterActive;
    s.fxSemis = shifterActive ? 4 : 0;
    s.mix     = 1.0f;
    s.method  = StretchMethod::Rubber;

    auto rig = buildRig(s, kReady);
    const auto ids = addMoreClips(rig, 100);

    // Warm every clip's cache lane before measuring — a cache miss during the
    // timed loop would attribute a render-THREAD job submission's allocation
    // to the audio thread it's actually not on.
    for (int id : ids) rig.engine->invalidateClipCache(id, "perfgate");
    CHECK(waitUntil([&] { for (int id : ids) if (!rig.engine->isClipCacheReady(id)) return false; return true; }),
          (shifterActive ? "100-clip session (Clip mode active) warm" : "100-clip session (Clip mode inactive) warm"));

    Transport transport;
    transport.setSampleRate(s.exportRate); transport.setBPM(s.bpm);
    transport.seekToSample(0); transport.play();
    juce::AudioBuffer<float> block(2, 512);

    long long allocs = 0;
    for (int i = 0; i < 40; ++i)   // ~460 ms of steady playback across the whole session
    {
        block.clear();
        g_allocCount.store(0);
        t_countAllocs = true;
        rig.engine->processBlock(block, 512, transport);
        t_countAllocs = false;
        allocs += g_allocCount.load();
        transport.advance(512);
    }
    return allocs;
}

static void testSessionAllocationFree()
{
    std::cout << "\n[B] 100-clip session, mode 4 active: zero allocation growth on the audio thread\n";

    const long long off = countSessionBlockAllocs(false);
    const long long on  = countSessionBlockAllocs(true);

    std::cout << "    100 clips, Clip mode inactive: " << off << " allocations\n";
    std::cout << "    100 clips, Clip mode active:   " << on  << " allocations\n";

    CHECK(on == off,
          "mode 4 adds no allocation across a 100-clip session (active " << on << " vs inactive " << off << ")");
}

int main()
{
    juce::ScopedJuceInitialiser_GUI juceInit;
    std::cout << std::unitbuf;   // a crash must not swallow the report so far
    std::cout << "=== test_clip_fx_perf_gate ===\n";

    testBoundedRenderStorm();
    testSessionAllocationFree();

    std::cout << "\n" << g_passed << " passed, " << g_failed << " failed\n";
    if (g_failed == 0)
    {
        std::cout << "ALL TESTS PASSED\n";
        return 0;
    }
    return 1;
}
