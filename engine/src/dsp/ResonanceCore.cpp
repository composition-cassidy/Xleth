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
//     (kappa = 3 sigma Soft, 1.5 sigma Hard), then the max K over each band's main-lobe zone (the zone the
//     baseline excludes): a confidently detected resonance takes its shoulders (and at low f the window's
//     leakage of it) with it. Target reduction = K x E: the WHOLE excess, i.e. towards the baseline, not
//     "excess minus threshold" (that would leave the threshold standing as a residual).
//   * Below ~300 Hz (where an ERB is narrower than the analysis kernel) E for the depth (not for the
//     detection decision) is the excess at auditory resolution: see subBinCorrection().
//   * Depth caps the reduction smoothly: R = r / (1 + (r / Rmax)^p)^(1/p), Rmax = depth x 12 dB (Soft,
//     p = 2) or depth x 24 dB (Hard, p = 6).
//   * Per-band one-pole attack / release in dB at the frame rate (DspPrimitives onePoleStep convention),
//     then a [1 2 1] / 4 smoothing across bands, then the stereo link (blend towards max(L, R)).
//   * G(f): the band curve (dB) is interpolated linearly on the ERB axis to every bin and applied as a
//     real, zero-phase gain.

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
} // namespace

Core::Core() = default;
Core::~Core() = default;

int Core::fftSizeFor(double sampleRate, FrameTier tier) noexcept
{
    // Normal: ~21 ms frame, 1024 up to 50 kHz, then doubled per sample-rate octave. Fast / High: half / double.
    int n = 512 << static_cast<int>(tier);
    double sr = sampleRate;
    while (sr > 50000.0 && n < 16384) { sr *= 0.5; n *= 2; }
    return n;
}

void Core::prepare(double sampleRate, int /*maxBlockSize*/, int numChannels)
{
    sampleRate_  = sampleRate > 0.0 ? sampleRate : 48000.0;
    fftSize_     = fftSizeFor(sampleRate_, tier_);
    hop_         = fftSize_ / 4;
    {
        // Baseline refresh intervals are defined in ms and converted to whole frames (N = 1024 at 48 kHz: 4 and 2 frames).
        const double hopMs = 1000.0 * hop_ / sampleRate_;
        slowPeriod_ = std::clamp(static_cast<int>(std::lround(kSlowBaselineRefreshMs / hopMs)), 1, 32);
        fastPeriod_ = std::clamp(static_cast<int>(std::lround(kFastBaselineRefreshMs / hopMs)), 1, 32);
    }
    numChannels_ = std::clamp(numChannels, 1, kMaxChannels);

    int order = 0;
    while ((1 << order) < fftSize_) ++order;
    fft_ = std::make_unique<juce::dsp::FFT>(order);

    // sqrt of the periodic Hann window, used for analysis and (with the normalisation) synthesis.
    window_.assign(static_cast<size_t>(fftSize_), 0.0f);
    synthesis_.assign(static_cast<size_t>(fftSize_), 0.0f);
    const double twoPi = 2.0 * juce::MathConstants<double>::pi;
    for (int n = 0; n < fftSize_; ++n)
    {
        const double hann = 0.5 - 0.5 * std::cos(twoPi * n / fftSize_);
        window_[static_cast<size_t>(n)] = static_cast<float>(std::sqrt(std::max(hann, 0.0)));
    }
    // Per-hop-phase COLA normalisation 1 / sum_k w^2(phase + kH) (the RS WolaProcessor scheme). For the
    // periodic Hann at hop N/4 the sum is exactly 2; computing it keeps the reconstruction exact in float.
    for (int phase = 0; phase < hop_; ++phase)
    {
        double sum = 0.0;
        for (int n = phase; n < fftSize_; n += hop_)
            sum += static_cast<double>(window_[static_cast<size_t>(n)]) * window_[static_cast<size_t>(n)];
        const double norm = sum > 1.0e-8 ? 1.0 / sum : 1.0;
        for (int n = phase; n < fftSize_; n += hop_)
            synthesis_[static_cast<size_t>(n)] = static_cast<float>(window_[static_cast<size_t>(n)] * norm);
    }

    buildGrid();

    const int nb = fftSize_ / 2 + 1;
    const auto B = static_cast<size_t>(numBands_);
    for (int c = 0; c < kMaxChannels; ++c)
    {
        auto& ch = ch_[c];
        ch.inFifo.assign(static_cast<size_t>(fftSize_), 0.0f);
        ch.outAcc.assign(static_cast<size_t>(fftSize_), 0.0f);
        ch.outFifo.assign(static_cast<size_t>(hop_), 0.0f);
        ch.fftBuf.assign(static_cast<size_t>(fftSize_) * 2, 0.0f);
        ch.binGain.assign(static_cast<size_t>(nb), 1.0f);
        ch.powAvg.assign(static_cast<size_t>(nb), 0.0f);
        ch.powAvgF.assign(static_cast<size_t>(nb), 0.0f);
        ch.levelDb.assign(B, 0.0f);
        ch.baseDb.assign(B, 0.0f);
        ch.levelFDb.assign(B, 0.0f);
        ch.baseFDb.assign(B, 0.0f);
        ch.fastOwns.assign(B, 0);
        ch.redDb.assign(B, 0.0f);
        ch.smoothDb.assign(B, 0.0f);
        ch.outDb.assign(B, 0.0f);
        ch.exAdjDb.assign(B, 0.0f);
    }
    binX_.assign(static_cast<size_t>(nb), 0.0f);
    binF_.assign(static_cast<size_t>(nb), 1.0f);
    sigmaE_.assign(B, 0.0f);
    sigmaEF_.assign(B, 0.0f);
    scratch_.assign(B, 0.0f);
    tmpBand_.assign(B, 0.0f);
    estBand_.assign(B, 0.0f);
    reset();
}

// Everything frequency-dependent the detector needs, computed once per prepare().
void Core::buildGrid()
{
    const int N = fftSize_, H = hop_, nb = N / 2 + 1;
    const double sr = sampleRate_, binHz = sr / N;
    const int B = kGridBands;
    numBands_ = B;

    // --- window statistics: frame-overlap and bin correlations of |X|^2 for white noise ---
    double sumW2 = 0.0;
    for (int n = 0; n < N; ++n) sumW2 += static_cast<double>(window_[static_cast<size_t>(n)]) * window_[static_cast<size_t>(n)];
    double rhoTime[4] = { 1.0, 0.0, 0.0, 0.0 };   // lag in hops
    for (int L = 1; L < 4; ++L)
    {
        double s = 0.0;
        for (int n = 0; n + L * H < N; ++n) s += static_cast<double>(window_[static_cast<size_t>(n)]) * window_[static_cast<size_t>(n + L * H)];
        rhoTime[L] = (s * s) / (sumW2 * sumW2);
    }
    double rhoBin[4] = { 1.0, 0.0, 0.0, 0.0 };    // lag in bins
    for (int d = 1; d < 4; ++d)
    {
        double s = 0.0;
        for (int n = 0; n < N; ++n)
            s += static_cast<double>(window_[static_cast<size_t>(n)]) * window_[static_cast<size_t>(n)]
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
    buildAverage(static_cast<double>(detectorTauMs_), emaA_, emaB_, vfTime_);
    if (fastTauMs_ > 0.0f) buildAverage(static_cast<double>(fastTauMs_), emaAF_, emaBF_, vfTimeF_);
    else { emaAF_ = 0.0f; emaBF_ = 1.0f; vfTimeF_.assign(1, 1.0); }

    // --- band centres, uniform on the ERB-rate axis ---
    const double fLo = 20.0, fHi = std::min(0.45 * sr, 20000.0);
    erbLo_ = erbRate(fLo);
    erbStep_ = (erbRate(fHi) - erbLo_) / (B - 1);
    bandHz_.assign(static_cast<size_t>(B), 0.0f);
    for (int b = 0; b < B; ++b) bandHz_[static_cast<size_t>(b)] = static_cast<float>(erbToHz(erbLo_ + b * erbStep_));

    // --- band <- bin weights (CSR). Weight stored = u_k * f_k (per-octave level); vfBin from u_k ---
    bwStart_.assign(static_cast<size_t>(B) + 1, 0);
    bwBin_.clear(); bwW_.clear();
    vfBin_.assign(static_cast<size_t>(B), 1.0f);
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
            bwBin_.push_back(ks[i]);
            bwW_.push_back(static_cast<float>(ui * ks[i] * binHz));
        }
        vfBin_[static_cast<size_t>(b)] = static_cast<float>(vf);
        bwStart_[static_cast<size_t>(b) + 1] = static_cast<int>(bwBin_.size());
    }

    // --- flank band lists per side, outside the main-lobe exclusion ---
    const double gapUp = std::pow(2.0, static_cast<double>(kGapOct)), flank = std::pow(2.0, static_cast<double>(kFlankOct));
    bandX_.assign(static_cast<size_t>(B), 0.0f);
    for (int b = 0; b < B; ++b) bandX_[static_cast<size_t>(b)] = static_cast<float>(std::log2(static_cast<double>(bandHz_[static_cast<size_t>(b)])));
    for (int s = 0; s < 2; ++s)
    {
        flStart_[s].assign(static_cast<size_t>(B) + 1, 0);
        fl_[s].clear();
        sideX_[s].assign(static_cast<size_t>(B), 0.0f);
        sideVf_[s].assign(static_cast<size_t>(B), 1.0f);
        sideNeff_[s].assign(static_cast<size_t>(B), 1.0f);
    }
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
    lobeLo_.assign(static_cast<size_t>(B), 0);
    lobeHi_.assign(static_cast<size_t>(B), 0);
    for (int b = 0; b < B; ++b)
    {
        const double fb = bandHz_[static_cast<size_t>(b)];
        const double exUp = std::max(fb * gapUp, fb + kGapBins * binHz);
        const double exDn = std::min(fb / gapUp, fb - kGapBins * binHz);
        const double outUp = exUp * flank, outDn = exDn / flank;
        int lo = b, hi = b;
        while (lo > 0 && bandHz_[static_cast<size_t>(lo - 1)] > exDn) --lo;
        while (hi < B - 1 && bandHz_[static_cast<size_t>(hi + 1)] < exUp) ++hi;
        lobeLo_[static_cast<size_t>(b)] = lo;
        lobeHi_[static_cast<size_t>(b)] = hi;
        for (int s = 0; s < 2; ++s)
        {
            double fMin = 1.0e30, fMax = 0.0, vfSum = 0.0, xSum = 0.0;
            int count = 0;
            for (int j = 0; j < B; ++j)
            {
                const double fj = bandHz_[static_cast<size_t>(j)];
                const bool in = s == 0 ? (exDn > 0.0 && fj <= exDn && fj >= outDn) : (fj >= exUp && fj <= outUp);
                if (!in) continue;
                fl_[s].push_back(j);
                fMin = std::min(fMin, fj); fMax = std::max(fMax, fj);
                vfSum += vfBin_[static_cast<size_t>(j)];
                xSum += bandX_[static_cast<size_t>(j)];
                ++count;
            }
            flStart_[s][static_cast<size_t>(b) + 1] = static_cast<int>(fl_[s].size());
            if (count > 0)
            {
                sideX_[s][static_cast<size_t>(b)] = static_cast<float>(xSum / count);
                sideVf_[s][static_cast<size_t>(b)] = static_cast<float>(vfSum / count);
                // Independent information on this flank: the bins it spans (adjacent bins correlate, hence
                // the 1.5) divided by the effective bins per band level, capped at the band count.
                const double effBins = ((fMax - fMin) / binHz + 2.0) / 1.5;
                const double binsPerBand = 1.0 / std::max(vfSum / count, 1.0e-6);
                sideNeff_[s][static_cast<size_t>(b)] = static_cast<float>(std::clamp(effBins / binsPerBand, 1.0, static_cast<double>(count)));
            }
        }
    }

    // --- sub-bin correction constants: kernel ENBW, the bins where an ERB is narrower than it, and the second
    //     moment a narrowband source shows over +/-2 bins around its peak bin (averaged over sub-bin offsets) ---
    {
        double sw = 0.0;
        for (int n = 0; n < N; ++n) sw += window_[static_cast<size_t>(n)];
        const double enbwBins = N * sumW2 / (sw * sw);
        auto erbHz = [](double f) { return 24.7 * (4.37 * f / 1000.0 + 1.0); };
        kLowMax_ = 0;
        for (int k = 1; k < nb - 3; ++k) if (erbHz(k * binHz) < enbwBins * binHz) kLowMax_ = k;
        erbBins_.assign(static_cast<size_t>(nb), 1.0f);
        for (int k = 0; k < nb; ++k) erbBins_[static_cast<size_t>(k)] = static_cast<float>(erbHz(k * binHz) / binHz);
        auto kernel = [&](double f)   // |W(f)|^2 / |W(0)|^2, f in bins
        {
            double re = 0.0, im = 0.0;
            for (int n = 0; n < N; ++n)
            {
                const double ph = -2.0 * juce::MathConstants<double>::pi * f * n / N;
                re += window_[static_cast<size_t>(n)] * std::cos(ph);
                im += window_[static_cast<size_t>(n)] * std::sin(ph);
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
        kernelVar_ = static_cast<float>(varSum / cnt);
    }

    // --- bin -> band interpolation (ERB axis) for G(f) ---
    binBand_.assign(static_cast<size_t>(nb), 0);
    binFrac_.assign(static_cast<size_t>(nb), 0.0f);
    for (int k = 0; k < nb; ++k)
    {
        const double x = (erbRate(k * binHz) - erbLo_) / erbStep_;
        int j; double t;
        if (x <= 0.0) { j = 0; t = 0.0; }
        else if (x >= B - 1) { j = B - 2; t = 1.0; }
        else { j = static_cast<int>(std::floor(x)); t = x - j; }
        binBand_[static_cast<size_t>(k)] = j;
        binFrac_[static_cast<size_t>(k)] = static_cast<float>(t);
    }
}

// sigma_E per band for the current number of averaged frames.
void Core::updateSigma() noexcept
{
    updateSigmaFor(vfTime_, frames_, sigmaE_);
    if (fastTauMs_ > 0.0f) updateSigmaFor(vfTimeF_, frames_, sigmaEF_);
}

void Core::updateSigmaFor(const std::vector<double>& vfTime, long long frames, std::vector<float>& sigmaOut) noexcept
{
    const auto nMax = static_cast<long long>(vfTime.size());
    const double vt = vfTime[static_cast<size_t>(std::clamp<long long>(frames + 1, 1, nMax) - 1)];
    const double halfPi = 0.5 * juce::MathConstants<double>::pi;
    for (int b = 0; b < numBands_; ++b)
    {
        const double sL = levelSigmaDb(vt * vfBin_[static_cast<size_t>(b)]);
        // Baseline = w0 m0 + w1 m1 (line through the flank medians); var(median) ~ (pi/2) sigma^2 / n_eff.
        const auto bi = static_cast<size_t>(b);
        const bool has0 = flStart_[0][bi + 1] > flStart_[0][bi], has1 = flStart_[1][bi + 1] > flStart_[1][bi];
        double w[2] = { has0 ? 1.0 : 0.0, has1 ? 1.0 : 0.0 };
        if (has0 && has1)
        {
            w[0] = (sideX_[1][bi] - bandX_[bi]) / (sideX_[1][bi] - sideX_[0][bi]);
            w[1] = 1.0 - w[0];
        }
        double varBase = 0.0;
        for (int s = 0; s < 2; ++s)
        {
            if (w[s] == 0.0) continue;
            const double sv = levelSigmaDb(vt * sideVf_[s][bi]);
            varBase += w[s] * w[s] * halfPi * sv * sv / sideNeff_[s][bi];
        }
        sigmaOut[static_cast<size_t>(b)] = static_cast<float>(std::sqrt(sL * sL + varBase));
    }
}

void Core::release()
{
    fft_.reset();
    window_.clear(); window_.shrink_to_fit();
    synthesis_.clear(); synthesis_.shrink_to_fit();
    for (auto& ch : ch_)
    {
        for (auto* v : { &ch.inFifo, &ch.outAcc, &ch.outFifo, &ch.fftBuf, &ch.binGain, &ch.powAvg, &ch.powAvgF,
                         &ch.levelDb, &ch.baseDb, &ch.levelFDb, &ch.baseFDb, &ch.redDb, &ch.smoothDb, &ch.outDb, &ch.exAdjDb })
        { v->clear(); v->shrink_to_fit(); }
        ch.fastOwns.clear(); ch.fastOwns.shrink_to_fit();
    }
    fftSize_ = hop_ = numChannels_ = hopFill_ = numBands_ = 0;
    frames_ = 0;
}

void Core::reset() noexcept
{
    for (auto& ch : ch_)
    {
        for (auto* v : { &ch.inFifo, &ch.outAcc, &ch.outFifo, &ch.fftBuf, &ch.powAvg, &ch.powAvgF,
                         &ch.levelDb, &ch.baseDb, &ch.levelFDb, &ch.baseFDb, &ch.redDb, &ch.smoothDb, &ch.outDb, &ch.exAdjDb })
            std::fill(v->begin(), v->end(), 0.0f);
        std::fill(ch.binGain.begin(), ch.binGain.end(), 1.0f);
        std::fill(ch.fastOwns.begin(), ch.fastOwns.end(), static_cast<unsigned char>(0));
    }
    hopFill_ = 0;
    frames_ = 0;
    emaAn_ = 1.0;
    emaAnF_ = 1.0;
}

void Core::process(float* const* channels, int numChannels, int numSamples, const Params& p) noexcept
{
    if (fftSize_ <= 0 || channels == nullptr || numSamples <= 0) return;
    const int nCh = std::min(numChannels, numChannels_);
    if (nCh <= 0) return;

    const int N = fftSize_, H = hop_;
    int pos = 0;
    while (pos < numSamples)
    {
        const int k = std::min(numSamples - pos, H - hopFill_);
        for (int c = 0; c < nCh; ++c)
        {
            float* x = channels[c] + pos;
            auto& ch = ch_[c];
            // Input first (in-place buffers): the newest hop of the analysis FIFO, then hand out output that
            // was finished one hop ago. Output time t leaves at real time t + N.
            std::memcpy(ch.inFifo.data() + (N - H + hopFill_), x, sizeof(float) * static_cast<size_t>(k));
            std::memcpy(x, ch.outFifo.data() + hopFill_, sizeof(float) * static_cast<size_t>(k));
        }
        hopFill_ += k;
        pos += k;
        if (hopFill_ == H)
        {
            processFrame(nCh, p);
            hopFill_ = 0;
        }
    }
}

void Core::processFrame(int numCh, const Params& p) noexcept
{
    const int N = fftSize_, H = hop_;
    const int nb = N / 2 + 1;

    for (int c = 0; c < numCh; ++c)
    {
        auto& ch = ch_[c];
        float* buf = ch.fftBuf.data();
        const float* in = ch.inFifo.data();
        const float* w = window_.data();
        for (int n = 0; n < N; ++n) buf[n] = in[n] * w[n];
        std::fill(buf + N, buf + 2 * N, 0.0f);
        fft_->performRealOnlyForwardTransform(buf, true);
    }

    const bool applyGain = computeGains(numCh, p);

    for (int c = 0; c < numCh; ++c)
    {
        auto& ch = ch_[c];
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
        fft_->performRealOnlyInverseTransform(buf);

        // Overlap-add: drop the hop that was handed out, append an empty hop, add this frame.
        float* acc = ch.outAcc.data();
        std::memmove(acc, acc + H, sizeof(float) * static_cast<size_t>(N - H));
        std::fill(acc + (N - H), acc + N, 0.0f);
        const float* sw = synthesis_.data();
        for (int n = 0; n < N; ++n) acc[n] += buf[n] * sw[n];
        // acc[0, H) has now received all N/H overlapping frames: it is final.
        std::memcpy(ch.outFifo.data(), acc, sizeof(float) * static_cast<size_t>(H));

        // Advance the analysis FIFO by one hop.
        float* in = ch.inFifo.data();
        std::memmove(in, in + H, sizeof(float) * static_cast<size_t>(N - H));
    }
    ++frames_;
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

void Core::detectChannel(Channel& ch, double biasCorr, double biasCorrFast) noexcept
{
    const int nb = fftSize_ / 2 + 1;
    const float* X = ch.fftBuf.data();
    float* S = ch.powAvg.data();
    const float ea = emaA_, eb = emaB_;
    if (fastTauMs_ > 0.0f)
    {
        float* SF = ch.powAvgF.data();
        const float fa = emaAF_, fb = emaBF_;
        for (int k = 0; k < nb; ++k)
        {
            const float re = X[2 * k], im = X[2 * k + 1], pw = re * re + im * im;
            S[k]  = ea * S[k]  + eb * pw;
            SF[k] = fa * SF[k] + fb * pw;
        }
        bandLevelsAndBaseline(SF, ch.levelFDb.data(), ch.baseFDb.data(), biasCorrFast, fastPeriod_, ch.refMeanF);
    }
    else
    {
        for (int k = 0; k < nb; ++k)
        {
            const float re = X[2 * k], im = X[2 * k + 1];
            S[k] = ea * S[k] + eb * (re * re + im * im);
        }
    }
    bandLevelsAndBaseline(S, ch.levelDb.data(), ch.baseDb.data(), biasCorr, slowPeriod_, ch.refMeanS);
}

// Band levels (dB, per octave) of the averaged bin powers S and their flank baseline.
void Core::bandLevelsAndBaseline(const float* S, float* L, float* base, double biasCorr, int refreshPeriod, float& refMean) noexcept
{
    for (int band = 0; band < numBands_; ++band)
    {
        double acc = 0.0;
        for (int i = bwStart_[static_cast<size_t>(band)]; i < bwStart_[static_cast<size_t>(band) + 1]; ++i)
            acc += static_cast<double>(bwW_[static_cast<size_t>(i)]) * S[bwBin_[static_cast<size_t>(i)]];
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
    const bool all = frames_ < refreshPeriod || std::abs(meanL - refMean) > kBaselineJumpDb;
    if (all) refMean = meanL;
    for (int band = 0; band < numBands_; ++band)
    {
        if (!all && ((band + static_cast<int>(frames_ % refreshPeriod)) % refreshPeriod) != 0) continue;   // keep the last refresh
        const auto bi = static_cast<size_t>(band);
        float m[2] = { 0.0f, 0.0f }; bool has[2] = { false, false };
        for (int s = 0; s < 2; ++s)
        {
            const int i0 = flStart_[s][bi], i1 = flStart_[s][bi + 1];
            if (i1 <= i0) continue;
            m[s] = median(fl_[s].data() + i0, i1 - i0, L);
            has[s] = true;
        }
        const float x = bandX_[bi];
        if (has[0] && has[1])
        {
            const float x0 = sideX_[0][bi], x1 = sideX_[1][bi];
            base[band] = m[0] + (m[1] - m[0]) * (x - x0) / (x1 - x0);
        }
        else if (has[0] || has[1])
        {
            const int s = has[0] ? 0 : 1;
            base[band] = m[s] + static_cast<float>(slope) * (x - sideX_[s][bi]);
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
void Core::subBinCorrection(Channel& ch, double biasCorr) noexcept
{
    const int B = numBands_;
    const float* L = ch.levelDb.data();
    const float* base = ch.baseDb.data();
    float* adj = ch.exAdjDb.data();
    for (int b = 0; b < B; ++b) adj[b] = L[b] - base[b];
    if (kLowMax_ < 1) return;

    const int nb = fftSize_ / 2 + 1;
    const int kMax = std::min(kLowMax_ + 2, nb - 1);
    const double binHz = sampleRate_ / fftSize_;
    const float* S = ch.powAvg.data();
    float* x = binX_.data();
    float* F = binF_.data();
    for (int k = 1; k <= kMax; ++k)
    {
        const int j = binBand_[static_cast<size_t>(k)];
        const float t = binFrac_[static_cast<size_t>(k)];
        const float bk = base[j] + t * (base[j + 1] - base[j]);
        const double lev = 10.0 * std::log10(static_cast<double>(S[k]) * k * binHz * biasCorr + 1.0e-30);
        x[k] = std::max(static_cast<float>(std::pow(10.0, (lev - bk) * 0.1)) - 1.0f, 0.0f);
        F[k] = 1.0f;
    }
    x[0] = 0.0f;
    for (int k0 = 1; k0 <= kLowMax_; ++k0)
    {
        if (!(x[k0] > 0.0f) || x[k0] < x[k0 - 1] || x[k0] < x[k0 + 1]) continue;
        const int j0 = std::max(1, k0 - 2), j1 = std::min(kMax, k0 + 2);
        float m = 0.0f, c = 0.0f;
        for (int j = j0; j <= j1; ++j) { m += x[j]; c += static_cast<float>(j) * x[j]; }
        c /= m;
        float v = 0.0f;
        for (int j = j0; j <= j1; ++j) v += (static_cast<float>(j) - c) * (static_cast<float>(j) - c) * x[j];
        v /= m;
        const float wSrc = std::sqrt(12.0f * std::max(v - kernelVar_, 0.0f));
        const float xAud = m / std::max(erbBins_[static_cast<size_t>(k0)], wSrc);
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

bool Core::computeGains(int numCh, const Params& p) noexcept
{
    // ---- per-frame derived parameters (a handful of transcendental calls) ----
    const float depth = std::clamp(p.depth, 0.0f, 1.0f);
    const bool  hard  = p.hardKnee;
    const float z     = thresholdSigmas(p.sensitivity);     // threshold in sigma_E: 6 (sens 0) .. 4 (default) .. 2 (sens 1)
    const float kappa = hard ? 1.5f : 3.0f;                 // knee width in sigma_E
    const float rMax  = depth * (hard ? 24.0f : 12.0f);
    const double frameRate = sampleRate_ / hop_;
    const float aAtt  = xleth::dsp::onePoleStep(std::clamp(p.attackMs, 0.1f, 1000.0f) * 1.0e-3, frameRate);
    const float aRel  = xleth::dsp::onePoleStep(std::clamp(p.releaseMs, 1.0f, 10000.0f) * 1.0e-3, frameRate);
    const float link  = std::clamp(p.stereoLink, 0.0f, 1.0f);

    // ---- detector ----
    emaAn_ *= static_cast<double>(emaA_);
    const double biasCorr = 1.0 / std::max(1.0 - emaAn_, 1.0e-12);
    const bool fastOn = fastTauMs_ > 0.0f;
    double biasCorrFast = 1.0;
    if (fastOn)
    {
        emaAnF_ *= static_cast<double>(emaAF_);
        biasCorrFast = 1.0 / std::max(1.0 - emaAnF_, 1.0e-12);
    }
    // Both variance tables are indexed by the frame count; sigma is frozen once the longer (slow) one is in steady state.
    if (frames_ < static_cast<long long>(vfTime_.size())) updateSigma();

    const int B = numBands_;
    for (int c = 0; c < numCh; ++c)
    {
        auto& ch = ch_[c];
        detectChannel(ch, biasCorr, biasCorrFast);
        subBinCorrection(ch, biasCorr);
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
            float e = es, sig = sigmaE_[bi];
            est[b] = adj[b];   // excess at auditory resolution (== level - baseline above ~300 Hz)
            if (fastOn)
            {
                const float ef = LF[b] - baseF[b], sf = sigmaEF_[bi];
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
                    e = ef; sig = sf;
                    est[b] = ef + std::max(adj[b] - es, 0.0f);   // keep the sub-bin (low-f) depth correction of the slow path
                }
            }
            const float thr = z * sig;
            kb[b] = e > thr ? smoothstep01((e - thr) / (kappa * sig)) : 0.0f;
        }
        for (int b = 0; b < B; ++b)
        {
            const float e = est[b];
            float target = 0.0f;
            float k = 0.0f;
            if (e > 0.0f && rMax > 0.0f)
                for (int j = lobeLo_[static_cast<size_t>(b)]; j <= lobeHi_[static_cast<size_t>(b)]; ++j) k = std::max(k, kb[j]);
            if (k > 0.0f)
            {
                const float raw = k * e;
                const float x = raw / rMax;
                target = hard ? raw / std::pow(1.0f + (x * x) * (x * x) * (x * x), 1.0f / 6.0f)
                              : raw / std::sqrt(1.0f + x * x);
            }
            float v = r[b];
            v += (target > v ? aAtt : aRel) * (target - v);
            r[b] = v < 1.0e-7f ? 0.0f : v;
        }
        // Smoothing across frequency: [1 2 1] / 4, edges replicated.
        float* sm = ch.smoothDb.data();
        for (int b = 0; b < B; ++b)
        {
            const float lo = r[b > 0 ? b - 1 : 0], hi = r[b < B - 1 ? b + 1 : B - 1];
            sm[b] = 0.25f * lo + 0.5f * r[b] + 0.25f * hi;
        }
    }

    // ---- stereo link: blend each channel towards max(L, R) ----
    for (int c = 0; c < numCh; ++c)
    {
        const float* own = ch_[c].smoothDb.data();
        float* out = ch_[c].outDb.data();
        if (numCh < 2 || link <= 0.0f) { std::memcpy(out, own, sizeof(float) * static_cast<size_t>(B)); continue; }
        const float* other = ch_[1 - c].smoothDb.data();
        for (int b = 0; b < B; ++b) out[b] = own[b] + link * (std::max(own[b], other[b]) - own[b]);
    }

    // ---- G(f): band curve -> bins, real zero-phase gain ----
    bool any = false;
    const int nb = fftSize_ / 2 + 1;
    for (int c = 0; c < numCh; ++c)
    {
        const float* out = ch_[c].outDb.data();
        float* g = ch_[c].binGain.data();
        for (int k = 0; k < nb; ++k)
        {
            const int j = binBand_[static_cast<size_t>(k)];
            const float t = binFrac_[static_cast<size_t>(k)];
            const float rdB = out[j] + t * (out[j + 1] - out[j]);
            if (rdB > 1.0e-6f) { g[k] = std::exp(-rdB * kLn10Over20); any = true; }
            else g[k] = 1.0f;
        }
    }
    return any;
}

} // namespace xleth::dsp::resonance
