// test_loop_analysis.cpp — Unit tests for the seam-similarity primitives in
// dsp/LoopAnalysis.h (the Auto Loop Optimizer cost-function terms).
// Build: see engine/CMakeLists.txt target "test_loop_analysis"
// Run:   test_loop_analysis.exe
// Pass:  prints "ALL TESTS PASSED" and exits 0
// Fail:  prints "FAILED: ..." and exits 1
//
// Every case is synthetic with a known closed-form answer, so these assert real
// numeric values rather than pinning a captured baseline.

#include "dsp/LoopAnalysis.h"

#include <juce_core/juce_core.h>
#include <juce_dsp/juce_dsp.h>

#include <cmath>
#include <cstdint>
#include <iostream>
#include <vector>

static int g_passed = 0;
static int g_failed = 0;

#define CHECK(cond, msg)                                                 \
    do {                                                                 \
        if (cond) { ++g_passed; }                                        \
        else { std::cerr << "  FAIL [" << __LINE__ << "] " << msg << "\n"; ++g_failed; } \
    } while (0)

static constexpr double kSR = 48000.0;

using namespace xleth::dsp;

// Deterministic uniform noise in [-1, 1] — a fixed LCG keeps the "uncorrelated"
// cases reproducible across runs and platforms.
static std::vector<float> makeNoise(int n, std::uint32_t seed)
{
    std::vector<float> v((size_t)n);
    std::uint32_t s = seed;
    for (int i = 0; i < n; ++i) {
        s = s * 1664525u + 1013904223u;
        v[(size_t)i] = (float)((double)(s >> 8) / (double)(1u << 24)) * 2.0f - 1.0f;
    }
    return v;
}

static std::vector<float> makeSine(int n, double freqHz, double sampleRate, double phase = 0.0)
{
    std::vector<float> v((size_t)n);
    const double w = 2.0 * juce::MathConstants<double>::pi * freqHz / sampleRate;
    for (int i = 0; i < n; ++i)
        v[(size_t)i] = (float)std::sin(w * i + phase);
    return v;
}

static bool finite(float x) { return std::isfinite(x); }

// ── normalizedCrossCorrelation ───────────────────────────────────────────────
static void testNCC()
{
    std::cout << "normalizedCrossCorrelation\n";
    const int N = 4096;
    const auto x = makeNoise(N, 12345u);

    // Self-similarity is exactly 1.
    const float self = normalizedCrossCorrelation(x.data(), x.data(), N);
    CHECK(std::abs(self - 1.0f) < 1e-5f, "NCC(x, x) should be 1, got " << self);

    // Inversion is exactly -1: mean-removal means this holds even though the
    // noise has a non-zero DC offset.
    std::vector<float> negX((size_t)N);
    for (int i = 0; i < N; ++i) negX[(size_t)i] = -x[(size_t)i];
    const float inv = normalizedCrossCorrelation(x.data(), negX.data(), N);
    CHECK(std::abs(inv + 1.0f) < 1e-5f, "NCC(x, -x) should be -1, got " << inv);

    // Independent noise: |r| ~ 1/sqrt(N) ≈ 0.016 here, so 0.05 is a safe bound.
    const auto y = makeNoise(N, 999u);
    const float uncorr = normalizedCrossCorrelation(x.data(), y.data(), N);
    CHECK(std::abs(uncorr) < 0.05f, "NCC(x, uncorrelated) should be ~0, got " << uncorr);

    // Gain and DC offset must not move the result — level is the energy term's job.
    std::vector<float> scaled((size_t)N);
    for (int i = 0; i < N; ++i) scaled[(size_t)i] = 0.25f * x[(size_t)i] + 0.5f;
    const float gainInv = normalizedCrossCorrelation(x.data(), scaled.data(), N);
    CHECK(std::abs(gainInv - 1.0f) < 1e-5f,
          "NCC should be gain/DC invariant, got " << gainInv);

    // Silence: defined as 0, and above all must not be NaN.
    const std::vector<float> zeros((size_t)N, 0.0f);
    const float silSil = normalizedCrossCorrelation(zeros.data(), zeros.data(), N);
    CHECK(finite(silSil) && silSil == 0.0f, "NCC(silence, silence) should be 0, got " << silSil);

    const float silX = normalizedCrossCorrelation(zeros.data(), x.data(), N);
    CHECK(finite(silX) && silX == 0.0f, "NCC(silence, x) should be 0, got " << silX);

    // A constant (DC-only) window has zero variance too — same guard.
    const std::vector<float> dc((size_t)N, 0.7f);
    const float dcX = normalizedCrossCorrelation(dc.data(), x.data(), N);
    CHECK(finite(dcX) && dcX == 0.0f, "NCC(constant, x) should be 0, got " << dcX);

    // Degenerate lengths.
    CHECK(normalizedCrossCorrelation(x.data(), x.data(), 0) == 0.0f, "NCC(N=0) should be 0");
}

// ── bestCorrelationLag ───────────────────────────────────────────────────────
static void testBestCorrelationLag()
{
    std::cout << "bestCorrelationLag\n";

    // Embed the reference at a known offset in a noise buffer.
    const int searchN = 4096;
    const int refN    = 256;
    const int offset  = 1337;
    const auto search = makeNoise(searchN, 4242u);
    std::vector<float> ref(search.begin() + offset, search.begin() + offset + refN);

    const auto peak = bestCorrelationLag(ref.data(), refN, search.data(), searchN,
                                         0, searchN - refN);
    CHECK(peak.lag == offset, "embedded ref should be found at lag " << offset
                                << ", got " << peak.lag);
    CHECK(std::abs(peak.ncc - 1.0f) < 1e-5f,
          "embedded ref should score NCC 1, got " << peak.ncc);

    // The search range must be honoured: exclude the true offset and the result
    // must land inside the bounds with a clearly worse score.
    const auto narrowed = bestCorrelationLag(ref.data(), refN, search.data(), searchN,
                                             0, offset - 1);
    CHECK(narrowed.lag >= 0 && narrowed.lag <= offset - 1,
          "lag should stay within [0, " << offset - 1 << "], got " << narrowed.lag);
    CHECK(narrowed.ncc < 0.5f, "off-peak NCC should be low, got " << narrowed.ncc);

    // Period alignment on a pure sine: 480 Hz at 48 kHz is exactly 100 samples.
    // Starting at lag 1 excludes the trivial zero-lag self-match.
    const int    T     = 100;
    const double freq  = kSR / T;
    const auto   sine  = makeSine(searchN, freq, kSR);
    const int    sRefN = 512;
    std::vector<float> sineRef(sine.begin(), sine.begin() + sRefN);

    const auto sinePeak = bestCorrelationLag(sineRef.data(), sRefN, sine.data(), searchN,
                                             1, 1024);
    CHECK(sinePeak.lag == T, "sine should align at its period " << T
                               << ", got " << sinePeak.lag);
    CHECK(std::abs(sinePeak.ncc - 1.0f) < 1e-4f,
          "period-aligned sine should score NCC 1, got " << sinePeak.ncc);

    // 2T is an equally valid alignment — the primitive returns the smallest such
    // lag, but the score there must be just as high.
    const float nccAt2T = normalizedCrossCorrelation(sineRef.data(), sine.data() + 2 * T, sRefN);
    CHECK(std::abs(nccAt2T - 1.0f) < 1e-4f, "sine at 2T should also score ~1, got " << nccAt2T);

    // Half a period out of phase is full inversion.
    const float nccAtHalfT = normalizedCrossCorrelation(sineRef.data(), sine.data() + T / 2, sRefN);
    CHECK(nccAtHalfT < -0.9f, "sine at T/2 should be anti-correlated, got " << nccAtHalfT);

    // Guards: empty/degenerate ranges return {0, 0} rather than reading OOB.
    const auto empty = bestCorrelationLag(ref.data(), refN, search.data(), searchN, 500, 400);
    CHECK(empty.lag == 0 && empty.ncc == 0.0f, "inverted lag range should return {0, 0}");

    const auto tooLong = bestCorrelationLag(ref.data(), searchN + 10, search.data(), searchN, 0, 10);
    CHECK(tooLong.lag == 0 && tooLong.ncc == 0.0f, "ref longer than search should return {0, 0}");

    const auto zeroRef = bestCorrelationLag(ref.data(), 0, search.data(), searchN, 0, 10);
    CHECK(zeroRef.lag == 0 && zeroRef.ncc == 0.0f, "refN=0 should return {0, 0}");

    // Silent search: every lag scores 0, and nothing is NaN.
    const std::vector<float> zeros((size_t)searchN, 0.0f);
    const auto silent = bestCorrelationLag(ref.data(), refN, zeros.data(), searchN, 0, 100);
    CHECK(finite(silent.ncc) && silent.ncc == 0.0f,
          "silent search should score 0, got " << silent.ncc);
}

// ── spectralDistance ─────────────────────────────────────────────────────────
static void testSpectralDistance()
{
    std::cout << "spectralDistance\n";
    const int N = 1024;

    // Identical windows have identical spectra.
    const auto a = makeSine(N, 440.0, kSR);
    const float self = spectralDistance(a.data(), a.data(), N);
    CHECK(std::abs(self) < 1e-4f, "spectralDistance(x, x) should be 0, got " << self);

    const auto noise = makeNoise(N, 77u);
    const float selfNoise = spectralDistance(noise.data(), noise.data(), N);
    CHECK(std::abs(selfNoise) < 1e-4f,
          "spectralDistance(noise, noise) should be 0, got " << selfNoise);

    // Two different tones — 440 Hz vs 1760 Hz (2 octaves apart) share no peaks.
    // This is the case that a cosine/Pearson metric gets wrong: the shared log
    // floor makes these two look ~0.84 correlated. Under L2 they separate.
    const auto b = makeSine(N, 1760.0, kSR);
    const float diff = spectralDistance(a.data(), b.data(), N);
    CHECK(diff > 1.0f, "spectralDistance(sine_f1, sine_f2) should be large, got " << diff);
    CHECK(diff > 100.0f * self, "different tones must rank far above identical ones");
    CHECK(diff >= 0.0f && finite(diff), "spectralDistance should be finite and >= 0");

    // Level invariance: a gain change is a constant log-magnitude offset and must
    // cancel under mean-removal, keeping this term orthogonal to the RMS energy term.
    std::vector<float> quiet((size_t)N);
    for (int i = 0; i < N; ++i) quiet[(size_t)i] = 0.1f * a[(size_t)i];
    const float gainDist = spectralDistance(a.data(), quiet.data(), N);
    CHECK(gainDist < 0.05f, "spectralDistance should be gain-invariant, got " << gainDist);
    CHECK(gainDist < diff * 0.1f, "a gain change must rank far below a real timbre change");

    // Same tone, different phase — a magnitude comparison ignores phase.
    const auto aShifted = makeSine(N, 440.0, kSR, juce::MathConstants<double>::pi * 0.5);
    const float phaseDist = spectralDistance(a.data(), aShifted.data(), N);
    CHECK(phaseDist < diff * 0.25f,
          "magnitude spectra should be near phase-blind, got " << phaseDist);

    // Documented silence behaviour — falls out of the centring, no special case.
    const std::vector<float> zeros((size_t)N, 0.0f);
    const float bothSilent = spectralDistance(zeros.data(), zeros.data(), N);
    CHECK(finite(bothSilent) && bothSilent == 0.0f,
          "spectralDistance(silence, silence) should be 0, got " << bothSilent);

    // Silence centres to the zero vector, so this reduces to the sounding
    // window's own centred log-spectrum spread: large versus an identical pair,
    // but by construction below two tones that each have that spread at
    // *different* bins (those add in quadrature). Ordering matters more than the
    // absolute value, so assert the ordering.
    const float oneSilent = spectralDistance(a.data(), zeros.data(), N);
    CHECK(finite(oneSilent) && oneSilent > 0.5f,
          "spectralDistance(x, silence) should be large, got " << oneSilent);
    CHECK(oneSilent > 100.0f * self, "sound-vs-silence must rank far above identical windows");
    CHECK(oneSilent < diff, "sound-vs-silence should sit below two distinct tones, got "
                              << oneSilent << " vs " << diff);

    // Non-power-of-two N must work via internal zero-padding.
    const int oddN = 1000;
    const auto oddA = makeSine(oddN, 440.0, kSR);
    const auto oddB = makeSine(oddN, 1760.0, kSR);
    const float oddSelf = spectralDistance(oddA.data(), oddA.data(), oddN);
    const float oddDiff = spectralDistance(oddA.data(), oddB.data(), oddN);
    CHECK(finite(oddSelf) && std::abs(oddSelf) < 1e-4f,
          "non-power-of-two self-distance should be 0, got " << oddSelf);
    CHECK(finite(oddDiff) && oddDiff > 1.0f,
          "non-power-of-two tone distance should be large, got " << oddDiff);

    // Degenerate lengths.
    CHECK(spectralDistance(a.data(), a.data(), 0) == 0.0f, "spectralDistance(N=0) should be 0");
    CHECK(spectralDistance(a.data(), a.data(), 1) == 0.0f, "spectralDistance(N=1) should be 0");
}

// ── computeRMS composition (energy-continuity term) ──────────────────────────
// Not a new primitive: this pins the composition the cost function will use, so
// the "no redundant RMS-continuity function" decision stays covered by a test.
static void testRMSContinuity()
{
    std::cout << "computeRMS continuity composition\n";
    const int N = 1024;
    const auto loud = makeSine(N, 440.0, kSR);
    std::vector<float> quiet((size_t)N);
    for (int i = 0; i < N; ++i) quiet[(size_t)i] = 0.5f * loud[(size_t)i];

    // A full-scale sine has RMS 1/sqrt(2). The window spans 9.4 periods, not a
    // whole number, so the partial final period leaves a few 1e-3 of error —
    // hence the loose bound rather than an exact-value assertion.
    const float rmsLoud = computeRMS(loud.data(), N);
    CHECK(std::abs(rmsLoud - 0.70710678f) < 1e-2f,
          "sine RMS should be ~1/sqrt(2), got " << rmsLoud);

    const float continuitySelf = std::abs(rmsLoud - computeRMS(loud.data(), N));
    CHECK(continuitySelf == 0.0f, "matched windows should have zero energy discontinuity");

    const float continuityHalf = std::abs(rmsLoud - computeRMS(quiet.data(), N));
    CHECK(std::abs(continuityHalf - 0.5f * rmsLoud) < 1e-3f,
          "half-gain window should differ by half the RMS, got " << continuityHalf);
}

int main()
{
    std::cout << "=== test_loop_analysis ===\n";
    testNCC();
    testBestCorrelationLag();
    testSpectralDistance();
    testRMSContinuity();

    std::cout << "\n" << g_passed << " passed, " << g_failed << " failed\n";
    if (g_failed > 0) {
        std::cerr << "FAILED: " << g_failed << " check(s)\n";
        return 1;
    }
    std::cout << "ALL TESTS PASSED\n";
    return 0;
}
