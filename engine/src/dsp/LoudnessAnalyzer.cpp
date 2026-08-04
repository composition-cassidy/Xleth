#include "dsp/LoudnessAnalyzer.h"

#include <algorithm>
#include <cmath>

namespace xleth::dsp {

namespace {

constexpr double kPi = 3.14159265358979323846;

// BS.1770-4 offset: L = -0.691 + 10*log10(Σ G_ch * meanSquare_ch).
constexpr double kLoudnessOffset = -0.691;

// ── K-weighting analog prototypes (BS.1770-4) ────────────────────────────────
// The Recommendation prints only the 48 kHz biquads. These are the prototype
// parameters those biquads were designed from; running the bilinear transform
// on them at 48 kHz reproduces the printed table exactly (asserted in
// test_loudness), and at any other rate it gives the filter the spec intends
// rather than a rate-shifted approximation of it.
constexpr double kShelfF0 = 1681.974450955533;   // Hz
constexpr double kShelfG  = 3.999843853973347;   // dB of shelf gain
constexpr double kShelfQ  = 0.7071752369554196;

constexpr double kHighPassF0 = 38.13547087602444; // Hz, -3 dB point
constexpr double kHighPassQ  = 0.5003270373238773;

// Exponent relating the shelf's mid-band gain to its high-band gain. Part of
// the original filter design; it is what makes the transition symmetric about
// the shelf midpoint.
constexpr double kShelfVbExponent = 0.4996667741545416;

} // namespace

// ── K-weighting coefficients ─────────────────────────────────────────────────

LoudnessAnalyzer::BiquadCoeffs LoudnessAnalyzer::makeShelfCoeffs(double sampleRate) noexcept
{
    BiquadCoeffs c;
    if (sampleRate <= 0.0) return c;

    const double K  = std::tan(kPi * kShelfF0 / sampleRate);
    const double Vh = std::pow(10.0, kShelfG / 20.0);
    const double Vb = std::pow(Vh, kShelfVbExponent);
    const double KoQ = K / kShelfQ;
    const double K2  = K * K;

    const double a0 = 1.0 + KoQ + K2;

    c.b0 = (Vh + Vb * KoQ + K2) / a0;
    c.b1 = 2.0 * (K2 - Vh) / a0;
    c.b2 = (Vh - Vb * KoQ + K2) / a0;
    c.a1 = 2.0 * (K2 - 1.0) / a0;
    c.a2 = (1.0 - KoQ + K2) / a0;
    return c;
}

LoudnessAnalyzer::BiquadCoeffs LoudnessAnalyzer::makeHighPassCoeffs(double sampleRate) noexcept
{
    BiquadCoeffs c;
    if (sampleRate <= 0.0) return c;

    const double K   = std::tan(kPi * kHighPassF0 / sampleRate);
    const double KoQ = K / kHighPassQ;
    const double K2  = K * K;

    const double a0 = 1.0 + KoQ + K2;

    // The numerator is left un-normalised at {1, -2, 1}, exactly as the
    // Recommendation specifies. That is not an oversight in the spec: it leaves
    // the RLB stage about +0.043 dB up at Nyquist, and that gain is baked into
    // the -0.691 offset. Dividing b through by a0 here would break the 1 kHz
    // calibration by ~0.04 dB.
    c.b0 = 1.0;
    c.b1 = -2.0;
    c.b2 = 1.0;
    c.a1 = 2.0 * (K2 - 1.0) / a0;
    c.a2 = (1.0 - KoQ + K2) / a0;
    return c;
}

// ── True-peak polyphase bank ─────────────────────────────────────────────────

const LoudnessAnalyzer::PolyphaseBank& LoudnessAnalyzer::truePeakFilter()
{
    // Built once, on first use. Rate-independent: the interpolator works in
    // normalised frequency, so the same taps serve 44.1 and 48 kHz.
    static const PolyphaseBank bank = []
    {
        std::array<double, kTruePeakTaps> proto {};
        const int centre = (kTruePeakTaps - 1) / 2;   // 24

        for (int j = 0; j < kTruePeakTaps; ++j)
        {
            const int m = j - centre;
            double h;
            if (m == 0)
            {
                h = 1.0;
            }
            else
            {
                const double t = kPi * static_cast<double>(m) / static_cast<double>(kTruePeakFactor);
                h = std::sin(t) / t;
            }
            // Hann window. Endpoints land on zero, which is why 49 taps buy
            // only 47 useful ones — the odd length is what keeps the centre at
            // a multiple of the oversampling factor.
            h *= 0.5 * (1.0 - std::cos(2.0 * kPi * static_cast<double>(j)
                                       / static_cast<double>(kTruePeakTaps - 1)));
            proto[static_cast<std::size_t>(j)] = h;
        }

        PolyphaseBank b {};
        for (auto& phase : b) phase.fill(0.0);

        for (int j = 0; j < kTruePeakTaps; ++j)
        {
            const int p = j % kTruePeakFactor;
            const int k = j / kTruePeakFactor;
            b[static_cast<std::size_t>(p)][static_cast<std::size_t>(k)]
                = proto[static_cast<std::size_t>(j)];
        }

        // Normalise each phase to unity DC gain so a constant signal
        // reconstructs exactly and no phase can invent or lose level. Phase 0
        // already sums to 1 (its only non-zero tap is the centre), so this
        // leaves the identity phase untouched.
        for (auto& phase : b)
        {
            double sum = 0.0;
            for (double t : phase) sum += t;
            if (std::abs(sum) > 1.0e-12)
                for (double& t : phase) t /= sum;
        }
        return b;
    }();

    return bank;
}

// ── Histogram ────────────────────────────────────────────────────────────────

void LoudnessAnalyzer::Histogram::allocate()
{
    count.assign(static_cast<std::size_t>(kHistogramBins), 0u);
    energy.assign(static_cast<std::size_t>(kHistogramBins), 0.0);
}

void LoudnessAnalyzer::Histogram::clear() noexcept
{
    std::fill(count.begin(), count.end(), 0u);
    std::fill(energy.begin(), energy.end(), 0.0);
}

void LoudnessAnalyzer::Histogram::add(double loudnessLufs, double e) noexcept
{
    // Callers only reach here for blocks already past the absolute gate, so the
    // low clamp is a guard rather than a policy. The high clamp would need a
    // master bus above +30 LUFS to ever fire; the energy sum stays exact
    // regardless, only the bin index saturates.
    int bin = static_cast<int>(std::floor((loudnessLufs - kAbsoluteGateLufs) / kHistogramBinLu));
    bin = std::clamp(bin, 0, kHistogramBins - 1);

    count[static_cast<std::size_t>(bin)]  += 1u;
    energy[static_cast<std::size_t>(bin)] += e;
}

double LoudnessAnalyzer::energyToLufs(double energy) noexcept
{
    if (!(energy > 0.0)) return kNoMeasurement;
    // Floored at the sentinel so "no data" and "absurdly quiet" report the same
    // thing; either way there is nothing meaningful below it.
    return std::max(kNoMeasurement, kLoudnessOffset + 10.0 * std::log10(energy));
}

double LoudnessAnalyzer::binCentreLufs(int bin) noexcept
{
    return kAbsoluteGateLufs + (static_cast<double>(bin) + 0.5) * kHistogramBinLu;
}

// ── Lifecycle ────────────────────────────────────────────────────────────────

void LoudnessAnalyzer::prepare(double sampleRate, int numChannels)
{
    prepared_ = false;
    if (sampleRate <= 0.0 || numChannels < 1) return;

    sampleRate_  = sampleRate;
    // G = 1.0 for L and R; no surround weighting, so anything past stereo is
    // dropped rather than silently mis-weighted.
    numChannels_ = std::min(numChannels, 2);

    subBlockSamples_ = static_cast<int>(std::llround(sampleRate * 0.1));
    if (subBlockSamples_ < 1) subBlockSamples_ = 1;

    const auto ch = static_cast<std::size_t>(numChannels_);

    shelf_.assign(ch, Biquad{});
    highPass_.assign(ch, Biquad{});
    for (auto& b : shelf_)    b.c = makeShelfCoeffs(sampleRate);
    for (auto& b : highPass_) b.c = makeHighPassCoeffs(sampleRate);

    subBlockSumSq_.assign(ch, 0.0);
    history_.assign(static_cast<std::size_t>(kSubBlocksPerShortTerm) * ch, 0.0);
    peakDelay_.assign(static_cast<std::size_t>(kTruePeakSubTaps) * ch, 0.0);

    blockHist_.allocate();
    shortTermHist_.allocate();

    prepared_ = true;
    reset();
}

void LoudnessAnalyzer::reset() noexcept
{
    for (auto& b : shelf_)    b.reset();
    for (auto& b : highPass_) b.reset();

    std::fill(subBlockSumSq_.begin(), subBlockSumSq_.end(), 0.0);
    subBlockFill_ = 0;

    std::fill(history_.begin(), history_.end(), 0.0);
    historyWrite_  = 0;
    historyFilled_ = 0;

    blockHist_.clear();
    shortTermHist_.clear();

    momentaryMax_ = kNoMeasurement;
    shortTermMax_ = kNoMeasurement;

    std::fill(peakDelay_.begin(), peakDelay_.end(), 0.0);
    peakWrite_        = 0;
    truePeakLinear_   = 0.0;
    samplePeakLinear_ = 0.0;
}

// ── Streaming ────────────────────────────────────────────────────────────────

void LoudnessAnalyzer::processBlock(const float* const* channels, int numSamples) noexcept
{
    if (!prepared_ || channels == nullptr || numSamples <= 0) return;

    const auto& bank = truePeakFilter();

    int offset = 0;
    while (offset < numSamples)
    {
        // Never straddle a sub-block boundary: the inner loop stays branch-free
        // on the flush condition and the boundary lands on an exact sample.
        const int chunk = std::min(numSamples - offset, subBlockSamples_ - subBlockFill_);

        for (int c = 0; c < numChannels_; ++c)
        {
            const float* src = channels[c];
            if (src == nullptr) continue;

            const auto  cu    = static_cast<std::size_t>(c);
            Biquad&     shelf = shelf_[cu];
            Biquad&     hp    = highPass_[cu];
            double      sumSq = subBlockSumSq_[cu];

            double* delay = peakDelay_.data() + cu * kTruePeakSubTaps;
            int     wpos  = peakWrite_;   // every channel walks the same cursor
            double  tp    = truePeakLinear_;
            double  sp    = samplePeakLinear_;

            for (int i = 0; i < chunk; ++i)
            {
                const double x = static_cast<double>(src[offset + i]);

                // K-weighting → mean-square accumulation.
                const double k = hp.process(shelf.process(x));
                sumSq += k * k;

                // True peak: the raw sample first (phase 0 is an exact identity
                // but runs 6 samples behind, so tracking the sample peak here
                // covers the tail the delay line never flushes), then the four
                // oversampled phases.
                const double ax = std::abs(x);
                if (ax > sp) sp = ax;

                wpos = (wpos + 1) % kTruePeakSubTaps;
                delay[wpos] = x;

                for (int p = 0; p < kTruePeakFactor; ++p)
                {
                    const auto& phase = bank[static_cast<std::size_t>(p)];
                    double acc = 0.0;
                    for (int t = 0; t < kTruePeakSubTaps; ++t)
                    {
                        int idx = wpos - t;
                        if (idx < 0) idx += kTruePeakSubTaps;
                        acc += phase[static_cast<std::size_t>(t)] * delay[idx];
                    }
                    const double aacc = std::abs(acc);
                    if (aacc > tp) tp = aacc;
                }
            }

            subBlockSumSq_[cu] = sumSq;
            truePeakLinear_    = tp;
            samplePeakLinear_  = sp;
        }

        // Advanced once for all channels — doing it inside the loop above would
        // desync the cursor if a channel pointer were null.
        peakWrite_ = (peakWrite_ + chunk) % kTruePeakSubTaps;

        subBlockFill_ += chunk;
        offset        += chunk;

        if (subBlockFill_ >= subBlockSamples_) closeSubBlock();
    }
}

void LoudnessAnalyzer::closeSubBlock() noexcept
{
    const auto ch = static_cast<std::size_t>(numChannels_);

    for (std::size_t c = 0; c < ch; ++c)
    {
        history_[static_cast<std::size_t>(historyWrite_) * ch + c] = subBlockSumSq_[c];
        subBlockSumSq_[c] = 0.0;
    }
    subBlockFill_ = 0;

    const int newest = historyWrite_;
    historyWrite_ = (historyWrite_ + 1) % kSubBlocksPerShortTerm;
    ++historyFilled_;

    // Sums the last `nSubBlocks` sub-blocks into a windowed loudness. Summing
    // 4 or 30 doubles per 100 ms is free next to the per-sample filtering, and
    // it avoids the drift a running subtract-add accumulator would collect over
    // a long render.
    const auto windowLoudness = [&](int nSubBlocks) -> double
    {
        double energy = 0.0;
        for (int s = 0; s < nSubBlocks; ++s)
        {
            int slot = newest - s;
            if (slot < 0) slot += kSubBlocksPerShortTerm;
            for (std::size_t c = 0; c < ch; ++c)   // G = 1.0 per channel
                energy += history_[static_cast<std::size_t>(slot) * ch + c];
        }
        return energy / (static_cast<double>(nSubBlocks) * static_cast<double>(subBlockSamples_));
    };

    if (historyFilled_ >= kSubBlocksPerMomentary)
    {
        // One 400 ms block per 100 ms hop is exactly the 75 % overlap the
        // gating model calls for, and the same value is the momentary reading.
        const double meanSq  = windowLoudness(kSubBlocksPerMomentary);
        const double loudness = energyToLufs(meanSq);

        if (loudness > momentaryMax_) momentaryMax_ = loudness;
        if (loudness > kAbsoluteGateLufs) blockHist_.add(loudness, meanSq);
    }

    if (historyFilled_ >= kSubBlocksPerShortTerm)
    {
        const double meanSq   = windowLoudness(kSubBlocksPerShortTerm);
        const double loudness = energyToLufs(meanSq);

        if (loudness > shortTermMax_) shortTermMax_ = loudness;
        if (loudness > kAbsoluteGateLufs) shortTermHist_.add(loudness, meanSq);
    }
}

// ── Results ──────────────────────────────────────────────────────────────────

LoudnessAnalyzer::Results LoudnessAnalyzer::getResults() const
{
    Results r;
    if (!prepared_) return r;

    r.momentaryMax = momentaryMax_;
    r.shortTermMax = shortTermMax_;

    if (truePeakLinear_ > 0.0 || samplePeakLinear_ > 0.0)
        r.truePeakDbtp = 20.0 * std::log10(std::max(truePeakLinear_, samplePeakLinear_));

    // ── Integrated: absolute gate is already applied at insertion ────────────
    {
        std::uint64_t n = 0;
        double        e = 0.0;
        for (int i = 0; i < kHistogramBins; ++i)
        {
            n += blockHist_.count[static_cast<std::size_t>(i)];
            e += blockHist_.energy[static_cast<std::size_t>(i)];
        }

        if (n > 0)
        {
            const double relGate = energyToLufs(e / static_cast<double>(n)) + kRelativeGateLu;

            // Nearest-bin threshold: the straddling bin joins the gated set when
            // its centre clears the gate, which keeps the rounding unbiased.
            int first = static_cast<int>(std::llround((relGate - kAbsoluteGateLufs) / kHistogramBinLu));
            first = std::clamp(first, 0, kHistogramBins);

            std::uint64_t gn = 0;
            double        ge = 0.0;
            for (int i = first; i < kHistogramBins; ++i)
            {
                gn += blockHist_.count[static_cast<std::size_t>(i)];
                ge += blockHist_.energy[static_cast<std::size_t>(i)];
            }

            if (gn > 0) r.integrated = energyToLufs(ge / static_cast<double>(gn));
        }
    }

    // ── Loudness range (EBU Tech 3342) ──────────────────────────────────────
    {
        std::uint64_t n = 0;
        double        e = 0.0;
        for (int i = 0; i < kHistogramBins; ++i)
        {
            n += shortTermHist_.count[static_cast<std::size_t>(i)];
            e += shortTermHist_.energy[static_cast<std::size_t>(i)];
        }

        if (n > 0)
        {
            const double relGate = energyToLufs(e / static_cast<double>(n)) + kLraRelativeGateLu;

            int first = static_cast<int>(std::llround((relGate - kAbsoluteGateLufs) / kHistogramBinLu));
            first = std::clamp(first, 0, kHistogramBins);

            std::uint64_t gn = 0;
            for (int i = first; i < kHistogramBins; ++i)
                gn += shortTermHist_.count[static_cast<std::size_t>(i)];

            if (gn > 0)
            {
                // Nearest-rank percentiles over the surviving distribution.
                const auto rankAt = [gn](double fraction) -> std::uint64_t
                {
                    const double r = static_cast<double>(gn - 1) * fraction;
                    return static_cast<std::uint64_t>(std::llround(r));
                };

                const std::uint64_t lowRank  = rankAt(0.10);
                const std::uint64_t highRank = rankAt(0.95);

                bool   haveLow  = false, haveHigh = false;
                double lowLufs  = 0.0,   highLufs = 0.0;

                std::uint64_t seen = 0;
                for (int i = first; i < kHistogramBins; ++i)
                {
                    const std::uint64_t c = shortTermHist_.count[static_cast<std::size_t>(i)];
                    if (c == 0) continue;

                    const std::uint64_t upto = seen + c - 1;
                    if (!haveLow  && upto >= lowRank)  { lowLufs  = binCentreLufs(i); haveLow  = true; }
                    if (!haveHigh && upto >= highRank) { highLufs = binCentreLufs(i); haveHigh = true; }
                    seen += c;
                }

                if (haveLow && haveHigh)
                    r.lra = std::max(0.0, highLufs - lowLufs);
            }
        }
    }

    return r;
}

// ── Offline convenience ──────────────────────────────────────────────────────

LoudnessAnalyzer::Results LoudnessAnalyzer::analyze(const juce::AudioBuffer<float>& buffer,
                                                    double sampleRate)
{
    LoudnessAnalyzer a;
    a.prepare(sampleRate, buffer.getNumChannels());
    if (buffer.getNumSamples() > 0)
        a.processBlock(buffer.getArrayOfReadPointers(), buffer.getNumSamples());
    return a.getResults();
}

} // namespace xleth::dsp
