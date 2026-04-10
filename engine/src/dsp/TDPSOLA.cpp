#include "dsp/TDPSOLA.h"
#include "XlethDebug.h"

#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstdio>
#include <cstring>
#include <limits>
#include <vector>

namespace {

static constexpr int    kHop        = 512;
static constexpr int    kFrame      = 2048;
static constexpr int    kLpcOrder   = 20;
static constexpr double kPi         = 3.14159265358979323846;
static constexpr float  kSilenceRMS = 1.0e-3f;  // ≈ -60 dB
static constexpr double kMinDurSec  = 0.05;     // 50 ms

// ─── NSDF pitch detection ─────────────────────────────────────────────────────

// NSDF[tau] = 2 * Σ x[n]*x[n+tau] / (Σ x[n]² + Σ x[n+tau]²), tau∈[tauMin,tauMax]
static std::vector<float> computeNSDF(
    const float* x, int N, int tauMin, int tauMax)
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
static int detectPeriod(const std::vector<float>& nsdf, int tauMin,
                        float threshold = 0.5f)
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

// One T0 estimate per analysis hop; unvoiced gaps filled; 5-point median applied.
static std::vector<int> detectAllPeriods(const float* x, int N, double sampleRate)
{
    const int tauMin = std::max(1, (int)(sampleRate / 500.0));
    const int tauMax = (int)(sampleRate / 75.0);

    int numFrames = (N + kHop - 1) / kHop;
    std::vector<int> raw(numFrames, 0);

    for (int f = 0; f < numFrames; ++f) {
        int start     = f * kHop;
        int available = std::min(kFrame, N - start);
        std::vector<float> frame(kFrame, 0.0f);
        std::copy(x + start, x + start + available, frame.begin());
        auto nsdf = computeNSDF(frame.data(), kFrame, tauMin, tauMax);
        raw[f] = detectPeriod(nsdf, tauMin);
    }

    // Forward pass: propagate last voiced estimate forward
    { int last = 0; for (auto& v : raw) { if (v > 0) last = v; else v = last; } }
    // Backward pass: fill leading unvoiced frames with a sane default
    { int next = std::max(1, (int)(sampleRate / 200.0));
      for (int i = (int)raw.size() - 1; i >= 0; --i)
          if (raw[i] > 0) next = raw[i]; else raw[i] = next; }

    // 5-point median filter
    if ((int)raw.size() >= 5) {
        std::vector<int> filt = raw;
        for (int i = 2; i + 2 < (int)raw.size(); ++i) {
            int v[5] = { raw[i-2], raw[i-1], raw[i], raw[i+1], raw[i+2] };
            std::sort(std::begin(v), std::end(v));
            filt[i] = v[2];
        }
        return filt;
    }
    return raw;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

static int periodAt(const std::vector<int>& periods, int pos, int N)
{
    if (periods.empty()) return std::max(1, N / 10);
    int frame = std::max(0, std::min(pos / kHop, (int)periods.size() - 1));
    return std::max(1, periods[frame]);
}

// Snap 'center' to the nearest positive zero-crossing within ±10% of t0.
static int snapZeroCrossing(const float* x, int N, int center, int t0)
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

// Place analysis pitch marks by advancing at T0 intervals and snapping to
// positive zero-crossings.
static std::vector<int> placeMarks(const float* x, int N,
                                   const std::vector<int>& periods)
{
    std::vector<int> marks;
    if (N <= 0) return marks;
    int t0  = periodAt(periods, 0, N);
    int pos = t0;
    while (pos < N) {
        pos = snapZeroCrossing(x, N, pos, t0);
        marks.push_back(pos);
        t0  = periodAt(periods, pos, N);
        pos += t0;
    }
    return marks;
}

static std::vector<float> linearResample(const float* x, int N, int outN)
{
    std::vector<float> out(outN, 0.0f);
    if (N <= 0 || outN <= 0) return out;
    if (outN == 1) { out[0] = x[0]; return out; }
    double scale = (double)(N - 1) / (double)(outN - 1);
    for (int i = 0; i < outN; ++i) {
        double sp  = i * scale;
        int    si  = (int)sp;
        float  fr  = (float)(sp - si);
        float  va  = (si < N)     ? x[si]     : 0.0f;
        float  vb  = (si + 1 < N) ? x[si + 1] : 0.0f;
        out[i] = va + fr * (vb - va);
    }
    return out;
}

static float computeRMS(const float* x, int N)
{
    if (N <= 0) return 0.0f;
    double s = 0.0;
    for (int i = 0; i < N; ++i) s += (double)x[i] * x[i];
    return (float)std::sqrt(s / N);
}

// ─── LPC via Levinson-Durbin (order p) ───────────────────────────────────────
// Returns [1, a1, a2, ..., ap] such that e[n] = Σ a[k]*x[n-k] (analysis filter).

static std::vector<float> computeLPC(const float* x, int N, int order)
{
    std::vector<float> identity(order + 1, 0.0f);
    identity[0] = 1.0f;

    std::vector<double> R(order + 1, 0.0);
    for (int lag = 0; lag <= order; ++lag) {
        double s = 0.0;
        for (int n = 0; n < N - lag; ++n) s += (double)x[n] * x[n + lag];
        R[lag] = s;
    }
    if (R[0] < 1e-10) return identity;

    std::vector<double> a(order + 1, 0.0), aPrev(order + 1, 0.0);
    double E = R[0];
    for (int m = 1; m <= order && E > 0.0; ++m) {
        double num = R[m];
        for (int j = 1; j < m; ++j) num += aPrev[j] * R[m - j];
        double km = std::max(-0.999, std::min(0.999, -num / E));
        for (int j = 1; j < m; ++j) a[j] = aPrev[j] + km * aPrev[m - j];
        a[m] = km;
        E *= (1.0 - km * km);
        aPrev = a;
    }
    std::vector<float> res(order + 1);
    res[0] = 1.0f;
    for (int i = 1; i <= order; ++i) res[i] = (float)a[i];
    return res;
}

// FIR analysis (whitening): y[n] = Σ a[k]*x[n-k]
static std::vector<float> applyFIR(const std::vector<float>& x,
                                   const std::vector<float>& a)
{
    int N = (int)x.size(), p = (int)a.size() - 1;
    std::vector<float> y(N, 0.0f);
    for (int n = 0; n < N; ++n) {
        double s = (double)a[0] * x[n];
        for (int k = 1; k <= p; ++k)
            if (n - k >= 0) s += (double)a[k] * x[n - k];
        y[n] = (float)s;
    }
    return y;
}

// IIR synthesis (coloring): y[n] = x[n] - Σ_{k=1}^{p} a[k]*y[n-k]
static std::vector<float> applyIIR(const std::vector<float>& x,
                                   const std::vector<float>& a)
{
    int N = (int)x.size(), p = (int)a.size() - 1;
    std::vector<float> y(N, 0.0f);
    for (int n = 0; n < N; ++n) {
        double s = x[n];
        for (int k = 1; k <= p; ++k)
            if (n - k >= 0) s -= (double)a[k] * y[n - k];
        y[n] = (float)s;
    }
    return y;
}

// ─── OLA synthesis ────────────────────────────────────────────────────────────
//
// Synthesis hop (output): T0_synth = T0_in / pitchFactor
// Analysis advance per mark: dt_in = T0_synth / stretchRatio
//
// For each synthesis mark at t_out:
//  1. Find nearest analysis pitch mark to t_in in input.
//  2. Extract raw grain [mark-T0 .. mark+T0), resample to [2*T0_synth] samples.
//  3. Apply periodic Hann window: w[i] = 0.5*(1-cos(2π*i / outGrainSize)).
//  4. OLA-accumulate into output; track Hann weight sum for normalization.

static std::vector<float> olaChannel(
    const float* x, int N, int outN,
    const std::vector<int>& marks,
    const std::vector<int>& periods,
    double pitchFactor,
    double stretchRatio)
{
    std::vector<float> output(outN, 0.0f);
    std::vector<float> wsum  (outN, 0.0f);
    if (outN <= 0 || N <= 0) return output;

    double t_in  = 0.0;
    int    t_out = 0;

    while (t_out < outN) {
        int posClamped = std::max(0, std::min((int)t_in, N - 1));
        int t0 = periodAt(periods, posClamped, N);

        double t0s  = (double)t0 / pitchFactor;
        int    t0si = std::max(1, std::min(4096, (int)std::round(t0s)));

        // Nearest analysis mark to t_in
        int ti   = std::max(0, std::min((int)std::round(t_in), N - 1));
        int mark = ti;
        if (!marks.empty()) {
            auto it = std::lower_bound(marks.begin(), marks.end(), ti);
            if (it == marks.end()) {
                mark = marks.back();
            } else if (it == marks.begin()) {
                mark = marks.front();
            } else {
                auto prev = std::prev(it);
                mark = (std::abs(*it - ti) <= std::abs(*prev - ti)) ? *it : *prev;
            }
        }

        // Extract raw grain of size 2*t0 centered at mark (zero-pad at boundaries)
        int grainSize = 2 * t0;
        std::vector<float> grain(grainSize, 0.0f);
        for (int i = 0; i < grainSize; ++i) {
            int idx = mark - t0 + i;
            if (idx >= 0 && idx < N) grain[i] = x[idx];
        }

        // Resample grain to output grain size 2*t0si
        int outGrainSize = 2 * t0si;
        std::vector<float> outGrain(outGrainSize, 0.0f);
        if (grainSize == outGrainSize) {
            outGrain = grain;
        } else if (grainSize == 1) {
            std::fill(outGrain.begin(), outGrain.end(), grain[0]);
        } else {
            double scale = (double)(grainSize - 1) / (double)(outGrainSize - 1);
            for (int i = 0; i < outGrainSize; ++i) {
                double sp = i * scale;
                int    si = (int)sp;
                float  fr = (float)(sp - si);
                float  va = (si < grainSize)     ? grain[si]     : 0.0f;
                float  vb = (si + 1 < grainSize) ? grain[si + 1] : 0.0f;
                outGrain[i] = va + fr * (vb - va);
            }
        }

        // Apply periodic Hann + OLA accumulate
        int startOut = t_out - t0si;
        for (int i = 0; i < outGrainSize; ++i) {
            float w  = 0.5f * (1.0f - (float)std::cos(2.0 * kPi * i / outGrainSize));
            int   oi = startOut + i;
            if (oi >= 0 && oi < outN) {
                output[oi] += outGrain[i] * w;
                wsum  [oi] += w;
            }
        }

        t_out += t0si;
        t_in  += t0s / stretchRatio;
    }

    // Normalize by accumulated Hann weights
    for (int i = 0; i < outN; ++i)
        if (wsum[i] > 1.0e-6f) output[i] /= wsum[i];

    return output;
}

} // anonymous namespace

// ─── Public API ───────────────────────────────────────────────────────────────

namespace xleth::dsp {

juce::AudioBuffer<float> processTDPSOLA(
    const juce::AudioBuffer<float>& input,
    const PSOLAParams& params)
{
    const int N     = input.getNumSamples();
    const int numCh = input.getNumChannels();
    if (N == 0 || numCh == 0) return juce::AudioBuffer<float>();

    const double pitchFactor = std::max(0.1, std::min(10.0,
        std::pow(2.0, (params.pitchOffsetSemis * 100.0
                       + params.pitchOffsetCents) / 1200.0)));

    // Near-identity early exit — avoid unnecessary work
    if (std::abs(pitchFactor - 1.0) < 0.001
        && std::abs(params.stretchRatio - 1.0) < 0.001
        && !params.formantPreserve)
    {
#ifdef XLETH_DEBUG
        fprintf(stderr, "[TDPSOLA] skip: near-identity params, returning copy\n");
#endif
        juce::AudioBuffer<float> out(numCh, N);
        for (int ch = 0; ch < numCh; ++ch)
            out.copyFrom(ch, 0, input, ch, 0, N);
        return out;
    }

    const double sratio = std::max(0.1, params.stretchRatio);
    const int    outN   = std::max(1, (int)std::round(N * sratio));
    const int    minN   = std::max(1, (int)std::round(params.sampleRate * kMinDurSec));

#ifdef XLETH_DEBUG
    fprintf(stderr, "[TDPSOLA] input: %d samples, pitch=%.2f st, stretch=%.3f, formant=%d\n",
            N, params.pitchOffsetSemis + params.pitchOffsetCents / 100.0,
            params.stretchRatio, (int)params.formantPreserve);
    const auto tdpsolaStart = std::chrono::steady_clock::now();
#endif

    // Short signal (<50 ms) — fall back to linear interpolation
    if (N < minN) {
#ifdef XLETH_DEBUG
        fprintf(stderr, "[TDPSOLA] fallback: input too short (%d samples < %d), using linear interpolation\n",
                N, minN);
#endif
        juce::AudioBuffer<float> out(numCh, outN);
        for (int ch = 0; ch < numCh; ++ch) {
            auto v = linearResample(input.getReadPointer(ch), N, outN);
            std::copy(v.begin(), v.end(), out.getWritePointer(ch));
        }
        return out;
    }

    juce::AudioBuffer<float> out(numCh, outN);
    out.clear();

    for (int ch = 0; ch < numCh; ++ch) {
        const float* inPtr = input.getReadPointer(ch);

        // Silence — leave channel as zeros
        if (computeRMS(inPtr, N) < kSilenceRMS) continue;

        std::vector<float> working(inPtr, inPtr + N);

        // ── LP-PSOLA formant preservation: whiten before pitch processing ────
        std::vector<float> lpc;
        if (params.formantPreserve) {
            lpc     = computeLPC(working.data(), N, kLpcOrder);
            working = applyFIR(working, lpc);
        }

        // ── Pitch detection ───────────────────────────────────────────────────
        auto periods = detectAllPeriods(working.data(), N, params.sampleRate);
        auto marks   = placeMarks(working.data(), N, periods);

        // ── OLA synthesis ─────────────────────────────────────────────────────
        auto result = olaChannel(working.data(), N, outN, marks, periods,
                                 pitchFactor, sratio);

        // ── Re-color (restore formant envelope) ───────────────────────────────
        if (params.formantPreserve && !lpc.empty())
            result = applyIIR(result, lpc);

        const int copyN = std::min((int)result.size(), outN);
        std::copy(result.begin(), result.begin() + copyN, out.getWritePointer(ch));
    }

#ifdef XLETH_DEBUG
    {
        const auto ms = std::chrono::duration_cast<std::chrono::milliseconds>(
            std::chrono::steady_clock::now() - tdpsolaStart).count();
        fprintf(stderr, "[TDPSOLA] output: %d samples in %lldms\n", outN, (long long)ms);
    }
#endif

    return out;
}

} // namespace xleth::dsp
