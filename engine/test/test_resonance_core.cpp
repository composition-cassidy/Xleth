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
//   T9 hop phase    setHopPhaseOffset (prepare-time, default 0): latency stays N, depth-0 identity at every offset, the first
//                   frame completes after hop - offset samples, offsets are taken modulo the hop (0 / hop / negative are
//                   bit-identical to the default), reset() == fresh, zero allocations, the detector still cuts a resonance
//   F1-F4 detector  (stage B) pink noise not cut at the most sensitive setting; a +12 dB / Q8 resonance is cut
//                   by >= 7 dB at f0 and nothing an octave away; right-only resonance leaves L alone at link 0 and
//                   is mirrored at link 1; the threshold's predicted sigma_E matches the measured std on noise
//   D1 dynamics     (v6) step response and release in MILLISECONDS (onset t50, time for the cut to fall <= 1 dB), at 48 and 96 kHz
//   --- RS High Quality surface (every default bit-identical to before) ---
//   W0-W4 weights   grid exposure (numBands / bandCentreHz); weightCurve of 1.0 == nullptr; exact RS semantics frame by frame against an
//                   unweighted twin (w <= 1 scales, w > 1 deepens to the ceiling, clamps, NaN -> 1); weight 0 never cuts a planted resonance
//   S1-S2 sharpness -3 dB width of the cut of a Q8 resonance strictly decreasing over sharpness 0 / 0.5 / 1; clamping
//   M1-M4 channels  mono == stereo ch 0 at link 0; Mid / Side wrappers (1-channel core + aligned dry) reconstruct at depth 0 and cut only
//                   their own component; M + S as two channels == two mono cores
//   V1-V4 viz tap   one frame per hop and channel, consistent with the core's state; output unchanged; zero allocations; null-sink cost
//   E1 meters       lastMaxReductionDb per channel / combined, reset, mono
//   P1 params       depth / sensitivity / sharpness / weightCurve / stereoLink at random extremes before every block: max sample step and
//                   second difference within 1.25x of steady runs, no NaN / Inf, no allocation
//   H1-H3 hop phase hopPhaseOffsetForInstance (van der Corput); 8 instances at hop 256: <= 2 frame boundaries per 64-sample block
//   --- live frame-tier switching, aligned dry output, parameter hardening ---
//   T-A fixed tier  every tier, default and weighted / sharpened configurations: output hash == the build before live switching (85df03d)
//   T-E hardening   NaN / Inf / out-of-range in every Params field and in the weight curve: finite, bounded, == the sanitised value, no allocation
//   T-H hop phase   8 staggered instances switched together keep their staggering (offset stored as a fraction of the hop)
//   T-D0 alloc      zero operator new / delete over tier switches (every pair, cold, dryOut + aux + viz sink)
//   T-B transitions every ordered pair, pink + bell and a 1 kHz sine: max step <= 1.25x steady, no NaN, crossfade where documented, impulse at the
//                   new latency, wet + dryOut never combs at depth 0 (negative control: a dry that follows latencyFor(new) from the request)
//   T-M Mid/Side    a mono core on M with S as the delay-only aux channel reconstructs L / R on the stereo dry timeline through every switch
//   T-C continuity  detector state kept across a switch: the cut stays up and is within 1.5 dB of a fresh core of the new tier within 150 ms
//   T-D stress      a second thread requests random tiers (every 1-50 ms, and bursts) during 200 000 random-size blocks: no NaN, bounded, zero
//                   allocations (armed counter and a thread-id counter), every adoption matches a request
//
// The allocation counter hooks operator new / new[] on the measuring thread only (the same approach as
// test_effect_processblock_alloc.cpp). Output prefix: [ResCore].

#include "dsp/ResonanceCore.h"

#include <juce_core/juce_core.h>

#include <algorithm>
#include <atomic>
#include <chrono>
#include <cmath>
#include <cstddef>
#include <limits>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <new>
#include <string>
#include <thread>
#include <type_traits>
#include <vector>

// --- Counting allocator (measuring thread only, armed around process()) ----------------------------
namespace {
std::atomic<bool>      g_allocArmed { false };
std::atomic<long long> g_allocCount { 0 };
thread_local bool      t_isMeasuringThread = false;

// Second, independent filter (T-D): every allocation / free made by ONE thread (identified by std::thread::id, set before counting starts),
// whether or not it is inside process().
std::atomic<bool>      g_tidCounting { false };
std::thread::id        g_tidWatched;
std::atomic<long long> g_tidAllocCount { 0 };
std::atomic<long long> g_freeCount { 0 };       // frees on the measuring thread while armed
std::atomic<long long> g_tidFreeCount { 0 };

inline void countAlloc() noexcept
{
    if (g_allocArmed.load(std::memory_order_relaxed) && t_isMeasuringThread)
        g_allocCount.fetch_add(1, std::memory_order_relaxed);
    if (g_tidCounting.load(std::memory_order_relaxed) && std::this_thread::get_id() == g_tidWatched)
        g_tidAllocCount.fetch_add(1, std::memory_order_relaxed);
}
inline void countFree(void* p) noexcept
{
    if (p == nullptr) return;
    if (g_allocArmed.load(std::memory_order_relaxed) && t_isMeasuringThread)
        g_freeCount.fetch_add(1, std::memory_order_relaxed);
    if (g_tidCounting.load(std::memory_order_relaxed) && std::this_thread::get_id() == g_tidWatched)
        g_tidFreeCount.fetch_add(1, std::memory_order_relaxed);
}
} // namespace

void* operator new(std::size_t n)                 { countAlloc(); void* p = std::malloc(n ? n : 1); if (!p) std::abort(); return p; }
void* operator new[](std::size_t n)               { countAlloc(); void* p = std::malloc(n ? n : 1); if (!p) std::abort(); return p; }
void* operator new(std::size_t n, const std::nothrow_t&) noexcept   { countAlloc(); return std::malloc(n ? n : 1); }
void* operator new[](std::size_t n, const std::nothrow_t&) noexcept { countAlloc(); return std::malloc(n ? n : 1); }
void  operator delete(void* p) noexcept                    { countFree(p); std::free(p); }
void  operator delete[](void* p) noexcept                  { countFree(p); std::free(p); }
void  operator delete(void* p, std::size_t) noexcept       { countFree(p); std::free(p); }
void  operator delete[](void* p, std::size_t) noexcept     { countFree(p); std::free(p); }
void  operator delete(void* p, const std::nothrow_t&) noexcept   { countFree(p); std::free(p); }
void  operator delete[](void* p, const std::nothrow_t&) noexcept { countFree(p); std::free(p); }

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
void testTierSizes()
{
    bool ok = true;
    for (double sr : { 44100.0, 48000.0, 96000.0 })
    {
        const int base = sr > 50000.0 ? 2 : 1;
        const int want[3] = { 512 * base, 1024 * base, 2048 * base };
        int i = 0;
        for (Core::FrameTier t : { Core::FrameTier::Fast, Core::FrameTier::Normal, Core::FrameTier::High })
        {
            Core c; c.setFrameTier(t); c.prepare(sr, 512, 2);
            ok = ok && Core::fftSizeFor(sr, t) == want[i] && Core::latencyFor(sr, t) == want[i] && c.currentLatency() == want[i] && c.hopSize() == want[i] / 4;
            ++i;
        }
    }
    check(ok, "T1 frame tiers: N = 512 / 1024 / 2048 at 44.1 / 48 kHz (x2 at 96 kHz), latency == N, hop == N/4");
}

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

// T9: hop phase offset. Prepare-time option, default 0 = the historical behaviour. See Core::setHopPhaseOffset.
void testHopPhaseOffset();   // defined after bandStats / nearestBand (it uses them)

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

void testHopPhaseOffset()
{
    const double sr = 48000.0;
    const int N = 1024, H = 256;
    const Stereo in = makePink(static_cast<int>(3.0 * sr), -20.0, 91);
    const std::vector<int> offsets = { 1, 32, 100, 224, 255 };

    // T9a latency == N and depth-0 identity (COLA) for every offset, block 64 and the mixed schedule.
    {
        bool latOk = true;
        double worstRms = -300.0, worstMax = 0.0;
        for (int off : offsets)
            for (const std::vector<int>& sched : { std::vector<int>{ 64 }, std::vector<int>{ 1, 37, 128, 255, 511, 1024, 37 } })
            {
                Core c; c.setHopPhaseOffset(off); c.prepare(sr, 1024, 2);
                latOk = latOk && c.currentLatency() == N && c.hopPhaseOffset() == off && c.hopSize() == H;
                const Diff d = alignedDiff(in, render(c, in, sched, depth0()), c.currentLatency());
                worstRms = std::max(worstRms, d.rmsDb); worstMax = std::max(worstMax, d.maxAbs);
            }
        char buf[200];
        std::snprintf(buf, sizeof buf, "T9a hop offsets {1,32,100,224,255}: latency == N (%d) and depth-0 identity: worst rms %.1f dBFS, worst max |diff| %.2e", N, worstRms, worstMax);
        check(latOk && worstRms <= -120.0 && worstMax <= kMaxAbsAt120, buf);
    }
    // T9b a unit impulse still comes out at exactly +N with unit height.
    for (int off : { 32, 224 })
    {
        const int at = 3001, n = 16384;
        Stereo imp; imp.resize(n);
        imp.ch[0][at] = 1.0f; imp.ch[1][at] = 1.0f;
        Core c; c.setHopPhaseOffset(off); c.prepare(sr, 512, 2);
        const Stereo out = render(c, imp, { 512 }, depth0());
        int peakIdx = -1; float peak = 0.0f; double rest = 0.0;
        for (int i = 0; i < n; ++i) { const float v = std::abs(out.ch[0][static_cast<size_t>(i)]); if (v > peak) { peak = v; peakIdx = i; } }
        for (int i = 0; i < n; ++i) if (i != peakIdx) rest = std::max(rest, static_cast<double>(std::abs(out.ch[0][static_cast<size_t>(i)])));
        char buf[200];
        std::snprintf(buf, sizeof buf, "T9b impulse, offset %d: peak at +%d (expect %d), height %.7f, max elsewhere %.2e", off, peakIdx - at, c.currentLatency(), static_cast<double>(peak), rest);
        check(peakIdx - at == c.currentLatency() && std::abs(peak - 1.0f) < 1.0e-5f && rest < kMaxAbsAt120, buf);
    }
    // T9c the first frame completes after hop - offset input samples, the next one hop later.
    {
        bool ok = true;
        std::string detail;
        for (int off : { 1, 32, 100, 255 })
        {
            Core c; c.setHopPhaseOffset(off); c.prepare(sr, 512, 2);
            std::vector<float> l(static_cast<size_t>(H), 0.0f), r(static_cast<size_t>(H), 0.0f);
            float* p[2] = { l.data(), r.data() };
            const Params prm;
            c.process(p, 2, H - off - 1, prm);
            const long long f0 = c.framesProcessed();
            c.process(p, 2, 1, prm);
            const long long f1 = c.framesProcessed();
            c.process(p, 2, H - 1, prm);
            const long long f2 = c.framesProcessed();
            c.process(p, 2, 1, prm);
            const long long f3 = c.framesProcessed();
            ok = ok && f0 == 0 && f1 == 1 && f2 == 1 && f3 == 2;
            detail += " " + std::to_string(off) + ":" + std::to_string(f0) + "/" + std::to_string(f1) + "/" + std::to_string(f2) + "/" + std::to_string(f3);
        }
        check(ok, "T9c first frame after hop - offset samples, next one hop later (frames at offset:before/at/+hop-1/+hop =" + detail + ")");
    }
    // T9d offsets are taken modulo the hop; 0 / hop / negative are the default, bit-identical (detector and gain computer active).
    {
        const Stereo sig = resonantPink(sr, 3.0, 2500.0, 92);
        Params cap; cap.depth = 1.0f; cap.hardKnee = true;
        Core def; def.prepare(sr, 512, 2);
        const Stereo ref = render(def, sig, { 333 }, cap);
        bool zeroSame = true;
        for (int off : { 0, H, 2 * H, -H })
        {
            Core c; c.setHopPhaseOffset(off); c.prepare(sr, 512, 2);
            zeroSame = zeroSame && c.hopPhaseOffset() == 0 && sameDiff(ref, render(c, sig, { 333 }, cap)).maxAbs == 0.0;
        }
        check(zeroSame, "T9d offsets 0 / hop / 2 hops / -hop are bit-identical to a core that never called setHopPhaseOffset");
        Core a; a.setHopPhaseOffset(32); a.prepare(sr, 512, 2);
        const Stereo r32 = render(a, sig, { 333 }, cap);
        bool modSame = a.hopPhaseOffset() == 32;
        for (int off : { 32 + H, 32 - H, 32 + 4 * H })
        {
            Core c; c.setHopPhaseOffset(off); c.prepare(sr, 512, 2);
            modSame = modSame && c.hopPhaseOffset() == 32 && sameDiff(r32, render(c, sig, { 333 }, cap)).maxAbs == 0.0;
        }
        check(modSame, "T9d offset 32 == 32 + hop == 32 - hop == 32 + 4 hops (bit-identical)");
        // block-size independence holds with an offset too.
        Core b; b.setHopPhaseOffset(100); b.prepare(sr, 512, 2);
        Core b2; b2.setHopPhaseOffset(100); b2.prepare(sr, 512, 2);
        const Diff bd = sameDiff(render(b, sig, { 64 }, cap), render(b2, sig, { 1, 37, 128, 255, 511, 1024, 37 }, cap));
        char buf[160];
        std::snprintf(buf, sizeof buf, "T9d block-size independence with offset 100 (64 vs mixed): rms %.1f dBFS, max |diff| %.2e", bd.rmsDb, bd.maxAbs);
        check(bd.rmsDb <= -120.0 && bd.maxAbs <= kMaxAbsAt120, buf);
    }
    // T9e reset() == a freshly prepared instance, with an offset.
    {
        const Stereo a = resonantPink(sr, 2.0, 1100.0, 93), b = resonantPink(sr, 2.0, 3700.0, 94);
        Params p; p.depth = 1.0f; p.hardKnee = true;
        Core c; c.setHopPhaseOffset(96); c.prepare(sr, 512, 2);
        (void) render(c, a, { 512 }, p);
        c.reset();
        const Stereo afterReset = render(c, b, { 333 }, p);
        Core fresh; fresh.setHopPhaseOffset(96); fresh.prepare(sr, 512, 2);
        check(sameDiff(afterReset, render(fresh, b, { 333 }, p)).maxAbs == 0.0, "T9e reset() == fresh instance with offset 96 (bit-identical)");
    }
    // T9f zero operator new in process() with an offset: static params, swept params, cold pass.
    {
        Stereo sig = makePink(static_cast<int>(4.0 * sr), -20.0, 95);
        applyPeak(sig.ch[0], sr, 2500.0, 8.0, 12.0);
        applyPeak(sig.ch[1], sr, 2500.0, 8.0, 12.0);
        long long total = 0;
        for (int mode = 0; mode < 3; ++mode)
        {
            Core c; c.setHopPhaseOffset(96); c.prepare(sr, 1024, 2);
            total += countAllocs(c, sig, 64, mode == 2 ? 0 : 200, 400, mode >= 1, mode == 2);
        }
        check(total == 0, "T9f zero operator new in process() with offset 96 (static / swept / cold, block 64): count " + std::to_string(total));
    }
    // T9g the detector works the same: a +12 dB / Q8 resonance at 2.5 kHz is cut by >= 7 dB at f0, within 1 dB of the offset-0 cut, nothing an octave away.
    {
        Params cap; cap.depth = 1.0f; cap.hardKnee = true;
        const Stereo sig = resonantPink(sr, 8.0, 2500.0, 62);
        Core c0; c0.prepare(sr, 512, 2);
        Core c1; c1.setHopPhaseOffset(100); c1.prepare(sr, 512, 2);
        const BandStats s0 = bandStats(c0, sig, cap, 2.0), s1 = bandStats(c1, sig, cap, 2.0);
        const int b0 = nearestBand(c0, 2500.0);
        double far = 0.0;
        for (int b = 0; b < c1.numBands(); ++b)
            if (c1.bandHz(b) >= 100.0 && std::abs(std::log2(c1.bandHz(b) / 2500.0)) > 1.0) far = std::max(far, s1.red[0][static_cast<size_t>(b)]);
        const double r0 = s0.red[0][static_cast<size_t>(b0)], r1 = s1.red[0][static_cast<size_t>(b0)];
        char buf[200];
        std::snprintf(buf, sizeof buf, "T9g resonance 2.5 kHz with offset 100: cut at f0 %.2f dB (offset 0: %.2f; >= 7 and within 1 dB), worst band > 1 oct away %.3f dB (<= 0.3)", r1, r0, far);
        check(r1 >= 7.0 && std::abs(r1 - r0) <= 1.0 && far <= 0.3, buf);
    }
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

// Bounds on the dynamics below (ms). Stage A recorded the starting point; stage B tightened them to the two-speed detector.
constexpr double kOnsetT50MaxMs     = 100.0;   // measured: stage A 80 / 85 / 91 / 107 ms; two-speed detector 48 / 64 / 80 / 85 ms
constexpr double kTierOnsetMaxMs    = 120.0;   // D3, all three tiers (the window length shifts the onset by about half a window)
constexpr double kTierReleaseMaxMs  = 800.0;
constexpr double kRelease1dBMaxMs   = 700.0;   // measured: stage A 704 / 704 / 832 / 843 ms; two-speed detector 523 / 592 / 555 / 661 ms (a 9 dB cut at the 200 ms release needs 446 ms)

// ---- Dynamics (v6 stage A): the detector's / gain computer's step response and release in MILLISECONDS ----------
// A +12 dB / Q8 bell is switched ON and OFF (5 ms linear crossfades between the clean pink noise C and the bell-filtered
// noise A of the SAME noise: x = C + g (A - C)) at hop-aligned times, 6 events, 1.2 s on, 2.5 s off. The applied reduction
// (bandReductionDb, the gain computer's output) at the band of f0 (max over +/-1/6 oct of the band grid) is averaged over the
// events at every frame. onset_t50 = time after the onset until the reduction first reaches 50 % of its steady value (mean
// over the last 200 ms of the on-time); release_1dB = time after the offset until it is <= 1 dB. Both are in ms, so they
// must not depend on N: run at 48 kHz (N = 1024) and 96 kHz (N = 2048) -- same ms, double the FFT size.
struct DynResult { double steady = 0.0, t50 = -1.0, tRel1dB = -1.0; };

DynResult measureDynamics(double sr, double f0, const Params& prm, float fastMs = -1.0f, Core::FrameTier tier = Core::FrameTier::Normal)
{
    DynResult out;
    Core c;
    if (fastMs >= 0.0f) c.setFastTimeConstantMs(fastMs);
    c.setFrameTier(tier);
    c.prepare(sr, 512, 2);
    const int H = c.hopSize();
    const int onFrames = static_cast<int>(std::llround(1.2 * sr / H)), offFrames = static_cast<int>(std::llround(2.5 * sr / H));
    const int firstOnset = static_cast<int>(std::llround(3.0 * sr / H));
    const int nEv = 6, evFrames = onFrames + offFrames, total = firstOnset + nEv * evFrames + static_cast<int>(std::llround(1.0 * sr / H));
    const int n = total * H;
    Stereo C = makePink(n, -20.0, 71), A = C;
    for (int ch = 0; ch < 2; ++ch) applyPeak(A.ch[ch], sr, f0, 8.0, 12.0);
    const int fade = static_cast<int>(std::llround(0.005 * sr));
    std::vector<double> g(static_cast<size_t>(n), 0.0);
    for (int e = 0; e < nEv; ++e)
    {
        const int on = (firstOnset + e * evFrames) * H, off = on + onFrames * H;
        for (int i = on; i < off + fade && i < n; ++i)
        {
            double v = 1.0;
            if (i < on + fade) v = std::min(v, static_cast<double>(i - on) / fade);
            if (i >= off)      v = std::min(v, 1.0 - static_cast<double>(i - off) / fade);
            g[static_cast<size_t>(i)] = v;
        }
    }
    Stereo x = C;
    for (int ch = 0; ch < 2; ++ch)
        for (int i = 0; i < n; ++i)
            x.ch[ch][static_cast<size_t>(i)] = C.ch[ch][static_cast<size_t>(i)] + static_cast<float>(g[static_cast<size_t>(i)]) * (A.ch[ch][static_cast<size_t>(i)] - C.ch[ch][static_cast<size_t>(i)]);

    std::vector<int> bands;
    for (int b = 0; b < c.numBands(); ++b)
        if (std::abs(std::log2(c.bandHz(b) / f0)) <= 1.0 / 6.0) bands.push_back(b);
    std::vector<double> red(static_cast<size_t>(total), 0.0);
    std::vector<float> l(static_cast<size_t>(H)), r(static_cast<size_t>(H));
    float* ptrs[2] = { l.data(), r.data() };
    for (int f = 0; f < total; ++f)
    {
        std::memcpy(l.data(), x.ch[0].data() + static_cast<size_t>(f) * H, sizeof(float) * static_cast<size_t>(H));
        std::memcpy(r.data(), x.ch[1].data() + static_cast<size_t>(f) * H, sizeof(float) * static_cast<size_t>(H));
        c.process(ptrs, 2, H, prm);
        double m = 0.0;
        for (int b : bands) m = std::max(m, static_cast<double>(c.bandReductionDb(0)[b]));
        red[static_cast<size_t>(f)] = m;
    }
    // Detection runs on the frame that contains the data: the frame whose process() call received the last hop of the
    // window is the one analysed, so frame index f corresponds to the input up to (f + 1) H samples.
    auto evMean = [&](int rel) { double s = 0.0; for (int e = 0; e < nEv; ++e) s += red[static_cast<size_t>(firstOnset + e * evFrames + rel)]; return s / nEv; };
    const double hopMs = 1000.0 * H / sr;
    const int last200 = static_cast<int>(std::llround(200.0 / hopMs));
    double st = 0.0;
    for (int k = onFrames - last200; k < onFrames; ++k) st += evMean(k);
    out.steady = st / last200;
    for (int k = 0; k < onFrames; ++k)
        if (evMean(k) >= 0.5 * out.steady) { out.t50 = (k + 1) * hopMs; break; }       // (k + 1) hops of input have been seen
    for (int k = onFrames; k < evFrames; ++k)
        if (evMean(k) <= 1.0) { out.tRel1dB = (k + 1 - onFrames) * hopMs; break; }
    return out;
}

void testDynamics()
{
    Params cap; cap.depth = 1.0f; cap.hardKnee = true;    // the C1c settings: attack 15 ms, release 200 ms
    for (double sr : { 48000.0, 96000.0 })
        for (double f0 : { 500.0, 2500.0 })
        {
            const DynResult d = measureDynamics(sr, f0, cap);
            char buf[260];
            std::snprintf(buf, sizeof buf, "D1 step response sr %.0f (N %d) f0 %.0f: steady cut %.2f dB (>= 4), onset_t50 %.1f ms (<= %.0f), release to <= 1 dB %.1f ms (<= %.0f)",
                          sr, Core::fftSizeFor(sr), f0, d.steady, d.t50, kOnsetT50MaxMs, d.tRel1dB, kRelease1dBMaxMs);
            check(d.steady >= 4.0 && d.t50 >= 0.0 && d.t50 <= kOnsetT50MaxMs && d.tRel1dB >= 0.0 && d.tRel1dB <= kRelease1dBMaxMs, buf);
        }
    // D3 (frame-size tiers, v6 stage C): every time constant is in ms, so the step response must not follow N. Fast (N 512), Normal
    // (1024), High (2048) at 48 kHz; only the analysis window's own length (10.7 / 21.3 / 42.7 ms) may show.
    for (Core::FrameTier t : { Core::FrameTier::Fast, Core::FrameTier::Normal, Core::FrameTier::High })
        for (double f0 : { 500.0, 2500.0 })
        {
            const DynResult d = measureDynamics(48000.0, f0, cap, -1.0f, t);
            char buf[260];
            std::snprintf(buf, sizeof buf, "D3 tier N %d f0 %.0f: steady cut %.2f dB (>= 4), onset_t50 %.1f ms (<= %.0f), release to <= 1 dB %.1f ms (<= %.0f)",
                          Core::fftSizeFor(48000.0, t), f0, d.steady, d.t50, kTierOnsetMaxMs, d.tRel1dB, kTierReleaseMaxMs);
            check(d.steady >= 4.0 && d.t50 >= 0.0 && d.t50 <= kTierOnsetMaxMs && d.tRel1dB >= 0.0 && d.tRel1dB <= kTierReleaseMaxMs, buf);
        }
    // D2: the fast path is what makes the difference, and it costs nothing in steady state: with it OFF (slow only) the onset
    // is slower and the release much slower; the steady cut differs by <= 0.5 dB.
    {
        const DynResult on = measureDynamics(48000.0, 2500.0, cap), off = measureDynamics(48000.0, 2500.0, cap, 0.0f);
        char buf[260];
        std::snprintf(buf, sizeof buf, "D2 two-speed vs slow-only (48 kHz, 2500 Hz): steady cut %.2f vs %.2f dB (<= 0.5 apart), onset_t50 %.1f vs %.1f ms (faster), release to <= 1 dB %.1f vs %.1f ms (>= 150 ms faster)",
                      on.steady, off.steady, on.t50, off.t50, on.tRel1dB, off.tRel1dB);
        check(std::abs(on.steady - off.steady) <= 0.5 && on.t50 < off.t50 && on.tRel1dB + 150.0 <= off.tRel1dB, buf);
    }
}

// ===================================================================================================
// RS High Quality surface (after f2d825d): grid + weight curve (W), sharpness (S), 1 / 2 channels and Mid / Side (M),
// visualization tap (V), meters (E), parameter-change safety (P), instance hop-phase helper (H).

// Mean applied reduction per band of a MONO stream (channel 0 of a core), hop-sized blocks, after skipSec.
std::vector<double> monoBandMean(Core& c, const std::vector<float>& x, const Params& p, double skipSec)
{
    const int H = c.hopSize(), B = c.numBands();
    std::vector<double> m(static_cast<size_t>(B), 0.0);
    std::vector<float> buf(static_cast<size_t>(H));
    float* ptrs[1] = { buf.data() };
    const int skip = static_cast<int>(skipSec * c.sampleRate()) / H;
    long long n = 0;
    for (int pos = 0, f = 0; pos + H <= static_cast<int>(x.size()); pos += H, ++f)
    {
        std::memcpy(buf.data(), x.data() + pos, sizeof(float) * static_cast<size_t>(H));
        c.process(ptrs, 1, H, p);
        if (f < skip) continue;
        for (int b = 0; b < B; ++b) m[static_cast<size_t>(b)] += c.bandReductionDb(0)[b];
        ++n;
    }
    for (auto& v : m) v /= static_cast<double>(std::max<long long>(n, 1));
    return m;
}

void testWeightCurve()
{
    const double sr = 48000.0;
    // W0: grid exposure. numBands() == kGridBands, centres strictly increasing from 20 Hz to min(0.45 fs, 20 kHz), bandCentreHz == bandHz.
    for (double r : { 44100.0, 48000.0, 96000.0 })
    {
        Core c; c.prepare(r, 512, 2);
        bool inc = true;
        for (int b = 1; b < c.numBands(); ++b) inc = inc && c.bandCentreHz(b) > c.bandCentreHz(b - 1) && c.bandCentreHz(b) == c.bandHz(b);
        const double lo = c.bandCentreHz(0), hi = c.bandCentreHz(c.numBands() - 1), hiExp = std::min(0.45 * r, 20000.0);
        char buf[220];
        std::snprintf(buf, sizeof buf, "W0 grid @%d: numBands %d (== %d), centres increasing %d, first %.3f Hz (20), last %.2f Hz (%.0f)",
                      static_cast<int>(r), c.numBands(), xleth::dsp::resonance::kGridBands, inc ? 1 : 0, lo, hi, hiExp);
        check(c.numBands() == xleth::dsp::resonance::kGridBands && inc && std::abs(lo - 20.0) < 0.01 && std::abs(hi - hiExp) < 0.5, buf);
    }

    Params cap; cap.depth = 1.0f; cap.hardKnee = true;   // C1c
    const Stereo in = resonantPink(sr, 6.0, 2500.0, 81);
    const int B = xleth::dsp::resonance::kGridBands;

    // W1: a curve of 1.0 everywhere is bit-identical to nullptr.
    {
        std::vector<float> ones(static_cast<size_t>(B), 1.0f);
        Params pw = cap; pw.weightCurve = ones.data();
        Core a, b; a.prepare(sr, 512, 2); b.prepare(sr, 512, 2);
        const Diff d = sameDiff(render(a, in, { 64, 333 }, cap), render(b, in, { 64, 333 }, pw));
        check(d.maxAbs == 0.0, "W1 weightCurve of 1.0 == nullptr: bit-identical output (C1c, 2.5 kHz resonance, blocks 64/333), max |diff| " + std::to_string(d.maxAbs));
    }

    // W2: exact semantics against an unweighted twin, frame by frame: w <= 1 -> w x R, w > 1 -> min(w x R, max(Rmax, R)), clamp [0, 2.5], negative -> 0, NaN / Inf -> 1 (intake hardening; before it NaN read as 0).
    //     C1 (depth 0.5, Soft: ceiling 6 dB) so weights above 1 reach the ceiling; link 0.5 and a right-only resonance exercise the stereo link.
    {
        Stereo x = makePink(static_cast<int>(6.0 * sr), -20.0, 82);
        applyPeak(x.ch[0], sr, 2500.0, 8.0, 12.0); applyPeak(x.ch[1], sr, 2500.0, 8.0, 12.0); applyPeak(x.ch[1], sr, 800.0, 8.0, 12.0);
        const float nanv = std::numeric_limits<float>::quiet_NaN();
        const float pat[8] = { 0.0f, 0.3f, 1.0f, 1.7f, 2.5f, 4.0f, -1.0f, nanv };
        std::vector<float> w(static_cast<size_t>(B));
        for (int b = 0; b < B; ++b) w[static_cast<size_t>(b)] = pat[b % 8];
        Params pu; pu.stereoLink = 0.5f;
        Params pw = pu; pw.weightCurve = w.data();
        const float rMax = pu.depth * 12.0f;
        Core cu, cw; cu.prepare(sr, 512, 2); cw.prepare(sr, 512, 2);
        const int H = cu.hopSize();
        std::vector<float> l(static_cast<size_t>(H)), r(static_cast<size_t>(H)), l2 = l, r2 = r;
        float* pU[2] = { l.data(), r.data() };
        float* pW[2] = { l2.data(), r2.data() };
        long long mismatch = 0, checked = 0, atCeiling = 0, deeper = 0, zeroed = 0;
        for (int pos = 0; pos + H <= x.size(); pos += H)
        {
            std::memcpy(l.data(), x.ch[0].data() + pos, sizeof(float) * static_cast<size_t>(H)); l2 = l;
            std::memcpy(r.data(), x.ch[1].data() + pos, sizeof(float) * static_cast<size_t>(H)); r2 = r;
            cu.process(pU, 2, H, pu);
            cw.process(pW, 2, H, pw);
            for (int ch = 0; ch < 2; ++ch)
                for (int b = 0; b < B; ++b)
                {
                    const float u = cu.bandReductionDb(ch)[b], v = cw.bandReductionDb(ch)[b];
                    const float wr = w[static_cast<size_t>(b)];
                    const float ww = !std::isfinite(wr) ? 1.0f : (wr > 0.0f ? std::min(wr, 2.5f) : 0.0f);   // hardening: non-finite = 1 (unweighted)
                    const float expect = ww <= 1.0f ? ww * u : std::min(ww * u, std::max(rMax, u));
                    if (v != expect) ++mismatch;
                    ++checked;
                    if (ww > 1.0f && u > 0.0f && v == rMax) ++atCeiling;
                    if (v > u) ++deeper;
                    if (ww == 0.0f && u > 1.0f && v == 0.0f) ++zeroed;
                }
        }
        char buf[260];
        std::snprintf(buf, sizeof buf, "W2 weight semantics vs unweighted twin (C1, link 0.5, weights {0,.3,1,1.7,2.5,4->2.5,-1->0,NaN->1}): %lld / %lld band values differ; "
                      "deeper than unweighted %lld, at the 6 dB ceiling %lld, cut > 1 dB zeroed %lld", mismatch, checked, deeper, atCeiling, zeroed);
        check(mismatch == 0 && deeper > 0 && atCeiling > 0 && zeroed > 0, buf);
    }

    // W3: weight 0 over +-1/2 octave around a planted resonance: those bands are never cut (every frame, both channels), every weight-1 band is
    //     exactly the unweighted core, and the unweighted core does cut the resonance.
    {
        std::vector<float> notch(static_cast<size_t>(B), 1.0f);
        Core probe; probe.prepare(sr, 512, 2);
        int nZero = 0;
        for (int b = 0; b < B; ++b)
            if (std::abs(std::log2(probe.bandCentreHz(b) / 2500.0)) <= 0.5) { notch[static_cast<size_t>(b)] = 0.0f; ++nZero; }
        Params pw = cap; pw.weightCurve = notch.data();
        Core ref, c; ref.prepare(sr, 512, 2); c.prepare(sr, 512, 2);
        const BandStats sRef = bandStats(ref, in, cap, 0.0), sW = bandStats(c, in, pw, 0.0);
        const int b0 = nearestBand(c, 2500.0);
        double zMax = 0.0; bool othersSame = true;
        for (int ch = 0; ch < 2; ++ch)
            for (int b = 0; b < B; ++b)
            {
                if (notch[static_cast<size_t>(b)] == 0.0f) zMax = std::max(zMax, sW.maxRed[ch][static_cast<size_t>(b)]);
                else othersSame = othersSame && sW.red[ch][static_cast<size_t>(b)] == sRef.red[ch][static_cast<size_t>(b)];
            }
        char buf[260];
        std::snprintf(buf, sizeof buf, "W3 weight 0 on %d bands within +-1/2 oct of 2.5 kHz: max cut there %.3g dB over every frame (== 0), unweighted cut at f0 %.2f dB (>= 7), weight-1 bands identical %d",
                      nZero, zMax, sRef.red[0][static_cast<size_t>(b0)], othersSame ? 1 : 0);
        check(zMax == 0.0 && sRef.red[0][static_cast<size_t>(b0)] >= 7.0 && othersSame, buf);
    }

    // W4: weights above 1 deepen what was detected, up to the depth ceiling and never beyond (C1: depth 0.5 Soft, ceiling 6 dB); they create no cut on plain noise.
    {
        double cut[3] = { 0, 0, 0 };
        const float ws[3] = { 1.0f, 1.5f, 2.5f };
        double peakMax = 0.0;
        for (int i = 0; i < 3; ++i)
        {
            std::vector<float> flat(static_cast<size_t>(B), ws[i]);
            Params pw; pw.weightCurve = flat.data();
            Core c; c.prepare(sr, 512, 2);
            const BandStats s = bandStats(c, in, pw, 2.0);
            cut[i] = s.red[0][static_cast<size_t>(nearestBand(c, 2500.0))];
            for (int b = 0; b < B; ++b) peakMax = std::max(peakMax, s.maxRed[0][static_cast<size_t>(b)]);
        }
        std::vector<float> flat25(static_cast<size_t>(B), 2.5f);
        Params pn; pn.weightCurve = flat25.data();
        Core cn; cn.prepare(sr, 512, 2);
        const BandStats sn = bandStats(cn, makePink(static_cast<int>(6.0 * sr), -20.0, 83), pn, 2.0);
        double noiseMean = 0.0; int nb = 0;
        for (int b = 0; b < B; ++b) if (cn.bandCentreHz(b) >= 100.0) { noiseMean += sn.red[0][static_cast<size_t>(b)]; ++nb; }
        noiseMean /= std::max(nb, 1);
        char buf[260];
        std::snprintf(buf, sizeof buf, "W4 flat weight 1 / 1.5 / 2.5 (C1, ceiling 6 dB): mean cut at f0 %.2f / %.2f / %.2f dB (increasing), max band cut %.3f dB (<= 6), plain pink at 2.5: mean %.3f dB (<= 0.3)",
                      cut[0], cut[1], cut[2], peakMax, noiseMean);
        check(cut[1] >= cut[0] + 0.5 && cut[2] >= cut[1] && peakMax <= 6.0 + 1e-6 && noiseMean <= 0.3, buf);
    }
}

// -3 dB width (octaves) of the cut around f0: the span where the mean applied band reduction is >= levelDb, crossings interpolated on log2 f.
double cutWidthOct(const Core& c, const std::vector<double>& red, double f0, double levelDb, double& peak)
{
    const int B = c.numBands(), b0 = nearestBand(c, f0);
    int bp = b0;
    for (int b = std::max(0, b0 - 3); b <= std::min(B - 1, b0 + 3); ++b) if (red[static_cast<size_t>(b)] > red[static_cast<size_t>(bp)]) bp = b;
    peak = red[static_cast<size_t>(bp)];
    if (peak < levelDb) return 0.0;
    auto x = [&](int b) { return std::log2(static_cast<double>(c.bandCentreHz(b))); };
    auto R = [&](int b) { return red[static_cast<size_t>(b)]; };
    int lo = bp, hi = bp;
    while (lo > 0 && R(lo - 1) >= levelDb) --lo;
    while (hi < B - 1 && R(hi + 1) >= levelDb) ++hi;
    double xl = x(lo), xh = x(hi);
    if (lo > 0)     { const double t = (levelDb - R(lo - 1)) / (R(lo) - R(lo - 1)); xl = x(lo - 1) + t * (x(lo) - x(lo - 1)); }
    if (hi < B - 1) { const double t = (R(hi) - levelDb) / (R(hi) - R(hi + 1)); xh = x(hi) + t * (x(hi + 1) - x(hi)); }
    return xh - xl;
}

void testSharpness()
{
    const double sr = 48000.0;
    Params cap; cap.depth = 1.0f; cap.hardKnee = true;   // C1c
    for (double f0 : { 1000.0, 2500.0 })
    {
        const Stereo in = resonantPink(sr, 8.0, f0, f0 > 2000.0 ? 85 : 86);
        double w[3] = { 0, 0, 0 }, pk[3] = { 0, 0, 0 };
        const float sh[3] = { 0.0f, 0.5f, 1.0f };
        for (int i = 0; i < 3; ++i)
        {
            Params p = cap; p.sharpness = sh[i];
            Core c; c.prepare(sr, 512, 2);
            const BandStats s = bandStats(c, in, p, 2.0);
            w[i] = cutWidthOct(c, s.red[0], f0, 3.0, pk[i]);
        }
        char buf[260];
        std::snprintf(buf, sizeof buf, "S1 sharpness 0 / 0.5 / 1, Q8 +12 dB at %.0f Hz (C1c): -3 dB width of the cut %.3f / %.3f / %.3f oct (%.0f / %.0f / %.0f Hz; strictly narrower), peak cut %.2f / %.2f / %.2f dB",
                      f0, w[0], w[1], w[2], f0 * (std::exp2(w[0] / 2) - std::exp2(-w[0] / 2)), f0 * (std::exp2(w[1] / 2) - std::exp2(-w[1] / 2)),
                      f0 * (std::exp2(w[2] / 2) - std::exp2(-w[2] / 2)), pk[0], pk[1], pk[2]);
        check(w[0] > w[1] && w[1] > w[2] && w[2] > 0.0, buf);
    }
    // S2: the default (0.5) and an explicit 0.5 are the same thing; values outside 0..1 clamp (NaN = default) - bit-identical outputs.
    {
        const Stereo in = resonantPink(sr, 3.0, 2500.0, 87);
        Params pNaN = cap; pNaN.sharpness = std::numeric_limits<float>::quiet_NaN();
        Params pBig = cap; pBig.sharpness = 7.0f;
        Params pOne = cap; pOne.sharpness = 1.0f;
        Core a, b, c, d; a.prepare(sr, 512, 2); b.prepare(sr, 512, 2); c.prepare(sr, 512, 2); d.prepare(sr, 512, 2);
        const bool nanSame = sameDiff(render(a, in, { 256 }, cap), render(b, in, { 256 }, pNaN)).maxAbs == 0.0;
        const bool bigSame = sameDiff(render(c, in, { 256 }, pOne), render(d, in, { 256 }, pBig)).maxAbs == 0.0;
        check(nanSame && bigSame, "S2 sharpness NaN == default 0.5 and 7.0 == 1.0 (bit-identical outputs)");
    }
}

// Effect-side Mid / Side wrapper exactly as the RS HQ path does it (processHighQualityMidMode / SideMode): the chosen component (M = (L + R) / 2 or
// S = (L - R) / 2) goes through a 1-channel core, the other one through a dry delay of exactly the core latency, then L = M + S, R = M - S.
Stereo renderMidSide(Core& core, const Stereo& in, bool side, const Params& p, int block)
{
    const int n = in.size(), lat = core.currentLatency();
    std::vector<float> comp(static_cast<size_t>(n)), other(static_cast<size_t>(n));
    for (int i = 0; i < n; ++i)
    {
        const float m = 0.5f * (in.ch[0][static_cast<size_t>(i)] + in.ch[1][static_cast<size_t>(i)]);
        const float s = 0.5f * (in.ch[0][static_cast<size_t>(i)] - in.ch[1][static_cast<size_t>(i)]);
        comp[static_cast<size_t>(i)] = side ? s : m;
        other[static_cast<size_t>(i)] = side ? m : s;
    }
    for (int pos = 0; pos < n; pos += block)
    {
        float* ptr[1] = { comp.data() + pos };
        core.process(ptr, 1, std::min(block, n - pos), p);
    }
    Stereo out; out.resize(n);
    for (int i = 0; i < n; ++i)
    {
        const float od = i >= lat ? other[static_cast<size_t>(i - lat)] : 0.0f;
        const float mid = side ? od : comp[static_cast<size_t>(i)];
        const float sd  = side ? comp[static_cast<size_t>(i)] : od;
        out.ch[0][static_cast<size_t>(i)] = mid + sd;
        out.ch[1][static_cast<size_t>(i)] = mid - sd;
    }
    return out;
}

void testChannelModes()
{
    const double sr = 48000.0;
    Params cap; cap.depth = 1.0f; cap.hardKnee = true;
    // M1: a 1-channel core == channel 0 of a 2-channel core at link 0, and a 2-channel-prepared core processing 1 channel == the 1-channel core (bit-identical).
    {
        Stereo in = makePink(static_cast<int>(4.0 * sr), -20.0, 91);
        applyPeak(in.ch[0], sr, 1100.0, 8.0, 12.0); applyPeak(in.ch[1], sr, 3300.0, 8.0, 12.0);
        Core c2, c1, c21; c2.prepare(sr, 512, 2); c1.prepare(sr, 512, 1); c21.prepare(sr, 512, 2);
        const Stereo o2 = render(c2, in, { 100 }, cap), o1 = render(c1, in, { 100 }, cap, 1), o21 = render(c21, in, { 100 }, cap, 1);
        const bool sameAs2 = o1.ch[0] == o2.ch[0], same21 = o21.ch[0] == o1.ch[0] && o21.ch[1] == in.ch[1];
        check(sameAs2 && same21, std::string("M1 mono core == ch 0 of a stereo core at link 0: ") + (sameAs2 ? "bit-identical" : "DIFFERS")
                                  + "; 2-ch core run with 1 channel == mono core, ch 1 untouched: " + (same21 ? "yes" : "NO"));
    }
    // Mid / Side material: M = pink + a 1.5 kHz resonance, S = pink (-6 dB) + a 4 kHz resonance; L = M + S, R = M - S.
    Stereo ms;
    {
        Stereo a = makePink(static_cast<int>(8.0 * sr), -20.0, 92);
        applyPeak(a.ch[0], sr, 1500.0, 8.0, 12.0);
        applyPeak(a.ch[1], sr, 4000.0, 8.0, 12.0);
        ms.resize(a.size());
        for (int i = 0; i < a.size(); ++i)
        {
            const float m = a.ch[0][static_cast<size_t>(i)], s = 0.5f * a.ch[1][static_cast<size_t>(i)];
            ms.ch[0][static_cast<size_t>(i)] = m + s;
            ms.ch[1][static_cast<size_t>(i)] = m - s;
        }
    }
    // M2: the Mid and the Side wrapper reconstruct the latency-aligned input at depth 0.
    for (int side = 0; side < 2; ++side)
    {
        Core c; c.prepare(sr, 512, 1);
        const Stereo out = renderMidSide(c, ms, side == 1, depth0(), 100);
        const Diff d = alignedDiff(ms, out, c.currentLatency());
        char buf[200];
        std::snprintf(buf, sizeof buf, "M2 %s wrapper (1-channel core + latency-aligned dry of the other component), depth 0: rms %.1f dBFS, max |diff| %.2e",
                      side ? "Side" : "Mid", d.rmsDb, d.maxAbs);
        check(d.rmsDb <= -120.0 && d.maxAbs <= kMaxAbsAt120, buf);
    }
    // M3: Mid mode cuts the Mid resonance and not the Side one; Side mode the reverse (C1c, the 1-channel core's band reductions).
    for (int side = 0; side < 2; ++side)
    {
        std::vector<float> comp(static_cast<size_t>(ms.size()));
        for (int i = 0; i < ms.size(); ++i)
            comp[static_cast<size_t>(i)] = side ? 0.5f * (ms.ch[0][static_cast<size_t>(i)] - ms.ch[1][static_cast<size_t>(i)])
                                                : 0.5f * (ms.ch[0][static_cast<size_t>(i)] + ms.ch[1][static_cast<size_t>(i)]);
        Core c; c.prepare(sr, 512, 1);
        const std::vector<double> m = monoBandMean(c, comp, cap, 2.0);
        const double own = m[static_cast<size_t>(nearestBand(c, side ? 4000.0 : 1500.0))], foreign = m[static_cast<size_t>(nearestBand(c, side ? 1500.0 : 4000.0))];
        char buf[200];
        std::snprintf(buf, sizeof buf, "M3 %s mode: cut at its own resonance (%s) %.2f dB (>= 7), at the other component's (%s) %.3f dB (<= 0.3)",
                      side ? "Side" : "Mid", side ? "4 kHz" : "1.5 kHz", own, side ? "1.5 kHz" : "4 kHz", foreign);
        check(own >= 7.0 && foreign <= 0.3, buf);
    }
    // M4: M and S as the two channels of one core at link 0 == two separate 1-channel cores (bit-identical): an "M + S" mode costs one core.
    {
        Stereo msIn; msIn.resize(ms.size());
        for (int i = 0; i < ms.size(); ++i)
        {
            msIn.ch[0][static_cast<size_t>(i)] = 0.5f * (ms.ch[0][static_cast<size_t>(i)] + ms.ch[1][static_cast<size_t>(i)]);
            msIn.ch[1][static_cast<size_t>(i)] = 0.5f * (ms.ch[0][static_cast<size_t>(i)] - ms.ch[1][static_cast<size_t>(i)]);
        }
        Core both, cm, cs; both.prepare(sr, 512, 2); cm.prepare(sr, 512, 1); cs.prepare(sr, 512, 1);
        const Stereo ob = render(both, msIn, { 64 }, cap);
        Stereo sOnly; sOnly.resize(msIn.size()); sOnly.ch[0] = msIn.ch[1];
        const Stereo om = render(cm, msIn, { 64 }, cap, 1), os = render(cs, sOnly, { 64 }, cap, 1);
        check(ob.ch[0] == om.ch[0] && ob.ch[1] == os.ch[0], "M4 M and S as the two channels of one core (link 0) == two 1-channel cores (bit-identical)");
    }
}

using xleth::dsp::resonance::VizFrame;
using xleth::dsp::resonance::VizSink;

// The frame layout documented in ResonanceCore.md section 8.4.
static_assert(std::is_trivially_copyable<VizFrame>::value && std::is_standard_layout<VizFrame>::value, "VizFrame must be POD-like");
static_assert(alignof(VizFrame) == 8 && sizeof(VizFrame) == 24 + 3 * sizeof(float) * xleth::dsp::resonance::kGridBands, "VizFrame layout (1176 bytes)");
static_assert(offsetof(VizFrame, channel) == 8 && offsetof(VizFrame, numBands) == 12 && offsetof(VizFrame, hopSize) == 16 && offsetof(VizFrame, maxReductionDb) == 20
              && offsetof(VizFrame, levelDb) == 24 && offsetof(VizFrame, baselineDb) == 408 && offsetof(VizFrame, reductionDb) == 792, "VizFrame field offsets");

// Checks every frame against the core's own introspection at the moment of the call.
struct CheckingSink final : VizSink
{
    const Core* core = nullptr;
    int numCh = 2;
    long long frames[2] = { 0, 0 }, nextHop[2] = { 0, 0 }, bad = 0;
    int lastChannel = -1;
    void onResonanceFrame(const VizFrame& f) noexcept override
    {
        if (f.channel < 0 || f.channel >= numCh) { ++bad; return; }
        const int c = f.channel, B = core->numBands();
        if (f.hopIndex != nextHop[c] || f.hopIndex != core->framesProcessed()) ++bad;
        if (c != (lastChannel + 1) % numCh) ++bad;
        if (f.numBands != B || f.hopSize != core->hopSize()) ++bad;
        float m = 0.0f;
        for (int b = 0; b < B; ++b) m = std::max(m, f.reductionDb[b]);
        if (m != f.maxReductionDb) ++bad;
        const size_t bytes = sizeof(float) * static_cast<size_t>(B);
        if (std::memcmp(f.reductionDb, core->bandReductionDb(c), bytes) != 0) ++bad;
        if (std::memcmp(f.levelDb, core->bandFastLevelDb(c), bytes) != 0) ++bad;
        if (std::memcmp(f.baselineDb, core->bandFastBaselineDb(c), bytes) != 0) ++bad;
        nextHop[c] = f.hopIndex + 1; ++frames[c]; lastChannel = c;
    }
};

struct NoopSink final : VizSink
{
    float acc = 0.0f;
    void onResonanceFrame(const VizFrame& f) noexcept override { acc += f.maxReductionDb; }
};

void testVizTap()
{
    const double sr = 48000.0;
    Params cap; cap.depth = 1.0f; cap.hardKnee = true;
    Stereo in = resonantPink(sr, 4.0, 2500.0, 95);
    applyPeak(in.ch[1], sr, 700.0, 8.0, 12.0);
    // V1 / V2: frames at the hop rate, per channel, in order, equal to the core's own state; the output is bit-identical to a run without a sink.
    {
        Core c; c.prepare(sr, 512, 2);
        CheckingSink sink; sink.core = &c;
        c.setVizSink(&sink);
        const Stereo withSink = render(c, in, { 100 }, cap);
        Core ref; ref.prepare(sr, 512, 2);
        const Stereo noSink = render(ref, in, { 100 }, cap);
        const double secs = static_cast<double>(in.size()) / sr;
        const long long expectFrames = (in.size() + c.hopPhaseOffset()) / c.hopSize();
        char buf[260];
        std::snprintf(buf, sizeof buf, "V1 viz tap, block 100: frames L %lld R %lld (expected %lld == framesProcessed %lld), %.2f frames/s per channel (sr / hop = %.2f), inconsistent frames %lld",
                      sink.frames[0], sink.frames[1], expectFrames, c.framesProcessed(), sink.frames[0] / secs, sr / c.hopSize(), sink.bad);
        check(sink.frames[0] == expectFrames && sink.frames[1] == expectFrames && c.framesProcessed() == expectFrames && sink.bad == 0, buf);
        check(sameDiff(withSink, noSink).maxAbs == 0.0, "V2 output with a viz sink == without (bit-identical)");
        // mono: one frame per hop, channel 0 only
        Core cm; cm.prepare(sr, 512, 2);
        CheckingSink sm; sm.core = &cm; sm.numCh = 1;
        cm.setVizSink(&sm);
        (void) render(cm, in, { 64 }, cap, 1);
        check(sm.frames[0] == cm.framesProcessed() && sm.frames[1] == 0 && sm.bad == 0, "V1 mono: one frame per hop on channel 0 only (" + std::to_string(sm.frames[0]) + " frames)");
    }
    // V3: zero operator new in process() with a sink set (cold pass from the first block, parameters swept every block).
    {
        Core c; c.prepare(sr, 1024, 2);
        NoopSink sink; c.setVizSink(&sink);
        const long long n = countAllocs(c, in, 64, 0, 1500, true, true);
        check(n == 0, "V3 zero operator new in process() with a viz sink (block 64, cold, params swept every block): count " + std::to_string(n));
    }
    // V4: cost. The null sink does strictly less work than a sink; the paired timing ratio null / no-op sink (median of 9 interleaved repetitions,
    //     3 s stereo at block 64) must not exceed 1.10. The no-op sink's own overhead is reported. Cost against the pre-change build: bench CPU (ResonanceCore.md).
    {
        const Stereo x = resonantPink(sr, 3.0, 2500.0, 96);
        std::vector<double> ratio, over;
        double tN = 0.0, tS = 0.0;
        for (int rep = 0; rep < 9; ++rep)
        {
            double t[2] = { 0.0, 0.0 };
            for (int k = 0; k < 2; ++k)
            {
                const int mode = (rep & 1) ? 1 - k : k;   // alternate the order
                Core c; c.prepare(sr, 64, 2);
                NoopSink sink;
                if (mode == 1) c.setVizSink(&sink);
                Stereo buf = x;
                const auto t0 = std::chrono::steady_clock::now();
                for (int pos = 0; pos + 64 <= buf.size(); pos += 64)
                {
                    float* ptrs[2] = { buf.ch[0].data() + pos, buf.ch[1].data() + pos };
                    c.process(ptrs, 2, 64, cap);
                }
                t[mode] = std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - t0).count();
            }
            ratio.push_back(t[0] / t[1]);
            over.push_back(t[1] / t[0] - 1.0);
            tN += t[0]; tS += t[1];
        }
        std::sort(ratio.begin(), ratio.end()); std::sort(over.begin(), over.end());
        char buf[220];
        std::snprintf(buf, sizeof buf, "V4 cost: null / no-op sink paired ratio median %.3f (<= 1.10); no-op sink overhead median %+.2f %%; mean %.1f / %.1f ms per 3 s stereo",
                      ratio[ratio.size() / 2], 100.0 * over[over.size() / 2], tN / 9.0, tS / 9.0);
        check(ratio[ratio.size() / 2] <= 1.10, buf);
    }
}

void testMeters()
{
    const double sr = 48000.0;
    static_assert(std::atomic<float>::is_always_lock_free, "lastMaxReductionDb must be lock-free");
    Params cap; cap.depth = 1.0f; cap.hardKnee = true;
    Stereo in = makePink(static_cast<int>(4.0 * sr), -20.0, 97);
    applyPeak(in.ch[1], sr, 1800.0, 8.0, 12.0);   // right only: the channels differ
    Core c; c.prepare(sr, 512, 2);
    const bool zeroAtStart = c.lastMaxReductionDb() == 0.0f && c.lastMaxReductionDb(0) == 0.0f && c.lastMaxReductionDb(1) == 0.0f;
    const int H = c.hopSize();
    std::vector<float> l(static_cast<size_t>(H)), r(static_cast<size_t>(H));
    float* ptrs[2] = { l.data(), r.data() };
    long long bad = 0; float peakR = 0.0f, peakL = 0.0f;
    for (int pos = 0; pos + H <= in.size(); pos += H)
    {
        std::memcpy(l.data(), in.ch[0].data() + pos, sizeof(float) * static_cast<size_t>(H));
        std::memcpy(r.data(), in.ch[1].data() + pos, sizeof(float) * static_cast<size_t>(H));
        c.process(ptrs, 2, H, cap);
        float m[2] = { 0.0f, 0.0f };
        for (int ch = 0; ch < 2; ++ch) for (int b = 0; b < c.numBands(); ++b) m[ch] = std::max(m[ch], c.bandReductionDb(ch)[b]);
        if (c.lastMaxReductionDb(0) != m[0] || c.lastMaxReductionDb(1) != m[1] || c.lastMaxReductionDb() != std::max(m[0], m[1])) ++bad;
        peakL = std::max(peakL, m[0]); peakR = std::max(peakR, m[1]);
    }
    c.reset();
    const bool zeroAfterReset = c.lastMaxReductionDb() == 0.0f && c.lastMaxReductionDb(1) == 0.0f;
    // mono processing on a 2-channel core: channel 1 reads 0, combined == channel 0
    Core cm; cm.prepare(sr, 512, 2);
    (void) render(cm, in, { 256 }, cap, 1);
    const bool monoOk = cm.lastMaxReductionDb(1) == 0.0f && cm.lastMaxReductionDb() == cm.lastMaxReductionDb(0);
    char buf[260];
    std::snprintf(buf, sizeof buf, "E1 lastMaxReductionDb: == max band reduction per channel / combined after every hop (%lld mismatches), peak L %.2f R %.2f dB, 0 at start %d / after reset %d, mono run ch1 0 %d",
                  bad, peakL, peakR, zeroAtStart ? 1 : 0, zeroAfterReset ? 1 : 0, monoOk ? 1 : 0);
    check(bad == 0 && zeroAtStart && zeroAfterReset && monoOk && peakR >= 7.0f, buf);
}

// Largest first and second differences over [skip, n) of both channels, and the count of non-finite samples.
struct StepStats { double d1 = 0.0, d2 = 0.0; long long nonFinite = 0; };
StepStats stepStats(const Stereo& y, int skip)
{
    StepStats s;
    for (int c = 0; c < 2; ++c)
        for (int i = 0; i < y.size(); ++i)
        {
            const float v = y.ch[c][static_cast<size_t>(i)];
            if (!std::isfinite(v)) { ++s.nonFinite; continue; }
            if (i < skip || i < 2) continue;
            const double a = y.ch[c][static_cast<size_t>(i - 1)], b = y.ch[c][static_cast<size_t>(i - 2)];
            s.d1 = std::max(s.d1, std::abs(v - a));
            s.d2 = std::max(s.d2, std::abs(v - 2.0 * a + b));
        }
    return s;
}

void testParamChangeSafety()
{
    const double sr = 48000.0;
    const int n = static_cast<int>(6.0 * sr);
    // Moderate-level material: pink -26 dBFS with a planted +12 dB / Q8 bell at 1.2 kHz, a 2.5 kHz tone (-22 dBFS) in both channels and a 700 Hz tone in R.
    Stereo x = makePink(n, -26.0, 101);
    for (int c = 0; c < 2; ++c) applyPeak(x.ch[c], sr, 1200.0, 8.0, 12.0);
    for (int i = 0; i < n; ++i)
    {
        const double t = i / sr;
        x.ch[0][static_cast<size_t>(i)] += static_cast<float>(0.08 * std::sin(2.0 * juce::MathConstants<double>::pi * 2500.0 * t));
        x.ch[1][static_cast<size_t>(i)] += static_cast<float>(0.08 * std::sin(2.0 * juce::MathConstants<double>::pi * 2500.0 * t + 0.7)
                                                              + 0.05 * std::sin(2.0 * juce::MathConstants<double>::pi * 700.0 * t));
    }
    const int B = xleth::dsp::resonance::kGridBands;
    std::vector<float> w0(static_cast<size_t>(B), 0.0f), w25(static_cast<size_t>(B), 2.5f);
    Params lo; lo.depth = 0.0f; lo.sensitivity = 0.0f; lo.sharpness = 0.0f; lo.weightCurve = w0.data();  lo.stereoLink = 0.0f; lo.hardKnee = true;
    Params hi; hi.depth = 1.0f; hi.sensitivity = 1.0f; hi.sharpness = 1.0f; hi.weightCurve = w25.data(); hi.stereoLink = 1.0f; hi.hardKnee = true;
    Params cap; cap.depth = 1.0f; cap.hardKnee = true;
    Params hiFlat = hi; hiFlat.weightCurve = nullptr; hiFlat.sharpness = 0.0f;
    const int skip = Core::latencyFor(sr) + static_cast<int>(0.5 * sr);

    // Steady references: every extreme held for the whole run.
    StepStats ref;
    for (const Params* p : { &lo, &hi, &cap, &hiFlat })
    {
        Core c; c.prepare(sr, 64, 2);
        const StepStats s = stepStats(render(c, x, { 64 }, *p), skip);
        ref.d1 = std::max(ref.d1, s.d1); ref.d2 = std::max(ref.d2, s.d2); ref.nonFinite += s.nonFinite;
    }
    // Stress: before EVERY block each of depth, sensitivity, sharpness, weightCurve (nullptr / all 0 / all 2.5) and stereoLink jumps to a random extreme.
    const double kBound = 1.25;
    for (int block : { 64, 100 })
    {
        Core c; c.prepare(sr, block, 2);
        Stereo y = x;
        uint64_t st = 0x5DEECE66Dull + static_cast<uint64_t>(block);
        long long allocs = 0;
        t_isMeasuringThread = true;
        for (int pos = 0; pos < n; pos += block)
        {
            st = st * 6364136223846793005ull + 1442695040888963407ull;
            const uint64_t bits = st >> 33;
            Params p;
            p.hardKnee    = true;
            p.depth       = (bits & 1u) ? 1.0f : 0.0f;
            p.sensitivity = (bits & 2u) ? 1.0f : 0.0f;
            p.sharpness   = (bits & 4u) ? 1.0f : 0.0f;
            p.stereoLink  = (bits & 8u) ? 1.0f : 0.0f;
            const int wsel = static_cast<int>((bits >> 4) % 3u);
            p.weightCurve = wsel == 0 ? nullptr : (wsel == 1 ? w0.data() : w25.data());
            const int b = std::min(block, n - pos);
            float* ptrs[2] = { y.ch[0].data() + pos, y.ch[1].data() + pos };
            g_allocCount.store(0); g_allocArmed.store(true);
            c.process(ptrs, 2, b, p);
            g_allocArmed.store(false); allocs += g_allocCount.load();
        }
        t_isMeasuringThread = false;
        const StepStats s = stepStats(y, skip);
        char buf[300];
        std::snprintf(buf, sizeof buf, "P1 params at random extremes before every block (%d): max |step| %.4f vs steady %.4f (ratio %.3f <= %.2f), max |2nd diff| %.4f vs %.4f (ratio %.3f <= %.2f), non-finite %lld, allocations %lld",
                      block, s.d1, ref.d1, s.d1 / ref.d1, kBound, s.d2, ref.d2, s.d2 / ref.d2, kBound, s.nonFinite + ref.nonFinite, allocs);
        check(s.d1 <= kBound * ref.d1 && s.d2 <= kBound * ref.d2 && s.nonFinite == 0 && ref.nonFinite == 0 && allocs == 0, buf);
    }
}

void testHopPhaseHelper()
{
    // H1: the sequence at hop 256 (Normal tier, 48 kHz) and its scaling with the hop.
    {
        const int expect[8] = { 0, 128, 64, 192, 32, 160, 96, 224 };
        bool ok = true;
        std::string got;
        for (int i = 0; i < 8; ++i)
        {
            const int v = Core::hopPhaseOffsetForInstance(i, 256);
            ok = ok && v == expect[i] && Core::hopPhaseOffsetForInstance(i, 512) == 2 * expect[i];
            got += (i ? "," : "") + std::to_string(v);
        }
        ok = ok && Core::hopPhaseOffsetForInstance(-3, 256) == 0 && Core::hopPhaseOffsetForInstance(5, 1) == 0 && Core::hopPhaseOffsetForInstance(5, 0) == 0;
        check(ok, "H1 hopPhaseOffsetForInstance(0..7, 256) = {" + got + "} (bit reversal x hop; x2 at hop 512; 0 for index <= 0 or hop <= 1)");
    }
    // H2: instances 0 .. hop-1 at a power-of-two hop are a permutation of 0 .. hop-1; any hop gives values in [0, hop).
    {
        std::vector<int> seen(256, 0);
        bool perm = true;
        for (int i = 0; i < 256; ++i) { const int v = Core::hopPhaseOffsetForInstance(i, 256); if (v < 0 || v >= 256 || seen[static_cast<size_t>(v)]++) perm = false; }
        bool range = true;
        for (int hop : { 2, 3, 100, 192, 1000 })
            for (int i = 0; i < 300; ++i) { const int v = Core::hopPhaseOffsetForInstance(i, hop); range = range && v >= 0 && v < hop; }
        check(perm && range, "H2 instances 0..255 at hop 256 are a permutation of 0..255; values in [0, hop) for hops 2 / 3 / 100 / 192 / 1000");
    }
    // H3: 8 real instances (48 kHz, Normal, hop 256) prepared with the helper's offsets, 64-sample blocks: count the frame boundaries per block over all 8.
    for (int staggered = 1; staggered >= 0; --staggered)
    {
        const double sr = 48000.0;
        const int hop = Core::fftSizeFor(sr) / 4;
        const Stereo in = makePink(static_cast<int>(2.0 * sr), -20.0, 111);
        Core cores[8];
        for (int i = 0; i < 8; ++i) { cores[i].setHopPhaseOffset(staggered ? Core::hopPhaseOffsetForInstance(i, hop) : 0); cores[i].prepare(sr, 64, 2); }
        std::vector<float> l(64), r(64);
        float* ptrs[2] = { l.data(), r.data() };
        int maxPerBlock = 0;
        long long hist[9] = { 0 };
        for (int pos = 0; pos + 64 <= in.size(); pos += 64)
        {
            int frames = 0;
            for (auto& c : cores)
            {
                std::memcpy(l.data(), in.ch[0].data() + pos, sizeof(float) * 64);
                std::memcpy(r.data(), in.ch[1].data() + pos, sizeof(float) * 64);
                const long long before = c.framesProcessed();
                c.process(ptrs, 2, 64, Params{});
                frames += static_cast<int>(c.framesProcessed() - before);
            }
            maxPerBlock = std::max(maxPerBlock, frames);
            ++hist[std::min(frames, 8)];
        }
        char buf[260];
        std::snprintf(buf, sizeof buf, "H3 8 instances, hop %d, block 64, %s: max frame boundaries per block %d (%s); blocks with 0/1/2/8 frames: %lld/%lld/%lld/%lld",
                      hop, staggered ? "hopPhaseOffsetForInstance(i)" : "all offset 0 (control)", maxPerBlock, staggered ? "<= 2" : "control: == 8",
                      hist[0], hist[1], hist[2], hist[8]);
        check(staggered ? maxPerBlock <= 2 : maxPerBlock == 8, buf);
    }
}

// ===================================================================================================
// Live frame-tier switching (requestTier / adoption / transition), aligned dry output, parameter hardening.

// FNV-1a 64 over the float bit patterns of both channels: a fixture of an output stream that is cheap to store as a constant.
uint64_t hashStereo(const Stereo& s)
{
    uint64_t h = 1469598103934665603ull;
    for (int c = 0; c < 2; ++c)
        for (float v : s.ch[c])
        {
            uint32_t u; std::memcpy(&u, &v, sizeof u);
            for (int i = 0; i < 4; ++i) { h ^= (u >> (8 * i)) & 0xFFu; h *= 1099511628211ull; }
        }
    return h;
}

// T-A: fixed-tier output fixture. Recorded with the frozen pre-switching core (85df03d) and reproduced by the live-switching core; RE-RECORDED for the onset change
// (kSwitchUpSigmas 2.5 -> 2.0, fast-path knee 0.5 / 1.0 sigma; [RSCore] a2), which changes the output wherever the fast estimate takes a band. Any later change must reproduce these.
void testFixedTierBitIdentity()
{
    const double sr = 48000.0;
    Stereo in = resonantPink(sr, 3.0, 2500.0, 201);
    for (int i = 0; i < in.size(); ++i)
        in.ch[0][static_cast<size_t>(i)] += static_cast<float>(0.05 * std::sin(2.0 * juce::MathConstants<double>::pi * 1000.0 * i / sr));
    const int B = xleth::dsp::resonance::kGridBands;
    std::vector<float> w(static_cast<size_t>(B));
    const float pat[5] = { 0.0f, 0.3f, 1.0f, 1.7f, 2.5f };
    for (int b = 0; b < B; ++b) w[static_cast<size_t>(b)] = pat[b % 5];
    Params def;
    Params wBroad; wBroad.depth = 1.0f; wBroad.hardKnee = true; wBroad.sensitivity = 0.7f; wBroad.sharpness = 0.15f; wBroad.stereoLink = 0.5f; wBroad.weightCurve = w.data();
    Params wNarrow = wBroad; wNarrow.hardKnee = false; wNarrow.sharpness = 0.85f; wNarrow.attackMs = 3.0f; wNarrow.releaseMs = 80.0f;
    const std::vector<int> sched = { 1, 37, 128, 255, 511, 1024, 37 };
    struct Case { Core::FrameTier tier; const Params* p; int offset; const char* name; uint64_t expect; };
    const Case cases[] = {
        { Core::FrameTier::Fast,   &def,     0,  "Fast default",            0xd2c72d957f1bf693ull },
        { Core::FrameTier::Normal, &def,     0,  "Normal default",          0xf7e86bbef12342abull },
        { Core::FrameTier::High,   &def,     0,  "High default",            0xa1fe11a43a9a59acull },
        { Core::FrameTier::Fast,   &wBroad,  0,  "Fast weighted broad",     0xd254c893bac94ce9ull },
        { Core::FrameTier::Normal, &wBroad,  0,  "Normal weighted broad",   0x3a8149a829d6f9e3ull },
        { Core::FrameTier::High,   &wBroad,  0,  "High weighted broad",     0x313eba91054bc0c9ull },
        { Core::FrameTier::Fast,   &wNarrow, 0,  "Fast weighted narrow",    0xc905ff8b8079204dull },
        { Core::FrameTier::Normal, &wNarrow, 0,  "Normal weighted narrow",  0xc7faf31bfcd6b37bull },
        { Core::FrameTier::High,   &wNarrow, 0,  "High weighted narrow",    0xe429dd0d5f813ac8ull },
        { Core::FrameTier::Normal, &def,     96, "Normal default offset 96",0x3b5bf663c77a2878ull },
    };
    for (const Case& k : cases)
    {
        Core c; c.setFrameTier(k.tier); c.setHopPhaseOffset(k.offset); c.prepare(sr, 1024, 2);
        const uint64_t h = hashStereo(render(c, in, sched, *k.p));
        char buf[200];
        std::snprintf(buf, sizeof buf, "T-A fixed tier output == the recorded fixture: %s hash 0x%016llx (expect 0x%016llx)",
                      k.name, static_cast<unsigned long long>(h), static_cast<unsigned long long>(k.expect));
        check(h == k.expect, buf);
    }
}

const Core::FrameTier kTiers[3] = { Core::FrameTier::Fast, Core::FrameTier::Normal, Core::FrameTier::High };
const char* tierName(Core::FrameTier t) { return t == Core::FrameTier::Fast ? "Fast" : (t == Core::FrameTier::Normal ? "Normal" : "High"); }
inline uint64_t lcgNext(uint64_t s) { return s * 6364136223846793005ull + 1442695040888963407ull; }

Stereo makeWhite(int n, double rmsDb, uint64_t seed)
{
    Stereo s; s.resize(n);
    const double g = std::pow(10.0, rmsDb / 20.0) * std::sqrt(3.0);   // uniform [-1, 1) has rms 1 / sqrt(3)
    for (int c = 0; c < 2; ++c)
    {
        uint64_t st = (seed + 31ull * static_cast<uint64_t>(c + 1)) * 0x9E3779B97F4A7C15ull;
        for (int i = 0; i < n; ++i) { st = lcgNext(st); s.ch[c][static_cast<size_t>(i)] = static_cast<float>(g * (static_cast<double>(st >> 40) / 8388608.0 - 1.0)); }
    }
    return s;
}

Stereo makeSine(int n, double sr, double f, double amp)
{
    Stereo s; s.resize(n);
    for (int i = 0; i < n; ++i)
    {
        const double ph = 2.0 * juce::MathConstants<double>::pi * f * i / sr;
        s.ch[0][static_cast<size_t>(i)] = static_cast<float>(amp * std::sin(ph));
        s.ch[1][static_cast<size_t>(i)] = static_cast<float>(amp * std::sin(ph + 0.9));
    }
    return s;
}

// Render `in` in fixed blocks with dryOut; before the first block that starts at or after requestAt, requestTier(to). Positions are stream positions
// (the core is freshly prepared).
struct SwitchRun
{
    Stereo out, dry;
    long long adoptPos = -1;                       // start of the call that adopted the request
    long long flipStart = -1, flipEnd = -1;        // the call during which frameTier() changed
    long long endPos = -1;                         // end of the call after which no transition was running any more
};
SwitchRun runSwitch(Core& c, const Stereo& in, int block, long long requestAt, Core::FrameTier to, const Params& p)
{
    SwitchRun r; r.out = in; r.dry.resize(in.size());
    const long long before = c.tierSwitchCount();
    bool requested = false;
    for (int pos = 0; pos < in.size();)
    {
        const int b = std::min(block, in.size() - pos);
        if (!requested && pos >= requestAt) { c.requestTier(to); requested = true; }
        float* ptrs[2] = { r.out.ch[0].data() + pos, r.out.ch[1].data() + pos };
        float* dp[2] = { r.dry.ch[0].data() + pos, r.dry.ch[1].data() + pos };
        const Core::FrameTier t0 = c.frameTier();
        c.process(ptrs, 2, b, p, dp);
        if (r.adoptPos < 0 && c.tierSwitchCount() > before) r.adoptPos = pos;
        if (r.flipStart < 0 && c.frameTier() != t0) { r.flipStart = pos; r.flipEnd = pos + b; }
        if (r.adoptPos >= 0 && r.endPos < 0 && !c.tierTransitionActive()) r.endPos = pos + b;
        pos += b;
    }
    return r;
}

double maxStep(const Stereo& y, long long a, long long b)
{
    double m = 0.0;
    for (int c = 0; c < 2; ++c)
        for (long long i = std::max<long long>(a, 1); i < std::min<long long>(b, y.size()); ++i)
            m = std::max(m, std::abs(static_cast<double>(y.ch[c][static_cast<size_t>(i)]) - y.ch[c][static_cast<size_t>(i - 1)]));
    return m;
}

long long countNonFinite(const Stereo& y)
{
    long long n = 0;
    for (int c = 0; c < 2; ++c) for (float v : y.ch[c]) if (!std::isfinite(v)) ++n;
    return n;
}

// Power spectrum (Hann over [a, b), zero-padded to 2^order) of channel 0 of a + b2 (b2 may be null), smoothed over +-2 bins.
std::vector<double> segmentPsd(const std::vector<float>& x, const std::vector<float>* y2, long long a, long long b, int order)
{
    const int nfft = 1 << order;
    juce::dsp::FFT fft(order);
    std::vector<float> buf(static_cast<size_t>(2 * nfft), 0.0f);
    const long long len = b - a;
    for (long long i = 0; i < len && i < nfft; ++i)
    {
        const double w = 0.5 - 0.5 * std::cos(2.0 * juce::MathConstants<double>::pi * (i + 0.5) / len);
        double v = x[static_cast<size_t>(a + i)];
        if (y2 != nullptr) v += (*y2)[static_cast<size_t>(a + i)];
        buf[static_cast<size_t>(i)] = static_cast<float>(w * v);
    }
    fft.performFrequencyOnlyForwardTransform(buf.data(), true);
    std::vector<double> p(static_cast<size_t>(nfft / 2 + 1), 0.0), s = p;
    for (int k = 0; k <= nfft / 2; ++k) p[static_cast<size_t>(k)] = static_cast<double>(buf[static_cast<size_t>(k)]) * buf[static_cast<size_t>(k)];
    for (int k = 0; k <= nfft / 2; ++k)
    {
        double acc = 0.0; int n = 0;
        for (int j = std::max(0, k - 2); j <= std::min(nfft / 2, k + 2); ++j) { acc += p[static_cast<size_t>(j)]; ++n; }
        s[static_cast<size_t>(k)] = acc / n;
    }
    return s;
}

// T-B: every ordered pair of tiers, mid-stream. Steps, finiteness, the crossfade position, the final latency (impulse) and the dry / wet contract.
void testTierSwitchTransitions()
{
    const double sr = 48000.0;
    Params cap; cap.depth = 1.0f; cap.hardKnee = true;   // C1c: the deepest cut, the largest difference between wet and dry
    const int n = static_cast<int>(4.0 * sr);
    const Stereo pinkRes = resonantPink(sr, 4.0, 2500.0, 301);
    const Stereo sine = makeSine(n, sr, 1000.0, 0.25);
    struct Sig { const Stereo* x; const char* name; };
    const Sig sigs[2] = { { &pinkRes, "pink + 2.5 kHz bell" }, { &sine, "1 kHz sine" } };
    const long long reqAt = static_cast<long long>(2.5 * sr) + 37;
    const int block = 100;
    const int steadySkip = Core::latencyFor(sr, Core::FrameTier::High) + static_cast<int>(0.5 * sr);
    const double kBound = 1.25;
    for (const Sig& sg : sigs)
    {
        double inStep = maxStep(*sg.x, steadySkip, n);
        for (Core::FrameTier from : kTiers)
            for (Core::FrameTier to : kTiers)
            {
                if (from == to) continue;
                Core c; c.setFrameTier(from); c.prepare(sr, block, 2);
                const SwitchRun r = runSwitch(c, *sg.x, block, reqAt, to, cap);
                double ref = 0.0;
                for (Core::FrameTier t : { from, to })
                {
                    Core f; f.setFrameTier(t); f.prepare(sr, block, 2);
                    ref = std::max(ref, maxStep(render(f, *sg.x, { block }, cap), steadySkip, n));
                }
                const double tr = maxStep(r.out, r.adoptPos, r.endPos + block);
                const int HB = Core::fftSizeFor(sr, to) / 4;
                const long long valid = (r.adoptPos / HB) * HB + 3LL * HB;
                const bool flipOk = r.adoptPos == reqAt - (reqAt % block) + (reqAt % block ? block : 0) && r.flipStart < valid && valid <= r.flipEnd;
                const bool endOk = c.currentLatency() == Core::latencyFor(sr, to) && c.frameTier() == to && !c.tierTransitionActive() && r.endPos >= valid + c.tierCrossfadeSamples();
                const long long nf = countNonFinite(r.out) + countNonFinite(r.dry);
                char buf[400];
                std::snprintf(buf, sizeof buf, "T-B %s, %s -> %s: transition %lld samples (adopt %lld, crossfade at %lld = adopt grid + 3 hops), max |step| %.4f vs steady %.4f (ratio %.3f <= %.2f; "
                              "an unsuppressed dry bridge would reach %.3f), non-finite %lld, end latency %d == %d",
                              sg.name, tierName(from), tierName(to), r.endPos - r.adoptPos, r.adoptPos, valid, tr, ref, tr / ref, kBound, inStep / ref, nf,
                              c.currentLatency(), Core::latencyFor(sr, to));
                check(flipOk && endOk && nf == 0 && tr <= kBound * ref, buf);
            }
    }

    // Impulse after settling: silence, switch at 0.5 s, unit impulse at 2.0 s -> wet AND dry peak at exactly +latencyFor(new tier). Depth 0: unit height, nothing
    // elsewhere. Default params: same position; the height is compared with a core of the new tier that never switched (an isolated impulse 2 s into digital
    // silence is cut by ~0.3 % by a steady core of any tier below High: that is the detector, not the switch).
    for (int variant = 0; variant < 2; ++variant)
    for (Core::FrameTier from : kTiers)
        for (Core::FrameTier to : kTiers)
        {
            if (from == to) continue;
            const int m = static_cast<int>(3.0 * sr), at = static_cast<int>(2.0 * sr) + 11;
            Stereo imp; imp.resize(m);
            imp.ch[0][static_cast<size_t>(at)] = 1.0f; imp.ch[1][static_cast<size_t>(at)] = 1.0f;
            Core c; c.setFrameTier(from); c.prepare(sr, 256, 2);
            const Params prm = variant == 0 ? Params{ 0.0f } : Params{};
            const SwitchRun r = runSwitch(c, imp, 256, static_cast<long long>(0.5 * sr), to, prm);
            int pw = -1, pd = -1; float hw = 0.0f, hd = 0.0f; double rest = 0.0;
            for (int i = 0; i < m; ++i)
            {
                const float w = std::abs(r.out.ch[0][static_cast<size_t>(i)]), d = std::abs(r.dry.ch[0][static_cast<size_t>(i)]);
                if (w > hw) { hw = w; pw = i; }
                if (d > hd) { hd = d; pd = i; }
            }
            for (int i = 0; i < m; ++i) if (i != pw) rest = std::max(rest, static_cast<double>(std::abs(r.out.ch[0][static_cast<size_t>(i)])));
            const int lat = Core::latencyFor(sr, to);
            // Control: a core of the new tier that never switched, same input.
            Core ctl; ctl.setFrameTier(to); ctl.prepare(sr, 256, 2);
            const Stereo yc = render(ctl, imp, { 256 }, prm);
            int pc = -1; float hc = 0.0f; double restC = 0.0;
            for (int i = 0; i < m; ++i) { const float v = std::abs(yc.ch[0][static_cast<size_t>(i)]); if (v > hc) { hc = v; pc = i; } }
            for (int i = 0; i < m; ++i) if (i != pc) restC = std::max(restC, static_cast<double>(std::abs(yc.ch[0][static_cast<size_t>(i)])));
            const Diff dc = sameDiff(r.out, yc);
            char buf[400];
            std::snprintf(buf, sizeof buf, "T-B impulse (%s) after %s -> %s (transition ended at %lld < impulse %d): wet peak at +%d, dry peak at +%d (expect %d), heights %.7f / %.7f, max elsewhere %.2e; "
                          "never-switched %s core: peak at +%d, height %.7f, max elsewhere %.2e, max |switched - it| %.2e",
                          variant == 0 ? "depth 0" : "default params", tierName(from), tierName(to), r.endPos, at, pw - at, pd - at, lat, static_cast<double>(hw), static_cast<double>(hd), rest,
                          tierName(to), pc - at, static_cast<double>(hc), restC, dc.maxAbs);
            const bool heightOk = variant == 0 ? (std::abs(hw - 1.0f) < 1.0e-5f && rest < kMaxAbsAt120) : (pc - at == lat && std::abs(hw - hc) <= 0.005f);
            check(r.endPos < at && pw - at == lat && pd - at == lat && hd == 1.0f && heightOk, buf);
        }

    // Dry / wet contract at depth 0: wet + dryOut has the spectrum of 2 x dryOut over the whole transition (no comb). Negative control: a dry delay that follows
    // latencyFor(requested tier) from the adoption on (what an effect would do with its own delay line and the published latency) combs over the hold period.
    for (Core::FrameTier from : kTiers)
        for (Core::FrameTier to : kTiers)
        {
            if (from == to) continue;
            const int m = static_cast<int>(2.0 * sr);
            const Stereo wn = makeWhite(m, -20.0, 77);
            Core c; c.setFrameTier(from); c.prepare(sr, 128, 2);
            const SwitchRun r = runSwitch(c, wn, 128, static_cast<long long>(1.0 * sr) + 37, to, Params{ 0.0f });
            const long long a = r.adoptPos, b = r.endPos;
            const int LA = Core::latencyFor(sr, from), LB = Core::latencyFor(sr, to);
            std::vector<float> naive(static_cast<size_t>(m), 0.0f), twiceDry(static_cast<size_t>(m), 0.0f), twiceNaive(static_cast<size_t>(m), 0.0f);
            double maxWetDry = 0.0;
            for (long long t = 0; t < m; ++t)
            {
                const long long src = t - (t < a ? LA : LB);
                naive[static_cast<size_t>(t)] = src >= 0 ? wn.ch[0][static_cast<size_t>(src)] : 0.0f;
                twiceDry[static_cast<size_t>(t)] = 2.0f * r.dry.ch[0][static_cast<size_t>(t)];
                twiceNaive[static_cast<size_t>(t)] = 2.0f * naive[static_cast<size_t>(t)];
                if (t >= a && t < b) maxWetDry = std::max(maxWetDry, std::abs(static_cast<double>(r.out.ch[0][static_cast<size_t>(t)]) - r.dry.ch[0][static_cast<size_t>(t)]));
            }
            const std::vector<double> sOk = segmentPsd(r.out.ch[0], &r.dry.ch[0], a, b, 13), sRef = segmentPsd(twiceDry, nullptr, a, b, 13);
            const std::vector<double> sBad = segmentPsd(r.out.ch[0], &naive, a, b, 13), sBadRef = segmentPsd(twiceNaive, nullptr, a, b, 13);
            const int k0 = static_cast<int>(50.0 / (sr / 8192.0)), k1 = static_cast<int>(20000.0 / (sr / 8192.0));
            double okMax = 0.0, badMin = 0.0, lgOk = 0.0, arOk = 0.0, lgBad = 0.0, arBad = 0.0;
            for (int k = k0; k <= k1; ++k)
            {
                const double ro = sOk[static_cast<size_t>(k)] / sRef[static_cast<size_t>(k)], rb = sBad[static_cast<size_t>(k)] / sBadRef[static_cast<size_t>(k)];
                okMax = std::max(okMax, std::abs(10.0 * std::log10(ro)));
                badMin = std::min(badMin, 10.0 * std::log10(rb));
                lgOk += std::log(ro); arOk += ro; lgBad += std::log(rb); arBad += rb;
            }
            const int nk = k1 - k0 + 1;
            const double flatOk = std::exp(lgOk / nk) / (arOk / nk), flatBad = std::exp(lgBad / nk) / (arBad / nk);
            char buf[400];
            std::snprintf(buf, sizeof buf, "T-B depth 0 %s -> %s, window = the %lld-sample transition: max |wet - dryOut| %.2e; (wet + dryOut) / (2 dryOut) spectrum within %.4f dB (<= 0.1), flatness %.5f (>= 0.999); "
                          "control dry at latencyFor(new) from adoption: deepest notch %.1f dB, flatness %.3f",
                          tierName(from), tierName(to), b - a, maxWetDry, okMax, flatOk, badMin, flatBad);
            check(maxWetDry <= kMaxAbsAt120 && okMax <= 0.1 && flatOk >= 0.999, buf);
        }
}

// T-M: the Mid / Side recipe through a switch. A 1-channel core processes M = (L + R) / 2 with S = (L - R) / 2 as the delay-only aux channel. At depth 0,
// L' = M' + S_d and R' = M' - S_d must equal the L / R a stereo core puts on its dry timeline (dryOut) at every sample of the switch, and auxOut must equal the
// dryOut of a 2-channel core fed S as channel 1 (bit-identical: the same timeline).
void testMidSideAcrossSwitch()
{
    const double sr = 48000.0;
    const int m = static_cast<int>(2.0 * sr), block = 128;
    const Stereo x = makeWhite(m, -20.0, 131);
    std::vector<float> M(static_cast<size_t>(m)), S(static_cast<size_t>(m));
    for (int i = 0; i < m; ++i)
    {
        M[static_cast<size_t>(i)] = 0.5f * (x.ch[0][static_cast<size_t>(i)] + x.ch[1][static_cast<size_t>(i)]);
        S[static_cast<size_t>(i)] = 0.5f * (x.ch[0][static_cast<size_t>(i)] - x.ch[1][static_cast<size_t>(i)]);
    }
    for (Core::FrameTier from : kTiers)
        for (Core::FrameTier to : kTiers)
        {
            if (from == to) continue;
            Core mono; mono.setFrameTier(from); mono.prepare(sr, block, 1);
            Core ref; ref.setFrameTier(from); ref.prepare(sr, block, 2);     // M and S as two channels: S's dryOut is the reference timeline
            Core lr; lr.setFrameTier(from); lr.prepare(sr, block, 2);       // L and R: the stereo dry timeline
            std::vector<float> mo = M, md(static_cast<size_t>(m)), so(static_cast<size_t>(m));
            Stereo rIn; rIn.ch[0] = M; rIn.ch[1] = S;
            Stereo rDry; rDry.resize(m);
            Stereo lrOut = x, lrDry; lrDry.resize(m);
            const Params p0 { 0.0f };
            const long long reqAt = static_cast<long long>(1.0 * sr) + 37;
            bool requested = false;
            for (int pos = 0; pos < m; pos += block)
            {
                const int b = std::min(block, m - pos);
                if (!requested && pos >= reqAt) { mono.requestTier(to); ref.requestTier(to); lr.requestTier(to); requested = true; }
                float* p1[1] = { mo.data() + pos };
                float* d1[1] = { md.data() + pos };
                mono.process(p1, 1, b, p0, d1, S.data() + pos, so.data() + pos);
                float* p2[2] = { rIn.ch[0].data() + pos, rIn.ch[1].data() + pos };
                float* d2[2] = { rDry.ch[0].data() + pos, rDry.ch[1].data() + pos };
                ref.process(p2, 2, b, p0, d2);
                float* p3[2] = { lrOut.ch[0].data() + pos, lrOut.ch[1].data() + pos };
                float* d3[2] = { lrDry.ch[0].data() + pos, lrDry.ch[1].data() + pos };
                lr.process(p3, 2, b, p0, d3);
            }
            double auxDiff = 0.0, recon = 0.0;
            for (int i = 0; i < m; ++i)
            {
                auxDiff = std::max(auxDiff, std::abs(static_cast<double>(so[static_cast<size_t>(i)]) - rDry.ch[1][static_cast<size_t>(i)]));
                const double L = static_cast<double>(mo[static_cast<size_t>(i)]) + so[static_cast<size_t>(i)];
                const double R = static_cast<double>(mo[static_cast<size_t>(i)]) - so[static_cast<size_t>(i)];
                recon = std::max(recon, std::max(std::abs(L - lrDry.ch[0][static_cast<size_t>(i)]), std::abs(R - lrDry.ch[1][static_cast<size_t>(i)])));
            }
            char buf[300];
            std::snprintf(buf, sizeof buf, "T-M Mid recipe through %s -> %s (mono core on M, S as aux, depth 0): auxOut == 2-channel dryOut[1] (max |diff| %.1e), L' / R' vs the stereo dry timeline max |diff| %.2e (<= 1e-6), switched %d",
                          tierName(from), tierName(to), auxDiff, recon, mono.frameTier() == to ? 1 : 0);
            check(auxDiff == 0.0 && recon <= kMaxAbsAt120 && mono.frameTier() == to && !mono.tierTransitionActive(), buf);
        }
}

// Published cut at f0 (max applied band reduction within +-1/6 octave, channel 0) after every block; optional switch request before the first block at/after requestAt.
struct CutCurve { std::vector<double> cut; long long adoptBlock = -1; };
CutCurve cutCurve(Core& c, const Stereo& in, int block, double f0, long long requestAt, Core::FrameTier to)
{
    CutCurve r;
    std::vector<float> l(static_cast<size_t>(block)), rr(static_cast<size_t>(block));
    float* ptrs[2] = { l.data(), rr.data() };
    const long long before = c.tierSwitchCount();
    bool requested = false;
    for (int pos = 0, blk = 0; pos + block <= in.size(); pos += block, ++blk)
    {
        if (requestAt >= 0 && !requested && pos >= requestAt) { c.requestTier(to); requested = true; }
        std::memcpy(l.data(), in.ch[0].data() + pos, sizeof(float) * static_cast<size_t>(block));
        std::memcpy(rr.data(), in.ch[1].data() + pos, sizeof(float) * static_cast<size_t>(block));
        c.process(ptrs, 2, block, Params{ 1.0f, 0.5f, 15.0f, 200.0f, true });
        if (r.adoptBlock < 0 && c.tierSwitchCount() > before) r.adoptBlock = blk;
        double m = 0.0;
        for (int b = 0; b < c.numBands(); ++b)
            if (std::abs(std::log2(c.bandHz(b) / f0)) <= 1.0 / 6.0) m = std::max(m, static_cast<double>(c.bandReductionDb(0)[b]));
        r.cut.push_back(m);
    }
    return r;
}

// T-C: detector / gain state across a switch. Steady planted resonance (C1c), switch after 4 s; the published cut of the switched core against a core of the
// new tier that ran the whole signal (the "fresh core of the new tier"), and the same switch with the state reset instead of kept.
void testTierSwitchContinuity()
{
    const double sr = 48000.0;
    const int block = 64;
    const double blockMs = 1000.0 * block / sr;
    const int marks[] = { 0, 5, 10, 20, 30, 40, 50, 75, 100, 125, 150, 200, 300, 500 };
    for (double f0 : { 2500.0, 500.0 })
    {
        const bool gate = f0 == 2500.0;   // 500 Hz: informational (the bell is narrower than a bin at every tier)
        const Stereo x = resonantPink(sr, 4.8, f0, 501);
        const long long reqAt = static_cast<long long>(4.0 * sr);
        for (Core::FrameTier from : kTiers)
            for (Core::FrameTier to : kTiers)
            {
                if (from == to) continue;
                Core keep; keep.setFrameTier(from); keep.prepare(sr, block, 2);
                Core rst; rst.setFrameTier(from); rst.setKeepDetectorStateOnTierSwitch(false); rst.prepare(sr, block, 2);
                Core fresh; fresh.setFrameTier(to); fresh.prepare(sr, block, 2);
                const CutCurve ck = cutCurve(keep, x, block, f0, reqAt, to), cr = cutCurve(rst, x, block, f0, reqAt, to), cf = cutCurve(fresh, x, block, f0, -1, to);
                const long long a = ck.adoptBlock;
                const long long nb = static_cast<long long>(ck.cut.size());
                const long long b150 = a + static_cast<long long>(std::ceil(150.0 / blockMs));
                double minKeep = 1.0e9, minReset = 1.0e9, worstAfter = 0.0;
                for (long long i = a; i < nb; ++i)
                {
                    if (i <= b150) { minKeep = std::min(minKeep, ck.cut[static_cast<size_t>(i)]); minReset = std::min(minReset, cr.cut[static_cast<size_t>(i)]); }
                    else worstAfter = std::max(worstAfter, std::abs(ck.cut[static_cast<size_t>(i)] - cf.cut[static_cast<size_t>(i)]));
                }
                auto settle = [&](const CutCurve& cc) {   // ms after adoption from which |cut - fresh| <= 1.5 dB to the end of the run
                    long long last = a - 1;
                    for (long long i = a; i < nb; ++i) if (std::abs(cc.cut[static_cast<size_t>(i)] - cf.cut[static_cast<size_t>(i)]) > 1.5) last = i;
                    return (last + 1 - a) * blockMs;
                };
                std::string curve;
                for (int ms : marks)
                {
                    const long long i = a + static_cast<long long>(std::llround(ms / blockMs));
                    if (i >= nb) break;
                    char t[64];
                    std::snprintf(t, sizeof t, " %d:%.2f/%.2f/%.2f", ms, ck.cut[static_cast<size_t>(i)], cf.cut[static_cast<size_t>(i)], cr.cut[static_cast<size_t>(i)]);
                    curve += t;
                }
                char buf[900];
                std::snprintf(buf, sizeof buf, "T-C %.0f Hz %s -> %s: kept state: min cut in [0,150] ms %.2f dB (> 1), within 1.5 dB of a fresh %s core from %.1f ms (<= 150), worst |diff| after 150 ms %.2f dB; "
                              "reset state: min %.2f dB, within 1.5 dB from %.1f ms; curve ms:kept/fresh/reset dB%s%s",
                              f0, tierName(from), tierName(to), minKeep, tierName(to), settle(ck), worstAfter, minReset, settle(cr), curve.c_str(), gate ? "" : " (informational)");
                if (gate) check(minKeep > 1.0 && worstAfter <= 1.5 && settle(ck) <= 150.0, buf);
                else { std::printf("[ResCore] INFO %s\n", buf); std::fflush(stdout); }
            }
    }
}

// Zero allocations / frees on tier switches, deterministic: cold pass from the first block after prepare(), every ordered pair, with dryOut and a viz sink.
struct NopSink final : xleth::dsp::resonance::VizSink { long long n = 0; void onResonanceFrame(const xleth::dsp::resonance::VizFrame&) noexcept override { ++n; } };
void testTierSwitchAllocations()
{
    const double sr = 48000.0;
    const Stereo x = resonantPink(sr, 6.0, 2500.0, 601);
    for (int block : { 1, 64, 1000 })
    {
        Core c; c.prepare(sr, 1024, 2);
        NopSink sink; c.setVizSink(&sink);
        std::vector<float> l(static_cast<size_t>(block)), r(static_cast<size_t>(block)), dl = l, dr = r, ax = l, axo = l;
        float* ptrs[2] = { l.data(), r.data() };
        float* dp[2] = { dl.data(), dr.data() };
        const Core::FrameTier seq[] = { Core::FrameTier::High, Core::FrameTier::Fast, Core::FrameTier::Normal, Core::FrameTier::Fast, Core::FrameTier::High, Core::FrameTier::Normal };
        const int blocksPerStep = std::max(1, static_cast<int>(0.15 * sr) / block);
        long long allocs = 0, frees = 0;
        int step = 0;
        t_isMeasuringThread = true;
        for (int pos = 0, blk = 0; pos + block <= x.size(); pos += block, ++blk)
        {
            if (blk % blocksPerStep == 0) c.requestTier(seq[step++ % 6]);
            std::memcpy(l.data(), x.ch[0].data() + pos, sizeof(float) * static_cast<size_t>(block));
            std::memcpy(r.data(), x.ch[1].data() + pos, sizeof(float) * static_cast<size_t>(block));
            g_allocCount.store(0); g_freeCount.store(0); g_allocArmed.store(true);
            std::memcpy(ax.data(), x.ch[1].data() + pos, sizeof(float) * static_cast<size_t>(block));
            c.process(ptrs, 2, block, Params{ 1.0f, 0.5f, 15.0f, 200.0f, true }, dp, ax.data(), axo.data());
            g_allocArmed.store(false);
            allocs += g_allocCount.load(); frees += g_freeCount.load();
        }
        t_isMeasuringThread = false;
        char buf[200];
        std::snprintf(buf, sizeof buf, "T-D0 tier switches every 150 ms (all 6 ordered pairs, block %d, dryOut + aux + viz sink, cold): %lld switches, operator new %lld, delete %lld",
                      block, c.tierSwitchCount(), allocs, frees);
        check(allocs == 0 && frees == 0 && c.tierSwitchCount() >= 30, buf);
    }
}

// T-D: concurrency. A second thread requests random tiers while this (the audio) thread processes 200 000 blocks of random sizes 1..1024.
void testTierSwitchStress()
{
    const double sr = 48000.0;
    Stereo src = resonantPink(sr, 10.0, 2500.0, 701);
    for (int i = 0; i < src.size(); ++i) src.ch[0][static_cast<size_t>(i)] += static_cast<float>(0.05 * std::sin(2.0 * juce::MathConstants<double>::pi * 1000.0 * i / sr));
    double inMax = 0.0;
    for (int c = 0; c < 2; ++c) for (float v : src.ch[c]) inMax = std::max(inMax, static_cast<double>(std::abs(v)));
    const double bound = 4.0 * inMax;
    const int kBlocks = 200000;
    using clk = std::chrono::steady_clock;
    auto now = [] { return static_cast<long long>(std::chrono::duration_cast<std::chrono::nanoseconds>(clk::now().time_since_epoch()).count()); };
    for (int mode = 0; mode < 2; ++mode)
    {
        Core c; c.setFrameTier(Core::FrameTier::Normal); c.prepare(sr, 1024, 2);
        Params cap; cap.depth = 1.0f; cap.hardKnee = true;
        struct Req { long long tPre, tPost; int tier; };
        struct Adopt { long long tStart, tEnd; int tier; };
        std::vector<Req> reqs(600000);
        std::vector<Adopt> adopts(static_cast<size_t>(kBlocks) + 1);
        std::atomic<int> nReq { 0 };
        std::atomic<bool> stop { false };
        std::vector<float> l(1024), r(1024), dl(1024), dr(1024);
        float* ptrs[2] = { l.data(), r.data() };
        float* dp[2] = { dl.data(), dr.data() };
        int nAdopt = 0, nFlips = 0, flipMismatch = 0, latMismatch = 0, multiAdopt = 0;
        long long nonFinite = 0, armedAllocs = 0, armedFrees = 0, samples = 0;
        double outMax = 0.0;
        int lastTier = static_cast<int>(c.frameTier());
        long long lastSwitches = 0;
        int lastTarget = lastTier;
        long long tierBlocks[3] = { 0, 0, 0 };

        std::thread requester([&] {
            uint64_t st = 0xC0FFEEull + static_cast<uint64_t>(mode);
            int idx = 0;
            auto one = [&] {
                st = lcgNext(st);
                const int tier = static_cast<int>((st >> 33) % 3u);
                const long long a = now();
                c.requestTier(kTiers[tier]);
                const long long b = now();
                if (idx < static_cast<int>(reqs.size())) { reqs[static_cast<size_t>(idx)] = { a, b, tier }; ++idx; nReq.store(idx, std::memory_order_release); }
            };
            while (!stop.load(std::memory_order_relaxed))
            {
                one();
                st = lcgNext(st);
                if (mode == 0) std::this_thread::sleep_for(std::chrono::milliseconds(1 + static_cast<int>((st >> 33) % 50u)));
                else
                {
                    if (((st >> 45) & 7u) == 0u) for (int k = 0; k < 20; ++k) one();   // back-to-back burst
                    std::this_thread::sleep_for(std::chrono::microseconds(200 + static_cast<int>((st >> 33) % 4800u)));
                }
            }
        });

        g_tidWatched = std::this_thread::get_id();
        g_tidAllocCount.store(0); g_tidFreeCount.store(0);
        g_tidCounting.store(true);
        t_isMeasuringThread = true;
        const long long tStart = now();
        uint64_t bs = 0xABCDEFull + static_cast<uint64_t>(mode);
        int pos = 0;
        for (int blk = 0; blk < kBlocks; ++blk)
        {
            bs = lcgNext(bs);
            const int b = 1 + static_cast<int>((bs >> 33) % 1024u);
            for (int i = 0; i < b; ++i)
            {
                l[static_cast<size_t>(i)] = src.ch[0][static_cast<size_t>(pos)];
                r[static_cast<size_t>(i)] = src.ch[1][static_cast<size_t>(pos)];
                if (++pos == src.size()) pos = 0;
            }
            const long long t0 = now();
            g_allocCount.store(0); g_freeCount.store(0); g_allocArmed.store(true);
            c.process(ptrs, 2, b, cap, dp);
            g_allocArmed.store(false);
            const long long t1 = now();
            armedAllocs += g_allocCount.load(); armedFrees += g_freeCount.load();
            samples += b;
            for (int i = 0; i < b; ++i)
                for (const float v : { l[static_cast<size_t>(i)], r[static_cast<size_t>(i)], dl[static_cast<size_t>(i)], dr[static_cast<size_t>(i)] })
                {
                    if (!std::isfinite(v)) ++nonFinite;
                    else outMax = std::max(outMax, static_cast<double>(std::abs(v)));
                }
            const long long sw = c.tierSwitchCount();
            if (sw != lastSwitches)
            {
                if (sw - lastSwitches > 1) ++multiAdopt;
                lastTarget = static_cast<int>(c.targetFrameTier());
                if (nAdopt < static_cast<int>(adopts.size())) adopts[static_cast<size_t>(nAdopt++)] = { t0, t1, lastTarget };
                lastSwitches = sw;
            }
            const int ft = static_cast<int>(c.frameTier());
            if (ft != lastTier) { ++nFlips; if (ft != lastTarget) ++flipMismatch; lastTier = ft; }
            if (c.currentLatency() != Core::latencyFor(sr, c.frameTier())) ++latMismatch;
            ++tierBlocks[ft];
        }
        const long long tEnd = now();
        t_isMeasuringThread = false;
        g_tidCounting.store(false);
        const long long tidAllocs = g_tidAllocCount.load(), tidFrees = g_tidFreeCount.load();
        stop.store(true);
        requester.join();

        // Every adoption must match a request: same tier, stored before the adopting call ended and after the previous adoption's call started
        // (an older request was consumed or overwritten by then).
        const int nr = nReq.load(std::memory_order_acquire);
        int unmatched = 0;
        for (int j = 0; j < nAdopt; ++j)
        {
            const long long lo = j == 0 ? std::numeric_limits<long long>::min() : adopts[static_cast<size_t>(j - 1)].tStart;
            bool found = false;
            for (int i = 0; i < nr && !found; ++i)
            {
                const Req& q = reqs[static_cast<size_t>(i)];
                found = q.tier == adopts[static_cast<size_t>(j)].tier && q.tPre <= adopts[static_cast<size_t>(j)].tEnd && q.tPost >= lo;
            }
            if (!found) ++unmatched;
        }
        const double wallS = (tEnd - tStart) * 1.0e-9;
        char buf[600];
        std::snprintf(buf, sizeof buf, "T-D stress %s: %d blocks (1..1024, %.1f s of audio in %.1f s), %d requests, %d adoptions (%d unmatched, %d calls with > 1), %d tier changes (%d not the adopted target), "
                      "blocks on Fast/Normal/High %lld/%lld/%lld, latency != latencyFor(frameTier) %d, non-finite %lld, max |out| %.3f (<= %.3f), operator new/delete in process %lld/%lld, on the audio thread %lld/%lld",
                      mode == 0 ? "requests every 1-50 ms" : "burst (0.2-5 ms + runs of 20)", kBlocks, samples / sr, wallS, nr, nAdopt, unmatched, multiAdopt, nFlips, flipMismatch,
                      tierBlocks[0], tierBlocks[1], tierBlocks[2], latMismatch, nonFinite, outMax, bound, armedAllocs, armedFrees, tidAllocs, tidFrees);
        check(nonFinite == 0 && outMax <= bound && armedAllocs == 0 && armedFrees == 0 && tidAllocs == 0 && tidFrees == 0 && unmatched == 0 && multiAdopt == 0
              && flipMismatch == 0 && latMismatch == 0 && nAdopt >= 20 && tierBlocks[0] > 0 && tierBlocks[1] > 0 && tierBlocks[2] > 0, buf);
    }
}

// T-E: parameter hardening at intake. Every non-finite / out-of-range value in every Params field gives finite, bounded output with zero allocations, and the
// output is bit-identical to passing the sanitised value explicitly. Valid values pass through bit-identically.
void testParamHardening()
{
    const double sr = 48000.0;
    const float nanv = std::numeric_limits<float>::quiet_NaN(), inf = std::numeric_limits<float>::infinity();
    // (a) sanitizeParams on valid values is the identity (bit pattern), on invalid ones: non-finite -> default, else clamp.
    {
        bool ok = true;
        uint64_t st = 99;
        auto u01 = [&] { st = lcgNext(st); return static_cast<float>(static_cast<double>(st >> 40) / 16777216.0); };
        for (int i = 0; i < 20000 && ok; ++i)
        {
            Params p;
            p.depth = u01(); p.sensitivity = u01(); p.stereoLink = u01(); p.sharpness = u01();
            p.attackMs = 0.1f + 999.9f * u01(); p.releaseMs = 1.0f + 9999.0f * u01();
            if (i == 0) { p.depth = 0.0f; p.sensitivity = 1.0f; p.stereoLink = -0.0f; p.sharpness = 1.0f; p.attackMs = 0.1f; p.releaseMs = 10000.0f; }
            const Params q = Core::sanitizeParams(p);
            ok = std::memcmp(&p.depth, &q.depth, 4) == 0 && std::memcmp(&p.sensitivity, &q.sensitivity, 4) == 0 && std::memcmp(&p.attackMs, &q.attackMs, 4) == 0
                 && std::memcmp(&p.releaseMs, &q.releaseMs, 4) == 0 && std::memcmp(&p.stereoLink, &q.stereoLink, 4) == 0 && std::memcmp(&p.sharpness, &q.sharpness, 4) == 0;
        }
        Params bad; bad.depth = nanv; bad.sensitivity = inf; bad.attackMs = -inf; bad.releaseMs = 0.0f; bad.stereoLink = 7.0f; bad.sharpness = -3.0f;
        const Params q = Core::sanitizeParams(bad);
        const bool mapOk = q.depth == 0.5f && q.sensitivity == 0.5f && q.attackMs == 15.0f && q.releaseMs == 1.0f && q.stereoLink == 1.0f && q.sharpness == 0.0f;
        Params big; big.attackMs = 1.0e30f; big.releaseMs = -5.0f; big.depth = -1.0e30f;
        const Params qb = Core::sanitizeParams(big);
        const bool clampOk = qb.attackMs == 1000.0f && qb.releaseMs == 1.0f && qb.depth == 0.0f;
        check(ok && mapOk && clampOk, "T-E sanitizeParams: 20000 random valid parameter sets unchanged (bit pattern); NaN / +-Inf -> default (0.5 / 0.5 / 15 ms / 0.5), out of range -> clamped (release 0 -> 1 ms, link 7 -> 1, sharpness -3 -> 0, attack 1e30 -> 1000 ms)");
    }
    // (b) every field x every bad value, through process().
    Stereo x = resonantPink(sr, 1.5, 2500.0, 801);
    for (int i = 0; i < x.size(); ++i) x.ch[1][static_cast<size_t>(i)] += static_cast<float>(0.05 * std::sin(2.0 * juce::MathConstants<double>::pi * 700.0 * i / sr));
    double inMax = 0.0;
    for (int c = 0; c < 2; ++c) for (float v : x.ch[c]) inMax = std::max(inMax, static_cast<double>(std::abs(v)));
    const float badVals[] = { nanv, inf, -inf, 1.0e30f, -1.0e30f, 7.0f, -3.0f, 0.0f };
    const char* fields[] = { "depth", "sensitivity", "attackMs", "releaseMs", "stereoLink", "sharpness" };
    auto runCounted = [&](const Params& p, Stereo& out, long long& allocs)
    {
        Core c; c.prepare(sr, 256, 2);
        out = x;
        t_isMeasuringThread = true;
        for (int pos = 0; pos < x.size(); pos += 256)
        {
            const int b = std::min(256, x.size() - pos);
            float* ptrs[2] = { out.ch[0].data() + pos, out.ch[1].data() + pos };
            g_allocCount.store(0); g_allocArmed.store(true);
            c.process(ptrs, 2, b, p);
            g_allocArmed.store(false); allocs += g_allocCount.load();
        }
        t_isMeasuringThread = false;
    };
    for (int f = 0; f < 6; ++f)
    {
        long long allocs = 0, nf = 0, mismatch = 0;
        double mx = 0.0;
        for (float v : badVals)
        {
            Params p; p.depth = 1.0f; p.hardKnee = true;
            float* fld[6] = { &p.depth, &p.sensitivity, &p.attackMs, &p.releaseMs, &p.stereoLink, &p.sharpness };
            *fld[f] = v;
            Stereo yb, ys;
            runCounted(p, yb, allocs);
            runCounted(Core::sanitizeParams(p), ys, allocs);
            nf += countNonFinite(yb);
            for (int c = 0; c < 2; ++c) for (float s : yb.ch[c]) if (std::isfinite(s)) mx = std::max(mx, static_cast<double>(std::abs(s)));
            if (sameDiff(yb, ys).maxAbs != 0.0 || countNonFinite(yb) != 0) ++mismatch;
        }
        char buf[300];
        std::snprintf(buf, sizeof buf, "T-E %s in {NaN, +Inf, -Inf, 1e30, -1e30, 7, -3, 0}: non-finite %lld, max |out| %.3f (<= %.3f), outputs == the sanitised value's %d / 8, allocations %lld",
                      fields[f], nf, mx, 4.0 * inMax, 8 - static_cast<int>(mismatch), allocs);
        check(nf == 0 && mx <= 4.0 * inMax && mismatch == 0 && allocs == 0, buf);
    }
    // (c) every field bad at once, and a weight curve with non-finite / negative / huge entries (non-finite = 1, negative = 0, huge = 2.5).
    {
        const int B = xleth::dsp::resonance::kGridBands;
        const float wp[6] = { nanv, inf, -inf, -1.0f, 1.0e30f, 0.5f }, ws[6] = { 1.0f, 1.0f, 1.0f, 0.0f, 2.5f, 0.5f };
        std::vector<float> wBad(static_cast<size_t>(B)), wSan(static_cast<size_t>(B));
        for (int b = 0; b < B; ++b) { wBad[static_cast<size_t>(b)] = wp[b % 6]; wSan[static_cast<size_t>(b)] = ws[b % 6]; }
        Params pw; pw.depth = 1.0f; pw.hardKnee = true; pw.weightCurve = wBad.data();
        Params pws = pw; pws.weightCurve = wSan.data();
        long long allocs = 0;
        Stereo y1, y2, y3, y4;
        runCounted(pw, y1, allocs); runCounted(pws, y2, allocs);
        Params all; all.depth = nanv; all.sensitivity = -inf; all.attackMs = nanv; all.releaseMs = inf; all.stereoLink = nanv; all.sharpness = inf; all.weightCurve = wBad.data();
        runCounted(all, y3, allocs);
        Params allS = Core::sanitizeParams(all); allS.weightCurve = wSan.data();
        runCounted(allS, y4, allocs);
        const long long nf = countNonFinite(y1) + countNonFinite(y3);
        char buf[300];
        std::snprintf(buf, sizeof buf, "T-E weightCurve {NaN, Inf, -Inf, -1, 1e30, 0.5} == {1, 1, 1, 0, 2.5, 0.5} (max |diff| %.1e); every field non-finite at once == its sanitised set (max |diff| %.1e); non-finite %lld, allocations %lld",
                      sameDiff(y1, y2).maxAbs, sameDiff(y3, y4).maxAbs, nf, allocs);
        check(sameDiff(y1, y2).maxAbs == 0.0 && sameDiff(y3, y4).maxAbs == 0.0 && nf == 0 && allocs == 0, buf);
    }
}

// T-H: the hop phase offset survives tier switches. 8 instances prepared at Normal with hopPhaseOffsetForInstance(i, 256), all switched together
// Normal -> High -> Fast -> Normal; in each steady segment count the frame boundaries per 64-sample block over the 8 instances, and the offsets.
void testHopPhaseAcrossSwitch()
{
    const double sr = 48000.0;
    const Stereo in = makePink(static_cast<int>(3.0 * sr), -20.0, 121);
    for (int staggered = 1; staggered >= 0; --staggered)
    {
        Core cores[8];
        for (int i = 0; i < 8; ++i) { cores[i].setHopPhaseOffset(staggered ? Core::hopPhaseOffsetForInstance(i, 256) : 0); cores[i].prepare(sr, 64, 2); }
        std::vector<float> l(64), r(64);
        float* ptrs[2] = { l.data(), r.data() };
        const Core::FrameTier seq[4] = { Core::FrameTier::Normal, Core::FrameTier::High, Core::FrameTier::Fast, Core::FrameTier::Normal };
        const int segBlocks = static_cast<int>(0.6 * sr) / 64;
        std::string detail;
        bool ok = true;
        int pos = 0;
        for (int s = 0; s < 4; ++s)
        {
            if (s > 0) for (auto& c : cores) c.requestTier(seq[s]);
            int maxPer = 0;
            bool offsOk = true;
            for (int blk = 0; blk < segBlocks; ++blk, pos += 64)
            {
                int frames = 0;
                bool anyTransition = false;
                for (int i = 0; i < 8; ++i)
                {
                    std::memcpy(l.data(), in.ch[0].data() + pos, sizeof(float) * 64);
                    std::memcpy(r.data(), in.ch[1].data() + pos, sizeof(float) * 64);
                    const long long before = cores[i].framesProcessed();
                    cores[i].process(ptrs, 2, 64, Params{});
                    frames += static_cast<int>(cores[i].framesProcessed() - before);
                    anyTransition = anyTransition || cores[i].tierTransitionActive() || cores[i].frameTier() != seq[s];
                }
                if (blk >= segBlocks / 4 && !anyTransition) maxPer = std::max(maxPer, frames);   // steady part of the segment
            }
            const int hop = cores[0].hopSize();
            for (int i = 0; i < 8; ++i)
            {
                const int want = staggered ? Core::hopPhaseOffsetForInstance(i, 256) * hop / 256 : 0;
                offsOk = offsOk && cores[i].hopPhaseOffset() == want && cores[i].frameTier() == seq[s];
            }
            const int expectMax = std::max(1, (8 * 64 + hop - 1) / hop);   // staggered: 8 instances spread evenly over the hop's 64-sample blocks
            const bool segOk = offsOk && (staggered ? maxPer <= expectMax : maxPer == 8);
            ok = ok && segOk;
            detail += std::string(" ") + tierName(seq[s]) + " hop " + std::to_string(hop) + ": max " + std::to_string(maxPer) + (staggered ? " (<= " + std::to_string(expectMax) + ")" : "") + (offsOk ? "" : " OFFSETS WRONG");
        }
        check(ok, std::string("T-H 8 instances switched together Normal -> High -> Fast -> Normal, block 64, ") + (staggered ? "hopPhaseOffsetForInstance(i, 256)" : "all offset 0 (control)")
                      + ": frame boundaries per block over the 8 in steady state," + detail + (staggered ? "; offsets scale with the hop (x2 High, /2 Fast, back to the original)" : ""));
    }
}

} // namespace

int main(int argc, char** argv)
{
    std::printf("[ResCore] test_resonance_core\n");
    // Optional filter for local iteration: `test_resonance_core <substring>` runs only the switching / hardening groups whose name contains it
    // (ctest passes no argument and runs everything).
    const std::string only = argc > 1 ? argv[1] : "";
    if (!only.empty())
    {
        struct G { const char* name; void (*fn)(); };
        const G groups[] = { { "testFixedTierBitIdentity", testFixedTierBitIdentity }, { "testParamHardening", testParamHardening },
                             { "testHopPhaseAcrossSwitch", testHopPhaseAcrossSwitch }, { "testTierSwitchAllocations", testTierSwitchAllocations },
                             { "testTierSwitchTransitions", testTierSwitchTransitions }, { "testMidSideAcrossSwitch", testMidSideAcrossSwitch }, { "testTierSwitchContinuity", testTierSwitchContinuity },
                             { "testTierSwitchStress", testTierSwitchStress } };
        for (const G& g : groups) if (std::string(g.name).find(only) != std::string::npos) g.fn();
        std::printf("[ResCore] --- %d passed, %d failed ---\n", g_pass, g_fail);
        return g_fail == 0 ? 0 : 1;
    }
    testLatency();
    testTierSizes();
    testIdentityAndCola();
    testImpulse();
    testAllocations();
    testBlockSizeIndependence();
    testReset();
    testMono();
    testHopPhaseOffset();
    testDetectorFunction();
    testDynamics();
    testWeightCurve();
    testSharpness();
    testChannelModes();
    testVizTap();
    testMeters();
    testParamChangeSafety();
    testHopPhaseHelper();
    testFixedTierBitIdentity();
    testParamHardening();
    testHopPhaseAcrossSwitch();
    testTierSwitchAllocations();
    testTierSwitchTransitions();
    testMidSideAcrossSwitch();
    testTierSwitchContinuity();
    testTierSwitchStress();
    std::printf("[ResCore] --- %d passed, %d failed ---\n", g_pass, g_fail);
    return g_fail == 0 ? 0 : 1;
}
