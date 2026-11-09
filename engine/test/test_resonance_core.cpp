// test_resonance_core - unit tests for xleth::dsp::resonance::Core (engine/src/dsp/ResonanceCore.*),
// the shared resonance detector / gain computer / spectral renderer (stage 1, not wired into any effect).
//
//   T1 latency      latencyFor / currentLatency = N (1024 at 44.1 / 48 kHz, 2048 at 88.2 / 96 kHz)
//   T2 identity     depth 0: latency-aligned output == input within -120 dBFS RMS and max |diff|
//   T3 impulse      unit impulse comes out at exactly +N with unit height (depth 0 and default params)
//   T4 alloc        zero operator-new calls inside process(): static params, parameters changed before
//                   EVERY block, and a cold pass armed from the first block after prepare()
//   T5 COLA         depth-0 reconstruction at block sizes 32 / 64 / 480 / 512 / 1024 and a mixed schedule
//   T6 block size   outputs at different block schedules identical (within -120 dBFS) with the detector
//                   active (default params, pink noise + a planted resonance)
//   T7 reset        reset() mid-stream == a freshly prepared instance
//   T8 mono         one channel processed, extra channels untouched
//   F1-F4 detector  (stage B) pink noise not cut at the most sensitive setting; a +12 dB / Q8 resonance is cut
//                   by >= 7 dB at f0 and nothing an octave away; right-only resonance leaves L alone at link 0 and
//                   is mirrored at link 1; the threshold's predicted sigma_E matches the measured std on noise
//
// The allocation counter hooks operator new / new[] on the measuring thread only (the same approach as
// test_effect_processblock_alloc.cpp). Output prefix: [ResCore].

#include "dsp/ResonanceCore.h"

#include <juce_core/juce_core.h>

#include <algorithm>
#include <atomic>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <new>
#include <string>
#include <vector>

// --- Counting allocator (measuring thread only, armed around process()) ----------------------------
namespace {
std::atomic<bool>      g_allocArmed { false };
std::atomic<long long> g_allocCount { 0 };
thread_local bool      t_isMeasuringThread = false;

inline void countAlloc() noexcept
{
    if (g_allocArmed.load(std::memory_order_relaxed) && t_isMeasuringThread)
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

using xleth::dsp::resonance::Core;
using xleth::dsp::resonance::Params;

namespace {

int g_pass = 0, g_fail = 0;

void check(bool ok, const std::string& what)
{
    if (ok) { ++g_pass; std::printf("[ResCore] PASS %s\n", what.c_str()); }
    else    { ++g_fail; std::printf("[ResCore] FAIL %s\n", what.c_str()); }
    std::fflush(stdout);
}

struct Stereo
{
    std::vector<float> ch[2];
    int size() const { return static_cast<int>(ch[0].size()); }
    void resize(int n) { ch[0].assign(static_cast<size_t>(n), 0.0f); ch[1].assign(static_cast<size_t>(n), 0.0f); }
};

// Deterministic LCG pink noise (Kellet economy filter), independent per channel.
Stereo makePink(int n, double rmsDb, uint64_t seed)
{
    Stereo s; s.resize(n);
    for (int c = 0; c < 2; ++c)
    {
        uint64_t st = (seed + 17ull * static_cast<uint64_t>(c + 1)) * 0x9E3779B97F4A7C15ull + 0x1234567ull;
        double b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0, acc = 0;
        std::vector<double> o(static_cast<size_t>(n));
        for (int i = 0; i < n; ++i)
        {
            st = st * 6364136223846793005ull + 1442695040888963407ull;
            const double white = static_cast<double>(st >> 40) / 8388608.0 - 1.0;
            b0 = 0.99886 * b0 + white * 0.0555179; b1 = 0.99332 * b1 + white * 0.0750759;
            b2 = 0.96900 * b2 + white * 0.1538520; b3 = 0.86650 * b3 + white * 0.3104856;
            b4 = 0.55000 * b4 + white * 0.5329522; b5 = -0.7616 * b5 - white * 0.0168980;
            o[static_cast<size_t>(i)] = b0 + b1 + b2 + b3 + b4 + b5 + b6 + white * 0.5362;
            b6 = white * 0.115926;
            acc += o[static_cast<size_t>(i)] * o[static_cast<size_t>(i)];
        }
        const double g = std::pow(10.0, rmsDb / 20.0) / std::sqrt(acc / std::max(n, 1));
        for (int i = 0; i < n; ++i) s.ch[c][static_cast<size_t>(i)] = static_cast<float>(o[static_cast<size_t>(i)] * g);
    }
    return s;
}

// RBJ peaking biquad in place (double TDF-II).
void applyPeak(std::vector<float>& x, double sr, double f0, double q, double gainDb)
{
    const double A = std::pow(10.0, gainDb / 40.0), w0 = 2.0 * juce::MathConstants<double>::pi * f0 / sr;
    const double alpha = std::sin(w0) / (2.0 * q), cw = std::cos(w0), a0 = 1.0 + alpha / A;
    const double b0 = (1.0 + alpha * A) / a0, b1 = -2.0 * cw / a0, b2 = (1.0 - alpha * A) / a0, a1 = -2.0 * cw / a0, a2 = (1.0 - alpha / A) / a0;
    double z1 = 0, z2 = 0;
    for (float& v : x)
    {
        const double in = v, out = b0 * in + z1;
        z1 = b1 * in - a1 * out + z2; z2 = b2 * in - a2 * out;
        v = static_cast<float>(out);
    }
}

Stereo render(Core& core, const Stereo& in, const std::vector<int>& sched, const Params& p, int numCh = 2)
{
    Stereo out = in;
    const int n = in.size();
    size_t si = 0;
    for (int pos = 0; pos < n;)
    {
        const int b = std::min(sched[si++ % sched.size()], n - pos);
        float* ptrs[2] = { out.ch[0].data() + pos, out.ch[1].data() + pos };
        core.process(ptrs, numCh, b, p);
        pos += b;
    }
    return out;
}

struct Diff { double rmsDb = -300.0, maxAbs = 0.0; };

// out[i + lat] vs in[i] over [skip, n - lat), both channels.
Diff alignedDiff(const Stereo& in, const Stereo& out, int lat, int skip = 0, int chans = 2)
{
    double acc = 0.0, mx = 0.0; long long cnt = 0;
    for (int c = 0; c < chans; ++c)
        for (int i = skip; i + lat < in.size(); ++i)
        {
            const double d = static_cast<double>(out.ch[c][static_cast<size_t>(i + lat)]) - in.ch[c][static_cast<size_t>(i)];
            acc += d * d; mx = std::max(mx, std::abs(d)); ++cnt;
        }
    Diff r;
    r.rmsDb = 20.0 * std::log10(std::max(std::sqrt(acc / std::max<long long>(cnt, 1)), 1.0e-15));
    r.maxAbs = mx;
    return r;
}

Diff sameDiff(const Stereo& a, const Stereo& b)
{
    double acc = 0.0, mx = 0.0; long long cnt = 0;
    for (int c = 0; c < 2; ++c)
        for (int i = 0; i < a.size(); ++i)
        {
            const double d = static_cast<double>(a.ch[c][static_cast<size_t>(i)]) - b.ch[c][static_cast<size_t>(i)];
            acc += d * d; mx = std::max(mx, std::abs(d)); ++cnt;
        }
    Diff r;
    r.rmsDb = 20.0 * std::log10(std::max(std::sqrt(acc / std::max<long long>(cnt, 1)), 1.0e-15));
    r.maxAbs = mx;
    return r;
}

const double kMaxAbsAt120 = 1.0e-6;   // -120 dBFS as an amplitude

Params depth0() { Params p; p.depth = 0.0f; return p; }

// ---------------------------------------------------------------------------------------------------
void testLatency()
{
    check(Core::latencyFor(44100.0) == 1024, "T1 latencyFor(44100) == 1024");
    check(Core::latencyFor(48000.0) == 1024, "T1 latencyFor(48000) == 1024");
    check(Core::latencyFor(88200.0) == 2048, "T1 latencyFor(88200) == 2048");
    check(Core::latencyFor(96000.0) == 2048, "T1 latencyFor(96000) == 2048");
    for (double sr : { 44100.0, 48000.0, 96000.0 })
    {
        Core c; c.prepare(sr, 512, 2);
        check(c.currentLatency() == Core::latencyFor(sr) && c.hopSize() * 4 == c.fftSize(),
              "T1 currentLatency == latencyFor, hop == N/4 @" + std::to_string(static_cast<int>(sr)));
        const double ms = 1000.0 * c.fftSize() / sr;
        check(ms > 20.0 && ms < 24.0, "T1 frame ~21 ms @" + std::to_string(static_cast<int>(sr)) + " (" + std::to_string(ms) + " ms)");
    }
}

void testIdentityAndCola()
{
    const double sr = 48000.0;
    const Stereo in = makePink(static_cast<int>(3.0 * sr), -20.0, 11);
    const std::vector<std::vector<int>> scheds = { { 32 }, { 64 }, { 480 }, { 512 }, { 1024 }, { 1, 37, 128, 255, 511, 1024, 37 } };
    const char* names[] = { "32", "64", "480", "512", "1024", "mixed" };
    for (size_t i = 0; i < scheds.size(); ++i)
    {
        Core c; c.prepare(sr, 1024, 2);
        const Stereo out = render(c, in, scheds[i], depth0());
        const Diff d = alignedDiff(in, out, c.currentLatency());
        char buf[160];
        std::snprintf(buf, sizeof buf, "T2/T5 depth-0 identity / COLA, block %s: rms %.1f dBFS, max |diff| %.2e", names[i], d.rmsDb, d.maxAbs);
        check(d.rmsDb <= -120.0 && d.maxAbs <= kMaxAbsAt120, buf);
    }
    // Also at 44.1 and 96 kHz (N = 2048).
    for (double r : { 44100.0, 96000.0 })
    {
        const Stereo in2 = makePink(static_cast<int>(2.0 * r), -20.0, 12);
        Core c; c.prepare(r, 512, 2);
        const Diff d = alignedDiff(in2, render(c, in2, { 512 }, depth0()), c.currentLatency());
        char buf[160];
        std::snprintf(buf, sizeof buf, "T2 depth-0 identity @%d: rms %.1f dBFS, max |diff| %.2e", static_cast<int>(r), d.rmsDb, d.maxAbs);
        check(d.rmsDb <= -120.0 && d.maxAbs <= kMaxAbsAt120, buf);
    }
}

void testImpulse()
{
    const double sr = 48000.0;
    const int at = 3001, n = 16384;
    for (int variant = 0; variant < 2; ++variant)
    {
        Stereo in; in.resize(n);
        in.ch[0][at] = 1.0f; in.ch[1][at] = 1.0f;
        Core c; c.prepare(sr, 512, 2);
        const Params p = variant == 0 ? depth0() : Params{};
        const Stereo out = render(c, in, { 512 }, p);
        int peakIdx = -1; float peak = 0.0f; double rest = 0.0;
        for (int i = 0; i < n; ++i)
        {
            const float v = std::abs(out.ch[0][static_cast<size_t>(i)]);
            if (v > peak) { peak = v; peakIdx = i; }
        }
        for (int i = 0; i < n; ++i) if (i != peakIdx) rest = std::max(rest, static_cast<double>(std::abs(out.ch[0][static_cast<size_t>(i)])));
        char buf[200];
        std::snprintf(buf, sizeof buf, "T3 impulse (%s): peak at +%d (expect %d), height %.7f, max elsewhere %.2e",
                      variant == 0 ? "depth 0" : "default params", peakIdx - at, c.currentLatency(), static_cast<double>(peak), rest);
        // Default params: a lone impulse has a flat spectrum, so nothing may be detected as a resonance.
        check(peakIdx - at == c.currentLatency() && std::abs(peak - 1.0f) < 1.0e-5f && rest < kMaxAbsAt120, buf);
    }
}

long long countAllocs(Core& c, const Stereo& in, int block, int warmBlocks, int measuredBlocks, bool sweep, bool cold)
{
    std::vector<float> l(static_cast<size_t>(block)), r(static_cast<size_t>(block));
    float* ptrs[2] = { l.data(), r.data() };
    Params p;
    long long total = 0;
    int pos = 0;
    const int nBlocks = warmBlocks + measuredBlocks;
    t_isMeasuringThread = true;
    for (int b = 0; b < nBlocks; ++b)
    {
        if (pos + block > in.size()) pos = 0;
        std::memcpy(l.data(), in.ch[0].data() + pos, sizeof(float) * static_cast<size_t>(block));
        std::memcpy(r.data(), in.ch[1].data() + pos, sizeof(float) * static_cast<size_t>(block));
        pos += block;
        if (sweep)
        {
            // A new parameter set before EVERY block (as a message-thread write would be observed).
            p.depth       = 0.5f + 0.5f * std::sin(0.37f * static_cast<float>(b));
            p.sensitivity = 0.5f + 0.5f * std::sin(0.53f * static_cast<float>(b) + 1.0f);
            p.attackMs    = 1.0f + 199.0f * (0.5f + 0.5f * std::sin(0.11f * static_cast<float>(b)));
            p.releaseMs   = 10.0f + 1990.0f * (0.5f + 0.5f * std::sin(0.07f * static_cast<float>(b)));
            p.hardKnee    = (b % 3) == 0;
            p.stereoLink  = 0.5f + 0.5f * std::sin(0.29f * static_cast<float>(b));
        }
        const bool armed = cold || b >= warmBlocks;
        if (armed) { g_allocCount.store(0); g_allocArmed.store(true); }
        c.process(ptrs, 2, block, p);
        if (armed) { g_allocArmed.store(false); total += g_allocCount.load(); }
    }
    t_isMeasuringThread = false;
    return total;
}

void testAllocations()
{
    // Negative control: the hook must see a deliberate allocation, or every "0" below is meaningless.
    {
        t_isMeasuringThread = true;
        g_allocCount.store(0); g_allocArmed.store(true);
        int* volatile probe = new int(7);
        g_allocArmed.store(false);
        t_isMeasuringThread = false;
        delete probe;
        check(g_allocCount.load() >= 1, "T4 counter self-check: a deliberate new is counted (" + std::to_string(g_allocCount.load()) + ")");
    }
    const double sr = 48000.0;
    Stereo in = makePink(static_cast<int>(4.0 * sr), -20.0, 21);
    applyPeak(in.ch[0], sr, 2500.0, 8.0, 12.0);
    applyPeak(in.ch[1], sr, 2500.0, 8.0, 12.0);
    for (int block : { 1, 64, 512, 1024 })
        for (int mode = 0; mode < 3; ++mode)
        {
            const bool sweep = mode >= 1, cold = mode == 2;
            Core c; c.prepare(sr, 1024, 2);
            const int measured = block == 1 ? 20000 : 400;
            const long long n = countAllocs(c, in, block, cold ? 0 : 200, measured, sweep, cold);
            check(n == 0, "T4 zero operator new in process(): block " + std::to_string(block) + (cold ? " cold, params swept every block" : sweep ? " params swept every block" : " static params")
                          + " (count " + std::to_string(n) + ")");
        }
    // reset() is RT-safe too.
    {
        Core c; c.prepare(sr, 512, 2);
        t_isMeasuringThread = true;
        g_allocCount.store(0); g_allocArmed.store(true);
        c.reset();
        g_allocArmed.store(false);
        t_isMeasuringThread = false;
        check(g_allocCount.load() == 0, "T4 zero operator new in reset()");
    }
}

Stereo resonantPink(double sr, double seconds, double f0, uint64_t seed)
{
    Stereo s = makePink(static_cast<int>(seconds * sr), -20.0, seed);
    applyPeak(s.ch[0], sr, f0, 8.0, 12.0);
    applyPeak(s.ch[1], sr, f0, 8.0, 12.0);
    return s;
}

void testBlockSizeIndependence()
{
    const double sr = 48000.0;
    const Stereo in = resonantPink(sr, 4.0, 2500.0, 31);
    for (int variant = 0; variant < 2; ++variant)
    {
        Params p;   // default params: the detector and gain computer are active
        if (variant == 1) { p.depth = 1.0f; p.hardKnee = true; p.stereoLink = 0.5f; }
        Core ref; ref.prepare(sr, 1024, 2);
        const Stereo r = render(ref, in, { 512 }, p);
        const std::vector<std::vector<int>> scheds = { { 32 }, { 64 }, { 480 }, { 1024 }, { 1, 37, 128, 255, 511, 1024, 37 } };
        const char* names[] = { "32", "64", "480", "1024", "mixed" };
        for (size_t i = 0; i < scheds.size(); ++i)
        {
            Core c; c.prepare(sr, 1024, 2);
            const Diff d = sameDiff(r, render(c, in, scheds[i], p));
            char buf[200];
            std::snprintf(buf, sizeof buf, "T6 block-size independence (%s) block %s vs 512: rms %.1f dBFS, max |diff| %.2e",
                          variant == 0 ? "default params" : "depth 1 Hard link 0.5", names[i], d.rmsDb, d.maxAbs);
            check(d.rmsDb <= -120.0 && d.maxAbs <= kMaxAbsAt120, buf);
        }
    }
}

void testReset()
{
    const double sr = 48000.0;
    const Stereo a = resonantPink(sr, 2.0, 1100.0, 41);
    const Stereo b = resonantPink(sr, 2.0, 3700.0, 42);
    Params p; p.depth = 1.0f; p.hardKnee = true;
    Core c; c.prepare(sr, 512, 2);
    (void) render(c, a, { 512 }, p);
    c.reset();
    const Stereo afterReset = render(c, b, { 333 }, p);
    Core fresh; fresh.prepare(sr, 512, 2);
    const Diff d = sameDiff(afterReset, render(fresh, b, { 333 }, p));
    char buf[160];
    std::snprintf(buf, sizeof buf, "T7 reset() == fresh instance: rms %.1f dBFS, max |diff| %.2e", d.rmsDb, d.maxAbs);
    check(d.maxAbs == 0.0, buf);
}

void testMono()
{
    const double sr = 48000.0;
    const Stereo in = resonantPink(sr, 2.0, 2500.0, 51);
    Core c; c.prepare(sr, 512, 2);
    Stereo out = render(c, in, { 256 }, depth0(), 1);
    const Diff d0 = alignedDiff(in, out, c.currentLatency(), 0, 1);
    bool untouched = out.ch[1] == in.ch[1];
    char buf[160];
    std::snprintf(buf, sizeof buf, "T8 mono: ch0 depth-0 identity rms %.1f dBFS, ch1 untouched = %d", d0.rmsDb, untouched ? 1 : 0);
    check(d0.rmsDb <= -120.0 && untouched, buf);
}

// Run `in` in hop-sized blocks (one frame per block) and average the applied per-band reduction per channel after `skipSec`.
struct BandStats { std::vector<double> red[2], maxRed[2], e, e2; long long n = 0; };
BandStats bandStats(Core& c, const Stereo& in, const Params& p, double skipSec)
{
    const int H = c.hopSize(), B = c.numBands();
    BandStats s;
    for (int ch = 0; ch < 2; ++ch) { s.red[ch].assign(static_cast<size_t>(B), 0.0); s.maxRed[ch].assign(static_cast<size_t>(B), 0.0); }
    s.e.assign(static_cast<size_t>(B), 0.0); s.e2 = s.e;
    std::vector<float> l(static_cast<size_t>(H)), r(static_cast<size_t>(H));
    float* ptrs[2] = { l.data(), r.data() };
    const int skip = static_cast<int>(skipSec * c.sampleRate()) / H;
    for (int pos = 0, f = 0; pos + H <= in.size(); pos += H, ++f)
    {
        std::memcpy(l.data(), in.ch[0].data() + pos, sizeof(float) * static_cast<size_t>(H));
        std::memcpy(r.data(), in.ch[1].data() + pos, sizeof(float) * static_cast<size_t>(H));
        c.process(ptrs, 2, H, p);
        if (f < skip) continue;
        for (int ch = 0; ch < 2; ++ch)
            for (int b = 0; b < B; ++b)
            {
                const double v = c.bandReductionDb(ch)[b];
                s.red[ch][static_cast<size_t>(b)] += v;
                s.maxRed[ch][static_cast<size_t>(b)] = std::max(s.maxRed[ch][static_cast<size_t>(b)], v);
            }
        for (int b = 0; b < B; ++b)
        {
            const double e = static_cast<double>(c.bandLevelDb(0)[b]) - c.bandBaselineDb(0)[b];
            s.e[static_cast<size_t>(b)] += e; s.e2[static_cast<size_t>(b)] += e * e;
        }
        ++s.n;
    }
    for (int ch = 0; ch < 2; ++ch) for (auto& v : s.red[ch]) v /= std::max<long long>(s.n, 1);
    return s;
}

int nearestBand(const Core& c, double f)
{
    int best = 0;
    for (int b = 1; b < c.numBands(); ++b)
        if (std::abs(std::log2(c.bandHz(b) / f)) < std::abs(std::log2(c.bandHz(best) / f))) best = b;
    return best;
}

// Functional checks of the detector / gain computer (stage B). Not the bench gates; coarse guards that the design
// properties the bench grades stay true in CI.
void testDetectorFunction()
{
    const double sr = 48000.0;
    Params cap; cap.depth = 1.0f; cap.hardKnee = true;   // the C1c settings

    // F1: plain pink noise, most sensitive + deepest setting: (almost) nothing is cut.
    {
        Core c; c.prepare(sr, 512, 2);
        Params sens = cap; sens.sensitivity = 1.0f;
        const BandStats s = bandStats(c, makePink(static_cast<int>(8.0 * sr), -20.0, 61), sens, 2.0);
        double mean = 0.0, mx = 0.0;
        for (int ch = 0; ch < 2; ++ch)
            for (int b = 0; b < c.numBands(); ++b)
            {
                if (c.bandHz(b) < 100.0) continue;
                mean += s.red[ch][static_cast<size_t>(b)]; mx = std::max(mx, s.red[ch][static_cast<size_t>(b)]);
            }
        mean /= 2.0 * c.numBands();
        char buf[200];
        std::snprintf(buf, sizeof buf, "F1 pink noise, sensitivity 1 / depth 1 Hard: mean band reduction %.3f dB (<= 0.2), worst band mean %.3f dB (<= 1.0)", mean, mx);
        check(mean <= 0.2 && mx <= 1.0, buf);
    }
    // F2: +12 dB / Q8 resonance at 2.5 kHz in both channels: cut close to the excess at f0, nothing an octave away.
    {
        Core c; c.prepare(sr, 512, 2);
        const BandStats s = bandStats(c, resonantPink(sr, 8.0, 2500.0, 62), cap, 2.0);
        const int b0 = nearestBand(c, 2500.0);
        double far = 0.0;
        for (int b = 0; b < c.numBands(); ++b)
            if (c.bandHz(b) >= 100.0 && std::abs(std::log2(c.bandHz(b) / 2500.0)) > 1.0) far = std::max(far, s.red[0][static_cast<size_t>(b)]);
        char buf[200];
        std::snprintf(buf, sizeof buf, "F2 resonance 2.5 kHz: cut at f0 L %.2f R %.2f dB (>= 7), worst band > 1 oct away %.3f dB (<= 0.3)",
                      s.red[0][static_cast<size_t>(b0)], s.red[1][static_cast<size_t>(b0)], far);
        check(s.red[0][static_cast<size_t>(b0)] >= 7.0 && s.red[1][static_cast<size_t>(b0)] >= 7.0 && far <= 0.3, buf);
    }
    // F3: resonance in R only. Link 0: L is left alone. Link 1: L follows R.
    for (float link : { 0.0f, 1.0f })
    {
        Stereo in = makePink(static_cast<int>(8.0 * sr), -20.0, 63);
        applyPeak(in.ch[1], sr, 1100.0, 8.0, 12.0);
        Params p = cap; p.stereoLink = link;
        Core c; c.prepare(sr, 512, 2);
        const BandStats s = bandStats(c, in, p, 2.0);
        const int b0 = nearestBand(c, 1100.0);
        const double l = s.red[0][static_cast<size_t>(b0)], r = s.red[1][static_cast<size_t>(b0)];
        char buf[200];
        std::snprintf(buf, sizeof buf, "F3 right-only resonance, link %.0f: cut at f0 L %.2f R %.2f dB", static_cast<double>(link), l, r);
        check(r >= 7.0 && (link == 0.0f ? l <= 0.3 : std::abs(l - r) <= 0.05), buf);
    }
    // F4: the threshold's sigma_E matches the measured std-dev of the excess on noise (200 Hz .. 10 kHz bands).
    {
        Core c; c.prepare(sr, 512, 2);
        const BandStats s = bandStats(c, makePink(static_cast<int>(20.0 * sr), -20.0, 64), Params{}, 2.0);
        double ratio = 0.0; int nb = 0;
        for (int b = 0; b < c.numBands(); ++b)
        {
            if (c.bandHz(b) < 200.0 || c.bandHz(b) > 10000.0) continue;
            const double m = s.e[static_cast<size_t>(b)] / s.n;
            const double sd = std::sqrt(std::max(s.e2[static_cast<size_t>(b)] / s.n - m * m, 0.0));
            ratio += sd / c.bandSigmaDb()[b]; ++nb;
        }
        ratio /= std::max(nb, 1);
        char buf[200];
        std::snprintf(buf, sizeof buf, "F4 noise: measured std(excess) / predicted sigma_E = %.3f over %d bands (0.8 .. 1.25)", ratio, nb);
        check(ratio >= 0.8 && ratio <= 1.25, buf);
    }
}

} // namespace

int main()
{
    std::printf("[ResCore] test_resonance_core\n");
    testLatency();
    testIdentityAndCola();
    testImpulse();
    testAllocations();
    testBlockSizeIndependence();
    testReset();
    testMono();
    testDetectorFunction();
    std::printf("[ResCore] --- %d passed, %d failed ---\n", g_pass, g_fail);
    return g_fail == 0 ? 0 : 1;
}
