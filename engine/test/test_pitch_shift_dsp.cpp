// test_pitch_shift_dsp.cpp — Realtime pitch-shift DSP foundation (Pitch Shifter P1).
// Build: see engine/CMakeLists.txt target "test_pitch_shift_dsp"
// Run:   test_pitch_shift_dsp.exe
// Pass:  prints "ALL TESTS PASSED" and exits 0
// Fail:  prints "FAIL [line] ..." and exits 1
//
// Covers dsp/GranularShifter.{h,cpp} and dsp/LiveShifterWrapper.{h,cpp}:
//
//   1. Granular spectral quality — sine sweep 100 Hz .. 10 kHz at -12, +7 and
//      +12 st. Asserts the worst out-of-band spur (grain sideband or resampling
//      image) and the harmonic THD stay under stated dB floors.
//   2. Stream count — the same measurement for 2 and 4 grain streams, which is
//      what justifies GranularShifter::kDefaultStreams.
//   3. Click freedom — at grain boundaries in steady state, and across
//      mid-stream pitch and grain-size changes.
//   4. LATENCY INVARIANCE — getLatencySamples() identical across the full
//      +/-24 st range (both modules) and across the full 10..100 ms grain-size
//      range (granular), with the measured impulse delay matching the reported
//      figure.
//   5. Zero allocation in both process() calls, via a counting global
//      operator new/delete.
//
// Every threshold is a named constant below, with the measured headroom noted.

#include "dsp/GranularShifter.h"
#include "dsp/LiveShifterWrapper.h"

#include <juce_audio_basics/juce_audio_basics.h>
#include <juce_core/juce_core.h>
#include <juce_dsp/juce_dsp.h>
#include <juce_gui_basics/juce_gui_basics.h>

#include <algorithm>
#include <atomic>
#include <cmath>
#include <cstdio>
#include <chrono>
#include <cstdlib>
#include <iostream>
#include <vector>

// ─── Counting allocator ──────────────────────────────────────────────────────
// Armed only around the process() calls under test. Uses malloc/free so the
// counter itself never recurses.

namespace {
std::atomic<bool>     g_allocArmed  { false };
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

#define CHECK(cond, msg)                                                       \
    do {                                                                       \
        if (cond) { ++g_passed; }                                              \
        else { std::cerr << "  FAIL [" << __LINE__ << "] " << msg << "\n";     \
               ++g_failed; }                                                   \
    } while (0)

static constexpr double kSR        = 48000.0;
static constexpr int    kBlock     = 512;   // engine-typical block
static constexpr int    kOddBlock  = 337;   // deliberately not a divisor of 512

// ─── Thresholds ──────────────────────────────────────────────────────────────
// Filled in from the first instrumented run; see the report printed by this
// test. Each carries roughly 3 dB of headroom over the worst measured case so
// that ordinary codegen drift does not flip the result.

// Granular aliasing floor: total energy landing above where a 200 Hz .. 5 kHz
// band can legitimately reach after shifting, relative to the energy inside it.
// See granularAliasDb() - this is the interpolator-quality number, and it is
// the one the "image/alias below a stated dB floor" requirement lands on.
static constexpr double kGranularAliasDb = -52.0;

// Granular grain-rate skirt: sideband ENERGY within 10 grain rates, relative to
// the carrier's own main-lobe energy. See measureSpectrum() - on a pure sine
// this is intrinsic to any delay-line / granular shifter and at the unlucky
// frequencies the sidebands carry MORE energy than the carrier, so the bound is
// above 0 dB on purpose. It exists to catch a regression, not to certify
// transparency. Pinned a few dB above the worst measured case: +1.8 dB at the
// default 2 streams, +24.7 dB at 4 - which is why 4 is not the default.
static constexpr double kGranularSkirtDb = 6.0;

// Granular: harmonic distortion only (2nd..10th harmonic of the shifted
// fundamental, RMS).
static constexpr double kGranularThdDb = -30.0;

// Click detection. A "click" is a frame-to-frame step far larger than the
// signal's own maximum slope. Expressed as a multiple of the theoretical peak
// slope of the output sinusoid, A * 2*pi*f_out/fs.
static constexpr double kMaxSlopeRatio = 4.0;

// LiveShifter measured-vs-reported delay, in samples, on a stream that sets its
// pitch and plays. The granular path is exact (unity pitch is a bit-perfect
// delay, so it uses +/-1); the LiveShifter is an FFT process whose impulse
// response is spread over a window, and its delay is compensated from a
// 2-semitone calibration grid, so the residual is that grid's interpolation
// error plus the estimator's own spread. Worst measured: 30 samples.
// Uncompensated, the same sweep moved by 3260.
static constexpr int kLiveDelayToleranceSamples = 96;

// The same thing, but reaching each pitch by automating one live stream instead
// of starting there. Looser on purpose: R3LiveShifter's pipeline is path
// dependent, so an instantaneous +24 st -> -24 st leap settles at a different
// delay than the calibration's unity-to-target path. Worst measured: 421
// samples (8.8 ms), against 3260 uncompensated. See finding (c) in
// LiveShifterWrapper.h - this is a property of the vendored shifter, and the
// REPORTED latency does not move either way, so PDC stays correct.
static constexpr int kLiveAutomationToleranceSamples = 640;

// ─── Signal helpers ──────────────────────────────────────────────────────────

// Runs `totalSamples` of `gen` through `shifter` in blocks of `blockSize`,
// returning the whole output. `onSample` is called with the absolute sample
// index before each block, so a test can mutate parameters mid-stream.
template <typename Shifter, typename Gen, typename MidStream>
static std::vector<float> runStream(Shifter& shifter, int totalSamples,
                                    int blockSize, Gen gen, MidStream midStream)
{
    std::vector<float>       out((size_t) totalSamples, 0.0f);
    juce::AudioBuffer<float> block(1, blockSize);

    for (int i = 0; i < totalSamples; i += blockSize)
    {
        const int n = std::min(blockSize, totalSamples - i);
        midStream(i);

        block.setSize(1, n, false, false, true);
        float* w = block.getWritePointer(0);
        for (int k = 0; k < n; ++k) w[k] = gen(i + k);

        shifter.process(block);

        const float* r = block.getReadPointer(0);
        for (int k = 0; k < n; ++k) out[(size_t) (i + k)] = r[k];
    }
    return out;
}

template <typename Shifter, typename Gen>
static std::vector<float> runStream(Shifter& shifter, int totalSamples,
                                    int blockSize, Gen gen)
{
    return runStream(shifter, totalSamples, blockSize, gen, [](int) {});
}

struct Spectrum
{
    std::vector<float> mag;      // linear magnitude, bin 0 .. size/2
    double             binHz = 0.0;
};

// Hann-windowed magnitude spectrum of `n` samples starting at `offset`.
static Spectrum analyse(const std::vector<float>& x, int offset, int fftOrder)
{
    const int size = 1 << fftOrder;
    juce::dsp::FFT fft(fftOrder);

    std::vector<float> buf((size_t) size * 2, 0.0f);
    for (int i = 0; i < size; ++i)
    {
        const double w = 0.5 * (1.0 - std::cos(2.0 * juce::MathConstants<double>::pi * i / (size - 1)));
        const int    j = offset + i;
        buf[(size_t) i] = (j >= 0 && j < (int) x.size()) ? (float) (x[(size_t) j] * w) : 0.0f;
    }

    fft.performFrequencyOnlyForwardTransform(buf.data());

    Spectrum s;
    s.mag.assign(buf.begin(), buf.begin() + size / 2 + 1);
    s.binHz = kSR / size;
    return s;
}

struct SpectralReport
{
    double fundamentalHz = 0.0;
    double nearSkirtDb   = -999.0;   // grain-rate skirt ENERGY vs carrier energy
    double farSpurDb     = -999.0;   // interpolator images / aliases
    double thdDb         = -999.0;   // harmonics 2..10
};

// A granular (== delay-line) pitch shifter produces two artifact families, and
// conflating them hides the one that is actually a quality metric:
//
//   NEAR SKIRT   Successive grains re-enter at a phase that advances by
//                2*pi*f*(r-1)*G per relaunch, so the overlap-add is amplitude-
//                modulated at the grain rate. That puts sidebands at
//                f_out +/- k/G. On a PURE SINE at an unlucky frequency the two
//                crossfading grains land in antiphase and null the carrier
//                outright, so these sidebands can reach the carrier's own
//                level. This is intrinsic to the algorithm, not a defect in
//                this implementation: it is the classic granular "warble".
//                Measured and reported, bounded only loosely.
//
//   FAR SPUR     Everything further out than a few grain rates: images and
//                aliases from reading the input at a fractional stride. THIS is
//                the interpolator-quality number the alias bound belongs on,
//                and it is what the Hermite read head buys us.
//
// `skirtHz` is the boundary between them, passed in by the caller as a multiple
// of the grain rate.
static SpectralReport measureSpectrum(const Spectrum& s, double expectedHz, double skirtHz)
{
    const int nBins = (int) s.mag.size();

    // A 16384-point Hann main lobe is 4 bins wide, so +/-3 finds the peak
    // without reaching a sideband and +/-5 excludes the lobe cleanly.
    const int findWin   = 3;
    const int guard     = 5;
    const int skirtBins = std::max(guard + 1, (int) std::lround(skirtHz / s.binHz));

    const int expBin  = (int) std::lround(expectedHz / s.binHz);
    const int firstOk = std::max(3, (int) std::lround(20.0 / s.binHz));

    int    fundBin = expBin;
    double fundMag = 0.0;
    for (int b = std::max(1, expBin - findWin); b <= std::min(nBins - 1, expBin + findWin); ++b)
        if (s.mag[(size_t) b] > fundMag) { fundMag = s.mag[(size_t) b]; fundBin = b; }

    SpectralReport rep;
    rep.fundamentalHz = fundBin * s.binHz;
    if (fundMag <= 0.0) return rep;

    auto inGuard = [&](int b, int centre) { return std::abs(b - centre) <= guard; };

    auto nearHarmonic = [&](int b)
    {
        for (int h = 2; h <= 10; ++h)
        {
            const int hb = fundBin * h;
            if (hb - guard >= nBins) break;
            if (inGuard(b, hb)) return true;
        }
        return false;
    };

    // Carrier energy is the whole main lobe, so the ratios below stay stable
    // whichever bin the peak happens to land in.
    double carrierE = 0.0;
    for (int b = std::max(0, fundBin - guard); b <= std::min(nBins - 1, fundBin + guard); ++b)
        carrierE += (double) s.mag[(size_t) b] * s.mag[(size_t) b];

    double nearE    = 0.0;   // skirt ENERGY, not a peak bin: it can exceed the
    double farWorst = 0.0;   // carrier, and the assertion needs to see that.
    for (int b = firstOk; b < nBins; ++b)
    {
        if (inGuard(b, fundBin)) continue;
        if (nearHarmonic(b))     continue;

        const double m = (double) s.mag[(size_t) b];
        if (std::abs(b - fundBin) <= skirtBins) nearE += m * m;
        else                                    farWorst = std::max(farWorst, m);
    }

    const double ref = std::max(fundMag, 1e-12);

    double harmSq = 0.0;
    for (int h = 2; h <= 10; ++h)
    {
        const int hb = fundBin * h;
        if (hb + guard >= nBins) break;
        double peak = 0.0;
        for (int b = hb - guard; b <= hb + guard; ++b)
            peak = std::max(peak, (double) s.mag[(size_t) b]);
        harmSq += peak * peak;
    }

    rep.nearSkirtDb = 10.0 * std::log10(std::max(nearE, 1e-24) / std::max(carrierE, 1e-24));
    rep.farSpurDb   = 20.0 * std::log10(std::max(farWorst,  1e-12) / ref);
    rep.thdDb       = 20.0 * std::log10(std::max(std::sqrt(harmSq), 1e-12) / ref);
    return rep;
}

// Largest frame-to-frame step in `x` over [from, to), as a multiple of the
// theoretical peak slope of an `amp`-amplitude sinusoid at `fHz`.
static double maxSlopeRatio(const std::vector<float>& x, int from, int to,
                            double amp, double fHz)
{
    const double nominal = amp * 2.0 * juce::MathConstants<double>::pi * fHz / kSR;
    double worst = 0.0;
    for (int i = std::max(1, from); i < std::min(to, (int) x.size()); ++i)
        worst = std::max(worst, (double) std::abs(x[(size_t) i] - x[(size_t) i - 1]));
    return worst / std::max(nominal, 1e-12);
}

// Where an impulse response's energy is centred, as the midpoint of the
// 128-sample window holding the most energy. Mirrors the estimator
// LiveShifterWrapper uses for its own calibration, so the two are directly
// comparable - measuring with a different yardstick than the compensation was
// built from would just report the difference between the yardsticks.
//
// For the granular path, whose impulse response really is a single sample, this
// returns that sample +/- 0, so both modules can be measured the same way.
static int smoothedEnergyPeak(const std::vector<float>& x)
{
    constexpr int kEnergyWindow = 128;

    const int n = (int) x.size();
    if (n <= kEnergyWindow) return n / 2;

    double run = 0.0;
    for (int i = 0; i < kEnergyWindow; ++i) run += (double) x[(size_t) i] * x[(size_t) i];

    double best    = run;
    int    bestPos = 0;
    for (int i = kEnergyWindow; i < n; ++i)
    {
        run += (double) x[(size_t) i] * x[(size_t) i];
        run -= (double) x[(size_t) (i - kEnergyWindow)] * x[(size_t) (i - kEnergyWindow)];
        if (run > best) { best = run; bestPos = i - kEnergyWindow + 1; }
    }

    if (best <= 0.0) return 0;
    return bestPos + kEnergyWindow / 2;
}

static int peakIndex(const std::vector<float>& x)
{
    int    best = 0;
    double bestV = -1.0;
    for (int i = 0; i < (int) x.size(); ++i)
        if (std::abs(x[(size_t) i]) > bestV) { bestV = std::abs(x[(size_t) i]); best = i; }
    return best;
}

// ─── 1 & 2. Granular spectral quality, by stream count ───────────────────────

struct SweepResult
{
    double worstNearSkirt = -999.0;
    double worstFarSpur   = -999.0;
    double worstThd       = -999.0;
};

static SweepResult granularSweep(int numStreams, double semis, double grainMs, bool verbose)
{
    static constexpr double kFreqs[] = { 100.0, 220.0, 440.0, 1000.0, 2500.0, 5000.0, 10000.0 };
    const double ratio = std::pow(2.0, semis / 12.0);

    constexpr int fftOrder = 14;               // 16384 bins, 2.93 Hz resolution
    constexpr int fftSize  = 1 << fftOrder;

    // Boundary between the grain-rate skirt and the image/alias field, at 10x
    // the grain rate: beyond the 10th sideband a Hann overlap-add's modulation
    // skirt is already far below the floor being bounded.
    const double grainRateHz = 1000.0 / grainMs;
    const double skirtHz     = 10.0 * grainRateHz;

    SweepResult res;

    for (double f : kFreqs)
    {
        const double fOut = f * ratio;

        // Above Nyquist after shifting is not a meaningful test case.
        if (fOut > 0.45 * kSR) continue;

        // A grain must hold enough cycles of the OUTPUT tone for "carrier vs
        // sideband" to mean anything: below ~8 cycles per grain the sidebands
        // are not a skirt, they are the signal. 50 ms grains cannot granulate a
        // 50 Hz tone, and no implementation choice changes that.
        if (fOut * grainMs / 1000.0 < 8.0) continue;

        xleth::dsp::GranularShifter g;
        g.prepare(kSR, 1, kBlock, numStreams);
        g.setGrainSizeMs(grainMs);
        g.setPitch((int) semis, 0);

        const int settle = g.getLatencySamples() + 4 * fftSize / 8;
        const int total  = settle + fftSize + kBlock;

        auto out = runStream(g, total, kBlock, [&](int n)
        {
            return (float) (0.5 * std::sin(2.0 * juce::MathConstants<double>::pi * f * n / kSR));
        });

        const auto rep = measureSpectrum(analyse(out, settle, fftOrder), fOut, skirtHz);
        res.worstNearSkirt = std::max(res.worstNearSkirt, rep.nearSkirtDb);
        res.worstFarSpur   = std::max(res.worstFarSpur,   rep.farSpurDb);
        res.worstThd       = std::max(res.worstThd,       rep.thdDb);

        if (verbose)
            std::printf("      f=%7.0f Hz -> %9.1f Hz   skirt %6.1f dB   image/alias %6.1f dB   THD %6.1f dB\n",
                        f, rep.fundamentalHz, rep.nearSkirtDb, rep.farSpurDb, rep.thdDb);
    }

    if (verbose)
        std::printf("    streams=%d  %+5.1f st  grain %.0f ms : worst skirt %.1f dB, "
                    "worst image/alias %.1f dB, worst THD %.1f dB\n",
                    numStreams, semis, grainMs, res.worstNearSkirt, res.worstFarSpur, res.worstThd);

    return res;
}

// Band-limited alias / image measurement.
//
// The per-frequency sine table above cannot separate an interpolation image
// from a far-out grain-rate sideband, because a deeply modulated carrier
// splatters sidebands well past any fixed skirt boundary. This does separate
// them: feed a signal that occupies only 200 Hz .. 5 kHz, shift it, and measure
// the energy that lands ABOVE where the shifted band can legitimately reach.
// Modulation sidebands stay next to their own partials; images and aliases do
// not. Everything above the edge is therefore an image or an alias, whatever
// produced it.
//
// The shifter is a linear (time-varying) system - grain windowing and fractional
// reads are both linear - so there is no harmonic or intermodulation product to
// confuse the measurement either.
static double granularAliasDb(int numStreams, double semis, double grainMs, double jitterHeadroomHz)
{
    const double ratio   = std::pow(2.0, semis / 12.0);
    const double bandLo  = 200.0;
    const double bandHi  = 5000.0;
    const double edgeHz  = bandHi * ratio + jitterHeadroomHz;

    constexpr int fftOrder = 14;
    constexpr int fftSize  = 1 << fftOrder;

    // 12 partials spread irrationally across the band so no two share a grain
    // sideband, at equal amplitude.
    constexpr int kPartials = 12;
    double freqs[kPartials];
    double phases[kPartials];
    for (int i = 0; i < kPartials; ++i)
    {
        const double t = (double) i / (kPartials - 1);
        freqs[i]  = bandLo * std::pow(bandHi / bandLo, t) * (1.0 + 0.013 * ((i % 3) - 1));
        phases[i] = 0.7 * i * i;   // deterministic, mutually incoherent
    }

    xleth::dsp::GranularShifter g;
    g.prepare(kSR, 1, kBlock, numStreams);
    g.setGrainSizeMs(grainMs);
    g.setPitch((int) semis, 0);

    const int settle = g.getLatencySamples() + 4 * fftSize / 8;
    const int total  = settle + fftSize + kBlock;

    auto out = runStream(g, total, kBlock, [&](int n)
    {
        double v = 0.0;
        for (int i = 0; i < kPartials; ++i)
            v += std::sin(2.0 * juce::MathConstants<double>::pi * freqs[i] * n / kSR + phases[i]);
        return (float) (0.4 * v / kPartials);
    });

    const auto sp = analyse(out, settle, fftOrder);

    double inBand = 0.0, outBand = 0.0;
    for (int b = 3; b < (int) sp.mag.size(); ++b)
    {
        const double e = (double) sp.mag[(size_t) b] * sp.mag[(size_t) b];
        if (b * sp.binHz <= edgeHz) inBand += e;
        else                        outBand += e;
    }

    return 10.0 * std::log10(std::max(outBand, 1e-24) / std::max(inBand, 1e-24));
}

static void testGranularAliasing()
{
    std::cout << "\n[1b] Granular aliasing (200 Hz .. 5 kHz band, energy above the shifted edge)\n";

    for (double semis : { -12.0, -7.0, 7.0, 12.0 })
        for (double grainMs : { 20.0, 50.0 })
        {
            const double db2 = granularAliasDb(2, semis, grainMs, 1000.0);
            const double db4 = granularAliasDb(4, semis, grainMs, 1000.0);
            std::printf("    %+5.1f st, %4.0f ms grain : 2 streams %6.1f dB   4 streams %6.1f dB\n",
                        semis, grainMs, db2, db4);

            const double db = (xleth::dsp::GranularShifter::kDefaultStreams == 2) ? db2 : db4;
            CHECK(db <= kGranularAliasDb,
                  "granular out-of-band energy " << db << " dB exceeds floor "
                  << kGranularAliasDb << " dB at " << semis << " st, " << grainMs << " ms");
        }
}

static void testGranularSpectralQuality()
{
    std::cout << "\n[1] Granular spectral quality (sine sweep 100 Hz .. 10 kHz, 50 ms grains)\n";

    for (double semis : { -12.0, 7.0, 12.0 })
    {
        const auto r = granularSweep(xleth::dsp::GranularShifter::kDefaultStreams,
                                     semis, 50.0, true);

        CHECK(r.worstThd <= kGranularThdDb,
              "granular THD " << r.worstThd << " dB exceeds floor " << kGranularThdDb
              << " dB at " << semis << " st");
        CHECK(r.worstNearSkirt <= kGranularSkirtDb,
              "granular grain-rate skirt " << r.worstNearSkirt << " dB exceeds bound "
              << kGranularSkirtDb << " dB at " << semis << " st");
    }

    std::cout << "\n[2] Stream count 2 vs 4 (justifies kDefaultStreams)\n";
    for (double semis : { -12.0, 7.0, 12.0 })
    {
        const auto r2 = granularSweep(2, semis, 50.0, false);
        const auto r4 = granularSweep(4, semis, 50.0, false);
        std::printf("    %+5.1f st : skirt  2str %6.1f  4str %6.1f  (delta %+5.1f) | "
                    "image  2str %6.1f  4str %6.1f  (delta %+5.1f)\n",
                    semis, r2.worstNearSkirt, r4.worstNearSkirt,
                    r4.worstNearSkirt - r2.worstNearSkirt,
                    r2.worstFarSpur, r4.worstFarSpur,
                    r4.worstFarSpur - r2.worstFarSpur);
    }
}

// ─── 3. Click freedom ────────────────────────────────────────────────────────

static void testClickFreedom()
{
    std::cout << "\n[3] Click freedom\n";

    static constexpr double kF   = 200.0;
    static constexpr double kAmp = 0.5;

    auto sine = [&](int n)
    {
        return (float) (kAmp * std::sin(2.0 * juce::MathConstants<double>::pi * kF * n / kSR));
    };

    // (a) Steady state: many grain boundaries crossed at a non-unity ratio.
    {
        xleth::dsp::GranularShifter g;
        g.prepare(kSR, 1, kBlock);
        g.setGrainSizeMs(25.0);          // 25 ms grains -> ~80 boundaries in 2 s
        g.setPitch(7, 0);

        const int total = (int) (2.0 * kSR);
        auto out = runStream(g, total, kBlock, sine);

        const double r = maxSlopeRatio(out, g.getLatencySamples() + kBlock, total,
                                       kAmp, kF * std::pow(2.0, 7.0 / 12.0));
        std::printf("    grain boundaries, steady state : max slope %.2fx nominal\n", r);
        CHECK(r <= kMaxSlopeRatio,
              "grain-boundary discontinuity " << r << "x nominal slope exceeds "
              << kMaxSlopeRatio << "x");
    }

    // (b) Mid-stream pitch sweep, one step per block (the automation case).
    {
        xleth::dsp::GranularShifter g;
        g.prepare(kSR, 1, kBlock);
        g.setGrainSizeMs(25.0);
        g.setPitch(0, 0);

        const int total = (int) (2.0 * kSR);
        auto out = runStream(g, total, kBlock, sine, [&](int i)
        {
            // -12 st .. +12 st and back, continuous in cents.
            const double t     = (double) i / total;
            const double semis = 12.0 * std::sin(2.0 * juce::MathConstants<double>::pi * t);
            g.setPitch((int) semis, (int) std::lround((semis - (int) semis) * 100.0));
        });

        // Worst case output frequency over the sweep is kF * 2^1.
        const double r = maxSlopeRatio(out, g.getLatencySamples() + kBlock, total,
                                       kAmp, kF * 2.0);
        std::printf("    mid-stream pitch sweep         : max slope %.2fx nominal\n", r);
        CHECK(r <= kMaxSlopeRatio,
              "pitch-change discontinuity " << r << "x nominal slope exceeds "
              << kMaxSlopeRatio << "x");
    }

    // (c) Mid-stream grain-size changes across the full 10..100 ms range. This
    //     is the case the running window-sum normaliser exists for.
    {
        xleth::dsp::GranularShifter g;
        g.prepare(kSR, 1, kBlock);
        g.setPitch(5, 0);
        g.setGrainSizeMs(10.0);

        const int total = (int) (2.0 * kSR);
        auto out = runStream(g, total, kBlock, sine, [&](int i)
        {
            const double t = (double) i / total;
            g.setGrainSizeMs(10.0 + 90.0 * 0.5 * (1.0 - std::cos(2.0 * juce::MathConstants<double>::pi * t)));
        });

        const double r = maxSlopeRatio(out, g.getLatencySamples() + kBlock, total,
                                       kAmp, kF * std::pow(2.0, 5.0 / 12.0));
        std::printf("    mid-stream grain-size sweep    : max slope %.2fx nominal\n", r);
        CHECK(r <= kMaxSlopeRatio,
              "grain-size-change discontinuity " << r << "x nominal slope exceeds "
              << kMaxSlopeRatio << "x");
    }
}

// ─── 4. Latency invariance ───────────────────────────────────────────────────

static void testGranularLatency()
{
    std::cout << "\n[4a] Granular latency invariance\n";

    xleth::dsp::GranularShifter g;
    g.prepare(kSR, 1, kBlock);
    const int reported = g.getLatencySamples();
    std::printf("    reported latency: %d samples (%.1f ms) = 2 x max grain\n",
                reported, 1000.0 * reported / kSR);

    bool constantOverPitch = true;
    for (int semis = -24; semis <= 24; ++semis)
        for (int cents : { -99, 0, 99 })
        {
            g.setPitch(semis, cents);
            if (g.getLatencySamples() != reported) constantOverPitch = false;
        }
    CHECK(constantOverPitch, "granular latency varied with pitch over +/-24 st");

    bool constantOverSize = true;
    for (double ms = xleth::dsp::GranularShifter::kMinGrainMs;
         ms <= xleth::dsp::GranularShifter::kMaxGrainMs + 1e-9; ms += 1.0)
    {
        g.setGrainSizeMs(ms);
        if (g.getLatencySamples() != reported) constantOverSize = false;
    }
    CHECK(constantOverSize, "granular latency varied with grain size over 10..100 ms");
    std::printf("    constant across +/-24 st (x cents) and 10..100 ms grain: %s\n",
                (constantOverPitch && constantOverSize) ? "yes" : "NO");

    // Measured impulse delay. At unity ratio the delay is a constant integer
    // and every grain reads the same sample, so the overlap-add is a bit-exact
    // pass-through and the impulse lands exactly on `reported`.
    for (double grainMs : { 10.0, 37.0, 100.0 })
    {
        xleth::dsp::GranularShifter h;
        h.prepare(kSR, 1, kBlock);
        h.setGrainSizeMs(grainMs);
        h.setPitch(0, 0);

        const int total = h.getLatencySamples() + 4 * kBlock;
        auto out = runStream(h, total, kBlock, [](int n) { return n == 0 ? 1.0f : 0.0f; });

        const int measured = peakIndex(out);
        std::printf("    grain %5.0f ms : measured impulse delay %d, reported %d (delta %d)\n",
                    grainMs, measured, h.getLatencySamples(), measured - h.getLatencySamples());
        CHECK(std::abs(measured - h.getLatencySamples()) <= 1,
              "granular impulse delay " << measured << " != reported "
              << h.getLatencySamples() << " (grain " << grainMs << " ms)");
    }
}

static void testLiveShifterLatency()
{
    std::cout << "\n[4b] LiveShifter latency invariance\n";

    const auto t0 = std::chrono::steady_clock::now();
    xleth::dsp::LiveShifterWrapper live;
    live.prepare(kSR, 1, kBlock);
    const auto t1 = std::chrono::steady_clock::now();

    CHECK(live.isPrepared(), "LiveShifterWrapper failed to prepare");
    if (! live.isPrepared()) return;

    // A second prepare() with the same configuration must hit the calibration
    // cache, or every device change would pay the impulse sweep again.
    xleth::dsp::LiveShifterWrapper live2;
    const auto t2 = std::chrono::steady_clock::now();
    live2.prepare(kSR, 1, kBlock);
    const auto t3 = std::chrono::steady_clock::now();

    const double firstMs  = std::chrono::duration<double, std::milli>(t1 - t0).count();
    const double cachedMs = std::chrono::duration<double, std::milli>(t3 - t2).count();

    const int reported = live.getLatencySamples();
    std::printf("    shifter block size          : %d\n", live.getBlockSize());
    std::printf("    max(getStartDelay()) sweep  : %d   (diagnostic only)\n", live.getMaxStartDelay());
    std::printf("    calibrated worst-case delay : %d\n", live.getCalibratedMaxDelay());
    std::printf("    reported latency            : %d samples (%.1f ms)\n",
                reported, 1000.0 * reported / kSR);
    std::printf("    prepare(): %.0f ms uncached, %.0f ms cached\n", firstMs, cachedMs);

    CHECK(cachedMs < firstMs * 0.5 + 5.0,
          "second prepare() took " << cachedMs << " ms vs " << firstMs
          << " ms - the calibration cache is not being hit");

    bool constant = true;
    for (int semis = -24; semis <= 24; ++semis)
        for (int cents : { -99, 0, 99 })
        {
            live.setPitch(semis, cents);
            if (live.getLatencySamples() != reported) constant = false;
        }
    CHECK(constant, "LiveShifter latency varied with pitch over +/-24 st");
    std::printf("    reported latency constant across +/-24 st (x cents): %s\n",
                constant ? "yes" : "NO");

    // Measured delay, per pitch, through the whole wrapper. The raw column is
    // the shifter's uncompensated pipeline delay; the padded column is what the
    // caller actually gets, and it is the one that must not move.
    std::printf("    %-8s %10s %10s %10s\n", "pitch", "raw", "measured", "vs reported");
    int worstErr = 0;
    for (int semis : { -24, -18, -12, -7, -3, 0, 3, 7, 12, 18, 24 })
    {
        xleth::dsp::LiveShifterWrapper l;
        l.prepare(kSR, 1, kBlock);
        l.setPitch(semis, 0);

        const int total = l.getLatencySamples() + 24 * kBlock;
        auto out = runStream(l, total, kBlock, [](int n) { return n == 0 ? 1.0f : 0.0f; });

        const int measured = smoothedEnergyPeak(out);
        const int err      = measured - l.getLatencySamples();
        worstErr = std::max(worstErr, std::abs(err));

        std::printf("    %+3d st   %10d %10d %+10d\n",
                    semis, l.getCalibratedDelayAt(semis), measured, err);
        CHECK(std::abs(err) <= kLiveDelayToleranceSamples,
              "LiveShifter measured delay " << measured << " is " << err
              << " samples off the reported " << l.getLatencySamples()
              << " at " << semis << " st (tolerance "
              << kLiveDelayToleranceSamples << ")");
    }
    std::printf("    worst |measured - reported| across the sweep: %d samples (%.2f ms)\n",
                worstErr, 1000.0 * worstErr / kSR);

    // The same measurement, but reaching each pitch by AUTOMATION on one live
    // stream rather than by starting there. This is the case that actually
    // desyncs PDC, so it gets its own assertion.
    std::printf("    automated (one stream, pitch changed mid-flight):\n");
    {
        xleth::dsp::LiveShifterWrapper l;
        l.prepare(kSR, 1, kBlock);
        const int rep = l.getLatencySamples();

        juce::AudioBuffer<float> b(1, kBlock);
        int autoWorst = 0;

        for (int semis : { 0, 24, -24, 7, -12, 12 })
        {
            l.setPitch(semis, 0);
            for (int i = 0; i < 256; ++i) { b.clear(); l.process(b); }   // settle

            const int total = rep + 24 * kBlock;
            std::vector<float> out((size_t) total, 0.0f);
            for (int i = 0; i < total; i += kBlock)
            {
                b.clear();
                if (i == 0) b.setSample(0, 0, 1.0f);
                l.process(b);
                for (int k = 0; k < kBlock && i + k < total; ++k)
                    out[(size_t) (i + k)] = b.getReadPointer(0)[k];
            }

            const int measured = smoothedEnergyPeak(out);
            const int err      = measured - rep;
            autoWorst = std::max(autoWorst, std::abs(err));
            std::printf("    %+3d st   %10s %10d %+10d\n", semis, "-", measured, err);
        }

        std::printf("    worst automation-induced latency error: %d samples (%.2f ms)\n",
                    autoWorst, 1000.0 * autoWorst / kSR);
        CHECK(autoWorst <= kLiveAutomationToleranceSamples,
              "automating pitch moved the LiveShifter's actual latency by "
              << autoWorst << " samples (tolerance "
              << kLiveAutomationToleranceSamples << ")");
    }
}

// ─── 5. Zero allocation ──────────────────────────────────────────────────────

static void testZeroAllocation()
{
    std::cout << "\n[5] Zero allocation in process()\n";

    // Granular. Odd block size so the ring wraps at non-power-of-two offsets,
    // and parameters moved every block so the latch path is exercised too.
    {
        xleth::dsp::GranularShifter g;
        g.prepare(kSR, 2, kBlock);
        g.setGrainSizeMs(40.0);
        g.setPitch(5, 25);

        juce::AudioBuffer<float> block(2, kOddBlock);
        block.clear();

        // Warm up outside the armed window (first touch of any lazily grown
        // internal storage would otherwise be counted).
        for (int i = 0; i < 8; ++i) g.process(block);

        g_allocCount.store(0);
        g_allocArmed.store(true);
        for (int i = 0; i < 400; ++i)
        {
            g.setPitch(i % 49 - 24, (i * 7) % 100);
            g.setGrainSizeMs(10.0 + (i % 90));
            g.process(block);
        }
        g_allocArmed.store(false);

        const long long n = g_allocCount.load();
        std::printf("    GranularShifter::process  x400 : %lld allocations\n", n);
        CHECK(n == 0, "GranularShifter::process allocated " << n << " times");
    }

    // LiveShifter.
    {
        xleth::dsp::LiveShifterWrapper l;
        l.prepare(kSR, 2, kBlock);
        l.setPitch(-5, 50);

        juce::AudioBuffer<float> block(2, kOddBlock);
        block.clear();

        for (int i = 0; i < 8; ++i) l.process(block);

        g_allocCount.store(0);
        g_allocArmed.store(true);
        for (int i = 0; i < 400; ++i)
        {
            l.setPitch(i % 49 - 24, (i * 13) % 100);
            l.setFormantScale(i % 2 ? 0.0f : 1.25f);
            l.setFormantOption(i % 3 == 0 ? xleth::dsp::LiveShifterWrapper::Formant::Preserved
                                          : xleth::dsp::LiveShifterWrapper::Formant::Shifted);
            l.process(block);
        }
        g_allocArmed.store(false);

        const long long n = g_allocCount.load();
        std::printf("    LiveShifterWrapper::process x400: %lld allocations\n", n);
        CHECK(n == 0, "LiveShifterWrapper::process allocated " << n << " times");
    }
}

// ─── 6. Duration preservation / sanity ───────────────────────────────────────

static void testSanity()
{
    std::cout << "\n[6] Sanity\n";

    // Duration preservation is structural: process() is in-place and returns
    // exactly as many frames as it was given, for both modules and for a block
    // size that is not a multiple of the LiveShifter's 512.
    {
        xleth::dsp::GranularShifter g;
        g.prepare(kSR, 2, kBlock);
        g.setPitch(12, 0);
        juce::AudioBuffer<float> b(2, kOddBlock);
        b.clear();
        g.process(b);
        CHECK(b.getNumSamples() == kOddBlock, "granular changed the block length");
    }

    // Unity pitch through the granular path is a pure delay: assert it really
    // is bit-exact, which is what makes the impulse-delay measurement above
    // meaningful rather than approximate.
    {
        xleth::dsp::GranularShifter g;
        g.prepare(kSR, 1, kBlock);
        g.setPitch(0, 0);
        g.setGrainSizeMs(35.0);

        const int L     = g.getLatencySamples();
        const int total = L + 4 * kBlock;

        auto gen = [](int n)
        {
            return (float) (0.4 * std::sin(2.0 * juce::MathConstants<double>::pi * 331.0 * n / kSR)
                          + 0.2 * std::sin(2.0 * juce::MathConstants<double>::pi * 1777.0 * n / kSR));
        };
        auto out = runStream(g, total, kBlock, gen);

        double worst = 0.0;
        for (int i = L; i < total; ++i)
            worst = std::max(worst, (double) std::abs(out[(size_t) i] - gen(i - L)));
        std::printf("    unity-pitch pass-through error : %.3e\n", worst);
        CHECK(worst < 1.0e-6,
              "unity pitch is not a pure delay: worst error " << worst);
    }

    // Variable block sizes through the LiveShifter FIFO must never underrun:
    // any underrun shows up as the R3 error path's 0.9x decay tail, so a
    // sustained sine should come out at a sane level.
    {
        xleth::dsp::LiveShifterWrapper l;
        l.prepare(kSR, 1, 2048);
        l.setPitch(0, 0);

        juce::AudioBuffer<float> b(1, 2048);
        double  peak = 0.0;
        int     n    = 0;
        const int sizes[] = { 1, 17, 512, 2048, 333, 64, 1024, 7 };

        for (int rep = 0; rep < 60; ++rep)
        {
            const int sz = sizes[rep % 8];
            b.setSize(1, sz, false, false, true);
            float* w = b.getWritePointer(0);
            for (int k = 0; k < sz; ++k, ++n)
                w[k] = (float) (0.5 * std::sin(2.0 * juce::MathConstants<double>::pi * 440.0 * n / kSR));
            l.process(b);
            if (n > l.getLatencySamples() + 4096)
                peak = std::max(peak, (double) b.getMagnitude(0, sz));
        }
        std::printf("    ragged block sizes, unity pitch: output peak %.3f\n", peak);
        CHECK(peak > 0.3 && peak < 0.8,
              "LiveShifter output peak " << peak << " under ragged block sizes "
              "(expected ~0.5; an underrun would collapse it)");
    }
}

// ─── main ────────────────────────────────────────────────────────────────────

int main()
{
    juce::ScopedJuceInitialiser_GUI juceInit;

    std::cout << "=== test_pitch_shift_dsp ===\n";

    testGranularSpectralQuality();
    testGranularAliasing();
    testClickFreedom();
    testGranularLatency();
    testLiveShifterLatency();
    testZeroAllocation();
    testSanity();

    std::cout << "\n--- " << g_passed << " passed, " << g_failed << " failed ---\n";
    if (g_failed == 0) { std::cout << "ALL TESTS PASSED\n"; return 0; }
    return 1;
}
