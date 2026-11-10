#include "dsp/ResonanceCore.h"

#include "dsp/DspPrimitives.h"

#include <algorithm>
#include <cmath>
#include <cstring>

// ─── Design notes (stage 1) ─────────────────────────────────────────────────────────────────────
// Detector
//   * |X_k|^2 of the sqrt-Hann frame is averaged recursively over frames (one-pole, tau detectorTauMs_ (default 200 ms),
//     bias-corrected during start-up). A single periodogram bin has ~5.6 dB std-dev on noise; the
//     average is what makes a fixed-statistics threshold possible at all.
//   * Levels live on a 96-band ERB-rate grid (20 Hz .. min(0.45 fs, 20 kHz)). Each band is a triangular
//     (ERB-domain) weighting of bins, or the linear interpolation of the two nearest bins where a band is
//     narrower than a bin. Each bin is weighted by its frequency, so the level is power per unit
//     log-frequency ("per octave"): pink noise is flat.
//   * Flanks start outside the resonance's main lobe: kGapOct octaves from the band (a Q >= 4 bell at
//     +12 dB is within ~1-2 dB of flat there) and never closer than kGapBins FFT bins (the analysis
//     window's own main lobe, which smears a narrow low-frequency resonance over its neighbours). Each
//     flank is kFlankOct wide. Baseline = the straight line (dB over log2 f) through the MEDIANS of the two
//     flanks, evaluated at the band: exact for any locally linear tilt even where the bin-limited gap makes
//     the flanks asymmetric. One-sided bands (grid edges) carry their flank median along a wideband
//     least-squares tilt (200 Hz .. 10 kHz).
//   * Threshold = z(sensitivity) x sigma_E, where sigma_E is the standard deviation of
//     (level - baseline) for a noise-like input, derived from the averaging geometry: frame overlap
//     correlation and bin correlation of THIS window, the recursive-average weights (including the
//     start-up count), the band's bin weights, and the medians' variance with their line weights
//     (log-Gamma statistics: std of 10log10 of a Gamma(M) mean = 10/ln10 * sqrt(trigamma(M))).
// Two-speed detection (v6, dynamic gates G8 / G9)
//   * A second power average with a short time constant (kDefaultFastTauMs = 40 ms, in ms: independent of N / the rate) runs next to
//     the slow one (200 ms). It has its own band levels, flank baseline and sigma_E (same geometry formulas, its own variance table), so
//     every threshold is derived from the variance of the estimate that is used.
//   * Per band the SLOW estimate (precise, smooth) is used while the fast one is statistically consistent with it. Onset: fast above
//     slow by more than kSwitchUpSigmas fast sigmas -> the fast estimate is used. Release: slow above fast by more than kVetoSetSigmas
//     fast sigmas -> a latch hands the band to the fast estimate until slow is within kVetoClearSigmas fast sigmas of fast again. The
//     latch is what keeps the slow (200 ms) average from holding the cut after the resonance is gone; the knee / threshold / depth cap
//     then run on the estimate in charge, and the per-band release (the user's constant) starts at once.
//   * Cost control: a band's flank baseline (per-band medians, the dominant detector cost) is refreshed every 4th (slow) / 2nd (fast)
//     frame, staggered over the bands, and on every frame where the mean band level has moved by > kBaselineJumpDb (a broadband
//     onset must not meet a stale baseline). Levels are exact every frame.
// Gain computer
//   * excess E = level - baseline. Salience u = (E - T) / sigma_E; knee K = smoothstep(u / kappa)
//     (kappa = 3 sigma Soft, 1.5 sigma Hard; 1 / 0.5 fast sigma while the fast estimate is in charge), then the max K over each band's main-lobe zone (the zone the
//     baseline excludes): a confidently detected resonance takes its shoulders (and at low f the window's
//     leakage of it) with it. Target reduction = K x E: the WHOLE excess, i.e. towards the baseline, not
//     "excess minus threshold" (that would leave the threshold standing as a residual).
//   * Below ~300 Hz (where an ERB is narrower than the analysis kernel) E for the depth (not for the
//     detection decision) is the excess at auditory resolution: see subBinCorrection().
//   * Depth caps the reduction smoothly: R = r / (1 + (r / Rmax)^p)^(1/p), Rmax = depth x 12 dB (Soft,
//     p = 2) or depth x 24 dB (Hard, p = 6).
//   * Per-band one-pole attack / release in dB at the frame rate (DspPrimitives onePoleStep convention),
//     then a [1 2 1] / 4 smoothing across bands (Params::sharpness: 0.5 = exactly this; 1 = none; 0 = [1 2 1]^4),
//     then the stereo link (blend towards max(L, R)), then the optional per-band weight curve (RS weighting semantics).
//   * Visualization tap / meters: after the weight curve, once per hop (emitViz, lastMaxReductionDb).
//   * G(f): the band curve (dB) is interpolated linearly on the ERB axis to every bin and applied as a
//     real, zero-phase gain.
// Live tier switching (ResonanceCore.md section 9)
//   * One Engine per tier, all built in prepare(); the input ring is shared and is every engine's analysis FIFO (a frame ending at stream
//     position e reads ring[e - N, e)), so an engine that starts mid-stream already has its history. A frame grid is (e + offset) % H == 0
//     on the stream clock pos_.
//   * Adoption (start of a process() call, no transition running): the new engine takes the old one's state (transferState), processes
//     the frame at its last grid point <= pos_ from the ring, then runs on its grid next to the old one. Its overlap-add output is complete
//     3 hops after that first frame (`valid`); until then the output, the meters and the introspection stay on the old engine. From `valid`
//     the output crossfades old -> new over fadeLen_ samples (linear, (k + 1) / F like the EQ restart fade-in), the aligned dry crossfades
//     between the two delays with the same gains; then the old engine stops.

namespace xleth::dsp::resonance
{

namespace
{
constexpr double kTenOverLn10 = 4.342944819032518;   // 10 / ln(10): dB per neper of power
constexpr float  kLn10Over20  = 0.11512925464970229f;

double erbRate(double f) { return 21.4 * std::log10(1.0 + 0.00437 * f); }
double erbToHz(double e) { return (std::pow(10.0, e / 21.4) - 1.0) / 0.00437; }

// Trigamma psi1(m), m > 0: recurrence up to m >= 6, then the asymptotic series.
double trigamma(double m)
{
    double r = 0.0;
    while (m < 6.0) { r += 1.0 / (m * m); m += 1.0; }
    const double im = 1.0 / m, im2 = im * im;
    return r + im + 0.5 * im2 + im * im2 * (1.0 / 6.0 - im2 * (1.0 / 30.0 - im2 / 42.0));
}

// Std-dev (dB) of 10log10 of a mean whose relative variance (variance / mean^2) is vf, for a noise-like
// input: the mean is ~Gamma(M = 1 / vf).
double levelSigmaDb(double vf)
{
    const double m = 1.0 / std::max(vf, 1.0e-9);
    return kTenOverLn10 * std::sqrt(trigamma(m));
}

inline float smoothstep01(float x) noexcept
{
    x = std::clamp(x, 0.0f, 1.0f);
    return x * x * (3.0f - 2.0f * x);
}

// Finite test on the bit pattern: independent of the floating-point model the target is compiled with.
inline bool finiteF(float v) noexcept
{
    uint32_t u; std::memcpy(&u, &v, sizeof u);
    return (u & 0x7F800000u) != 0x7F800000u;
}

inline float sane(float v, float def, float lo, float hi) noexcept
{
    return finiteF(v) ? std::clamp(v, lo, hi) : def;
}
} // namespace

Core::Core() = default;
Core::~Core() = default;

int Core::fftSizeFor(double sampleRate, FrameTier tier) noexcept
{
    // Normal: ~21 ms frame, 1024 up to 50 kHz, then doubled per sample-rate octave. Fast / High: half / double.
    int t = static_cast<int>(tier);
    t = t < 0 ? 0 : (t > 2 ? 2 : t);
    int n = 512 << t;
    double sr = sampleRate;
    while (sr > 50000.0 && n < 16384) { sr *= 0.5; n *= 2; }
    return n;
}

Params Core::sanitizeParams(const Params& in) noexcept
{
    // Defaults are the Params defaults; ranges are the documented ones (the attack / release floors are the ones computeGains() clamps to).
    Params p = in;
    p.depth       = sane(in.depth,       0.5f,   0.0f, 1.0f);
    p.sensitivity = sane(in.sensitivity, 0.5f,   0.0f, 1.0f);
    p.attackMs    = sane(in.attackMs,    15.0f,  0.1f, 1000.0f);
    p.releaseMs   = sane(in.releaseMs,   200.0f, 1.0f, 10000.0f);
    p.stereoLink  = sane(in.stereoLink,  0.0f,   0.0f, 1.0f);
    p.sharpness   = sane(in.sharpness,   0.5f,   0.0f, 1.0f);
    return p;
}

int Core::hopOffsetFor(int hop) const noexcept
{
    // The stored fraction hopOffset0_ / hop0_ applied to `hop`, floored. Exact for the prepare-time tier and for every larger hop.
    return static_cast<int>((static_cast<long long>(hopOffset0_) * hop) / hop0_);
}

int Core::hopPhaseOffset() const noexcept
{
    return prepared_ ? eng_[active_].hopOffset : 0;
}

void Core::prepare(double sampleRate, int /*maxBlockSize*/, int numChannels)
{
    sampleRate_  = sampleRate > 0.0 ? sampleRate : 48000.0;
    numChannels_ = std::clamp(numChannels, 1, kMaxChannels);
    target_      = std::clamp(target_, 0, 2);

    buildSharedGrid();
    for (int t = 0; t < 3; ++t) buildEngine(eng_[t], static_cast<FrameTier>(t));

    // The hop phase offset of the prepare-time tier, kept as a fraction of that tier's hop.
    hop0_       = eng_[target_].H;
    hopOffset0_ = ((hopPhaseOffset_ % hop0_) + hop0_) % hop0_;
    for (auto& e : eng_) e.hopOffset = hopOffsetFor(e.H);

    // Input ring: >= 2 x the largest N (a frame of the largest tier plus a hop of history, and the dry read at the largest latency).
    const int nMax = eng_[2].N;
    size_t ringLen = 1;
    while (ringLen < static_cast<size_t>(2 * nMax)) ringLen <<= 1;
    ringMask_ = static_cast<long long>(ringLen) - 1;
    for (auto& r : ring_) r.assign(ringLen, 0.0f);
    auxRing_.assign(ringLen, 0.0f);

    const int nbMax = nMax / 2 + 1;
    const auto B = static_cast<size_t>(numBands_);
    binX_.assign(static_cast<size_t>(nbMax), 0.0f);
    binF_.assign(static_cast<size_t>(nbMax), 1.0f);
    scratch_.assign(B, 0.0f);
    tmpBand_.assign(B, 0.0f);
    estBand_.assign(B, 0.0f);
    fadeLen_ = std::max(1, static_cast<int>(std::lround(sampleRate_ * kTierCrossfadeMs * 1.0e-3)));
    switches_.store(0, std::memory_order_relaxed);
    prepared_ = true;
    reset();
}

// Tier-independent part of the grid: band centres on the ERB axis, log2 f, and the wideband tilt range. Depends on the sample rate only.
void Core::buildSharedGrid()
{
    const double sr = sampleRate_;
    const int B = kGridBands;
    numBands_ = B;
    const double fLo = 20.0, fHi = std::min(0.45 * sr, 20000.0);
    erbLo_ = erbRate(fLo);
    erbStep_ = (erbRate(fHi) - erbLo_) / (B - 1);
    bandHz_.assign(static_cast<size_t>(B), 0.0f);
    for (int b = 0; b < B; ++b) bandHz_[static_cast<size_t>(b)] = static_cast<float>(erbToHz(erbLo_ + b * erbStep_));
    bandX_.assign(static_cast<size_t>(B), 0.0f);
    for (int b = 0; b < B; ++b) bandX_[static_cast<size_t>(b)] = static_cast<float>(std::log2(static_cast<double>(bandHz_[static_cast<size_t>(b)])));
    // Wideband tilt fit range for one-sided flanks (edges of the grid): bands between 200 Hz and 10 kHz.
    slopeLo_ = 0; slopeHi_ = -1;
    for (int b = 0; b < B; ++b)
    {
        const double f = bandHz_[static_cast<size_t>(b)];
        if (f < 200.0) slopeLo_ = b + 1;
        if (f <= std::min(10000.0, fHi)) slopeHi_ = b;
    }
    {
        double sx = 0.0, n = 0.0;
        for (int b = slopeLo_; b <= slopeHi_; ++b) { sx += bandX_[static_cast<size_t>(b)]; n += 1.0; }
        slopeXMean_ = n > 0.0 ? sx / n : 0.0;
        double sxx = 0.0;
        for (int b = slopeLo_; b <= slopeHi_; ++b) { const double d = bandX_[static_cast<size_t>(b)] - slopeXMean_; sxx += d * d; }
        slopeSxx_ = std::max(sxx, 1.0e-9);
    }
}

// Everything frequency-dependent one tier's detector and renderer need, computed once per prepare().
void Core::buildEngine(Engine& e, FrameTier tier)
{
    e.N = fftSizeFor(sampleRate_, tier);
    e.H = e.N / 4;
    {
        // Baseline refresh intervals are defined in ms and converted to whole frames (N = 1024 at 48 kHz: 4 and 2 frames).
        const double hopMs = 1000.0 * e.H / sampleRate_;
        e.slowPeriod = std::clamp(static_cast<int>(std::lround(kSlowBaselineRefreshMs / hopMs)), 1, 32);
        e.fastPeriod = std::clamp(static_cast<int>(std::lround(kFastBaselineRefreshMs / hopMs)), 1, 32);
    }
    int order = 0;
    while ((1 << order) < e.N) ++order;
    e.fft = std::make_unique<juce::dsp::FFT>(order);

    const int N = e.N, H = e.H, nb = N / 2 + 1;
    // sqrt of the periodic Hann window, used for analysis and (with the normalisation) synthesis.
    e.window.assign(static_cast<size_t>(N), 0.0f);
    e.synthesis.assign(static_cast<size_t>(N), 0.0f);
    const double twoPi = 2.0 * juce::MathConstants<double>::pi;
    for (int n = 0; n < N; ++n)
    {
        const double hann = 0.5 - 0.5 * std::cos(twoPi * n / N);
        e.window[static_cast<size_t>(n)] = static_cast<float>(std::sqrt(std::max(hann, 0.0)));
    }
    // Per-hop-phase COLA normalisation 1 / sum_k w^2(phase + kH) (the RS WolaProcessor scheme). For the
    // periodic Hann at hop N/4 the sum is exactly 2; computing it keeps the reconstruction exact in float.
    for (int phase = 0; phase < H; ++phase)
    {
        double sum = 0.0;
        for (int n = phase; n < N; n += H)
            sum += static_cast<double>(e.window[static_cast<size_t>(n)]) * e.window[static_cast<size_t>(n)];
        const double norm = sum > 1.0e-8 ? 1.0 / sum : 1.0;
        for (int n = phase; n < N; n += H)
            e.synthesis[static_cast<size_t>(n)] = static_cast<float>(e.window[static_cast<size_t>(n)] * norm);
    }

    const double sr = sampleRate_, binHz = sr / N;
    const int B = numBands_;
    const std::vector<float>& window = e.window;

    // --- window statistics: frame-overlap and bin correlations of |X|^2 for white noise ---
    double sumW2 = 0.0;
    for (int n = 0; n < N; ++n) sumW2 += static_cast<double>(window[static_cast<size_t>(n)]) * window[static_cast<size_t>(n)];
    double rhoTime[4] = { 1.0, 0.0, 0.0, 0.0 };   // lag in hops
    for (int L = 1; L < 4; ++L)
    {
        double s = 0.0;
        for (int n = 0; n + L * H < N; ++n) s += static_cast<double>(window[static_cast<size_t>(n)]) * window[static_cast<size_t>(n + L * H)];
        rhoTime[L] = (s * s) / (sumW2 * sumW2);
    }
    double rhoBin[4] = { 1.0, 0.0, 0.0, 0.0 };    // lag in bins
    for (int d = 1; d < 4; ++d)
    {
        double s = 0.0;
        for (int n = 0; n < N; ++n)
            s += static_cast<double>(window[static_cast<size_t>(n)]) * window[static_cast<size_t>(n)]
                 * std::cos(2.0 * juce::MathConstants<double>::pi * d * n / N);
        rhoBin[d] = (s * s) / (sumW2 * sumW2);
    }

    // --- recursive average: S = a S + b P per frame; variance factor after n frames (bias-corrected weights) ---
    // Time constants are defined in ms and converted with the hop duration (frame rate), so they do not depend on N or the rate.
    const double frameRate = sr / H;
    auto buildAverage = [&](double tauMs, float& eA, float& eB, std::vector<double>& vfOut)
    {
        const double a = std::exp(-1.0 / (tauMs * 1.0e-3 * frameRate));
        eA = static_cast<float>(a);
        eB = static_cast<float>(-std::expm1(-1.0 / (tauMs * 1.0e-3 * frameRate)));
        const int nMax = std::clamp(static_cast<int>(std::ceil(std::log(1.0e-4) / std::log(a))), 1, 4096);
        vfOut.assign(static_cast<size_t>(nMax), 1.0);
        std::vector<double> w(static_cast<size_t>(nMax));
        for (int n = 1; n <= nMax; ++n)
        {
            const double norm = (1.0 - a) / (1.0 - std::pow(a, n));
            for (int i = 0; i < n; ++i) w[static_cast<size_t>(i)] = norm * std::pow(a, i);
            double vf = 0.0;
            for (int i = 0; i < n; ++i)
            {
                vf += w[static_cast<size_t>(i)] * w[static_cast<size_t>(i)];
                for (int L = 1; L < 4 && i + L < n; ++L) vf += 2.0 * rhoTime[L] * w[static_cast<size_t>(i)] * w[static_cast<size_t>(i + L)];
            }
            vfOut[static_cast<size_t>(n - 1)] = vf;
        }
    };
    buildAverage(static_cast<double>(detectorTauMs_), e.emaA, e.emaB, e.vfTime);
    if (fastTauMs_ > 0.0f) buildAverage(static_cast<double>(fastTauMs_), e.emaAF, e.emaBF, e.vfTimeF);
    else { e.emaAF = 0.0f; e.emaBF = 1.0f; e.vfTimeF.assign(1, 1.0); }

    // --- band <- bin weights (CSR). Weight stored = u_k * f_k (per-octave level); vfBin from u_k ---
    e.bwStart.assign(static_cast<size_t>(B) + 1, 0);
    e.bwBin.clear(); e.bwW.clear();
    e.vfBin.assign(static_cast<size_t>(B), 1.0f);
    std::vector<int> ks; std::vector<double> ws;
    for (int b = 0; b < B; ++b)
    {
        ks.clear(); ws.clear();
        const double eb = erbLo_ + b * erbStep_;
        for (int k = 1; k < nb; ++k)
        {
            const double d = std::abs(erbRate(k * binHz) - eb) / erbStep_;
            if (d < 1.0) { ks.push_back(k); ws.push_back(1.0 - d); }
        }
        if (ks.size() < 2)
        {
            // Band narrower than a bin: linear interpolation of the two bins around its centre (never bin 0).
            ks.clear(); ws.clear();
            const double pos = bandHz_[static_cast<size_t>(b)] / binHz;
            int k0 = static_cast<int>(std::floor(pos));
            double t = pos - k0;
            if (k0 < 1) { k0 = 1; t = 0.0; }
            if (k0 > nb - 2) { k0 = nb - 2; t = 1.0; }
            ks.push_back(k0); ws.push_back(1.0 - t);
            ks.push_back(k0 + 1); ws.push_back(t);
        }
        double sw = 0.0;
        for (double v : ws) sw += v;
        double vf = 0.0;
        for (size_t i = 0; i < ks.size(); ++i)
        {
            const double ui = ws[i] / sw;
            for (size_t j = 0; j < ks.size(); ++j)
            {
                const int d = std::abs(ks[i] - ks[j]);
                if (d < 4) vf += ui * (ws[j] / sw) * rhoBin[d];
            }
            e.bwBin.push_back(ks[i]);
            e.bwW.push_back(static_cast<float>(ui * ks[i] * binHz));
        }
        e.vfBin[static_cast<size_t>(b)] = static_cast<float>(vf);
        e.bwStart[static_cast<size_t>(b) + 1] = static_cast<int>(e.bwBin.size());
    }

    // --- flank band lists per side, outside the main-lobe exclusion ---
    const double gapUp = std::pow(2.0, static_cast<double>(kGapOct)), flank = std::pow(2.0, static_cast<double>(kFlankOct));
    for (int s = 0; s < 2; ++s)
    {
        e.flStart[s].assign(static_cast<size_t>(B) + 1, 0);
        e.fl[s].clear();
        e.sideX[s].assign(static_cast<size_t>(B), 0.0f);
        e.sideVf[s].assign(static_cast<size_t>(B), 1.0f);
        e.sideNeff[s].assign(static_cast<size_t>(B), 1.0f);
    }
    e.lobeLo.assign(static_cast<size_t>(B), 0);
    e.lobeHi.assign(static_cast<size_t>(B), 0);
    for (int b = 0; b < B; ++b)
    {
        const double fb = bandHz_[static_cast<size_t>(b)];
        const double exUp = std::max(fb * gapUp, fb + kGapBins * binHz);
        const double exDn = std::min(fb / gapUp, fb - kGapBins * binHz);
        const double outUp = exUp * flank, outDn = exDn / flank;
        int lo = b, hi = b;
        while (lo > 0 && bandHz_[static_cast<size_t>(lo - 1)] > exDn) --lo;
        while (hi < B - 1 && bandHz_[static_cast<size_t>(hi + 1)] < exUp) ++hi;
        e.lobeLo[static_cast<size_t>(b)] = lo;
        e.lobeHi[static_cast<size_t>(b)] = hi;
        for (int s = 0; s < 2; ++s)
        {
            double fMin = 1.0e30, fMax = 0.0, vfSum = 0.0, xSum = 0.0;
            int count = 0;
            for (int j = 0; j < B; ++j)
            {
                const double fj = bandHz_[static_cast<size_t>(j)];
                const bool in = s == 0 ? (exDn > 0.0 && fj <= exDn && fj >= outDn) : (fj >= exUp && fj <= outUp);
                if (!in) continue;
                e.fl[s].push_back(j);
                fMin = std::min(fMin, fj); fMax = std::max(fMax, fj);
                vfSum += e.vfBin[static_cast<size_t>(j)];
                xSum += bandX_[static_cast<size_t>(j)];
                ++count;
            }
            e.flStart[s][static_cast<size_t>(b) + 1] = static_cast<int>(e.fl[s].size());
            if (count > 0)
            {
                e.sideX[s][static_cast<size_t>(b)] = static_cast<float>(xSum / count);
                e.sideVf[s][static_cast<size_t>(b)] = static_cast<float>(vfSum / count);
                // Independent information on this flank: the bins it spans (adjacent bins correlate, hence
                // the 1.5) divided by the effective bins per band level, capped at the band count.
                const double effBins = ((fMax - fMin) / binHz + 2.0) / 1.5;
                const double binsPerBand = 1.0 / std::max(vfSum / count, 1.0e-6);
                e.sideNeff[s][static_cast<size_t>(b)] = static_cast<float>(std::clamp(effBins / binsPerBand, 1.0, static_cast<double>(count)));
            }
        }
    }

    // --- sub-bin correction constants: kernel ENBW, the bins where an ERB is narrower than it, and the second
    //     moment a narrowband source shows over +/-2 bins around its peak bin (averaged over sub-bin offsets) ---
    {
        double sw = 0.0;
        for (int n = 0; n < N; ++n) sw += window[static_cast<size_t>(n)];
        const double enbwBins = N * sumW2 / (sw * sw);
        auto erbHz = [](double f) { return 24.7 * (4.37 * f / 1000.0 + 1.0); };
        e.kLowMax = 0;
        for (int k = 1; k < nb - 3; ++k) if (erbHz(k * binHz) < enbwBins * binHz) e.kLowMax = k;
        e.erbBins.assign(static_cast<size_t>(nb), 1.0f);
        for (int k = 0; k < nb; ++k) e.erbBins[static_cast<size_t>(k)] = static_cast<float>(erbHz(k * binHz) / binHz);
        auto kernel = [&](double f)   // |W(f)|^2 / |W(0)|^2, f in bins
        {
            double re = 0.0, im = 0.0;
            for (int n = 0; n < N; ++n)
            {
                const double ph = -2.0 * juce::MathConstants<double>::pi * f * n / N;
                re += window[static_cast<size_t>(n)] * std::cos(ph);
                im += window[static_cast<size_t>(n)] * std::sin(ph);
            }
            return (re * re + im * im) / (sw * sw);
        };
        double varSum = 0.0; int cnt = 0;
        for (int i = 0; i < 32; ++i)
        {
            const double delta = (i + 0.5) / 32.0;          // source at bin 10 + delta
            double x[9];
            int k0 = 0;
            for (int j = 0; j < 9; ++j) { x[j] = kernel((j - 4) - delta); if (x[j] > x[k0]) k0 = j; }
            double m = 0.0, c = 0.0;
            for (int j = std::max(0, k0 - 2); j <= std::min(8, k0 + 2); ++j) { m += x[j]; c += j * x[j]; }
            c /= m;
            double v = 0.0;
            for (int j = std::max(0, k0 - 2); j <= std::min(8, k0 + 2); ++j) v += (j - c) * (j - c) * x[j];
            varSum += v / m; ++cnt;
        }
        e.kernelVar = static_cast<float>(varSum / cnt);
    }

    // --- bin -> band interpolation (ERB axis) for G(f) ---
    e.binBand.assign(static_cast<size_t>(nb), 0);
    e.binFrac.assign(static_cast<size_t>(nb), 0.0f);
    for (int k = 0; k < nb; ++k)
    {
        const double x = (erbRate(k * binHz) - erbLo_) / erbStep_;
        int j; double t;
        if (x <= 0.0) { j = 0; t = 0.0; }
        else if (x >= B - 1) { j = B - 2; t = 1.0; }
        else { j = static_cast<int>(std::floor(x)); t = x - j; }
        e.binBand[static_cast<size_t>(k)] = j;
        e.binFrac[static_cast<size_t>(k)] = static_cast<float>(t);
    }

    // --- per-channel state and per-band statistics ---
    const auto Bs = static_cast<size_t>(B);
    for (int c = 0; c < kMaxChannels; ++c)
    {
        auto& ch = e.ch[c];
        ch.outAcc.assign(static_cast<size_t>(N), 0.0f);
        ch.outFifo.assign(static_cast<size_t>(H), 0.0f);
        ch.fftBuf.assign(static_cast<size_t>(N) * 2, 0.0f);
        ch.binGain.assign(static_cast<size_t>(nb), 1.0f);
        ch.powAvg.assign(static_cast<size_t>(nb), 0.0f);
        ch.powAvgF.assign(static_cast<size_t>(nb), 0.0f);
        ch.levelDb.assign(Bs, 0.0f);
        ch.baseDb.assign(Bs, 0.0f);
        ch.levelFDb.assign(Bs, 0.0f);
        ch.baseFDb.assign(Bs, 0.0f);
        ch.fastOwns.assign(Bs, 0);
        ch.redDb.assign(Bs, 0.0f);
        ch.smoothDb.assign(Bs, 0.0f);
        ch.outDb.assign(Bs, 0.0f);
        ch.exAdjDb.assign(Bs, 0.0f);
    }
    e.sigmaE.assign(Bs, 0.0f);
    e.sigmaEF.assign(Bs, 0.0f);
}

// sigma_E per band for the engine's current number of averaged frames.
void Core::updateSigma(Engine& e) noexcept
{
    updateSigmaFor(e, e.vfTime, e.frames, e.sigmaE);
    if (fastTauMs_ > 0.0f) updateSigmaFor(e, e.vfTimeF, e.frames, e.sigmaEF);
}

void Core::updateSigmaFor(const Engine& e, const std::vector<double>& vfTime, long long frames, std::vector<float>& sigmaOut) noexcept
{
    const auto nMax = static_cast<long long>(vfTime.size());
    const double vt = vfTime[static_cast<size_t>(std::clamp<long long>(frames + 1, 1, nMax) - 1)];
    const double halfPi = 0.5 * juce::MathConstants<double>::pi;
    for (int b = 0; b < numBands_; ++b)
    {
        const double sL = levelSigmaDb(vt * e.vfBin[static_cast<size_t>(b)]);
        // Baseline = w0 m0 + w1 m1 (line through the flank medians); var(median) ~ (pi/2) sigma^2 / n_eff.
        const auto bi = static_cast<size_t>(b);
        const bool has0 = e.flStart[0][bi + 1] > e.flStart[0][bi], has1 = e.flStart[1][bi + 1] > e.flStart[1][bi];
        double w[2] = { has0 ? 1.0 : 0.0, has1 ? 1.0 : 0.0 };
        if (has0 && has1)
        {
            w[0] = (e.sideX[1][bi] - bandX_[bi]) / (e.sideX[1][bi] - e.sideX[0][bi]);
            w[1] = 1.0 - w[0];
        }
        double varBase = 0.0;
        for (int s = 0; s < 2; ++s)
        {
            if (w[s] == 0.0) continue;
            const double sv = levelSigmaDb(vt * e.sideVf[s][bi]);
            varBase += w[s] * w[s] * halfPi * sv * sv / e.sideNeff[s][bi];
        }
        sigmaOut[static_cast<size_t>(b)] = static_cast<float>(std::sqrt(sL * sL + varBase));
    }
}

void Core::release()
{
    for (auto& e : eng_)
    {
        e.fft.reset();
        for (auto* v : { &e.window, &e.synthesis, &e.bwW, &e.vfBin, &e.binFrac, &e.sideX[0], &e.sideX[1], &e.sideVf[0], &e.sideVf[1],
                         &e.sideNeff[0], &e.sideNeff[1], &e.sigmaE, &e.sigmaEF, &e.erbBins })
        { v->clear(); v->shrink_to_fit(); }
        for (auto* v : { &e.bwStart, &e.bwBin, &e.flStart[0], &e.flStart[1], &e.fl[0], &e.fl[1], &e.lobeLo, &e.lobeHi, &e.binBand })
        { v->clear(); v->shrink_to_fit(); }
        e.vfTime.clear(); e.vfTime.shrink_to_fit();
        e.vfTimeF.clear(); e.vfTimeF.shrink_to_fit();
        for (auto& ch : e.ch)
        {
            for (auto* v : { &ch.outAcc, &ch.outFifo, &ch.fftBuf, &ch.binGain, &ch.powAvg, &ch.powAvgF,
                             &ch.levelDb, &ch.baseDb, &ch.levelFDb, &ch.baseFDb, &ch.redDb, &ch.smoothDb, &ch.outDb, &ch.exAdjDb })
            { v->clear(); v->shrink_to_fit(); }
            ch.fastOwns.clear(); ch.fastOwns.shrink_to_fit();
        }
        e.N = e.H = 0;
        e.hopOffset = 0;
        e.frames = 0;
    }
    for (auto& r : ring_) { r.clear(); r.shrink_to_fit(); }
    auxRing_.clear(); auxRing_.shrink_to_fit();
    for (auto* v : { &binX_, &binF_, &scratch_, &tmpBand_, &estBand_, &bandHz_, &bandX_ }) { v->clear(); v->shrink_to_fit(); }
    prepared_ = false;
    trans_ = Transition{};
    numChannels_ = numBands_ = 0;
    frames_ = 0;
    pos_ = 0;
    latency_.store(0, std::memory_order_relaxed);
    for (auto& m : meterCh_) m.store(0.0f, std::memory_order_relaxed);
    meterAll_.store(0.0f, std::memory_order_relaxed);
}

void Core::resetEngine(Engine& e) noexcept
{
    for (auto& ch : e.ch)
    {
        for (auto* v : { &ch.outAcc, &ch.outFifo, &ch.fftBuf, &ch.powAvg, &ch.powAvgF,
                         &ch.levelDb, &ch.baseDb, &ch.levelFDb, &ch.baseFDb, &ch.redDb, &ch.smoothDb, &ch.outDb, &ch.exAdjDb })
            std::fill(v->begin(), v->end(), 0.0f);
        std::fill(ch.binGain.begin(), ch.binGain.end(), 1.0f);
        std::fill(ch.fastOwns.begin(), ch.fastOwns.end(), static_cast<unsigned char>(0));
        ch.refMeanS = ch.refMeanF = 0.0f;
    }
    std::fill(e.sigmaE.begin(), e.sigmaE.end(), 0.0f);
    std::fill(e.sigmaEF.begin(), e.sigmaEF.end(), 0.0f);
    e.frames = 0;
    e.emaAn = 1.0;
    e.emaAnF = 1.0;
    e.forceRefresh = false;
    // The first frame completes after H - offset input samples (0 unless setHopPhaseOffset() was used before prepare()).
    e.nextEnd = e.H - e.hopOffset;
}

void Core::reset() noexcept
{
    if (!prepared_) return;
    // A transition in progress completes at once: the core continues on the requested tier, as a fresh instance of that tier would.
    trans_ = Transition{};
    active_ = target_;
    for (auto& e : eng_) resetEngine(e);
    for (auto& r : ring_) std::fill(r.begin(), r.end(), 0.0f);
    std::fill(auxRing_.begin(), auxRing_.end(), 0.0f);
    pos_ = 0;
    frames_ = 0;
    activeTier_.store(active_, std::memory_order_relaxed);
    latency_.store(eng_[active_].N, std::memory_order_relaxed);
    for (auto& m : meterCh_) m.store(0.0f, std::memory_order_relaxed);
    meterAll_.store(0.0f, std::memory_order_relaxed);
}

void Core::ringWrite(float* r, long long at, const float* src, int n) const noexcept
{
    const auto len = static_cast<int>(ringMask_ + 1);
    const int i0 = static_cast<int>(at & ringMask_);
    const int first = std::min(n, len - i0);
    std::memcpy(r + i0, src, sizeof(float) * static_cast<size_t>(first));
    if (n > first) std::memcpy(r, src + first, sizeof(float) * static_cast<size_t>(n - first));
}

void Core::ringRead(const float* r, long long at, float* dst, int n) const noexcept
{
    const auto len = static_cast<int>(ringMask_ + 1);
    const int i0 = static_cast<int>(at & ringMask_);
    const int first = std::min(n, len - i0);
    std::memcpy(dst, r + i0, sizeof(float) * static_cast<size_t>(first));
    if (n > first) std::memcpy(dst + first, r, sizeof(float) * static_cast<size_t>(n - first));
}

void Core::process(float* const* channels, int numChannels, int numSamples, const Params& pIn, float* const* dryOut, const float* auxIn, float* auxOut) noexcept
{
    if (!prepared_ || channels == nullptr || numSamples <= 0) return;
    const int nCh = std::min(numChannels, numChannels_);
    if (nCh <= 0) return;

    const Params p = sanitizeParams(pIn);
    if (!trans_.active) adoptPendingTier(nCh, p);

    const Io io { channels, dryOut, auxIn, auxIn != nullptr ? auxOut : nullptr };
    int pos = 0;
    while (pos < numSamples)
        pos += trans_.active ? processTransition(io, nCh, pos, numSamples - pos, p)
                             : processSteady(io, nCh, pos, numSamples - pos, p);
}

// One chunk on the engine in use, up to its next frame boundary. Input first (in-place buffers): it goes into the ring, then the output that
// was finished one hop ago is handed out. Output time t leaves at real time t + N.
int Core::processSteady(const Io& io, int nCh, int offset, int n, const Params& p) noexcept
{
    Engine& e = eng_[active_];
    const int toEnd = static_cast<int>(e.nextEnd - pos_);   // 1 .. H
    const int k = std::min(n, toEnd);
    const int fill = e.H - toEnd;
    for (int c = 0; c < nCh; ++c)
    {
        float* x = io.channels[c] + offset;
        ringWrite(ring_[c].data(), pos_, x, k);
        std::memcpy(x, e.ch[c].outFifo.data() + fill, sizeof(float) * static_cast<size_t>(k));
        if (io.dryOut != nullptr && io.dryOut[c] != nullptr) ringRead(ring_[c].data(), pos_ - e.N, io.dryOut[c] + offset, k);
    }
    if (io.auxIn != nullptr)
    {
        ringWrite(auxRing_.data(), pos_, io.auxIn + offset, k);
        if (io.auxOut != nullptr) ringRead(auxRing_.data(), pos_ - e.N, io.auxOut + offset, k);
    }
    pos_ += k;
    if (pos_ == e.nextEnd)
    {
        processFrame(e, e.nextEnd, nCh, p, true);
        e.nextEnd += e.H;
    }
    return k;
}

// One chunk of a transition, up to the next frame boundary of either engine (the crossfade start is a frame boundary of the new engine).
//   pos_ <  valid: the output, the meters and the introspection are the old engine's (bit-identical to steady state); the new engine warms up unpublished.
//   pos_ >= valid: y = A + r (B - A), dry = x[t - N_A] + r (x[t - N_B] - x[t - N_A]), r = min(1, (t - valid + 1) / F); the new engine publishes.
int Core::processTransition(const Io& io, int nCh, int offset, int n, const Params& p) noexcept
{
    Engine& A = eng_[trans_.from];
    Engine& B = eng_[trans_.to];
    const int toA = static_cast<int>(A.nextEnd - pos_), toB = static_cast<int>(B.nextEnd - pos_);
    const int k = std::min(n, std::min(toA, toB));
    const int fillA = A.H - toA, fillB = B.H - toB;
    const bool fading = pos_ >= trans_.valid;
    const float invF = 1.0f / static_cast<float>(fadeLen_);
    for (int c = 0; c < nCh; ++c)
    {
        float* x = io.channels[c] + offset;
        const float* ring = ring_[c].data();
        ringWrite(ring_[c].data(), pos_, x, k);
        const float* a = A.ch[c].outFifo.data() + fillA;
        float* d = (io.dryOut != nullptr) ? io.dryOut[c] : nullptr;
        if (!fading)
        {
            std::memcpy(x, a, sizeof(float) * static_cast<size_t>(k));
            if (d != nullptr) ringRead(ring, pos_ - A.N, d + offset, k);
            continue;
        }
        const float* b = B.ch[c].outFifo.data() + fillB;
        for (int i = 0; i < k; ++i)
        {
            const long long t = pos_ + i;
            const long long since = t - trans_.valid + 1;
            if (since >= fadeLen_)
            {
                // Crossfade complete: exactly the new engine (and the new delay).
                x[i] = b[i];
                if (d != nullptr) d[offset + i] = ringAt(ring, t - B.N);
                continue;
            }
            const float r = static_cast<float>(since) * invF;
            x[i] = a[i] + r * (b[i] - a[i]);
            if (d != nullptr)
            {
                const float da = ringAt(ring, t - A.N), db = ringAt(ring, t - B.N);
                d[offset + i] = da + r * (db - da);
            }
        }
    }
    if (io.auxIn != nullptr)
    {
        // The delay-only channel: the dry timeline, nothing else.
        const float* ring = auxRing_.data();
        ringWrite(auxRing_.data(), pos_, io.auxIn + offset, k);
        if (io.auxOut != nullptr)
        {
            float* d = io.auxOut + offset;
            if (!fading) ringRead(ring, pos_ - A.N, d, k);
            else
                for (int i = 0; i < k; ++i)
                {
                    const long long t = pos_ + i;
                    const long long since = t - trans_.valid + 1;
                    const float db = ringAt(ring, t - B.N);
                    if (since >= fadeLen_) { d[i] = db; continue; }
                    const float da = ringAt(ring, t - A.N);
                    d[i] = da + static_cast<float>(since) * invF * (db - da);
                }
        }
    }
    pos_ += k;
    if (pos_ == A.nextEnd)
    {
        processFrame(A, A.nextEnd, nCh, p, A.nextEnd < trans_.valid);   // the old engine publishes until the crossfade starts
        A.nextEnd += A.H;
    }
    if (pos_ == B.nextEnd)
    {
        if (B.nextEnd == trans_.valid)
        {
            // The new engine's first complete output starts here: the output timeline (and everything that describes it) moves to the new tier.
            active_ = trans_.to;
            activeTier_.store(trans_.to, std::memory_order_relaxed);
            latency_.store(B.N, std::memory_order_relaxed);
        }
        processFrame(B, B.nextEnd, nCh, p, B.nextEnd >= trans_.valid);
        B.nextEnd += B.H;
    }
    if (pos_ >= trans_.valid + fadeLen_) trans_.active = false;    // r reached 1: the old engine stops
    return k;
}

// Start of a process() call, no transition running: adopt a pending request.
void Core::adoptPendingTier(int nCh, const Params& p) noexcept
{
    if (pendingTier_.load(std::memory_order_relaxed) < 0) return;   // common case: one relaxed load per call
    const int req = pendingTier_.exchange(-1, std::memory_order_acquire);
    if (req < 0 || req > 2 || req == active_) return;               // nothing new (the same tier is consumed and ignored)

    Engine& A = eng_[active_];
    Engine& B = eng_[req];
    for (auto& ch : B.ch)
    {
        std::fill(ch.outAcc.begin(), ch.outAcc.end(), 0.0f);
        std::fill(ch.outFifo.begin(), ch.outFifo.end(), 0.0f);
    }
    if (keepState_) transferState(A, B, nCh);
    else
    {
        resetEngine(B);
    }
    // B's grid: frames end at e with (e + offset) % H == 0. Its first frame is the last grid point <= pos_, computed now from the ring (the input
    // up to it is there); its output is complete from 3 hops later on.
    const long long m = ((pos_ + B.hopOffset) / B.H) * B.H - B.hopOffset;
    processFrame(B, m, nCh, p, false);
    B.nextEnd = m + B.H;
    trans_.active = true;
    trans_.from = active_;
    trans_.to = req;
    trans_.valid = m + 3LL * B.H;
    target_ = req;
    switches_.fetch_add(1, std::memory_order_relaxed);
}

// Grid-domain state (per-band reductions, release latches) is copied; the bin-domain power averages are remapped to the new bins with the
// |X|^2 scaling of a noise-like input (x N_to / N_from); the bias-correction products a^n are the same function of time at every tier (a^n =
// exp(-t / tau)) and are copied; the frame count is converted through time (sigma tables, stagger); every baseline is recomputed on the
// next frame. Measured in test T-C (ResonanceCore.md 9.4).
void Core::transferState(const Engine& from, Engine& to, int nCh) noexcept
{
    const auto bytes = sizeof(float) * static_cast<size_t>(numBands_);
    for (int c = 0; c < kMaxChannels; ++c)
    {
        const Channel& s = from.ch[c];
        Channel& d = to.ch[c];
        if (c < nCh)
        {
            remapPower(from, to, s.powAvg.data(), d.powAvg.data());
            remapPower(from, to, s.powAvgF.data(), d.powAvgF.data());
        }
        else
        {
            std::fill(d.powAvg.begin(), d.powAvg.end(), 0.0f);
            std::fill(d.powAvgF.begin(), d.powAvgF.end(), 0.0f);
        }
        std::memcpy(d.redDb.data(), s.redDb.data(), bytes);
        std::memcpy(d.smoothDb.data(), s.smoothDb.data(), bytes);
        std::memcpy(d.outDb.data(), s.outDb.data(), bytes);
        std::memcpy(d.levelDb.data(), s.levelDb.data(), bytes);
        std::memcpy(d.baseDb.data(), s.baseDb.data(), bytes);
        std::memcpy(d.levelFDb.data(), s.levelFDb.data(), bytes);
        std::memcpy(d.baseFDb.data(), s.baseFDb.data(), bytes);
        std::memcpy(d.exAdjDb.data(), s.exAdjDb.data(), bytes);
        std::memcpy(d.fastOwns.data(), s.fastOwns.data(), static_cast<size_t>(numBands_));
        d.refMeanS = s.refMeanS;
        d.refMeanF = s.refMeanF;
    }
    to.emaAn = from.emaAn;
    to.emaAnF = from.emaAnF;
    to.frames = static_cast<long long>(std::llround(static_cast<double>(from.frames) * from.H / to.H));
    to.forceRefresh = true;
    updateSigma(to);
}

// dst (bins of `to`) from src (bins of `from`), scaled by N_to / N_from. Finer target: linear interpolation at the target bin's frequency.
// Coarser target (r = N_from / N_to = 2 or 4): triangular average over the source bins within +-r of it (a source peak between two target bins
// is shared, not dropped).
void Core::remapPower(const Engine& from, const Engine& to, const float* src, float* dst) noexcept
{
    const int nbF = from.N / 2 + 1, nbT = to.N / 2 + 1;
    const double scale = static_cast<double>(to.N) / from.N;
    if (to.N >= from.N)
    {
        const int r = to.N / from.N;   // 1, 2 or 4
        for (int k = 0; k < nbT; ++k)
        {
            const int k0 = k / r;
            const int k1 = std::min(k0 + 1, nbF - 1);
            const double t = static_cast<double>(k - k0 * r) / r;
            dst[k] = static_cast<float>(scale * (src[k0] + t * (static_cast<double>(src[k1]) - src[k0])));
        }
    }
    else
    {
        const int r = from.N / to.N;   // 2 or 4
        for (int k = 0; k < nbT; ++k)
        {
            const int centre = k * r;
            double acc = 0.0, wsum = 0.0;
            for (int j = centre - r + 1; j <= centre + r - 1; ++j)
            {
                if (j < 0 || j >= nbF) continue;
                const double w = 1.0 - std::abs(j - centre) / static_cast<double>(r);
                acc += w * src[j];
                wsum += w;
            }
            dst[k] = static_cast<float>(scale * (wsum > 0.0 ? acc / wsum : 0.0));
        }
    }
}

void Core::processFrame(Engine& e, long long end, int numCh, const Params& p, bool publish) noexcept
{
    const int N = e.N, H = e.H;
    const int nb = N / 2 + 1;

    // Analysis: the window ending at `end`, read from the input ring (positions before the stream start are zeros).
    const auto len = static_cast<int>(ringMask_ + 1);
    const int i0 = static_cast<int>((end - N) & ringMask_);
    const int first = std::min(N, len - i0);
    for (int c = 0; c < numCh; ++c)
    {
        auto& ch = e.ch[c];
        float* buf = ch.fftBuf.data();
        const float* in = ring_[c].data();
        const float* w = e.window.data();
        for (int n = 0; n < first; ++n) buf[n] = in[i0 + n] * w[n];
        for (int n = first; n < N; ++n) buf[n] = in[n - first] * w[n];
        std::fill(buf + N, buf + 2 * N, 0.0f);
        e.fft->performRealOnlyForwardTransform(buf, true);
    }

    const bool applyGain = computeGains(e, numCh, p, publish);

    for (int c = 0; c < numCh; ++c)
    {
        auto& ch = e.ch[c];
        float* buf = ch.fftBuf.data();
        if (applyGain)
        {
            const float* g = ch.binGain.data();
            for (int k = 0; k < nb; ++k)
            {
                buf[2 * k]     *= g[k];
                buf[2 * k + 1] *= g[k];
            }
        }
        e.fft->performRealOnlyInverseTransform(buf);

        // Overlap-add: drop the hop that was handed out, append an empty hop, add this frame.
        float* acc = ch.outAcc.data();
        std::memmove(acc, acc + H, sizeof(float) * static_cast<size_t>(N - H));
        std::fill(acc + (N - H), acc + N, 0.0f);
        const float* sw = e.synthesis.data();
        for (int n = 0; n < N; ++n) acc[n] += buf[n] * sw[n];
        // acc[0, H) has now received all N/H overlapping frames: it is final.
        std::memcpy(ch.outFifo.data(), acc, sizeof(float) * static_cast<size_t>(H));
    }
    if (publish)
    {
        if (vizSink_ != nullptr) emitViz(e, numCh);
        ++frames_;
    }
    ++e.frames;
}

// One VizFrame per processed channel, filled in place (no allocation), handed to the sink synchronously.
void Core::emitViz(const Engine& e, int numCh) noexcept
{
    VizFrame& f = vizFrame_;
    const bool fast = fastTauMs_ > 0.0f;
    const auto bytes = sizeof(float) * static_cast<size_t>(numBands_);
    for (int c = 0; c < numCh; ++c)
    {
        const auto& ch = e.ch[c];
        f.hopIndex = frames_;
        f.channel = c;
        f.numBands = numBands_;
        f.hopSize = e.H;
        f.maxReductionDb = meterCh_[c].load(std::memory_order_relaxed);
        std::memcpy(f.levelDb, fast ? ch.levelFDb.data() : ch.levelDb.data(), bytes);
        std::memcpy(f.baselineDb, fast ? ch.baseFDb.data() : ch.baseDb.data(), bytes);
        std::memcpy(f.reductionDb, ch.outDb.data(), bytes);
        vizSink_->onResonanceFrame(f);
    }
}

int Core::hopPhaseOffsetForInstance(int instanceIndex, int hop) noexcept
{
    if (instanceIndex <= 0 || hop <= 1) return 0;
    // Base-2 van der Corput: mirror the binary digits of the index around the binary point (1 -> .1, 2 -> .01, 3 -> .11, 4 -> .001, ...).
    double v = 0.0, digit = 0.5;
    for (unsigned i = static_cast<unsigned>(instanceIndex); i != 0u; i >>= 1, digit *= 0.5)
        if ((i & 1u) != 0u) v += digit;
    const int off = static_cast<int>(std::floor(v * hop));
    return std::clamp(off, 0, hop - 1);
}

float Core::median(const int* idx, int n, const float* values) noexcept
{
    float* s = scratch_.data();
    for (int i = 0; i < n; ++i) s[i] = values[idx[i]];
    const int m = n / 2;
    std::nth_element(s, s + m, s + n);
    const float hi = s[m];
    if ((n & 1) != 0) return hi;
    const float lo = *std::max_element(s, s + m);
    return 0.5f * (lo + hi);
}

void Core::detectChannel(Engine& e, Channel& ch, double biasCorr, double biasCorrFast) noexcept
{
    const int nb = e.N / 2 + 1;
    const float* X = ch.fftBuf.data();
    float* S = ch.powAvg.data();
    const float ea = e.emaA, eb = e.emaB;
    if (fastTauMs_ > 0.0f)
    {
        float* SF = ch.powAvgF.data();
        const float fa = e.emaAF, fb = e.emaBF;
        for (int k = 0; k < nb; ++k)
        {
            const float re = X[2 * k], im = X[2 * k + 1], pw = re * re + im * im;
            S[k]  = ea * S[k]  + eb * pw;
            SF[k] = fa * SF[k] + fb * pw;
        }
        bandLevelsAndBaseline(e, SF, ch.levelFDb.data(), ch.baseFDb.data(), biasCorrFast, e.fastPeriod, ch.refMeanF);
    }
    else
    {
        for (int k = 0; k < nb; ++k)
        {
            const float re = X[2 * k], im = X[2 * k + 1];
            S[k] = ea * S[k] + eb * (re * re + im * im);
        }
    }
    bandLevelsAndBaseline(e, S, ch.levelDb.data(), ch.baseDb.data(), biasCorr, e.slowPeriod, ch.refMeanS);
}

// Band levels (dB, per octave) of the averaged bin powers S and their flank baseline.
void Core::bandLevelsAndBaseline(const Engine& e, const float* S, float* L, float* base, double biasCorr, int refreshPeriod, float& refMean) noexcept
{
    for (int band = 0; band < numBands_; ++band)
    {
        double acc = 0.0;
        for (int i = e.bwStart[static_cast<size_t>(band)]; i < e.bwStart[static_cast<size_t>(band) + 1]; ++i)
            acc += static_cast<double>(e.bwW[static_cast<size_t>(i)]) * S[e.bwBin[static_cast<size_t>(i)]];
        L[band] = static_cast<float>(10.0 * std::log10(acc * biasCorr + 1.0e-30));
    }

    // Wideband tilt (dB per octave, least squares over 200 Hz .. 10 kHz): only used to carry a ONE-sided flank
    // to the band centre at the edges of the grid. A resonance is one band among ~70 here, so it barely moves it.
    double slope = 0.0;
    if (slopeHi_ > slopeLo_)
    {
        double mean = 0.0;
        for (int b = slopeLo_; b <= slopeHi_; ++b) mean += L[b];
        mean /= (slopeHi_ - slopeLo_ + 1);
        double sxy = 0.0;
        for (int b = slopeLo_; b <= slopeHi_; ++b) sxy += (bandX_[static_cast<size_t>(b)] - slopeXMean_) * (L[b] - mean);
        slope = sxy / slopeSxx_;
    }

    // Baseline = the straight line (dB over log2 f) through the two flank medians, evaluated at the band. Exact for
    // any locally linear tilt even when the flanks sit at different distances (at low f the bin-limited exclusion is
    // asymmetric). One-sided bands: the flank median carried along the wideband tilt.
    float meanL = 0.0f;
    for (int b = 0; b < numBands_; ++b) meanL += L[b];
    meanL /= static_cast<float>(numBands_);
    const long long frames = e.frames;
    const bool all = frames < refreshPeriod || e.forceRefresh || std::abs(meanL - refMean) > kBaselineJumpDb;
    if (all) refMean = meanL;
    for (int band = 0; band < numBands_; ++band)
    {
        if (!all && ((band + static_cast<int>(frames % refreshPeriod)) % refreshPeriod) != 0) continue;   // keep the last refresh
        const auto bi = static_cast<size_t>(band);
        float m[2] = { 0.0f, 0.0f }; bool has[2] = { false, false };
        for (int s = 0; s < 2; ++s)
        {
            const int i0 = e.flStart[s][bi], i1 = e.flStart[s][bi + 1];
            if (i1 <= i0) continue;
            m[s] = median(e.fl[s].data() + i0, i1 - i0, L);
            has[s] = true;
        }
        const float x = bandX_[bi];
        if (has[0] && has[1])
        {
            const float x0 = e.sideX[0][bi], x1 = e.sideX[1][bi];
            base[band] = m[0] + (m[1] - m[0]) * (x - x0) / (x1 - x0);
        }
        else if (has[0] || has[1])
        {
            const int s = has[0] ? 0 : 1;
            base[band] = m[s] + static_cast<float>(slope) * (x - e.sideX[s][bi]);
        }
        else base[band] = L[band];
    }
}

// Low-frequency target at auditory resolution. Below ~300 Hz (48 kHz, N = 1024) an ERB is narrower than the analysis
// kernel, so a narrow resonance is diluted in its bin. Around each local peak bin: excess mass M (sum of the excess
// fractions over +/-2 bins = the source's excess power over the noise density, in bins), source width from the second
// moment with the kernel's own moment removed, and the excess an auditory filter centred on it would see,
// x_aud = M / max(ERB, W_src). Never lowers an estimate; broad humps (W_src >= ERB) are unchanged. The detection
// decision stays on the uncorrected (statistically calibrated) excess; only the depth of the cut uses this.
void Core::subBinCorrection(const Engine& e, Channel& ch, double biasCorr) noexcept
{
    const int B = numBands_;
    const float* L = ch.levelDb.data();
    const float* base = ch.baseDb.data();
    float* adj = ch.exAdjDb.data();
    for (int b = 0; b < B; ++b) adj[b] = L[b] - base[b];
    if (e.kLowMax < 1) return;

    const int nb = e.N / 2 + 1;
    const int kMax = std::min(e.kLowMax + 2, nb - 1);
    const double binHz = sampleRate_ / e.N;
    const float* S = ch.powAvg.data();
    float* x = binX_.data();
    float* F = binF_.data();
    for (int k = 1; k <= kMax; ++k)
    {
        const int j = e.binBand[static_cast<size_t>(k)];
        const float t = e.binFrac[static_cast<size_t>(k)];
        const float bk = base[j] + t * (base[j + 1] - base[j]);
        const double lev = 10.0 * std::log10(static_cast<double>(S[k]) * k * binHz * biasCorr + 1.0e-30);
        x[k] = std::max(static_cast<float>(std::pow(10.0, (lev - bk) * 0.1)) - 1.0f, 0.0f);
        F[k] = 1.0f;
    }
    x[0] = 0.0f;
    for (int k0 = 1; k0 <= e.kLowMax; ++k0)
    {
        if (!(x[k0] > 0.0f) || x[k0] < x[k0 - 1] || x[k0] < x[k0 + 1]) continue;
        const int j0 = std::max(1, k0 - 2), j1 = std::min(kMax, k0 + 2);
        float m = 0.0f, c = 0.0f;
        for (int j = j0; j <= j1; ++j) { m += x[j]; c += static_cast<float>(j) * x[j]; }
        c /= m;
        float v = 0.0f;
        for (int j = j0; j <= j1; ++j) v += (static_cast<float>(j) - c) * (static_cast<float>(j) - c) * x[j];
        v /= m;
        const float wSrc = std::sqrt(12.0f * std::max(v - e.kernelVar, 0.0f));
        const float xAud = m / std::max(e.erbBins[static_cast<size_t>(k0)], wSrc);
        const float f = std::max(1.0f, xAud / x[k0]);
        for (int j = std::max(1, k0 - 1); j <= std::min(kMax, k0 + 1); ++j) F[j] = std::max(F[j], f);
    }
    const float fTop = static_cast<float>(kMax * binHz);
    for (int b = 0; b < B && bandHz_[static_cast<size_t>(b)] < fTop; ++b)
    {
        if (!(adj[b] > 0.0f)) continue;
        const float pos = bandHz_[static_cast<size_t>(b)] / static_cast<float>(binHz);
        int k = static_cast<int>(pos);
        float t = pos - static_cast<float>(k);
        if (k < 1) { k = 1; t = 0.0f; }
        if (k >= kMax) { k = kMax - 1; t = 1.0f; }
        const float fb = F[k] + t * (F[k + 1] - F[k]);
        if (fb <= 1.0f) continue;
        const float xb = std::pow(10.0f, adj[b] * 0.1f) - 1.0f;
        adj[b] = 10.0f * std::log10(1.0f + xb * fb);
    }
}

bool Core::computeGains(Engine& e, int numCh, const Params& p, bool publish) noexcept
{
    // ---- per-frame derived parameters (a handful of transcendental calls) ----
    const float depth = std::clamp(p.depth, 0.0f, 1.0f);
    const bool  hard  = p.hardKnee;
    const float z     = thresholdSigmas(p.sensitivity);     // threshold in sigma_E: 6 (sens 0) .. 4 (default) .. 2 (sens 1)
    const float kappa = hard ? 1.5f : 3.0f;                 // knee width in sigma_E
    const float kappaFast = hard ? kFastKneeSigmasHard : kFastKneeSigmasSoft;   // knee width while the fast estimate is in charge
    const float rMax  = depth * (hard ? 24.0f : 12.0f);
    const double frameRate = sampleRate_ / e.H;
    const float aAtt  = xleth::dsp::onePoleStep(std::clamp(p.attackMs, 0.1f, 1000.0f) * 1.0e-3, frameRate);
    const float aRel  = xleth::dsp::onePoleStep(std::clamp(p.releaseMs, 1.0f, 10000.0f) * 1.0e-3, frameRate);
    const float link  = std::clamp(p.stereoLink, 0.0f, 1.0f);
    // Sharpness -> cross-band smoothing (NaN = the default 0.5). [sa sc sa] with sa = 0.25 at 0.5 (exactly the historical [1 2 1] / 4: sa = 0.25f and
    // sc = 1 - 2 sa = 0.5f are exact in float, so the default path computes the very same expression), fading to [0 1 0] at 1. Below 0.5 the result is
    // blended towards three further [1 2 1] / 4 passes ([1 2 1]^4 / 256 at 0).
    const float sharp   = p.sharpness >= 0.0f ? std::min(p.sharpness, 1.0f) : (p.sharpness < 0.0f ? 0.0f : 0.5f);
    const float sa      = sharp > 0.5f ? 0.5f * (1.0f - sharp) : 0.25f;
    const float sc      = 1.0f - 2.0f * sa;
    const float broaden = sharp < 0.5f ? 2.0f * (0.5f - sharp) : 0.0f;

    // ---- detector ----
    e.emaAn *= static_cast<double>(e.emaA);
    const double biasCorr = 1.0 / std::max(1.0 - e.emaAn, 1.0e-12);
    const bool fastOn = fastTauMs_ > 0.0f;
    double biasCorrFast = 1.0;
    if (fastOn)
    {
        e.emaAnF *= static_cast<double>(e.emaAF);
        biasCorrFast = 1.0 / std::max(1.0 - e.emaAnF, 1.0e-12);
    }
    // Both variance tables are indexed by the frame count; sigma is frozen once the longer (slow) one is in steady state.
    if (e.frames < static_cast<long long>(e.vfTime.size())) updateSigma(e);

    const int B = numBands_;
    for (int c = 0; c < numCh; ++c)
    {
        auto& ch = e.ch[c];
        detectChannel(e, ch, biasCorr, biasCorrFast);
        subBinCorrection(e, ch, biasCorr);
        const float* L = ch.levelDb.data();
        const float* base = ch.baseDb.data();
        const float* LF = ch.levelFDb.data();
        const float* baseF = ch.baseFDb.data();
        const float* adj = ch.exAdjDb.data();
        float* r = ch.redDb.data();
        // Estimate per band: the SLOW excess while the fast one is statistically consistent with it, the FAST excess where
        // the fast one is above it by kSwitchUpSigmas fast sigmas (onset) or, latched with hysteresis, below it by kVetoSetSigmas (release). The
        // threshold and the knee use the sigma of the estimate that is used, so the false-trigger rate stays set by statistics.
        // Salience knee per band, then gated over each band's main-lobe zone: once a resonance is confidently
        // detected anywhere in the zone, every band of the zone is reduced by ITS OWN excess (the resonance's
        // shoulders and, at low f, the analysis window's leakage of it into the neighbouring bins).
        float* kb = tmpBand_.data();
        float* est = estBand_.data();
        for (int b = 0; b < B; ++b)
        {
            const auto bi = static_cast<size_t>(b);
            const float es = L[b] - base[b];
            float ex = es, sig = e.sigmaE[bi], kap = kappa;
            est[b] = adj[b];   // excess at auditory resolution (== level - baseline above ~300 Hz)
            if (fastOn)
            {
                const float ef = LF[b] - baseF[b], sf = e.sigmaEF[bi];
                unsigned char& own = ch.fastOwns[bi];
                bool useFast = false;
                if (ef - es > kSwitchUpSigmas * sf) { own = 0; useFast = true; }          // onset
                else
                {
                    const float d = es - ef;                                               // release: latched with hysteresis
                    if (own != 0) { if (d < kVetoClearSigmas * sf) own = 0; }
                    else if (d > kVetoSetSigmas * sf) own = 1;
                    useFast = own != 0;
                }
                if (useFast)
                {
                    ex = ef; sig = sf; kap = kappaFast;
                    est[b] = ef + std::max(adj[b] - es, 0.0f);   // keep the sub-bin (low-f) depth correction of the slow path
                }
            }
            const float thr = z * sig;
            kb[b] = ex > thr ? smoothstep01((ex - thr) / (kap * sig)) : 0.0f;
        }
        for (int b = 0; b < B; ++b)
        {
            const float ev = est[b];
            float target = 0.0f;
            float k = 0.0f;
            if (ev > 0.0f && rMax > 0.0f)
                for (int j = e.lobeLo[static_cast<size_t>(b)]; j <= e.lobeHi[static_cast<size_t>(b)]; ++j) k = std::max(k, kb[j]);
            if (k > 0.0f)
            {
                const float raw = k * ev;
                const float x = raw / rMax;
                target = hard ? raw / std::pow(1.0f + (x * x) * (x * x) * (x * x), 1.0f / 6.0f)
                              : raw / std::sqrt(1.0f + x * x);
            }
            float v = r[b];
            v += (target > v ? aAtt : aRel) * (target - v);
            r[b] = v < 1.0e-7f ? 0.0f : v;
        }
        // Smoothing across frequency: [sa sc sa] ([1 2 1] / 4 at the default sharpness 0.5), edges replicated.
        float* sm = ch.smoothDb.data();
        for (int b = 0; b < B; ++b)
        {
            const float lo = r[b > 0 ? b - 1 : 0], hi = r[b < B - 1 ? b + 1 : B - 1];
            sm[b] = sa * lo + sc * r[b] + sa * hi;
        }
        if (broaden > 0.0f)
        {
            // Sharpness below 0.5: blend towards three further [1 2 1] / 4 passes. The per-band scratch arrays are free here (kb was consumed above,
            // the median scratch by the detector).
            auto pass = [B](const float* src, float* dst) noexcept
            {
                for (int b = 0; b < B; ++b)
                    dst[b] = 0.25f * src[b > 0 ? b - 1 : 0] + 0.5f * src[b] + 0.25f * src[b < B - 1 ? b + 1 : B - 1];
            };
            float* wa = tmpBand_.data();
            float* wb = scratch_.data();
            pass(sm, wa); pass(wa, wb); pass(wb, wa);
            for (int b = 0; b < B; ++b) sm[b] += broaden * (wa[b] - sm[b]);
        }
    }
    e.forceRefresh = false;

    // ---- stereo link: blend each channel towards max(L, R) ----
    for (int c = 0; c < numCh; ++c)
    {
        const float* own = e.ch[c].smoothDb.data();
        float* out = e.ch[c].outDb.data();
        if (numCh < 2 || link <= 0.0f) { std::memcpy(out, own, sizeof(float) * static_cast<size_t>(B)); continue; }
        const float* other = e.ch[1 - c].smoothDb.data();
        for (int b = 0; b < B; ++b) out[b] = own[b] + link * (std::max(own[b], other[b]) - own[b]);
    }

    // ---- weight curve (RS weighting semantics): w <= 1 scales the reduction, w > 1 deepens it up to the depth ceiling, never beyond (and never
    //      below the unweighted value, which may exceed a just-lowered ceiling while it releases). nullptr = flat 1: the loop is skipped.
    //      Intake hardening: a non-finite entry reads as 1 (the band is left unweighted), negative as 0, above kMaxWeight as kMaxWeight. ----
    if (p.weightCurve != nullptr)
    {
        const float* wc = p.weightCurve;
        for (int c = 0; c < numCh; ++c)
        {
            float* out = e.ch[c].outDb.data();
            for (int b = 0; b < B; ++b)
            {
                const float wr = wc[b];
                const float w = !finiteF(wr) ? 1.0f : (wr > 0.0f ? (wr < kMaxWeight ? wr : kMaxWeight) : 0.0f);
                const float v = out[b];
                out[b] = w <= 1.0f ? w * v : std::min(w * v, std::max(rMax, v));
            }
        }
    }

    // ---- meters: max applied band reduction of this frame (only from the engine the output is aligned to) ----
    if (publish)
    {
        float all = 0.0f;
        for (int c = 0; c < kMaxChannels; ++c)
        {
            float m = 0.0f;
            if (c < numCh)
            {
                const float* out = e.ch[c].outDb.data();
                for (int b = 0; b < B; ++b) m = std::max(m, out[b]);
            }
            meterCh_[c].store(m, std::memory_order_relaxed);
            all = std::max(all, m);
        }
        meterAll_.store(all, std::memory_order_relaxed);
    }

    // ---- G(f): band curve -> bins, real zero-phase gain ----
    bool any = false;
    const int nb = e.N / 2 + 1;
    for (int c = 0; c < numCh; ++c)
    {
        const float* out = e.ch[c].outDb.data();
        float* g = e.ch[c].binGain.data();
        for (int k = 0; k < nb; ++k)
        {
            const int j = e.binBand[static_cast<size_t>(k)];
            const float t = e.binFrac[static_cast<size_t>(k)];
            const float rdB = out[j] + t * (out[j + 1] - out[j]);
            if (rdB > 1.0e-6f) { g[k] = std::exp(-rdB * kLn10Over20); any = true; }
            else g[k] = 1.0f;
        }
    }
    return any;
}

} // namespace xleth::dsp::resonance
