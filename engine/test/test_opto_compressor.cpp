// test_opto_compressor.cpp — Opto Comp ("opto") behaviour tests
// Build: cmake --build build --config Release --target test_opto_compressor
// Run:   ctest --test-dir build -C Release -R "^test_opto_compressor$" -V
// Pass:  prints "ALL TESTS PASSED" and exits 0
//
// docs/Compressor_Archetypes_Deep_Dive.md §3.4 and §10, the items that apply to
// an opto leveler. Behavioural only — curves, envelopes, identities — never a
// waveform null against hardware.
//
//   [1] Model pieces: the Limit sidechain's loop slope is the exact derivative;
//       Compress is the plain feedback form; ballistics predict() is monotone in
//       ρ with an exact derivative (what the implicit solve relies on); the dark
//       divider reads 0 dB.
//   [2] §10.1 Static curve sweep: the settled loop lands on the model's own
//       equilibrium; the knee is soft (no corner) and the ratio is not a
//       constant — ≈3:1 average in Compress, higher in Limit, both monotone to
//       40 dB of Peak Reduction; program dependence (crest factor, burst
//       length); Gain is outside the loop.
//   [3] §3.4 fitting procedure / §10.3 opto memory: 100 ms, 1 s and 10 s bursts
//       at a fixed level — the release tails MUST lengthen with burst length.
//       Negative controls: a single-τ cell releases identically after every
//       burst (fails the test); a two-speed cell WITHOUT the light history h
//       separates 100 ms from 1 s but not 1 s from 10 s.
//   [4] §10.2 Ballistics vs UA's figures: attack ≈10 ms, faster for bigger
//       transients; first 50 % of the release in ~60 ms; τ_slow within
//       0.5–15 s; coefficients rate-invariant (and the effect's core runs at 2×).
//   [5] §10.8 Stereo link: identical gain on both channels per sample; the
//       effect is exactly mirror-symmetric in L/R.
//   [6] Limit/Compress: the switch is material, lands on the new mode's
//       curve and never steps the gain (the core crossfades its two lanes).
//   [7] §10.7 Colour: the tube stage leads with the 2nd harmonic; 2×
//       oversampling keeps its harmonics from aliasing (negative control: the
//       same core at 1× aliases).
//   [8] §10.10 Realtime safety: zero allocations in processBlock across
//       parameter churn, reset() allocation-free, no subnormals after
//       loud-then-silence, loop stable at extreme settings without OS.
//   [9] Latency / PDC / bypass, and the parameter surface + registration.

#include "audio/EffectChainManager.h"
#include "audio/OptoCompressorCore.h"
#include "audio/XlethOptoCompressorEffect.h"
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

// ─── Counting allocator (armed per thread, only around the calls under test) ─

namespace {
struct ThreadArm
{
    static inline thread_local bool on = false;
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
using Core     = comp::OptoCompressorCore;
using Settings = Core::Settings;
using GC       = comp::ProgramDependentGC;
using Bal      = comp::OptoMemoryBallistics;
using Opto     = XlethOptoCompressorEffect;

namespace
{

constexpr double kPi = 3.14159265358979323846;
constexpr float  kPR = 20.0f;     // Peak Reduction used by the core-level tests
constexpr float  kT  = -kPR;      // …as the core's "threshold" input

Settings makeSettings(bool limit, Bal::Params bal = {})
{
    Settings s;
    s.gc.inputMix = limit ? GC::kLimitMix : 0.0f;
    s.bal = bal;
    s.topology = comp::Topology::TrackedFeedback;
    return s;
}

// Runs a mono/stereo signal through a prepared core one sample at a time,
// constant drive and gain, recording per-sample GR. Processed in place.
void runCore(Core& core, std::vector<float>& L, std::vector<float>* R,
             float T, float gainDb, std::vector<float>* grOut = nullptr)
{
    const float thr[1] = { T }, mk[1] = { gainDb };
    const int n = static_cast<int>(L.size());
    if (grOut) grOut->assign(static_cast<size_t>(n), 0.0f);
    for (int s = 0; s < n; ++s)
    {
        float* l = L.data() + s;
        float* r = R ? R->data() + s : l;
        core.process(l, r, 1, thr, mk, 1);
        if (grOut) (*grOut)[static_cast<size_t>(s)] = core.getGainReductionDb();
    }
}

// Square wave: |x| constant, so the sidechain sees a steady level.
std::vector<float> square(int n, float amp, int periodSamples = 48)
{
    std::vector<float> v(static_cast<size_t>(n));
    for (int i = 0; i < n; ++i)
        v[static_cast<size_t>(i)] = ((i / (periodSamples / 2)) % 2 == 0) ? amp : -amp;
    return v;
}

std::vector<float> zeros(int n) { return std::vector<float>(static_cast<size_t>(n), 0.0f); }

void append(std::vector<float>& a, const std::vector<float>& b) { a.insert(a.end(), b.begin(), b.end()); }

float dbToAmp(float db) { return std::pow(10.0f, db / 20.0f); }
float ampToDb(float a)  { return 20.0f * std::log10(std::max(a, 1.0e-12f)); }

int firstCrossing(const std::vector<float>& v, int from, float level, bool rising)
{
    for (int i = from; i < static_cast<int>(v.size()); ++i)
        if (rising ? v[static_cast<size_t>(i)] >= level : v[static_cast<size_t>(i)] <= level)
            return i;
    return -1;
}

void processEffect(Opto& fx, juce::AudioBuffer<float>& buf, int block)
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

// Amplitude of the component at `hz` over [from, from+n) — exact for an
// integer number of cycles in the window (rectangular window, no leakage).
double toneAmp(const float* x, int n, double hz, double fs)
{
    double re = 0.0, im = 0.0;
    for (int i = 0; i < n; ++i)
    {
        const double ph = 2.0 * kPi * hz * i / fs;
        re += x[i] * std::cos(ph);
        im += x[i] * std::sin(ph);
    }
    return 2.0 * std::sqrt(re * re + im * im) / n;
}

// Settled static-curve point: steady square at `lvl`, return output level (dB).
float settledOutDb(float lvl, bool limit, float T, double fs = 12000.0, double secs = 4.0)
{
    Core core;
    core.setColorEnabled(false);
    core.prepare(fs, makeSettings(limit));
    auto x = square(static_cast<int>(fs * secs), dbToAmp(lvl), 12);
    runCore(core, x, nullptr, T, 0.0f);
    return ampToDb(std::abs(x.back()));
}

} // namespace

// ─── [1] Model pieces ────────────────────────────────────────────────────────

static void testModelPieces()
{
    std::cout << "\n[1] model pieces: sidechain law, ballistics derivative, divider\n";

    // Compress: the loop form is the plain feedback form of the reduced level.
    float worstFb = 0.0f, worstSlope = 0.0f;
    for (float L = -40.0f; L <= 10.0f; L += 0.5f)
        for (float B = 0.0f; B <= 40.0f; B += 0.5f)
        {
            float s1, s2;
            const GC::Params comp {};
            const float a = GC::reductionLoop(L, B, kT, comp, s1);
            const float b = GC::reductionFB(L - B, kT, comp, s2);
            worstFb = std::max(worstFb, std::abs(a - b) / (1.0f + b));

            // Limit: slopeB = −∂c/∂B, against a central difference.
            const GC::Params lim { GC::kLimitMix };
            float s, sp, sm;
            const float c0 = GC::reductionLoop(L, B, kT, lim, s);
            const float h = 1.0e-3f;
            const float cp = GC::reductionLoop(L, B + h, kT, lim, sp);
            const float cm = GC::reductionLoop(L, B - h, kT, lim, sm);
            if (c0 > 1.0e-3f && cm > 0.0f)
                worstSlope = std::max(worstSlope, std::abs(s - (cm - cp) / (2.0f * h)) / (1.0f + s));
            // More input in the sidechain = more light for the same output.
            float sc;
            CHECK(!(c0 + 1e-4f < GC::reductionLoop(L, B, kT, comp, sc)), "Limit never asks for less light than Compress");
        }
    std::printf("    Compress loop form vs FB form: worst rel. diff %.2e; Limit slopeB vs finite difference: worst rel. err %.2e\n",
                worstFb, worstSlope);
    CHECK(worstFb < 1e-6f, "Compress sidechain is the output (pure feedback)");
    CHECK(worstSlope < 5e-3f, "Limit sidechain's loop slope is the exact derivative");

    // Ballistics: predict() monotone in ρ, derivative exact, from assorted states.
    // At a LOW rate: per-sample steps b are large there, so dGR/dρ is well above
    // float resolution of a GR difference (at 48 kHz it is ~1e-6 dB per unit of
    // light — the finite difference would be pure rounding). The formula is the
    // same at every rate.
    const auto c = Bal::makeCoeffs(Bal::Params{}, 400.0);
    std::mt19937 rng(7);
    std::uniform_real_distribution<float> U(0.0f, 30.0f);
    int nonMono = 0;
    float worstD = 0.0f;
    for (int k = 0; k < 400; ++k)
    {
        Bal::State st { U(rng), U(rng) * 0.3f, U(rng) * 0.1f, U(rng) * 0.2f };
        float prev = -1.0f;
        for (float rho = 0.0f; rho <= 60.0f; rho += 0.37f)
        {
            float d, dp, dm;
            const float v = Bal::predict(st, c, rho, d);
            if (v < prev - 1e-6f) ++nonMono;
            prev = v;
            const float h = 5e-2f;
            const float vp = Bal::predict(st, c, rho + h, dp);
            const float vm = Bal::predict(st, c, std::max(0.0f, rho - h), dm);
            const float fd = (vp - vm) / (rho + h - std::max(0.0f, rho - h));
            // Skip the branch kinks (attack/release switch), where one-sided slopes differ.
            if (std::abs(dp - dm) < 1e-3f * (std::abs(d) + 1e-9f) + 1e-9f)
                worstD = std::max(worstD, std::abs(fd - d) / (std::abs(d) + 1e-7f));
        }
    }
    std::printf("    ballistics: non-monotone steps %d; worst rel. derivative error %.2e\n", nonMono, worstD);
    CHECK(nonMono == 0, "predict() is nondecreasing in the light target");
    CHECK(worstD < 2e-2f, "predict()'s derivative matches a finite difference");

    CHECK(std::abs(comp::CdsDivider::grDb(comp::T4Cell::kDarkG)) < 1e-6f, "the dark cell reads 0 dB of reduction");
    CHECK(std::abs(comp::CdsDivider::grDb(comp::T4Cell::kDarkG + 9.0f) - 19.99f) < 0.05f,
          "G = 9·G_series (+dark) is ~20 dB: gain = 1/(1+G)");
}

// ─── [2] Static curve ────────────────────────────────────────────────────────

static void testStaticCurve()
{
    std::cout << "\n[2] static curve sweep (Peak Reduction " << kPR << " dB)\n";

    // (a) The loop settles on the model's equilibrium, both modes.
    for (bool limit : { false, true })
    {
        float worst = 0.0f;
        for (float lvl = -40.0f; lvl <= 10.0f; lvl += 2.0f)
        {
            const float out  = settledOutDb(lvl, limit, kT);
            const float want = GC::outputDb(lvl, kT, makeSettings(limit).gc);
            worst = std::max(worst, std::abs(out - want));
        }
        std::printf("    %-8s settled loop vs equilibrium: worst %.4f dB\n", limit ? "Limit" : "Compress", worst);
        CHECK(worst < 0.05f, (limit ? "Limit" : "Compress") << " loop settles on the model's static curve (worst " << worst << " dB)");
    }

    // (b) Shape of the curve, from the equilibrium on a fine grid.
    auto curve = [](bool limit, float T, float lo, float hi, float step) {
        std::vector<std::pair<float, float>> v;
        for (float x = lo; x <= hi + 1e-3f; x += step)
            v.emplace_back(x, GC::outputDb(x, T, makeSettings(limit).gc));
        return v;
    };
    auto avgRatio = [](const std::vector<std::pair<float, float>>& c, float grLo, float grHi) {
        float x0 = 0, y0 = 0, x1 = 0, y1 = 0; bool have = false;
        for (auto [x, y] : c)
        {
            const float gr = x - y;
            if (gr < grLo || gr > grHi) continue;
            if (!have) { x0 = x; y0 = y; have = true; }
            x1 = x; y1 = y;
        }
        return (x1 - x0) / std::max(1e-6f, y1 - y0);
    };

    const float step = 0.25f;
    const auto cc = curve(false, kT, -40.0f, 10.0f, step);
    const auto cl = curve(true,  kT, -40.0f, 10.0f, step);

    std::cout << "    in dBFS | Compress out  GR   local ratio | Limit out  GR   local ratio\n";
    for (size_t i = 1; i < cc.size(); ++i)
    {
        const float x = cc[i].first;
        if (std::fmod(x + 40.0f, 4.0f) != 0.0f) continue;
        const float rc = step / std::max(1e-6f, cc[i].second - cc[i - 1].second);
        const float rl = step / std::max(1e-6f, cl[i].second - cl[i - 1].second);
        std::printf("    %6.1f  | %7.2f %6.2f %8.2f      | %7.2f %6.2f %8.2f\n",
                    x, cc[i].second, x - cc[i].second, rc, cl[i].second, x - cl[i].second, rl);
    }

    // No reduction below the EL onset; unity there.
    CHECK(std::abs(cc.front().first - cc.front().second) < 1e-4f, "no reduction well below the onset");

    // Soft knee: the slope dOut/dIn leaves 1 continuously — no corner — and
    // takes several dB of input to settle.
    float maxSlopeJump = 0.0f, kneeStart = 1e9f, kneeEnd = 1e9f;
    std::vector<float> slopes;
    for (size_t i = 1; i < cc.size(); ++i) slopes.push_back((cc[i].second - cc[i - 1].second) / step);
    for (size_t i = 1; i < slopes.size(); ++i) maxSlopeJump = std::max(maxSlopeJump, std::abs(slopes[i] - slopes[i - 1]));
    for (size_t i = 0; i < slopes.size(); ++i)
    {
        if (kneeStart > 1e8f && slopes[i] < 0.95f) kneeStart = cc[i].first;
        if (kneeEnd > 1e8f && slopes[i] < 0.45f) kneeEnd = cc[i].first;
    }
    std::printf("    Compress knee: slope 0.95 at %.2f dBFS -> 0.45 at %.2f dBFS (%.2f dB wide); largest slope step per %.2f dB: %.3f\n",
                kneeStart, kneeEnd, kneeEnd - kneeStart, step, maxSlopeJump);
    CHECK(maxSlopeJump < 0.08f, "soft knee: the curve's slope has no corner");
    CHECK(kneeEnd - kneeStart >= 3.0f, "soft knee: the transition spans several dB of input");

    const float rC  = avgRatio(cc, 3.0f, 15.0f);
    const float rL  = avgRatio(cl, 3.0f, 15.0f);
    const float rC1 = avgRatio(cc, 3.0f, 8.0f), rC2 = avgRatio(cc, 12.0f, 20.0f);
    std::printf("    average ratio over 3-15 dB GR: Compress %.2f:1, Limit %.2f:1; Compress 3-8 dB %.2f:1 vs 12-20 dB %.2f:1\n",
                rC, rL, rC1, rC2);
    CHECK(rC > 2.5f && rC < 3.6f, "Compress averages ~3:1 (" << rC << ")");
    CHECK(rL > 1.5f * rC, "Limit compresses harder than Compress (" << rL << " vs " << rC << ")");
    (void) rC1; (void) rC2;

    // No single ratio describes it: local ratio across 1–20 dB of reduction.
    auto localRatioAt = [&](const std::vector<std::pair<float, float>>& c, float gr) {
        for (size_t i = 1; i < c.size(); ++i)
            if (c[i].first - c[i].second >= gr)
                return step / std::max(1e-6f, c[i].second - c[i - 1].second);
        return 0.0f;
    };
    float rMin = 1e9f, rMax = 0.0f;
    for (float g = 1.0f; g <= 18.0f; g += 0.5f)
    {
        const float r = localRatioAt(cc, g);
        rMin = std::min(rMin, r);
        rMax = std::max(rMax, r);
    }
    const float rl4 = localRatioAt(cl, 4.0f), rl18 = localRatioAt(cl, 18.0f);
    std::printf("    local ratio over 1-18 dB GR: Compress %.2f..%.2f; Limit %.2f at 4 dB -> %.2f at 18 dB\n",
                rMin, rMax, rl4, rl18);
    CHECK(rMax - rMin > 0.5f, "Compress: the ratio drifts through and past the knee (not a constant)");
    CHECK(rl18 > 1.5f * rl4, "Limit: the ratio climbs with depth as the input tap takes over");

    // Monotone everywhere the controls reach: Peak Reduction 0..40, input to +10 dBFS.
    for (bool limit : { false, true })
        for (float pr : { 0.0f, 20.0f, 40.0f })
        {
            const auto c = curve(limit, -pr, -60.0f, 10.0f, 0.5f);
            float minSlope = 1.0f;
            for (size_t i = 1; i < c.size(); ++i) minSlope = std::min(minSlope, (c[i].second - c[i - 1].second) / 0.5f);
            CHECK(minSlope > 0.0f, (limit ? "Limit" : "Compress") << " PR " << pr
                  << ": output rises with input everywhere (min slope " << minSlope << ")");
        }

    // (c) Program dependence. Same PEAK level, same settings:
    constexpr double fs = 48000.0;
    auto settleGr = [&](bool squareWave, float lvl, double secs) {
        Core core;
        core.setColorEnabled(false);
        core.prepare(fs, makeSettings(false));
        const int n = static_cast<int>(fs * secs);
        std::vector<float> x(static_cast<size_t>(n));
        const float a = dbToAmp(lvl);
        for (int i = 0; i < n; ++i)
            x[static_cast<size_t>(i)] = squareWave ? ((i / 24) % 2 ? -a : a)
                                                   : a * static_cast<float>(std::sin(2.0 * kPi * 1000.0 * i / fs));
        std::vector<float> gr;
        runCore(core, x, nullptr, kT, 0.0f, &gr);
        return gr.back();
    };
    const float grSq = settleGr(true, -6.0f, 3.0), grSine = settleGr(false, -6.0f, 3.0);
    const float grShort = settleGr(true, -6.0f, 0.1);
    std::printf("    program dependence @ -6 dBFS peak: square %.2f dB, sine %.2f dB GR (crest factor); "
                "100 ms burst %.2f dB vs held %.2f dB (slow cell still charging)\n", grSq, grSine, grShort, grSq);
    CHECK(grSq - grSine > 0.5f, "a denser signal at the same peak is compressed harder");
    CHECK(grSq - grShort > 0.3f, "a short burst sees less reduction than the same level held");

    // (d) Gain is outside the loop: GR does not depend on it.
    {
        Core a, b;
        a.setColorEnabled(false); b.setColorEnabled(false);
        a.prepare(fs, makeSettings(false)); b.prepare(fs, makeSettings(false));
        auto xa = square(static_cast<int>(fs * 1.0), dbToAmp(-6.0f));
        auto xb = xa;
        std::vector<float> ga, gb;
        runCore(a, xa, nullptr, kT, 0.0f, &ga);
        runCore(b, xb, nullptr, kT, 30.0f, &gb);
        float worst = 0.0f;
        for (size_t i = 0; i < ga.size(); ++i) worst = std::max(worst, std::abs(ga[i] - gb[i]));
        std::printf("    Gain 0 vs +30 dB: worst GR difference %.2e dB; output level difference %.2f dB\n",
                    worst, ampToDb(std::abs(xb.back())) - ampToDb(std::abs(xa.back())));
        CHECK(worst == 0.0f, "Gain never changes the amount of reduction (makeup after the loop)");
        CHECK(std::abs(ampToDb(std::abs(xb.back())) - ampToDb(std::abs(xa.back())) - 30.0f) < 0.01f, "Gain is +30 dB of makeup");
    }
}

// ─── [3] §3.4 fitting procedure: release memory ──────────────────────────────

struct Tail { float grEnd; float msTo50; float sTo10; float sTo1dB; };

static Tail burstTail(const Bal::Params& bal, double burstSeconds, double fs = 48000.0,
                      std::vector<float>* grTrace = nullptr)
{
    Core core;
    core.setColorEnabled(false);
    core.prepare(fs, makeSettings(false, bal));
    std::vector<float> x = zeros(static_cast<int>(fs * 0.2));
    append(x, square(static_cast<int>(fs * burstSeconds), dbToAmp(-6.0f)));
    const int end = static_cast<int>(x.size());
    append(x, zeros(static_cast<int>(fs * 30.0)));
    std::vector<float> gr;
    runCore(core, x, nullptr, kT, 0.0f, &gr);
    Tail t;
    t.grEnd = gr[static_cast<size_t>(end - 1)];
    auto after = [&](float lvl) {
        const int c = firstCrossing(gr, end, lvl, false);
        return c < 0 ? 1e9 : (c - end) / fs;
    };
    t.msTo50 = static_cast<float>(after(0.5f * t.grEnd) * 1000.0);
    t.sTo10  = static_cast<float>(after(0.1f * t.grEnd));
    t.sTo1dB = static_cast<float>(after(1.0f));
    if (grTrace) *grTrace = std::move(gr);
    return t;
}

// The §3.4 criterion: every longer burst leaves a clearly longer tail.
static bool tailsLengthen(const Tail t[3], float factor)
{
    return t[1].sTo1dB > factor * t[0].sTo1dB && t[2].sTo1dB > factor * t[1].sTo1dB
        && t[1].sTo10  > factor * t[0].sTo10  && t[2].sTo10  > factor * t[1].sTo10;
}

static void testReleaseMemory()
{
    std::cout << "\n[3] opto memory: 100 ms / 1 s / 10 s bursts at -6 dBFS, PR " << kPR << " dB\n";
    const double bursts[3] = { 0.1, 1.0, 10.0 };

    auto runSet = [&](const char* name, const Bal::Params& p, Tail out[3]) {
        for (int i = 0; i < 3; ++i)
        {
            out[i] = burstTail(p, bursts[i]);
            std::printf("    %-22s %5.1f s burst: GR at end %5.2f dB | 50%% in %6.1f ms | 10%% in %6.2f s | to 1 dB in %6.2f s\n",
                        name, bursts[i], out[i].grEnd, out[i].msTo50, out[i].sTo10, out[i].sTo1dB);
        }
    };

    Tail opto[3];
    runSet("opto (fitted cell)", Bal::Params{}, opto);
    CHECK(tailsLengthen(opto, 1.5f), "release tails lengthen with burst length (each step > 1.5x)");
    CHECK(opto[2].sTo1dB > 5.0f * opto[0].sTo1dB, "10 s burst tail > 5x the 100 ms burst tail");
    for (int i = 0; i < 3; ++i)
        CHECK(opto[i].msTo50 > 30.0f && opto[i].msTo50 < 150.0f,
              "first 50% of the release is fast (" << opto[i].msTo50 << " ms, UA ~60 ms)");
    CHECK(opto[2].sTo1dB > 3.0f && opto[2].sTo1dB < 15.0f, "the long tail lands in UA's 1-15 s (" << opto[2].sTo1dB << " s)");
    CHECK(std::abs(opto[2].grEnd - opto[1].grEnd) < 1.0f, "bursts end at (nearly) the same reduction — the tails differ by memory, not depth");

    // Negative control 1: the fast/slow structure collapsed into ONE τ.
    Bal::Params single;
    single.fastShare = 1.0f;          // no slow part, no memory
    single.fastReleaseMs = 1000.0f;   // one mid-range release τ
    Tail one[3];
    runSet("single-tau cell (1 s)", single, one);
    CHECK(!tailsLengthen(one, 1.5f), "NEGATIVE CONTROL: a single-tau cell fails the burst test");
    CHECK(std::abs(one[2].sTo1dB - one[0].sTo1dB) < 0.1f * one[0].sTo1dB,
          "NEGATIVE CONTROL: single-tau tails are identical after every burst");

    // Negative control 2: keep the two speeds, remove the light history h.
    Bal::Params noHist;
    noHist.slowReleaseMaxS = noHist.slowReleaseMinS;
    Tail nh[3];
    runSet("two-speed, no history", noHist, nh);
    CHECK(!tailsLengthen(nh, 1.5f), "NEGATIVE CONTROL: without h the 1 s and 10 s tails are the same");
    CHECK(opto[2].sTo1dB > 2.0f * nh[2].sTo1dB, "the light history is what stretches the long tail");
}

// ─── [4] Ballistics vs the published figures ─────────────────────────────────

static void testBallistics()
{
    std::cout << "\n[4] attack / release vs UA's figures; rate invariance\n";
    constexpr double fs = 48000.0;

    // Attack: step from silence to a steady level, 63 % of the 150 ms plateau.
    float prevMs = 1e9f;
    bool faster = true;
    for (float lvl : { -14.0f, -8.0f, 0.0f })
    {
        Core core;
        core.setColorEnabled(false);
        core.prepare(fs, makeSettings(false));
        std::vector<float> x = zeros(4800);
        append(x, square(static_cast<int>(fs * 0.3), dbToAmp(lvl)));
        std::vector<float> gr;
        runCore(core, x, nullptr, kT, 0.0f, &gr);
        const float plateau = gr[static_cast<size_t>(4800 + fs * 0.15)];
        const int n63 = firstCrossing(gr, 4800, 0.632f * plateau, true) - 4800 + 1;
        const float ms = static_cast<float>(n63 * 1000.0 / fs);
        std::printf("    attack to %5.1f dBFS: plateau GR %5.2f dB, 63%% in %5.2f ms\n", lvl, plateau, ms);
        CHECK(ms > 2.0f && ms < 20.0f, "attack is the panel's, in the ~10 ms class (" << ms << " ms)");
        faster = faster && ms < prevMs;
        prevMs = ms;
    }
    CHECK(faster, "program-dependent attack: bigger transients are caught faster");

    // τ_slow spans exactly the fitted 0.5–15 s as the history fills.
    const auto c = Bal::makeCoeffs(Bal::Params{}, fs);
    const float tMin = Bal::slowReleaseSamples(0.0f, c) / static_cast<float>(fs);
    const float tMax = Bal::slowReleaseSamples(1e9f, c) / static_cast<float>(fs);
    std::printf("    tau_slow: %.2f s (no history) .. %.2f s (full history)\n", tMin, tMax);
    CHECK(std::abs(tMin - 0.5f) < 1e-3f && std::abs(tMax - 15.0f) < 1e-3f, "tau_slow maps into 0.5-15 s");
    const float bSeries = Bal::slowReleaseStep(2.0f, c);
    const float bExact  = static_cast<float>(-std::expm1(-1.0 / Bal::slowReleaseSamples(2.0f, c)));
    CHECK(std::abs(bSeries - bExact) <= 1e-6f * bExact, "series slow-release step equals -expm1(-1/n)");

    // Rate invariance: the same program at 48 kHz and at 96 kHz gives the same
    // tails in SECONDS — every coefficient is computed at the rate it runs at.
    auto tail = [&](double rate) { return burstTail(Bal::Params{}, 1.0, rate); };
    const Tail a = tail(48000.0), b = tail(96000.0);
    std::printf("    1 s burst @48k: 50%% %.1f ms, 1 dB %.3f s | @96k: 50%% %.1f ms, 1 dB %.3f s\n",
                a.msTo50, a.sTo1dB, b.msTo50, b.sTo1dB);
    CHECK(std::abs(a.sTo1dB - b.sTo1dB) < 0.01f * a.sTo1dB && std::abs(a.msTo50 - b.msTo50) < 0.02f * a.msTo50,
          "time constants are rate-invariant");

    Opto fx;
    fx.prepareToPlay(fs, 512);
    CHECK(fx.getCore().getProcessRate() == 2.0 * fs, "the effect's core runs at the 2x oversampled rate");
}

// ─── [5] Stereo link ─────────────────────────────────────────────────────────

static void testStereoLink()
{
    std::cout << "\n[5] stereo link: identical gain on both channels\n";
    constexpr double fs = 48000.0;
    for (bool limit : { false, true })
    {
        Core core;
        core.setColorEnabled(false);
        core.prepare(fs, makeSettings(limit));
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
        std::printf("    %-8s left-driven GR applied to right: worst relative gain mismatch %.2e over %d samples\n",
                    limit ? "Limit" : "Compress", worst, compared);
        CHECK(compared > 1000 && worst < 1e-5, "linked gain is identical per sample");
    }

    auto runSide = [&](int loudCh, juce::AudioBuffer<float>& out) -> float {
        Opto fx;
        fx.prepareToPlay(fs, 512);
        fx.setParameterValue("peak_reduction", 30.0f);
        fx.prepareToPlay(fs, 512);
        const int n = static_cast<int>(fs * 0.3);
        out.setSize(2, n);
        for (int i = 0; i < n; ++i)
        {
            out.setSample(loudCh, i, 0.8f * static_cast<float>(std::sin(2.0 * kPi * 220.0 * i / fs)));
            out.setSample(1 - loudCh, i, 0.01f * static_cast<float>(std::sin(2.0 * kPi * 3000.0 * i / fs)));
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
    CHECK(grA > 6.0f, "the loud channel drives real gain reduction");
    CHECK(grA == grB, "same gain reduction whichever channel drives it");
    CHECK(mirrored, "effect output is exactly L/R mirror-symmetric");
}

// ─── [6] Limit/Compress switch ───────────────────────────────────────────────
//
// Unlike the Glue's ratio buttons, the switch does not move GR directly — it
// changes the light the panel is asked for, and the panel and cell lag that by
// milliseconds, so even a HARD switch cannot step the gain. The core still
// runs its two-lane crossfade (both lanes start from the same cell state, so
// the fade is continuous by construction); this checks that the switch is
// material, lands on the new mode's curve, and never steps the gain.

static void testModeSwitch()
{
    std::cout << "\n[6] Limit/Compress switch: material, smooth, lands on the new curve\n";
    constexpr double fs = 48000.0;
    const float lvl = 0.0f;
    for (bool toLimit : { true, false })
        for (double fadeS : { 1.0 / fs, 0.030 })
        {
            Core::Config cfg;
            cfg.crossfadeSeconds = fadeS;
            Core core(cfg);
            core.setColorEnabled(false);
            core.prepare(fs, makeSettings(!toLimit));
            auto x = square(static_cast<int>(fs * 3.0), dbToAmp(lvl));
            runCore(core, x, nullptr, kT, 0.0f);
            const float before = core.getGainReductionDb();
            core.setSettings(makeSettings(toLimit));
            // Down (Limit -> Compress) is a RELEASE of the slow cell, which
            // carries the memory of Limit's extra light for many seconds.
            auto y = square(static_cast<int>(fs * (toLimit ? 3.0 : 40.0)), dbToAmp(lvl));
            std::vector<float> gr;
            runCore(core, y, nullptr, kT, 0.0f, &gr);
            float worst = std::abs(gr[0] - before);
            for (size_t i = 1; i < gr.size(); ++i) worst = std::max(worst, std::abs(gr[i] - gr[i - 1]));
            const float want = lvl - GC::outputDb(lvl, kT, makeSettings(toLimit).gc);
            std::printf("    %-18s %-10s GR %5.2f -> %5.2f dB (new curve %5.2f), max |dGR| %.4f dB/sample\n",
                        toLimit ? "Compress -> Limit" : "Limit -> Compress", fadeS > 0.01 ? "30 ms fade" : "hard",
                        before, gr.back(), want, worst);
            CHECK(std::abs(gr.back() - before) > 1.5f, "the switch is material (> 1.5 dB of GR at 0 dBFS, PR 20)");
            CHECK(std::abs(gr.back() - want) < 0.05f, "and settles on the new mode's static curve");
            CHECK(worst < 0.02f, "the gain never steps (< 0.02 dB per sample)");
            CHECK(core.getActiveSettings() == makeSettings(toLimit) && !core.isCrossfading(), "the fade completes onto the new lane");
        }

    // Effect level: the "mode" parameter really reaches the core as a stepped change.
    Opto fx;
    fx.prepareToPlay(fs, 512);
    fx.setParameterValue("mode", 1.0f);
    CHECK(fx.currentSettings().gc.inputMix == GC::kLimitMix, "mode 1 = Limit (input mixed into the sidechain)");
    fx.setParameterValue("mode", 0.0f);
    CHECK(fx.currentSettings().gc.inputMix == 0.0f, "mode 0 = Compress");
}

// ─── [7] Colour and oversampling ─────────────────────────────────────────────

static void testColourAndAliasing()
{
    std::cout << "\n[7] tube/transformer colour: harmonics, and 2x oversampling vs aliasing\n";
    constexpr double fs = 48000.0;

    // THD of the colour stage alone (core with no reduction: PR 0, low level).
    for (float lvl : { -20.0f, -6.0f, 0.0f })
    {
        Core core;
        core.setColorEnabled(true);
        core.prepare(fs * 2.0, makeSettings(false));
        const int n = static_cast<int>(fs * 2.0 * 1.5);
        std::vector<float> x(static_cast<size_t>(n));
        const float a = dbToAmp(lvl);
        for (int i = 0; i < n; ++i) x[static_cast<size_t>(i)] = a * static_cast<float>(std::sin(2.0 * kPi * 500.0 * i / (fs * 2.0)));
        runCore(core, x, nullptr, 0.0f, 0.0f);   // PR 0: drive < onset, no reduction
        const int w = static_cast<int>(fs * 2.0);
        const float* seg = x.data() + (n - w);
        const double h1 = toneAmp(seg, w, 500.0, fs * 2.0), h2 = toneAmp(seg, w, 1000.0, fs * 2.0),
                     h3 = toneAmp(seg, w, 1500.0, fs * 2.0);
        std::printf("    %5.1f dBFS sine: H2 %6.1f dBc, H3 %6.1f dBc (THD2+3 %.3f %%)\n",
                    lvl, ampToDb(float(h2 / h1)), ampToDb(float(h3 / h1)), 100.0 * std::sqrt(h2 * h2 + h3 * h3) / h1);
        CHECK(h2 > h3, "the tube stage leads with the 2nd harmonic at " << lvl << " dBFS");
        if (lvl == -20.0f) CHECK(std::sqrt(h2 * h2 + h3 * h3) / h1 < 0.01, "clean at -20 dBFS (< 1 % THD)");
        if (lvl == 0.0f)   CHECK(std::sqrt(h2 * h2 + h3 * h3) / h1 > 0.003, "audible colour at 0 dBFS (> 0.3 % THD)");
    }

    // Aliasing: a hot 7 kHz tone through the tube stage (Gain +12 dB). Its
    // 4th..6th harmonics (28/35/42 kHz) fold to 20/13/6 kHz at 1x — inharmonic.
    const double f0 = 7000.0;
    const double aliases[3] = { 20000.0, 13000.0, 6000.0 };
    auto aliasDb = [&](const std::vector<float>& y, int from) {
        const int w = static_cast<int>(fs);   // 1 s: every frequency here is an integer bin
        const float* seg = y.data() + from;
        const double fund = toneAmp(seg, w, f0, fs);
        double sum = 0.0;
        for (double f : aliases) { const double a = toneAmp(seg, w, f, fs); sum += a * a; }
        return ampToDb(float(std::sqrt(sum) / fund));
    };
    const int n = static_cast<int>(fs * 1.5);

    // 2x: the whole effect.
    Opto fx;
    fx.prepareToPlay(fs, 512);
    fx.setParameterValue("peak_reduction", 0.0f);
    fx.setParameterValue("gain", 12.0f);
    fx.prepareToPlay(fs, 512);
    juce::AudioBuffer<float> b(2, n);
    for (int i = 0; i < n; ++i)
    {
        const float v = 0.5f * static_cast<float>(std::sin(2.0 * kPi * f0 * i / fs));
        b.setSample(0, i, v);
        b.setSample(1, i, v);
    }
    processEffect(fx, b, 512);
    std::vector<float> os(b.getReadPointer(0), b.getReadPointer(0) + n);

    // 1x: the same core run straight at 48 kHz (negative control).
    Core raw;
    raw.setColorEnabled(true);
    raw.prepare(fs, makeSettings(false));
    std::vector<float> x1(static_cast<size_t>(n));
    for (int i = 0; i < n; ++i) x1[static_cast<size_t>(i)] = 0.5f * static_cast<float>(std::sin(2.0 * kPi * f0 * i / fs));
    runCore(raw, x1, nullptr, 0.0f, 12.0f);

    const float aOs = aliasDb(os, n - static_cast<int>(fs)), a1x = aliasDb(x1, n - static_cast<int>(fs));
    std::printf("    7 kHz @ -6 dBFS + 12 dB gain, folded 4th-6th harmonics: 2x OS %.1f dBc, 1x (control) %.1f dBc\n", aOs, a1x);
    CHECK(a1x > -80.0f, "NEGATIVE CONTROL: the waveshaper really aliases at 1x");
    CHECK(aOs < a1x - 20.0f, "2x oversampling suppresses the aliases by > 20 dB");
    CHECK(aOs < -80.0f, "no audible aliasing with 2x oversampling");
}

// ─── [8] Realtime safety ─────────────────────────────────────────────────────

static void testRealtimeSafety()
{
    std::cout << "\n[8] realtime safety: allocations, denormals, loop stability\n";
    constexpr double fs = 48000.0;
    constexpr int block = 512;

    {
        Opto fx;
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
            fx.setParameterValue("mode", static_cast<float>((k / 3) % 2));
            fx.setParameterValue("peak_reduction", static_cast<float>(k % 41));
            fx.setParameterValue("gain", static_cast<float>((k * 7) % 41));
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
        fx.reset();
        g_allocArmed.store(false);
        CHECK(g_allocCount.load() == 0, "reset() is a pure state clear (no allocation)");
    }

    {
        // Loud, then a long silence: nothing subnormal, and silence is not slow.
        Opto fx;
        fx.prepareToPlay(fs, block);
        fx.setParameterValue("peak_reduction", 40.0f);   // heavy light → longest memory
        juce::AudioBuffer<float> b(2, block);
        juce::MidiBuffer midi;
        using clk = std::chrono::steady_clock;
        double loudUs = 0.0, silentUs = 0.0;
        int subnormals = 0, nonFinite = 0;
        const int loudBlocks = static_cast<int>(fs * 3.0 / block);
        const int quietBlocks = static_cast<int>(fs * 30.0 / block);
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
        std::printf("    loud %.1f us/block (%.2f %% of a %d-sample block's %.0f us), late silence %.1f us/block, "
                    "subnormal outputs %d, GR state %.3g\n",
                    loudPer, 100.0 * loudPer / (block * 1e6 / fs), block, block * 1e6 / fs, silentPer, subnormals, gr);
        CHECK(nonFinite == 0, "all outputs finite");
        CHECK(subnormals == 0, "no subnormal output samples in silence after a loud signal");
        CHECK(gr == 0.0f || std::fpclassify(gr) != FP_SUBNORMAL, "GR state never subnormal");
        CHECK(silentPer < 3.0 * loudPer + 20.0, "silence after a loud signal is not slower (denormal stall)");
    }

    {
        // Extreme settings at 44.1 kHz with NO oversampling: PR 40, Limit, a
        // +10 dBFS 50 Hz square. The implicit loop must settle without ringing.
        constexpr double fs44 = 44100.0;
        Core core;
        core.setColorEnabled(false);
        core.prepare(fs44, makeSettings(true));
        auto x = square(static_cast<int>(fs44 * 3.0), dbToAmp(10.0f), 882);
        std::vector<float> gr;
        runCore(core, x, nullptr, -40.0f, 0.0f, &gr);
        float lateSlew = 0.0f;
        int alternations = 0;
        const size_t from = gr.size() * 2 / 3;
        for (size_t i = from + 2; i < gr.size(); ++i)
        {
            lateSlew = std::max(lateSlew, std::abs(gr[i] - gr[i - 1]));
            if ((gr[i] - gr[i - 1]) * (gr[i - 1] - gr[i - 2]) < -1e-10f) ++alternations;
        }
        bool bounded = true;
        for (float v : x) bounded = bounded && std::isfinite(v) && std::abs(v) < 4.0f;
        const float want = 10.0f - GC::outputDb(10.0f, -40.0f, makeSettings(true).gc);
        std::printf("    PR 40 / Limit / +10 dBFS / 44.1 kHz no OS: late |dGR| %.2e dB, sign flips %d, GR %.2f dB (equilibrium %.2f)\n",
                    lateSlew, alternations, gr.back(), want);
        CHECK(bounded, "output bounded at extreme settings");
        CHECK(lateSlew < 1e-3f && alternations == 0, "implicit loop settles without ringing");
        CHECK(std::abs(gr.back() - want) < 0.1f, "and settles on the model's equilibrium");
    }
}

// ─── [9] Latency, bypass, surface ────────────────────────────────────────────

static void testLatencyBypassSurface()
{
    std::cout << "\n[9] latency, latency-aligned bypass, parameter surface, registration\n";
    constexpr double fs = 48000.0;
    Opto fx;
    fx.prepareToPlay(fs, 480);
    fx.setParameterValue("peak_reduction", 0.0f);
    fx.prepareToPlay(fs, 480);
    const int lat = fx.getLatencySamples();
    std::printf("    2x FIR oversampler latency: %d samples, reported to PDC: %d\n", fx.getOversamplingLatencySamples(), lat);
    CHECK(lat > 0 && lat == fx.getOversamplingLatencySamples(), "reported latency is the measured oversampler latency");

    juce::AudioBuffer<float> b(2, 4800);
    b.clear();
    b.setSample(0, 100, 0.25f);
    b.setSample(1, 100, 0.25f);
    processEffect(fx, b, 480);
    int peakAt = 0;
    for (int i = 0; i < b.getNumSamples(); ++i)
        if (std::abs(b.getSample(0, i)) > std::abs(b.getSample(0, peakAt))) peakAt = i;
    std::printf("    impulse at 100 emerges at %d\n", peakAt);
    CHECK(peakAt == 100 + lat, "impulse delayed by exactly the reported latency");

    Opto by;
    by.prepareToPlay(fs, 480);
    by.setParameterValue("peak_reduction", 40.0f);
    by.setParameterValue("gain", 20.0f);
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

    Opto s;
    CHECK(s.getParameters().size() == 3, "3 APVTS parameters: the unit's three controls");
    CHECK(std::abs(s.getParameterValue("peak_reduction") - 20.0f) < 1e-4f, "Peak Reduction defaults to 20 dB");
    CHECK(std::abs(s.getParameterValue("gain")) < 1e-4f, "Gain defaults to 0 dB");
    CHECK(std::abs(s.getParameterValue("mode")) < 1e-6f, "defaults to Compress");
    CHECK(s.currentSettings().gc.inputMix == 0.0f, "Compress = output-only sidechain");

    EffectChainManager chain;
    chain.init(48000.0, 512);
    const int node = chain.addEffect("opto", 0);
    auto* e = node >= 0 ? chain.getEffect(node) : nullptr;
    CHECK(e != nullptr && e->getPluginId() == "opto", "AudioGraph creates \"opto\" as a stock effect");
    if (e) CHECK(e->getLatencySamples() > 0, "live chain instance reports its latency to PDC");
}

int main()
{
    juce::ScopedJuceInitialiser_GUI juceInit;
    std::cout << "test_opto_compressor — Opto Comp on CompressorCore\n";

    testModelPieces();
    testStaticCurve();
    testReleaseMemory();
    testBallistics();
    testStereoLink();
    testModeSwitch();
    testColourAndAliasing();
    testRealtimeSafety();
    testLatencyBypassSurface();

    std::cout << "\n" << g_passed << " passed, " << g_failed << " failed\n";
    if (g_failed == 0) std::cout << "ALL TESTS PASSED\n";
    return g_failed == 0 ? 0 : 1;
}
