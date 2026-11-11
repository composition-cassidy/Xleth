// test_stereoize_core.cpp — xleth::dsp::stereoize::Core (src/dsp/stereoize/StereoizeCore.*), headless.
// Build: cmake --build build --config Release --target test_stereoize_core
// Run:   ctest --test-dir build -C Release -R "^test_stereoize_core$" -V
// Pass:  prints "[StereoizeCore] ALL TESTS PASSED" and exits 0.
//
// Spec xleth-spread-spec.md section 7, core-level rows:
//   T1  mono null: (Lout + Rout) / 2 == (Lin + Rin) / 2 to <= -120 dBFS, every mode, width 0..200,
//       random parameters, parameters re-randomised every block; width 0 is a bit-exact passthrough
//   T2  correlation calibration: pink noise, Diffuse and Velvet, width 0/50/100/150/200, several seeds:
//       measured L/R correlation within +-0.05 of (1 - g^2) / (1 + g^2)
//   T4  block-size independence: block sizes 32 / 64 / 128 / 333 / 512 / 1024 / random give
//       bit-identical output with constant parameters
//   T5  automation zipper: width / size / character / low bypass / variation swept every 64 samples
//       on a sine; the side signal through an 8th-order 4 kHz high-pass stays <= -90 dBFS
//   T6  sample rates 44.1 / 48 / 96 / 192 kHz: delay times constant in ms; T1 and T2 hold
//   T7  denormals: 10 s of silence after a loud burst: CPU flat, output decays to exact zero
//   T9  CPU: 64 instances at 48 kHz / 128 (reported; the spec's 5 % gate is for the target laptop)
//   T10 seed decorrelation: two seeds, same input: side correlation < 0.1
// Plus: zero operator new in process() (switches included), switch timing, Transient Guard,
// monitors, loudness match, mono stream, non-finite input.
// Output prefix: [StereoizeCore].

#include "dsp/stereoize/StereoizeCore.h"

#include <juce_audio_basics/juce_audio_basics.h>

#include <algorithm>
#include <atomic>
#include <chrono>
#include <cmath>
#include <cstdint>
#include <cstdlib>
#include <iomanip>
#include <iostream>
#include <limits>
#include <new>
#include <string>
#include <vector>

// ─── Allocation counter ──────────────────────────────────────────────────────
namespace
{
std::atomic<bool>      g_allocArmed { false };
std::atomic<long long> g_allocCount { 0 };
inline void countAlloc() noexcept
{
    if (g_allocArmed.load(std::memory_order_relaxed)) g_allocCount.fetch_add(1, std::memory_order_relaxed);
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
        if (cond) {                                                            \
            ++g_passed;                                                        \
        } else {                                                               \
            std::cerr << "  FAIL [" << __LINE__ << "] " << msg << "\n";        \
            ++g_failed;                                                        \
        }                                                                      \
    } while (0)

namespace st = xleth::dsp::stereoize;

namespace
{
constexpr double kPi = 3.14159265358979323846;

struct Rng
{
    std::uint32_t s;
    explicit Rng(std::uint32_t seed) : s(seed ? seed : 1u) {}
    std::uint32_t u32() { s ^= s << 13; s ^= s >> 17; s ^= s << 5; return s; }
    float uni() { return static_cast<float>(u32() & 0x00FFFFFFu) / 16777215.0f; }
    float bip() { return uni() * 2.0f - 1.0f; }
    int   range(int lo, int hi) { return lo + static_cast<int>(u32() % static_cast<std::uint32_t>(hi - lo + 1)); }
};

using Sig = std::vector<float>;

double dbOf(double v) { return 20.0 * std::log10(std::max(v, 1e-30)); }

const char* modeName(st::Character c)
{
    switch (c)
    {
        case st::Character::Comb:    return "Comb";
        case st::Character::Diffuse: return "Diffuse";
        case st::Character::Velvet:  return "Velvet";
    }
    return "?";
}

constexpr st::Character kModes[] = { st::Character::Comb, st::Character::Diffuse, st::Character::Velvet };

Sig whiteNoise(int n, std::uint32_t seed, float amp = 0.5f)
{
    Rng r(seed);
    Sig s(static_cast<std::size_t>(n));
    for (auto& v : s) v = r.bip() * amp;
    return s;
}

// RBJ biquad, double precision, for test signal conditioning and analysis only.
struct Biquad
{
    double b0 = 1, b1 = 0, b2 = 0, a1 = 0, a2 = 0, z1 = 0, z2 = 0;
    static Biquad highpass(double fc, double q, double fs)
    {
        const double w = 2.0 * kPi * fc / fs, c = std::cos(w), al = std::sin(w) / (2.0 * q);
        const double a0 = 1.0 + al;
        Biquad b;
        b.b0 = (1.0 + c) / 2.0 / a0; b.b1 = -(1.0 + c) / a0; b.b2 = (1.0 + c) / 2.0 / a0;
        b.a1 = -2.0 * c / a0; b.a2 = (1.0 - al) / a0;
        return b;
    }
    double process(double x)
    {
        const double y = b0 * x + z1;
        z1 = b1 * x - a1 * y + z2;
        z2 = b2 * x - a2 * y;
        return y;
    }
};

// Pink noise (Paul Kellet's refined filter), high-passed at 40 Hz so the measurement is about the
// decorrelator and not about the sub-sonic content every pink generator piles up.
Sig pinkNoise(int n, std::uint32_t seed, double fs)
{
    Rng r(seed);
    double b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
    auto hp1 = Biquad::highpass(40.0, 0.7071, fs);
    Sig s(static_cast<std::size_t>(n));
    for (int i = 0; i < n; ++i)
    {
        const double w = r.bip();
        b0 = 0.99886 * b0 + w * 0.0555179;
        b1 = 0.99332 * b1 + w * 0.0750759;
        b2 = 0.96900 * b2 + w * 0.1538520;
        b3 = 0.86650 * b3 + w * 0.3104856;
        b4 = 0.55000 * b4 + w * 0.5329522;
        b5 = -0.7616 * b5 - w * 0.0168980;
        const double pink = b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362;
        b6 = w * 0.115926;
        s[static_cast<std::size_t>(i)] = static_cast<float>(hp1.process(pink) * 0.1);
    }
    return s;
}

// Transient-heavy, pitched material standing in for Sparta samples: clap-like noise bursts and a
// harmonic note sequence.
Sig spartaLike(int n, std::uint32_t seed, double fs)
{
    Rng r(seed);
    Sig s(static_cast<std::size_t>(n), 0.0f);
    const int period = static_cast<int>(0.25 * fs);
    const double notes[] = { 110.0, 146.83, 164.81, 220.0, 196.0, 130.81 };
    for (int i = 0; i < n; ++i)
    {
        const int k = i / period, t = i % period;
        const double env = std::exp(-static_cast<double>(t) / (0.04 * fs));
        const double f = notes[k % 6];
        double v = 0.0;
        for (int h = 1; h <= 6; ++h) v += std::sin(2.0 * kPi * f * h * i / fs) / h;
        v *= 0.25 * std::exp(-static_cast<double>(t) / (0.18 * fs));
        if (k % 2 == 1) v += r.bip() * 0.6 * env;   // clap on the off-beats
        s[static_cast<std::size_t>(i)] = static_cast<float>(v);
    }
    return s;
}

struct Stereo
{
    Sig l, r;
};

// Runs a core over a stereo signal. `perBlock` (may be null) edits the params before each block.
template <typename F>
Stereo run(st::Core& core, const Stereo& in, int blockSize, st::Params p, F&& perBlock)
{
    Stereo out = in;
    const int n = static_cast<int>(in.l.size());
    int block = 0;
    for (int off = 0; off < n; off += blockSize, ++block)
    {
        const int len = std::min(blockSize, n - off);
        perBlock(p, block, off);
        core.process(out.l.data() + off, out.r.data() + off, len, p);
    }
    return out;
}

Stereo run(st::Core& core, const Stereo& in, int blockSize, const st::Params& p)
{
    return run(core, in, blockSize, p, [](st::Params&, int, int) {});
}

double monoNullDb(const Stereo& in, const Stereo& out, int from = 0)
{
    double worst = 0.0;
    for (std::size_t i = static_cast<std::size_t>(from); i < in.l.size(); ++i)
    {
        const double a = 0.5 * (static_cast<double>(out.l[i]) + out.r[i]);
        const double b = 0.5 * (static_cast<double>(in.l[i]) + in.r[i]);
        worst = std::max(worst, std::fabs(a - b));
    }
    return dbOf(worst);
}

double correlation(const Sig& a, const Sig& b, std::size_t from)
{
    double ab = 0, aa = 0, bb = 0;
    for (std::size_t i = from; i < a.size(); ++i)
    {
        ab += static_cast<double>(a[i]) * b[i];
        aa += static_cast<double>(a[i]) * a[i];
        bb += static_cast<double>(b[i]) * b[i];
    }
    return (aa > 0 && bb > 0) ? ab / std::sqrt(aa * bb) : 1.0;
}

Sig sideResidual(const Stereo& in, const Stereo& out)
{
    Sig g(in.l.size());
    for (std::size_t i = 0; i < g.size(); ++i)
        g[i] = 0.5f * (out.l[i] - out.r[i]) - 0.5f * (in.l[i] - in.r[i]);
    return g;
}

st::Params baseParams(st::Character c, float width, int variation = 7)
{
    st::Params p;
    p.character = c;
    p.widthPct = width;
    p.variation = variation;
    return p;
}

st::Params randomParams(Rng& r)
{
    st::Params p;
    p.widthPct      = r.uni() * 200.0f;
    p.character     = static_cast<st::Character>(r.range(0, 2));
    p.sizeMs        = 0.5f + r.uni() * 29.5f;
    p.lowBypassHz   = 20.0f * std::pow(100.0f, r.uni());
    p.lowSlope      = r.uni() < 0.5f ? st::LowSlope::Db12 : st::LowSlope::Db24;
    p.hfDampHz      = r.uni() < 0.3f ? st::kHfDampOffHz : 2000.0f * std::pow(10.0f, r.uni());
    p.guard         = r.uni();
    p.variation     = r.range(0, st::kMaxVariation);
    p.loudnessMatch = false;
    return p;
}

// ─── T1 ──────────────────────────────────────────────────────────────────────
void testMonoNull()
{
    std::cout << "\n[StereoizeCore] T1 mono null\n";
    const double fs = 48000.0;
    const int n = static_cast<int>(fs * 1.5);
    const Stereo inputs[] = {
        { whiteNoise(n, 11), whiteNoise(n, 12) },               // decorrelated stereo
        { whiteNoise(n, 13), whiteNoise(n, 13) },               // mono
        { spartaLike(n, 3, fs), spartaLike(n, 3, fs) },         // pitched + claps, mono
        { spartaLike(n, 4, fs), whiteNoise(n, 14, 0.2f) },      // mixed stereo
    };

    double worst = -400.0;
    for (const auto& in : inputs)
    {
        for (auto mode : kModes)
        {
            for (float w : { 0.0f, 37.0f, 100.0f, 163.0f, 200.0f })
            {
                st::Core core;
                core.prepare(fs, 512);
                Rng r(static_cast<std::uint32_t>(w * 10 + static_cast<int>(mode) + 1));
                auto p = randomParams(r);
                p.character = mode;
                p.widthPct = w;
                const auto out = run(core, in, 256, p);
                worst = std::max(worst, monoNullDb(in, out));
            }
        }
        // Everything automated: new random parameters every 128-sample block.
        st::Core core;
        core.prepare(fs, 512);
        Rng r(99);
        const auto out = run(core, in, 128, st::Params {}, [&r](st::Params& p, int, int) { p = randomParams(r); });
        const double db = monoNullDb(in, out);
        std::cout << "  automated, all params random per block: " << std::fixed << std::setprecision(1) << db << " dBFS\n";
        worst = std::max(worst, db);
    }
    std::cout << "  worst mono-null error: " << std::fixed << std::setprecision(1) << worst << " dBFS\n";
    CHECK(worst <= -120.0, "T1 mono null error " << worst << " dBFS > -120");

    // Width 0: bit-exact passthrough.
    for (auto mode : kModes)
    {
        st::Core core;
        core.prepare(fs, 512);
        const Stereo in { whiteNoise(n, 21), whiteNoise(n, 22) };
        auto p = baseParams(mode, 0.0f);
        p.guard = 0.7f;
        p.hfDampHz = 6000.0f;
        const auto out = run(core, in, 300, p);
        CHECK(out.l == in.l && out.r == in.r, "T1 width 0 is not a bit-exact passthrough (" << modeName(mode) << ")");
    }
}

// ─── T2 ──────────────────────────────────────────────────────────────────────
double measuredRho(st::Character mode, float width, int variation, double fs, const Sig& pink)
{
    st::Core core;
    core.prepare(fs, 512);
    auto p = baseParams(mode, width, variation);
    p.lowBypassHz = 20.0f;
    const Stereo in { pink, pink };
    const auto out = run(core, in, 512, p);
    return correlation(out.l, out.r, static_cast<std::size_t>(0.5 * fs));
}

double testCorrelationCalibration(double fs, bool verbose)
{
    const Sig pink = pinkNoise(static_cast<int>(fs * 4.0), 5, fs);
    double worstErr = 0.0;
    for (auto mode : { st::Character::Diffuse, st::Character::Velvet })
    {
        for (float w : { 0.0f, 50.0f, 100.0f, 150.0f, 200.0f })
        {
            const float g = st::widthToGain(w);
            const double target = st::targetCorrelation(g);
            double worstHere = 0.0, worstRho = target;
            for (int seed : { 0, 1, 2, 3, 4, 5, 123, 777 })
            {
                const double rho = measuredRho(mode, w, seed, fs, pink);
                if (std::fabs(rho - target) >= worstHere) { worstHere = std::fabs(rho - target); worstRho = rho; }
            }
            if (verbose)
                std::cout << "  " << std::left << std::setw(8) << modeName(mode) << std::right << " width " << std::setw(3)
                          << static_cast<int>(w) << "  target " << std::showpos << std::fixed << std::setprecision(3) << target
                          << "  worst of 8 seeds " << worstRho << std::noshowpos << "\n";
            worstErr = std::max(worstErr, worstHere);
        }
    }
    return worstErr;
}

// ─── T4 ──────────────────────────────────────────────────────────────────────
void testBlockSizeIndependence()
{
    std::cout << "\n[StereoizeCore] T4 block-size independence\n";
    const double fs = 48000.0;
    const int n = static_cast<int>(fs * 1.2);
    const Stereo in { spartaLike(n, 8, fs), whiteNoise(n, 9, 0.3f) };

    for (auto mode : kModes)
    {
        auto p = baseParams(mode, 140.0f, 42);
        p.guard = 0.5f;
        p.hfDampHz = 8000.0f;
        p.lowSlope = st::LowSlope::Db24;
        p.loudnessMatch = true;
        p.sizeMs = 12.5f;

        st::Core ref;
        ref.prepare(fs, 1024);
        const auto expect = run(ref, in, 64, p);

        bool allSame = true;
        for (int bs : { 32, 128, 333, 512, 1024 })
        {
            st::Core c;
            c.prepare(fs, 1024);
            const auto got = run(c, in, bs, p);
            const bool same = got.l == expect.l && got.r == expect.r;
            if (!same) std::cerr << "  " << modeName(mode) << " block " << bs << " differs\n";
            allSame = allSame && same;
        }
        // Irregular blocks, as a host might deliver.
        {
            st::Core c;
            c.prepare(fs, 1024);
            Stereo out = in;
            Rng r(5);
            for (int off = 0; off < n;)
            {
                const int len = std::min(r.range(1, 700), n - off);
                c.process(out.l.data() + off, out.r.data() + off, len, p);
                off += len;
            }
            const bool same = out.l == expect.l && out.r == expect.r;
            if (!same) std::cerr << "  " << modeName(mode) << " irregular blocks differ\n";
            allSame = allSame && same;
        }
        CHECK(allSame, "T4 output depends on the block size (" << modeName(mode) << ")");
        std::cout << "  " << modeName(mode) << ": " << (allSame ? "bit-identical" : "DIFFERENT") << "\n";
    }
}

// ─── T5 ──────────────────────────────────────────────────────────────────────
double hfPeakDb(const Sig& g, double fs, std::size_t from)
{
    const double qs[] = { 0.5098, 0.6013, 0.9000, 2.5629 };   // 8th-order Butterworth
    Biquad f[4];
    for (int k = 0; k < 4; ++k) f[k] = Biquad::highpass(4000.0, qs[k], fs);
    double peak = 0.0;
    for (std::size_t i = 0; i < g.size(); ++i)
    {
        double x = g[i];
        for (auto& b : f) x = b.process(x);
        if (i >= from) peak = std::max(peak, std::fabs(x));
    }
    return dbOf(peak);
}

void testZipper()
{
    std::cout << "\n[StereoizeCore] T5 automation zipper (side through 8th-order 4 kHz HP)\n";
    const double fs = 48000.0;
    const int n = static_cast<int>(fs * 3.0);
    Sig sine(static_cast<std::size_t>(n));
    for (int i = 0; i < n; ++i) sine[static_cast<std::size_t>(i)] = static_cast<float>(0.5 * std::sin(2.0 * kPi * 110.0 * i / fs));
    const Stereo in { sine, sine };
    const std::size_t from = static_cast<std::size_t>(0.05 * fs);   // past the 4 kHz filter's own start-up

    struct Sweep { const char* name; int which; };
    const Sweep sweeps[] = {
        { "width 0..200", 0 }, { "size 0.5..30", 1 }, { "character cycle", 2 },
        { "low bypass 20..2000", 3 }, { "variation", 4 }, { "everything", 5 },
    };

    double worst = -400.0;
    for (auto mode : kModes)
    {
        // Static baseline.
        {
            st::Core c;
            c.prepare(fs, 64);
            auto p = baseParams(mode, 150.0f);
            p.lowBypassHz = 40.0f;
            const auto out = run(c, in, 64, p);
            std::cout << "  " << std::left << std::setw(8) << modeName(mode) << std::right << " static baseline         "
                      << std::fixed << std::setprecision(1) << hfPeakDb(sideResidual(in, out), fs, from) << " dBFS\n";
        }
        for (const auto& s : sweeps)
        {
            st::Core c;
            c.prepare(fs, 64);
            auto p0 = baseParams(mode, 150.0f);
            p0.lowBypassHz = 40.0f;
            const auto out = run(c, in, 64, p0, [&](st::Params& p, int block, int off) {
                const double t = off / fs;
                if (s.which == 0 || s.which == 5) p.widthPct = static_cast<float>(100.0 + 100.0 * std::sin(2.0 * kPi * 1.3 * t));
                if (s.which == 1 || s.which == 5) p.sizeMs = static_cast<float>(0.5 * std::pow(60.0, 0.5 + 0.5 * std::sin(2.0 * kPi * 0.4 * t)));
                if (s.which == 2 || s.which == 5) p.character = static_cast<st::Character>((block / 110) % 3);
                if (s.which == 3 || s.which == 5) p.lowBypassHz = static_cast<float>(20.0 * std::pow(100.0, 0.5 + 0.5 * std::sin(2.0 * kPi * 0.9 * t)));
                if (s.which == 4 || s.which == 5) p.variation = (block / 75) % 1000;
            });
            const double db = hfPeakDb(sideResidual(in, out), fs, from);
            worst = std::max(worst, db);
            std::cout << "  " << std::left << std::setw(8) << modeName(mode) << " " << std::setw(24) << s.name << std::right
                      << std::fixed << std::setprecision(1) << db << " dBFS  (switches " << c.engineSwitchCount() << ")\n";
            CHECK(db <= -90.0, "T5 " << modeName(mode) << " " << s.name << ": " << db << " dBFS > -90");
        }
    }
    std::cout << "  worst: " << std::fixed << std::setprecision(1) << worst << " dBFS\n";
}

// ─── T6 ──────────────────────────────────────────────────────────────────────
void testSampleRates()
{
    std::cout << "\n[StereoizeCore] T6 sample rates\n";
    double tauMs48 = 0.0, preMs48 = 0.0;
    for (double fs : { 44100.0, 48000.0, 96000.0, 192000.0 })
    {
        st::Core comb, diff, vel;
        for (auto* c : { &comb, &diff, &vel }) c->prepare(fs, 512);
        const int n = static_cast<int>(fs * 0.2);
        const Stereo in { whiteNoise(n, 31), whiteNoise(n, 32) };
        run(comb, in, 512, baseParams(st::Character::Comb, 100.0f, 17));
        run(diff, in, 512, baseParams(st::Character::Diffuse, 100.0f, 17));
        run(vel, in, 512, baseParams(st::Character::Velvet, 100.0f, 17));
        const double tauMs = comb.activeEngineInfo().combTauSamples * 1000.0 / fs;
        const double l0Ms = diff.activeEngineInfo().diffuseLength[0] * 1000.0 / fs;
        const double velMs = vel.activeEngineInfo().velvetLengthSamples * 1000.0 / fs;
        if (fs == 48000.0) { tauMs48 = tauMs; preMs48 = l0Ms; }
        std::cout << "  " << std::setw(6) << fs << " Hz: comb tau " << std::fixed << std::setprecision(3) << tauMs
                  << " ms, diffuse stage 1 " << l0Ms << " ms, velvet " << velMs << " ms\n";
        CHECK(std::fabs(velMs - 30.0) < 0.05, "T6 velvet length " << velMs << " ms at " << fs);

        const double db = monoNullDb(in, run(diff, in, 512, baseParams(st::Character::Diffuse, 180.0f, 3)));
        CHECK(db <= -120.0, "T6 mono null " << db << " dBFS at " << fs);
        const double err = testCorrelationCalibration(fs, false);
        std::cout << "          T2 worst error " << std::setprecision(3) << err << "\n";
        CHECK(err <= 0.05, "T6 correlation error " << err << " at " << fs);
    }
    // Same seed at every rate: the same time in ms (to one sample at 44.1 kHz).
    for (double fs : { 44100.0, 96000.0, 192000.0 })
    {
        st::Core comb, diff;
        comb.prepare(fs, 512);
        diff.prepare(fs, 512);
        const int n = 1024;
        const Stereo in { whiteNoise(n, 1), whiteNoise(n, 2) };
        run(comb, in, 512, baseParams(st::Character::Comb, 100.0f, 17));
        run(diff, in, 512, baseParams(st::Character::Diffuse, 100.0f, 17));
        const double tau = comb.activeEngineInfo().combTauSamples * 1000.0 / fs;
        const double l0 = diff.activeEngineInfo().diffuseLength[0] * 1000.0 / fs;
        CHECK(std::fabs(tau - tauMs48) < 1000.0 / 44100.0, "T6 comb tau " << tau << " ms at " << fs << " vs " << tauMs48);
        CHECK(std::fabs(l0 - preMs48) < 1000.0 / 44100.0, "T6 diffuse stage " << l0 << " ms at " << fs << " vs " << preMs48);
    }
}

// ─── T7 ──────────────────────────────────────────────────────────────────────
void testDenormals()
{
    std::cout << "\n[StereoizeCore] T7 denormals (1 s burst, 10 s silence)\n";
    const double fs = 48000.0;
    const int bs = 128;
    for (auto mode : kModes)
    {
        st::Core c;
        c.prepare(fs, bs);
        auto p = baseParams(mode, 200.0f);
        p.guard = 0.5f;
        p.hfDampHz = 5000.0f;
        p.sizeMs = 30.0f;
        Rng r(77);
        Sig l(bs), rr(bs);
        auto timeSecond = [&](bool loud) {
            const int blocks = static_cast<int>(fs / bs);
            const auto t0 = std::chrono::steady_clock::now();
            for (int b = 0; b < blocks; ++b)
            {
                for (int i = 0; i < bs; ++i)
                {
                    l[static_cast<std::size_t>(i)]  = loud ? r.bip() : 0.0f;
                    rr[static_cast<std::size_t>(i)] = loud ? r.bip() : 0.0f;
                }
                c.process(l.data(), rr.data(), bs, p);
            }
            return std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - t0).count();
        };
        const double loudMs = timeSecond(true);
        double worstSilent = 0.0;
        for (int s = 0; s < 10; ++s) worstSilent = std::max(worstSilent, timeSecond(false));
        float lastPeak = 0.0f;
        for (int i = 0; i < bs; ++i) lastPeak = std::max({ lastPeak, std::fabs(l[static_cast<std::size_t>(i)]), std::fabs(rr[static_cast<std::size_t>(i)]) });
        std::cout << "  " << std::left << std::setw(8) << modeName(mode) << std::right << " burst " << std::fixed << std::setprecision(2)
                  << loudMs << " ms/s, worst silent second " << worstSilent << " ms/s, final peak " << std::defaultfloat << lastPeak << "\n";
        CHECK(worstSilent <= std::max(2.0 * loudMs, loudMs + 5.0), "T7 silence costs more than the burst (" << modeName(mode) << ")");
        CHECK(lastPeak == 0.0f, "T7 output never reached exact zero (" << modeName(mode) << ")");
    }
}

// ─── T9 ──────────────────────────────────────────────────────────────────────
void testCpu()
{
    std::cout << "\n[StereoizeCore] T9 CPU: 64 instances, 48 kHz, 128-sample blocks, 5 s\n";
    const double fs = 48000.0;
    const int bs = 128, inst = 64;
    const int blocks = static_cast<int>(5.0 * fs / bs);
    for (auto mode : kModes)
    {
        std::vector<st::Core> cores(static_cast<std::size_t>(inst));
        std::vector<Sig> bufL(static_cast<std::size_t>(inst), Sig(bs)), bufR(static_cast<std::size_t>(inst), Sig(bs));
        for (auto& c : cores) c.prepare(fs, bs);
        Rng r(3);
        double ms = 0.0;
        for (int b = 0; b < blocks; ++b)
        {
            for (int k = 0; k < inst; ++k)
                for (int i = 0; i < bs; ++i)
                {
                    bufL[static_cast<std::size_t>(k)][static_cast<std::size_t>(i)] = r.bip() * 0.3f;
                    bufR[static_cast<std::size_t>(k)][static_cast<std::size_t>(i)] = r.bip() * 0.3f;
                }
            const auto t0 = std::chrono::steady_clock::now();
            for (int k = 0; k < inst; ++k)
            {
                auto p = baseParams(mode, 120.0f, k * 13);
                p.guard = 0.3f;
                cores[static_cast<std::size_t>(k)].process(bufL[static_cast<std::size_t>(k)].data(), bufR[static_cast<std::size_t>(k)].data(), bs, p);
            }
            ms += std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - t0).count();
        }
        const double pct = 100.0 * ms / 5000.0;
        std::cout << "  " << std::left << std::setw(8) << modeName(mode) << std::right << " " << std::fixed << std::setprecision(2)
                  << pct << " % of one core (" << (ms * 1e6 / (5.0 * fs * inst)) << " ns per sample per instance)\n";
        CHECK(pct < 50.0, "T9 " << modeName(mode) << " uses " << pct << " % of a core for 64 instances");
    }
}

// ─── T10 ─────────────────────────────────────────────────────────────────────
void testSeedDecorrelation()
{
    std::cout << "\n[StereoizeCore] T10 seed decorrelation (white noise, width 100)\n";
    const double fs = 48000.0;
    const int n = static_cast<int>(fs * 2.0);
    const Sig w = whiteNoise(n, 41);
    const Sig pk = pinkNoise(n, 42, fs);
    const std::size_t from = static_cast<std::size_t>(0.3 * fs);

    auto sideFor = [&](st::Character mode, int seed, const Sig& src, float lowBypass = 20.0f) {
        st::Core c;
        c.prepare(fs, 512);
        auto p = baseParams(mode, 100.0f, seed);
        p.lowBypassHz = lowBypass;
        const Stereo in { src, src };
        return sideResidual(in, run(c, in, 512, p));
    };

    Rng r(1234);
    for (auto mode : kModes)
    {
        double worstWhite = 0.0, worstPink = 0.0, worstPink150 = 0.0, sumWhite = 0.0;
        int over = 0;
        const int pairs = 40;
        for (int k = 0; k < pairs; ++k)
        {
            int a, b;
            if (mode == st::Character::Comb && k < 20) { a = k * 3; b = a + 1; }   // neighbouring seeds
            else { a = r.range(0, 999); do { b = r.range(0, 999); } while (b == a); }
            const double rw = std::fabs(correlation(sideFor(mode, a, w), sideFor(mode, b, w), from));
            const double rp = std::fabs(correlation(sideFor(mode, a, pk), sideFor(mode, b, pk), from));
            const double rp150 = std::fabs(correlation(sideFor(mode, a, pk, 150.0f), sideFor(mode, b, pk, 150.0f), from));
            worstWhite = std::max(worstWhite, rw);
            worstPink = std::max(worstPink, rp);
            worstPink150 = std::max(worstPink150, rp150);
            sumWhite += rw;
            if (rw >= 0.1) ++over;
        }
        std::cout << "  " << std::left << std::setw(8) << modeName(mode) << std::right << " white: mean " << std::fixed << std::setprecision(3)
                  << sumWhite / pairs << " worst " << worstWhite << " (" << over << "/" << pairs << " pairs >= 0.1); pink worst "
                  << worstPink << " (low bypass 20 Hz), " << worstPink150 << " (150 Hz default)\n";
        if (mode != st::Character::Comb)
            CHECK(worstWhite < 0.1, "T10 " << modeName(mode) << " seed pair side correlation " << worstWhite);
        else
            CHECK(over <= 4, "T10 Comb: " << over << " of 40 seed pairs correlate >= 0.1");
    }
}

// ─── Zero allocation ─────────────────────────────────────────────────────────
void testNoAllocation()
{
    std::cout << "\n[StereoizeCore] zero operator new in process()\n";
    const double fs = 48000.0;
    st::Core c;
    c.prepare(fs, 512);
    Rng r(8);
    Sig l(256), rr(256);
    g_allocCount = 0;
    g_allocArmed = true;
    for (int b = 0; b < 2000; ++b)
    {
        for (int i = 0; i < 256; ++i) { l[static_cast<std::size_t>(i)] = r.bip(); rr[static_cast<std::size_t>(i)] = r.bip(); }
        auto p = randomParams(r);   // forces engine switches (character / size / variation) most blocks
        p.monoCheck = (b & 64) != 0;
        p.compareDry = (b & 128) != 0;
        c.process(l.data(), rr.data(), 256, p);
        if (b % 500 == 0) c.reset();
    }
    g_allocArmed = false;
    std::cout << "  operator new calls: " << g_allocCount.load() << " (switches " << c.engineSwitchCount() << ")\n";
    CHECK(g_allocCount.load() == 0, "process()/reset() allocated " << g_allocCount.load() << " times");
}

// ─── Switch behaviour ────────────────────────────────────────────────────────
void testSwitching()
{
    std::cout << "\n[StereoizeCore] engine switching\n";
    const double fs = 48000.0;
    for (auto to : kModes)
    {
        st::Core c;
        c.prepare(fs, 64);
        const st::Character from = to == st::Character::Diffuse ? st::Character::Velvet : st::Character::Diffuse;
        Sig l(64), r(64);
        Rng rng(4);
        auto p = baseParams(from, 100.0f);
        for (int b = 0; b < 100; ++b)
        {
            for (int i = 0; i < 64; ++i) { l[static_cast<std::size_t>(i)] = rng.bip(); r[static_cast<std::size_t>(i)] = rng.bip(); }
            c.process(l.data(), r.data(), 64, p);
        }
        p.character = to;
        int samples = 0;
        bool started = false;
        while (samples < static_cast<int>(fs))
        {
            for (int i = 0; i < 64; ++i) { l[static_cast<std::size_t>(i)] = rng.bip(); r[static_cast<std::size_t>(i)] = rng.bip(); }
            c.process(l.data(), r.data(), 64, p);
            samples += 64;
            started = started || c.switchInProgress();
            if (started && !c.switchInProgress()) break;
        }
        const auto info = c.activeEngineInfo();
        const double ms = samples * 1000.0 / fs;
        std::cout << "  " << modeName(from) << " -> " << modeName(to) << ": done in " << std::fixed << std::setprecision(1) << ms
                  << " ms (pre-roll " << info.preRollSamples * 1000.0 / fs << " ms + fade " << c.fadeSamples() * 1000.0 / fs << " ms)\n";
        CHECK(info.character == to, "switch to " << modeName(to) << " did not complete");
        CHECK(c.engineSwitchCount() == 1, "expected exactly one switch, got " << c.engineSwitchCount());
        CHECK(ms <= 260.0, "switch to " << modeName(to) << " took " << ms << " ms");
    }

    // A change back during the pre-roll cancels the switch without anything being heard.
    {
        st::Core c;
        c.prepare(fs, 64);
        Sig l(64, 0.1f), r(64, -0.1f);
        auto p = baseParams(st::Character::Comb, 100.0f);
        c.process(l.data(), r.data(), 64, p);
        p.character = st::Character::Diffuse;
        c.process(l.data(), r.data(), 64, p);
        c.process(l.data(), r.data(), 64, p);
        const bool wasSwitching = c.switchInProgress();
        p.character = st::Character::Comb;
        c.process(l.data(), r.data(), 64, p);
        c.process(l.data(), r.data(), 64, p);
        CHECK(wasSwitching && !c.switchInProgress() && c.engineSwitchCount() == 0, "a reverted change during pre-roll was not cancelled");
    }
}

// ─── Transient Guard ─────────────────────────────────────────────────────────
void testGuard()
{
    std::cout << "\n[StereoizeCore] Transient Guard\n";
    const double fs = 48000.0;
    const int bs = 32;

    // Onset after silence: the duck must bite within 2 ms.
    {
        st::Core c;
        c.prepare(fs, bs);
        auto p = baseParams(st::Character::Velvet, 100.0f);
        p.guard = 1.0f;
        Sig l(bs), r(bs);
        for (int b = 0; b < 200; ++b) { std::fill(l.begin(), l.end(), 0.0f); std::fill(r.begin(), r.end(), 0.0f); c.process(l.data(), r.data(), bs, p); }
        Rng rng(6);
        float depth = 0.0f;
        for (int b = 0; b < 3; ++b)   // 96 samples = 2 ms
        {
            for (int i = 0; i < bs; ++i) { const float v = rng.bip() * 0.8f; l[static_cast<std::size_t>(i)] = v; r[static_cast<std::size_t>(i)] = v; }
            c.process(l.data(), r.data(), bs, p);
            depth = std::max(depth, c.meters().guardDepth);
        }
        std::cout << "  onset after silence: duck depth " << std::fixed << std::setprecision(2) << depth << " within 2 ms\n";
        CHECK(depth >= 0.7f, "guard did not duck an onset (depth " << depth << ")");
    }
    // Sustained low tone: no pumping.
    {
        st::Core c;
        c.prepare(fs, bs);
        auto p = baseParams(st::Character::Diffuse, 100.0f);
        p.guard = 1.0f;
        Sig l(bs), r(bs);
        double t = 0.0;
        float worst = 0.0f;
        for (int b = 0; b < static_cast<int>(2.0 * fs / bs); ++b)
        {
            for (int i = 0; i < bs; ++i, t += 1.0 / fs)
            {
                const float v = static_cast<float>(0.5 * std::sin(2.0 * kPi * 60.0 * t) + 0.2 * std::sin(2.0 * kPi * 440.0 * t));
                l[static_cast<std::size_t>(i)] = v;
                r[static_cast<std::size_t>(i)] = v;
            }
            c.process(l.data(), r.data(), bs, p);
            if (t > 0.5) worst = std::max(worst, c.meters().guardDepth);
        }
        std::cout << "  sustained 60 + 440 Hz: worst duck depth " << std::fixed << std::setprecision(3) << worst << "\n";
        CHECK(worst <= 0.1f, "guard pumps on a sustained tone (depth " << worst << ")");
    }
}

// ─── Monitors, loudness, edge cases ──────────────────────────────────────────
void testMonitorsAndLoudness()
{
    std::cout << "\n[StereoizeCore] monitors, loudness match, edge cases\n";
    const double fs = 48000.0;
    const int n = static_cast<int>(fs * 2.0);
    const Sig w = whiteNoise(n, 51);
    const Stereo in { w, w };
    const std::size_t from = static_cast<std::size_t>(0.6 * fs);

    auto power = [&](const Stereo& s) {
        double e = 0;
        for (std::size_t i = from; i < s.l.size(); ++i) e += static_cast<double>(s.l[i]) * s.l[i] + static_cast<double>(s.r[i]) * s.r[i];
        return e;
    };

    for (float width : { 100.0f, 200.0f })
    {
        st::Core plain, matched;
        plain.prepare(fs, 512);
        matched.prepare(fs, 512);
        auto p = baseParams(st::Character::Diffuse, width);
        p.lowBypassHz = 20.0f;
        const auto o1 = run(plain, in, 512, p);
        p.loudnessMatch = true;
        const auto o2 = run(matched, in, 512, p);
        const double gainDb = 10.0 * std::log10(power(o1) / power(in));
        const double matchDb = 10.0 * std::log10(power(o2) / power(in));
        const double g = st::widthToGain(width);
        std::cout << "  width " << static_cast<int>(width) << ": stereo +" << std::fixed << std::setprecision(2) << gainDb
                  << " dB (theory +" << 10.0 * std::log10(1.0 + g * g) << "), loudness match " << std::showpos << matchDb << std::noshowpos << " dB\n";
        CHECK(std::fabs(gainDb - 10.0 * std::log10(1.0 + g * g)) < 0.3, "stereo gain off theory at width " << width);
        CHECK(std::fabs(matchDb) < 0.3, "loudness match leaves " << matchDb << " dB at width " << width);
    }

    // Mono check: both sides carry the mono sum.
    {
        st::Core c;
        c.prepare(fs, 512);
        auto p = baseParams(st::Character::Comb, 160.0f);
        p.monoCheck = true;
        const Stereo st2 { whiteNoise(n, 52), whiteNoise(n, 53) };
        const auto o = run(c, st2, 512, p);
        double worst = 0.0;
        for (std::size_t i = 1000; i < o.l.size(); ++i)
        {
            worst = std::max(worst, static_cast<double>(std::fabs(o.l[i] - o.r[i])));
            worst = std::max(worst, std::fabs(o.l[i] - 0.5 * (static_cast<double>(st2.l[i]) + st2.r[i])));
        }
        CHECK(worst < 1e-6, "mono check output is not the mono sum (" << worst << ")");
    }

    // Dry compare: the dry input, raised to the processed loudness.
    {
        st::Core c;
        c.prepare(fs, 512);
        auto p = baseParams(st::Character::Diffuse, 100.0f);
        p.lowBypassHz = 20.0f;
        run(c, in, 512, p);   // let the level match settle on the processed signal
        p.compareDry = true;
        Stereo o = in;
        for (int off = 0; off < n; off += 512) c.process(o.l.data() + off, o.r.data() + off, std::min(512, n - off), p);
        const double ratioDb = 10.0 * std::log10(power(o) / power(in));
        std::cout << "  dry compare at width 100: dry raised " << std::fixed << std::setprecision(2) << ratioDb << " dB (meter "
                  << c.meters().dryMatchGainDb << " dB)\n";
        CHECK(std::fabs(ratioDb - 3.01) < 0.5, "dry compare level match " << ratioDb << " dB, expected about +3 dB");
        CHECK(correlation(o.l, o.r, from) > 0.999, "dry compare is not the (mono) dry signal");
    }

    // Mono stream: left is untouched.
    {
        st::Core c;
        c.prepare(fs, 512);
        Sig l = whiteNoise(512, 61);
        const Sig orig = l;
        c.process(l.data(), nullptr, 512, baseParams(st::Character::Velvet, 200.0f));
        CHECK(l == orig, "a mono stream was modified");
    }

    // A non-finite input sample does not poison the history.
    {
        st::Core c;
        c.prepare(fs, 64);
        Stereo s { whiteNoise(48000, 71), whiteNoise(48000, 72) };
        s.l[100] = std::numeric_limits<float>::quiet_NaN();
        const auto o = run(c, s, 64, baseParams(st::Character::Diffuse, 150.0f));
        bool finite = true;
        for (std::size_t i = 200; i < o.l.size(); ++i) finite = finite && std::isfinite(o.l[i]) && std::isfinite(o.r[i]);
        CHECK(finite, "a NaN input sample left the output non-finite");
    }

    // Meters agree with a direct measurement.
    {
        st::Core c;
        c.prepare(fs, 512);
        const auto o = run(c, in, 512, baseParams(st::Character::Diffuse, 100.0f));
        const double direct = correlation(o.l, o.r, o.l.size() - static_cast<std::size_t>(0.3 * fs));
        std::cout << "  correlation meter " << std::fixed << std::setprecision(3) << c.meters().correlation << " vs direct " << direct
                  << ", target " << c.meters().targetCorrelation << "\n";
        CHECK(std::fabs(c.meters().correlation - direct) < 0.1, "correlation meter disagrees with the signal");
        CHECK(std::fabs(c.meters().targetCorrelation) < 1e-6f, "target correlation at width 100 is not 0");
    }
}

} // namespace

void testCosineIntegral()
{
    std::cout << "\n[StereoizeCore] cosine integral / pink autocorrelation\n";
    struct Ref { double x, ci; };
    const Ref refs[] = { { 0.5, -0.17778407880661290 }, { 1.0, 0.33740392290096813 }, { 2.0, 0.42298082877486500 },
                         { 3.0, 0.11962978600800032 }, { 4.0, -0.14098169788693041 }, { 5.0, -0.19002974965664387 },
                         { 10.0, -0.04545643300445537 }, { 20.0, 0.04441982084535332 } };
    double worst = 0.0;
    for (const auto& r : refs) worst = std::max(worst, std::fabs(st::detail::cosineIntegral(r.x) - r.ci));
    // The two branches meet at x = 4.
    worst = std::max(worst, std::fabs(st::detail::cosineIntegral(4.0 - 1e-9) - st::detail::cosineIntegral(4.0)));
    std::cout << "  worst |Ci - reference| " << std::scientific << std::setprecision(2) << worst << std::defaultfloat << "\n";
    CHECK(worst < 2e-6, "cosine integral error " << worst);

    // The 1/f autocorrelation against a brute-force sum of cosines over log frequency.
    double worstR = 0.0;
    for (double tauMs : { 0.05, 0.3, 1.0, 4.0 })
    {
        const int K = 400000;
        double acc = 0.0;
        for (int k = 0; k < K; ++k)
        {
            const double f = 40.0 * std::pow(500.0, (k + 0.5) / K);
            acc += std::cos(2.0 * kPi * f * tauMs * 1e-3);
        }
        worstR = std::max(worstR, std::fabs(acc / K - st::detail::pinkAutocorrelation(tauMs * 1e-3, 40.0, 20000.0)));
    }
    std::cout << "  worst |r - brute force| " << std::scientific << std::setprecision(2) << worstR << std::defaultfloat << "\n";
    CHECK(worstR < 1e-4, "pink autocorrelation error " << worstR);
}

int main()
{
    juce::ScopedNoDenormals noDenormals;
    std::cout << "[StereoizeCore] test_stereoize_core\n";

    testCosineIntegral();

    testMonoNull();

    std::cout << "\n[StereoizeCore] T2 correlation calibration (pink noise > 40 Hz, mono input, 8 seeds)\n";
    const double err = testCorrelationCalibration(48000.0, true);
    std::cout << "  worst error " << std::fixed << std::setprecision(3) << err << "\n";
    CHECK(err <= 0.05, "T2 correlation error " << err << " > 0.05");

    testBlockSizeIndependence();
    testZipper();
    testSampleRates();
    testDenormals();
    testCpu();
    testSeedDecorrelation();
    testNoAllocation();
    testSwitching();
    testGuard();
    testMonitorsAndLoudness();

    std::cout << "\n[StereoizeCore] " << g_passed << " passed, " << g_failed << " failed\n";
    if (g_failed == 0) std::cout << "[StereoizeCore] ALL TESTS PASSED\n";
    return g_failed == 0 ? 0 : 1;
}
