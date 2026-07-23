#include "dsp/AutoLoopPolicy.h"
#include "dsp/LoopAnalysis.h"
#include "dsp/LoopOptimizer.h"  // kMinPitchHz / kMaxPitchHz / kAnalysisFrame / kAnalysisHop

#include <juce_dsp/juce_dsp.h>

#include <algorithm>
#include <cmath>
#include <complex>
#include <limits>
#include <numeric>

namespace xleth::dsp {

namespace {

constexpr double kEps = 1e-12;
constexpr double kNaN = std::numeric_limits<double>::quiet_NaN();
constexpr double kPi  = 3.14159265358979323846;

// ── Small numeric helpers matching numpy semantics ───────────────────────────

// np.median: average the two central elements for an even count. The period
// estimates this operates on are floats, so — unlike LoopOptimizer's integer
// medianOf — the averaging matters for lining up with the Python reference.
double npMedian(std::vector<double> v)
{
    if (v.empty()) return kNaN;
    std::sort(v.begin(), v.end());
    const size_t n = v.size();
    if (n % 2 == 1) return v[n / 2];
    return 0.5 * (v[n / 2 - 1] + v[n / 2]);
}

// np.quantile default ('linear') on an already-sorted array.
double npQuantileSorted(const std::vector<double>& s, double q)
{
    if (s.empty()) return kNaN;
    if (s.size() == 1) return s[0];
    const double pos = q * (double)(s.size() - 1);
    const double lo = std::floor(pos);
    const size_t i = (size_t)lo;
    const double frac = pos - lo;
    if (i + 1 >= s.size()) return s.back();
    return s[i] + frac * (s[i + 1] - s[i]);
}

// searchsorted(a, v, 'left'/'right') on an ascending int64 array.
int searchsortedLeft(const std::vector<int64_t>& a, int64_t v)
{
    return (int)(std::lower_bound(a.begin(), a.end(), v) - a.begin());
}
int searchsortedRight(const std::vector<int64_t>& a, int64_t v)
{
    return (int)(std::upper_bound(a.begin(), a.end(), v) - a.begin());
}

double hzToCents(double hz) { return 1200.0 * std::log2(std::max(hz, kEps)); }

// ── NSDF period, sub-sample refined ──────────────────────────────────────────
// Parabolic interpolation of the NSDF maximum at the detected lag. YIN (the
// Python reference) refines the CMND minimum to sub-sample precision; the engine
// uses NSDF, so we refine its peak instead. The refinement is what keeps the two
// f0 estimates within tolerance across many period multiples (a half-sample bias
// at T=90 is already ~10 cents, and it compounds with k) — see the NSDF-vs-YIN
// validation the task requires.
double refinePeriod(const std::vector<float>& nsdf, int tauMin, int lag)
{
    const int i = lag - tauMin;
    if (i <= 0 || i + 1 >= (int)nsdf.size()) return (double)lag;
    const double a = nsdf[(size_t)i - 1], b = nsdf[(size_t)i], c = nsdf[(size_t)i + 1];
    const double denom = a - 2.0 * b + c;
    if (std::abs(denom) < 1e-18) return (double)lag;
    return (double)lag + 0.5 * (a - c) / denom;
}

// The NSDF of one frame, computed with an FFT autocorrelation instead of the
// O(frame*lags) direct sum in LoopAnalysis::computeNSDF. Mathematically identical
// — the numerator Sum x[n]x[n+tau] IS the linear autocorrelation, so an
// FFT power-spectrum round-trip gives it for every tau at once — but O(frame*log)
// per hop rather than O(frame*lags). This is a perf specialisation of the shared
// primitive, NOT a different detector: `detectPeriod` (the actual key-max pick)
// is still the shared one, and the float FFT's ~1e-6 error cannot move an integer
// lag whose peaks are separated by far more. (Validated: period matches the
// direct computeNSDF to well under the NSDF-vs-YIN gap.)
std::vector<float> nsdfFft(const float* x, int N, int tauMin, int tauMax, juce::dsp::FFT& fft,
                           int order, std::vector<float>& scratch)
{
    tauMax = std::min(tauMax, N - 1);
    if (tauMin > tauMax || N <= 0) return {};

    std::vector<double> cumX2((size_t)N + 1, 0.0);
    for (int i = 0; i < N; ++i) cumX2[(size_t)i + 1] = cumX2[(size_t)i] + (double)x[i] * x[i];

    const int M = 1 << order;
    std::fill(scratch.begin(), scratch.end(), 0.0f);
    for (int i = 0; i < N; ++i) scratch[(size_t)i] = x[i];
    fft.performRealOnlyForwardTransform(scratch.data(), false);
    for (int k = 0; k < M; ++k) {
        const float re = scratch[2 * (size_t)k], im = scratch[2 * (size_t)k + 1];
        scratch[2 * (size_t)k] = re * re + im * im;
        scratch[2 * (size_t)k + 1] = 0.0f;
    }
    fft.performRealOnlyInverseTransform(scratch.data());  // scratch[tau] == Sum x[n]x[n+tau]

    const int len = tauMax - tauMin + 1;
    std::vector<float> nsdf((size_t)len, 0.0f);
    for (int i = 0; i < len; ++i) {
        const int tau = tauMin + i, W = N - tau;
        const double denom = cumX2[(size_t)W] + (cumX2[(size_t)N] - cumX2[(size_t)tau]);
        if (denom >= 1e-12) nsdf[(size_t)i] = (float)(2.0 * scratch[(size_t)tau] / denom);
    }
    return nsdf;
}

struct HopPeriods {
    std::vector<int64_t> positions;  // hop start samples
    std::vector<double>  periods;    // sub-sample period, 0.0 == unvoiced
};

HopPeriods measureHops(const float* x, int N, double sampleRate)
{
    HopPeriods h;
    if (x == nullptr || N < kAnalysisFrame || sampleRate <= 0.0) return h;

    const int tauMin = std::max(1, (int)(sampleRate / kMaxPitchHz));
    const int tauMax = (int)(sampleRate / kMinPitchHz);
    if (tauMax <= tauMin) return h;

    int order = 1;
    while ((1 << order) < 2 * kAnalysisFrame) ++order;
    juce::dsp::FFT fft(order);
    std::vector<float> scratch((size_t)(1u << order) * 2u, 0.0f);

    for (int s = 0; s + kAnalysisFrame <= N; s += kAnalysisHop) {
        const std::vector<float> nsdf = nsdfFft(x + s, kAnalysisFrame, tauMin, tauMax, fft, order, scratch);
        const int lag = detectPeriod(nsdf, tauMin);  // 0 == unvoiced
        h.positions.push_back(s);
        h.periods.push_back(lag > 0 ? refinePeriod(nsdf, tauMin, lag) : 0.0);
    }
    return h;
}

double medianVoicedAll(const HopPeriods& h)
{
    std::vector<double> v;
    for (double p : h.periods) if (p > 0.0) v.push_back(p);
    return npMedian(v);
}

double medianVoicedInWindow(const HopPeriods& h, int64_t start, int64_t end)
{
    std::vector<double> v;
    for (size_t i = 0; i < h.periods.size(); ++i)
        if (h.periods[i] > 0.0 && h.positions[i] >= start && h.positions[i] < end)
            v.push_back(h.periods[i]);
    if (!v.empty()) return npMedian(v);
    return medianVoicedAll(h);  // mirrors PitchTrack.median_period fallback
}

// ── LPC formant tracking (mirrors loop_optimizer/formants.py) ────────────────

// Levinson-Durbin. Returns A(z) coefficients (a[0]==1), or empty on an unstable /
// collapsed recursion.
std::vector<double> levinson(const std::vector<double>& r, int order)
{
    if ((int)r.size() <= order || r[0] <= kEps) return {};
    for (double v : r) if (!std::isfinite(v)) return {};

    std::vector<double> a(order + 1, 0.0);
    a[0] = 1.0;
    double err = r[0];
    for (int i = 1; i <= order; ++i) {
        double acc = r[(size_t)i];
        for (int j = 1; j < i; ++j) acc += a[(size_t)j] * r[(size_t)(i - j)];
        const double k = -acc / err;
        if (!std::isfinite(k) || std::abs(k) >= 1.0) return {};
        std::vector<double> prev(a);
        for (int j = 1; j < i; ++j) a[(size_t)j] = prev[(size_t)j] + k * prev[(size_t)(i - j)];
        a[(size_t)i] = k;
        err *= 1.0 - k * k;
        if (err <= kEps) return {};
    }
    return a;
}

// Roots of a real polynomial coeffs[0]*x^n + ... + coeffs[n] (leading coeff
// nonzero) via Durand-Kerner (Weierstrass) iteration. numpy uses companion-matrix
// eigenvalues; DK converges to the same roots for the distinct conjugate-pair
// roots an LPC A(z) produces, and we sort by frequency afterwards so root order
// is irrelevant.
std::vector<std::complex<double>> polyRoots(const std::vector<double>& coeffs)
{
    const int n = (int)coeffs.size() - 1;
    if (n < 1) return {};
    std::vector<std::complex<double>> a(coeffs.size());
    const double lead = coeffs[0];
    for (size_t i = 0; i < coeffs.size(); ++i) a[i] = coeffs[i] / lead;  // monic

    std::vector<std::complex<double>> roots((size_t)n);
    const std::complex<double> seed(0.4, 0.9);
    std::complex<double> p(1.0, 0.0);
    for (int i = 0; i < n; ++i) { roots[(size_t)i] = p; p *= seed; }

    auto evalp = [&](std::complex<double> z) {
        std::complex<double> r = a[0];
        for (int i = 1; i <= n; ++i) r = r * z + a[(size_t)i];
        return r;
    };

    for (int iter = 0; iter < 200; ++iter) {
        double maxDelta = 0.0;
        for (int i = 0; i < n; ++i) {
            std::complex<double> denom(1.0, 0.0);
            for (int j = 0; j < n; ++j)
                if (j != i) denom *= (roots[(size_t)i] - roots[(size_t)j]);
            if (std::abs(denom) < 1e-300) continue;
            const std::complex<double> delta = evalp(roots[(size_t)i]) / denom;
            roots[(size_t)i] -= delta;
            maxDelta = std::max(maxDelta, std::abs(delta));
        }
        if (maxDelta < 1e-14) break;
    }
    return roots;
}

// Linear autocorrelation of a frame after everything above band_hz is removed —
// via FFT power spectrum, exactly as formants._band_limited_autocorrelation. The
// juce FFT is single precision; the resulting sub-1e-6 error in the
// autocorrelation is far below the drift gate's headroom (validated).
std::vector<double> bandLimitedAutocorrelation(const std::vector<double>& frame,
                                               double sampleRate, double bandHz,
                                               int maxLag)
{
    const int n = (int)frame.size();
    if (n < 4 || maxLag < 1) return {};
    int order = 3;
    while ((1 << order) < 2 * n || (1 << order) < 8) ++order;
    const int nFft = 1 << order;

    std::vector<float> buf((size_t)nFft * 2, 0.0f);
    for (int i = 0; i < n; ++i) buf[(size_t)i] = (float)frame[(size_t)i];

    juce::dsp::FFT fft(order);
    fft.performRealOnlyForwardTransform(buf.data(), false);  // full symmetric spectrum

    for (int k = 0; k < nFft; ++k) {
        const double re = buf[2 * (size_t)k], im = buf[2 * (size_t)k + 1];
        const double f = (k <= nFft / 2 ? (double)k : (double)(nFft - k)) * sampleRate / (double)nFft;
        const double power = (f > bandHz) ? 0.0 : (re * re + im * im);
        buf[2 * (size_t)k]     = (float)power;
        buf[2 * (size_t)k + 1] = 0.0f;
    }

    fft.performRealOnlyInverseTransform(buf.data());

    if (nFft <= maxLag || !std::isfinite(buf[0]) || buf[0] <= (float)kEps) return {};
    std::vector<double> r((size_t)maxLag + 1);
    for (int i = 0; i <= maxLag; ++i) r[(size_t)i] = (double)buf[(size_t)i];
    return r;
}

} // namespace

std::array<double, kNumFormants> frameFormantsHz(const float* frame, int n, double sampleRate)
{
    std::array<double, kNumFormants> out{kNaN, kNaN, kNaN};
    if (frame == nullptr || n < 4) return out;

    std::vector<double> y((size_t)n);
    for (int i = 0; i < n; ++i) {
        if (!std::isfinite(frame[(size_t)i])) return out;
        y[(size_t)i] = frame[(size_t)i];
    }
    // Pre-emphasis, then Hamming — order matters (window taper must not be
    // differentiated): y[i] = x[i] - 0.97*x[i-1], y[0] = x[0].
    for (int i = n - 1; i >= 1; --i) y[(size_t)i] -= kFormantPreemphasis * y[(size_t)(i - 1)];
    double peak = 0.0;
    for (int i = 0; i < n; ++i) {
        const double w = 0.54 - 0.46 * std::cos(2.0 * kPi * i / (double)(n - 1));
        y[(size_t)i] *= w;
        peak = std::max(peak, std::abs(y[(size_t)i]));
    }
    if (peak <= kEps) return out;

    const int decim = std::max(1, (int)(sampleRate / (2.0 * kFormantBandHz)));
    const double effRate = sampleRate / decim;
    const std::vector<double> rFull =
        bandLimitedAutocorrelation(y, sampleRate, kFormantBandHz, kFormantLpcOrder * decim);
    if (rFull.empty()) return out;

    // r[::decim] of a band-limited signal IS the decimated signal's own
    // autocorrelation, so the LPC below is fitted at effRate with no resampling.
    std::vector<double> rDec((size_t)kFormantLpcOrder + 1);
    for (int i = 0; i <= kFormantLpcOrder; ++i) rDec[(size_t)i] = rFull[(size_t)(i * decim)];

    const std::vector<double> a = levinson(rDec, kFormantLpcOrder);
    if (a.empty()) return out;

    std::vector<double> freqs;
    for (const std::complex<double>& root : polyRoots(a)) {
        if (std::imag(root) <= 0.0) continue;
        const double mag = std::abs(root);
        const double freq = std::arg(root) * effRate / (2.0 * kPi);
        const double bw = -std::log(std::max(mag, kEps)) * effRate / kPi;
        if (!std::isfinite(freq) || !std::isfinite(bw)) continue;
        if (freq >= kFormantMinHz && freq <= std::min(kFormantMaxHz, effRate / 2.0)
            && bw <= kFormantMaxBandwidthHz)
            freqs.push_back(freq);
    }
    std::sort(freqs.begin(), freqs.end());
    for (int i = 0; i < kNumFormants && i < (int)freqs.size(); ++i) out[(size_t)i] = freqs[(size_t)i];
    return out;
}

namespace {

// F1-F3 sampled on a fixed grid, with O(1) drift over any span via centred
// cumulative sums (mirrors formants.FormantTrack).
struct FormantTrack {
    std::vector<int64_t> frameStarts;
    int frameLen = 0;
    // centsRows[frame*3 + f], NaN where unresolved.
    std::vector<double> centsRows;
    int nFrames = 0;
    // Cumulative, size (nFrames+1)*3.
    std::vector<double> sum1, sum2, count;
    std::array<double, kNumFormants> offset{0, 0, 0};

    void build()
    {
        nFrames = (int)frameStarts.size();
        std::array<double, kNumFormants> sumVal{0, 0, 0};
        std::array<int, kNumFormants> cnt{0, 0, 0};
        for (int i = 0; i < nFrames; ++i)
            for (int f = 0; f < kNumFormants; ++f) {
                const double c = centsRows[(size_t)i * kNumFormants + f];
                if (std::isfinite(c)) { sumVal[(size_t)f] += c; cnt[(size_t)f]++; }
            }
        for (int f = 0; f < kNumFormants; ++f)
            offset[(size_t)f] = cnt[(size_t)f] > 0 ? sumVal[(size_t)f] / cnt[(size_t)f] : 0.0;

        sum1.assign((size_t)(nFrames + 1) * kNumFormants, 0.0);
        sum2.assign((size_t)(nFrames + 1) * kNumFormants, 0.0);
        count.assign((size_t)(nFrames + 1) * kNumFormants, 0.0);
        for (int i = 0; i < nFrames; ++i)
            for (int f = 0; f < kNumFormants; ++f) {
                const double c = centsRows[(size_t)i * kNumFormants + f];
                const bool ok = std::isfinite(c);
                const double filled = ok ? c - offset[(size_t)f] : 0.0;
                const size_t cur = (size_t)i * kNumFormants + f, nxt = (size_t)(i + 1) * kNumFormants + f;
                sum1[nxt]  = sum1[cur] + filled;
                sum2[nxt]  = sum2[cur] + filled * filled;
                count[nxt] = count[cur] + (ok ? 1.0 : 0.0);
            }
    }

    // Frames lying WHOLLY inside [start, end).
    void frameRange(int64_t start, int64_t end, int& lo, int& hi) const
    {
        if (nFrames == 0) { lo = hi = 0; return; }
        lo = searchsortedLeft(frameStarts, start);
        hi = searchsortedRight(frameStarts, end - frameLen);
        hi = std::max(lo, hi);
    }

    double spanDriftCents(int64_t start, int64_t end) const
    {
        int lo, hi; frameRange(start, end, lo, hi);
        double sumVar = 0.0; int okCount = 0;
        for (int f = 0; f < kNumFormants; ++f) {
            const double n = count[(size_t)hi * kNumFormants + f] - count[(size_t)lo * kNumFormants + f];
            if (n < 2.0) continue;
            const double s1 = sum1[(size_t)hi * kNumFormants + f] - sum1[(size_t)lo * kNumFormants + f];
            const double s2 = sum2[(size_t)hi * kNumFormants + f] - sum2[(size_t)lo * kNumFormants + f];
            const double var = std::max(s2 / n - (s1 / n) * (s1 / n), 0.0);
            sumVar += var; okCount++;
        }
        if (okCount == 0) return kNaN;
        return std::sqrt(sumVar / okCount);
    }

    std::array<double, kNumFormants> spanFormantsCents(int64_t start, int64_t end) const
    {
        int lo, hi; frameRange(start, end, lo, hi);
        std::array<double, kNumFormants> out{kNaN, kNaN, kNaN};
        for (int f = 0; f < kNumFormants; ++f) {
            const double n = count[(size_t)hi * kNumFormants + f] - count[(size_t)lo * kNumFormants + f];
            if (n < 1.0) continue;
            const double s1 = sum1[(size_t)hi * kNumFormants + f] - sum1[(size_t)lo * kNumFormants + f];
            out[(size_t)f] = s1 / n + offset[(size_t)f];
        }
        return out;
    }
};

FormantTrack trackFormants(const float* x, int N, double sampleRate, int64_t start, int64_t end)
{
    FormantTrack t;
    t.frameLen = std::max(8, (int)std::llround(kFormantFrameMs * 0.001 * sampleRate));
    const int hop = std::max(1, (int)std::llround(kFormantHopMs * 0.001 * sampleRate));
    start = std::max<int64_t>(0, start);
    end = std::min<int64_t>(N, end);

    for (int64_t s = start; s + t.frameLen <= end; s += hop) {
        t.frameStarts.push_back(s);
        const std::array<double, kNumFormants> hz = frameFormantsHz(x + s, t.frameLen, sampleRate);
        for (int f = 0; f < kNumFormants; ++f)
            t.centsRows.push_back(std::isfinite(hz[(size_t)f]) ? hzToCents(hz[(size_t)f]) : kNaN);
    }
    t.build();
    return t;
}

double formantDistanceCents(const std::array<double, kNumFormants>& a,
                            const std::array<double, kNumFormants>& b)
{
    double sum = 0.0; int cnt = 0;
    for (int f = 0; f < kNumFormants; ++f)
        if (std::isfinite(a[(size_t)f]) && std::isfinite(b[(size_t)f])) {
            const double d = a[(size_t)f] - b[(size_t)f];
            sum += d * d; cnt++;
        }
    return cnt == 0 ? kNaN : std::sqrt(sum / cnt);
}

// ── Engine clamp (mirrors engine_emu.resolve / Sampler.cpp:881-910) ──────────

struct EffectiveLoop {
    int64_t effLoopStart = 0, effLoopEnd = 0, effXfade = 0;
    bool useLoop = false;
    int64_t wrapAdvance() const { return effLoopEnd - (effLoopStart + effXfade); }
};

EffectiveLoop resolveLoop(int64_t loopStart, int64_t loopEnd, int64_t xfade, int64_t numFrames)
{
    // smpStart = 0, smpLength = 0 (whole buffer) — the policy always previews the
    // full sample, matching how build_sample_payload resolves a policy arm.
    const int64_t clampedEnd = numFrames;
    EffectiveLoop e;
    e.effLoopEnd = loopEnd > 0 ? std::min(loopEnd, numFrames) : numFrames;
    e.effLoopStart = std::min(loopStart, e.effLoopEnd);
    e.useLoop = e.effLoopEnd > e.effLoopStart;
    if (e.useLoop && xfade > 0) {
        e.effXfade = xfade;
        e.effXfade = std::min(e.effXfade, (e.effLoopEnd - e.effLoopStart) / 2);
        e.effXfade = std::min(e.effXfade, e.effLoopEnd);            // - smpStart(0)
        e.effXfade = std::min(e.effXfade, clampedEnd - e.effLoopStart);
        if (e.effXfade < 0) e.effXfade = 0;
    }
    return e;
}

// ── Candidate geometry (mirrors loop_optimizer/candidates.py) ────────────────

int seamWindow(double period) { return std::max(2, (int)std::llround(period)); }

std::vector<std::pair<int, int>> viableLengths(double period, int windowSpan, double sampleRate)
{
    std::vector<std::pair<int, int>> out;
    if (!std::isfinite(period) || period <= 1.0 || windowSpan < 4) return out;
    const int w = seamWindow(period);
    const int maxLen = (int)std::min(kPolicyMaxLoopDurationSec * sampleRate, (double)(windowSpan - w));
    if ((double)maxLen < period) return out;
    const int minLen = (int)(kPolicyMinLoopDurationSec * sampleRate);
    const int kMax = std::min((int)(maxLen / period), kMaxPeriodMultiples);
    for (int k = 1; k <= kMax; ++k) {
        const int length = (int)std::llround(k * period);
        if (length > 0 && length >= minLen) out.emplace_back(k, length);
    }
    return out;
}

// Cosine NCC between x[s:s+w] and x[s+length:s+length+w] for every s in [lo, hi).
// NOT the engine's mean-removed Pearson (LoopAnalysis normalizedCrossCorrelation)
// — the reference optimizer's placement search is cosine similarity, and the
// argmax start can differ between the two, so it is ported verbatim. NaN where a
// window is silent.
// `sqCum` is a shared prefix sum of squares over [sqBase, ...): sqCum[k] ==
// Sum_{i=sqBase}^{sqBase+k-1} x[i]^2. It is length-independent, so the caller
// hoists it out of the per-length loop (spanPool) — the single biggest cost in
// the search on long selections. Only the product prefix depends on `length`.
std::vector<double> slidingEndMatchNcc(const float* x, int n, int length, int w, int lo, int hi,
                                       const std::vector<double>& sqCum, int sqBase)
{
    std::vector<double> out;
    if (hi <= lo || w <= 0 || lo < 0 || (int64_t)hi + length + w > n) return out;
    const int base = lo;
    const int prodTop = hi + w;                           // prod index upper bound (exclusive)

    std::vector<double> prodCum((size_t)(prodTop - base) + 1, 0.0);
    for (int i = base; i < prodTop; ++i)
        prodCum[(size_t)(i - base) + 1] =
            prodCum[(size_t)(i - base)] + (double)x[(size_t)i] * x[(size_t)(i + length)];

    out.resize((size_t)(hi - lo));
    for (int s = lo; s < hi; ++s) {
        const double dot = prodCum[(size_t)(s + w - base)] - prodCum[(size_t)(s - base)];
        const double a = std::max(sqCum[(size_t)(s + w - sqBase)] - sqCum[(size_t)(s - sqBase)], 0.0);
        const double b = std::max(sqCum[(size_t)(s + length + w - sqBase)] - sqCum[(size_t)(s + length - sqBase)], 0.0);
        // denom == norm_a*norm_b == sqrt(a)*sqrt(b) == sqrt(a*b); one sqrt, and the
        // >1e-12 guard on the product-of-norms becomes >1e-24 on their squares.
        const double ab = a * b;
        out[(size_t)(s - lo)] = ab > 1e-24 ? dot / std::sqrt(ab) : kNaN;
    }
    return out;
}

// Longest period-multiple crossfade the engine clamp leaves untouched, at one
// span. Returns the max surviving crossfade width in samples (0 if only the
// zero-fade variant survives). Mirrors candidates.xfade_variants + the "longest"
// pick the policy makes over it.
int maxXfadeVariant(int64_t numFrames, double period, int64_t loopStart, int64_t loopEnd)
{
    const int64_t length = loopEnd - loopStart;
    if (length <= 0 || !std::isfinite(period) || period <= 0.0) return -1;
    const int64_t maxXfadeSamples = length / 2;
    const int jMax = std::min((int)((double)maxXfadeSamples / period), kMaxXfadePeriodMultiples);

    int best = -1;
    int prevReq = -1;
    for (int j = 0; j <= jMax; ++j) {
        const int requested = (int)std::llround(j * period);
        if (requested > maxXfadeSamples || requested == prevReq) continue;
        prevReq = requested;
        const EffectiveLoop e = resolveLoop(loopStart, loopEnd, requested, numFrames);
        if (e.wrapAdvance() <= 0) continue;
        if (e.effXfade != requested) continue;  // clamp bound other than half-loop fired
        best = std::max(best, requested);
    }
    return best;
}

// ── Span search + placement (drift) gate ─────────────────────────────────────

struct Span {
    int period_multiple;
    int length;
    int loop_start;
    double search_ncc;
    double drift_cents;
};

std::vector<Span> spanPool(const float* x, int N, double period,
                           int windowStart, int windowEnd, double sampleRate,
                           const FormantTrack& track)
{
    std::vector<Span> pool;
    const int w = seamWindow(period);
    const int step = std::max(1, (int)std::llround(period));

    // Prefix sum of squares over the whole window, hoisted: every length's seam
    // norms read from this instead of rebuilding it (sqTop is always windowEnd).
    std::vector<double> sqCum((size_t)(windowEnd - windowStart) + 1, 0.0);
    for (int i = windowStart; i < windowEnd; ++i)
        sqCum[(size_t)(i - windowStart) + 1] = sqCum[(size_t)(i - windowStart)] + (double)x[(size_t)i] * x[(size_t)i];

    for (const auto& kl : viableLengths(period, windowEnd - windowStart, sampleRate)) {
        const int k = kl.first, length = kl.second;
        const int lo = windowStart;
        const int hi = windowEnd - length - w;
        if (hi <= lo) continue;
        const std::vector<double> ncc = slidingEndMatchNcc(x, N, length, w, lo, hi, sqCum, windowStart);
        if (ncc.empty()) continue;

        int best = -1; double bestV = -std::numeric_limits<double>::infinity();
        for (int i = 0; i < (int)ncc.size(); ++i)
            if (std::isfinite(ncc[(size_t)i]) && ncc[(size_t)i] > bestV) { bestV = ncc[(size_t)i]; best = i; }

        auto consider = [&](int off) {
            const double v = ncc[(size_t)off];
            if (!std::isfinite(v) || v < kPolicyMinSeamNcc) return;
            const int start = lo + off;
            pool.push_back(Span{k, length, start, v,
                                track.spanDriftCents(start, (int64_t)start + length)});
        };
        for (int off = 0; off < (int)ncc.size(); off += step) consider(off);
        if (best >= 0 && best % step != 0) consider(best);
    }
    return pool;
}

// Filter the pool to the stable spans. Returns kept (sorted longest-first) and
// writes back the median / cut for the telemetry trace.
std::vector<Span> driftGatedSpans(const std::vector<Span>& pool, double& median, double& cut)
{
    std::vector<double> finite;
    for (const Span& s : pool) if (std::isfinite(s.drift_cents)) finite.push_back(s.drift_cents);

    std::vector<Span> kept;
    if (finite.empty()) {
        median = cut = kNaN;
        kept = pool;
    } else {
        std::sort(finite.begin(), finite.end());
        median = npMedian(finite);
        cut = std::max(npQuantileSorted(finite, kFormantDriftQuantile), kFormantStableDriftCents);
        for (const Span& s : pool)
            if (std::isfinite(s.drift_cents) && s.drift_cents <= cut) kept.push_back(s);
        if (kept.empty()) kept = pool;
    }
    std::sort(kept.begin(), kept.end(), [](const Span& a, const Span& b) {
        if (a.length != b.length) return a.length > b.length;
        if (a.search_ncc != b.search_ncc) return a.search_ncc > b.search_ncc;
        return a.loop_start < b.loop_start;
    });
    return kept;
}

} // namespace

// ── Public primitives for the parity harness ─────────────────────────────────

std::vector<double> measureHopPeriods(const float* x, int N, double sampleRate)
{
    return measureHops(x, N, sampleRate).periods;
}

double periodInWindow(const float* x, int N, double sampleRate, int64_t start, int64_t end)
{
    return medianVoicedInWindow(measureHops(x, N, sampleRate), start, end);
}

// ── The policy v2 chain ──────────────────────────────────────────────────────

AutoLoopResult autoLoopForSelection(const float* x, int N, double sampleRate,
                                    int64_t selStart, int64_t selEnd)
{
    AutoLoopResult r;
    if (x == nullptr || N <= 0 || sampleRate <= 0.0) { r.reason = "empty buffer"; return r; }

    selStart = std::clamp<int64_t>(selStart, 0, N);
    selEnd = std::clamp<int64_t>(selEnd, 0, N);
    if (selEnd <= selStart) { r.reason = "empty selection"; return r; }

    // Step A — fundamental period. The pitch track is over the whole buffer; the
    // period is the median voiced hop inside the selection widened by
    // kPeriodWindowMarginPeriods (mirrors analysis._select_window for the gold
    // selection, whose margin is derived from the whole-file rough median).
    const HopPeriods hops = measureHops(x, N, sampleRate);
    const double rough = medianVoicedAll(hops);
    if (!std::isfinite(rough)) { r.reason = "no voiced hops"; return r; }
    const int64_t pMargin = (int64_t)std::llround(kPeriodWindowMarginPeriods * rough);
    const int64_t pwStart = std::max<int64_t>(0, selStart - pMargin);
    const int64_t pwEnd = std::min<int64_t>(N, selEnd + pMargin);
    const double period = medianVoicedInWindow(hops, pwStart, pwEnd);
    if (!std::isfinite(period) || period <= 1.0) { r.reason = "region not analysable"; return r; }

    // Step B — the policy window: the selection ± kPolicySelectionMarginFrac.
    const int64_t region = selEnd - selStart;
    const int64_t margin = (int64_t)std::llround(kPolicySelectionMarginFrac * (double)region);
    const int64_t windowStart = std::max<int64_t>(0, selStart - margin);
    const int64_t windowEnd = std::min<int64_t>(N, selEnd + margin);
    if ((double)(windowEnd - windowStart) < period) { r.reason = "selection shorter than one period"; return r; }

    // Step C — formant track over the window (computed once, sliced per span).
    const FormantTrack track = trackFormants(x, N, sampleRate, windowStart, windowEnd);

    // Step D — the joint (placement, length) span pool, then the drift gate.
    const std::vector<Span> pool = spanPool(x, N, period, (int)windowStart, (int)windowEnd, sampleRate, track);
    if (pool.empty()) { r.reason = "no viable placement"; return r; }
    double median = kNaN, cut = kNaN;
    const std::vector<Span> kept = driftGatedSpans(pool, median, cut);

    const Span longest = *std::max_element(pool.begin(), pool.end(), [](const Span& a, const Span& b) {
        if (a.length != b.length) return a.length < b.length;
        return a.search_ncc < b.search_ncc;
    });

    // Step E — the longest surviving span whose span yields a crossfade variant,
    // taking the longest period-multiple crossfade the clamp allows. The fade
    // gates (formant-fade / click / flam) are provably inert on the corpus and
    // are deliberately not ported (see AutoLoopPolicy.h), so "chosen == max_xfade".
    const int attempts = std::min((int)kept.size(), kMaxSpanAttempts);
    for (int i = 0; i < attempts; ++i) {
        const Span& span = kept[(size_t)i];
        const int xfade = maxXfadeVariant(N, period, span.loop_start, (int64_t)span.loop_start + span.length);
        if (xfade < 0) continue;

        r.valid = true;
        r.loopStart = span.loop_start;
        r.loopEnd = (int64_t)span.loop_start + span.length;
        r.crossfadeSamples = xfade;
        r.period = period;
        r.periodMultiple = span.period_multiple;
        r.spanDriftCents = span.drift_cents;
        r.selectionMedianDriftCents = median;
        r.driftCutCents = cut;
        r.spansConsidered = (int)pool.size();
        r.spansKept = (int)kept.size();
        r.longestSpan = longest.length;
        r.maxXfade = xfade;
        if (span.length < longest.length) r.gatesBound.push_back("placement_drift");
        return r;
    }

    r.reason = "no span yielded a crossfade variant";
    return r;
}

} // namespace xleth::dsp
