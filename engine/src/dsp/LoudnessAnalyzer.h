#pragma once

// ─── LoudnessAnalyzer.h ──────────────────────────────────────────────────────
// ITU-R BS.1770-4 loudness measurement: integrated / momentary / short-term
// LUFS, EBU Tech 3342 Loudness Range, and true peak in dBTP.
//
// This is the measurement half of loudness normalisation — it only reports, it
// never touches the signal. Written as a plain class in the style of
// dsp/LoopAnalysis.h: no JUCE GUI, no engine types, nothing but the spec.
//
// ── Signal chain (per channel) ───────────────────────────────────────────────
//   x  →  K-weighting stage 1 (high shelf)  →  stage 2 (RLB high-pass)  →  x_k
//   mean-square of x_k accumulates into 100 ms sub-blocks; sliding windows of
//   4 sub-blocks (400 ms) and 30 sub-blocks (3 s) give the gating/momentary and
//   short-term measurements respectively.
//
// Loudness of a window is, per BS.1770-4 §2:
//     L = -0.691 + 10 * log10( Σ_ch G_ch * meanSquare(x_k,ch) )
// with G_ch = 1.0 for left and right. Surround weighting is NOT implemented:
// channels beyond the first two are ignored (see prepare()).
//
// ── Sample-rate independence ─────────────────────────────────────────────────
// The 48 kHz biquad tables printed in BS.1770-4 are NOT used. Both stages are
// derived from the analog prototype by bilinear transform at the sample rate
// handed to prepare(), because Xleth renders at 44100 and 48000 and hardcoded
// 48 kHz coefficients would silently mis-weight every 44.1 kHz render. At
// 48 kHz the derivation reproduces the published table to full double
// precision — test_loudness asserts exactly that, so the derivation itself is
// pinned to the spec rather than to a captured baseline.
//
// ── Gating (integrated loudness, BS.1770-4 §5) ───────────────────────────────
// 400 ms blocks at 75 % overlap. Absolute gate Γa = -70 LUFS; blocks louder
// than that form the ungated set. The relative gate Γr is the loudness of the
// ungated set's mean energy minus 10 LU; integrated loudness is the mean energy
// of the blocks above Γr, converted back to LUFS.
//
// Because processBlock() must not allocate (this will later be tapped onto the
// master bus on the audio thread), block loudnesses are accumulated into a
// fixed 0.1 LU histogram spanning [-70, +30) LUFS rather than a growing list.
// Each bin keeps an exact energy sum alongside its count, so both means above
// are exact — only the gate *threshold* lands on a bin edge, which can shift
// blocks sitting within 0.1 LU of Γr. That is the same trade every streaming
// implementation makes and is far inside the ±0.1 LU compliance tolerance.
//
// ── Loudness Range (EBU Tech 3342) ───────────────────────────────────────────
// Built from the short-term (3 s) distribution on the same 100 ms grid, gated
// at -70 LUFS absolute and at (ungated mean) - 20 LU relative, then reported as
// the 95th minus the 10th percentile of what survives. Same histogram trick;
// here the 0.1 LU quantisation is the only error and the tolerance is ±1 LU.
//
// ── True peak ────────────────────────────────────────────────────────────────
// 4x oversampling through a 49-tap Hann-windowed sinc, applied as four 13-tap
// polyphase sub-filters so the input is never zero-stuffed. 49 taps with the
// centre at index 24 makes phase 0 an exact identity (every other tap of that
// phase falls on a sinc zero), so the original samples are measured too and the
// reported true peak can never come out below the sample peak.
//
// ── Threading ────────────────────────────────────────────────────────────────
// prepare() allocates and must run off the audio thread. processBlock() and
// reset() are alloc-free, lock-free and noexcept. getResults() only reads, but
// it walks the histograms, so call it from the main thread.

#include <juce_audio_basics/juce_audio_basics.h>

#include <array>
#include <cstdint>
#include <vector>

namespace xleth::dsp {

class LoudnessAnalyzer
{
public:
    // Reported when a measurement has no data behind it: digital silence, a
    // stream shorter than the window it needs, or every block below the
    // absolute gate. Deliberately a finite sentinel rather than -inf so the
    // value survives a trip through JSON to the UI unharmed.
    static constexpr double kNoMeasurement = -200.0;

    struct Results
    {
        double integrated    {kNoMeasurement}; // LUFS, dual-gated (BS.1770-4 §5)
        double momentaryMax  {kNoMeasurement}; // LUFS, max of the 400 ms window
        double shortTermMax  {kNoMeasurement}; // LUFS, max of the 3 s window
        double lra           {0.0};            // LU, EBU Tech 3342 (0 when undefined)
        double truePeakDbtp  {kNoMeasurement}; // dBTP, 4x oversampled
    };

    LoudnessAnalyzer() = default;

    // Sizes every buffer and derives the K-weighting coefficients for this rate.
    // numChannels may be anything >= 1, but only the first two are measured with
    // G = 1.0 each — BS.1770-4's surround weights are out of scope, so passing a
    // 5.1 buffer measures its L/R pair, not its loudness. Allocates; also resets.
    void prepare(double sampleRate, int numChannels);

    // Drops all measurement state (filters, windows, histograms, peak) while
    // keeping the allocation and coefficients from prepare(). Alloc-free.
    void reset() noexcept;

    // Streaming entry point. `channels` must point to at least
    // getNumMeasuredChannels() non-null channel pointers of `numSamples` floats.
    // No allocation, no locking. A no-op before prepare().
    void processBlock(const float* const* channels, int numSamples) noexcept;

    // Snapshot of everything measured so far. Safe to call mid-stream.
    // The trailing partial 100 ms sub-block is not included, per spec.
    Results getResults() const;

    // Offline convenience: measures a whole buffer in one call. Equivalent to
    // prepare() + a single processBlock() + getResults().
    static Results analyze(const juce::AudioBuffer<float>& buffer, double sampleRate);

    double getSampleRate()          const noexcept { return sampleRate_; }
    int    getNumMeasuredChannels() const noexcept { return numChannels_; }

    // ── Spec-visible internals (exposed for the compliance tests) ────────────
    // A K-weighting stage as normalised biquad coefficients (a0 divided out).
    struct BiquadCoeffs
    {
        double b0 {1.0}, b1 {0.0}, b2 {0.0};
        double a1 {0.0}, a2 {0.0};
    };

    // Stage 1: high shelf, ~+4 dB above the 1.5-2 kHz region (head response).
    static BiquadCoeffs makeShelfCoeffs(double sampleRate) noexcept;
    // Stage 2: RLB high-pass, -3 dB at ~38 Hz.
    static BiquadCoeffs makeHighPassCoeffs(double sampleRate) noexcept;

    // Window geometry, in 100 ms sub-blocks.
    static constexpr int kSubBlocksPerMomentary = 4;   // 400 ms
    static constexpr int kSubBlocksPerShortTerm = 30;  // 3 s

    // Gate thresholds, LUFS / LU.
    static constexpr double kAbsoluteGateLufs   = -70.0;
    static constexpr double kRelativeGateLu     = -10.0;  // integrated
    static constexpr double kLraRelativeGateLu  = -20.0;  // loudness range

private:
    // ── Loudness histogram ──────────────────────────────────────────────────
    // 0.1 LU bins from kAbsoluteGateLufs upward. Counts drive the percentiles,
    // the parallel energy sums keep the gated means exact.
    static constexpr int    kHistogramBins = 1000;   // -70 .. +30 LUFS
    static constexpr double kHistogramBinLu = 0.1;

    struct Histogram
    {
        std::vector<std::uint64_t> count;
        std::vector<double>        energy;

        void allocate();
        void clear() noexcept;
        void add(double loudnessLufs, double energy) noexcept;
    };

    struct Biquad
    {
        BiquadCoeffs c {};
        double s1 {0.0}, s2 {0.0};

        inline double process(double x) noexcept
        {
            // Transposed direct form II, double state: the integration runs for
            // minutes over signals that can sit 60 dB down, so float state here
            // would visibly bias quiet material.
            const double y = c.b0 * x + s1;
            s1 = c.b1 * x - c.a1 * y + s2;
            s2 = c.b2 * x - c.a2 * y;
            return y;
        }

        void reset() noexcept { s1 = 0.0; s2 = 0.0; }
    };

    // Flushes one completed 100 ms sub-block into the sliding windows.
    void closeSubBlock() noexcept;

    static double energyToLufs(double energy) noexcept;
    static double binCentreLufs(int bin) noexcept;

    // ── True peak ───────────────────────────────────────────────────────────
    static constexpr int kTruePeakFactor  = 4;
    static constexpr int kTruePeakTaps    = 49;
    static constexpr int kTruePeakSubTaps = 13;   // ceil(49 / 4)

    using PolyphaseBank = std::array<std::array<double, kTruePeakSubTaps>, kTruePeakFactor>;
    static const PolyphaseBank& truePeakFilter();

    // ── State ───────────────────────────────────────────────────────────────
    double sampleRate_      {0.0};
    int    numChannels_     {0};      // measured channels, 1 or 2
    int    subBlockSamples_ {0};      // samples per 100 ms sub-block
    bool   prepared_        {false};

    std::vector<Biquad> shelf_;       // [channel]
    std::vector<Biquad> highPass_;    // [channel]

    std::vector<double> subBlockSumSq_;   // in-flight sub-block, [channel]
    int                 subBlockFill_ {0};

    // Ring of the last kSubBlocksPerShortTerm sub-block energies,
    // [slot * numChannels_ + channel]. Sized in prepare().
    std::vector<double> history_;
    int                 historyWrite_ {0};
    std::int64_t        historyFilled_{0};

    Histogram blockHist_;      // 400 ms gating blocks → integrated
    Histogram shortTermHist_;  // 3 s windows → LRA

    double momentaryMax_ {kNoMeasurement};
    double shortTermMax_ {kNoMeasurement};

    std::vector<double> peakDelay_;   // [channel * kTruePeakSubTaps + k], newest at k=0
    int                 peakWrite_ {0};
    double              truePeakLinear_  {0.0};
    double              samplePeakLinear_{0.0};
};

} // namespace xleth::dsp
