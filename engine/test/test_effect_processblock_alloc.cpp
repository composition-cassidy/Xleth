// test_effect_processblock_alloc - processBlock heap-allocation guard for the
// two spectral suppressors (Resonance Suppressor, EQ "Spectral" band).
//
// Phase P0 of the resonance-suppressor rewrite (docs/RESONANCE_SUPPRESSOR_AUDIT.md
// section 2.5, finding RT10: "No test guards processBlock allocations"). The
// sibling test_effect_audio_thread_reset only counts operator new around
// resetOnAudioThread(); this one counts it around processBlock().
//
//   (a) RS, processing_mode = Low Latency, detector active
//         -> KNOWN-DEFECT (audit RT1/RT2): configureDetectorFilters() calls
//            Coefficients::makeBandPass and processChannel() calls
//            makePeakFilter every block per channel; both return
//            `*new Coefficients`. REPORT-ONLY: the real count is printed and the
//            case never fails the test, because the repo has no known-failure
//            convention for C++ tests (ctest WILL_FAIL / XFAIL are unused).
//            Pass --strict-ll to make (a) assert zero (flip that on when P1a
//            lands and delete the KNOWN-DEFECT label).
//   (b) RS, processing_mode = High Quality, quality Normal      -> asserted 0
//   (c) EQ, one band in Spectral mode (mode 2) and enabled      -> asserted 0
//
// Protocol per case and block size (64, 512), stereo, 48 kHz: 50 warm-up
// blocks, then 200 measured blocks with the counter armed ONLY around
// processBlock(). Input is built and copied in before arming; results are
// stored in pre-sized storage and printed after disarming - nothing in the
// measured region allocates, locks, or logs.
//
// A second, EXTENDED-warm-up pass per case runs >= 3 x 8192 samples of warm-up
// first. At block 64 the specified 50 warm-up blocks are only 3200 samples,
// i.e. less than one 4096-point spectral frame, so the first STFT frame would
// otherwise land inside the measured window. The two passes separate "lazy
// first-frame allocation" from "steady-state allocation".
//
// WHAT THIS DOES NOT SEE: it hooks operator new/new[] only (the same approach
// as test_effect_audio_thread_reset). juce::HeapBlock / juce::Array storage
// goes through std::malloc/realloc and is NOT counted, so for (a) the printed
// number is a LOWER bound (each Coefficients also owns an Array buffer), and
// "0" for (b)/(c) means "no operator-new traffic", not "no malloc traffic".
//
// All output lines carry the [RSBaseline] prefix so they can be grepped.

#include "audio/XlethEQEffect.h"
#include "audio/XlethResonanceSuppressorEffect.h"

#include <juce_audio_basics/juce_audio_basics.h>
#include <juce_audio_processors/juce_audio_processors.h>
#include <juce_dsp/juce_dsp.h>
#include <juce_gui_basics/juce_gui_basics.h>

#include <algorithm>
#include <atomic>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <functional>
#include <iostream>
#include <new>
#include <string>
#include <vector>

// --- Counting allocator -----------------------------------------------------
// Armed only around the call under test. malloc/free so it never recurses.

//
// THREAD FILTER: only allocations made by the measuring thread (the one that
// calls processBlock, i.e. the stand-in for the audio thread) are counted. A
// process-wide counter wrongly charged the EQ's UI spectrum-analysis thread
// (XlethParametricEQ::processSpectrumFrame allocates a std::vector per frame on
// its own thread) to processBlock. Allocations from other threads while armed
// are tallied separately in g_otherThreadCount and only reported.

namespace {
std::atomic<bool>      g_allocArmed { false };
std::atomic<long long> g_allocCount { 0 };        // measuring thread only
std::atomic<long long> g_otherThreadCount { 0 };  // any other thread, informational
thread_local bool      t_isMeasuringThread = false;

inline void countAlloc() noexcept
{
    if (g_allocArmed.load(std::memory_order_relaxed))
    {
        if (t_isMeasuringThread) g_allocCount.fetch_add(1, std::memory_order_relaxed);
        else                     g_otherThreadCount.fetch_add(1, std::memory_order_relaxed);
    }
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

// --- Harness ----------------------------------------------------------------

static int g_passed = 0;
static int g_failed = 0;

#define CHECK(cond, msg)                                                       \
    do {                                                                       \
        if (cond) { ++g_passed; }                                              \
        else { ++g_failed; std::cout << "[RSBaseline] FAIL: " << msg << "\n"; } \
    } while (0)

static constexpr double kSR            = 48000.0;
static constexpr int    kSpecWarmBlocks = 50;
static constexpr int    kMeasured       = 200;
static constexpr int    kBlockSizes[]   = { 64, 512 };

static bool g_strictLL = false;

// --- Signal: stereo pink noise with a +12 dB resonance at 2.5 kHz -----------
// Paul Kellet's economy pink filter, then an RBJ peaking biquad (+12 dB, Q 8)
// per channel. Built entirely before any counter is armed.

static juce::AudioBuffer<float> makeSignal(int numSamples)
{
    juce::AudioBuffer<float> sig(2, numSamples);
    for (int ch = 0; ch < 2; ++ch)
    {
        std::uint32_t lcg = 0x9E3779B9u ^ static_cast<std::uint32_t>(ch * 7919 + 1);
        float b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
        juce::dsp::IIR::Filter<float> peak;
        peak.coefficients = juce::dsp::IIR::Coefficients<float>::makePeakFilter(
            kSR, 2500.0f, 8.0f, juce::Decibels::decibelsToGain(12.0f));
        float* d = sig.getWritePointer(ch);
        for (int s = 0; s < numSamples; ++s)
        {
            lcg = lcg * 1664525u + 1013904223u;
            const float white = static_cast<float>((lcg >> 8) & 0x00ffffffu) / 8388608.0f - 1.0f;
            b0 = 0.99886f * b0 + white * 0.0555179f;
            b1 = 0.99332f * b1 + white * 0.0750759f;
            b2 = 0.96900f * b2 + white * 0.1538520f;
            b3 = 0.86650f * b3 + white * 0.3104856f;
            b4 = 0.55000f * b4 + white * 0.5329522f;
            b5 = -0.7616f * b5 - white * 0.0168980f;
            const float pink = b0 + b1 + b2 + b3 + b4 + b5 + b6 + white * 0.5362f;
            b6 = white * 0.115926f;
            d[s] = peak.processSample(pink * 0.04f);
        }
    }
    return sig;
}

// --- Measurement ------------------------------------------------------------

struct AllocResult
{
    long long total    = 0;
    long long minBlock = 0;
    long long maxBlock = 0;
    long long otherThreads = 0;   // allocs by OTHER threads while armed (informational)
    float     meterPeak = 0.0f;   // RS slot 2 (suppression meter); -1 = n/a
    bool      finite   = true;
    int       warm     = 0;
};

static AllocResult measure(juce::AudioProcessor& fx,
                           const juce::AudioBuffer<float>& sig,
                           int block, int warmBlocks,
                           const std::function<float()>& meter)
{
    AllocResult r;
    r.warm = warmBlocks;
    r.meterPeak = meter ? 0.0f : -1.0f;

    juce::AudioBuffer<float> work(2, block);
    juce::MidiBuffer midi;
    std::vector<long long> perBlock(static_cast<std::size_t>(kMeasured), 0);

    int pos = 0;
    auto loadBlock = [&] {
        for (int ch = 0; ch < 2; ++ch)
            work.copyFrom(ch, 0, sig, ch, pos, block);
        pos += block;
    };

    for (int i = 0; i < warmBlocks; ++i)
    {
        loadBlock();
        fx.processBlock(work, midi);
    }

    const long long other0 = g_otherThreadCount.load(std::memory_order_relaxed);
    for (int i = 0; i < kMeasured; ++i)
    {
        loadBlock();                                   // not measured
        const long long c0 = g_allocCount.load(std::memory_order_relaxed);
        g_allocArmed.store(true, std::memory_order_relaxed);
        fx.processBlock(work, midi);                   // MEASURED
        g_allocArmed.store(false, std::memory_order_relaxed);
        const long long c1 = g_allocCount.load(std::memory_order_relaxed);
        perBlock[static_cast<std::size_t>(i)] = c1 - c0;

        if (meter) r.meterPeak = std::max(r.meterPeak, meter());
        for (int ch = 0; ch < 2 && r.finite; ++ch)
        {
            const float* p = work.getReadPointer(ch);
            for (int s = 0; s < block; ++s)
                if (!std::isfinite(p[s])) { r.finite = false; break; }
        }
    }

    r.otherThreads = g_otherThreadCount.load(std::memory_order_relaxed) - other0;
    r.minBlock = *std::min_element(perBlock.begin(), perBlock.end());
    r.maxBlock = *std::max_element(perBlock.begin(), perBlock.end());
    for (long long v : perBlock) r.total += v;
    return r;
}

static int warmBlocksExtended(int block)
{
    // >= 3 x 8192 samples, never fewer than the specified 50 blocks.
    return std::max(kSpecWarmBlocks, (3 * 8192 + block - 1) / block);
}

static int signalSamplesFor(int block)
{
    return (warmBlocksExtended(block) + kMeasured + 2) * block;
}

static void report(const char* caseId, const char* label, int block,
                   const AllocResult& r, const char* passName, const char* verdict)
{
    std::printf("[RSBaseline] case=%s (%s) block=%d pass=%s warm=%d measured=%d "
                "allocs_total=%lld per_block_min=%lld per_block_max=%lld "
                "per_block_mean=%.2f other_thread_allocs=%lld meter2_peak=%.3f finite=%d  %s\n",
                caseId, label, block, passName, r.warm, kMeasured,
                r.total, r.minBlock, r.maxBlock,
                static_cast<double>(r.total) / kMeasured, r.otherThreads,
                static_cast<double>(r.meterPeak), r.finite ? 1 : 0, verdict);
}

// --- Cases ------------------------------------------------------------------

static void configureRsLowLatency(XlethResonanceSuppressorEffect& fx)
{
    CHECK(fx.setParameterValue("processing_mode", 0.0f), "RS processing_mode Low Latency settable");
    fx.setParameterValue("depth", 100.0f);
    fx.setParameterValue("sharpness", 80.0f);
    fx.setParameterValue("selectivity", 35.0f);
    fx.setParameterValue("attack", 5.0f);
    fx.setParameterValue("release", 180.0f);
    fx.setParameterValue("mix", 100.0f);
}

static void configureRsHighQualityNormal(XlethResonanceSuppressorEffect& fx)
{
    CHECK(fx.setParameterValue("processing_mode", 1.0f), "RS processing_mode High Quality settable");
    CHECK(fx.setParameterValue("quality", 1.0f), "RS quality Normal settable");
    fx.setParameterValue("depth", 100.0f);
    fx.setParameterValue("sharpness", 70.0f);
    fx.setParameterValue("selectivity", 35.0f);
    fx.setParameterValue("mix", 100.0f);
}

static void configureEqSpectral(XlethParametricEQ& eq)
{
    const int band = eq.addBand();
    CHECK(band == 0, "EQ adds band 0");
    CHECK(eq.setBandParam(0, "freq", 2500.0f), "EQ band freq settable");
    CHECK(eq.setBandParam(0, "gain", -12.0f), "EQ band gain (= spectral depth) settable");
    CHECK(eq.setBandParam(0, "q", 4.0f), "EQ band Q settable");
    CHECK(eq.setBandParam(0, "type", 0.0f), "EQ band type settable");
    CHECK(eq.setBandParam(0, "enabled", 1.0f), "EQ band enabled");
    CHECK(eq.setBandParam(0, "mode", 2.0f), "EQ band mode = Spectral (2)");
}

static void runCaseRsLL(int block, const juce::AudioBuffer<float>& sig)
{
    const int passes[2] = { kSpecWarmBlocks, warmBlocksExtended(block) };
    const char* names[2] = { "spec", "extended" };
    for (int p = 0; p < 2; ++p)
    {
        XlethResonanceSuppressorEffect fx;
        configureRsLowLatency(fx);
        fx.prepareToPlay(kSR, block);
        CHECK(fx.getLatencySamples() == 0, "RS LL reports zero latency");
        const AllocResult r = measure(fx, sig, block, passes[p], [&] { return fx.readMeterValue(2); });

        CHECK(r.finite, "case a output finite");
        // The case is only meaningful if the detector actually engaged.
        CHECK(r.meterPeak > 0.02f, "case a: detector active (RS suppression meter rose); meter=" << r.meterPeak);

        const bool allocated = r.total > 0;
        const char* verdict = g_strictLL
            ? (allocated ? "STRICT-FAIL" : "PASS (strict)")
            : (allocated ? "KNOWN-DEFECT: RT1/RT2 confirmed (allocates per block; report-only)"
                         : "AUDIT-REFUTED: 0 operator-new calls (RT1/RT2 not reproduced)");
        report("a", "RS LowLatency", block, r, names[p], verdict);
        if (g_strictLL)
            CHECK(!allocated, "case a (--strict-ll): RS LL processBlock allocated " << r.total << " times");
    }
}

static void runCaseRsHQ(int block, const juce::AudioBuffer<float>& sig)
{
    const int passes[2] = { kSpecWarmBlocks, warmBlocksExtended(block) };
    const char* names[2] = { "spec", "extended" };
    for (int p = 0; p < 2; ++p)
    {
        XlethResonanceSuppressorEffect fx;
        configureRsHighQualityNormal(fx);
        fx.prepareToPlay(kSR, block);
        CHECK(fx.getLatencySamples() == 1024, "RS HQ Normal reports 1024 latency; got " << fx.getLatencySamples());
        const AllocResult r = measure(fx, sig, block, passes[p], [&] { return fx.readMeterValue(2); });

        CHECK(r.finite, "case b output finite");
        report("b", "RS HighQuality/Normal", block, r, names[p], r.total == 0 ? "PASS" : "FAIL");
        CHECK(r.total == 0, "case b: RS HQ Normal processBlock allocated " << r.total
                            << " times (block " << block << ", " << names[p] << " warm-up)");
    }
}

static void runCaseEqSpectral(int block, const juce::AudioBuffer<float>& sig)
{
    const int passes[2] = { kSpecWarmBlocks, warmBlocksExtended(block) };
    const char* names[2] = { "spec", "extended" };
    for (int p = 0; p < 2; ++p)
    {
        XlethParametricEQ eq;
        eq.prepareToPlay(kSR, block);
        configureEqSpectral(eq);
        CHECK(eq.getLatencySamples() == XlethParametricEQ::kSTFTLatency,
              "EQ spectral reports kSTFTLatency; got " << eq.getLatencySamples());
        const AllocResult r = measure(eq, sig, block, passes[p], {});

        CHECK(r.finite, "case c output finite");
        report("c", "EQ Spectral", block, r, names[p], r.total == 0 ? "PASS" : "FAIL");
        CHECK(r.total == 0, "case c: EQ Spectral processBlock allocated " << r.total
                            << " times (block " << block << ", " << names[p] << " warm-up)");
    }
}

// The counter must really see allocations, or every zero above is meaningless.
static void counterNegativeControl()
{
    g_allocCount.store(0);
    g_allocArmed.store(true);
    int* volatile p = new int(1);
    float* volatile q = new float[16];
    g_allocArmed.store(false);
    const long long seen = g_allocCount.load();
    delete p;
    delete[] q;
    std::printf("[RSBaseline] negative control: 2 deliberate allocations -> counter saw %lld\n", seen);
    CHECK(seen == 2, "operator-new counter negative control (expected 2, saw " << seen << ")");
}

int main(int argc, char** argv)
{
    juce::ScopedJuceInitialiser_GUI juceInit;
    t_isMeasuringThread = true;   // this thread stands in for the audio thread
    for (int i = 1; i < argc; ++i)
        if (std::strcmp(argv[i], "--strict-ll") == 0) g_strictLL = true;

    std::cout << "[RSBaseline] === test_effect_processblock_alloc ("
              << (g_strictLL ? "strict-ll" : "default: case a is report-only KNOWN-DEFECT") << ") ===\n";
    std::cout << "[RSBaseline] counts operator new/new[] only; juce::HeapBlock/Array (malloc) is NOT counted\n";

    counterNegativeControl();

    for (int block : kBlockSizes)
    {
        const juce::AudioBuffer<float> sig = makeSignal(signalSamplesFor(block));
        runCaseRsLL(block, sig);
        runCaseRsHQ(block, sig);
        runCaseEqSpectral(block, sig);
    }

    std::cout << "[RSBaseline] --- " << g_passed << " passed, " << g_failed << " failed ---\n";
    if (g_failed == 0) { std::cout << "[RSBaseline] ALL TESTS PASSED\n"; return 0; }
    return 1;
}
