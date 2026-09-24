// test_fet_compressor.cpp — FET Comp ("fet") behaviour tests
// Build: cmake --build build --config Release --target test_fet_compressor
// Run:   ctest --test-dir build -C Release -R "^test_fet_compressor$" -V
// Pass:  prints "ALL TESTS PASSED" and exits 0
//
// docs/Compressor_Archetypes_Deep_Dive.md §4.5 and §10, the items that apply to
// a FET limiter. Behavioural only — curves, envelopes, spectra, identities —
// never a waveform null against hardware.
//
//   [1] Model pieces: the §4.3 divider is the exact KCL root and unity when the
//       FET is pinched off; ε(0) = 0 and ε rises; the working-range validity
//       (V_DS vs V_ctl − V_P, quadratic share) printed; ballistics predict()
//       monotone with an exact derivative; the GC's conductance form is the
//       exact inverse of its static curve.
//   [2] §10.1/§10.5 Static curve per ratio preset: the loop settles on each
//       preset's curve, the measured slope is the preset's ratio, and the
//       THRESHOLD MOVES with the ratio (+1 dB per button, UREI); knees harden
//       with ratio; Input drives level into the curve (no threshold control).
//   [3] §10.6 THD vs gain reduction — the ε fit: THD rises with GR through the
//       working range, 2nd harmonic leading, inside UREI's < 0.5 % at 5 dB;
//       NEGATIVE CONTROL ε = 0: no rise. Whole effect inside the spec.
//   [4] §10.2/§10.5 Ballistics at the OVERSAMPLED rate: the RCs' τ from the
//       knobs (1..7, faster clockwise), attack slowing with ratio, release in
//       dB depth-dependent (conductance-domain RC); closed-loop "full attack"
//       against UREI's < 20 µs / 800 µs; NEGATIVE CONTROL at 1×: the 20 µs
//       attack cannot be represented.
//   [5] §10.7 Aliasing: tones swept toward Nyquist under fast, heavy
//       compression — inharmonic content at 4× vs the same core at 1×.
//   [6] All buttons in: its own mode — curve, dirt, lag and pumping distinct
//       from every ratio and from any blend of them.
//   [7] §10.8 Stereo link: left-only drive, identical control on both channels.
//   [8] Stepped controls: ratio buttons crossfade (a hard switch steps the GR —
//       negative control), the All bias network ramps without a click.
//   [9] §10.10 Realtime safety and CPU: zero allocations in processBlock and
//       reset, no subnormals after loud-then-silence, the loop stable at
//       extreme settings with no oversampling; per-block cost printed.
//  [10] Latency / PDC / bypass, and the parameter surface + registration.

#include "audio/EffectChainManager.h"
#include "audio/FetCompressorCore.h"
#include "audio/XlethFetCompressorEffect.h"
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
#include <complex>
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
using Core     = comp::FetCompressorCore;
using Settings = Core::Settings;
using GC       = comp::FetRatioPresetGC;
using Bal      = comp::RcBallistics;
using Div      = comp::FetShuntDivider;
using Fet      = comp::Fet1176;
using FetFx    = XlethFetCompressorEffect;

namespace
{

constexpr double kPi  = 3.14159265358979323846;
constexpr double kFs  = 48000.0;
constexpr double kOs  = 4.0 * kFs;            // the effect's core rate
constexpr float  kT   = Fet::kThresholdDb;
constexpr int    kAll = Fet::kAllButtonsIn;
const char* const kNames[5] = { "4:1", "8:1", "12:1", "20:1", "All" };

float dbToAmp(float db) { return std::pow(10.0f, db / 20.0f); }
float ampToDb(float a)  { return 20.0f * std::log10(std::max(a, 1.0e-12f)); }

struct CoreOpts
{
    int   preset = 0;
    float attack = 3.0f, release = 5.0f;
    bool  colour = false;
    float residual = 1.0f;     // ε scale (0 = the ε = 0 negative control)
    comp::Topology topology = comp::Topology::TrackedFeedback;
};

Settings settingsFor(const CoreOpts& o)
{
    Settings s = comp::fetSettings(o.preset, o.attack, o.release);
    s.topology = o.topology;
    return s;
}

void prepareCore(Core& core, double fs, const CoreOpts& o)
{
    core.setColorEnabled(o.colour);
    core.gainElement().setAllButtonsIn(o.preset == kAll);
    core.gainElement().setResidualScale(o.residual);
    core.prepare(fs, settingsFor(o));
}

// Runs a mono/stereo signal through a prepared core, constant threshold and
// makeup, recording per-sample GR when asked. Processed in place.
void runCore(Core& core, std::vector<float>& L, std::vector<float>* R,
             float makeupDb = 0.0f, std::vector<float>* grOut = nullptr)
{
    const float thr[1] = { kT }, mk[1] = { makeupDb };
    const int n = static_cast<int>(L.size());
    if (grOut)
    {
        grOut->assign(static_cast<size_t>(n), 0.0f);
        for (int s = 0; s < n; ++s)
        {
            float* l = L.data() + s;
            float* r = R ? R->data() + s : l;
            core.process(l, r, 1, thr, mk, 1);
            (*grOut)[static_cast<size_t>(s)] = core.getGainReductionDb();
        }
        return;
    }
    constexpr int B = 256;
    for (int s = 0; s < n; s += B)
    {
        const int len = std::min(B, n - s);
        float* l = L.data() + s;
        float* r = R ? R->data() + s : l;
        core.process(l, r, len, thr, mk, len);
    }
}

std::vector<float> square(int n, float amp, int periodSamples = 48)
{
    std::vector<float> v(static_cast<size_t>(n));
    for (int i = 0; i < n; ++i)
        v[static_cast<size_t>(i)] = ((i / (periodSamples / 2)) % 2 == 0) ? amp : -amp;
    return v;
}

std::vector<float> sine(int n, float amp, double hz, double fs)
{
    std::vector<float> v(static_cast<size_t>(n));
    for (int i = 0; i < n; ++i) v[static_cast<size_t>(i)] = amp * static_cast<float>(std::sin(2.0 * kPi * hz * i / fs));
    return v;
}

std::vector<float> zeros(int n) { return std::vector<float>(static_cast<size_t>(n), 0.0f); }
void append(std::vector<float>& a, const std::vector<float>& b) { a.insert(a.end(), b.begin(), b.end()); }

// Amplitude of the component at `hz` over n samples — exact for an integer
// number of cycles in the window.
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

struct Thd { double thd, h2, h3; };
Thd measureThd(const float* x, int n, double f0, double fs)
{
    const double h1 = toneAmp(x, n, f0, fs);
    double sum = 0.0, h2 = 0.0, h3 = 0.0;
    for (int k = 2; k <= 9 && k * f0 < 0.5 * fs; ++k)
    {
        const double a = toneAmp(x, n, k * f0, fs);
        if (k == 2) h2 = a;
        if (k == 3) h3 = a;
        sum += a * a;
    }
    return { std::sqrt(sum) / h1, h2 / h1, h3 / h1 };
}

float ClassAColorProbe(float x) { return comp::ClassAColor::amp(x); }

// Linear-interpolated first crossing of `level` (fractional sample index).
double crossing(const std::vector<float>& v, int from, float level, bool rising)
{
    for (int i = std::max(from, 1); i < static_cast<int>(v.size()); ++i)
    {
        const float a = v[static_cast<size_t>(i - 1)], b = v[static_cast<size_t>(i)];
        if (rising ? (b >= level && a < level) : (b <= level && a > level))
            return (i - 1) + (level - a) / (b - a);
        if (i == from && (rising ? a >= level : a <= level)) return i - 1;
    }
    return -1.0;
}

void processEffect(FetFx& fx, juce::AudioBuffer<float>& buf, int block)
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

// Settled static-curve point: steady square at `lvl` (in-core dBFS). Fastest
// attack (it settles upward in milliseconds) and slowest release, so the timing
// network's own divider tau_r/(tau_a + tau_r) is 1 - 2e-5: the pure curve.
float settledOutDb(float lvl, const CoreOpts& base, double fs = kFs)
{
    CoreOpts o = base;
    o.attack = 7.0f;
    o.release = 1.0f;
    Core core;
    prepareCore(core, fs, o);
    auto x = square(static_cast<int>(fs * 0.8), dbToAmp(lvl), 48);
    runCore(core, x, nullptr);
    return ampToDb(std::abs(x.back()));
}

} // namespace

// ─── [1] Model pieces ────────────────────────────────────────────────────────

static void testModelPieces()
{
    std::cout << "\n[1] model pieces: divider, residual, validity, ballistics, GC\n";

    // (a) The divider is the exact root of the KCL quadratic, and the FET
    // pinched off (a = 0) is a wire: bit-exact unity.
    double worstKcl = 0.0;
    for (float a : { 0.0f, 0.1f, 1.0f, 3.0f, 10.0f, 30.0f, 100.0f, 300.0f })
        for (float eps : { 0.0f, 0.01f, 0.1f, 0.5f, 0.8f })
            for (float xv = -1.0f; xv <= 1.0f; xv += 0.05f)
            {
                const float s = 1.0f + a;
                const float r = 4.0f * Div::kBetaRs * eps * xv / (s * s);
                if (std::abs(r) > 0.25f) continue;          // the limiter's own region, checked below
                const double v = Div::divide(xv, a, eps);
                const double kcl = (xv - v) - a * v - Div::kBetaRs * eps * v * v;
                worstKcl = std::max(worstKcl, std::abs(kcl) / (std::abs(xv) + 1e-6));
            }
    std::printf("    KCL residual (x − v) − a·v − βR_s·ε·v² over |r| <= 0.25: worst %.2e of |x|\n", worstKcl);
    CHECK(worstKcl < 3e-3, "the closed form is the square-law divider's root (the share limiter moves it < 0.3 %)");

    bool unity = true;
    for (float x = -4.0f; x <= 4.0f; x += 0.013f) unity = unity && Div::divide(x, 0.0f, 0.0f) == x;
    Div el;
    el.prepare(kOs);
    const float a0 = el.gainFor(0.0f);
    for (float x = -4.0f; x <= 4.0f; x += 0.013f) unity = unity && el.apply(x, a0, 0) == x;
    CHECK(unity, "pinched off (a = 0, ε(0) = 0) the element is bit-exact unity");

    // Small-signal gain is 1/(1 + a): GR = 20·log10(1 + a), exactly what gainFor inverts.
    float worstSs = 0.0f;
    for (float gr = 0.5f; gr <= 45.0f; gr += 0.5f)
    {
        const float a = el.gainFor(gr);
        const float y = el.apply(1.0e-4f, a, 0);
        worstSs = std::max(worstSs, std::abs(-ampToDb(y / 1.0e-4f) - gr));
    }
    std::printf("    small-signal GR vs requested, 0.5..45 dB: worst %.4f dB\n", worstSs);
    CHECK(worstSs < 2e-3f, "small-signal gain is exactly the requested GR");
    CHECK(std::abs(Div::conductanceFor(80.0f) - Div::kMaxConductance) < 1e-3f, "the FET fully on caps the conductance (a = 300, 49.6 dB)");

    // (b) ε: zero when pinched off, rising with conductance, bounded.
    bool epsRises = Div::residual(0.0f, 0.0f) == 0.0f && Div::residual(0.0f, 1.0f) == 0.0f;
    float prev = 0.0f, prevAll = 0.0f, eMax = 0.0f, eMaxAll = 0.0f;
    for (float a = 0.01f; a <= 300.0f; a *= 1.1f)
    {
        const float e = Div::residual(a, 0.0f), eAll = Div::residual(a, 1.0f);
        epsRises = epsRises && e > prev && eAll > prevAll && eAll > e;
        prev = e;
        prevAll = eAll;
        eMax = std::max(eMax, e);
        eMaxAll = std::max(eMaxAll, eAll);
    }
    CHECK(epsRises, "ε(0) = 0 and ε rises with the channel conductance (All above the buttons everywhere)");
    CHECK(eMax < Div::kEpsMax, "the buttons: |ε| = |2k − 1| stays below the passive divider's bound");
    CHECK(eMaxAll < Div::kAllInEpsMax, "All: bounded by its own (amplified gate drive) ceiling");

    // (c) Working range at threshold-level signals, 4:1.
    std::cout << "    GR dB | a      | eps    | node V_pk | V_DS/(Vctl-Vp) | channel share | quad share r\n";
    float worstRatioAbove12 = 0.0f, worstShare = 0.0f;
    const GC::Params p4 = GC::forPreset(Fet::kPresets[0]);
    for (float gr : { 1.0f, 3.0f, 5.0f, 10.0f, 12.0f, 15.0f, 20.0f, 30.0f })
    {
        // Input level whose static GR is `gr`.
        float lo = kT - 10.0f, hi = kT + 80.0f;
        for (int i = 0; i < 60; ++i) { const float m = 0.5f * (lo + hi); (m - GC::outputDb(m, kT, p4) < gr ? lo : hi) = m; }
        const float x = 0.5f * (lo + hi);
        const float a = Div::conductanceFor(gr);
        const float eps = Div::residual(a, 0.0f);
        const float vNode = dbToAmp(GC::outputDb(x, kT, p4)) * Div::kVoltsPerFs;
        const float vov = a / (2.0f * Div::kBetaRs);
        const float ratio = vNode / vov;
        const float r = 4.0f * Div::kBetaRs * eps * dbToAmp(x) * Div::kVoltsPerFs / ((1.0f + a) * (1.0f + a));
        std::printf("    %5.1f | %6.2f | %.4f | %6.1f mV | %10.2f     | %8.2f      | %.3f\n",
                    gr, a, eps, vNode * 1000.0f, ratio, a / (1.0f + a), r);
        if (gr >= 15.0f) worstRatioAbove12 = std::max(worstRatioAbove12, ratio);
        worstShare = std::max(worstShare, r);
    }
    CHECK(worstRatioAbove12 < 1.0f, "V_DS < V_ctl − V_P from 15 dB of GR (square law in range)");
    CHECK(worstShare < 0.25f, "the quadratic share stays < 0.25 through 30 dB of GR (limiter transparent)");

    // (d) The rectifier reads the continuous peak. A tone not commensurate with
    // the rate: the sampled |x| peak wanders with the sampling phase (the beat
    // a fast 20:1 loop turns into sidebands); RcRectifier's does not.
    std::cout << "    rectifier, peak-level spread across 400 cycles at 4x (sampled |x| vs RcRectifier):\n";
    for (double f0 : { 6999.0, 15999.0, 18999.0 })
    {
        comp::RcRectifier det;
        det.reset();
        const int n = static_cast<int>(kOs * 400.0 / f0);
        float lo[2] = { 1e9f, 1e9f }, hi[2] = { -1e9f, -1e9f };
        float cyc[2] = { -300.0f, -300.0f };
        int lastCycle = 0;
        for (int i = 0; i < n; ++i)
        {
            const float x = static_cast<float>(std::sin(2.0 * kPi * f0 * i / kOs));
            const float lv[2] = { ampToDb(std::abs(x)), det.levelDb(x, x, comp::StereoLink::Max) };
            const int c = static_cast<int>(2.0 * f0 * i / kOs);   // half-cycles
            if (c != lastCycle)
            {
                if (lastCycle > 4)
                    for (int k = 0; k < 2; ++k) { lo[k] = std::min(lo[k], cyc[k]); hi[k] = std::max(hi[k], cyc[k]); }
                cyc[0] = cyc[1] = -300.0f;
                lastCycle = c;
            }
            for (int k = 0; k < 2; ++k) cyc[k] = std::max(cyc[k], lv[k]);
        }
        std::printf("      %6.0f Hz: %.3f dB vs %.4f dB (peak reads %.3f vs %.4f dB)\n",
                    f0, hi[0] - lo[0], hi[1] - lo[1], lo[0], lo[1]);
        CHECK(hi[0] - lo[0] > 0.05f, "NEGATIVE CONTROL: the sampled |x| peak wanders by > 0.05 dB at " << f0 << " Hz");
        CHECK(hi[1] - lo[1] < 0.1f * (hi[0] - lo[0]) && std::abs(lo[1]) < 0.05f,
              "the rectifier reads the continuous peak (spread < 1/10 of sampled, within 0.05 dB) at " << f0 << " Hz");
    }

    // (e) Ballistics: predict() monotone in ρ with an exact derivative.
    const auto c = Bal::makeCoeffs({ 200.0e-6f, 0.1f }, kOs);
    std::mt19937 rng(7);
    std::uniform_real_distribution<float> U(0.0f, 40.0f);
    int nonMono = 0;
    float worstD = 0.0f;
    for (int k = 0; k < 400; ++k)
    {
        Bal::State st;
        st.v = U(rng); st.rho = U(rng); st.gr = Bal::grFor(st.v);
        float pv = -1.0f;
        for (float rho = 0.0f; rho <= 80.0f; rho += 0.37f)
        {
            float d, dp, dm;
            const float v = Bal::predict(st, c, rho, d);
            if (v < pv - 1e-6f) ++nonMono;
            pv = v;
            const float h = 1e-2f;
            const float vp = Bal::predict(st, c, rho + h, dp);
            const float vm = Bal::predict(st, c, std::max(0.0f, rho - h), dm);
            if (dp == dm && d == dp && d > 0.0f)
                worstD = std::max(worstD, std::abs((vp - vm) / (rho + h - std::max(0.0f, rho - h)) - d) / d);
        }
    }
    std::printf("    ballistics: non-monotone steps %d; worst rel. derivative error %.2e\n", nonMono, worstD);
    CHECK(nonMono == 0, "predict() is nondecreasing in the drive");
    CHECK(worstD < 1e-2f, "predict()'s derivative matches a finite difference");

    // (f) GC: the conductance form is the inverse of the static curve, per preset.
    float worstInv = 0.0f, worstSlope = 0.0f;
    for (const auto& pr : Fet::kPresets)
    {
        const GC::Params p = GC::forPreset(pr);
        for (float x = kT - 20.0f; x <= kT + 60.0f; x += 0.25f)
        {
            const float y = GC::outputDb(x, kT, p);
            float s;
            const float a = GC::reductionFB(y, kT, p, s);
            worstInv = std::max(worstInv, std::abs(Bal::grFor(a) - (x - y)));
            float sp, sm;
            const float h = 1e-2f;
            const float ap = GC::reductionFB(y + h, kT, p, sp), am = GC::reductionFB(y - h, kT, p, sm);
            if (a > 0.05f && a < 290.0f && std::abs(sp - sm) < 1e-3f * (sp + 1e-3f))
                worstSlope = std::max(worstSlope, std::abs((ap - am) / (2.0f * h) - s) / (s + 1e-3f));
        }
    }
    std::printf("    GC: conductance form vs static curve worst %.2e dB; slope vs finite difference worst rel. %.2e\n",
                worstInv, worstSlope);
    CHECK(worstInv < 2e-3f, "a = reductionFB(outputDb(x)) gives back exactly the curve's GR");
    CHECK(worstSlope < 1e-2f, "the GC's conductance slope is exact");
}

// ─── [2] Static curve per ratio preset ───────────────────────────────────────

struct CurveFit { float ratio, thresholdDb, grAtThreshold, worstDb; };

static CurveFit fitPreset(int preset)
{
    CoreOpts o;
    o.preset = preset;
    o.residual = 0.0f;   // square wave: ε would make ± halves differ; GR is ε-independent
    const GC::Params p = GC::forPreset(Fet::kPresets[static_cast<size_t>(preset)]);
    CurveFit f {};
    for (float lvl = kT - 20.0f; lvl <= kT + 50.0f; lvl += 5.0f)
        f.worstDb = std::max(f.worstDb, std::abs(settledOutDb(lvl, o) - GC::outputDb(lvl, kT, p)));
    // The asymptote well above the knee, from two measured points.
    const float x1 = kT + 25.0f, x2 = kT + 40.0f;
    const float y1 = settledOutDb(x1, o), y2 = settledOutDb(x2, o);
    f.ratio = (x2 - x1) / (y2 - y1);
    // y = T' + (x − T')/R  ⇒  T' = (y − x/R) / (1 − 1/R)
    f.thresholdDb = (y1 - x1 / f.ratio) / (1.0f - 1.0f / f.ratio);
    f.grAtThreshold = f.thresholdDb - settledOutDb(f.thresholdDb, o);
    return f;
}

static void testStaticCurve()
{
    std::cout << "\n[2] static curve per ratio preset (settled loop, square wave, in-core dBFS)\n";
    CurveFit f[5];
    std::cout << "    preset | measured ratio | threshold (dBFS) | GR at threshold | worst |loop − curve|\n";
    for (int i = 0; i < 5; ++i)
    {
        f[i] = fitPreset(i);
        std::printf("    %-6s | %8.2f:1     | %9.2f        | %7.2f dB      | %.4f dB\n",
                    kNames[i], f[i].ratio, f[i].thresholdDb, f[i].grAtThreshold, f[i].worstDb);
        const float want = Fet::kPresets[static_cast<size_t>(i)].ratio;
        CHECK(std::abs(f[i].ratio - want) < 0.03f * want, kNames[i] << ": measured ratio " << f[i].ratio << " is the preset's");
        CHECK(f[i].worstDb < 0.02f, kNames[i] << ": the loop settles on the preset's curve (worst " << f[i].worstDb << " dB)");
    }
    // The threshold MOVES with the ratio: +1 dB per button (UREI table).
    for (int i = 1; i < 4; ++i)
    {
        const float step = f[i].thresholdDb - f[i - 1].thresholdDb;
        CHECK(std::abs(step - 1.0f) < 0.1f, kNames[i - 1] << " -> " << kNames[i] << ": threshold rises 1 dB (" << step << ")");
    }
    CHECK(std::abs(f[0].thresholdDb - kT) < 0.1f, "4:1 threshold at the reference level");
    CHECK(f[3].thresholdDb - f[0].thresholdDb > 2.5f, "the threshold visibly moves across the buttons (4:1 -> 20:1: +3 dB)");
    // Knee hardens with ratio: less reduction already applied AT the threshold.
    // The network's divider at the worst corner (slowest attack, fastest
    // release): the loop gain absorbs it, |20·log10 r| / R short of the curve.
    for (int i : { 0, kAll })
    {
        CoreOpts o;
        o.preset = i;
        o.attack = 1.0f;
        o.release = 7.0f;
        o.residual = 0.0f;
        Core core;
        prepareCore(core, kFs, o);
        auto x = square(static_cast<int>(kFs * 1.0), dbToAmp(kT + 20.0f), 48);
        runCore(core, x, nullptr);
        const float want = kT + 20.0f - GC::outputDb(kT + 20.0f, kT, GC::forPreset(Fet::kPresets[static_cast<size_t>(i)]));
        const auto& b = settingsFor(o).bal;
        std::printf("    divider droop, %s attack 1 / release 7 (r = %.4f): GR %.3f vs curve %.3f dB\n",
                    kNames[i], b.releaseS / (b.attackS + b.releaseS), core.getGainReductionDb(), want);
        CHECK(std::abs(core.getGainReductionDb() - want) < 0.1f, kNames[i] << ": worst-corner droop stays under 0.1 dB");
    }
    CHECK(f[0].grAtThreshold > f[1].grAtThreshold && f[1].grAtThreshold > f[2].grAtThreshold
          && f[2].grAtThreshold > f[3].grAtThreshold, "the knee hardens with the ratio");

    // Monotone everywhere Input can drive it (to the FET's ceiling and past).
    for (int i = 0; i < 5; ++i)
    {
        const GC::Params p = GC::forPreset(Fet::kPresets[static_cast<size_t>(i)]);
        float minSlope = 1.0f;
        for (float x = kT - 30.0f; x <= kT + 80.0f; x += 0.25f)
            minSlope = std::min(minSlope, (GC::outputDb(x + 0.25f, kT, p) - GC::outputDb(x, kT, p)) / 0.25f);
        CHECK(minSlope > 0.0f, kNames[i] << ": output rises with input everywhere");
    }

    // Input drives the level into the curve: the same program, more Input,
    // more reduction, following the static curve.
    std::cout << "    effect, 1 kHz sine at -12 dBFS, 4:1: Input dB -> GR dB (curve)\n";
    float prevGr = -10.0f;
    bool rises = true;
    for (float in : { -12.0f, 0.0f, 12.0f, 24.0f })
    {
        FetFx fx;
        fx.prepareToPlay(kFs, 512);
        fx.setParameterValue("input", in);
        fx.setParameterValue("release", 1.0f);
        fx.prepareToPlay(kFs, 512);
        juce::AudioBuffer<float> b(2, static_cast<int>(kFs * 0.5));
        for (int i = 0; i < b.getNumSamples(); ++i)
        {
            const float v = dbToAmp(-12.0f) * static_cast<float>(std::sin(2.0 * kPi * 1000.0 * i / kFs));
            b.setSample(0, i, v);
            b.setSample(1, i, v);
        }
        processEffect(fx, b, 512);
        const float gr = fx.getCore().getGainReductionDb();
        const float lvl = -12.0f + in;
        std::printf("      %+5.1f -> %6.2f (%6.2f)\n", in, gr, lvl - GC::outputDb(lvl, kT, GC::forPreset(Fet::kPresets[0])));
        rises = rises && gr > prevGr + 1.0f;
        prevGr = gr;
    }
    CHECK(rises, "more Input = more gain reduction (Input drives the curve)");
}

// ─── [3] THD vs gain reduction: the ε fit ────────────────────────────────────

struct ThdPoint { float gr; Thd t; };

// Core at 4x, 1 kHz sine, release knob 1 (1.1 s — the UREI spec condition),
// iterating the input level until the settled GR is `targetGr`.
static ThdPoint thdAt(int preset, float targetGr, float residual)
{
    constexpr double f0 = 1000.0;
    const GC::Params p = GC::forPreset(Fet::kPresets[static_cast<size_t>(preset)]);
    float lo = kT - 10.0f, hi = kT + 80.0f;
    for (int i = 0; i < 60; ++i) { const float m = 0.5f * (lo + hi); (m - GC::outputDb(m, kT, p) < targetGr ? lo : hi) = m; }
    float lvl = 0.5f * (lo + hi);
    ThdPoint out {};
    for (int it = 0; it < 4; ++it)
    {
        CoreOpts o;
        o.preset = preset;
        o.attack = 3.0f;
        o.release = 1.0f;
        o.residual = residual;
        Core core;
        prepareCore(core, kOs, o);
        const int n = static_cast<int>(kOs * 0.35);
        auto x = sine(n, dbToAmp(lvl), f0, kOs);
        runCore(core, x, nullptr);
        const int w = static_cast<int>(kOs * 0.1);   // 100 cycles
        out.gr = core.getGainReductionDb();
        out.t = measureThd(x.data() + (n - w), w, f0, kOs);
        const float err = targetGr - out.gr;
        if (std::abs(err) < 0.05f) break;
        lvl += err / (1.0f - 1.0f / p.ratio);
    }
    return out;
}

static void testThdVsGr()
{
    std::cout << "\n[3] THD vs gain reduction (element only, 1 kHz, release 1.1 s, core at 4x)\n";
    const float grs[] = { 1.0f, 3.0f, 5.0f, 10.0f, 15.0f, 20.0f, 25.0f, 30.0f };
    constexpr int N = 8;

    for (int preset : { 0, 3 })
    {
        ThdPoint fit[N], neg[N];
        std::printf("    %s   GR dB | THD %%   H2 dBc  H3 dBc | eps = 0: THD %%\n", kNames[preset]);
        for (int i = 0; i < N; ++i)
        {
            fit[i] = thdAt(preset, grs[i], 1.0f);
            neg[i] = thdAt(preset, grs[i], 0.0f);
            std::printf("          %5.1f | %6.3f  %6.1f  %6.1f | %7.4f\n", fit[i].gr, 100.0 * fit[i].t.thd,
                        ampToDb(float(fit[i].t.h2)), ampToDb(float(fit[i].t.h3)), 100.0 * neg[i].t.thd);
        }
        // Rises through the working range: 1..30 dB at 4:1, 1..20 dB at 20:1
        // (where the node is held lowest, ε saturates earlier — FetShuntDivider).
        const int top = preset == 0 ? N : 6;
        auto rising = [&](const ThdPoint* v) {
            bool ok = true;
            for (int i = 1; i < top; ++i) ok = ok && v[i].t.thd > 1.1 * v[i - 1].t.thd;
            return ok && v[top - 1].t.thd > 10.0 * v[0].t.thd;
        };
        CHECK(rising(fit), kNames[preset] << ": THD RISES with gain reduction through the working range");
        bool h2Leads = true;
        for (int i = 0; i < top; ++i) h2Leads = h2Leads && fit[i].t.h2 > 3.0 * fit[i].t.h3;
        CHECK(h2Leads, kNames[preset] << ": even-order (2nd harmonic) leads — the V_DS² residual");
        CHECK(fit[2].t.thd < 0.005, kNames[preset] << ": < 0.5 % at 5 dB of limiting (UREI spec)");
        CHECK(!rising(neg), kNames[preset] << ": NEGATIVE CONTROL: with ε = 0 THD does not rise with GR");
        CHECK(neg[5].t.thd < 0.1 * fit[5].t.thd, kNames[preset] << ": NEGATIVE CONTROL: ε = 0 has < 1/10 the distortion at 20 dB");
        if (preset == 0)
        {
            // The fit targets (FetCompressorCore.h): ≈0.13 / 0.4 / 1.4 / 2.1 % at 5 / 10 / 20 / 30 dB.
            const double want[4] = { 0.0013, 0.0041, 0.0136, 0.0211 };
            const int at[4] = { 2, 3, 5, 7 };
            for (int k = 0; k < 4; ++k)
                CHECK(fit[at[k]].t.thd > 0.7 * want[k] && fit[at[k]].t.thd < 1.4 * want[k],
                      "4:1 fit at " << grs[at[k]] << " dB: " << 100.0 * fit[at[k]].t.thd << " % (target " << 100.0 * want[k] << " %)");
            CHECK(fit[5].t.thd > 0.01, "grit: > 1 % THD at 20 dB of gain reduction");
        }
    }

    // Whole effect (4x, colour on) at ~5 dB of limiting, release 1.1 s, across
    // the band: UREI's "< 0.5 % THD 50 Hz - 15 kHz with limiting".
    std::cout << "    whole effect at ~5 dB GR, release 1.1 s:\n";
    for (double f0 : { 100.0, 1000.0, 10000.0 })
    {
        float inDb = 0.0f;
        float gr = 0.0f;
        Thd t {};
        for (int it = 0; it < 5; ++it)
        {
            FetFx fx;
            fx.prepareToPlay(kFs, 512);
            fx.setParameterValue("input", inDb);
            fx.setParameterValue("release", 1.0f);
            fx.prepareToPlay(kFs, 512);
            const int n = static_cast<int>(kFs * 0.6);
            juce::AudioBuffer<float> b(2, n);
            for (int i = 0; i < n; ++i)
            {
                const float v = dbToAmp(-12.0f) * static_cast<float>(std::sin(2.0 * kPi * f0 * i / kFs));
                b.setSample(0, i, v);
                b.setSample(1, i, v);
            }
            processEffect(fx, b, 512);
            gr = fx.getCore().getGainReductionDb();
            const int w = static_cast<int>(kFs * 0.2);
            t = measureThd(b.getReadPointer(0) + (n - w), w, f0, kFs);
            if (std::abs(gr - 5.0f) < 0.1f) break;
            inDb += (5.0f - gr) / 0.75f;
        }
        std::printf("      %6.0f Hz: GR %.2f dB, THD %.3f %%\n", f0, gr, 100.0 * t.thd);
        CHECK(std::abs(gr - 5.0f) < 0.3f && t.thd < 0.005, "whole effect < 0.5 % THD at 5 dB of limiting, " << f0 << " Hz");
    }
}

// ─── [3b] Class-A output stage ───────────────────────────────────────────────

static void testClassA()
{
    std::cout << "\n[3b] class-A output stage (colour alone, no reduction, core at 4x, 1 kHz)\n";
    double thd[4] {};
    const float lv[4] = { -20.0f, 0.0f, 4.0f, 8.0f };
    for (int k = 0; k < 4; ++k)
    {
        CoreOpts o;
        o.colour = true;
        Core core;
        prepareCore(core, kOs, o);
        const int n = static_cast<int>(kOs * 0.3);
        // Below the threshold (no reduction); Output (makeup) drives the stage.
        auto x = sine(n, dbToAmp(kT - 10.0f), 1000.0, kOs);
        runCore(core, x, nullptr, lv[k] - (kT - 10.0f));
        const int w = static_cast<int>(kOs * 0.1);
        const Thd t = measureThd(x.data() + (n - w), w, 1000.0, kOs);
        thd[k] = t.thd;
        std::printf("    %+5.1f dBFS into the stage: THD %.3f %%, H2 %.1f dBc, H3 %.1f dBc\n",
                    lv[k], 100.0 * t.thd, ampToDb(float(t.h2)), ampToDb(float(t.h3)));
        if (k < 2) CHECK(t.h2 > 3.0 * t.h3, "class A: the 2nd harmonic leads at " << lv[k] << " dBFS");
    }
    CHECK(thd[0] < 2e-4, "clean at -20 dBFS (< 0.02 %)");
    CHECK(thd[1] > 5e-4 && thd[1] < 3e-3, "0 dBFS: 0.05..0.3 % (UREI: < 0.3 % just below clipping)");
    CHECK(thd[3] > 10.0 * thd[1], "pushing Output past the knees clips it (asymmetric grit)");
    const float up = ClassAColorProbe(3.0f), dn = ClassAColorProbe(-3.0f);
    std::printf("    +/-3 FS through the curve: %+.3f / %+.3f (cutoff side clips first)\n", up, dn);
    CHECK(std::abs(dn) < std::abs(up), "asymmetric: the negative (cutoff) side runs out of headroom first");
}

// ─── [4] Ballistics at the oversampled rate ──────────────────────────────────

// 63 % time of the timing network itself (conductance domain), in µs.
// Attack: a drive step 0 -> 1 against a 1 s release; 63 % of where the cap
// settles (the network's own divider). The trapezoid sees a sampled step as a
// ramp across its first sample, so the step's time origin is half a sample in.
// Release: the charged cap (drive gone) discharging.
static double rcTime63(double tauS, double fs, bool attack)
{
    const double relS = attack ? 1.0 : tauS;
    const auto c = Bal::makeCoeffs({ static_cast<float>(attack ? tauS : 1e-6), static_cast<float>(relS) }, fs);
    Bal::State st;
    if (!attack) { st.v = 1.0f; st.rho = 0.0f; st.gr = Bal::grFor(1.0f); }
    std::vector<float> y;
    y.push_back(st.v);
    for (int i = 0; i < static_cast<int>(fs * tauS * 8.0) + 8; ++i)
    {
        Bal::commit(st, c, attack ? 1.0f : 0.0f);
        y.push_back(st.v);
    }
    // Sample k of y is the state after k steps.
    if (attack)
    {
        const float fin = static_cast<float>(relS / (tauS + relS));
        return (crossing(y, 1, 0.6321f * fin, true) - 0.5) / fs * 1e6;
    }
    return crossing(y, 1, 0.3679f, false) / fs * 1e6;
}

static void testBallistics()
{
    std::cout << "\n[4] ballistics: RC time constants at the 4x rate; knobs; ratio; release depth; 1x control\n";

    // (a) Knob law: 7 = fastest, 1 = slowest, geometric between.
    CHECK(std::abs(Fet::attackSeconds(7.0f) - 20e-6) < 1e-9 && std::abs(Fet::attackSeconds(1.0f) - 800e-6) < 1e-9,
          "attack knob: 7 = 20 us, 1 = 800 us");
    CHECK(std::abs(Fet::releaseSeconds(7.0f) - 0.050) < 1e-9 && std::abs(Fet::releaseSeconds(1.0f) - 1.100) < 1e-9,
          "release knob: 7 = 50 ms, 1 = 1.1 s");
    bool cw = true;
    for (float k = 1.0f; k < 7.0f; k += 0.5f)
        cw = cw && Fet::attackSeconds(k + 0.5f) < Fet::attackSeconds(k) && Fet::releaseSeconds(k + 0.5f) < Fet::releaseSeconds(k);
    CHECK(cw, "both get FASTER clockwise, as numbered on the hardware");

    // (b) The RC networks measured at the oversampled rate (4 x 44.1 kHz, the
    // tightest case): 63 % in tau, even at 20 us = 3.5 samples.
    const double os44 = 4.0 * 44100.0;
    std::cout << "    attack RC @176.4 kHz: knob -> tau (measured 63 %)\n";
    float worstA = 0.0f;
    for (float k : { 7.0f, 6.0f, 5.0f, 4.0f, 1.0f })
    {
        const double tau = Fet::attackSeconds(k);
        const double us = rcTime63(tau, os44, true);
        std::printf("      %.0f: %7.1f us (%7.1f)\n", k, tau * 1e6, us);
        worstA = std::max(worstA, static_cast<float>(std::abs(us - tau * 1e6) / (tau * 1e6)));
    }
    CHECK(worstA < 0.02f, "attack RC hits its tau within 2 % at the oversampled rate (worst " << worstA << ")");
    float worstR = 0.0f;
    for (float k : { 7.0f, 4.0f, 1.0f })
    {
        const double tau = Fet::releaseSeconds(k);
        worstR = std::max(worstR, static_cast<float>(std::abs(rcTime63(tau, os44, false) - tau * 1e6) / (tau * 1e6)));
    }
    CHECK(worstR < 0.005f, "release RC hits its tau within 0.5 %");

    // NEGATIVE CONTROL at 1x (44.1 kHz): 20 us is sub-sample. The RC cannot
    // resolve it — knob 7 and knob 6 (34 us) land within a sample of each
    // other, and the 20 us setting misses its tau badly.
    const double t7x1 = rcTime63(Fet::attackSeconds(7.0f), 44100.0, true);
    const double t6x1 = rcTime63(Fet::attackSeconds(6.0f), 44100.0, true);
    const double t7x4 = rcTime63(Fet::attackSeconds(7.0f), os44, true);
    const double t6x4 = rcTime63(Fet::attackSeconds(6.0f), os44, true);
    std::printf("    knob 7 / knob 6 attack: 1x %.1f / %.1f us, 4x %.1f / %.1f us (1 sample @44.1k = 22.7 us)\n",
                t7x1, t6x1, t7x4, t6x4);
    CHECK(std::abs(t7x1 - 20.0) > 0.15 * 20.0, "NEGATIVE CONTROL: at 1x the 20 us attack misses its tau by > 15 %");
    CHECK(std::abs(t7x4 - 20.0) < 0.02 * 20.0, "at 4x it is within 2 %");

    // (c) Attack slows slightly at higher ratios (the preset's RC).
    std::cout << "    attack knob 4 per ratio: RC tau | closed-loop 63 % / 98 % of GR (+20 dB step, 4x)\n";
    double rcTau[5] {}, cl63[5] {}, cl98[5] {};
    for (int p = 0; p < 5; ++p)
    {
        rcTau[p] = comp::fetSettings(p, 4.0f, 5.0f).bal.attackS * 1e6;
        CoreOpts o;
        o.preset = p;
        o.attack = 4.0f;
        o.release = 1.0f;
        o.residual = 0.0f;
        Core core;
        prepareCore(core, kOs, o);
        const int pre = static_cast<int>(kOs * 0.02);
        auto x = square(pre, dbToAmp(kT - 10.0f), 192);
        append(x, square(static_cast<int>(kOs * 0.02), dbToAmp(kT + 10.0f), 192));
        std::vector<float> gr;
        runCore(core, x, nullptr, 0.0f, &gr);
        const float fin = gr.back();
        cl63[p] = (crossing(gr, pre, 0.632f * fin, true) - pre + 1) / kOs * 1e6;
        cl98[p] = (crossing(gr, pre, 0.98f * fin, true) - pre + 1) / kOs * 1e6;
        std::printf("      %-5s %6.1f us | %6.1f / %6.1f us (GR %.1f dB)\n", kNames[p], rcTau[p], cl63[p], cl98[p], fin);
    }
    CHECK(rcTau[0] < rcTau[1] && rcTau[1] < rcTau[2] && rcTau[2] < rcTau[3], "the RC attack slows with the ratio");
    CHECK(rcTau[3] < 1.35 * rcTau[0], "…slightly (20:1 within 35 % of 4:1)");
    CHECK(rcTau[kAll] > 3.0 * rcTau[3], "All buttons in: the attack lag");

    // (d) UREI tone-burst attack is the CLOSED loop: "< 20 us" fully CW, "800
    // us" fully CCW. At 4:1 the loop's full attack (98 %) lands there.
    for (float k : { 7.0f, 1.0f })
    {
        CoreOpts o;
        o.attack = k;
        o.release = 1.0f;
        o.residual = 0.0f;
        Core core;
        prepareCore(core, kOs, o);
        const int pre = static_cast<int>(kOs * 0.02);
        auto x = square(pre, dbToAmp(kT - 10.0f), 192);
        append(x, square(static_cast<int>(kOs * 0.02), dbToAmp(kT + 10.0f), 192));
        std::vector<float> gr;
        runCore(core, x, nullptr, 0.0f, &gr);
        const double full = (crossing(gr, pre, 0.98f * gr.back(), true) - pre + 1) / kOs * 1e6;
        std::printf("    4:1 knob %.0f: closed-loop full attack (98 %%) %.1f us (RC tau %.0f us)\n", k, full, Fet::attackSeconds(k) * 1e6);
        if (k == 7.0f) CHECK(full < 25.0, "fastest: full attack within the UREI's < 20 us class (" << full << " us)");
        else           CHECK(full > 400.0 && full < 1600.0, "slowest: full attack in the 800 us class (" << full << " us)");
    }

    // (e) Release: RC in conductance ⇒ in dB, 63 % in ~tau from light GR,
    // slower from deep GR (linear-in-dB ramp). Release knob 4 (~235 ms).
    auto release63 = [&](float grTarget) {
        CoreOpts o;
        o.attack = 7.0f;
        o.release = 4.0f;
        o.residual = 0.0f;
        const GC::Params p = GC::forPreset(Fet::kPresets[0]);
        float lo = kT - 10.0f, hi = kT + 80.0f;
        for (int i = 0; i < 60; ++i) { const float m = 0.5f * (lo + hi); (m - GC::outputDb(m, kT, p) < grTarget ? lo : hi) = m; }
        Core core;
        prepareCore(core, kFs, o);
        const int on = static_cast<int>(kFs * 0.3);
        auto x = square(on, dbToAmp(0.5f * (lo + hi)), 48);
        append(x, zeros(static_cast<int>(kFs * 3.0)));
        std::vector<float> gr;
        runCore(core, x, nullptr, 0.0f, &gr);
        const float g0 = gr[static_cast<size_t>(on - 1)];
        return (crossing(gr, on, 0.3679f * g0, false) - on + 1) / kFs;
    };
    const double tauR = Fet::releaseSeconds(4.0f);
    const double r3 = release63(3.0f), r20 = release63(20.0f);
    std::printf("    release knob 4 (tau %.0f ms): 63 %% recovery in dB from 3 dB GR %.0f ms, from 20 dB GR %.0f ms\n",
                tauR * 1e3, r3 * 1e3, r20 * 1e3);
    CHECK(std::abs(r3 - tauR) < 0.2 * tauR, "light GR releases in ~tau");
    CHECK(r20 > 1.5 * r3, "deep GR releases slower (conductance-domain RC: a linear ramp in dB)");

    // (f) Rate invariance: 48k-based and 44.1k-based oversampled rates agree.
    const double a192 = rcTime63(Fet::attackSeconds(5.0f), kOs, true), a176 = rcTime63(Fet::attackSeconds(5.0f), os44, true);
    CHECK(std::abs(a192 - a176) < 0.03 * a192, "RC time constants are rate-invariant");

    FetFx fx;
    fx.prepareToPlay(kFs, 512);
    CHECK(fx.getCore().getProcessRate() == 4.0 * kFs, "the effect's core runs at the 4x oversampled rate");
}

// ─── [5] Aliasing under fast, heavy compression ──────────────────────────────

// Inharmonic power relative to the fundamental, over a window of exactly
// `cycles` periods: everything not at a multiple of f0 (DC excluded).
static float inharmonicDb(const float* x, int n, int cycles)
{
    // DFT on the grid of 1/(n) — f0 is bin `cycles`. Radix-2 not needed: n is
    // chosen as a power of two.
    int order = 0;
    while ((1 << order) < n) ++order;
    juce::dsp::FFT fft(order);
    std::vector<float> buf(static_cast<size_t>(2 * n), 0.0f);
    std::copy(x, x + n, buf.begin());
    fft.performFrequencyOnlyForwardTransform(buf.data(), true);
    const double fund = buf[static_cast<size_t>(cycles)];
    double inh = 0.0;
    for (int k = 1; k <= n / 2; ++k)
    {
        if (k % cycles == 0) continue;
        inh += static_cast<double>(buf[static_cast<size_t>(k)]) * buf[static_cast<size_t>(k)];
    }
    return ampToDb(static_cast<float>(std::sqrt(inh) / fund));
}

static void testAliasing()
{
    std::cout << "\n[5] aliasing: tones toward Nyquist, 20:1, attack 7 / release 7, ~20 dB GR, 48 kHz\n";
    constexpr int N = 16384;                 // analysis window, a power of two
    const int cyclesList[] = { 1024, 2389, 3413, 4437, 5461, 6485 };   // 3 .. 19 kHz, co-prime-ish with N
    std::cout << "    f0 Hz  | inharmonic dBc: 4x effect | 1x core (control)\n";
    float worstLow = -300.0f, worstTop = -300.0f;
    int gaps = 0, count = 0;
    for (int cyc : cyclesList)
    {
        const double f0 = cyc * kFs / N;
        const int n = N * 3;
        // 4x: the whole effect.
        FetFx fx;
        fx.prepareToPlay(kFs, 512);
        fx.setParameterValue("ratio", 3.0f);
        fx.setParameterValue("attack", 7.0f);
        fx.setParameterValue("release", 7.0f);
        fx.setParameterValue("input", 22.0f);
        fx.setParameterValue("output", -12.0f);
        fx.prepareToPlay(kFs, 512);
        juce::AudioBuffer<float> b(2, n);
        for (int i = 0; i < n; ++i)
        {
            const float v = 0.25f * static_cast<float>(std::sin(2.0 * kPi * f0 * i / kFs));
            b.setSample(0, i, v);
            b.setSample(1, i, v);
        }
        processEffect(fx, b, 512);
        const float a4 = inharmonicDb(b.getReadPointer(0) + (n - N), N, cyc);

        // 1x: the same core straight at 48 kHz, same drive.
        CoreOpts o;
        o.preset = 3;
        o.attack = 7.0f;
        o.release = 7.0f;
        o.colour = true;
        Core core;
        prepareCore(core, kFs, o);
        std::vector<float> x(static_cast<size_t>(n));
        for (int i = 0; i < n; ++i) x[static_cast<size_t>(i)] = 0.25f * dbToAmp(22.0f) * static_cast<float>(std::sin(2.0 * kPi * f0 * i / kFs));
        runCore(core, x, nullptr, -12.0f);
        const float a1 = inharmonicDb(x.data() + (n - N), N, cyc);
        std::printf("    %6.0f |   %7.1f               | %7.1f   (GR %.1f dB)\n", f0, a4, a1, fx.getCore().getGainReductionDb());
        (f0 < 16500.0 ? worstLow : worstTop) = std::max(f0 < 16500.0 ? worstLow : worstTop, a4);
        ++count;
        if (a1 > a4 + 20.0f) ++gaps;
    }
    CHECK(worstLow < -65.0f, "4x: inharmonic products below -65 dBc through 16 kHz (worst " << worstLow << " dBc)");
    CHECK(worstTop < -55.0f, "4x: below -55 dBc at 19 kHz (worst " << worstTop << " dBc) — the true-peak fit's own error at 10 samples/cycle");
    CHECK(gaps >= count - 1, "NEGATIVE CONTROL: the 1x core aliases > 20 dB worse across the sweep (" << gaps << "/" << count << ")");
}

// ─── [6] All buttons in ──────────────────────────────────────────────────────

static void testAllButtonsIn()
{
    std::cout << "\n[6] all buttons in: its own mode\n";
    const auto& all = Fet::kPresets[kAll];

    // (a) Not a derived combination: not any single button, not their mean.
    comp::FetPreset mean { "mean", 0, 0, 0, 0, 0, false };
    for (int i = 0; i < 4; ++i)
    {
        const auto& p = Fet::kPresets[static_cast<size_t>(i)];
        mean.ratio += p.ratio / 4; mean.kneeDb += p.kneeDb / 4; mean.thresholdOffsetDb += p.thresholdOffsetDb / 4;
        mean.attackScale += p.attackScale / 4; mean.releaseScale += p.releaseScale / 4;
        CHECK(!(GC::forPreset(p) == GC::forPreset(all)), "All is not the " << p.name << " curve");
    }
    CHECK(all.thresholdOffsetDb < Fet::kPresets[0].thresholdOffsetDb, "All: threshold BELOW every button's (not a blend of them)");
    CHECK(all.kneeDb < Fet::kPresets[3].kneeDb, "All: harder knee than any button");
    CHECK(all.releaseScale < 1.0f && all.attackScale > mean.attackScale * 2.0f, "All: faster release, lagging attack");
    CHECK(all.allButtonsIn && !Fet::kPresets[3].allButtonsIn, "All switches the element's bias network");

    // (b) Measured: plateau ratio in 12..20:1, threshold below 4:1's.
    const CurveFit f = fitPreset(kAll), f4 = fitPreset(0);
    std::printf("    All: %.2f:1, threshold %.2f dBFS (4:1 at %.2f)\n", f.ratio, f.thresholdDb, f4.thresholdDb);
    CHECK(f.ratio >= 12.0f && f.ratio <= 20.0f, "All: ratio between 12:1 and 20:1 (ARP)");
    CHECK(f.thresholdDb < f4.thresholdDb - 2.0f, "All: compresses from a lower level than any button");

    // (c) Dirt: at the same GR, far more distortion than 20:1 — and it does
    // not clean up at deep reduction the way the four buttons do.
    for (float g : { 10.0f, 30.0f })
    {
        const ThdPoint t20 = thdAt(3, g, 1.0f), tAll = thdAt(kAll, g, 1.0f);
        std::printf("    THD at %.0f dB GR: 20:1 %.3f %%, All %.3f %%\n", g, 100.0 * t20.t.thd, 100.0 * tAll.t.thd);
        CHECK(tAll.t.thd > 2.5 * t20.t.thd, "All: > 2.5x dirtier than 20:1 at " << g << " dB of GR");
    }

    // (d) Lag on initial transients: a step overshoots further before the
    // loop catches it; then pumps back faster.
    auto overshootAndRelease = [&](int preset, float& peakOverDb, double& rel63) {
        CoreOpts o;
        o.preset = preset;
        o.attack = 5.0f;
        o.release = 5.0f;
        o.residual = 0.0f;
        Core core;
        prepareCore(core, kOs, o);
        const int pre = static_cast<int>(kOs * 0.05), on = static_cast<int>(kOs * 0.2);
        auto x = square(pre, dbToAmp(kT - 12.0f), 192);
        append(x, square(on, dbToAmp(kT + 18.0f), 192));
        append(x, zeros(static_cast<int>(kOs * 1.0)));
        std::vector<float> gr;
        runCore(core, x, nullptr, 0.0f, &gr);
        float peak = 0.0f;
        for (int i = pre; i < pre + static_cast<int>(kOs * 0.005); ++i) peak = std::max(peak, std::abs(x[static_cast<size_t>(i)]));
        const float settled = std::abs(x[static_cast<size_t>(pre + on - 1)]);
        peakOverDb = ampToDb(peak / settled);
        const float g0 = gr[static_cast<size_t>(pre + on - 1)];
        rel63 = (crossing(gr, pre + on, 0.3679f * g0, false) - (pre + on) + 1) / kOs;
    };
    float o20, oAll;
    double r20, rAll;
    overshootAndRelease(3, o20, r20);
    overshootAndRelease(kAll, oAll, rAll);
    std::printf("    +30 dB step: first-5 ms overshoot 20:1 %.1f dB vs All %.1f dB; release 63 %%: %.0f ms vs %.0f ms\n",
                o20, oAll, r20 * 1e3, rAll * 1e3);
    CHECK(oAll > o20 + 1.0f, "All: more of the initial transient gets through (the lag)");
    CHECK(rAll < 0.75 * r20, "All: pumps back faster");
}

// ─── [7] Stereo link ─────────────────────────────────────────────────────────

static void testStereoLink()
{
    std::cout << "\n[7] stereo link: identical control on both channels\n";
    CoreOpts o;
    o.preset = 3;
    o.attack = 7.0f;
    o.release = 7.0f;
    o.residual = 0.0f;
    Core core;
    prepareCore(core, kOs, o);
    const int n = static_cast<int>(kOs * 0.3);
    auto L = sine(n, 0.9f, 220.0, kOs), R = sine(n, 0.01f, 3001.0, kOs);
    const auto L0 = L, R0 = R;
    runCore(core, L, &R);
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
    std::printf("    left-driven GR applied to right (eps = 0): worst relative gain mismatch %.2e over %d samples\n", worst, compared);
    CHECK(compared > 1000 && worst < 1e-5, "linked gain is identical per sample");

    auto runSide = [&](int loudCh, juce::AudioBuffer<float>& out) -> float {
        FetFx fx;
        fx.prepareToPlay(kFs, 512);
        fx.setParameterValue("input", 18.0f);
        fx.prepareToPlay(kFs, 512);
        const int m = static_cast<int>(kFs * 0.3);
        out.setSize(2, m);
        for (int i = 0; i < m; ++i)
        {
            out.setSample(loudCh, i, 0.5f * static_cast<float>(std::sin(2.0 * kPi * 220.0 * i / kFs)));
            out.setSample(1 - loudCh, i, 0.01f * static_cast<float>(std::sin(2.0 * kPi * 3000.0 * i / kFs)));
        }
        processEffect(fx, out, 512);
        return fx.readMeterValue(2);
    };
    juce::AudioBuffer<float> a, b;
    const float grA = runSide(0, a), grB = runSide(1, b);
    bool mirrored = true;
    for (int i = 0; i < a.getNumSamples() && mirrored; ++i)
        mirrored = a.getSample(0, i) == b.getSample(1, i) && a.getSample(1, i) == b.getSample(0, i);
    // The quiet channel is turned down by the loud one's GR.
    const int w = static_cast<int>(kFs * 0.1);
    const float quietIn = 0.01f * dbToAmp(18.0f), quietOut = static_cast<float>(toneAmp(a.getReadPointer(1) + (a.getNumSamples() - w), w, 3000.0, kFs));
    std::printf("    effect: GR meter left-driven %.3f / right-driven %.3f dB; quiet channel turned down %.2f dB; mirror-exact: %s\n",
                grA, grB, ampToDb(quietIn / quietOut), mirrored ? "yes" : "NO");
    CHECK(grA > 6.0f, "the loud channel drives real gain reduction");
    CHECK(grA == grB, "same gain reduction whichever channel drives it");
    CHECK(ampToDb(quietIn / quietOut) > 0.5f * grA, "the quiet channel gets the loud channel's reduction");
    CHECK(mirrored, "effect output is exactly L/R mirror-symmetric");
}

// ─── [8] Stepped controls ────────────────────────────────────────────────────

static void testSteppedControls()
{
    std::cout << "\n[8] ratio buttons crossfade; All's bias network ramps\n";
    for (double fadeS : { 1.0 / kOs, 0.030 })
    {
        Core::Config cfg;
        cfg.crossfadeSeconds = fadeS;
        Core core(cfg);
        CoreOpts o;
        o.attack = 4.0f;
        o.release = 4.0f;
        o.residual = 0.0f;
        prepareCore(core, kOs, o);
        auto x = square(static_cast<int>(kOs * 0.5), dbToAmp(kT + 20.0f), 192);
        runCore(core, x, nullptr);
        const float before = core.getGainReductionDb();
        CoreOpts o2 = o;
        o2.preset = 3;
        core.setSettings(settingsFor(o2));
        auto y = square(static_cast<int>(kOs * 1.5), dbToAmp(kT + 20.0f), 192);
        std::vector<float> gr;
        runCore(core, y, nullptr, 0.0f, &gr);
        float worst = std::abs(gr[0] - before);
        for (size_t i = 1; i < gr.size(); ++i) worst = std::max(worst, std::abs(gr[i] - gr[i - 1]));
        const float want = kT + 20.0f - GC::outputDb(kT + 20.0f, kT, GC::forPreset(Fet::kPresets[3]));
        std::printf("    4:1 -> 20:1 %-10s GR %5.2f -> %5.2f dB (curve %5.2f), max |dGR| %.4f dB/sample\n",
                    fadeS > 0.01 ? "30 ms fade" : "hard", before, gr.back(), want, worst);
        CHECK(std::abs(gr.back() - want) < 0.05f, "lands on the new button's curve");
        if (fadeS > 0.01) CHECK(worst < 0.01f, "the 30 ms coefficient-set fade never steps the gain");
        else              CHECK(worst > 0.3f, "NEGATIVE CONTROL: a hard switch steps the gain");
        CHECK(!core.isCrossfading() && core.getActiveSettings() == settingsFor(o2), "the fade completes onto the new lane");
    }

    // All on/off: the bias network (ε) ramps over 30 ms — the output of a
    // steady, compressed tone changes smoothly.
    FetFx fx;
    fx.prepareToPlay(kFs, 480);
    fx.setParameterValue("input", 20.0f);
    fx.setParameterValue("ratio", 3.0f);
    fx.prepareToPlay(kFs, 480);
    const int n = static_cast<int>(kFs * 0.6);
    juce::AudioBuffer<float> b(2, n);
    for (int i = 0; i < n; ++i)
    {
        const float v = 0.3f * static_cast<float>(std::sin(2.0 * kPi * 100.0 * i / kFs));
        b.setSample(0, i, v);
        b.setSample(1, i, v);
    }
    juce::MidiBuffer midi;
    for (int s = 0; s < n; s += 480)
    {
        if (s == static_cast<int>(kFs * 0.3) / 480 * 480) fx.setParameterValue("ratio", 4.0f);
        juce::AudioBuffer<float> view(b.getArrayOfWritePointers(), 2, s, 480);
        fx.processBlock(view, midi);
    }
    float worstJump = 0.0f, typical = 0.0f;
    for (int i = 1; i < n; ++i)
    {
        const float d = std::abs(b.getSample(0, i) - b.getSample(0, i - 1));
        if (i > static_cast<int>(kFs * 0.29) && i < static_cast<int>(kFs * 0.35)) worstJump = std::max(worstJump, d);
        if (i > static_cast<int>(kFs * 0.2) && i < static_cast<int>(kFs * 0.28)) typical = std::max(typical, d);
    }
    std::printf("    20:1 -> All on a 100 Hz tone: largest sample step around the switch %.4f vs steady %.4f\n", worstJump, typical);
    CHECK(fx.getCore().gainElement().allButtonsIn(), "ratio 4 engages All on the element");
    CHECK(worstJump < 1.5f * typical, "switching to All does not click (bias ramp + lane crossfade)");
}

// ─── [9] Realtime safety and CPU ─────────────────────────────────────────────

static void testRealtimeSafety()
{
    std::cout << "\n[9] realtime safety: allocations, denormals, loop stability, CPU\n";
    constexpr int block = 512;

    {
        FetFx fx;
        fx.prepareToPlay(kFs, block);
        juce::AudioBuffer<float> b(2, block);
        juce::MidiBuffer midi;
        std::mt19937 rng(3);
        std::uniform_real_distribution<float> d(-1.0f, 1.0f);
        long long allocs = 0;
        for (int k = 0; k < 400; ++k)
        {
            for (int c = 0; c < 2; ++c)
                for (int i = 0; i < block; ++i) b.setSample(c, i, d(rng));
            fx.setParameterValue("ratio", static_cast<float>((k / 3) % 5));
            fx.setParameterValue("attack", 1.0f + static_cast<float>(k % 7));
            fx.setParameterValue("release", 7.0f - static_cast<float>(k % 7) * 0.9f);
            fx.setParameterValue("input", static_cast<float>(k % 61) - 24.0f);
            fx.setParameterValue("output", static_cast<float>((k * 7) % 49) - 24.0f);
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
        // Also the per-block CPU cost of one instance.
        FetFx fx;
        fx.prepareToPlay(kFs, block);
        fx.setParameterValue("input", 24.0f);
        fx.setParameterValue("ratio", 4.0f);
        fx.setParameterValue("attack", 7.0f);
        fx.setParameterValue("release", 1.0f);
        juce::AudioBuffer<float> b(2, block);
        juce::MidiBuffer midi;
        using clk = std::chrono::steady_clock;
        double loudUs = 0.0, silentUs = 0.0;
        int subnormals = 0, nonFinite = 0;
        const int loudBlocks = static_cast<int>(kFs * 3.0 / block);
        const int quietBlocks = static_cast<int>(kFs * 20.0 / block);
        for (int k = 0; k < loudBlocks + quietBlocks; ++k)
        {
            const bool loud = k < loudBlocks;
            for (int c = 0; c < 2; ++c)
                for (int i = 0; i < block; ++i)
                    b.setSample(c, i, loud ? 0.9f * static_cast<float>(std::sin(2.0 * kPi * 60.0 * (k * block + i) / kFs)) : 0.0f);
            const auto t0 = clk::now();
            fx.processBlock(b, midi);
            const double us = std::chrono::duration<double, std::micro>(clk::now() - t0).count();
            if (loud && k > 10) loudUs += us; else if (k > loudBlocks + quietBlocks / 2) silentUs += us;
            for (int c = 0; c < 2; ++c)
                for (int i = 0; i < block; ++i)
                {
                    const float v = b.getSample(c, i);
                    if (!std::isfinite(v)) ++nonFinite;
                    else if (v != 0.0f && std::fpclassify(v) == FP_SUBNORMAL) ++subnormals;
                }
        }
        const float gr = fx.getCore().getGainReductionDb();
        const double loudPer = loudUs / (loudBlocks - 11), silentPer = silentUs / (quietBlocks / 2 - 1);
        std::printf("    CPU, one stereo instance at 4x: loud %.1f us/block (%.2f %% of a %d-sample block's %.0f us), "
                    "late silence %.1f us/block; subnormal outputs %d, GR state %.3g\n",
                    loudPer, 100.0 * loudPer / (block * 1e6 / kFs), block, block * 1e6 / kFs, silentPer, subnormals, gr);
        CHECK(nonFinite == 0, "all outputs finite");
        CHECK(subnormals == 0, "no subnormal output samples in silence after a loud signal");
        CHECK(gr == 0.0f || std::fpclassify(gr) != FP_SUBNORMAL, "GR state never subnormal");
        CHECK(silentPer < 3.0 * loudPer + 20.0, "silence after a loud signal is not slower (denormal stall)");
        CHECK(loudPer < 0.15 * (block * 1e6 / kFs), "one instance stays under 15 % of the block budget");

        // Where the time goes: the core alone at 4x on the same loud program,
        // and the oversampler alone (up + down, no core).
        CoreOpts o;
        o.preset = kAll;
        o.attack = 7.0f;
        o.release = 1.0f;
        o.colour = true;
        Core core;
        prepareCore(core, kOs, o);
        std::vector<float> L(static_cast<size_t>(block * 4)), R(static_cast<size_t>(block * 4));
        const float thr[1] = { kT }, mk[1] = { 0.0f };
        double coreUs = 0.0;
        const int reps = 200;
        for (int k = 0; k < reps; ++k)
        {
            for (int i = 0; i < block * 4; ++i)
                L[static_cast<size_t>(i)] = R[static_cast<size_t>(i)] = 0.9f * dbToAmp(24.0f) * static_cast<float>(std::sin(2.0 * kPi * 60.0 * (k * block * 4 + i) / kOs));
            const auto t0 = clk::now();
            core.process(L.data(), R.data(), block * 4, thr, mk, block * 4);
            coreUs += std::chrono::duration<double, std::micro>(clk::now() - t0).count();
        }
        xleth::dsp::Oversampler os(2, FetFx::kOversamplingOrder);
        os.prepare(block);
        double osUs = 0.0;
        for (int k = 0; k < reps; ++k)
        {
            for (int c = 0; c < 2; ++c)
                for (int i = 0; i < block; ++i) b.setSample(c, i, 0.5f * static_cast<float>(std::sin(2.0 * kPi * 60.0 * (k * block + i) / kFs)));
            float* ch[2] = { b.getWritePointer(0), b.getWritePointer(1) };
            juce::dsp::AudioBlock<float> host(ch, 2, static_cast<size_t>(block));
            const auto t0 = clk::now();
            os.processUp(host);
            os.processDown(host);
            osUs += std::chrono::duration<double, std::micro>(clk::now() - t0).count();
        }
        std::printf("    breakdown per %d-sample block: core at 4x %.1f us (%.1f ns per stereo oversampled sample), "
                    "oversampler up+down %.1f us\n", block, coreUs / reps, 1000.0 * coreUs / reps / (block * 4), osUs / reps);
    }

    {
        // Extreme settings at 44.1 kHz with NO oversampling: All, attack 7,
        // release 7, +40 dB over threshold, 50 Hz square. The implicit loop
        // must settle without ringing, on the curve.
        constexpr double fs44 = 44100.0;
        CoreOpts o;
        o.preset = kAll;
        o.attack = 7.0f;
        o.release = 7.0f;
        o.residual = 0.0f;
        Core core;
        prepareCore(core, fs44, o);
        auto x = square(static_cast<int>(fs44 * 2.0), dbToAmp(kT + 40.0f), 882);
        std::vector<float> gr;
        runCore(core, x, nullptr, 0.0f, &gr);
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
        const float want = kT + 40.0f - GC::outputDb(kT + 40.0f, kT, GC::forPreset(Fet::kPresets[kAll]));
        std::printf("    All / 7 / 7 / +40 dB / 44.1 kHz no OS: late |dGR| %.2e dB, sign flips %d, GR %.2f dB (curve %.2f)\n",
                    lateSlew, alternations, gr.back(), want);
        CHECK(bounded, "output bounded at extreme settings");
        CHECK(lateSlew < 1e-3f && alternations == 0, "implicit loop settles without ringing");
        CHECK(std::abs(gr.back() - want) < 0.05f, "and settles on the curve");
    }
}

// ─── [10] Latency, bypass, surface ───────────────────────────────────────────

static void testLatencyBypassSurface()
{
    std::cout << "\n[10] latency, latency-aligned bypass, parameter surface, registration\n";
    FetFx fx;
    fx.prepareToPlay(kFs, 480);
    fx.setParameterValue("input", -24.0f);
    fx.setParameterValue("output", 24.0f);
    fx.prepareToPlay(kFs, 480);
    const int lat = fx.getLatencySamples();
    std::printf("    4x FIR oversampler latency: %d samples, reported to PDC: %d\n", fx.getOversamplingLatencySamples(), lat);
    CHECK(fx.getOversamplingFactor() == 4, "4x oversampling");
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

    FetFx by;
    by.prepareToPlay(kFs, 480);
    by.setParameterValue("input", 30.0f);
    by.setParameterValue("ratio", 4.0f);
    by.setBypassed(true);
    by.prepareToPlay(kFs, 480);
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
    CHECK(worst == 0.0f, "bypass is sample-exact against the latency-aligned dry (Input is not applied to the dry)");

    FetFx s;
    CHECK(s.getParameters().size() == 5, "5 APVTS parameters: Input, Output, Attack, Release, Ratio");
    bool noThreshold = true;
    for (auto* prm : s.getParameters())
        if (auto* h = dynamic_cast<juce::HostedAudioProcessorParameter*>(prm))
            noThreshold = noThreshold && !h->getParameterID().containsIgnoreCase("thresh");
    CHECK(noThreshold, "no threshold control: Input drives the curve");
    CHECK(std::abs(s.getParameterValue("input")) < 1e-4f && std::abs(s.getParameterValue("output")) < 1e-4f, "Input/Output default 0 dB");
    CHECK(std::abs(s.getParameterValue("attack") - 3.0f) < 1e-4f && std::abs(s.getParameterValue("release") - 5.0f) < 1e-4f,
          "Attack 3 / Release 5 by default");
    CHECK(std::abs(s.getParameterValue("ratio")) < 1e-6f, "defaults to 4:1");
    s.prepareToPlay(kFs, 512);
    s.setParameterValue("ratio", 2.0f);
    CHECK(s.currentSettings().gc == GC::forPreset(Fet::kPresets[2]), "ratio 2 = the 12:1 preset");
    s.setParameterValue("attack", 7.0f);
    CHECK(std::abs(s.currentSettings().bal.attackS - 20e-6f * Fet::kPresets[2].attackScale) < 1e-9f,
          "attack 7 = 20 us (x the 12:1 slowdown)");

    EffectChainManager chain;
    chain.init(48000.0, 512);
    const int node = chain.addEffect("fet", 0);
    auto* e = node >= 0 ? chain.getEffect(node) : nullptr;
    CHECK(e != nullptr && e->getPluginId() == "fet", "AudioGraph creates \"fet\" as a stock effect");
    if (e) CHECK(e->getLatencySamples() > 0, "live chain instance reports its latency to PDC");
}

int main()
{
    juce::ScopedJuceInitialiser_GUI juceInit;
    std::cout << "test_fet_compressor — FET Comp on CompressorCore\n";

    testModelPieces();
    testStaticCurve();
    testThdVsGr();
    testClassA();
    testBallistics();
    testAliasing();
    testAllButtonsIn();
    testStereoLink();
    testSteppedControls();
    testRealtimeSafety();
    testLatencyBypassSurface();

    std::cout << "\n" << g_passed << " passed, " << g_failed << " failed\n";
    if (g_failed == 0) std::cout << "ALL TESTS PASSED\n";
    return g_failed == 0 ? 0 : 1;
}
