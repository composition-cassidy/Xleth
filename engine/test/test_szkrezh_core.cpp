// test_szkrezh_core.cpp — xleth::dsp::szkrezh::Core, the DSP behind the Szkrezh stock effect.
// Build: cmake --build build --config Release --target test_szkrezh_core
// Run:   ctest --test-dir build -C Release -R "^test_szkrezh_core$" -V
// Pass:  prints "[SzkrezhCore] ALL TESTS PASSED" and exits 0.
//
// From the research doc's verification plan (xleth-crystal-shift-research.md section 12):
//   T1  identity: Forward, unity pitch, no recycle/filters = input delayed by D + m + H + X
//   T2  reverse impulse: nothing before the first splice after the click, then the click reversed
//   T3  staircase: a 440 Hz burst at +1200 with recycle climbs 880 -> 1760 -> 3520, later and darker
//   T4  aliasing at +1200: Vintage vs Clean, an input that folds to an audible frequency
//   T5  runaway: max recycle at +3600 on noise stays bounded and finite
//   T6  zipper: a pitch change mid-grain changes nothing until the next splice
//   T7  determinism: block sizes 512 / 64 / 1 / random render bit-identical (several configurations)
// XLETH-only:
//   T8  transport-locked splice grid: free, sync, bar cut, start-position independence, R offset
//   T9  skipped blocks while idle render the same samples as processing them
//   T10 Harmony pitch from host notes; T11 Keys pitch (own track, other track, chords, retrigger)
// Plus: T12 gate/duck, T13 freeze, T14 tail hold, T15 zero operator new, T16 CPU, T17 harmony maths.

#include "dsp/szkrezh/SzkrezhCore.h"

#include <algorithm>
#include <atomic>
#include <chrono>
#include <cmath>
#include <cstdint>
#include <cstdlib>
#include <cstring>
#include <functional>
#include <iomanip>
#include <iostream>
#include <new>
#include <random>
#include <string>
#include <utility>
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

using namespace xleth::dsp::szkrezh;

namespace
{
constexpr double kSR = 48000.0;
constexpr double kPi = 3.14159265358979323846;

struct Rng
{
    std::uint32_t s;
    explicit Rng(std::uint32_t seed) : s(seed ? seed : 1u) {}
    float bip()
    {
        s ^= s << 13; s ^= s >> 17; s ^= s << 5;
        return static_cast<float>(s & 0x00FFFFFFu) / 16777215.0f * 2.0f - 1.0f;
    }
};

std::vector<float> noise(int n, std::uint32_t seed, float amp = 0.4f)
{
    std::vector<float> v(static_cast<std::size_t>(n));
    Rng r(seed);
    for (auto& x : v) x = r.bip() * amp;
    return v;
}

std::vector<float> sine(int n, double hz, float amp, int from = 0, int to = -1)
{
    std::vector<float> v(static_cast<std::size_t>(n), 0.0f);
    if (to < 0) to = n;
    for (int i = from; i < to; ++i)
        v[static_cast<std::size_t>(i)] = amp * static_cast<float>(std::sin(2.0 * kPi * hz * i / kSR));
    return v;
}

double amplitudeAt(const float* x, int n, double hz, double sr = kSR)
{
    const double w = 2.0 * kPi * hz / sr, c = 2.0 * std::cos(w);
    double s1 = 0.0, s2 = 0.0;
    for (int i = 0; i < n; ++i)
    {
        const double s = static_cast<double>(x[i]) + c * s1 - s2;
        s2 = s1; s1 = s;
    }
    const double power = s1 * s1 + s2 * s2 - c * s1 * s2;
    return 2.0 * std::sqrt(std::max(0.0, power)) / static_cast<double>(n);
}

double db(double x) { return 20.0 * std::log10(std::max(x, 1e-30)); }

// Bypassed tone filters, wet only, no recycle: the bare grain engine.
Params bare()
{
    Params p;
    p.pitchSource = PitchSource::Knob;
    p.pitchCents  = 1200.0f;
    p.sync        = false;
    p.spliceMs    = 500.0f;
    p.smoothingMs = 20.0f;
    p.delayMs     = 0.0f;
    p.reverse     = true;
    p.recycle     = 0.0f;
    p.lowCutHz    = 0.0f;
    p.highCutHz   = 1e9f;
    p.mix         = 1.0f;
    p.dynAmount   = 0.0f;
    return p;
}

struct Timeline
{
    std::vector<std::pair<std::int64_t, int>> host, keys;   // (sample offset from the run start, note), sorted
};

struct RunOpts
{
    std::int64_t start        = 0;
    double       bpm          = 140.0;
    bool         keysFromHost = true;
    const Timeline* notes     = nullptr;
    std::function<int(std::int64_t)>             blockSize;   // by block index; default 512
    std::function<void(std::int64_t, Params&)>   hook;        // per block, before setParams
    std::function<bool(std::int64_t, int)>       skip;        // true: skip the block (output 0)
    std::function<void(std::int64_t, int)>       after;       // after each processed block
    bool         countAllocs  = false;
};

struct Stereo
{
    std::vector<float> L, R;
};

Stereo run(Core& core, Params p, const std::vector<float>& inL, const std::vector<float>& inR, const RunOpts& o = {})
{
    const auto total = static_cast<std::int64_t>(inL.size());
    Stereo out;
    out.L.assign(inL.size(), 0.0f);
    out.R.assign(inR.size(), 0.0f);
    std::vector<NoteEvent> hn, kn;
    hn.reserve(4096);
    kn.reserve(4096);

    std::int64_t i = 0, bi = 0;
    while (i < total)
    {
        int n = o.blockSize ? o.blockSize(bi) : 512;
        n = static_cast<int>(std::min<std::int64_t>(std::max(n, 1), total - i));
        ++bi;
        const std::int64_t pos = o.start + i;
        if (o.hook) o.hook(pos, p);
        if (o.skip && o.skip(pos, n)) { i += n; continue; }

        hn.clear();
        kn.clear();
        if (o.notes)
        {
            for (const auto& e : o.notes->host)
            {
                const std::int64_t at = o.start + e.first;
                if (at >= pos && at < pos + n) hn.push_back({ static_cast<int>(at - pos), e.second });
            }
            for (const auto& e : o.notes->keys)
            {
                const std::int64_t at = o.start + e.first;
                if (at >= pos && at < pos + n) kn.push_back({ static_cast<int>(at - pos), e.second });
            }
        }
        std::copy(inL.begin() + i, inL.begin() + i + n, out.L.begin() + i);
        std::copy(inR.begin() + i, inR.begin() + i + n, out.R.begin() + i);

        BlockContext ctx;
        ctx.transportPos = pos;
        ctx.bpm          = o.bpm;
        ctx.barBeats     = 4.0;
        ctx.hostNotes    = hn.data();
        ctx.numHostNotes = static_cast<int>(hn.size());
        ctx.keyNotes     = kn.data();
        ctx.numKeyNotes  = static_cast<int>(kn.size());
        ctx.keysFromHost = o.keysFromHost;

        if (o.countAllocs) g_allocArmed.store(true);
        core.setParams(p);
        core.process(&out.L[static_cast<std::size_t>(i)], &out.R[static_cast<std::size_t>(i)], n, ctx);
        if (o.countAllocs) g_allocArmed.store(false);
        if (o.after) o.after(pos, n);
        i += n;
    }
    return out;
}

Stereo runFresh(Params p, const std::vector<float>& inL, const std::vector<float>& inR, const RunOpts& o = {}, double sr = kSR)
{
    Core core;
    core.setParams(p);
    core.prepare(sr);
    return run(core, p, inL, inR, o);
}

std::vector<SpawnRecord> spawns(const Core& core, int channel = -1)
{
    std::vector<SpawnRecord> v;
    const std::int64_t total = core.spawnCount();
    for (std::int64_t i = std::max<std::int64_t>(0, total - Core::kSpawnLogSize); i < total; ++i)
    {
        const SpawnRecord r = core.spawn(i);
        if (channel < 0 || r.channel == channel) v.push_back(r);
    }
    return v;
}

bool sameBits(const Stereo& a, const Stereo& b)
{
    return a.L.size() == b.L.size()
        && std::memcmp(a.L.data(), b.L.data(), a.L.size() * sizeof(float)) == 0
        && std::memcmp(a.R.data(), b.R.data(), a.R.size() * sizeof(float)) == 0;
}

std::int64_t ceilAt(double x) { return static_cast<std::int64_t>(std::ceil(x - 1e-6)); }
} // namespace

// ─── T1 identity ─────────────────────────────────────────────────────────────
static void testIdentity()
{
    std::cout << "\n[SzkrezhCore] T1 identity (Forward, 0 ct, no recycle, filters off)\n";
    for (double sr : { 44100.0, 48000.0, 96000.0 })
    {
        Params p = bare();
        p.reverse     = false;
        p.pitchCents  = 0.0f;
        p.spliceMs    = 500.0f;
        p.smoothingMs = 20.0f;
        p.delayMs     = 250.0f;
        const int n = static_cast<int>(3.0 * sr);
        const auto inL = noise(n, 11), inR = noise(n, 12);
        Core core;
        core.setParams(p);
        core.prepare(sr);
        const Stereo out = run(core, p, inL, inR);

        const int H = static_cast<int>(std::lround(0.5 * sr));
        const int X = static_cast<int>(std::floor(0.020 * sr));
        const int D = static_cast<int>(std::lround(0.25 * sr));
        const int L = D + 4 + H + X;   // Delay + Hermite margin + one grain
        double maxErr = 0.0, preMax = 0.0;
        for (int i = 0; i < n; ++i)
        {
            if (i < L) { preMax = std::max(preMax, std::fabs(static_cast<double>(out.L[i]))); continue; }
            maxErr = std::max(maxErr, std::fabs(static_cast<double>(out.L[i]) - inL[i - L]));
            maxErr = std::max(maxErr, std::fabs(static_cast<double>(out.R[i]) - inR[i - L]));
        }
        std::cout << "  sr " << sr << ": delay " << L << " samples, residual " << std::fixed << std::setprecision(1)
                  << db(maxErr) << " dBFS, before onset " << db(preMax) << " dBFS\n";
        CHECK(preMax == 0.0, "T1 silent before D + m + H + X at sr " << sr);
        CHECK(maxErr < 1e-5, "T1 residual below -100 dB at sr " << sr << " (" << db(maxErr) << " dB)");
    }
}

// ─── T2 reverse impulse ──────────────────────────────────────────────────────
static void testReverseImpulse()
{
    std::cout << "\n[SzkrezhCore] T2 reverse impulse\n";
    Params p = bare();
    p.reverse    = true;
    p.pitchCents = 1200.0f;
    p.spliceMs   = 200.0f;   // 9600 samples
    const int n = 80000, click = 30000;
    std::vector<float> in(static_cast<std::size_t>(n), 0.0f);
    in[click] = 1.0f;
    const Stereo out = runFresh(p, in, in);

    const int nextSplice = 38400;                       // first boundary after the click
    const int heard = nextSplice + (nextSplice - 4 - click) / 2;   // head moves back 2 per sample
    double before = 0.0, gap = 0.0, at = 0.0;
    for (int i = 0; i < nextSplice; ++i) before = std::max(before, std::fabs(static_cast<double>(out.L[i])));
    for (int i = nextSplice; i < heard - 2; ++i) gap = std::max(gap, std::fabs(static_cast<double>(out.L[i])));
    for (int i = heard - 2; i < heard + 100; ++i) at = std::max(at, std::fabs(static_cast<double>(out.L[i])));
    std::cout << "  before splice " << db(before) << " dB, splice->arrival " << db(gap) << " dB, at " << heard
              << ": " << db(at) << " dB\n";
    CHECK(before == 0.0, "T2 nothing before the first splice after the click");
    CHECK(gap < 1e-6, "T2 nothing between the splice and the reversed click's arrival");
    CHECK(at > 0.05, "T2 the reversed click arrives where the head reaches it");
}

// ─── T3 staircase ────────────────────────────────────────────────────────────
static void testStaircase()
{
    std::cout << "\n[SzkrezhCore] T3 recycle staircase (440 Hz burst, +1200, recycle 60 %)\n";
    Params p = bare();
    p.reverse    = true;
    p.pitchCents = 1200.0f;
    p.spliceMs   = 200.0f;
    p.delayMs    = 300.0f;
    p.recycle    = 0.6f;
    p.lowCutHz   = 80.0f;
    p.highCutHz  = 20000.0f;
    const int n = static_cast<int>(6.0 * kSR);
    const auto in = sine(n, 440.0, 0.5f, 0, static_cast<int>(0.15 * kSR));
    const Stereo out = runFresh(p, in, in);

    const int win = static_cast<int>(0.05 * kSR);
    const double freqs[] = { 440.0, 880.0, 1760.0, 3520.0 };
    double peakAmp[4] = {}, centroid[4] = {}, energy[4] = {};
    for (int w = 0; w + win <= n; w += win / 2)
        for (int f = 0; f < 4; ++f)
        {
            const double a = amplitudeAt(&out.L[w], win, freqs[f]);
            peakAmp[f] = std::max(peakAmp[f], a);
            centroid[f] += a * a * (w + win / 2) / kSR;
            energy[f]   += a * a;
        }
    for (int f = 0; f < 4; ++f)
    {
        centroid[f] /= std::max(energy[f], 1e-30);
        std::cout << "  " << std::setw(5) << freqs[f] << " Hz peak " << std::setprecision(1) << db(peakAmp[f])
                  << " dB, centre " << std::setprecision(2) << centroid[f] << " s\n";
    }
    CHECK(centroid[1] < centroid[2] && centroid[2] < centroid[3], "T3 each octave arrives later than the one below");
    CHECK(peakAmp[1] > peakAmp[2] && peakAmp[2] > peakAmp[3], "T3 each repeat is quieter than the one before");
    CHECK(peakAmp[3] > 0.005, "T3 the third repeat (3520 Hz) is there");
    CHECK(peakAmp[0] < 0.1 * peakAmp[1], "T3 no unshifted 440 Hz in the wet signal");
}

// ─── T4 aliasing ─────────────────────────────────────────────────────────────
static void testAliasing()
{
    std::cout << "\n[SzkrezhCore] T4 aliasing at +1200: a 20 kHz input folds to 8 kHz\n";
    const int n = static_cast<int>(2.0 * kSR);
    const auto in = sine(n, 20000.0, 0.5f);
    double alias[2] = {};
    for (int q = 0; q < 2; ++q)
    {
        Params p = bare();
        p.reverse     = true;
        p.pitchCents  = 1200.0f;
        p.spliceMs    = 100.0f;
        p.smoothingMs = 10.0f;
        p.quality     = q == 0 ? Quality::Vintage : Quality::Clean;
        const Stereo out = runFresh(p, in, in);
        const int from = static_cast<int>(0.5 * kSR), len = static_cast<int>(1.0 * kSR);
        alias[q] = amplitudeAt(&out.L[from], len, 8000.0) / 0.5;
    }
    std::cout << "  8 kHz alias re input: Vintage " << std::setprecision(1) << db(alias[0]) << " dB, Clean "
              << db(alias[1]) << " dB\n";
    CHECK(alias[1] < std::pow(10.0, -60.0 / 20.0), "T4 Clean keeps the audible alias below -60 dB");
    CHECK(alias[1] < alias[0] * 0.01, "T4 Clean is at least 40 dB cleaner than Vintage");

    // The in-band signal survives Clean: 3 kHz at +1200 -> 6 kHz.
    Params p = bare();
    p.reverse = true; p.spliceMs = 100.0f; p.smoothingMs = 10.0f; p.quality = Quality::Clean;
    const auto in3 = sine(n, 3000.0, 0.5f);
    const Stereo out = runFresh(p, in3, in3);
    const double kept = amplitudeAt(&out.L[static_cast<int>(0.5 * kSR)], static_cast<int>(kSR), 6000.0) / 0.5;
    std::cout << "  Clean passband: 3 kHz -> 6 kHz at " << db(kept) << " dB\n";
    CHECK(kept > std::pow(10.0, -6.0 / 20.0), "T4 Clean passes the shifted in-band tone");
}

// ─── T5 runaway ──────────────────────────────────────────────────────────────
static void testRunaway()
{
    std::cout << "\n[SzkrezhCore] T5 runaway: recycle 100 %, +3600, 20 s of noise\n";
    for (int q = 0; q < 2; ++q)
    {
        Params p;   // defaults: tone filters on
        p.pitchCents = 3600.0f;
        p.recycle    = 1.0f;
        p.sync       = true;
        p.spliceDiv  = 4;   // 1/16
        p.mix        = 1.0f;
        p.quality    = q == 0 ? Quality::Vintage : Quality::Clean;
        const int n = static_cast<int>(20.0 * kSR);
        const auto inL = noise(n, 21, 0.5f), inR = noise(n, 22, 0.5f);
        const Stereo out = runFresh(p, inL, inR);
        double peak = 0.0;
        bool finite = true;
        for (int i = 0; i < n; ++i)
        {
            finite = finite && std::isfinite(out.L[i]) && std::isfinite(out.R[i]);
            peak = std::max({ peak, std::fabs(static_cast<double>(out.L[i])), std::fabs(static_cast<double>(out.R[i])) });
        }
        std::cout << "  " << (q ? "Clean  " : "Vintage") << " peak " << std::setprecision(2) << peak << "\n";
        CHECK(finite, "T5 output stays finite");
        CHECK(peak < 4.0, "T5 output stays bounded (" << peak << ")");
    }
}

// ─── T6 per-grain latching ───────────────────────────────────────────────────
static void testLatching()
{
    std::cout << "\n[SzkrezhCore] T6 a pitch change mid-grain waits for the next splice\n";
    Params p = bare();
    p.spliceMs = 300.0f;   // boundaries every 14400
    const int n = 60000;
    const auto in = noise(n, 31);
    const Stereo a = runFresh(p, in, in);
    RunOpts o;
    o.blockSize = [](std::int64_t) { return 500; };
    o.hook = [](std::int64_t pos, Params& q) { if (pos >= 20000) q.pitchCents = 700.0f; };
    Core core;
    core.setParams(p);
    core.prepare(kSR);
    const Stereo b = run(core, p, in, in, o);

    int firstDiff = -1;
    for (int i = 0; i < n && firstDiff < 0; ++i)
        if (a.L[i] != b.L[i]) firstDiff = i;
    std::cout << "  change at 20000, first output difference at " << firstDiff << " (next splice 28800, fade-in starts at 0)\n";
    CHECK(firstDiff == 28801, "T6 output identical through the next splice, different right after it");
    bool latched = false;
    for (const auto& s : spawns(core, 0))
        if (s.pos == 28800) latched = std::fabs(s.cents - 700.0f) < 1e-3f;
    CHECK(latched, "T6 the grain at 28800 latched the new pitch");
}

// ─── T7 block-size independence ──────────────────────────────────────────────
static void testBlockSizes()
{
    std::cout << "\n[SzkrezhCore] T7 block sizes 512 / 64 / 1 / random are bit-identical\n";
    const int n = static_cast<int>(1.5 * kSR);
    const auto inL = noise(n, 41), inR = noise(n, 42);
    Timeline tl;
    tl.host = { { 0, 60 }, { 9000, 64 }, { 30000, 67 }, { 30100, 71 }, { 52000, 62 } };
    tl.keys = { { 5000, 64 }, { 5200, 69 }, { 40000, 72 } };

    struct Config { const char* name; std::function<void(Params&)> set; bool keysFromHost; };
    const Config configs[] = {
        { "Reverse +700, sync 1/8, ping-pong, duck, offsets", [](Params& p) {
              p.pitchCents = 700.0f; p.pitchOffsetCents = 30.0f; p.sync = true; p.spliceDiv = 7; p.delayDiv = 4;
              p.spliceOffset = 0.25f; p.delayOffset = 0.1f; p.recycle = 0.7f; p.fbMode = FeedbackMode::PingPong;
              p.dynAmount = 0.5f; p.dynThresholdDb = -12.0f; p.lowCutHz = 120.0f; p.highCutHz = 9000.0f; p.mix = 0.6f; },
          true },
        { "Forward -500, free 137 ms, mixed, gate, Clean", [](Params& p) {
              p.reverse = false; p.pitchCents = -500.0f; p.spliceMs = 137.0f; p.smoothingMs = 31.0f; p.delayMs = 23.0f;
              p.recycle = 0.5f; p.fbMode = FeedbackMode::Mixed; p.dynAmount = -0.7f; p.dynTarget = DynTarget::Both;
              p.quality = Quality::Clean; p.lowCutHz = 80.0f; p.highCutHz = 15000.0f; },
          true },
        { "Harmony, minor +3, sync 1/4D", [](Params& p) {
              p.pitchSource = PitchSource::Harmony; p.key = 9; p.scale = 1; p.harmonySteps = 3; p.sync = true;
              p.spliceDiv = 12; p.recycle = 0.4f; p.lowCutHz = 80.0f; p.highCutHz = 20000.0f; },
          true },
        { "Keys from another track, Clean", [](Params& p) {
              p.pitchSource = PitchSource::Keys; p.sync = true; p.spliceDiv = 10; p.recycle = 0.3f;
              p.quality = Quality::Clean; p.lowCutHz = 80.0f; p.highCutHz = 20000.0f; },
          false },
    };

    for (const auto& cfg : configs)
    {
        Params p = bare();
        cfg.set(p);
        auto render = [&](std::function<int(std::int64_t)> bs) {
            RunOpts o;
            o.notes = &tl;
            o.keysFromHost = cfg.keysFromHost;
            o.start = 1234567;   // not on any grid
            o.blockSize = std::move(bs);
            return runFresh(p, inL, inR, o);
        };
        const Stereo ref = render([](std::int64_t) { return 512; });
        const Stereo s64 = render([](std::int64_t) { return 64; });
        const Stereo s1  = render([](std::int64_t) { return 1; });
        std::mt19937 rng(5);
        std::uniform_int_distribution<int> d(1, 1000);
        const Stereo sr  = render([&](std::int64_t) { return d(rng); });
        double energy = 0.0;
        for (float x : ref.L) energy += static_cast<double>(x) * x;
        std::cout << "  " << cfg.name << ": 64 " << (sameBits(ref, s64) ? "same" : "DIFF") << ", 1 "
                  << (sameBits(ref, s1) ? "same" : "DIFF") << ", random " << (sameBits(ref, sr) ? "same" : "DIFF") << "\n";
        CHECK(energy > 1.0, "T7 " << cfg.name << ": produces output");
        CHECK(sameBits(ref, s64), "T7 " << cfg.name << ": 64-sample blocks bit-identical to 512");
        CHECK(sameBits(ref, s1), "T7 " << cfg.name << ": 1-sample blocks bit-identical to 512");
        CHECK(sameBits(ref, sr), "T7 " << cfg.name << ": random blocks bit-identical to 512");
    }
}

// ─── T8 transport-locked grid ────────────────────────────────────────────────
static void testGrid()
{
    std::cout << "\n[SzkrezhCore] T8 splice grid is a function of the transport position\n";
    const int n = static_cast<int>(8.0 * kSR);
    const auto in = noise(n, 51);

    // (a) Free, fractional hop, started off-grid.
    {
        Params p = bare();
        p.spliceMs = 333.3f;
        const double hop = static_cast<double>(333.3f) * 1e-3 * kSR;
        RunOpts o;
        o.start = 12345;
        o.blockSize = [](std::int64_t) { return 333; };
        Core core; core.setParams(p); core.prepare(kSR);
        run(core, p, in, in, o);
        bool ok = true; int count = 0;
        for (const auto& s : spawns(core, 0))
        {
            const double j = std::round(static_cast<double>(s.pos) / hop);
            ok = ok && s.pos == ceilAt(j * hop);
            ++count;
        }
        CHECK(count > 5 && ok, "T8a free splices land on ceil(j * hop) from timeline zero");
    }

    // (b) Sync 1/8 at 140 BPM and (c) 1/4D cut at every downbeat.
    const double spb = 60.0 * kSR / 140.0;
    for (int div : { 7, 12 })
    {
        Params p = bare();
        p.sync = true;
        p.spliceDiv = div;
        Core core; core.setParams(p); core.prepare(kSR);
        RunOpts o;
        o.blockSize = [](std::int64_t b) { return 100 + static_cast<int>(b % 7) * 37; };
        run(core, p, in, in, o);

        std::vector<std::int64_t> expect;
        const double len = divisionBeats(div);
        for (int bar = 0; bar < 4; ++bar)
            for (double b = 0.0; b < 4.0 - 1e-9; b += len)
                expect.push_back(ceilAt((bar * 4.0 + b) * spb));
        std::vector<std::int64_t> got;
        for (const auto& s : spawns(core, 0)) got.push_back(s.pos);
        bool ok = true;
        for (std::size_t i = 0; i < got.size() && i < expect.size(); ++i)
            ok = ok && got[i] == expect[i];
        std::cout << "  sync " << divisionLabel(div) << ": " << got.size() << " splices, first " << got[0] << ", "
                  << got[1] << ", " << got[2] << ", " << got[3] << "\n";
        CHECK(ok && got.size() >= 8, "T8b/c sync " << divisionLabel(div) << " splices on beat positions, cut at downbeats");
    }

    // (d) Starting elsewhere puts the splices on the same samples.
    {
        Params p = bare();
        p.sync = true;
        p.spliceDiv = 4;
        Core a; a.setParams(p); a.prepare(kSR);
        run(a, p, in, in, {});
        Core b; b.setParams(p); b.prepare(kSR);
        RunOpts o; o.start = 77777;
        const std::vector<float> tail(in.begin(), in.begin() + n / 2);
        run(b, p, tail, tail, o);
        std::vector<std::int64_t> fromZero, fromLater;
        for (const auto& s : spawns(a, 0)) if (s.pos >= 77777 && s.pos < 77777 + n / 2) fromZero.push_back(s.pos);
        for (const auto& s : spawns(b, 0)) fromLater.push_back(s.pos);
        const std::size_t k = std::min(fromZero.size(), fromLater.size());
        bool ok = k > 10;
        for (std::size_t i = 0; i < k; ++i) ok = ok && fromZero[i] == fromLater[i];
        CHECK(ok, "T8d playing from 77777 lands the same splices as playing from 0");
    }

    // (e) Splice Offset shortens the right channel's hop.
    {
        Params p = bare();
        p.spliceMs = 200.0f;
        p.spliceOffset = 0.25f;
        Core core; core.setParams(p); core.prepare(kSR);
        run(core, p, in, in, {});
        const auto r = spawns(core, 1);
        CHECK(r.size() > 3 && r[1].pos - r[0].pos == 7200 && r[2].pos - r[1].pos == 7200,
              "T8e right channel splices every 150 ms with a 25 % offset");
    }
}

// ─── T9 skipped blocks ───────────────────────────────────────────────────────
static void testSkippedBlocks()
{
    std::cout << "\n[SzkrezhCore] T9 blocks skipped while idle render the same as processed blocks\n";
    const int n = static_cast<int>(30.0 * kSR);
    std::vector<float> inL(static_cast<std::size_t>(n), 0.0f), inR(static_cast<std::size_t>(n), 0.0f);
    const auto burst = noise(static_cast<int>(0.2 * kSR), 61);
    const int second = static_cast<int>(26.0 * kSR);
    for (std::size_t i = 0; i < burst.size(); ++i)
    {
        inL[i] = inR[i] = burst[i];
        inL[second + i] = inR[second + i] = burst[i];
    }
    Params p;   // defaults: Reverse +1200, sync 1/4, recycle 35 %, tone on
    p.mix = 0.5f;

    Core a; a.setParams(p); a.prepare(kSR);
    RunOpts oa;
    oa.blockSize = [](std::int64_t) { return 256; };
    const Stereo full = run(a, p, inL, inR, oa);

    Core b; b.setParams(p); b.prepare(kSR);
    bool idleSeen = false;
    std::int64_t idleAt = -1, skipped = 0;
    RunOpts ob;
    ob.blockSize = [](std::int64_t) { return 256; };
    ob.after = [&](std::int64_t pos, int) {
        if (!idleSeen && pos > static_cast<std::int64_t>(burst.size()) && !b.holdsTail()) { idleSeen = true; idleAt = pos; }
    };
    ob.skip = [&](std::int64_t pos, int len) {
        const bool skip = idleSeen && pos + len <= second;
        if (skip) ++skipped;
        return skip;
    };
    const Stereo gappy = run(b, p, inL, inR, ob);

    std::cout << "  idle at " << std::setprecision(2) << idleAt / kSR << " s, " << skipped << " blocks skipped\n";
    CHECK(idleSeen && idleAt < second - static_cast<std::int64_t>(kSR), "T9 the effect goes idle well before the next burst");
    CHECK(skipped > 100, "T9 blocks were skipped");
    CHECK(sameBits(full, gappy), "T9 skipped run is bit-identical to the processed run");
}

// ─── T10 Harmony ─────────────────────────────────────────────────────────────
static void testHarmony()
{
    std::cout << "\n[SzkrezhCore] T10 Harmony: scale-correct interval from the host notes\n";
    const int n = static_cast<int>(4.5 * kSR);
    const auto in = noise(n, 71);
    Timeline tl;
    tl.host = { { 0, 60 }, { 48000, 64 }, { 96000, 67 }, { 144000, 71 } };   // C E G B
    Params p = bare();
    p.pitchSource = PitchSource::Harmony;
    p.key = 0; p.scale = 0; p.harmonySteps = 2;   // a third above in C major
    p.spliceMs = 250.0f;                           // 12000: every note lands on a splice
    RunOpts o; o.notes = &tl;
    Core core; core.setParams(p); core.prepare(kSR);
    run(core, p, in, in, o);
    bool ok = true; int count = 0;
    for (const auto& s : spawns(core, 0))
    {
        const float want = s.pos < 48000 ? 400.0f : s.pos < 96000 ? 300.0f : s.pos < 144000 ? 400.0f : 300.0f;
        ok = ok && std::fabs(s.cents - want) < 1e-3f;
        ++count;
    }
    CHECK(count > 10 && ok, "T10 C->E +4, E->G +3, G->B +4, B->D +3");

    // Forward + Delay: the lookup follows where the grain reads, not when it starts.
    Params f = p;
    f.reverse = false;
    f.delayMs = 500.0f;   // 24000 behind
    Core fc; fc.setParams(f); fc.prepare(kSR);
    run(fc, f, in, in, o);
    bool lag = false;
    for (const auto& s : spawns(fc, 0))
        if (s.pos == 72000) lag = std::fabs(s.cents - 400.0f) < 1e-3f;   // reads C at 72000 - 24000 - 12960 < 48000
    CHECK(lag, "T10 a Forward grain with Delay harmonises the note it reads");
}

// ─── T11 Keys ────────────────────────────────────────────────────────────────
static void testKeys()
{
    std::cout << "\n[SzkrezhCore] T11 Keys: played notes set the crystal pitch\n";
    const int n = static_cast<int>(3.0 * kSR);
    const auto in = noise(n, 81);

    // (a) Notes on the host track: shift = note - Root, retrigger 10 ms after the note.
    {
        Timeline tl;
        tl.host = { { 24000, 67 } };
        Params p = bare();
        p.pitchSource = PitchSource::Keys;
        p.rootNote = 60;
        p.spliceMs = 1000.0f;
        RunOpts o; o.notes = &tl;
        Core core; core.setParams(p); core.prepare(kSR);
        run(core, p, in, in, o);
        bool before = false, retrig = false, after = false;
        for (const auto& s : spawns(core, 0))
        {
            if (s.pos == 0) before = std::fabs(s.cents) < 1e-3f;
            if (s.pos == 24480) retrig = s.retrigger && std::fabs(s.cents - 700.0f) < 1e-3f;
            if (s.pos == 48000) after = std::fabs(s.cents - 700.0f) < 1e-3f;
        }
        CHECK(before, "T11a no note yet: unison");
        CHECK(retrig, "T11a a note retriggers a grain 10 ms later at note - Root");
        CHECK(after, "T11a later splices keep the note");
    }

    // (b) Another track: crystals land on the played chord over the host melody.
    {
        Timeline tl;
        tl.host = { { 0, 60 }, { 72000, 62 } };              // melody C, then D
        tl.keys = { { 12000, 64 }, { 12100, 67 } };          // E + G, 2 ms apart: one chord
        Params p = bare();
        p.pitchSource = PitchSource::Keys;
        p.spliceMs = 500.0f;
        RunOpts o; o.notes = &tl; o.keysFromHost = false;
        Core core; core.setParams(p); core.prepare(kSR);
        run(core, p, in, in, o);
        float chordL = -1.0f, chordR = -1.0f;
        bool follow = false;
        for (const auto& s : spawns(core))
        {
            if (s.pos == 12480 && s.retrigger) (s.channel == 0 ? chordL : chordR) = s.cents;
            if (s.pos == 96000 && s.channel == 0) follow = std::fabs(s.cents - 200.0f) < 1e-3f;
        }
        const bool chord = std::fabs(chordL - 400.0f) < 1e-3f && std::fabs(chordR - 700.0f) < 1e-3f;
        CHECK(chord, "T11b chord E+G over C: left +400, right +700, one retrigger");
        CHECK(follow, "T11b when the melody moves to D the shift follows (E over D = +200)");
    }
}

// ─── T12 gate / duck ─────────────────────────────────────────────────────────
static void testDynamics()
{
    std::cout << "\n[SzkrezhCore] T12 gate / duck on the wet path\n";
    const int n = static_cast<int>(3.0 * kSR);
    const auto in = sine(n, 300.0, 0.5f, 0, static_cast<int>(1.0 * kSR));
    for (int mode = 0; mode < 2; ++mode)
    {
        Params p = bare();
        p.dynAmount = mode == 0 ? 1.0f : -1.0f;
        p.dynThresholdDb = -20.0f;
        p.dynAttackMs = 2.0f;
        p.dynReleaseMs = 50.0f;
        Core core; core.setParams(p); core.prepare(kSR);
        float loud = 1.0f, quiet = 1.0f;
        RunOpts o;
        o.after = [&](std::int64_t pos, int) {
            if (pos > 0.5 * kSR && pos < 0.9 * kSR) loud = std::min(loud, core.dynGain());
            if (pos > 2.0 * kSR) quiet = std::min(quiet, core.dynGain());
        };
        run(core, p, in, in, o);
        std::cout << "  " << (mode == 0 ? "duck" : "gate") << ": gain while loud " << std::setprecision(9) << loud
                  << ", after " << quiet << "\n";
        if (mode == 0) CHECK(loud < 0.01f && quiet == 1.0f, "T12 duck: wet ducked while playing, back after");
        else           CHECK(loud == 1.0f && quiet < 0.01f, "T12 gate: wet open while playing, closed after");
    }
}

// ─── T13 freeze ──────────────────────────────────────────────────────────────
static void testFreeze()
{
    std::cout << "\n[SzkrezhCore] T13 freeze holds the tape\n";
    const int n = static_cast<int>(3.0 * kSR);
    const int switchAt = static_cast<int>(1.0 * kSR);
    std::vector<float> in = sine(n, 440.0, 0.4f, 0, switchAt);
    const auto later = sine(n, 1000.0, 0.4f, switchAt, n);
    for (int i = switchAt; i < n; ++i) in[i] = later[i];
    Params p = bare();
    p.spliceMs = 200.0f;
    RunOpts o;
    o.blockSize = [](std::int64_t) { return 500; };   // 48000 is a block start
    o.hook = [&](std::int64_t pos, Params& q) { q.freeze = pos >= switchAt; };
    const Stereo out = runFresh(p, in, in, o);
    const int from = static_cast<int>(1.6 * kSR), len = static_cast<int>(1.2 * kSR);
    const double old = amplitudeAt(&out.L[from], len, 880.0), fresh = amplitudeAt(&out.L[from], len, 2000.0);
    std::cout << "  after freeze: 880 Hz " << db(old) << " dB, 2000 Hz " << db(fresh) << " dB\n";
    CHECK(old > 0.05, "T13 the frozen material keeps playing");
    CHECK(fresh < 1e-4, "T13 new input never reaches the frozen tape");
}

// ─── T14 tail hold ───────────────────────────────────────────────────────────
static void testTailHold()
{
    std::cout << "\n[SzkrezhCore] T14 tail hold\n";
    Params p;   // defaults
    Core core; core.setParams(p); core.prepare(kSR);
    std::vector<float> silence(static_cast<std::size_t>(kSR), 0.0f);
    run(core, p, silence, silence);
    CHECK(!core.holdsTail(), "T14 silent input: nothing to hold");

    // A 100 ms clip, then silence. The first crystal arrives hundreds of ms after the clip ends;
    // without the hold the mixer's 50 ms silence detector would stop the chain before it sounds.
    const int n = static_cast<int>(20.0 * kSR);
    const int clipEnd = static_cast<int>(0.1 * kSR);
    std::vector<float> in(static_cast<std::size_t>(n), 0.0f);
    const auto clip = noise(clipEnd, 91);
    std::copy(clip.begin(), clip.end(), in.begin());
    std::int64_t releasedAt = -1;
    bool heldThroughGap = true;
    Core c2; c2.setParams(p); c2.prepare(kSR);
    RunOpts o;
    o.blockSize = [](std::int64_t) { return 256; };
    o.after = [&](std::int64_t pos, int) {
        if (releasedAt < 0 && pos > clipEnd && !c2.holdsTail()) releasedAt = pos;
    };
    const Stereo out = run(c2, p, in, in, o);

    int firstCrystal = -1;
    for (int i = clipEnd; i < n && firstCrystal < 0; ++i)
        if (std::fabs(out.L[i]) > 1e-3f) firstCrystal = i;
    heldThroughGap = firstCrystal > 0 && (releasedAt < 0 || releasedAt > firstCrystal);
    double after = 0.0;
    if (releasedAt > 0)
        for (std::int64_t i = releasedAt + 256; i < n; ++i) after = std::max(after, std::fabs(static_cast<double>(out.L[i])));
    std::cout << "  clip ends 0.10 s, first crystal above -60 dB at " << std::setprecision(3) << firstCrystal / kSR
              << " s, hold released at " << releasedAt / kSR << " s\n";
    CHECK(firstCrystal - clipEnd > static_cast<int>(0.05 * kSR), "T14 the first crystal comes more than 50 ms after the clip");
    CHECK(heldThroughGap, "T14 held through the silent gap before the first crystal");
    CHECK(releasedAt > 0 && releasedAt < n - static_cast<std::int64_t>(2.0 * kSR), "T14 the hold releases once the tail is gone");
    CHECK(after == 0.0, "T14 output is exactly silent once released");
}

// ─── T15 zero allocation ─────────────────────────────────────────────────────
static void testNoAlloc()
{
    std::cout << "\n[SzkrezhCore] T15 zero operator new in setParams() / process()\n";
    const int n = static_cast<int>(2.0 * kSR);
    const auto inL = noise(n, 101), inR = noise(n, 102);
    Timeline tl;
    tl.host = { { 1000, 60 }, { 50000, 64 } };
    tl.keys = { { 2000, 67 }, { 60000, 69 } };
    g_allocCount.store(0);
    for (int cfg = 0; cfg < 4; ++cfg)
    {
        Params p;
        p.pitchSource = static_cast<PitchSource>(cfg % 3);
        p.quality = cfg == 3 ? Quality::Clean : Quality::Vintage;
        p.dynAmount = 0.4f;
        Core core; core.setParams(p); core.prepare(kSR);
        RunOpts o;
        o.notes = &tl;
        o.keysFromHost = cfg != 2;
        o.countAllocs = true;
        o.blockSize = [](std::int64_t b) { return 64 + static_cast<int>(b % 5) * 100; };
        o.hook = [](std::int64_t pos, Params& q) { q.freeze = pos > 60000 && pos < 70000; };
        run(core, p, inL, inR, o);
        g_allocArmed.store(true);
        core.reset();
        g_allocArmed.store(false);
    }
    std::cout << "  operator new calls: " << g_allocCount.load() << "\n";
    CHECK(g_allocCount.load() == 0, "T15 no allocation on the audio path");
}

// ─── T16 CPU ─────────────────────────────────────────────────────────────────
static void testCpu()
{
    std::cout << "\n[SzkrezhCore] T16 CPU (stereo, 48 kHz, 10 s)\n";
    const int n = static_cast<int>(10.0 * kSR);
    const auto inL = noise(n, 111), inR = noise(n, 112);
    struct Case { const char* name; Params p; };
    Params typical;   // defaults: +1200, 1/4, Vintage
    Params worstV;   worstV.pitchCents = 3600.0f; worstV.sync = true; worstV.spliceDiv = 1; worstV.smoothingMs = 250.0f;
    Params cleanT;   cleanT.quality = Quality::Clean;
    Params worstC = worstV; worstC.quality = Quality::Clean;
    const Case cases[] = { { "Vintage +1200 1/4", typical }, { "Vintage +3600 1/64", worstV },
                           { "Clean +1200 1/4", cleanT }, { "Clean +3600 1/64", worstC } };
    for (const auto& c : cases)
    {
        Core core; core.setParams(c.p); core.prepare(kSR);
        const auto t0 = std::chrono::steady_clock::now();
        run(core, c.p, inL, inR);
        const double sec = std::chrono::duration<double>(std::chrono::steady_clock::now() - t0).count();
        const double pct = sec / 10.0 * 100.0;
        std::cout << "  " << std::left << std::setw(22) << c.name << std::right << std::setprecision(2) << pct
                  << " % of one core\n";
        if (std::string(c.name).rfind("Vintage", 0) == 0)
            CHECK(pct < 3.0, "T16 " << c.name << " under 3 % of a core");
    }
}

// ─── T17 harmony maths ───────────────────────────────────────────────────────
static void testHarmonyMaths()
{
    std::cout << "\n[SzkrezhCore] T17 harmony intervals\n";
    struct Row { int note, key, scale, steps, want; const char* what; };
    const Row rows[] = {
        { 60, 0, 0,  2,  4, "C major: C up a third = E" },
        { 64, 0, 0,  2,  3, "C major: E up a third = G" },
        { 71, 0, 0,  2,  3, "C major: B up a third = D" },
        { 60, 0, 0, -2, -3, "C major: C down a third = A" },
        { 60, 0, 0,  7, 12, "C major: 7 steps = octave" },
        { 61, 0, 0,  2,  4, "C major: C# keeps its offset (-> F)" },
        { 69, 9, 1,  2,  3, "A minor: A up a third = C" },
        { 57, 9, 1,  4,  7, "A minor: A up a fifth = E" },
        { 60, 0, 6,  1,  2, "C major pentatonic: C -> D" },
        { 64, 0, 6,  1,  3, "C major pentatonic: E -> G" },
        { 60, 0, 8,  5,  5, "Chromatic: 5 steps = 5 semitones" },
        { 59, 0, 2,  1,  1, "C harmonic minor: B -> C" },
    };
    for (const auto& r : rows)
    {
        const int got = harmonyShiftSemitones(r.note, r.key, r.scale, r.steps);
        CHECK(got == r.want, "T17 " << r.what << " (got " << got << ", want " << r.want << ")");
    }
}

int main()
{
    std::cout << std::fixed;
    testHarmonyMaths();
    testIdentity();
    testReverseImpulse();
    testStaircase();
    testAliasing();
    testRunaway();
    testLatching();
    testBlockSizes();
    testGrid();
    testSkippedBlocks();
    testHarmony();
    testKeys();
    testDynamics();
    testFreeze();
    testTailHold();
    testNoAlloc();
    testCpu();

    std::cout << "\n[SzkrezhCore] " << g_passed << " passed, " << g_failed << " failed\n";
    if (g_failed == 0) std::cout << "[SzkrezhCore] ALL TESTS PASSED\n";
    return g_failed == 0 ? 0 : 1;
}
