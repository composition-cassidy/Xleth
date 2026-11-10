// test_effect_processblock_alloc - processBlock heap-allocation guard for the
// two spectral suppressors (Resonance Suppressor, EQ "Spectral" band), plus the
// Low Latency numerical-equivalence ("null") test.
//
// Phase P0 of the resonance-suppressor rewrite (docs/RESONANCE_SUPPRESSOR_AUDIT.md
// section 2.5, finding RT10: "No test guards processBlock allocations"). The
// sibling test_effect_audio_thread_reset only counts operator new around
// resetOnAudioThread(); this one counts it around processBlock().
//
//   (a) RS, processing_mode = Low Latency, detector active, static params
//         -> asserted 0 (audit RT1/RT2, fixed in P1a: the detector band-pass and
//            wet peak biquads are now local fixed-size TDF-II filters whose
//            coefficients are written in place, no juce::Coefficients objects).
//            Run at block 64 and 512 with the specified warm-up, an extended
//            warm-up, and a COLD pass (counter armed from the very first block
//            after prepareToPlay, so any lazy first-block allocation shows).
//   (a2) RS Low Latency, parameter sweep: sharpness and selectivity changed
//         before EVERY block for 200 blocks (setParameterValue from the test
//         thread, outside the armed region, as a message-thread write would be
//         observed by the next block)                                -> asserted 0
//   (a3) RS Low Latency, wide sweep: sharpness, selectivity, depth, attack,
//         release, wc_hp and wc_lp all changed before every block    -> asserted 0
//   (b) RS, processing_mode = High Quality, quality Normal      -> asserted 0
//   (c) EQ, one band in Spectral mode (mode 2) and enabled      -> asserted 0
//   (e) RS, processing_mode = High Quality, hq_engine = New (ResonanceCore),
//         quality Normal, depth / sharpness / selectivity / attack / release /
//         stereo_link / wc_hp / wc_lp / mode swept before EVERY block ->
//         asserted 0 (spec, extended and cold passes, blocks 64 and 512).
//   (e2) the same plus structural changes from the test thread (quality every
//         37 blocks, stereo_mode every 53, hq_engine / processing_mode every
//         71 and 97): tier switches and fade / reset / fade-in transitions,
//         with the visualization tap ON (bucket resampling + collector push)
//         -> asserted 0.
//   (f) STRESS: a second thread changes quality, hq_engine, processing_mode and
//         stereo_mode at random while this thread processes 200,000 blocks of
//         64 samples: no allocation on the processing thread, no NaN, output
//         bounded.
//   (g) MEMORY (informational + reported): operator-new bytes of
//         prepareToPlay for one RS instance (both HQ engines, 48 kHz stereo,
//         block 512) and for a bare ResonanceCore, plus the process private
//         bytes delta of 16 prepared instances.
//   (d) NULL TEST: the LL output (stereo pink noise + 12 dB resonance at 2.5 kHz,
//         48 kHz, block 64 and 512, plus a swept-parameter run at 512) is
//         compared with fixtures captured from the pre-P1a implementation
//         (juce::dsp::IIR::Filter + makeBandPass/makePeakFilter). Difference
//         must be below -100 dBFS RMS. Fixtures live in
//         engine/test/fixtures/rs_ll/ (raw float32, planar L then R) and are
//         located through XLETH_RS_LL_FIXTURE_DIR. They can only be regenerated
//         from a build that still contains the old implementation:
//         `test_effect_processblock_alloc --write-ll-fixtures`.
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
// goes through std::malloc/realloc and is NOT counted, so a "0" means "no
// operator-new traffic", not "no malloc traffic". For the LL path the malloc
// side is covered by construction rather than by this counter: the P1a biquads
// hold only std::array/float members, so there is no HeapBlock/Array left in
// the LL processBlock path to allocate. (_CrtSetAllocHook would count malloc
// but exists only in the debug CRT; this suite is built Release-only.)
//
// All output lines carry the [RSLLAlloc] prefix so they can be grepped.

#include "audio/XlethEQEffect.h"
#include "audio/XlethResonanceSuppressorEffect.h"

#include <juce_audio_basics/juce_audio_basics.h>
#include <juce_audio_processors/juce_audio_processors.h>
#include <juce_dsp/juce_dsp.h>
#include <juce_gui_basics/juce_gui_basics.h>

#include <algorithm>
#include <array>
#include <atomic>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <filesystem>
#include <functional>
#include <limits>
#include <iostream>
#include <new>
#include <random>
#include <string>
#include <thread>
#include <vector>

#define NOMINMAX
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <psapi.h>

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
std::atomic<long long> g_allocBytes { 0 };        // measuring thread only, bytes (case g)
thread_local bool      t_isMeasuringThread = false;

inline void countAlloc(std::size_t n) noexcept
{
    if (g_allocArmed.load(std::memory_order_relaxed))
    {
        if (t_isMeasuringThread)
        {
            g_allocCount.fetch_add(1, std::memory_order_relaxed);
            g_allocBytes.fetch_add(static_cast<long long>(n), std::memory_order_relaxed);
        }
        else
            g_otherThreadCount.fetch_add(1, std::memory_order_relaxed);
    }
}
} // namespace

void* operator new(std::size_t n)                 { countAlloc(n); void* p = std::malloc(n ? n : 1); if (!p) std::abort(); return p; }
void* operator new[](std::size_t n)               { countAlloc(n); void* p = std::malloc(n ? n : 1); if (!p) std::abort(); return p; }
void* operator new(std::size_t n, const std::nothrow_t&) noexcept   { countAlloc(n); return std::malloc(n ? n : 1); }
void* operator new[](std::size_t n, const std::nothrow_t&) noexcept { countAlloc(n); return std::malloc(n ? n : 1); }
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
        else { ++g_failed; std::cout << "[RSLLAlloc] FAIL: " << msg << "\n"; } \
    } while (0)

static constexpr double kSR            = 48000.0;
static constexpr int    kSpecWarmBlocks = 50;
static constexpr int    kMeasured       = 200;
static constexpr int    kBlockSizes[]   = { 64, 512 };

#ifndef XLETH_RS_LL_FIXTURE_DIR
#error "XLETH_RS_LL_FIXTURE_DIR must be defined by CMake (engine/test/fixtures/rs_ll)"
#endif

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
    double    outAbsSum = 0.0;    // sum |out| over the measured blocks (sweep-took-effect check)
};

static AllocResult measure(juce::AudioProcessor& fx,
                           const juce::AudioBuffer<float>& sig,
                           int block, int warmBlocks,
                           const std::function<float()>& meter,
                           const std::function<void(int)>& beforeBlock = {})
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
        if (beforeBlock) beforeBlock(i);               // e.g. parameter sweep write
        loadBlock();
        fx.processBlock(work, midi);
    }

    const long long other0 = g_otherThreadCount.load(std::memory_order_relaxed);
    for (int i = 0; i < kMeasured; ++i)
    {
        if (beforeBlock) beforeBlock(warmBlocks + i);  // not measured (counter disarmed)
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
            {
                if (!std::isfinite(p[s])) { r.finite = false; break; }
                r.outAbsSum += std::abs(static_cast<double>(p[s]));
            }
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
    std::printf("[RSLLAlloc] case=%s (%s) block=%d pass=%s warm=%d measured=%d "
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

static void configureRsHighQualityNew(XlethResonanceSuppressorEffect& fx)
{
    fx.setCoreInstanceIndex(0);
    CHECK(fx.setParameterValue("processing_mode", 1.0f), "RS processing_mode High Quality settable");
    CHECK(fx.setParameterValue("hq_engine", 1.0f), "RS hq_engine New settable");
    CHECK(fx.setParameterValue("quality", 1.0f), "RS quality Normal settable");
    fx.setParameterValue("depth", 100.0f);
    fx.setParameterValue("sharpness", 70.0f);
    fx.setParameterValue("selectivity", 35.0f);
    fx.setParameterValue("mode", 1.0f);
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

// --- Deterministic per-block parameter walks (units of the parameter itself) --
// Each value moves on every block (irrational-ish rates), so every block gets
// new detector band-pass AND new wet peak coefficients (the latter also move on
// their own because the per-band reduction changes, but here the Q and the band
// layout change too).

static float sweepVal(int i, float lo, float hi, float rate, float phase)
{
    const float u = 0.5f + 0.5f * std::sin(rate * static_cast<float>(i) + phase);
    return lo + (hi - lo) * u;
}

using SweepFn = std::function<void(XlethResonanceSuppressorEffect&, int)>;

static void sweepSharpnessSelectivity(XlethResonanceSuppressorEffect& fx, int i)
{
    fx.setParameterValue("sharpness",   sweepVal(i,  5.0f,  95.0f, 0.91f, 0.0f));
    fx.setParameterValue("selectivity", sweepVal(i, 10.0f,  90.0f, 1.37f, 1.0f));
}

static void sweepWide(XlethResonanceSuppressorEffect& fx, int i)
{
    sweepSharpnessSelectivity(fx, i);
    fx.setParameterValue("depth",   sweepVal(i,   20.0f,   100.0f, 0.53f, 2.0f));
    fx.setParameterValue("attack",  sweepVal(i,    1.0f,    50.0f, 0.71f, 3.0f));
    fx.setParameterValue("release", sweepVal(i,   30.0f,   600.0f, 0.43f, 4.0f));
    fx.setParameterValue("wc_hp",   sweepVal(i,   40.0f,   600.0f, 0.61f, 5.0f));
    fx.setParameterValue("wc_lp",   sweepVal(i, 4000.0f, 18000.0f, 0.77f, 6.0f));
}

// One LL case at one block size, three passes: the specified warm-up, an
// extended warm-up, and COLD (counter armed from the very first block after
// prepareToPlay, so a lazy first-block allocation cannot hide in warm-up).
// `sweep` null = static parameters. Returns the |out| sums of the spec pass.
static double runLlCase(const char* caseId, const char* label, int block,
                        const juce::AudioBuffer<float>& sig, const SweepFn& sweep)
{
    const int passes[3] = { kSpecWarmBlocks, warmBlocksExtended(block), 0 };
    const char* names[3] = { "spec", "extended", "cold" };
    double specSum = 0.0;
    for (int p = 0; p < 3; ++p)
    {
        XlethResonanceSuppressorEffect fx;
        configureRsLowLatency(fx);
        fx.prepareToPlay(kSR, block);
        CHECK(fx.getLatencySamples() == 0, "RS LL reports zero latency");

        std::function<void(int)> before;
        if (sweep) before = [&](int i) { sweep(fx, i); };
        const AllocResult r = measure(fx, sig, block, passes[p],
                                      [&] { return fx.readMeterValue(2); }, before);
        if (p == 0) specSum = r.outAbsSum;

        CHECK(r.finite, "case " << caseId << " output finite");
        // The case is only meaningful if the detector actually engaged.
        CHECK(r.meterPeak > 0.005f, "case " << caseId << ": detector active (RS suppression meter rose); meter="
                                            << r.meterPeak);

        report(caseId, label, block, r, names[p], r.total == 0 ? "PASS" : "FAIL");
        CHECK(r.total == 0, "case " << caseId << ": RS LL processBlock allocated " << r.total
                            << " times (block " << block << ", " << names[p] << " pass)");
    }
    return specSum;
}

static void runCaseRsLL(int block, const juce::AudioBuffer<float>& sig)
{
    const double staticSum = runLlCase("a", "RS LowLatency static", block, sig, {});
    const double sweepSum  = runLlCase("a2", "RS LowLatency sweep sharpness+selectivity", block, sig,
                                       sweepSharpnessSelectivity);
    const double wideSum   = runLlCase("a3", "RS LowLatency wide sweep", block, sig, sweepWide);

    // The sweeps must actually reach the DSP: same input, different output.
    const double relA2 = std::abs(sweepSum - staticSum) / std::max(staticSum, 1.0e-9);
    const double relA3 = std::abs(wideSum - staticSum) / std::max(staticSum, 1.0e-9);
    std::printf("[RSLLAlloc] block=%d sweep-took-effect: |out| sum static=%.4f sweep=%.4f (rel %.4f) wide=%.4f (rel %.4f)\n",
                block, staticSum, sweepSum, relA2, wideSum, relA3);
    CHECK(relA2 > 1.0e-3, "case a2: sweep output differs from static output (block " << block << ")");
    CHECK(relA3 > 1.0e-3, "case a3: wide sweep output differs from static output (block " << block << ")");
}

// --- (d) Null test against the pre-P1a implementation -------------------------

static constexpr int kNullFrames = 12288;   // multiple of 64 and 512

struct NullCase
{
    const char* name;
    const char* file;
    int         block;
    bool        sweep;
};

static const NullCase kNullCases[] = {
    { "bs64",         "rs_ll_bs64.f32",         64,  false },
    { "bs512",        "rs_ll_bs512.f32",        512, false },
    { "bs512_sweep",  "rs_ll_bs512_sweep.f32",  512, true  },
};

// Planar result: [L0..L(N-1), R0..R(N-1)].
static std::vector<float> renderLlOffline(const NullCase& c, const juce::AudioBuffer<float>& sig)
{
    XlethResonanceSuppressorEffect fx;
    configureRsLowLatency(fx);
    fx.prepareToPlay(kSR, c.block);

    juce::AudioBuffer<float> work(2, c.block);
    juce::MidiBuffer midi;
    std::vector<float> out(static_cast<std::size_t>(2 * kNullFrames));
    for (int b = 0; b * c.block < kNullFrames; ++b)
    {
        if (c.sweep) sweepSharpnessSelectivity(fx, b);
        for (int ch = 0; ch < 2; ++ch)
            work.copyFrom(ch, 0, sig, ch, b * c.block, c.block);
        fx.processBlock(work, midi);
        for (int ch = 0; ch < 2; ++ch)
            std::memcpy(out.data() + static_cast<std::size_t>(ch * kNullFrames + b * c.block),
                        work.getReadPointer(ch), sizeof(float) * static_cast<std::size_t>(c.block));
    }
    return out;
}

static std::string fixturePath(const NullCase& c)
{
    return std::string(XLETH_RS_LL_FIXTURE_DIR) + "/" + c.file;
}

static bool readFixture(const NullCase& c, std::vector<float>& out)
{
    std::FILE* f = std::fopen(fixturePath(c).c_str(), "rb");
    if (!f) return false;
    out.assign(static_cast<std::size_t>(2 * kNullFrames), 0.0f);
    const std::size_t got = std::fread(out.data(), sizeof(float), out.size(), f);
    std::fclose(f);
    return got == out.size();
}

static int writeFixtures()
{
    const juce::AudioBuffer<float> sig = makeSignal(kNullFrames);
    std::filesystem::create_directories(XLETH_RS_LL_FIXTURE_DIR);
    for (const NullCase& c : kNullCases)
    {
        const std::vector<float> out = renderLlOffline(c, sig);
        std::FILE* f = std::fopen(fixturePath(c).c_str(), "wb");
        if (!f) { std::printf("[RSLLAlloc] cannot write %s\n", fixturePath(c).c_str()); return 2; }
        std::fwrite(out.data(), sizeof(float), out.size(), f);
        std::fclose(f);
        std::printf("[RSLLAlloc] wrote fixture %s (%zu bytes)\n", fixturePath(c).c_str(), out.size() * sizeof(float));
    }
    return 0;
}

static void runNullTests()
{
    const juce::AudioBuffer<float> sig = makeSignal(kNullFrames);
    constexpr double kLimitDb = -100.0;
    for (const NullCase& c : kNullCases)
    {
        std::vector<float> ref;
        if (!readFixture(c, ref))
        {
            CHECK(false, "null test " << c.name << ": cannot read fixture " << fixturePath(c));
            continue;
        }
        const std::vector<float> now = renderLlOffline(c, sig);

        double sumSq = 0.0, maxAbs = 0.0, refSq = 0.0, supSq = 0.0;
        for (int ch = 0; ch < 2; ++ch)
            for (int s = 0; s < kNullFrames; ++s)
            {
                const std::size_t i = static_cast<std::size_t>(ch * kNullFrames + s);
                const double d = static_cast<double>(now[i]) - static_cast<double>(ref[i]);
                sumSq += d * d;
                maxAbs = std::max(maxAbs, std::abs(d));
                refSq += static_cast<double>(ref[i]) * ref[i];
                const double suppressed = static_cast<double>(sig.getSample(ch, s)) - static_cast<double>(ref[i]);
                supSq += suppressed * suppressed;
            }
        const double n = static_cast<double>(2 * kNullFrames);
        const double diffRms = std::sqrt(sumSq / n);
        const double refRms  = std::sqrt(refSq / n);
        const double supRms  = std::sqrt(supSq / n);
        const double diffDb  = diffRms > 0.0 ? 20.0 * std::log10(diffRms) : -std::numeric_limits<double>::infinity();
        const double refDb   = 20.0 * std::log10(std::max(refRms, 1.0e-12));
        const double supDb   = 20.0 * std::log10(std::max(supRms, 1.0e-12));

        std::printf("[RSLLAlloc] null %-12s block=%d frames=%d  diff_rms=%.3e (%s dBFS)  max_abs_diff=%.3e  "
                    "ref_rms=%.2f dBFS  suppression_delta_rms(in-ref)=%.2f dBFS  limit=%.0f dBFS\n",
                    c.name, c.block, kNullFrames, diffRms,
                    diffRms > 0.0 ? (std::to_string(diffDb)).c_str() : "-inf (bit-identical)",
                    maxAbs, refDb, supDb, kLimitDb);

        CHECK(refRms > 1.0e-4, "null " << c.name << ": reference fixture is not silent");
        // The null is only meaningful if the suppressor actually changed the signal
        // by far more than the tolerance.
        CHECK(supDb > kLimitDb + 40.0, "null " << c.name << ": suppressor changed the signal (delta " << supDb << " dBFS)");
        CHECK(diffRms < std::pow(10.0, kLimitDb / 20.0),
              "null " << c.name << ": diff " << diffDb << " dBFS is not below " << kLimitDb << " dBFS");
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

// (e) / (e2): the New HQ engine with every continuous parameter swept before
// every block; e2 adds structural changes (tier requests, fades, resets).
static void sweepCore(XlethResonanceSuppressorEffect& fx, int i)
{
    sweepWide(fx, i);
    fx.setParameterValue("stereo_link", sweepVal(i, 0.0f, 100.0f, 0.37f, 7.0f));
    fx.setParameterValue("mode", (i % 5) < 2 ? 1.0f : 0.0f);
}

static void sweepCoreStructural(XlethResonanceSuppressorEffect& fx, int i)
{
    sweepCore(fx, i);
    if (i % 37 == 0) fx.setParameterValue("quality", static_cast<float>((i / 37) % 3));
    if (i % 53 == 0) fx.setParameterValue("stereo_mode", static_cast<float>((i / 53) % 3));
    if (i % 71 == 0) fx.setParameterValue("hq_engine", static_cast<float>((i / 71) % 2 == 0 ? 1 : 0));
    if (i % 97 == 0) fx.setParameterValue("processing_mode", (i / 97) % 2 == 0 ? 1.0f : 0.0f);
}

static void runCaseRsNew(int block, const juce::AudioBuffer<float>& sig)
{
    struct Variant { const char* id; const char* label; SweepFn sweep; };
    const Variant variants[2] = {
        { "e",  "RS HQ New engine, parameters swept every block", sweepCore },
        { "e2", "RS HQ New engine, sweeps + structural changes",   sweepCoreStructural },
    };
    const int passes[3] = { kSpecWarmBlocks, warmBlocksExtended(block), 0 };
    const char* names[3] = { "spec", "extended", "cold" };
    for (const auto& v : variants)
    {
        for (int p = 0; p < 3; ++p)
        {
            XlethResonanceSuppressorEffect fx;
            configureRsHighQualityNew(fx);
            fx.prepareToPlay(kSR, block);
            const bool viz = std::strcmp(v.id, "e2") == 0;
            if (viz) fx.setVisualizationEnabled(true);   // collector built here, before measuring
            CHECK(fx.getLatencySamples() == 1024, "RS New Normal reports 1024 latency; got " << fx.getLatencySamples());
            const auto sweep = v.sweep;
            const AllocResult r = measure(fx, sig, block, passes[p],
                                          [&] { return fx.readMeterValue(2); },
                                          [&](int i) { sweep(fx, i); });
            CHECK(r.finite, "case " << v.id << " output finite");
            CHECK(r.meterPeak > 0.005f, "case " << v.id << ": New engine suppression meter rose; meter=" << r.meterPeak);
            report(v.id, v.label, block, r, names[p], r.total == 0 ? "PASS" : "FAIL");
            CHECK(r.total == 0, "case " << v.id << ": RS New processBlock allocated " << r.total
                                << " times (block " << block << ", " << names[p] << " pass)");
            if (viz)
            {
                std::vector<std::uint8_t> drained(sizeof(xleth::viz::ResonanceBucket) * 64);
                const std::size_t bytes = fx.drainVizFrames(drained.data(), drained.size());
                std::printf("[RSLLAlloc] case=e2 block=%d pass=%s structural transitions=%llu tier switches=%lld viz bytes drained=%zu\n",
                            block, names[p], static_cast<unsigned long long>(fx.getStructureSwitchCount()),
                            fx.getCoreForTest().tierSwitchCount(), bytes);
                CHECK(bytes > 0, "case e2: the viz tap produced buckets");
            }
        }
    }
}

// (f) A "message thread" changes the structure at random while this thread
// processes 200,000 blocks. Only the processing thread's allocations count.
static void runStressRsStructure()
{
    constexpr int kBlock = 64;
    constexpr long long kBlocks = 200000;
    const juce::AudioBuffer<float> sig = makeSignal(kBlock * 4096);

    XlethResonanceSuppressorEffect fx;
    configureRsHighQualityNew(fx);
    fx.prepareToPlay(kSR, kBlock);

    float inPeak = 0.0f;
    for (int ch = 0; ch < 2; ++ch)
        for (int s = 0; s < sig.getNumSamples(); ++s)
            inPeak = std::max(inPeak, std::abs(sig.getSample(ch, s)));

    std::atomic<bool> stop { false };
    std::atomic<long long> changes { 0 };
    std::thread requester([&] {
        std::mt19937 rng(0x5EEDu);
        std::uniform_int_distribution<int> which(0, 3), q(0, 2), two(0, 1), st(0, 2), pause(0, 400);
        while (!stop.load(std::memory_order_relaxed))
        {
            switch (which(rng))
            {
                case 0: fx.setParameterValue("quality", static_cast<float>(q(rng))); break;
                case 1: fx.setParameterValue("hq_engine", static_cast<float>(two(rng))); break;
                case 2: fx.setParameterValue("processing_mode", static_cast<float>(two(rng))); break;
                default: fx.setParameterValue("stereo_mode", static_cast<float>(st(rng))); break;
            }
            changes.fetch_add(1, std::memory_order_relaxed);
            std::this_thread::sleep_for(std::chrono::microseconds(pause(rng)));
        }
    });

    juce::AudioBuffer<float> work(2, kBlock);
    juce::MidiBuffer midi;
    long long allocs = 0;
    bool finite = true;
    float outPeak = 0.0f;
    const int sigBlocks = sig.getNumSamples() / kBlock;
    for (long long b = 0; b < kBlocks; ++b)
    {
        const int pos = static_cast<int>(b % sigBlocks) * kBlock;
        for (int ch = 0; ch < 2; ++ch)
            work.copyFrom(ch, 0, sig, ch, pos, kBlock);
        const long long c0 = g_allocCount.load(std::memory_order_relaxed);
        g_allocArmed.store(true, std::memory_order_relaxed);
        fx.processBlock(work, midi);
        g_allocArmed.store(false, std::memory_order_relaxed);
        allocs += g_allocCount.load(std::memory_order_relaxed) - c0;
        for (int ch = 0; ch < 2; ++ch)
        {
            const float* d = work.getReadPointer(ch);
            for (int s = 0; s < kBlock; ++s)
            {
                if (!std::isfinite(d[s])) finite = false;
                else outPeak = std::max(outPeak, std::abs(d[s]));
            }
        }
    }
    stop.store(true);
    requester.join();

    std::printf("[RSLLAlloc] case=f (RS structure stress) blocks=%lld block=%d requests=%lld structural transitions=%llu "
                "tier switches=%lld allocs=%lld finite=%d out_peak=%.4f in_peak=%.4f  %s\n",
                kBlocks, kBlock, changes.load(), static_cast<unsigned long long>(fx.getStructureSwitchCount()),
                fx.getCoreForTest().tierSwitchCount(), allocs, finite ? 1 : 0, outPeak, inPeak,
                (allocs == 0 && finite && outPeak <= 4.0f * inPeak) ? "PASS" : "FAIL");
    CHECK(changes.load() > 1000, "case f: the requester made changes (" << changes.load() << ")");
    CHECK(fx.getStructureSwitchCount() > 100, "case f: structural transitions happened");
    CHECK(allocs == 0, "case f: processBlock allocated " << allocs << " times under concurrent structure changes");
    CHECK(finite, "case f: output finite");
    CHECK(outPeak <= 4.0f * inPeak, "case f: output bounded (peak " << outPeak << " vs input " << inPeak << ")");
}

// (g) Memory per instance (both HQ engines are prepared up front).
static std::size_t privateBytes()
{
    PROCESS_MEMORY_COUNTERS_EX pmc {};
    if (GetProcessMemoryInfo(GetCurrentProcess(), reinterpret_cast<PROCESS_MEMORY_COUNTERS*>(&pmc), sizeof(pmc)))
        return pmc.PrivateUsage;
    return 0;
}

static void runMemoryReport()
{
    auto bytesOf = [](const std::function<void()>& fn) {
        const long long b0 = g_allocBytes.load();
        g_allocArmed.store(true);
        fn();
        g_allocArmed.store(false);
        return g_allocBytes.load() - b0;
    };

    long long rsBytes = 0, coreBytes = 0, classicOnlyEstimate = 0;
    {
        auto fx = std::make_unique<XlethResonanceSuppressorEffect>();
        configureRsHighQualityNew(*fx);
        rsBytes = bytesOf([&] { fx->prepareToPlay(kSR, 512); });
    }
    {
        auto core = std::make_unique<xleth::dsp::resonance::Core>();
        coreBytes = bytesOf([&] { core->prepare(kSR, 512, 2); });
    }
    classicOnlyEstimate = rsBytes - coreBytes;

    constexpr int kInstances = 16;
    std::vector<std::unique_ptr<XlethResonanceSuppressorEffect>> many;
    many.reserve(kInstances);
    const std::size_t pb0 = privateBytes();
    for (int i = 0; i < kInstances; ++i)
    {
        many.push_back(std::make_unique<XlethResonanceSuppressorEffect>());
        configureRsHighQualityNew(*many.back());
        many.back()->prepareToPlay(kSR, 512);
    }
    const std::size_t pb1 = privateBytes();
    const double perInstanceMb = pb1 > pb0 ? static_cast<double>(pb1 - pb0) / kInstances / (1024.0 * 1024.0) : 0.0;

    std::printf("[RSLLAlloc] memory (48 kHz stereo, block 512): RS prepareToPlay operator-new bytes %.3f MB "
                "(ResonanceCore %.3f MB, rest = 3 WolaProcessors + buffers %.3f MB); private bytes per prepared "
                "instance (16 instances) %.3f MB\n",
                rsBytes / (1024.0 * 1024.0), coreBytes / (1024.0 * 1024.0), classicOnlyEstimate / (1024.0 * 1024.0),
                perInstanceMb);
    CHECK(rsBytes > 0 && coreBytes > 0, "case g: byte counter saw the prepare allocations");
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
    std::printf("[RSLLAlloc] negative control: 2 deliberate allocations -> counter saw %lld\n", seen);
    CHECK(seen == 2, "operator-new counter negative control (expected 2, saw " << seen << ")");
}

int main(int argc, char** argv)
{
    juce::ScopedJuceInitialiser_GUI juceInit;
    t_isMeasuringThread = true;   // this thread stands in for the audio thread
    for (int i = 1; i < argc; ++i)
        if (std::strcmp(argv[i], "--write-ll-fixtures") == 0)
            return writeFixtures();   // only meaningful on a build that still has the pre-P1a LL code

    std::cout << "[RSLLAlloc] === test_effect_processblock_alloc ===\n";
    std::cout << "[RSLLAlloc] counts operator new/new[] only; juce::HeapBlock/Array (malloc) is NOT counted\n";

    counterNegativeControl();

    for (int block : kBlockSizes)
    {
        const juce::AudioBuffer<float> sig = makeSignal(signalSamplesFor(block));
        runCaseRsLL(block, sig);
        runCaseRsHQ(block, sig);
        runCaseRsNew(block, sig);
        runCaseEqSpectral(block, sig);
    }

    runStressRsStructure();
    runMemoryReport();

    runNullTests();

    std::cout << "[RSLLAlloc] --- " << g_passed << " passed, " << g_failed << " failed ---\n";
    if (g_failed == 0) { std::cout << "[RSLLAlloc] ALL TESTS PASSED\n"; return 0; }
    return 1;
}
