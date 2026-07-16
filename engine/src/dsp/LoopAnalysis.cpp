#include "dsp/LoopAnalysis.h"

#include <algorithm>
#include <cmath>
#include <limits>

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

} // namespace xleth::dsp
