#include "dsp/LoopAnalysis.h"

#include <juce_dsp/juce_dsp.h>

#include <algorithm>
#include <cmath>
#include <limits>
#include <vector>

namespace xleth::dsp {

// NSDF[tau] = 2 * Σ x[n]*x[n+tau] / (Σ x[n]² + Σ x[n+tau]²), tau∈[tauMin,tauMax]
std::vector<float> computeNSDF(const float* x, int N, int tauMin, int tauMax)
{
    tauMax = std::min(tauMax, N - 1);
    if (tauMin > tauMax || N <= 0) return {};

    // Prefix sum of x² for O(1) denominator per tau
    std::vector<double> cumX2(N + 1, 0.0);
    for (int i = 0; i < N; ++i)
        cumX2[i + 1] = cumX2[i] + (double)x[i] * x[i];

    int len = tauMax - tauMin + 1;
    std::vector<float> nsdf(len, 0.0f);

    for (int i = 0; i < len; ++i) {
        int    tau = tauMin + i;
        int    W   = N - tau;
        double denom = cumX2[W] + (cumX2[N] - cumX2[tau]);  // sumXX + sumYY
        if (denom < 1e-12) { nsdf[i] = 0.0f; continue; }
        double num = 0.0;
        for (int n = 0; n < W; ++n)
            num += (double)x[n] * x[n + tau];
        nsdf[i] = (float)(2.0 * num / denom);
    }
    return nsdf;
}

// Returns the lag of the first key maximum (>= threshold), or 0 if unvoiced.
int detectPeriod(const std::vector<float>& nsdf, int tauMin, float threshold)
{
    if (nsdf.empty()) return 0;
    float globalMax = *std::max_element(nsdf.begin(), nsdf.end());
    if (globalMax < threshold) return 0;
    float keyThr = std::max(threshold, 0.8f * globalMax);
    for (int i = 1; i + 1 < (int)nsdf.size(); ++i) {
        float v = nsdf[i];
        if (v >= keyThr && v >= nsdf[i - 1] && v >= nsdf[i + 1])
            return tauMin + i;
    }
    return 0;
}

// Snap 'center' to the nearest positive zero-crossing within ±10% of t0.
int snapZeroCrossing(const float* x, int N, int center, int t0)
{
    int jitter = std::max(1, t0 / 10);
    int lo = std::max(1, center - jitter);
    int hi = std::min(N - 1, center + jitter);
    int best = center, bestDist = std::numeric_limits<int>::max();
    for (int i = lo; i <= hi; ++i) {
        if (x[i - 1] < 0.0f && x[i] >= 0.0f) {
            int d = std::abs(i - center);
            if (d < bestDist) { bestDist = d; best = i; }
        }
    }
    return best;
}

float computeRMS(const float* x, int N)
{
    if (N <= 0) return 0.0f;
    double s = 0.0;
    for (int i = 0; i < N; ++i) s += (double)x[i] * x[i];
    return (float)std::sqrt(s / N);
}

// ─── Seam-similarity primitives ──────────────────────────────────────────────

namespace {

// Variance floor below which a window counts as constant/silent. Sums are
// accumulated in double, so this sits far above the accumulation noise while
// still admitting genuinely quiet-but-varying material.
constexpr double kVarianceFloor = 1e-20;

// Log-magnitude floor, applied relative to each spectrum's own peak bin: -80 dB
// below peak. Relative rather than absolute so that scaling a window by a gain g
// scales peak and floor together, leaving every log-magnitude shifted by exactly
// log(g) — which mean-removal then cancels. An absolute floor would pin the
// quiet bins while the rest moved, making the offset non-uniform and destroying
// the level-invariance spectralDistance depends on. -80 dB also discards the
// numerical-noise region below it, which carries no timbral information.
constexpr float kRelMagFloor = 1e-4f;

// Absolute backstop for the relative floor, so an all-zero (silent) window,
// whose peak is 0, still produces finite log-magnitudes instead of -Inf.
constexpr float kAbsMagFloor = 1e-8f;

// r = Σ (a-ā)(b-b̄) / sqrt(Σ (a-ā)² · Σ (b-b̄)²), or 0 if either side is flat.
double pearson(const float* a, const float* b, int N)
{
    if (N <= 0) return 0.0;

    double meanA = 0.0, meanB = 0.0;
    for (int i = 0; i < N; ++i) { meanA += a[i]; meanB += b[i]; }
    meanA /= N;
    meanB /= N;

    double num = 0.0, varA = 0.0, varB = 0.0;
    for (int i = 0; i < N; ++i) {
        const double da = a[i] - meanA;
        const double db = b[i] - meanB;
        num  += da * db;
        varA += da * da;
        varB += db * db;
    }

    // A zero-variance window has no shape to correlate against: silence and
    // constants are defined to be uncorrelated with everything, not NaN.
    if (varA < kVarianceFloor || varB < kVarianceFloor) return 0.0;

    const double r = num / std::sqrt(varA * varB);
    // Rounding can push an exact ±1 a hair outside the range; pin it.
    return std::clamp(r, -1.0, 1.0);
}

// Hann-windows x into a zero-padded 2*fftSize interleaved buffer, forward-FFTs
// it, and writes fftSize/2+1 log-magnitudes into out.
void logMagnitudeSpectrum(const float* x, int N, juce::dsp::FFT& fft,
                          int fftSize, std::vector<float>& out)
{
    std::vector<float> buf(2 * (size_t)fftSize, 0.0f);
    const float twoPi = 2.0f * juce::MathConstants<float>::pi;
    for (int n = 0; n < N; ++n) {
        const float w = 0.5f * (1.0f - std::cos(twoPi * n / (float)(N - 1)));
        buf[n] = x[n] * w;
    }

    // After this: buf[2k], buf[2k+1] = re(k), im(k).
    fft.performRealOnlyForwardTransform(buf.data(), false);

    const int numBins = fftSize / 2 + 1;
    out.resize((size_t)numBins);
    for (int k = 0; k < numBins; ++k) {
        const float re = buf[2 * (size_t)k];
        const float im = buf[2 * (size_t)k + 1];
        out[(size_t)k] = std::sqrt(re * re + im * im);
    }

    const float peak  = *std::max_element(out.begin(), out.end());
    const float floor = std::max(peak * kRelMagFloor, kAbsMagFloor);
    for (int k = 0; k < numBins; ++k)
        out[(size_t)k] = std::log(std::max(out[(size_t)k], floor));
}

} // namespace

float normalizedCrossCorrelation(const float* a, const float* b, int N)
{
    return (float)pearson(a, b, N);
}

CorrPeak bestCorrelationLag(const float* ref, int refN,
                            const float* search, int searchN,
                            int lagMin, int lagMax)
{
    if (refN <= 0 || searchN <= 0) return {0, 0.0f};

    // Keep the whole ref window inside the search buffer at every lag tried.
    const int lo = std::max(0, lagMin);
    const int hi = std::min(lagMax, searchN - refN);
    if (lo > hi) return {0, 0.0f};

    CorrPeak best{lo, -std::numeric_limits<float>::infinity()};
    for (int lag = lo; lag <= hi; ++lag) {
        const float ncc = normalizedCrossCorrelation(ref, search + lag, refN);
        if (ncc > best.ncc) { best.lag = lag; best.ncc = ncc; }  // strict: ties → smallest lag
    }

    // Every lag scored 0 (silent/constant window) leaves the sentinel unbeaten
    // only if refN made all lags degenerate; normalise it away regardless.
    if (!std::isfinite(best.ncc)) best.ncc = 0.0f;
    return best;
}

float spectralDistance(const float* a, const float* b, int N)
{
    if (N < 2) return 0.0f;

    // Zero-pad to the next power of two: juce::dsp::FFT takes an order, and the
    // caller's window length is not required to be one.
    int order = 1;
    while ((1 << order) < N) ++order;
    const int fftSize = 1 << order;

    juce::dsp::FFT     fft(order);
    std::vector<float> logMagA, logMagB;
    logMagnitudeSpectrum(a, N, fft, fftSize, logMagA);
    logMagnitudeSpectrum(b, N, fft, fftSize, logMagB);

    const int numBins = (int)logMagA.size();

    // Centre each log-spectrum on its own mean, then take the RMS difference.
    // Centring is what makes this level-invariant: a gain change is a constant
    // offset in log-magnitude, so it moves the mean by the same amount and
    // cancels. It also makes silence self-handling — a silent window's spectrum
    // is flat at the log floor, so centring collapses it to the zero vector.
    double meanA = 0.0, meanB = 0.0;
    for (int k = 0; k < numBins; ++k) { meanA += logMagA[(size_t)k]; meanB += logMagB[(size_t)k]; }
    meanA /= numBins;
    meanB /= numBins;

    double sumSq = 0.0;
    for (int k = 0; k < numBins; ++k) {
        const double d = (logMagA[(size_t)k] - meanA) - (logMagB[(size_t)k] - meanB);
        sumSq += d * d;
    }
    return (float)std::sqrt(sumSq / numBins);
}

} // namespace xleth::dsp
