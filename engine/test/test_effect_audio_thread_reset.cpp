// test_effect_audio_thread_reset — the realtime contract behind jump resets.
//
// A live transport jump (seek, loop wrap, play after an audition) resets every
// effect chain ON THE AUDIO THREAD, in the same block that clears the PDC
// compensation delay lines (MixEngine::requestJumpChainReset). Deferred to the
// worker, the reset landed blocks late and a latent effect played pre-jump
// audio out of its pipeline against every compensated track.
//
// That is only legal because XlethEffectBase::resetOnAudioThread() is realtime
// safe. This test holds every stock effect to it:
//   [1] each stock effect, dirtied by real processing, accepts the audio-thread
//       reset with ZERO allocations and in bounded time (the measured worst is
//       tens of microseconds; the gate is a 1 ms median).
//   [2] the Pitch Shifter DECLINES (returns false, allocates nothing, touches
//       nothing) when its running live wrapper has no primed spare, since
//       priming inline takes ~10 ms and allocates - and its reset is a swap
//       again once the worker has primed.
//   [3] chain level: a declined effect is flagged, and the worker's deferred
//       pass resets exactly it - never an effect the audio thread already reset.
//
// A new stock effect goes in kStockIds. If its reset allocates, either make it
// a clear or override resetOnAudioThread() to decline.

#include "audio/EffectChainManager.h"
#include "audio/XlethEffectBase.h"
#include "audio/XlethPitchShifterEffect.h"
#include "audio/TestGainEffect.h"

#include <juce_audio_basics/juce_audio_basics.h>
#include <juce_audio_processors/juce_audio_processors.h>
#include <juce_gui_basics/juce_gui_basics.h>

#include <algorithm>
#include <atomic>
#include <chrono>
#include <cstdio>
#include <cstdlib>
#include <functional>
#include <iostream>
#include <memory>
#include <new>
#include <random>
#include <string>
#include <vector>

// ─── Counting allocator ──────────────────────────────────────────────────────
// Armed only around the call under test. malloc/free so it never recurses.

namespace {
std::atomic<bool>      g_allocArmed { false };
std::atomic<long long> g_allocCount { 0 };

inline void countAlloc() noexcept
{
    if (g_allocArmed.load(std::memory_order_relaxed))
        g_allocCount.fetch_add(1, std::memory_order_relaxed);
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

#define CHECK(cond, msg)                                                       \
    do {                                                                       \
        if (cond) { ++g_passed; }                                              \
        else { ++g_failed; std::cout << "  FAIL: " << msg << "\n"; }           \
    } while (0)

static constexpr double kSR    = 48000.0;
static constexpr int    kBlock = 480;
// Gated on the MEDIAN of the timed calls, reported alongside the max. A reset
// that is not realtime safe (an inline prime: ~10 ms, allocating) costs that on
// every call, so the median catches it; one preemption under a parallel ctest
// run inflates only the max, which made a max-based gate flaky.
static constexpr double kMaxResetUs = 1000.0;

static double median(std::vector<double> v)
{
    if (v.empty()) return 0.0;
    std::sort(v.begin(), v.end());
    return v[v.size() / 2];
}

// Every pluginId AudioGraph::createEffect builds as a stock XlethEffectBase.
static const char* const kStockIds[] = {
    "compressor", "limiter", "overdone", "transientproc", "xletheq", "xlethfilter",
    "distortion", "waveshaper", "uniflange", "chorus", "flanger", "phaser",
    "phanjer", "delay", "reverb", "resonancesuppressor", "smartbalance", "apex",
    "amp", "pitchshifter", "gloss", "glue", "fedda", "szkrezh",
};

static std::mt19937 g_rng(7);

static void processNoise(EffectChainManager& chain, int blocks)
{
    std::uniform_real_distribution<float> d(-0.5f, 0.5f);
    juce::AudioBuffer<float> b(2, kBlock);
    juce::MidiBuffer midi;
    for (int k = 0; k < blocks; ++k)
    {
        for (int c = 0; c < 2; ++c)
            for (int i = 0; i < kBlock; ++i)
                b.setSample(c, i, d(g_rng));
        chain.processBlock(b, kBlock, midi);
    }
}

struct Measured
{
    bool      allAccepted = true;
    long long allocs      = 0;
    std::vector<double> us;
    double medianUs() const { return median(us); }
    double maxUs() const { return us.empty() ? 0.0 : *std::max_element(us.begin(), us.end()); }
};

// Dirty the effect, let the worker's prime run (as it does after every jump),
// then time resetOnAudioThread() under the allocation counter.
static Measured measure(EffectChainManager& chain, XlethEffectBase& fx, int iterations)
{
    Measured m;
    for (int k = 0; k < iterations; ++k)
    {
        processNoise(chain, 8);
        chain.primeDeferredReset();

        g_allocCount.store(0);
        g_allocArmed.store(true);
        const auto t0 = std::chrono::steady_clock::now();
        const bool accepted = fx.resetOnAudioThread();
        const auto t1 = std::chrono::steady_clock::now();
        g_allocArmed.store(false);

        m.allAccepted = m.allAccepted && accepted;
        m.allocs += g_allocCount.load();
        m.us.push_back(std::chrono::duration<double, std::micro>(t1 - t0).count());
    }
    return m;
}

// ─── [1] every stock effect ──────────────────────────────────────────────────

static void testEveryStockEffect()
{
    std::cout << "\n[1] every stock effect: audio-thread reset is allocation-free and bounded\n";
    std::printf("    %-20s %8s %8s %9s %9s\n", "effect", "latency", "allocs", "median us", "max us");

    for (const char* id : kStockIds)
    {
        EffectChainManager chain;
        chain.init(kSR, kBlock);
        const int nodeId = chain.addEffect(id, 0);
        XlethEffectBase* fx = nodeId >= 0 ? chain.getEffect(nodeId) : nullptr;
        CHECK(fx != nullptr, id << ": created as a stock effect");
        if (fx == nullptr) continue;
        chain.refreshRealtimeView();

        // The Pitch Shifter's reset depends on its mode; cover every live one.
        std::vector<float> modes { -1.0f };
        if (std::string(id) == "pitchshifter") modes = { 0.0f, 1.0f, 2.0f };
        for (const float mode : modes)
        {
            if (mode >= 0.0f)
            {
                fx->setParameterValue("mode", mode);
                fx->setParameterValue("semitones", -12.0f);
            }
            const Measured m = measure(chain, *fx, 20);
            char label[48];
            std::snprintf(label, sizeof label, mode >= 0.0f ? "%s/mode%d" : "%s", id, (int) mode);
            std::printf("    %-20s %8d %8lld %9.1f %9.1f\n", label, fx->getLatencySamples(),
                        m.allocs, m.medianUs(), m.maxUs());
            CHECK(m.allAccepted, label << ": accepts the audio-thread reset");
            CHECK(m.allocs == 0, label << ": audio-thread reset allocated " << m.allocs << " times");
            CHECK(m.medianUs() < kMaxResetUs,
                  label << ": audio-thread reset takes " << m.medianUs() << " us (median)");
        }
    }
}

// ─── [2] the Pitch Shifter declines without a primed spare ───────────────────

static void testPitchShifterDeclinesUnprimed()
{
    std::cout << "\n[2] Pitch Shifter: declines, cheaply, when its spare is not primed\n";

    for (const float mode : { 1.0f, 2.0f })
    {
        const char* name = mode == 1.0f ? "Smart" : "Voice";
        EffectChainManager chain;
        chain.init(kSR, kBlock);
        const int nodeId = chain.addEffect("pitchshifter", 0);
        auto* fx = dynamic_cast<XlethPitchShifterEffect*>(chain.getEffect(nodeId));
        CHECK(fx != nullptr, name << ": created");
        if (fx == nullptr) continue;
        chain.refreshRealtimeView();
        fx->setParameterValue("mode", mode);
        fx->setParameterValue("semitones", 7.0f);
        const auto& live = mode == 1.0f ? fx->getSmartShifter() : fx->getVoiceShifter();

        processNoise(chain, 8);
        CHECK(live.isSpareReady(), name << ": prepare() left a primed spare");
        CHECK(fx->resetOnAudioThread(), name << ": first reset swaps the spare in");
        CHECK(!live.isSpareReady(), name << ": the swap consumed the spare");

        // Declining touches nothing, so it can be timed repeatedly.
        processNoise(chain, 8);
        bool anyAccepted = false;
        std::vector<double> us;
        g_allocCount.store(0);
        for (int k = 0; k < 20; ++k)
        {
            g_allocArmed.store(true);
            const auto t0 = std::chrono::steady_clock::now();
            anyAccepted = fx->resetOnAudioThread() || anyAccepted;
            const auto t1 = std::chrono::steady_clock::now();
            g_allocArmed.store(false);
            us.push_back(std::chrono::duration<double, std::micro>(t1 - t0).count());
        }
        std::printf("    %-5s unprimed: accepted=%d, %lld allocs, %.1f us median\n",
                    name, (int) anyAccepted, g_allocCount.load(), median(us));
        CHECK(!anyAccepted, name << ": declines rather than priming on the audio thread");
        CHECK(g_allocCount.load() == 0, name << ": declining allocated");
        CHECK(median(us) < kMaxResetUs, name << ": declining takes " << median(us) << " us (median)");
        CHECK(!live.isSpareReady(), name << ": declining left the shifter untouched");

        chain.primeDeferredReset();
        CHECK(live.isSpareReady(), name << ": the worker's prime restores the spare");
        CHECK(fx->resetOnAudioThread(), name << ": and the reset is a swap again");
    }
}

// ─── [3] chain level: the worker finishes exactly what was left ──────────────

namespace {
struct CountingGain final : public TestGainEffect
{
    std::atomic<int>* resets;
    explicit CountingGain(std::atomic<int>* r) : resets(r) {}
    void resetEffect() override { resets->fetch_add(1); }
};
} // namespace

static void testWorkerFinishesOnlyWhatWasLeft()
{
    std::cout << "\n[3] chain: a declined effect is reset by the worker, nothing else twice\n";

    EffectChainManager chain;
    chain.init(kSR, kBlock);
    std::atomic<int> gainResets { 0 };
    chain.addProcessorForTesting("testgain", std::make_unique<CountingGain>(&gainResets), 0);
    const int shifterNode = chain.addEffect("pitchshifter", 1);
    auto* fx = dynamic_cast<XlethPitchShifterEffect*>(chain.getEffect(shifterNode));
    CHECK(fx != nullptr, "shifter added");
    if (fx == nullptr) return;
    chain.refreshRealtimeView();
    fx->setParameterValue("mode", 1.0f);
    const auto& live = fx->getSmartShifter();

    processNoise(chain, 4);
    CHECK(chain.resetOnAudioThread(), "jump 1: every node reset on the audio thread");
    CHECK(gainResets.load() == 1, "jump 1: the gain reset once");
    CHECK(chain.tryResetDeferredOffThread(), "jump 1: nothing left for the worker");
    CHECK(gainResets.load() == 1, "jump 1: the worker did not reset the gain again");

    // No prime between jumps: the shifter must decline and be left.
    processNoise(chain, 4);
    CHECK(!chain.resetOnAudioThread(), "jump 2: reports work left (shifter unprimed)");
    CHECK(gainResets.load() == 2, "jump 2: the gain still reset in the jump block");
    CHECK(!live.isSpareReady(), "jump 2: shifter untouched (still no spare)");

    chain.primeDeferredReset();                // the worker's order: prime, then claim
    CHECK(live.isSpareReady(), "worker primed the spare");
    CHECK(chain.tryResetDeferredOffThread(), "worker's deferred pass ran");
    CHECK(!live.isSpareReady(), "the deferred pass reset the shifter (swap consumed the spare)");
    CHECK(gainResets.load() == 2, "the deferred pass did not reset the gain again");

    // A jump that lands while the worker is inside the chain cannot claim it;
    // the worker must then reset the WHOLE chain on its next pass.
    chain.primeDeferredReset();
    bool jumpClaimed = true;
    std::function<void()> duringReset = [&] { jumpClaimed = chain.resetOnAudioThread(); };
    auto* hook = &duringReset;
    struct HookGain final : public TestGainEffect
    {
        std::function<void()>** hook;
        explicit HookGain(std::function<void()>** h) : hook(h) {}
        void resetEffect() override { if (*hook) { auto* f = *hook; *hook = nullptr; (*f)(); } }
    };
    std::function<void()>* armed = hook;
    chain.addProcessorForTesting("testgain", std::make_unique<HookGain>(&armed), 0);
    chain.refreshRealtimeView();
    const int before = gainResets.load();
    CHECK(chain.tryResetProcessorsOffThread(), "worker full reset ran (jump fired inside it)");
    CHECK(!jumpClaimed, "the jump could not claim a chain the worker was resetting");
    CHECK(chain.tryResetDeferredOffThread(), "the worker's next pass ran");
    CHECK(gainResets.load() == before + 2,
          "that pass reset the whole chain (gain reset " << gainResets.load() - before << "x, want 2)");
}

int main()
{
    juce::ScopedJuceInitialiser_GUI juceInit;
    std::cout << "=== test_effect_audio_thread_reset ===\n";

    testEveryStockEffect();
    testPitchShifterDeclinesUnprimed();
    testWorkerFinishesOnlyWhatWasLeft();

    std::cout << "\n--- " << g_passed << " passed, " << g_failed << " failed ---\n";
    if (g_failed == 0) { std::cout << "ALL TESTS PASSED\n"; return 0; }
    return 1;
}
