// test_varimu_compressor.cpp — Vari-Mu Comp ("varimu") behaviour tests
// Build: cmake --build build --config Release --target test_varimu_compressor
// Run:   ctest --test-dir build -C Release -R "^test_varimu_compressor$" -V
// Pass:  prints "ALL TESTS PASSED" and exits 0
//
// docs/Compressor_Archetypes_Deep_Dive.md §5.4 and §10, the items that apply to
// a vari-mu limiter. Behavioural only — curves, envelopes, spectra, identities —
// never a waveform null against hardware.
//
//   [1] Model pieces: the stage's GR curve (0 at rest, monotone, exact slope,
//       floor), the rectifier's C1 diode knee, the ballistics' predict()
//       monotone with an exact derivative, the push-pull element's small-signal
//       gain = the curve, transparency at rest, and NO THUMP: the common-mode
//       control voltage cancels exactly (NEGATIVE CONTROL: single-ended thumps).
//   [2] §10.1 Static curve: the loop settles on the equilibrium curve; the
//       ratio RISES with level from ≈2:1 toward ≈30:1; the knee is the widest
//       of the four; Input drives the curve. NEGATIVE CONTROL: a log-linear
//       g_m curve cannot get past ≈5:1.
//   [3] §10.4 Program dependence, positions 5 and 6: a single peak, a peak
//       train and sustained program — the train MUST release slower, sustained
//       slowest. NEGATIVE CONTROL: a fixed release (one branch) does not.
//   [4] §10.2 Ballistics under the §1.3 normalisation: the RC τ is the manual's
//       figure ÷ 3 at the oversampled rate, and the closed loop's recovery time
//       IS the manual's figure. NEGATIVE CONTROL: un-normalised constants fail.
//   [5] §10.6 THD vs gain reduction: rises with GR; push-pull cancels even
//       order and the mismatch leaves the residue (NEGATIVE CONTROLS: matched
//       pair, single-ended).
//   [6] §10.7 Aliasing and the oversampling choice: folded harmonics at 1×,
//       2×, 4× under heavy, fast compression, and the CPU of each.
//   [7] §10.8 Stereo link (Linked mode): left-only drive, the same control on
//       both channels; a silent channel stays EXACTLY silent under GR swings.
//   [8] Mid/Side: M and S are processed independently (mono content never
//       moves S, side content never moves M, a quiet side keeps its level
//       under a loud mid — unlike Linked); the mode switch crossfades
//       (NEGATIVE CONTROL: a hard switch clicks).
//   [9] Stepped Time Constant: fades never step the gain; leaving an automatic
//       position folds its held bias (NEGATIVE CONTROL: dropping it steps).
//  [10] §10.10 Realtime safety and CPU: zero allocations in processBlock and
//       reset under churn (mode flips included), no subnormals after
//       loud-then-silence, the loop stable at extreme settings with no OS.
//  [11] Latency / PDC / bypass, the parameter surface and registration.
//  [12] Gentle leveling on a full-mix-style source at the defaults.

#include "audio/EffectChainManager.h"
#include "audio/VariMuCompressorCore.h"
#include "audio/XlethVariMuCompressorEffect.h"
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
#include <memory>
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
using Core     = comp::VariMuCompressorCore;
using Settings = Core::Settings;
using GC       = comp::IdentityGC;
using Bal      = comp::MultiRcBallistics;
using Tube     = comp::VariMuTube;
using Elem     = comp::PushPullVariMu;
using F670     = comp::Fairchild670;
using VmFx     = XlethVariMuCompressorEffect;

namespace
{

constexpr double kPi  = 3.14159265358979323846;
constexpr double kFs  = 48000.0;
constexpr float  kT   = VmFx::kThresholdDb;

float dbToAmp(float db) { return std::pow(10.0f, db / 20.0f); }
float ampToDb(float a)  { return 20.0f * std::log10(std::max(a, 1.0e-12f)); }

// The effect's core rate.
double coreRate() { return kFs * (1 << VmFx::kOversamplingOrder); }

struct CoreOpts
{
    int    position    = 4;
    bool   colour      = false;
    float  mismatch    = 1.0f;     // δ scale (0 = matched pair)
    bool   singleEnded = false;
    double manualToTau = F670::kManualToTau;
    comp::ChannelMode mode = comp::ChannelMode::Linked;
    int    branchesOverride = 0;   // > 0: force the network's branch count
};

Settings settingsFor(const CoreOpts& o)
{
    Settings s = comp::variMuSettings(o.position, o.manualToTau);
    if (o.branchesOverride > 0) s.bal.branches = o.branchesOverride;
    return s;
}

// Cores are ~100 kB (the stage's tables): heap, not stack.
std::unique_ptr<Core> makeCore(double fs, const CoreOpts& o, Core::Config cfg = comp::variMuConfig())
{
    auto core = std::make_unique<Core>(cfg);
    comp::wireVariMu(*core, kT);
    core->setColorEnabled(o.colour);
    core->gainElement().setMismatchScale(o.mismatch);
    core->gainElement().setSingleEndedForTest(o.singleEnded);
    core->setChannelMode(o.mode);
    core->prepare(fs, settingsFor(o));
    return core;
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

std::vector<float> square(int n, float amp, int periodSamples)
{
    std::vector<float> v(static_cast<size_t>(n));
    for (int i = 0; i < n; ++i)
        v[static_cast<size_t>(i)] = ((i / (periodSamples / 2)) % 2 == 0) ? amp : -amp;
    return v;
}

std::vector<float> sine(int n, float amp, double hz, double fs, int phase0 = 0)
{
    std::vector<float> v(static_cast<size_t>(n));
    for (int i = 0; i < n; ++i) v[static_cast<size_t>(i)] = amp * static_cast<float>(std::sin(2.0 * kPi * hz * (i + phase0) / fs));
    return v;
}

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
    for (int k = 2; k <= 9 && k * f0 < 0.45 * fs; ++k)
    {
        const double a = toneAmp(x, n, k * f0, fs);
        if (k == 2) h2 = a;
        if (k == 3) h3 = a;
        sum += a * a;
    }
    return { std::sqrt(sum) / h1, h2 / h1, h3 / h1 };
}

void processEffect(VmFx& fx, juce::AudioBuffer<float>& buf, int block)
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

// Settled static-curve point: a steady square at `lvl` (in-core dBFS) — |x| is
// constant, so the rectifier reads it exactly. Position 4: its RC divider
// τ_d/(τ_a + τ_d) is 1 − 8e-5, the pure curve.
float settledOutDb(float lvl, double fs)
{
    CoreOpts o;
    o.position = 4;
    auto core = makeCore(fs, o);
    auto x = square(static_cast<int>(fs * 0.4), dbToAmp(lvl), 96);
    runCore(*core, x, nullptr);
    // The output's crest over the last period: at deep GR the push-pull's
    // even-order residue makes the two polarities' plateaus differ slightly.
    float pk = 0.0f;
    for (size_t i = x.size() - 96; i < x.size(); ++i) pk = std::max(pk, std::abs(x[i]));
    return ampToDb(pk);
}

// Seconds of silence until the GR falls below `floorDb` (−1 if never within maxS).
double recoverySeconds(Core& core, double fs, float floorDb, double maxS)
{
    const float thr[1] = { kT }, mk[1] = { 0.0f };
    constexpr int B = 64;
    float buf[B];
    const int total = static_cast<int>(maxS * fs);
    for (int s = 0; s < total; s += B)
    {
        for (int i = 0; i < B; ++i) buf[i] = 0.0f;
        for (int i = 0; i < B; ++i)
        {
            core.process(buf + i, buf + i, 1, thr, mk, 1);
            if (core.getGainReductionDb() < floorDb) return (s + i + 1) / fs;
        }
    }
    return -1.0;
}

// Input level (in-core dBFS) whose static GR is `grDb`.
float levelForGr(float grDb)
{
    float lo = kT - 10.0f, hi = kT + 80.0f;
    for (int i = 0; i < 60; ++i)
    {
        const float x = 0.5f * (lo + hi);
        (x - GC::outputDb(x, kT, {}) > grDb ? hi : lo) = x;
    }
    return 0.5f * (lo + hi);
}

} // namespace

// ─── [1] Model pieces ────────────────────────────────────────────────────────

static void testModelPieces()
{
    std::cout << "\n[1] model pieces: stage curve, diode knee, ballistics, element, no thump\n";

    // The stage's GR curve.
    float s0 = 0.0f;
    CHECK(Tube::grDb(0.0f, s0) == 0.0f, "GR is exactly 0 dB at rest");
    bool mono = true;
    float worstSlope = 0.0f, worstForm = 0.0f, prev = -1.0f;
    for (float c = 0.0f; c < 2.19f; c += 0.005f)
    {
        float s;
        const float g = Tube::grDb(c, s);
        mono = mono && g > prev;
        prev = g;
        const double e = 1e-4;
        const double fd = (-20.0 * std::log10(Tube::stageGain(c + e)) + 20.0 * std::log10(Tube::stageGain(std::max(0.0, c - e)))) / (c + e - std::max(0.0, c - e));
        worstSlope = std::max(worstSlope, static_cast<float>(std::abs(s - fd) / std::max(1.0, fd)));
        const float exact = static_cast<float>(-20.0 * std::log10(Tube::stageGain(c)));
        worstForm = std::max(worstForm, std::abs(g - exact));
    }
    CHECK(worstForm < 1e-3f, "the per-sample GR form matches the stage curve (worst " << worstForm << " dB)");
    float sMax;
    CHECK(mono, "GR rises monotonically with the control voltage");
    CHECK(worstSlope < 2e-3f, "dGR/dc is exact (worst relative error " << worstSlope << ")");
    CHECK(std::abs(Tube::grDb(3.0f, sMax) - Tube::kMaxGrDb) < 1e-4f && sMax == 0.0f, "cut off: the feedthrough floor, " << Tube::kMaxGrDb << " dB");
    float sA, sB, sC, sD;
    const float gA = Tube::grDb(0.3f, sA), gB = Tube::grDb(1.3f, sB), gC = Tube::grDb(2.0f, sC), gD = Tube::grDb(2.15f, sD);
    std::printf("    stage: GR 0.3/1.3/2.0/2.15 V_th = %.2f/%.2f/%.2f/%.2f dB, dB per V_th %.1f/%.1f/%.1f/%.1f (rest %.2f)\n",
                gA, gB, gC, gD, sA, sB, sC, sD, Tube::kRestSlope);
    CHECK(Tube::kRestSlope < sA && sA < sB && sB < sC && sC < sD, "flat at rest, steepening toward cutoff (the ratio's source)");

    // The rectifier: zero below the diode turn-on, C1 knee.
    float d1, d2;
    CHECK(GC::rectify(kT - 6.0f, kT, d1) == 0.0f && d1 == 0.0f, "no conduction well below the threshold bias");
    const float onDb = 20.0f * std::log10(1.0f - GC::kDiodeKnee), topDb = 20.0f * std::log10(1.0f + GC::kDiodeKnee);
    const float r1 = GC::rectify(kT + onDb + 1e-3f, kT, d1), r2 = GC::rectify(kT + topDb - 1e-3f, kT, d2);
    float d3;
    const float r3 = GC::rectify(kT + topDb + 1e-3f, kT, d3);
    CHECK(r1 < 1e-5f && d1 < 1e-2f, "the diode knee starts at zero value and zero slope");
    CHECK(std::abs(r2 - r3) < 1e-3f && std::abs(d2 - d3) < 1e-2f * d3, "and meets the linear rectifier C1");

    // Ballistics: predict() nondecreasing in the drive, derivative exact. At a
    // LOW rate: at the core rate a slow branch moves ~1e-5 V_th per sample, a
    // GR change below float resolution for a finite difference (the Opto's
    // lesson).
    {
        const double fs = 400.0;
        const auto st6 = comp::variMuSettings(6);
        const auto c = Bal::makeCoeffs(st6.bal, fs);
        Bal::State s;
        s.v[0] = 0.8f; s.v[1] = 1.1f; s.v[2] = 0.3f; s.rho = 0.9f;
        float prevGr = -1.0f, worstD = 0.0f;
        int nonMono = 0;
        for (float r = 0.0f; r < 3.0f; r += 0.001f)
        {
            float d;
            const float gr = Bal::predict(s, c, r, d);
            if (gr < prevGr - 1e-6f) ++nonMono;
            prevGr = gr;
            // Central difference, only where both neighbours share the regime
            // (no diode or branch switch inside ±h — a kink has no derivative).
            float dm, dp;
            const float h = 1e-3f;
            const float gp = Bal::predict(s, c, r + h, dp), gm = Bal::predict(s, c, std::max(0.0f, r - h), dm);
            if (r > h && std::abs(dp - d) < 0.01f * std::abs(d) + 1e-9f && std::abs(dm - d) < 0.01f * std::abs(d) + 1e-9f)
                worstD = std::max(worstD, std::abs((gp - gm) / (2.0f * h) - d) / std::max(1e-3f, std::abs(d)));
        }
        CHECK(nonMono == 0, "predict() is nondecreasing in the drive");
        CHECK(worstD < 2e-2f, "predict()'s derivative matches a finite difference (worst " << worstD << ")");
    }

    // The push-pull element.
    auto elem = std::make_unique<Elem>();
    elem->setThresholdDb(kT);
    elem->prepare(coreRate());
    float worstSs = 0.0f, worstRt = 0.0f;
    // The table resolves the curve through 40 dB of GR; past that the bias is
    // within ~2 table cells (2e-3 V_th) of the final cutoff, where A ∝ √ and a
    // cubic cell cannot follow it. 40 dB of GR needs ≈ +45 dBFS in the core —
    // beyond Input's range on a full-scale source — so that is reported only.
    float worstDeep = 0.0f;
    for (float gr = 0.0f; gr <= 45.0f; gr += 0.25f)
    {
        const float c = elem->gainFor(gr);
        float s;
        worstRt = std::max(worstRt, std::abs(Tube::grDb(c, s) - gr));
        const float x = 1e-4f;   // small signal
        const float g = (elem->apply(x, c, 0) - elem->apply(-x, c, 0)) / (2.0f * x);
        (gr <= 40.0f ? worstSs : worstDeep) = std::max(gr <= 40.0f ? worstSs : worstDeep, std::abs(ampToDb(g) + gr));
    }
    std::printf("    element: GR -> control voltage -> GR round trip worst %.2e dB; small-signal gain vs GR worst %.2e dB "
                "through 40 dB (%.2f dB at 40..45)\n", worstRt, worstSs, worstDeep);
    CHECK(worstRt < 2e-3f, "gainFor() inverts the stage curve");
    CHECK(worstSs < 5e-3f, "the element's small-signal gain IS the fitted curve (0..40 dB)");

    // At rest the stage is transparent (the tube's curvature is tiny at the
    // threshold-level grid swing).
    {
        std::vector<float> x = sine(9600, dbToAmp(kT - 6.0f), 1000.0, 96000.0);
        double err = 0.0, ref = 0.0;
        for (float v : x)
        {
            const double y = elem->apply(v, 0.0f, 0);
            err += (y - v) * (y - v);
            ref += static_cast<double>(v) * v;
        }
        const float errDb = 10.0f * std::log10(static_cast<float>(err / ref));
        std::printf("    at rest, %.0f dBFS sine: element error %.1f dB re signal\n", kT - 6.0f, errDb);
        CHECK(errDb < -100.0f, "at rest the push-pull stage is transparent (< -100 dB)");
    }

    // No thump: with no signal both halves read F(−c) and cancel exactly, for
    // every control voltage — mismatch or not. Single-ended, the plate current
    // itself moves with the bias: a full-scale-sized DC step.
    bool silent = true;
    for (float c = 0.0f; c <= 2.3f; c += 0.01f) silent = silent && elem->apply(0.0f, c, 0) == 0.0f;
    CHECK(silent, "push-pull: the common-mode control voltage cancels EXACTLY (no thump)");
    elem->setSingleEndedForTest(true);
    const float thump = std::abs(elem->apply(0.0f, elem->gainFor(10.0f), 0));
    elem->setSingleEndedForTest(false);
    std::printf("    single-ended, 0 -> 10 dB of GR on silence: DC step %.1f dBFS\n", ampToDb(thump));
    CHECK(thump > 1.0f, "NEGATIVE CONTROL: single-ended, the control voltage itself reaches the output (> 0 dBFS DC)");
}

// ─── [2] Static curve ────────────────────────────────────────────────────────

static void testStaticCurve()
{
    std::cout << "\n[2] static curve: the ratio rises with level, the widest knee\n";
    const double fs = coreRate();
    struct Pt { float x, y; };
    std::vector<Pt> pts;
    float worstEq = 0.0f;
    // The loop's sidechain sees the stage's actual (large-signal) output, so it
    // settles on the element's large-signal equilibrium; that equals the
    // small-signal one (GC::outputDb) until the grid swing reaches the cutoff.
    auto elem = std::make_unique<Elem>();
    elem->setThresholdDb(kT);
    elem->prepare(fs);
    float worstSmall = 0.0f;
    // To +46 dB over the threshold: Input +36 on a full-scale peak (≈36 dB of GR).
    for (float x = kT - 8.0f; x <= kT + 46.0f; x += 0.25f)
    {
        const float y = settledOutDb(x, fs);
        worstEq = std::max(worstEq, std::abs(y - elem->staticOutputDb(x, kT)));
        if (x - y <= 25.0f) worstSmall = std::max(worstSmall, std::abs(y - GC::outputDb(x, kT, {})));
        pts.push_back({ x, y });
    }
    std::printf("    settled output vs the large-signal equilibrium: worst %.3f dB; vs the small-signal one through 25 dB of GR: %.3f dB\n",
                worstEq, worstSmall);
    CHECK(worstEq < 0.05f, "the loop settles on the stage's equilibrium curve (worst " << worstEq << " dB)");
    CHECK(worstSmall < 0.05f, "…which is the small-signal curve through 25 dB of GR (worst " << worstSmall << " dB)");
    bool neverFalls = true;
    for (size_t i = 1; i < pts.size(); ++i) neverFalls = neverFalls && pts[i].y >= pts[i - 1].y - 1e-4f;
    CHECK(neverFalls, "a feedback limiter never over-compresses: the output never falls as the input rises (to ≈36 dB of GR)");

    // Local ratio = dx/dy over ±0.5 dB, reported against the GR there.
    auto ratioAt = [&](size_t i) {
        const size_t a = i >= 2 ? i - 2 : 0, b = std::min(pts.size() - 1, i + 2);
        return (pts[b].x - pts[a].x) / std::max(1e-6f, pts[b].y - pts[a].y);
    };
    const float grMarks[] = { 1.0f, 3.0f, 6.0f, 10.0f, 15.0f, 20.0f, 25.0f, 30.0f };
    float rAt[8] {};
    std::printf("    GR dB :");
    for (float g : grMarks) std::printf(" %6.0f", g);
    std::printf("\n    ratio :");
    for (int k = 0; k < 8; ++k)
    {
        size_t i = 0;
        while (i + 1 < pts.size() && pts[i].x - pts[i].y < grMarks[k]) ++i;
        rAt[k] = ratioAt(i);
        std::printf(" %6.1f", rAt[k]);
    }
    std::printf("\n");
    CHECK(rAt[0] > 1.1f && rAt[0] < 2.0f, "gentle at the first dB of GR (" << rAt[0] << ":1)");
    CHECK(rAt[1] > 1.8f && rAt[1] < 2.8f, "≈2:1 at 3 dB of GR (" << rAt[1] << ":1)");
    CHECK(rAt[7] > 22.0f, "toward ≈30:1 in deep limiting (" << rAt[7] << ":1 at 30 dB)");
    bool rising = true;
    for (int k = 1; k < 8; ++k) rising = rising && rAt[k] > rAt[k - 1];
    CHECK(rising, "no fixed ratio: it rises with the amount of limiting");

    // Knee: the input span over which the slope turns from 0.9 to 0.25 (the
    // FET's widest, 4:1, knee is 10 dB of Giannoulis curve), and smoothness.
    float x09 = 0.0f, x025 = 0.0f, worstStep = 0.0f, prevSlope = 1.0f;
    for (size_t i = 1; i < pts.size(); ++i)
    {
        const float sl = (pts[i].y - pts[i - 1].y) / (pts[i].x - pts[i - 1].x);
        if (i > 1) worstStep = std::max(worstStep, std::abs(sl - prevSlope));
        prevSlope = sl;
        if (x09 == 0.0f && sl < 0.9f) x09 = pts[i].x;
        if (x025 == 0.0f && sl < 0.25f) x025 = pts[i].x;
    }
    std::printf("    slope 0.9 at %.1f dBFS, 0.25 at %.1f dBFS: knee %.1f dB wide; largest slope step per 0.25 dB %.3f\n",
                x09, x025, x025 - x09, worstStep);
    CHECK(x025 - x09 > 12.0f, "the widest knee of the four (> 12 dB; FET 4:1 is 10)");
    CHECK(worstStep < 0.06f, "no corner anywhere on the curve (diode knee included)");
    CHECK(x09 > kT - 4.0f && x09 < kT + 3.0f, "the curve turns at the in-core threshold level");

    // NEGATIVE CONTROL: the same rectifier and loop with an exactly log-linear
    // g_m (constant dB per volt, fitted to the same 3 dB point) cannot reach
    // the §5.2 ratios: R = R0 + 0.115·GR.
    {
        float s3;
        Tube::grDb(0.5f, s3);
        const float slope = s3;   // dB per V_th, the curve's own slope near 3 dB of GR
        auto outLL = [&](float x) {
            float lo = x - 60.0f, hi = x;
            for (int i = 0; i < 60; ++i)
            {
                const float y = 0.5f * (lo + hi);
                float d;
                const float gr = slope * GC::rectify(y, kT, d);
                (y - (x - gr) > 0.0f ? hi : lo) = y;
            }
            return 0.5f * (lo + hi);
        };
        float rLL = 0.0f;
        for (float x = kT; x < kT + 80.0f; x += 0.1f)
        {
            if (x - outLL(x) >= 30.0f) { rLL = 0.2f / (outLL(x + 0.1f) - outLL(x - 0.1f)); break; }
        }
        std::printf("    NEGATIVE CONTROL log-linear g_m (%.1f dB/V_th): ratio at 30 dB of GR %.1f:1\n", slope, rLL);
        CHECK(rLL > 0.0f && rLL < 8.0f, "NEGATIVE CONTROL: a log-linear g_m stays below 8:1 at 30 dB of GR");
    }

    // Input drives the curve (the effect has no threshold): more Input, more GR.
    float grPrev = -1.0f;
    bool more = true;
    for (float in : { -6.0f, 0.0f, 6.0f, 12.0f, 18.0f })
    {
        VmFx fx;
        fx.prepareToPlay(kFs, 512);
        fx.setParameterValue("input", in);
        fx.setParameterValue("time_constant", 4.0f);
        fx.prepareToPlay(kFs, 512);
        juce::AudioBuffer<float> b(2, static_cast<int>(kFs * 0.6));
        for (int i = 0; i < b.getNumSamples(); ++i)
        {
            const float v = dbToAmp(kT) * static_cast<float>(std::sin(2.0 * kPi * 440.0 * i / kFs));
            b.setSample(0, i, v);
            b.setSample(1, i, v);
        }
        processEffect(fx, b, 512);
        const float gr = fx.getCore().getGainReductionDb();
        std::printf("    Input %+5.1f dB on a threshold-level tone: GR %.2f dB\n", in, gr);
        more = more && gr > grPrev;
        grPrev = gr;
    }
    CHECK(more, "more Input = more gain reduction (Input drives the curve)");
}

// ─── [3] Program dependence (positions 5 and 6) ──────────────────────────────

struct Recovery { double single, train, sustained; float grEnd[3]; };

static Recovery recoveries(const CoreOpts& o)
{
    const double fs = coreRate();
    const float amp = dbToAmp(levelForGr(10.0f));
    Recovery r {};
    for (int kind = 0; kind < 3; ++kind)
    {
        auto core = makeCore(fs, o);
        std::vector<float> x;
        auto burst = [&](double s) { auto b = sine(static_cast<int>(s * fs), amp, 1000.0, fs); x.insert(x.end(), b.begin(), b.end()); };
        auto gap   = [&](double s) { x.insert(x.end(), static_cast<size_t>(s * fs), 0.0f); };
        if (kind == 0) burst(0.020);
        else if (kind == 1) for (int k = 0; k < 20; ++k) { gap(0.180); burst(0.020); }   // 4 s of peaks at 5 Hz
        else burst(12.0);
        runCore(*core, x, nullptr);
        r.grEnd[kind] = core->getGainReductionDb();
        const double t = recoverySeconds(*core, fs, 0.2f, 60.0);
        (kind == 0 ? r.single : kind == 1 ? r.train : r.sustained) = t;
    }
    return r;
}

static void testProgramDependence()
{
    std::cout << "\n[3] program dependence: single peak / peak train / sustained, recovery to 0.2 dB from ~10 dB\n";
    for (int pos : { 5, 6 })
    {
        CoreOpts o;
        o.position = pos;
        const Recovery r = recoveries(o);
        const auto& p = F670::kPositions[static_cast<size_t>(pos - 1)];
        std::printf("    position %d: single %.2f s (manual %.1f) | train %.2f s | sustained %.2f s (manual %.0f / %.0f)   [GR at end %.1f/%.1f/%.1f]\n",
                    pos, r.single, p.recoveryS[0], r.train, r.sustained, p.recoveryS[1], p.recoveryS[2], r.grEnd[0], r.grEnd[1], r.grEnd[2]);
        CHECK(std::abs(r.single - p.recoveryS[0]) < 0.25 * p.recoveryS[0], "pos " << pos << ": an individual peak recovers in the manual's time");
        CHECK(r.train > 2.5 * r.single, "pos " << pos << ": a peak TRAIN releases slower (" << r.train / r.single << "x)");
        CHECK(r.sustained > r.train, "pos " << pos << ": sustained program releases slowest");
        if (pos == 5)
            CHECK(std::abs(r.sustained - 10.0) < 2.5, "pos 5: sustained program recovers in the manual's 10 s");
        else
        {
            CHECK(std::abs(r.train - 10.0) < 3.0, "pos 6: a peak train recovers in the manual's 10 s");
            CHECK(std::abs(r.sustained - 25.0) < 5.0, "pos 6: consistently high program recovers in the manual's 25 s");
        }

        // NEGATIVE CONTROL: the same position's individual-peak branch alone —
        // a fixed release.
        CoreOpts f = o;
        f.branchesOverride = 1;
        const Recovery rf = recoveries(f);
        std::printf("      fixed release (branch 0 only): single %.2f s | train %.2f s | sustained %.2f s\n", rf.single, rf.train, rf.sustained);
        CHECK(!(rf.train > 2.5 * rf.single), "NEGATIVE CONTROL pos " << pos << ": with a fixed release the train does NOT release slower ("
              << rf.train / rf.single << "x)");
    }
}

// ─── [4] Ballistics and the §1.3 normalisation ───────────────────────────────

// 63 % time of a branch-0 RC at `fs` for position `pos`: charge (drive 1 from
// empty) or drain (from charged, drive 0), in seconds.
static double rcTime63(int pos, double fs, bool attack, double manualToTau)
{
    const auto c = Bal::makeCoeffs(comp::variMuSettings(pos, manualToTau).bal, fs);
    Bal::State s;
    if (!attack)
    {
        s.v[0] = 1.0f;
        s.rho = 0.0f;
    }
    // While charging the cap settles at ρ·τ_d/(τ_c + τ_d): the 63 % point of
    // that settle is the charge τ (of the parallel network, τ_c·τ_d/(τ_c+τ_d)).
    const double tc = 1.0 / c.cap[0].wA, td = 1.0 / c.cap[0].wR;   // in samples
    const double target = attack ? (1.0 - std::exp(-1.0)) * td / (tc + td) : std::exp(-1.0);
    const float drive = attack ? 1.0f : 0.0f;
    float prevV = s.v[0];
    for (int i = 0; i < static_cast<int>(fs * 30.0); ++i)
    {
        Bal::commit(s, c, drive);
        const float v = s.v[0];
        if (attack ? (v >= target && prevV < target) : (v <= target && prevV > target))
            return (i + (target - prevV) / (v - prevV)) / fs;
        prevV = v;
    }
    return -1.0;
}

static void testBallistics()
{
    std::cout << "\n[4] ballistics: RC tau = manual / 3 at the oversampled rate; the loop recovers in the manual's time\n";
    const double fs = coreRate();
    float worstA = 0.0f, worstR = 0.0f;
    for (int pos = 1; pos <= 6; ++pos)
    {
        const auto& p = F670::kPositions[static_cast<size_t>(pos - 1)];
        const double tauA = p.attackMs * 1e-3 / 3.0, tauR = p.recoveryS[0] / 3.0;
        const double a = rcTime63(pos, fs, true, F670::kManualToTau), r = rcTime63(pos, fs, false, F670::kManualToTau);
        // the trapezoid sees a sampled step as a ramp across its first sample: ½ sample late
        const double aAdj = a - 0.5 / fs;
        const double tauAParallel = tauA * tauR / (tauA + tauR);
        worstA = std::max(worstA, static_cast<float>(std::abs(aAdj - tauAParallel) / tauAParallel));
        worstR = std::max(worstR, static_cast<float>(std::abs(r - tauR) / tauR));
        std::printf("    position %d: attack RC %.1f us (manual %.1f ms / 3 = %.1f us), release RC %.4f s (manual %.1f s / 3 = %.4f s)\n",
                    pos, aAdj * 1e6, p.attackMs, tauA * 1e6, r, p.recoveryS[0], tauR);
    }
    CHECK(worstA < 0.02f, "the attack RC is the manual's figure / 3 within 2 % (worst " << worstA << ")");
    CHECK(worstR < 0.002f, "the release RC is the manual's figure / 3 within 0.2 % (worst " << worstR << ")");

    // Rate invariance: the coefficients are computed at the rate they run.
    const double r96 = rcTime63(4, 96000.0, false, F670::kManualToTau), r192 = rcTime63(4, 192000.0, false, F670::kManualToTau);
    CHECK(std::abs(r96 - r192) < 1e-3 * r96, "RC time constants are rate-invariant (computed at the oversampled rate)");

    // The closed loop from 10 dB of GR: recovery to 0.2 dB ("near-complete")
    // against the manual's figure — with the normalisation, and without it.
    const float amp = dbToAmp(levelForGr(10.0f));
    float worstNorm = 0.0f, bestRaw = 1e9f;
    for (int pos = 1; pos <= 4; ++pos)
    {
        double rec[2];
        for (int k = 0; k < 2; ++k)
        {
            CoreOpts o;
            o.position = pos;
            o.manualToTau = k == 0 ? F670::kManualToTau : 1.0;
            auto core = makeCore(fs, o);
            auto x = sine(static_cast<int>(fs * 1.0), amp, 1000.0, fs);
            runCore(*core, x, nullptr);
            rec[k] = recoverySeconds(*core, fs, 0.2f, 60.0);
        }
        const double man = F670::kPositions[static_cast<size_t>(pos - 1)].recoveryS[0];
        worstNorm = std::max(worstNorm, static_cast<float>(std::abs(rec[0] - man) / man));
        bestRaw = std::min(bestRaw, static_cast<float>(std::abs(rec[1] - man) / man));
        std::printf("    position %d: recovery 10 -> 0.2 dB %.2f s (manual %.1f s); un-normalised %.2f s\n", pos, rec[0], man, rec[1]);
    }
    CHECK(worstNorm < 0.15f, "with manual / 3, the loop recovers in the manual's time (worst " << worstNorm * 100 << " % off)");
    CHECK(bestRaw > 1.0f, "NEGATIVE CONTROL: un-normalised constants miss every manual recovery time by > 100 % (best " << bestRaw * 100 << " % off)");

    // Attack in the loop: a +10 dB step onto a threshold-level tone — "the full
    // limiting effect within the first 1/10,000 of a second" (§5.2), for the
    // 0.2 ms positions; about twice that for the 0.4 ms ones.
    for (int pos : { 1, 3 })
    {
        CoreOpts o;
        o.position = pos;
        auto core = makeCore(fs, o);
        const int n0 = static_cast<int>(fs * 0.5), n1 = static_cast<int>(fs * 0.3);
        auto x = sine(n0, dbToAmp(kT), 1000.0, fs);
        runCore(*core, x, nullptr);
        auto y = square(n1, dbToAmp(levelForGr(12.0f)), 96);   // |x| steady: GR is not rippled by the waveform
        std::vector<float> gr;
        runCore(*core, y, nullptr, 0.0f, &gr);
        const float fin = gr.back();
        int i90 = 0;
        while (i90 < n1 && gr[static_cast<size_t>(i90)] < 0.9f * fin) ++i90;
        const double us = i90 / fs * 1e6;
        std::printf("    position %d: +12 dB step -> 90 %% of %.1f dB GR in %.0f us\n", pos, fin, us);
        if (pos == 1) CHECK(us < 150.0, "0.2 ms positions: full limiting within ~1/10,000 s");
        else          CHECK(us < 300.0, "0.4 ms positions: within ~2/10,000 s");
    }
}

// ─── [5] THD vs gain reduction ───────────────────────────────────────────────

static Thd elementThd(float grDb, const CoreOpts& base, float* grOut = nullptr)
{
    const double fs = coreRate();
    CoreOpts o = base;
    o.position = 4;   // the slowest single-RC release: no audio-rate GR ripple
    auto core = makeCore(fs, o);
    const double f0 = 1000.0;
    auto x = sine(static_cast<int>(fs * 1.5), dbToAmp(levelForGr(grDb)), f0, fs);
    runCore(*core, x, nullptr);
    if (grOut) *grOut = core->getGainReductionDb();
    const int n = static_cast<int>(fs / f0) * 200;
    return measureThd(x.data() + (x.size() - static_cast<size_t>(n)), n, f0, fs);
}

static void testThdVsGr()
{
    std::cout << "\n[5] THD vs gain reduction (element only, 1 kHz, position 4)\n";
    const float grs[] = { 3.0f, 6.0f, 10.0f, 15.0f, 20.0f, 25.0f, 30.0f, 35.0f };
    constexpr int K = 8;
    Thd t[K];
    std::printf("    GR dB  |  THD %%   H2 %%    H3 %%\n");
    for (int k = 0; k < K; ++k)
    {
        float gr;
        t[k] = elementThd(grs[k], CoreOpts{}, &gr);
        std::printf("    %5.1f  | %7.4f %7.4f %7.4f   (measured GR %.2f)\n", grs[k], 100 * t[k].thd, 100 * t[k].h2, 100 * t[k].h3, gr);
    }
    bool rising = true;
    for (int k = 1; k < K; ++k) rising = rising && t[k].thd > t[k - 1].thd;
    CHECK(rising, "THD RISES with gain reduction through the whole range");
    CHECK(t[0].thd < 2e-4, "gentle leveling (3 dB) leaves the stage clean (< 0.02 %)");
    CHECK(t[4].thd > 1e-4 && t[4].thd < 1e-3, "20 dB of limiting: 0.01..0.1 % (the stage is clean in its working range)");
    CHECK(t[6].thd > 1.5e-3, "30 dB — the swing nearing the final cutoff: > 0.15 %");
    CHECK(t[7].thd > 1e-2, "35 dB — slammed into cutoff: > 1 %");
    CHECK(t[7].thd > 30.0 * t[3].thd, "the tube's dirt is a deep-limiting effect (35 dB vs 15 dB: > 30x)");

    // Push-pull even-order cancellation, and the mismatch as the residue.
    CoreOpts matched;
    matched.mismatch = 0.0f;
    CoreOpts se;
    se.singleEnded = true;
    const Thd tm = elementThd(15.0f, matched), tp = elementThd(15.0f, CoreOpts{});
    std::printf("    15 dB of GR: H2 push-pull (5 %% mismatch) %.5f %%, matched pair %.2e %%\n", 100 * tp.h2, 100 * tm.h2);
    CHECK(tm.h2 < 0.02 * tp.h2, "NEGATIVE CONTROL: a matched pair cancels the 2nd harmonic (the mismatch IS the residue)");
    CHECK(std::abs(tm.h3 - tp.h3) < 0.2 * tp.h3, "…while the odd order is the curve's own, mismatch or not");

    // Single-ended: no cancellation (the stage alone, silence-referenced).
    {
        const double fs = coreRate();
        auto elem = std::make_unique<Elem>();
        elem->setThresholdDb(kT);
        elem->prepare(fs);
        const float c = elem->gainFor(15.0f);
        const int n = static_cast<int>(fs / 1000.0) * 50;
        auto x = sine(n, dbToAmp(levelForGr(15.0f)), 1000.0, fs);
        std::vector<float> pp(x.size()), sgl(x.size());
        for (size_t i = 0; i < x.size(); ++i) pp[i] = elem->apply(x[i], c, 0);
        elem->setSingleEndedForTest(true);
        for (size_t i = 0; i < x.size(); ++i) sgl[i] = elem->apply(x[i], c, 0);
        const Thd a = measureThd(pp.data(), n, 1000.0, fs), b = measureThd(sgl.data(), n, 1000.0, fs);
        std::printf("    15 dB, static bias: H2 push-pull %.4f %% vs single-ended %.4f %%\n", 100 * a.h2, 100 * b.h2);
        CHECK(b.h2 > 10.0 * a.h2, "NEGATIVE CONTROL: single-ended, the even order is > 10x the push-pull residue");
    }

    // The whole effect (line amp + transformer in) at gentle leveling.
    {
        VmFx fx;
        fx.prepareToPlay(kFs, 480);
        fx.setParameterValue("time_constant", 4.0f);
        fx.prepareToPlay(kFs, 480);
        const float in = dbToAmp(levelForGr(3.0f));
        juce::AudioBuffer<float> b(2, static_cast<int>(kFs * 1.5));
        for (int i = 0; i < b.getNumSamples(); ++i)
        {
            const float v = in * static_cast<float>(std::sin(2.0 * kPi * 1000.0 * i / kFs));
            b.setSample(0, i, v);
            b.setSample(1, i, v);
        }
        processEffect(fx, b, 480);
        const int n = 48 * 400;
        const Thd e = measureThd(b.getReadPointer(0) + (b.getNumSamples() - n), n, 1000.0, kFs);
        std::printf("    whole effect at %.1f dB of GR: THD %.3f %% (H2 %.3f %%, H3 %.3f %%)\n", fx.getCore().getGainReductionDb(), 100 * e.thd, 100 * e.h2, 100 * e.h3);
        CHECK(e.thd < 5e-3, "whole effect at gentle leveling: < 0.5 % THD (the tube line amp's colour)");
        CHECK(e.h2 > e.h3, "…2nd-harmonic led");
    }
}

// ─── [6] Aliasing and the oversampling factor ────────────────────────────────

static float inharmonicDb(const float* x, int n, int cycles)
{
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

// The effect's chain (up → core → down) at an arbitrary oversampling order,
// stereo-identical input. CoreT lets a test swap a policy (the rectifier).
template <class CoreT>
struct OsChainT
{
    std::unique_ptr<CoreT> core;
    std::unique_ptr<dsp::Oversampler> os;
    std::vector<float> thr, mk;
    OsChainT(int ord, int position, float makeupDb) : thr(512, kT), mk(512, makeupDb)
    {
        typename CoreT::Config cfg;
        cfg.sidechainHpf = false;
        core = std::make_unique<CoreT>(cfg);
        comp::wireVariMu(*core, kT);
        const auto vs = comp::variMuSettings(position);
        typename CoreT::Settings st;
        st.gc = vs.gc;
        st.bal = vs.bal;
        st.topology = vs.topology;
        core->prepare(kFs * (1 << ord), st);
        os = std::make_unique<dsp::Oversampler>(2, ord);
        os->prepare(512);
    }
    void run(juce::AudioBuffer<float>& b)
    {
        for (int s = 0; s < b.getNumSamples(); s += 512)
        {
            const int n = std::min(512, b.getNumSamples() - s);
            float* ch[2] = { b.getWritePointer(0, s), b.getWritePointer(1, s) };
            juce::dsp::AudioBlock<float> host(ch, 2, static_cast<size_t>(n));
            auto up = os->processUp(host);
            core->process(up.getChannelPointer(0), up.getChannelPointer(1), static_cast<int>(up.getNumSamples()),
                          thr.data(), mk.data(), os->getFactor());
            os->processDown(host);
        }
    }
};
using OsChain = OsChainT<Core>;
// The same model with the FET's parabola-fit rectifier (a negative control).
using ParabolaCore = comp::CompressorCore<comp::RcRectifier, comp::IdentityGC, comp::MultiRcBallistics,
                                          comp::PushPullVariMu, comp::TubeTransformerColor>;

constexpr int kAliasN = 16384;
const int kAliasCycles[] = { 1024, 2389, 3413, 4437, 5461, 6485 };   // 3 .. 19 kHz at 48 kHz

// The tube waveshaping alone — the push-pull stage at a FIXED bias for `grDb`
// and the line amp — driven by the input level that produces that GR, at
// oversampling order `ord`: the folded-harmonic floor with no loop at all.
static float staticFoldDb(int ord, float grDb, int cyc)
{
    const double fs = kFs * (1 << ord), f0 = cyc * kFs / kAliasN;
    auto elem = std::make_unique<Elem>();
    elem->setThresholdDb(kT);
    elem->prepare(fs);
    comp::TubeTransformerColor col;
    col.setHeadroomDb(comp::kVariMuLineAmpHeadroomDb);
    col.prepare(fs);
    const float c = elem->gainFor(grDb);
    const float x = dbToAmp(levelForGr(grDb));
    const float mk = dbToAmp(grDb) * 0.5f / x;   // the stage's output back to −6 dBFS into the line amp
    dsp::Oversampler os(2, ord);
    os.prepare(512);
    const int n = kAliasN * 3;
    juce::AudioBuffer<float> b(2, n);
    for (int i = 0; i < n; ++i)
    {
        const float v = x * static_cast<float>(std::sin(2.0 * kPi * f0 * i / kFs));
        b.setSample(0, i, v);
        b.setSample(1, i, v);
    }
    for (int s = 0; s < n; s += 512)
    {
        float* ch[2] = { b.getWritePointer(0, s), b.getWritePointer(1, s) };
        juce::dsp::AudioBlock<float> host(ch, 2, 512);
        auto up = os.processUp(host);
        float* u0 = up.getChannelPointer(0);
        float* u1 = up.getChannelPointer(1);
        for (size_t i = 0; i < up.getNumSamples(); ++i)
            u1[i] = u0[i] = col.process(elem->apply(u0[i], c, 0) * mk, 0);
        os.processDown(host);
    }
    return inharmonicDb(b.getReadPointer(0) + (n - kAliasN), kAliasN, cyc);
}

// The whole compressor (loop included) at order `ord` on a tone whose static
// GR is `grDb`.
template <class CoreT>
static float loopFoldDb(int ord, int position, float grDb, int cyc)
{
    const double f0 = cyc * kFs / kAliasN;
    OsChainT<CoreT> ch(ord, position, -grDb);
    const int n = kAliasN * 3;
    juce::AudioBuffer<float> b(2, n);
    const float amp = dbToAmp(levelForGr(grDb));
    for (int i = 0; i < n; ++i)
    {
        const float v = amp * static_cast<float>(std::sin(2.0 * kPi * f0 * i / kFs));
        b.setSample(0, i, v);
        b.setSample(1, i, v);
    }
    ch.run(b);
    return inharmonicDb(b.getReadPointer(0) + (n - kAliasN), kAliasN, cyc);
}

static void testAliasing()
{
    std::cout << "\n[6] aliasing and the oversampling factor (tones 3..19 kHz at 48 kHz)\n";

    // (a) The tube waveshaping's own folding floor, 1x / 2x / 4x.
    float worst[4][3];   // [gr idx][order]
    const float grs[] = { 10.0f, 20.0f, 30.0f, 35.0f };
    std::printf("    static bias (no loop)   inharmonic dBc, worst over the sweep: 1x      2x      4x\n");
    for (int g = 0; g < 4; ++g)
    {
        for (int ord = 0; ord < 3; ++ord)
        {
            worst[g][ord] = -300.0f;
            for (int cyc : kAliasCycles) worst[g][ord] = std::max(worst[g][ord], staticFoldDb(ord, grs[g], cyc));
        }
        std::printf("      at %2.0f dB of GR                                        %7.1f %7.1f %7.1f\n",
                    grs[g], worst[g][0], worst[g][1], worst[g][2]);
    }
    const int shipped = VmFx::kOversamplingOrder;
    CHECK(worst[1][0] > worst[1][shipped] + 30.0f, "NEGATIVE CONTROL: at 1x the tube stage folds > 30 dB worse (20 dB of GR)");
    CHECK(std::max(worst[0][shipped], std::max(worst[1][shipped], worst[2][shipped])) < -85.0f,
          "the shipped factor: folded products below -85 dBc through 30 dB of GR");
    CHECK(worst[3][2] < worst[3][1] - 8.0f, "slammed (35 dB of GR, the swing reaching cutoff): 4x folds > 8 dB less than 2x — why 4x ships");

    // (b) The whole compressor — the loop's gain modulation included — at the
    // fastest position, 20 dB of GR; and the rectifier's peak fit.
    float loopWorst = -300.0f;
    std::printf("    whole compressor, position 1, 20 dB GR, shipped factor:");
    for (int cyc : kAliasCycles)
    {
        const float a = loopFoldDb<Core>(shipped, 1, 20.0f, cyc);
        std::printf(" %.1f", a);
        if (cyc * kFs / kAliasN < 16500.0) loopWorst = std::max(loopWorst, a);
    }
    std::printf(" dBc\n");
    CHECK(loopWorst < -60.0f, "whole compressor at 20 dB of GR: inharmonic content below -60 dBc through 16 kHz");
    const float cos2 = loopFoldDb<Core>(1, 1, 20.0f, 5461), par2 = loopFoldDb<ParabolaCore>(1, 1, 20.0f, 5461);
    std::printf("    16 kHz at 2x: cosine-fit rectifier %.1f dBc, parabola-fit (the FET's) %.1f dBc\n", cos2, par2);
    CHECK(par2 > cos2 + 20.0f, "NEGATIVE CONTROL: with the parabola peak fit the loop follows its sampling-phase error (> 20 dB worse)");

}

static void testCpuFactors()
{
    std::cout << "\n[6c] CPU of each oversampling factor (core + oversampler)\n";
    const int shipped = VmFx::kOversamplingOrder;
    // CPU of each factor: core + oversampler, one stereo instance on loud
    // program, per 512-sample block.
    using clk = std::chrono::steady_clock;
    double us[3] {};
    for (int ord = 1; ord <= 2; ++ord)
    {
        OsChain ch(ord, 6, 0.0f);
        juce::AudioBuffer<float> b(2, 512);
        const float amp = dbToAmp(levelForGr(15.0f));
        const int reps = 400;
        for (int k = 0; k < reps + 20; ++k)
        {
            for (int c = 0; c < 2; ++c)
                for (int i = 0; i < 512; ++i)
                    b.setSample(c, i, amp * static_cast<float>(std::sin(2.0 * kPi * (c ? 220.0 : 330.0) * (k * 512 + i) / kFs)));
            const auto t0 = clk::now();
            ch.run(b);
            if (k >= 20) us[ord] += std::chrono::duration<double, std::micro>(clk::now() - t0).count();
        }
        us[ord] /= reps;
    }
    const double budget = 512 * 1e6 / kFs;
    std::printf("    CPU per stereo instance (core + oversampler): 2x %.1f us (%.2f %%), 4x %.1f us (%.2f %%) of a 512-sample block\n",
                us[1], 100 * us[1] / budget, us[2], 100 * us[2] / budget);
    CHECK(us[shipped] < 0.05 * budget, "the shipped factor costs < 5 % of a core");
}

// ─── [7] Stereo link ─────────────────────────────────────────────────────────

static void testStereoLink()
{
    std::cout << "\n[7] Linked: one control voltage for both channels; a silent channel stays silent\n";
    auto runSide = [&](int loudCh, juce::AudioBuffer<float>& out) -> float {
        VmFx fx;
        fx.prepareToPlay(kFs, 512);
        fx.setParameterValue("input", 18.0f);
        fx.setParameterValue("time_constant", 1.0f);
        fx.prepareToPlay(kFs, 512);
        const int m = static_cast<int>(kFs * 0.5);
        out.setSize(2, m);
        for (int i = 0; i < m; ++i)
        {
            out.setSample(loudCh, i, 0.5f * static_cast<float>(std::sin(2.0 * kPi * 220.0 * i / kFs)));
            out.setSample(1 - loudCh, i, 0.003f * static_cast<float>(std::sin(2.0 * kPi * 3000.0 * i / kFs)));
        }
        processEffect(fx, out, 512);
        return fx.readMeterValue(2);
    };
    juce::AudioBuffer<float> a, b;
    const float grA = runSide(0, a), grB = runSide(1, b);
    bool mirrored = true;
    for (int i = 0; i < a.getNumSamples() && mirrored; ++i)
        mirrored = a.getSample(0, i) == b.getSample(1, i) && a.getSample(1, i) == b.getSample(0, i);
    const int w = static_cast<int>(kFs * 0.1);
    const float quietIn = 0.003f * dbToAmp(18.0f);
    const float quietOut = static_cast<float>(toneAmp(a.getReadPointer(1) + (a.getNumSamples() - w), w, 3000.0, kFs));
    std::printf("    GR meter left-driven %.3f / right-driven %.3f dB; quiet channel turned down %.2f dB; mirror-exact: %s\n",
                grA, grB, ampToDb(quietIn / quietOut), mirrored ? "yes" : "NO");
    CHECK(grA > 6.0f, "the loud channel drives real gain reduction");
    CHECK(grA == grB, "same gain reduction whichever channel drives it");
    CHECK(std::abs(ampToDb(quietIn / quietOut) - grA) < 1.5f, "the quiet channel gets the loud channel's reduction");
    CHECK(mirrored, "effect output is exactly L/R mirror-symmetric");

    // A silent channel under a swinging control voltage: bursts on the left
    // pump the bias between 0 and ~20 dB — the right channel must stay exactly
    // silent (the CV is common mode in its push-pull pair). Single-ended, the
    // control voltage reaches the output.
    for (int se = 0; se < 2; ++se)
    {
        CoreOpts o;
        o.position = 1;
        o.colour = true;
        o.singleEnded = se == 1;
        const double fs = coreRate();
        auto core = makeCore(fs, o);
        std::vector<float> L, R;
        for (int k = 0; k < 6; ++k)
        {
            auto on = sine(static_cast<int>(fs * 0.15), dbToAmp(levelForGr(20.0f)), 500.0, fs);
            L.insert(L.end(), on.begin(), on.end());
            L.insert(L.end(), static_cast<size_t>(fs * 0.25), 0.0f);
        }
        R.assign(L.size(), 0.0f);
        runCore(*core, L, &R);
        float peak = 0.0f;
        for (float v : R) peak = std::max(peak, std::abs(v));
        std::printf("    %s: silent right channel under 0..20 dB GR bursts peaks at %s\n",
                    se ? "single-ended (control)" : "push-pull            ", peak == 0.0f ? "exactly 0" : (std::to_string(ampToDb(peak)) + " dBFS").c_str());
        if (!se) CHECK(peak == 0.0f, "push-pull: no thump — the silent channel stays bit-exactly silent");
        else     CHECK(peak > dbToAmp(-20.0f), "NEGATIVE CONTROL: single-ended, the pumping bias thumps (> -20 dBFS)");
    }
}

// ─── [8] Mid/Side ────────────────────────────────────────────────────────────

static void testMidSide()
{
    std::cout << "\n[8] Mid/Side: independent control of M and S; the mode switch crossfades\n";
    const double fs = coreRate();
    const int n = static_cast<int>(fs * 0.5);
    const float loud = dbToAmp(levelForGr(12.0f));

    // Mono content (L = R): only the mid unit moves, and L stays equal to R.
    {
        CoreOpts o;
        o.position = 1;
        o.colour = true;
        o.mode = comp::ChannelMode::MidSide;
        auto core = makeCore(fs, o);
        auto L = sine(n, loud, 440.0, fs), R = L;
        runCore(*core, L, &R);
        bool same = true;
        for (size_t i = 0; i < L.size(); ++i) same = same && L[i] == R[i];
        std::printf("    mono content: GR mid %.2f / side %.2f dB, L == R: %s\n",
                    core->getChannelGainReductionDb(0), core->getChannelGainReductionDb(1), same ? "exactly" : "NO");
        CHECK(core->getChannelGainReductionDb(0) > 8.0f && core->getChannelGainReductionDb(1) == 0.0f, "mono content compresses M only");
        CHECK(same, "…and the side stays exactly empty (L == R out)");
    }
    // Side content (L = −R): only the side unit moves.
    {
        CoreOpts o;
        o.position = 1;
        o.mode = comp::ChannelMode::MidSide;
        auto core = makeCore(fs, o);
        auto L = sine(n, loud, 440.0, fs), R = L;
        for (auto& v : R) v = -v;
        runCore(*core, L, &R);
        std::printf("    side content: GR mid %.2f / side %.2f dB\n", core->getChannelGainReductionDb(0), core->getChannelGainReductionDb(1));
        CHECK(core->getChannelGainReductionDb(1) > 8.0f && core->getChannelGainReductionDb(0) == 0.0f, "side content compresses S only");
    }
    // A loud mid with a quiet side: in Mid/Side the side keeps its level; in
    // Linked it is pulled down with the mid.
    float sideDb[2];
    for (int ms = 0; ms < 2; ++ms)
    {
        CoreOpts o;
        o.position = 1;
        o.mode = ms ? comp::ChannelMode::MidSide : comp::ChannelMode::Linked;
        auto core = makeCore(fs, o);
        auto m = sine(n, loud, 220.0, fs), s = sine(n, dbToAmp(kT - 20.0f), 3000.0, fs);
        std::vector<float> L(m.size()), R(m.size());
        for (size_t i = 0; i < m.size(); ++i) { L[i] = m[i] + s[i]; R[i] = m[i] - s[i]; }
        runCore(*core, L, &R);
        const int w = static_cast<int>(fs * 0.1);
        std::vector<float> side(static_cast<size_t>(w));
        for (int i = 0; i < w; ++i) side[static_cast<size_t>(i)] = 0.5f * (L[L.size() - w + i] - R[R.size() - w + i]);
        sideDb[ms] = ampToDb(static_cast<float>(toneAmp(side.data(), w, 3000.0, fs)) / dbToAmp(kT - 20.0f));
        std::printf("    %-8s loud mid (GR %.1f dB) + quiet side: side level change %+.2f dB\n",
                    ms ? "Mid/Side" : "Linked", core->getGainReductionDb(), sideDb[ms]);
    }
    CHECK(std::abs(sideDb[1]) < 0.3f, "Mid/Side: a quiet side keeps its level under a loud mid");
    CHECK(sideDb[0] < -8.0f, "Linked (control): the same side is pulled down with the mid");

    // Below the threshold both modes are the same transparent stage.
    {
        float worst = 0.0f;
        std::vector<float> outs[2][2];
        for (int ms = 0; ms < 2; ++ms)
        {
            CoreOpts o;
            o.mode = ms ? comp::ChannelMode::MidSide : comp::ChannelMode::Linked;
            auto core = makeCore(fs, o);
            outs[ms][0] = sine(n, dbToAmp(kT - 12.0f), 330.0, fs);
            outs[ms][1] = sine(n, dbToAmp(kT - 15.0f), 550.0, fs);
            runCore(*core, outs[ms][0], &outs[ms][1]);
        }
        for (int c = 0; c < 2; ++c)
            for (size_t i = 0; i < outs[0][c].size(); ++i) worst = std::max(worst, std::abs(outs[0][c][i] - outs[1][c][i]));
        std::printf("    below threshold, Linked vs Mid/Side outputs differ by at most %.2e\n", worst);
        CHECK(worst < 1e-5f, "below threshold the M/S matrix is transparent");
    }

    // The mode switch on compressed stereo program (mid and side at different
    // GR): the 30 ms crossfade vs a 1-sample one. Sum link here, because
    // (|L| + |R|)/2 = max(|M|, |S|): the linked unit then reads exactly the
    // level the mid unit read, so it carries on from the mid's state without a
    // new attack, and whatever happens at the switch is the switch itself —
    // the side's gain moving from its own GR to the mid's.
    for (int hard = 0; hard < 2; ++hard)
    {
        Core::Config cfg = comp::variMuConfig();
        cfg.link = comp::StereoLink::Sum;
        if (hard) cfg.crossfadeSeconds = 1.0 / fs;
        CoreOpts o;
        o.position = 2;
        o.colour = true;
        o.mode = comp::ChannelMode::MidSide;
        auto core = makeCore(fs, o, cfg);
        const int total = static_cast<int>(fs * 1.2);
        // 173 Hz: the side is 0.59 of its peak at the switch instant.
        auto m = sine(total, loud, 110.0, fs), s = sine(total, dbToAmp(levelForGr(3.0f)), 173.0, fs);
        std::vector<float> L(m.size()), R(m.size());
        for (size_t i = 0; i < m.size(); ++i) { L[i] = m[i] + s[i]; R[i] = m[i] - s[i]; }
        const float thr[1] = { kT }, mk[1] = { 0.0f };
        const int sw = static_cast<int>(fs * 0.8), blk = 64;
        float grM = 0.0f, grS = 0.0f;
        for (int st = 0; st < total; st += blk)
        {
            if (st == sw / blk * blk)
            {
                grM = core->getChannelGainReductionDb(0);
                grS = core->getChannelGainReductionDb(1);
                core->setChannelMode(comp::ChannelMode::Linked);
            }
            const int len = std::min(blk, total - st);
            core->process(L.data() + st, R.data() + st, len, thr, mk, len);
        }
        // Largest second difference (a click is a kink/step) around the switch
        // vs in the steady part before it.
        auto d2 = [&](const std::vector<float>& v, int from, int to) {
            float w = 0.0f;
            for (int i = from + 2; i < to; ++i) w = std::max(w, std::abs(v[static_cast<size_t>(i)] - 2 * v[static_cast<size_t>(i - 1)] + v[static_cast<size_t>(i - 2)]));
            return w;
        };
        const int sw0 = sw / blk * blk;
        const float steady = std::max(d2(R, sw0 - static_cast<int>(fs * 0.2), sw0), d2(L, sw0 - static_cast<int>(fs * 0.2), sw0));
        const float around = std::max(d2(R, sw0 - 64, sw0 + static_cast<int>(fs * 0.05)), d2(L, sw0 - 64, sw0 + static_cast<int>(fs * 0.05)));
        std::printf("    Mid/Side -> Linked (%s, GR mid %.1f / side %.1f dB): largest 2nd difference around the switch %.2e vs steady %.2e; mode now %s\n",
                    hard ? "1-sample switch" : "30 ms crossfade", grM, grS, around, steady,
                    core->getChannelMode() == comp::ChannelMode::Linked ? "Linked" : "Mid/Side");
        CHECK(core->getChannelMode() == comp::ChannelMode::Linked && !core->isChannelModeFading(), "the switch completes onto Linked");
        if (!hard) CHECK(around < 1.5f * steady, "the 30 ms mode crossfade does not click");
        else       CHECK(around > 5.0f * steady, "NEGATIVE CONTROL: a 1-sample mode switch clicks");
    }
}

// ─── [9] Stepped Time Constant ───────────────────────────────────────────────

static void testSteppedTimeConstant()
{
    std::cout << "\n[9] Time Constant: coefficient-set fades; leaving an automatic position keeps the held bias\n";
    const double fs = coreRate();

    // Model level: leaving position 6 with its slow branches charged. The
    // fold keeps the bias; simply dropping the branches would step it.
    {
        const auto c3 = Bal::makeCoeffs(comp::variMuSettings(3).bal, fs);
        Bal::State s;
        s.v[0] = 0.2f; s.v[1] = 1.2f; s.v[2] = 0.9f; s.rho = 0.0f;
        Bal::commit(s, Bal::makeCoeffs(comp::variMuSettings(6).bal, fs), 0.0f);
        const float before = Bal::value(s);
        Bal::State folded = s, dropped = s;
        Bal::adopt(folded, c3);
        dropped.v[1] = dropped.v[2] = 0.0f;
        Bal::commit(folded, c3, 0.0f);
        Bal::commit(dropped, c3, 0.0f);
        std::printf("    6 -> 3 with the slow branches holding: GR %.2f -> %.2f dB folded, %.2f dB dropped\n",
                    before, Bal::value(folded), Bal::value(dropped));
        CHECK(std::abs(Bal::value(folded) - before) < 0.01f, "adopt() folds the held bias into branch 0: no step");
        CHECK(before - Bal::value(dropped) > 3.0f, "NEGATIVE CONTROL: dropping the slow branches would step the GR");
    }

    // Core level: switching during a held release (6 → 3), and during steady
    // compression (1 → 4): no GR step.
    for (auto pr : { std::pair<int, int>{ 6, 3 }, std::pair<int, int>{ 1, 4 } })
    {
        CoreOpts o;
        o.position = pr.first;
        auto core = makeCore(fs, o);
        auto x = sine(static_cast<int>(fs * 5.0), dbToAmp(levelForGr(10.0f)), 1000.0, fs);
        runCore(*core, x, nullptr);
        std::vector<float> y;
        if (pr.first == 6) y.assign(static_cast<size_t>(fs * 1.0), 0.0f);   // release in progress
        else y = sine(static_cast<int>(fs * 1.0), dbToAmp(levelForGr(10.0f)), 1000.0, fs, static_cast<int>(fs * 5.0));
        std::vector<float> gr0;
        auto warm = std::vector<float>(y.begin(), y.begin() + static_cast<long>(fs * 0.1));
        runCore(*core, warm, nullptr, 0.0f, &gr0);
        const float before = core->getGainReductionDb();
        float steady = 0.0f;   // the GR's own per-sample movement (ripple) before the switch
        for (size_t i = 1; i < gr0.size(); ++i) steady = std::max(steady, std::abs(gr0[i] - gr0[i - 1]));
        CoreOpts o2 = o;
        o2.position = pr.second;
        core->setSettings(settingsFor(o2));
        std::vector<float> rest(y.begin() + static_cast<long>(fs * 0.1), y.end()), gr;
        runCore(*core, rest, nullptr, 0.0f, &gr);
        float worst = std::abs(gr[0] - before);
        for (size_t i = 1; i < std::min<size_t>(gr.size(), static_cast<size_t>(fs * 0.05)); ++i) worst = std::max(worst, std::abs(gr[i] - gr[i - 1]));
        std::printf("    %d -> %d: GR %.2f dB at the switch, largest per-sample change in the next 50 ms %.5f dB (before it %.5f)\n",
                    pr.first, pr.second, before, worst, steady);
        CHECK(worst < 0.01f || worst < 1.2f * steady, pr.first << " -> " << pr.second << ": the switch never steps the gain");
        CHECK(!core->isCrossfading() && core->getActiveSettings() == settingsFor(o2), "the fade completes onto the new position");
    }
}

// ─── [10] Realtime safety and CPU ────────────────────────────────────────────

static void testRealtimeSafety()
{
    std::cout << "\n[10] realtime safety: allocations, denormals, loop stability, CPU\n";
    constexpr int block = 512;

    {
        VmFx fx;
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
            fx.setParameterValue("time_constant", static_cast<float>(1 + (k / 3) % 6));
            fx.setParameterValue("mode", static_cast<float>((k / 7) % 2));
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
        std::printf("    processBlock allocations over 400 blocks of parameter churn (mode flips included): %lld\n", allocs);
        CHECK(allocs == 0, "processBlock never allocates");
        g_allocCount.store(0);
        g_allocArmed.store(true);
        fx.reset();
        g_allocArmed.store(false);
        CHECK(g_allocCount.load() == 0, "reset() is a pure state clear (no allocation)");
    }

    for (int ms = 0; ms < 2; ++ms)
    {
        // Loud, then a long silence: nothing subnormal, silence is not slow.
        VmFx fx;
        fx.prepareToPlay(kFs, block);
        fx.setParameterValue("input", 24.0f);
        fx.setParameterValue("time_constant", 6.0f);
        fx.setParameterValue("mode", static_cast<float>(ms));
        juce::AudioBuffer<float> b(2, block);
        juce::MidiBuffer midi;
        using clk = std::chrono::steady_clock;
        double loudUs = 0.0, silentUs = 0.0;
        int subnormals = 0, nonFinite = 0;
        const int loudBlocks = static_cast<int>(kFs * 3.0 / block);
        const int quietBlocks = static_cast<int>(kFs * 40.0 / block);
        for (int k = 0; k < loudBlocks + quietBlocks; ++k)
        {
            const bool loud = k < loudBlocks;
            for (int c = 0; c < 2; ++c)
                for (int i = 0; i < block; ++i)
                    b.setSample(c, i, loud ? 0.9f * static_cast<float>(std::sin(2.0 * kPi * (c ? 60.0 : 97.0) * (k * block + i) / kFs)) : 0.0f);
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
        std::printf("    %s, one stereo instance: loud %.1f us/block (%.2f %% of the %.0f us budget), late silence %.1f us/block; "
                    "subnormal outputs %d, GR state %.3g\n",
                    ms ? "Mid/Side" : "Linked  ", loudPer, 100.0 * loudPer / (block * 1e6 / kFs), block * 1e6 / kFs, silentPer, subnormals, gr);
        CHECK(nonFinite == 0, "all outputs finite");
        CHECK(subnormals == 0, "no subnormal output samples in silence after a loud signal");
        CHECK(gr == 0.0f || std::fpclassify(gr) != FP_SUBNORMAL, "GR state never subnormal");
        CHECK(silentPer < 3.0 * loudPer + 20.0, "silence after a loud signal is not slower (denormal stall)");
        CHECK(loudPer < 0.05 * (block * 1e6 / kFs), "one instance stays under 5 % of the block budget");
    }

    {
        // Extreme settings at 44.1 kHz with NO oversampling: position 1, +45 dB
        // over the threshold, 50 Hz square. The implicit loop must settle
        // without ringing, on the curve.
        constexpr double fs44 = 44100.0;
        CoreOpts o;
        o.position = 1;
        auto core = makeCore(fs44, o);
        auto x = square(static_cast<int>(fs44 * 2.0), dbToAmp(kT + 45.0f), 882);
        std::vector<float> gr;
        runCore(*core, x, nullptr, 0.0f, &gr);
        float lateSlew = 0.0f;
        int alternations = 0;
        const size_t from = gr.size() * 2 / 3;
        for (size_t i = from + 2; i < gr.size(); ++i)
        {
            lateSlew = std::max(lateSlew, std::abs(gr[i] - gr[i - 1]));
            if ((gr[i] - gr[i - 1]) * (gr[i - 1] - gr[i - 2]) < -1e-10f) ++alternations;
        }
        // Bounded once the loop has caught the first edge (a feedback-style
        // limiter lets the first samples of a 45 dB step through — §2.1).
        bool bounded = true;
        float peakLate = 0.0f;
        for (size_t i = 0; i < x.size(); ++i)
        {
            bounded = bounded && std::isfinite(x[i]);
            if (i > static_cast<size_t>(fs44 * 0.005)) peakLate = std::max(peakLate, std::abs(x[i]));
        }
        bounded = bounded && peakLate < 4.0f;
        auto elem = std::make_unique<Elem>();
        elem->setThresholdDb(kT);
        elem->prepare(fs44);
        // Settled output crest (the last period) vs the stage's large-signal
        // equilibrium: at +45 dB the swing's large-signal gain is 0.7 dB under
        // the small-signal GR the core reports, and the loop regulates the former.
        float crest = 0.0f;
        for (size_t i = x.size() - 882; i < x.size(); ++i) crest = std::max(crest, std::abs(x[i]));
        const float want = elem->staticOutputDb(kT + 45.0f, kT);
        std::printf("    position 1 / +45 dB / 44.1 kHz no OS: late |dGR| %.2e dB, sign flips %d, GR %.2f dB, output %.2f dBFS (curve %.2f), peak after 5 ms %.2f\n",
                    lateSlew, alternations, gr.back(), ampToDb(crest), want, peakLate);
        CHECK(bounded, "output bounded at extreme settings");
        CHECK(lateSlew < 1e-3f && alternations == 0, "implicit loop settles without ringing");
        CHECK(std::abs(ampToDb(crest) - want) < 0.05f, "and settles on the curve");
    }
}

// ─── [11] Latency, bypass, surface ───────────────────────────────────────────

static void testLatencyBypassSurface()
{
    std::cout << "\n[11] latency, latency-aligned bypass, parameter surface, registration\n";
    VmFx fx;
    fx.prepareToPlay(kFs, 480);
    fx.setParameterValue("input", -24.0f);
    fx.prepareToPlay(kFs, 480);
    const int lat = fx.getLatencySamples();
    std::printf("    %dx FIR oversampler latency: %d samples, reported to PDC: %d\n", fx.getOversamplingFactor(), fx.getOversamplingLatencySamples(), lat);
    CHECK(fx.getOversamplingFactor() == (1 << VmFx::kOversamplingOrder), "the chosen oversampling factor");
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

    VmFx by;
    by.prepareToPlay(kFs, 480);
    by.setParameterValue("input", 30.0f);
    by.setParameterValue("mode", 1.0f);
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
    CHECK(worst == 0.0f, "bypass is sample-exact against the latency-aligned dry");

    VmFx s;
    CHECK(s.getParameters().size() == 4, "4 APVTS parameters: Input, Output, Time Constant, Mode");
    bool noThreshold = true;
    for (auto* prm : s.getParameters())
        if (auto* h = dynamic_cast<juce::HostedAudioProcessorParameter*>(prm))
            noThreshold = noThreshold && !h->getParameterID().containsIgnoreCase("thresh");
    CHECK(noThreshold, "no threshold control: Input drives the curve");
    CHECK(std::abs(s.getParameterValue("input")) < 1e-4f && std::abs(s.getParameterValue("output")) < 1e-4f, "Input/Output default 0 dB");
    CHECK(std::abs(s.getParameterValue("time_constant") - 2.0f) < 1e-4f, "Time Constant 2 by default");
    CHECK(std::abs(s.getParameterValue("mode")) < 1e-6f, "defaults to Linked");
    s.prepareToPlay(kFs, 512);
    s.setParameterValue("time_constant", 5.0f);
    CHECK(s.currentSettings() == comp::variMuSettings(5) && s.currentSettings().bal.branches == 2, "time_constant 5 = the automatic two-branch network");
    s.setParameterValue("mode", 1.0f);
    CHECK(s.channelMode() == comp::ChannelMode::MidSide, "mode 1 = Mid/Side");
    bool labelled = false;
    for (auto* prm : s.getParameters())
        if (auto* h = dynamic_cast<juce::HostedAudioProcessorParameter*>(prm))
            if (h->getParameterID() == "mode")
                labelled = h->getName(64) == "Mode" && !h->getName(64).containsIgnoreCase("lat") && !h->getName(64).containsIgnoreCase("vert");
    CHECK(labelled, "the mode is not labelled with the disputed Lat/Vert names");

    EffectChainManager chain;
    chain.init(48000.0, 512);
    const int node = chain.addEffect("varimu", 0);
    auto* e = node >= 0 ? chain.getEffect(node) : nullptr;
    CHECK(e != nullptr && e->getPluginId() == "varimu", "AudioGraph creates \"varimu\" as a stock effect");
    if (e) CHECK(e->getLatencySamples() > 0, "live chain instance reports its latency to PDC");
}

// ─── [12] Gentle leveling on a full-mix-style source ─────────────────────────

static void testFullMixLeveling()
{
    std::cout << "\n[12] defaults on a full-mix-style source (-1 dBFS peak): gentle leveling\n";
    const int n = static_cast<int>(kFs * 12.0);
    juce::AudioBuffer<float> b(2, n);
    std::mt19937 rng(5);
    std::normal_distribution<float> nd(0.0f, 1.0f);
    float padL = 0.0f, padR = 0.0f;
    for (int i = 0; i < n; ++i)
    {
        const double t = i / kFs;
        const double beat = std::fmod(t, 0.5), bar = std::fmod(t + 0.25, 1.0);
        const float kick = static_cast<float>(std::exp(-beat / 0.08) * std::sin(2.0 * kPi * (50.0 + 60.0 * std::exp(-beat / 0.02)) * beat));
        const float snare = bar < 0.15 ? static_cast<float>(std::exp(-bar / 0.05)) * 0.6f * nd(rng) : 0.0f;
        const float bass = 0.35f * static_cast<float>(std::sin(2.0 * kPi * (t < 6.0 ? 55.0 : 73.4) * t));
        padL += 0.02f * (nd(rng) - padL);
        padR += 0.02f * (nd(rng) - padR);
        const float swell = 0.5f + 0.5f * static_cast<float>(std::sin(2.0 * kPi * 0.1 * t));
        b.setSample(0, i, 0.8f * kick + 0.5f * snare + bass + 0.6f * swell * padL);
        b.setSample(1, i, 0.8f * kick + 0.5f * snare + bass + 0.6f * swell * padR);
    }
    b.applyGain(dbToAmp(-1.0f) / b.getMagnitude(0, n));
    const float crest = ampToDb(b.getMagnitude(0, n) / b.getRMSLevel(0, 0, n));
    VmFx fx;
    fx.prepareToPlay(kFs, 512);
    juce::MidiBuffer midi;
    double sum = 0.0;
    float mx = 0.0f;
    int cnt = 0;
    for (int s = 0; s < n; s += 512)
    {
        juce::AudioBuffer<float> view(b.getArrayOfWritePointers(), 2, s, std::min(512, n - s));
        fx.processBlock(view, midi);
        if (s > static_cast<int>(kFs * 2.0))
        {
            const float g = fx.readMeterValue(2);
            sum += g;
            mx = std::max(mx, g);
            ++cnt;
        }
    }
    const float mean = static_cast<float>(sum / cnt);
    std::printf("    crest factor %.1f dB, Input 0 / TC 2 / Linked: mean GR %.2f dB, max %.2f dB\n", crest, mean, mx);
    CHECK(mean >= 1.0f && mean <= 3.0f, "defaults level a mastered-level mix by 1-3 dB");
    CHECK(mx < 6.0f, "…without clamping its peaks (max < 6 dB)");
}

int main()
{
    juce::ScopedJuceInitialiser_GUI juceInit;
    std::cout << "test_varimu_compressor — Vari-Mu Comp on CompressorCore\n";

    // The CPU-timed sections run first: on this machine's hybrid CPU, Windows
    // moves a process that has been computing for minutes onto efficiency
    // cores, which doubled every timing measured after the other sections.
    juce::Process::setPriority(juce::Process::HighPriority);
    testCpuFactors();
    testRealtimeSafety();
    testAliasing();
    testModelPieces();
    testStaticCurve();
    testProgramDependence();
    testBallistics();
    testThdVsGr();
    testStereoLink();
    testMidSide();
    testSteppedTimeConstant();
    testLatencyBypassSurface();
    testFullMixLeveling();

    std::cout << "\n" << g_passed << " passed, " << g_failed << " failed\n";
    if (g_failed == 0) std::cout << "ALL TESTS PASSED\n";
    return g_failed == 0 ? 0 : 1;
}
