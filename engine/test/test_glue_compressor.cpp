// test_glue_compressor.cpp — CompressorCore + Glue VCA ("glue") behaviour tests
// Build: cmake --build build --config Release --target test_glue_compressor
// Run:   ctest --test-dir build -C Release -R "^test_glue_compressor$" -V
// Pass:  prints "ALL TESTS PASSED" and exits 0
//
// docs/Compressor_Archetypes_Deep_Dive.md §10, the items that apply to a VCA
// glue compressor. Compressors are nonlinear and time-varying, so every check
// is behavioural — curves, envelopes, identities — never a waveform null
// against hardware.
//
//   [1] Gain computer: the feedback (inverse-curve) form is the exact inverse
//       of the feedforward Giannoulis curve, so a closed loop settles on it.
//   [2] §10.1 Static curve: steady level from −60 to +10 dBFS, settled output
//       vs the gain computer, both topologies, all three ratios; plus the whole
//       oversampled effect with a 1 kHz sine.
//   [3] §10.2 Ballistics, ONE time-constant definition (one-pole τ, 63.2 %):
//       feedforward attack/release match τ·fs to a sample; the tracked loop
//       matches its predicted closed-loop pole (τ/R above the knee); and the
//       oversampled effect keeps τ in host time (coefficients at the OS rate).
//   [4] §10.4 Auto release is program dependent: a peak train leaves far more
//       gain reduction behind than a single peak; a fixed release does not.
//   [5] §10.8 Stereo link: identical gain on both channels, per sample; the
//       effect is exactly mirror-symmetric in L/R.
//   [6] Stepped controls crossfade coefficient sets (no zipper): a ratio switch
//       at the fastest attack slews GR ≥ 10× slower than a hard switch.
//   [7] §10.10 Realtime safety: zero allocations in processBlock across
//       parameter changes; no subnormals and no slowdown in silence after a
//       loud signal; the implicit loop is stable (no ringing) at 10:1 / 0.1 ms
//       at 44.1 kHz WITHOUT oversampling, where the naive loop diverges.
//   [8] Latency / PDC: the reported latency is the measured oversampler
//       latency, an impulse emerges exactly there, and bypass nulls against the
//       latency-aligned dry.
//   [9] Surface: parameter layout, and "glue" is created by AudioGraph.

#include "audio/CompressorCore.h"
#include "audio/EffectChainManager.h"
#include "audio/XlethGlueCompressorEffect.h"
#include "dsp/DspPrimitives.h"

#include <juce_audio_basics/juce_audio_basics.h>
#include <juce_audio_processors/juce_audio_processors.h>
#include <juce_core/juce_core.h>
#include <juce_dsp/juce_dsp.h>
#include <juce_events/juce_events.h>
#include <juce_gui_basics/juce_gui_basics.h>

#include <algorithm>
#include <atomic>
#include <chrono>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <iostream>
#include <new>
#include <random>
#include <string>
#include <vector>

// ─── Counting allocator (armed only around the calls under test) ────────────

// Armed PER THREAD: only allocations made by the thread running the call under
// test count. A process-wide flag also catches JUCE's own background threads
// (seen: one stray allocation, at a random early block, with no parameter
// activity at all), which says nothing about the audio callback.
namespace {
struct ThreadArm
{
    static inline thread_local bool on = false;   // constant-initialised: no TLS allocation
    void store(bool v) noexcept { on = v; }
    bool load(std::memory_order = std::memory_order_relaxed) const noexcept { return on; }
};
ThreadArm              g_allocArmed;
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

#define CHECK(cond, msg)                                                        \
    do {                                                                        \
        if (cond) { ++g_passed; }                                               \
        else { ++g_failed; std::cout << "  FAIL [" << __LINE__ << "] " << msg << "\n"; } \
    } while (0)

using namespace xleth;
using Core     = comp::GlueCompressorCore;
using Settings = Core::Settings;
using Glue     = XlethGlueCompressorEffect;

namespace
{

constexpr double kPi = 3.14159265358979323846;

Settings makeSettings(float ratio, float attackMs, float releaseMs, bool autoRel,
                      comp::Topology topo, float knee = Glue::kKneeDb)
{
    Settings s;
    s.gc.ratio = ratio;
    s.gc.kneeDb = knee;
    s.bal.attackMs = attackMs;
    s.bal.releaseMs = releaseMs;
    s.bal.autoRelease = autoRel;
    s.topology = topo;
    return s;
}

// Runs a mono/stereo signal through a prepared core with constant threshold
// and makeup, recording per-sample GR. Signals are processed in place.
void runCore(Core& core, std::vector<float>& L, std::vector<float>* R,
             float thresholdDb, float makeupDb, std::vector<float>* grOut = nullptr)
{
    constexpr int kChunk = 64;
    float thr[kChunk], mk[kChunk];
    std::fill(std::begin(thr), std::end(thr), thresholdDb);
    std::fill(std::begin(mk),  std::end(mk),  makeupDb);
    const int n = static_cast<int>(L.size());
    if (grOut) grOut->assign(static_cast<size_t>(n), 0.0f);
    for (int s = 0; s < n; s += 1)
    {
        // One sample at a time so the GR trace is exact per sample.
        float* l = L.data() + s;
        float* r = R ? R->data() + s : l;
        core.process(l, r, 1, thr, mk, 1);
        if (grOut) (*grOut)[static_cast<size_t>(s)] = core.getGainReductionDb();
    }
}

// Square wave: |x| is constant, so a peak detector sees a steady level and the
// GR trace is a clean one-pole response with no waveform ripple.
std::vector<float> square(int n, float amp, int periodSamples = 48)
{
    std::vector<float> v(static_cast<size_t>(n));
    for (int i = 0; i < n; ++i)
        v[static_cast<size_t>(i)] = ((i / (periodSamples / 2)) % 2 == 0) ? amp : -amp;
    return v;
}

float dbToAmp(float db) { return std::pow(10.0f, db / 20.0f); }
float ampToDb(float a)  { return 20.0f * std::log10(std::max(a, 1.0e-12f)); }

// First index at which trace crosses `level` in the given direction.
int firstCrossing(const std::vector<float>& v, int from, float level, bool rising)
{
    for (int i = from; i < static_cast<int>(v.size()); ++i)
        if (rising ? v[static_cast<size_t>(i)] >= level : v[static_cast<size_t>(i)] <= level)
            return i;
    return -1;
}

// Neutral effect setup for measurements: colour off, HPF out, makeup 0.
void neutral(Glue& fx)
{
    fx.setParameterValue("color", 0.0f);
    fx.setParameterValue("sc_hpf_on", 0.0f);
    fx.setParameterValue("makeup", 0.0f);
}

void processEffect(Glue& fx, juce::AudioBuffer<float>& buf, int block)
{
    juce::MidiBuffer midi;
    const int n = buf.getNumSamples();
    for (int s = 0; s < n; s += block)
    {
        const int len = std::min(block, n - s);
        juce::AudioBuffer<float> view(buf.getArrayOfWritePointers(), buf.getNumChannels(), s, len);
        fx.processBlock(view, midi);
    }
}

} // namespace

// ─── [1] Gain computer: FF curve and its FB inverse ─────────────────────────

static void testGainComputer()
{
    std::cout << "\n[1] soft-knee gain computer: feedback form inverts the feedforward curve\n";
    float worst = 0.0f;
    for (float R : { 2.0f, 4.0f, 10.0f })
        for (float W : { 0.0f, 4.0f, 12.0f })
        {
            dsp::SoftKneeGC::Params p { R, W };
            const float T = -20.0f;
            for (float x = -60.0f; x <= 10.0f; x += 0.05f)
            {
                float sff, sfb;
                const float y   = dsp::SoftKneeGC::outputDb(x, T, p);
                const float rff = dsp::SoftKneeGC::reductionFF(x, T, p, sff);
                const float rfb = dsp::SoftKneeGC::reductionFB(y, T, p, sfb);
                worst = std::max(worst, std::abs(rff - (x - y)));
                worst = std::max(worst, std::abs(rfb - rff));
                // Slopes: dr/dx = dc/dv · dv/dx, dv/dx = 1 − dr/dx  ⇒  dc/dv = s/(1−s)
                if (sff < 0.999f)
                    worst = std::max(worst, std::abs(sfb - sff / (1.0f - sff)) * 0.01f);
            }
            float s;
            CHECK(std::abs(dsp::SoftKneeGC::reductionFB(T + 10.0f, T, p, s) - (R - 1.0f) * 10.0f) < 1e-3f,
                  "above-knee FB slope is R-1 (R=" << R << ")");
        }
    std::printf("    worst FF/FB inconsistency: %.2e dB\n", worst);
    CHECK(worst < 2e-4f, "FB reduction is the exact inverse of the FF curve (worst " << worst << " dB)");
}

// ─── [2] Static curve ────────────────────────────────────────────────────────

static void testStaticCurve()
{
    std::cout << "\n[2] static curve vs the gain computer (steady level, settled)\n";
    constexpr double fs = 48000.0;
    const float T = -20.0f;

    for (auto topo : { comp::Topology::TrackedFeedback, comp::Topology::FeedForward })
        for (float R : Glue::kRatios)
        {
            float worst = 0.0f;
            for (float lvl = -60.0f; lvl <= 10.0f; lvl += 2.0f)
            {
                Core core;
                core.setColorEnabled(false);
                core.prepare(fs, makeSettings(R, 0.1f, 100.0f, false, topo));
                auto x = square(static_cast<int>(fs * 0.3), dbToAmp(lvl));
                runCore(core, x, nullptr, T, 0.0f);
                const float outDb = ampToDb(std::abs(x.back()));
                const float want  = core.staticOutputDb(lvl, T);
                worst = std::max(worst, std::abs(outDb - want));
            }
            std::printf("    %-8s %4.0f:1  worst |measured - GC| = %.4f dB\n",
                        topo == comp::Topology::FeedForward ? "FF" : "tracked", R, worst);
            CHECK(worst < 0.01f, "static curve matches the GC within 0.01 dB (worst " << worst << ")");
        }

    // The whole effect: 1 kHz sine, fastest attack / slowest release, 2x OS.
    std::cout << "    effect, 1 kHz sine, 0.1 ms / 1.2 s, tracked 4:1, T=-20:\n";
    float worst = 0.0f;
    for (float lvl = -40.0f; lvl <= 6.0f; lvl += 4.0f)
    {
        Glue fx;
        fx.prepareToPlay(fs, 512);
        neutral(fx);
        fx.setParameterValue("threshold", -20.0f);
        fx.setParameterValue("ratio", 1.0f);
        fx.setParameterValue("attack", 0.0f);
        fx.setParameterValue("release", 3.0f);
        fx.prepareToPlay(fs, 512);           // snap smoothers onto the settings
        const int n = static_cast<int>(fs * 1.0);
        juce::AudioBuffer<float> b(2, n);
        const float a = dbToAmp(lvl);
        for (int i = 0; i < n; ++i)
        {
            const float v = a * static_cast<float>(std::sin(2.0 * kPi * 1000.0 * i / fs));
            b.setSample(0, i, v);
            b.setSample(1, i, v);
        }
        processEffect(fx, b, 512);
        double sq = 0.0;
        const int w = static_cast<int>(fs * 0.1);
        for (int i = n - w; i < n; ++i) sq += double(b.getSample(0, i)) * b.getSample(0, i);
        const float peakDb = ampToDb(static_cast<float>(std::sqrt(sq / w) * std::sqrt(2.0)));
        const float want   = fx.getCore().staticOutputDb(lvl, -20.0f);
        worst = std::max(worst, std::abs(peakDb - want));
        std::printf("      in %6.1f dBFS  out %7.2f  GC %7.2f\n", lvl, peakDb, want);
    }
    CHECK(worst < 0.3f, "oversampled effect settles on the GC curve within 0.3 dB (worst " << worst << ")");
}

// ─── [3] Ballistics, one time-constant definition ────────────────────────────

static void testBallistics()
{
    std::cout << "\n[3] ballistics: one-pole tau (63.2 %), measured in samples\n";
    constexpr double fs = 48000.0;
    const float T = -20.0f;
    const int pre = 2000;

    // Feedforward: GR target is a constant step, so GR(n) = rho(1 - a^n) and
    // the 63.2 % crossing sits at n = tau*fs.
    for (float atk : Glue::kAttacksMs)
    {
        Core core;
        core.setColorEnabled(false);
        core.prepare(fs, makeSettings(4.0f, atk, 1200.0f, false, comp::Topology::FeedForward));
        auto x = square(pre, dbToAmp(-40.0f));
        auto hi = square(static_cast<int>(fs * 0.4), dbToAmp(0.0f));
        x.insert(x.end(), hi.begin(), hi.end());
        std::vector<float> gr;
        runCore(core, x, nullptr, T, 0.0f, &gr);
        const float rho = gr.back();
        const int n63 = firstCrossing(gr, pre, rho * (1.0f - std::exp(-1.0f)), true) - pre + 1;
        const double want = atk * 1e-3 * fs;
        std::printf("    FF attack  %6.1f ms: 63%% at %7d samples (tau*fs = %8.1f)\n", atk, n63, want);
        CHECK(std::abs(n63 - want) <= 1.0, "FF attack " << atk << " ms: " << n63 << " vs " << want);
    }
    for (float rel : Glue::kReleasesMs)
    {
        Core core;
        core.setColorEnabled(false);
        core.prepare(fs, makeSettings(4.0f, 0.1f, rel, false, comp::Topology::FeedForward));
        auto x = square(static_cast<int>(fs * 0.2), dbToAmp(0.0f));
        const int stepAt = static_cast<int>(x.size());
        auto lo = square(static_cast<int>(fs * 3.0), dbToAmp(-60.0f));
        x.insert(x.end(), lo.begin(), lo.end());
        std::vector<float> gr;
        runCore(core, x, nullptr, T, 0.0f, &gr);
        const float g0 = gr[static_cast<size_t>(stepAt - 1)];
        const int n37 = firstCrossing(gr, stepAt, g0 * std::exp(-1.0f), false) - stepAt + 1;
        const double want = rel * 1e-3 * fs;
        std::printf("    FF release %6.0f ms: 37%% at %7d samples (tau*fs = %8.1f)\n", rel, n37, want);
        CHECK(std::abs(n37 - want) <= 1.0, "FF release " << rel << " ms: " << n37 << " vs " << want);
    }

    // Tracked loop, above the knee throughout: the implicit step is
    //   GR = [a·GRp + (1−a)(R−1)(L−T)] / [1 + (1−a)(R−1)]
    // a one-pole with p = a / (1 + (1−a)(R−1)) — τ_eff ≈ τ/R (§2.1 point 3).
    for (float R : Glue::kRatios)
        for (float atk : { 3.0f, 10.0f, 30.0f })
        {
            Core core;
            core.setColorEnabled(false);
            core.prepare(fs, makeSettings(R, atk, 1200.0f, false, comp::Topology::TrackedFeedback));
            auto x = square(pre, dbToAmp(-40.0f));
            auto hi = square(static_cast<int>(fs * 0.4), dbToAmp(0.0f));
            x.insert(x.end(), hi.begin(), hi.end());
            std::vector<float> gr;
            runCore(core, x, nullptr, T, 0.0f, &gr);
            const float rho = gr.back();
            const int n63 = firstCrossing(gr, pre, rho * (1.0f - std::exp(-1.0f)), true) - pre + 1;
            const double a = std::exp(-1.0 / (atk * 1e-3 * fs));
            const double p = a / (1.0 + (1.0 - a) * (R - 1.0));
            const double want = -1.0 / std::log(p);
            std::printf("    tracked %4.0f:1 attack %5.1f ms: 63%% at %6d samples (pole predicts %7.1f, tau/R = %7.1f)\n",
                        R, atk, n63, want, atk * 1e-3 * fs / R);
            CHECK(std::abs(n63 - want) <= 1.0, "tracked attack follows the closed-loop pole (R=" << R << ", " << atk << " ms)");
        }

    // Effect level: 2x oversampled, so every coefficient must be computed at
    // 96 kHz for tau to come out in HOST samples. DC step, FF, colour off.
    for (int atkIdx : { 4, 5 })
    {
        Glue fx;
        fx.prepareToPlay(fs, 480);
        neutral(fx);
        fx.setParameterValue("threshold", -30.0f);
        fx.setParameterValue("topology", 1.0f);
        fx.setParameterValue("attack", static_cast<float>(atkIdx));
        fx.setParameterValue("release", 3.0f);
        fx.prepareToPlay(fs, 480);
        const int lat = fx.getLatencySamples();
        const int n = static_cast<int>(fs * 0.5), step = 9600;
        juce::AudioBuffer<float> b(2, n);
        for (int i = 0; i < n; ++i)
        {
            const float v = i < step ? 0.001f : 0.1f;
            b.setSample(0, i, v);
            b.setSample(1, i, v);
        }
        processEffect(fx, b, 480);
        std::vector<float> gr(static_cast<size_t>(n), 0.0f);
        for (int i = step + lat; i < n; ++i)
            gr[static_cast<size_t>(i)] = -ampToDb(b.getSample(0, i) / 0.1f);
        const float rho = gr.back();
        const int n63 = firstCrossing(gr, step + lat + 64, rho * (1.0f - std::exp(-1.0f)), true) - (step + lat) + 1;
        const double want = Glue::kAttacksMs[static_cast<size_t>(atkIdx)] * 1e-3 * fs;
        std::printf("    effect (2x OS) FF attack %4.0f ms: 63%% at %6d host samples (tau*fs = %6.1f)\n",
                    Glue::kAttacksMs[static_cast<size_t>(atkIdx)], n63, want);
        CHECK(std::abs(n63 - want) <= 3.0, "oversampled effect keeps tau in host time");
    }
}

// ─── [4] Auto release program dependence ─────────────────────────────────────

struct ReleaseStats { float grAfter300ms; float msTo1dB; };

static ReleaseStats burstRelease(bool train, bool autoRel, comp::Topology topo)
{
    constexpr double fs = 48000.0;
    Core core;
    core.setColorEnabled(false);
    core.prepare(fs, makeSettings(4.0f, 1.0f, 300.0f, autoRel, topo));
    const int on = static_cast<int>(fs * 0.05), off = on;
    std::vector<float> x;
    auto quiet = square(static_cast<int>(fs * 0.2), dbToAmp(-70.0f));
    x.insert(x.end(), quiet.begin(), quiet.end());
    const int bursts = train ? 20 : 1;
    for (int k = 0; k < bursts; ++k)
    {
        auto b = square(on, dbToAmp(-10.0f));
        x.insert(x.end(), b.begin(), b.end());
        if (k + 1 < bursts)
        {
            auto g = square(off, dbToAmp(-70.0f));
            x.insert(x.end(), g.begin(), g.end());
        }
    }
    const int end = static_cast<int>(x.size());
    auto tail = square(static_cast<int>(fs * 40.0), dbToAmp(-70.0f));
    x.insert(x.end(), tail.begin(), tail.end());
    std::vector<float> gr;
    runCore(core, x, nullptr, -30.0f, 0.0f, &gr);
    ReleaseStats r;
    r.grAfter300ms = gr[static_cast<size_t>(end + static_cast<int>(fs * 0.3))];
    const int c = firstCrossing(gr, end, 1.0f, false);
    r.msTo1dB = c < 0 ? 1e9f : static_cast<float>((c - end) * 1000.0 / fs);
    return r;
}

static void testAutoRelease()
{
    std::cout << "\n[4] auto release: program dependence (single peak vs peak train)\n";
    for (auto topo : { comp::Topology::TrackedFeedback, comp::Topology::FeedForward })
    {
        const char* tn = topo == comp::Topology::FeedForward ? "FF" : "tracked";
        const auto single = burstRelease(false, true, topo);
        const auto train  = burstRelease(true,  true, topo);
        std::printf("    %-7s AUTO : single GR@300ms %5.2f dB, to 1 dB %8.0f ms | train GR@300ms %5.2f dB, to 1 dB %8.0f ms\n",
                    tn, single.grAfter300ms, single.msTo1dB, train.grAfter300ms, train.msTo1dB);
        CHECK(train.grAfter300ms > 3.0f * single.grAfter300ms, tn << ": train holds > 3x the GR of a single peak");
        CHECK(train.msTo1dB > 4.0f * single.msTo1dB, tn << ": train releases > 4x slower than a single peak");
        CHECK(single.msTo1dB < 600.0f, tn << ": a lone peak releases on the fast (100 ms) stage");

        const auto fs1 = burstRelease(false, false, topo);
        const auto ft1 = burstRelease(true,  false, topo);
        std::printf("    %-7s 300ms: single GR@300ms %5.2f dB | train GR@300ms %5.2f dB (control)\n",
                    tn, fs1.grAfter300ms, ft1.grAfter300ms);
        CHECK(std::abs(ft1.grAfter300ms - fs1.grAfter300ms) < 0.05f * fs1.grAfter300ms + 0.01f,
              tn << ": fixed release has no program dependence (negative control)");
    }
}

// ─── [5] Stereo link ─────────────────────────────────────────────────────────

static void testStereoLink()
{
    std::cout << "\n[5] stereo link: identical gain on both channels\n";
    constexpr double fs = 48000.0;
    for (auto topo : { comp::Topology::TrackedFeedback, comp::Topology::FeedForward })
    {
        Core core;
        core.setColorEnabled(false);
        core.prepare(fs, makeSettings(10.0f, 0.1f, 100.0f, false, topo));
        const int n = static_cast<int>(fs * 0.5);
        std::vector<float> L(static_cast<size_t>(n)), R(static_cast<size_t>(n)), L0, R0;
        for (int i = 0; i < n; ++i)
        {
            L[static_cast<size_t>(i)] = 0.9f * static_cast<float>(std::sin(2.0 * kPi * 440.0 * i / fs));
            R[static_cast<size_t>(i)] = 0.02f * static_cast<float>(std::sin(2.0 * kPi * 1234.5 * i / fs));
        }
        L0 = L; R0 = R;
        runCore(core, L, &R, -30.0f, 0.0f);
        double worst = 0.0;
        int compared = 0;
        for (int i = 0; i < n; ++i)
        {
            const float xl = L0[static_cast<size_t>(i)], xr = R0[static_cast<size_t>(i)];
            if (std::abs(xl) < 1e-2f || std::abs(xr) < 1e-3f) continue;
            const double gl = L[static_cast<size_t>(i)] / xl, gr = R[static_cast<size_t>(i)] / xr;
            worst = std::max(worst, std::abs(gl - gr) / std::abs(gl));
            ++compared;
        }
        std::printf("    %-7s left-driven GR applied to right: worst relative gain mismatch %.2e over %d samples\n",
                    topo == comp::Topology::FeedForward ? "FF" : "tracked", worst, compared);
        CHECK(compared > 1000 && worst < 1e-5, "linked gain is identical per sample");
    }

    // The effect (2x OS, colour on): left-only drive and right-only drive are
    // exact mirror images, and report the same gain reduction.
    auto runSide = [&](int loudCh, juce::AudioBuffer<float>& out) -> float {
        Glue fx;
        fx.prepareToPlay(fs, 512);
        fx.setParameterValue("threshold", -30.0f);
        fx.setParameterValue("attack", 0.0f);
        fx.prepareToPlay(fs, 512);
        const int n = static_cast<int>(fs * 0.3);
        out.setSize(2, n);
        for (int i = 0; i < n; ++i)
        {
            const float loud  = 0.8f * static_cast<float>(std::sin(2.0 * kPi * 220.0 * i / fs));
            const float quiet = 0.01f * static_cast<float>(std::sin(2.0 * kPi * 3000.0 * i / fs));
            out.setSample(loudCh, i, loud);
            out.setSample(1 - loudCh, i, quiet);
        }
        processEffect(fx, out, 512);
        return fx.readMeterValue(2);
    };
    juce::AudioBuffer<float> a, b;
    const float grA = runSide(0, a), grB = runSide(1, b);
    bool mirrored = true;
    for (int i = 0; i < a.getNumSamples() && mirrored; ++i)
        mirrored = a.getSample(0, i) == b.getSample(1, i) && a.getSample(1, i) == b.getSample(0, i);
    std::printf("    effect: GR meter left-driven %.3f dB / right-driven %.3f dB, mirror-exact: %s\n",
                grA, grB, mirrored ? "yes" : "NO");
    CHECK(grA > 10.0f, "the loud channel drives real gain reduction");
    CHECK(grA == grB, "same gain reduction whichever channel drives it");
    CHECK(mirrored, "effect output is exactly L/R mirror-symmetric");
}

// ─── [6] Stepped-control crossfade ───────────────────────────────────────────

static float maxGrSlewAfterSwitch(double crossfadeSeconds, Settings from, Settings to)
{
    constexpr double fs = 48000.0;
    Core::Config cfg;
    cfg.crossfadeSeconds = crossfadeSeconds;
    Core core(cfg);
    core.setColorEnabled(false);
    core.prepare(fs, from);
    auto x = square(static_cast<int>(fs * 0.3), dbToAmp(0.0f));
    runCore(core, x, nullptr, -30.0f, 0.0f);
    core.setSettings(to);
    auto y = square(static_cast<int>(fs * 0.3), dbToAmp(0.0f));
    std::vector<float> gr;
    const float before = core.getGainReductionDb();
    runCore(core, y, nullptr, -30.0f, 0.0f, &gr);
    float worst = std::abs(gr[0] - before);
    for (size_t i = 1; i < gr.size(); ++i) worst = std::max(worst, std::abs(gr[i] - gr[i - 1]));
    return worst;
}

static void testSteppedCrossfade()
{
    std::cout << "\n[6] stepped controls crossfade coefficient sets (no zipper)\n";
    struct Case { const char* name; Settings a, b; };
    const auto TF = comp::Topology::TrackedFeedback, FF = comp::Topology::FeedForward;
    const Case cases[] = {
        { "ratio 2:1 -> 10:1 @0.1 ms", makeSettings(2.0f, 0.1f, 100.0f, false, TF), makeSettings(10.0f, 0.1f, 100.0f, false, TF) },
        { "ratio 10:1 -> 2:1 @0.1 ms", makeSettings(10.0f, 0.1f, 100.0f, false, TF), makeSettings(2.0f, 0.1f, 100.0f, false, TF) },
        { "topology FF -> tracked",    makeSettings(10.0f, 0.1f, 100.0f, false, FF), makeSettings(10.0f, 0.1f, 100.0f, false, TF) },
        { "release 1.2 s -> Auto",     makeSettings(4.0f, 0.1f, 1200.0f, false, TF),  makeSettings(4.0f, 0.1f, 1200.0f, true, TF) },
    };
    for (const auto& c : cases)
    {
        const float hard = maxGrSlewAfterSwitch(1.0 / 48000.0, c.a, c.b);
        const float soft = maxGrSlewAfterSwitch(0.030, c.a, c.b);
        std::printf("    %-28s max |dGR|/sample: hard switch %7.4f dB, crossfaded %7.4f dB\n", c.name, hard, soft);
        if (hard > 0.05f)
            CHECK(soft * 10.0f < hard, c.name << ": crossfade slews >= 10x slower than a hard switch");
        CHECK(soft < 0.05f, c.name << ": crossfaded GR moves < 0.05 dB per sample");
    }
}

// ─── [7] Realtime safety ─────────────────────────────────────────────────────

static void testRealtimeSafety()
{
    std::cout << "\n[7] realtime safety: allocations, denormals, loop stability\n";
    constexpr double fs = 48000.0;
    constexpr int block = 512;

    {
        Glue fx;
        fx.prepareToPlay(fs, block);
        juce::AudioBuffer<float> b(2, block);
        juce::MidiBuffer midi;
        std::mt19937 rng(3);
        std::uniform_real_distribution<float> d(-1.0f, 1.0f);
        long long allocs = 0;
        for (int k = 0; k < 400; ++k)
        {
            for (int c = 0; c < 2; ++c)
                for (int i = 0; i < block; ++i) b.setSample(c, i, d(rng));
            // Every stepped control and toggle moves during the run (param
            // writes happen on the "message thread", outside the counter).
            auto sp = [&](const char* id, float v) { fx.setParameterValue(id, v); };
            sp("ratio",     static_cast<float>(k % 3));
            sp("attack",    static_cast<float>(k % 6));
            sp("release",   static_cast<float>(k % 5));
            sp("topology",  static_cast<float>((k / 7) % 2));
            sp("sc_hpf_on", static_cast<float>((k / 5) % 2));
            sp("sc_hpf_freq", 20.0f + static_cast<float>(k % 48) * 10.0f);
            sp("color",     static_cast<float>((k / 11) % 2));
            sp("threshold", -40.0f + static_cast<float>(k % 40));
            fx.setBypassed((k / 50) % 2 == 1);
            g_allocCount.store(0);
            g_allocArmed.store(true);
            fx.processBlock(b, midi);
            g_allocArmed.store(false);
            if (g_allocCount.load() > 0)
                std::printf("    [alloc] block %d: %lld allocation(s)\n", k, g_allocCount.load());
            allocs += g_allocCount.load();
        }
        std::printf("    processBlock allocations over 400 blocks of parameter churn: %lld\n", allocs);
        CHECK(allocs == 0, "processBlock never allocates");
        g_allocCount.store(0);
        g_allocArmed.store(true);
        // reset() is what a transport jump runs on the audio thread (directly,
        // or via XlethEffectBase::resetOnAudioThread's default), so it too must
        // be a pure state clear.
        fx.reset();
        g_allocArmed.store(false);
        CHECK(g_allocCount.load() == 0, "reset() is a pure state clear (no allocation)");
    }

    {
        // Loud, then a long silence: nothing subnormal, and silence is not slow.
        Glue fx;
        fx.prepareToPlay(fs, block);
        fx.setParameterValue("release", 4.0f);   // Auto: longest-lived state
        juce::AudioBuffer<float> b(2, block);
        juce::MidiBuffer midi;
        using clk = std::chrono::steady_clock;
        double loudUs = 0.0, silentUs = 0.0;
        int subnormals = 0, nonFinite = 0;
        const int loudBlocks = static_cast<int>(fs * 1.0 / block);
        const int quietBlocks = static_cast<int>(fs * 10.0 / block);
        for (int k = 0; k < loudBlocks + quietBlocks; ++k)
        {
            const bool loud = k < loudBlocks;
            for (int c = 0; c < 2; ++c)
                for (int i = 0; i < block; ++i)
                    b.setSample(c, i, loud ? 0.9f * static_cast<float>(std::sin(2.0 * kPi * 60.0 * (k * block + i) / fs)) : 0.0f);
            const auto t0 = clk::now();
            fx.processBlock(b, midi);
            const double us = std::chrono::duration<double, std::micro>(clk::now() - t0).count();
            if (loud) loudUs += us; else if (k > loudBlocks + quietBlocks / 2) silentUs += us;
            for (int c = 0; c < 2; ++c)
                for (int i = 0; i < block; ++i)
                {
                    const float v = b.getSample(c, i);
                    if (!std::isfinite(v)) ++nonFinite;
                    else if (v != 0.0f && std::fpclassify(v) == FP_SUBNORMAL) ++subnormals;
                }
        }
        const float gr = fx.getCore().getGainReductionDb();
        const double loudPer = loudUs / loudBlocks, silentPer = silentUs / (quietBlocks / 2 - 1);
        std::printf("    loud %.1f us/block, late silence %.1f us/block, subnormal outputs %d, GR state %.3g\n",
                    loudPer, silentPer, subnormals, gr);
        CHECK(nonFinite == 0, "all outputs finite");
        CHECK(subnormals == 0, "no subnormal output samples in silence after a loud signal");
        CHECK(gr == 0.0f || std::fpclassify(gr) != FP_SUBNORMAL, "GR state never subnormal");
        CHECK(silentPer < 3.0 * loudPer + 20.0, "silence after a loud signal is not slower (denormal stall)");
    }

    {
        // Extreme feedback settings at 44.1 kHz with NO oversampling. The naive
        // one-sample-late loop has pole 1 − (1−a)·R: below −1 here, so it rings
        // and diverges. The implicit solve must settle smoothly.
        constexpr double fs44 = 44100.0;
        const double a = std::exp(-1.0 / (0.1e-3 * fs44));
        const double naivePole = 1.0 - (1.0 - a) * 10.0;
        Core core;
        core.setColorEnabled(false);
        core.prepare(fs44, makeSettings(10.0f, 0.1f, 100.0f, false, comp::Topology::TrackedFeedback));
        auto x = square(static_cast<int>(fs44 * 0.5), dbToAmp(10.0f), 882);
        std::vector<float> gr;
        runCore(core, x, nullptr, -40.0f, 0.0f, &gr);
        float lateSlew = 0.0f;
        int alternations = 0;
        for (size_t i = gr.size() / 2 + 1; i < gr.size(); ++i)
        {
            lateSlew = std::max(lateSlew, std::abs(gr[i] - gr[i - 1]));
            if (i > gr.size() / 2 + 1 && (gr[i] - gr[i - 1]) * (gr[i - 1] - gr[i - 2]) < -1e-12f) ++alternations;
        }
        bool bounded = true;
        for (float v : x) bounded = bounded && std::isfinite(v) && std::abs(v) < 4.0f;
        std::printf("    10:1 / 0.1 ms / 44.1 kHz no OS: naive loop pole %.3f (unstable), implicit: late |dGR| %.2e dB, "
                    "sign flips %d, GR %.2f dB\n", naivePole, lateSlew, alternations, gr.back());
        CHECK(naivePole < -1.0, "the test really is in the naive loop's unstable region");
        CHECK(bounded, "output bounded at extreme settings");
        CHECK(lateSlew < 1e-3f && alternations == 0, "implicit feedback loop settles without ringing");
        CHECK(std::abs(gr.back() - (50.0f - 50.0f / 10.0f)) < 0.05f, "and settles on the 10:1 curve (45 dB GR)");
    }
}

// ─── [8] Latency, PDC, bypass ────────────────────────────────────────────────

static void testLatencyAndBypass()
{
    std::cout << "\n[8] latency reporting and latency-aligned bypass\n";
    constexpr double fs = 48000.0;
    Glue fx;
    fx.prepareToPlay(fs, 480);
    neutral(fx);
    fx.setParameterValue("threshold", 0.0f);
    fx.prepareToPlay(fs, 480);
    const int lat = fx.getLatencySamples();
    std::printf("    2x FIR oversampler latency: %d samples (%.3f ms), reported to PDC: %d\n",
                fx.getOversamplingLatencySamples(), lat * 1000.0 / fs, lat);
    CHECK(lat > 0 && lat == fx.getOversamplingLatencySamples(), "reported latency is the measured oversampler latency");

    juce::AudioBuffer<float> b(2, 4800);
    b.clear();
    b.setSample(0, 100, 0.25f);
    b.setSample(1, 100, 0.25f);
    processEffect(fx, b, 480);
    int peakAt = 0;
    for (int i = 0; i < b.getNumSamples(); ++i)
        if (std::abs(b.getSample(0, i)) > std::abs(b.getSample(0, peakAt))) peakAt = i;
    std::printf("    impulse at 100 emerges at %d (peak %.4f)\n", peakAt, b.getSample(0, peakAt));
    CHECK(peakAt == 100 + lat, "impulse delayed by exactly the reported latency");

    // Bypass (after the 5 ms fade) must equal the input delayed by `lat`.
    Glue by;
    by.prepareToPlay(fs, 480);
    by.setParameterValue("threshold", -40.0f);  // heavy compression + colour: the wet path is very different
    by.setBypassed(true);
    by.prepareToPlay(fs, 480);
    by.reset();
    const int n = 9600;
    juce::AudioBuffer<float> in(2, n), out(2, n);
    std::mt19937 rng(11);
    std::uniform_real_distribution<float> d(-0.7f, 0.7f);
    for (int c = 0; c < 2; ++c)
        for (int i = 0; i < n; ++i) in.setSample(c, i, d(rng));
    out.makeCopyOf(in);
    processEffect(by, out, 480);
    float worst = 0.0f;
    for (int c = 0; c < 2; ++c)
        for (int i = lat + 480; i < n; ++i)
            worst = std::max(worst, std::abs(out.getSample(c, i) - in.getSample(c, i - lat)));
    std::printf("    bypassed output vs latency-aligned input: worst |diff| = %.3g\n", worst);
    CHECK(worst == 0.0f, "bypass is sample-exact against the latency-aligned dry");
}

// ─── [9] Surface / registration ──────────────────────────────────────────────

static void testSurface()
{
    std::cout << "\n[9] parameter surface and registration\n";
    Glue fx;
    const auto params = fx.getParameters();
    CHECK(params.size() == 9, "9 APVTS parameters (got " << params.size() << ")");
    auto s = fx.currentSettings();
    CHECK(s.gc.ratio == 4.0f && s.bal.attackMs == 10.0f && s.bal.autoRelease
          && s.topology == comp::Topology::TrackedFeedback,
          "defaults: 4:1, 10 ms, Auto, classic tracked topology");
    CHECK(std::abs(fx.getParameterValue("sc_hpf_on")) < 1e-6f, "sidechain HPF defaults OUT");
    CHECK(std::abs(fx.getParameterValue("color") - 1.0f) < 1e-6f, "console colour defaults IN");

    EffectChainManager chain;
    chain.init(48000.0, 512);
    const int node = chain.addEffect("glue", 0);
    auto* e = node >= 0 ? chain.getEffect(node) : nullptr;
    CHECK(e != nullptr && e->getPluginId() == "glue", "AudioGraph creates \"glue\" as a stock effect");
    if (e) CHECK(e->getLatencySamples() > 0, "live chain instance reports its latency to PDC");
}

int main()
{
    juce::ScopedJuceInitialiser_GUI juceInit;
    std::cout << "test_glue_compressor — CompressorCore + Glue VCA\n";

    testGainComputer();
    testStaticCurve();
    testBallistics();
    testAutoRelease();
    testStereoLink();
    testSteppedCrossfade();
    testRealtimeSafety();
    testLatencyAndBypass();
    testSurface();

    std::cout << "\n" << g_passed << " passed, " << g_failed << " failed\n";
    if (g_failed == 0) std::cout << "ALL TESTS PASSED\n";
    return g_failed == 0 ? 0 : 1;
}
