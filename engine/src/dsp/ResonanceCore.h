#pragma once

// ─── ResonanceCore — shared resonance detector / gain computer / spectral renderer ──
// Stage 1 of the resonance-suppressor rewrite (docs/RESONANCE_SUPPRESSOR_AUDIT.md
// §5.2 / §6). One self-contained DSP object, NOT wired into any effect yet. No
// juce::AudioProcessor / APVTS dependency: it is driven with raw channel pointers
// and a POD parameter block, so it can be unit-tested and benchmarked headless.
//
// Signal path (per channel, block-size independent, latency = N exactly):
//
//   input ─► FIFO ─► sqrt-Hann ─► real FFT(N) ─┬─► detector ─► gain computer ─► G(f)
//                                               │                                 │
//                                               └──────────► × G(f) (real, zero-phase)
//                                                               │
//                                    output ◄─ overlap-add ◄─ sqrt-Hann·1/Σw² ◄─ IFFT
//
//   N   = 1024 at 44.1 / 48 kHz (Normal tier; Fast 512, High 2048), doubled per sample-rate octave above that (2048 at
//         88.2 / 96 kHz) so the frame stays about 21 ms. Hop N/4.
//   COLA: synthesis window = sqrt-Hann × the per-hop-phase normalisation 1/Σw², the
//         same scheme as the RS High Quality WolaProcessor.
//
// Detector and gain computer, in one paragraph (details and the evidence behind every constant: ResonanceCore.md next to this file):
//   Per frame the bin powers |X_k|^2 are averaged over time twice, a SLOW average (200 ms) and a FAST one (40 ms), and weighted into 96 ERB-spaced bands.
//   The level of a band minus a baseline interpolated from the median levels of the spectrum on both sides of it (flanks outside the band's main lobe)
//   is the band's EXCESS in dB. Both estimates carry their own statistical sigma, derived from the averaging geometry, so every threshold is in sigma
//   (not in dB): the false-trigger rate on noise is set by statistics. A band uses the slow estimate while the fast one agrees with it; it switches to the
//   fast one on an onset (fast above slow by more than kSwitchUpSigmas fast sigmas) and, through a hysteresis latch, on a release (slow above fast by more
//   than kVetoSetSigmas, latched until the two are within kVetoClearSigmas again). The excess above threshold (sensitivity) is mapped through a salience
//   knee to a target reduction (whole excess, capped by depth), smoothed per band by attack / release, across bands by [1 2 1] / 4, optionally linked
//   between channels, interpolated to the bins and applied as a real, zero-phase gain.
//
// Every time constant is in milliseconds and independent of N and of the sample rate (converted with the hop duration in prepare()); only the analysis
// window itself (10.7 / 21.3 / 42.7 ms for the three frame tiers at <= 50 kHz) scales with N.
//
// Units: levels and reductions are dB, thresholds are in sigma of the excess estimate, times are ms, frequencies Hz. Latency is N samples, always.
//
// Known limit (a property of the analysis resolution, not a tuning issue): a resonance narrower than one analysis bin (a Q 8 bell is narrower than the 46.9 Hz bin
// of N = 1024 at 48 kHz below roughly 370 Hz; the effect on the cut is large below ~150 Hz) is only partly reduced. The cut is the bin-average excess, so the sub-bin
// peak stays standing: a Q 8 / +12 dB bell at 100 Hz keeps ~3.4 dB of its ~7.2 dB in-window excess, and N = 2048 does not change that. See "G1 resolution ceiling"
// in ResonanceCore.md.
//
// Realtime contract: prepare() / release() allocate and run on a non-audio thread.
// process() and reset() never allocate, lock or log.
//
// Threading: a Core is NOT thread-safe and owns no thread. One instance per audio chain; prepare(), release(), setFrameTier(), setDetectorTimeConstantMs()
// and setFastTimeConstantMs() are called on a non-audio thread while the instance is not processing (the setters are structural and take effect at the next
// prepare()). process(), reset() and the introspection accessors belong to the audio (processing) thread. Params is passed by value to every process() call and may
// change freely between calls (tests T4 / T6 run with parameters swept every block, without allocation).

#include <juce_dsp/juce_dsp.h>

#include <cstdint>
#include <memory>
#include <vector>

namespace xleth::dsp::resonance
{

constexpr int kMaxChannels = 2;
constexpr int kGridBands   = 96;   // detector / gain grid: ERB-rate spaced, 20 Hz .. min(0.45 fs, 20 kHz)

// Parameter block, copied by value into process() once per block. Plain data only.
struct Params
{
    // depth: 0..1. Ceiling of the reduction of one band, in dB: depth x 12 dB (Soft) or depth x 24 dB (Hard). The cut follows the excess smoothly towards the ceiling
    //        (R = r / (1 + (r / Rmax)^p)^(1/p), p = 2 Soft, p = 6 Hard); 0 passes the audio through with the latency only (error -160 dBFS RMS).
    float depth       = 0.5f;
    // sensitivity: 0..1. Detection threshold in sigma of the excess estimate (the statistical std-dev of level - baseline on noise): 6 sigma at 0, 4 at 0.5, 2 at 1.
    //        Higher = more sensitive (lower threshold). Unit: sigma, NOT dB.
    float sensitivity = 0.5f;
    // attackMs / releaseMs: per-band one-pole smoothing of the applied reduction, in dB, at the frame rate (clamped 0.1..1000 ms and 1..10000 ms). The release runs
    //        from the moment the detector hands the band back (about 45 ms after the resonance stops), so a 9 dB cut at the default 200 ms is below 1 dB after
    //        roughly 450-500 ms.
    float attackMs    = 15.0f;
    float releaseMs   = 200.0f;
    // hardKnee: false = Soft (knee 3 sigma wide, ceiling 12 dB x depth, gentle ceiling), true = Hard (knee 1.5 sigma wide, 24 dB x depth, sharp ceiling).
    bool  hardKnee    = false;
    // stereoLink: 0..1. Blend of each channel's reduction towards max(L, R): 0 = channels independent, 1 = both channels get the larger of the two reductions.
    float stereoLink  = 0.0f;

    // HOOK (not implemented in stage 1, ignored): per-grid-band focus / sensitivity weight, length numBands().
    const float* focusWeight = nullptr;
};

// HOOK (not implemented in stage 1): per-region output. Stage 1 has exactly one full-band region and
// regionOutput() returns zeros.
struct RegionOutput
{
    float maxReductionDb = 0.0f;
    float activity       = 0.0f;
};

class Core
{
public:
    Core();
    ~Core();
    Core(const Core&) = delete;
    Core& operator=(const Core&) = delete;

    // Allocates everything process() will ever touch. numChannels is clamped to 1..kMaxChannels.
    void prepare(double sampleRate, int maxBlockSize, int numChannels);
    void release();
    // Clears all signal state (FIFOs, overlap-add, detector, gain smoothers). RT-safe.
    void reset() noexcept;

    // Frame-size tier (structural: chosen before prepare(), no live switching). N = 512 / 1024 / 2048 at <= 50 kHz (window about
    // 10.7 / 21.3 / 42.7 ms), doubled per sample-rate octave above that. Every time constant stays in ms.
    enum class FrameTier { Fast = 0, Normal = 1, High = 2 };
    void setFrameTier(FrameTier t) noexcept { tier_ = t; }
    FrameTier frameTier() const noexcept { return tier_; }
    static int fftSizeFor(double sampleRate, FrameTier tier = FrameTier::Normal) noexcept;
    // Latency in samples for a given rate and tier (constant; independent of every Params field).
    static int latencyFor(double sampleRate, FrameTier tier = FrameTier::Normal) noexcept { return fftSizeFor(sampleRate, tier); }
    int currentLatency() const noexcept { return fftSize_; }

    // In place. Channels [0, min(numChannels, prepared channels)) are processed; any others are untouched.
    // numSamples may be any value >= 0 (it is NOT limited to the prepared maxBlockSize).
    void process(float* const* channels, int numChannels, int numSamples, const Params& p) noexcept;

    // ---- hooks (stage 1: not implemented) ----
    int numRegions() const noexcept { return 1; }
    RegionOutput regionOutput(int /*regionIndex*/) const noexcept { return {}; }

    // ---- introspection (tests / bench; read on the processing thread between process() calls) ----
    int fftSize() const noexcept { return fftSize_; }
    int hopSize() const noexcept { return hop_; }
    int numBins() const noexcept { return fftSize_ / 2 + 1; }
    double sampleRate() const noexcept { return sampleRate_; }
    long long framesProcessed() const noexcept { return frames_; }
    int numBands() const noexcept { return numBands_; }
    float bandHz(int b) const noexcept { return bandHz_[static_cast<size_t>(b)]; }
    // Last frame's per-band values (dB), length numBands().
    const float* bandLevelDb(int c) const noexcept    { return ch_[c].levelDb.data(); }    // averaged level, per-octave units
    const float* bandBaselineDb(int c) const noexcept { return ch_[c].baseDb.data(); }     // robust flank baseline
    const float* bandReductionDb(int c) const noexcept{ return ch_[c].outDb.data(); }      // applied reduction (>= 0)
    const float* bandSigmaDb() const noexcept         { return sigmaE_.data(); }           // std-dev of (level - baseline) on noise
    const float* bandSigmaFastDb() const noexcept     { return sigmaEF_.data(); }          // the same for the fast estimate
    const float* bandFastLevelDb(int c) const noexcept    { return ch_[c].levelFDb.data(); }
    const float* bandFastBaselineDb(int c) const noexcept { return ch_[c].baseFDb.data(); }
    // Detection threshold in units of sigma_E for a sensitivity (0..1): 6 sigma at 0, 4 at 0.5, 2 at 1.
    static float thresholdSigmas(float sensitivity) noexcept
    {
        const float s = sensitivity < 0.0f ? 0.0f : (sensitivity > 1.0f ? 1.0f : sensitivity);
        return 6.0f - 4.0f * s;
    }
    // ---- detector constants (exposed so the design notes / tests can quote them; evidence for every value: ResonanceCore.md) ----
    // Slow estimate: recursive power average of |X_k|^2, time constant in ms. Long enough that the excess of a band has a small, predictable sigma (about 0.5 dB at 2.5 kHz),
    // short enough to follow a held resonance. 400 ms detects sub-bin resonances more often but lingers about 2 tau after a resonance stops and lets the low-frequency
    // clean-pink bias (+0.6 dB) become ~1 sigma. Structural: takes effect at the next prepare() (call it before prepare).
    static constexpr float kDefaultDetectorTauMs = 200.0f;
    void setDetectorTimeConstantMs(float ms) noexcept { detectorTauMs_ = ms > 1.0f ? ms : 1.0f; }
    float detectorTimeConstantMs() const noexcept { return detectorTauMs_; }
    // Two-speed detection (v6). A second, fast power average (time constant in ms, independent of N and the sample rate) is
    // kept next to the slow one. Per band the detector uses the SLOW estimate while the fast one is statistically consistent
    // with it, and the FAST estimate where the two differ by more than kSwitchUpSigmas fast-estimate standard deviations above it
    // (an onset) or, latched with hysteresis, by kVetoSetSigmas below it (a release). The threshold and knee of whichever estimate is used come from
    // that estimate's own variance. 0 disables the fast path (slow only, the stage-B behaviour). Structural: next prepare().
    // Fast time constant, ms. 40 ms is the knee (measured, quick runs): 25 ms is noisier (larger fast sigma, more false latches; G1 10/12, G4 jitter 0.148 dB vs 0.130, G9a 7/9);
    // 60 ms reacts too late at 500 Hz (G8a 4/6, t50 101-104 ms against the 100 ms gate).
    static constexpr float kDefaultFastTauMs  = 40.0f;
    // Onset rule, in FAST sigmas: fast - slow > 2.5 -> the band uses the fast estimate (the slow average needs ~200 ms to reach a new level, the fast one ~40 ms, so a real
    // onset opens a gap of several fast sigmas within a few frames while noise stays inside 2.5). This value comes from the first, symmetric (+-2.5) attempt; its onset side
    // already met the reaction gate (G8a 6/6), only its release side was too late (below).
    static constexpr float kSwitchUpSigmas    = 2.5f;
    // Release latch, in FAST sigmas: slow - fast > 2.0 sets the latch (the fast estimate takes over), slow - fast < 0.75 clears it. The latch is asymmetric because the slow
    // estimate falls only as 10 log10(1 + 9 e^(-t / 200 ms)) after a 10 dB resonance stops: it stays within 2.5 fast sigmas of the fast estimate while still 3-5 dB above the
    // clean level, which a symmetric rule never hands over (G9a 6/9). Setting at 2.0 catches the release about 45 ms after the offset; clearing at 0.75 keeps the latch from
    // chattering. Looser settings (set 1.5 / clear 0.5, or release at 0.5 sigma) release faster but fire false latches in steady state and cost G1 (see ResonanceCore.md).
    static constexpr float kVetoSetSigmas     = 2.0f;
    // Forced full baseline refresh: when the mean band level has moved by more than this many dB since the last full refresh (a broadband onset out of silence meets a stale
    // baseline and would show a false excess), every band's baseline is recomputed in that frame instead of the staggered share. dB.
    static constexpr float kBaselineJumpDb     = 1.5f;
    // Baseline refresh cadence, ms (converted to whole frames in prepare(): 4 / 2 frames at N = 1024). Each band's baseline (two flank medians, the dominant detector cost) is
    // recomputed once per interval, staggered over the bands; levels are exact every frame. Defined in ms so the cadence does not change with N.
    static constexpr float kSlowBaselineRefreshMs = 21.33f;   // slow estimate (tau 200 ms)
    static constexpr float kFastBaselineRefreshMs = 10.67f;   // fast estimate
    // Release latch, clear threshold (see kVetoSetSigmas): slow - fast below this many fast sigmas hands the band back to the slow estimate. Fast sigmas.
    static constexpr float kVetoClearSigmas   = 0.75f;
    void setFastTimeConstantMs(float ms) noexcept { fastTauMs_ = ms > 0.0f ? (ms > 1.0f ? ms : 1.0f) : 0.0f; }
    float fastTimeConstantMs() const noexcept { return fastTauMs_; }
    // Flank geometry of the baseline: the flanks start outside the resonance's main lobe and are kFlankOct wide.
    static constexpr float kGapOct        = 0.5f;     // flank exclusion half-width, octaves (main lobe of a Q >= 4 resonance)
    static constexpr float kGapBins       = 2.0f;     // ... and at least this many FFT bins (analysis main lobe)
    static constexpr float kFlankOct      = 0.75f;    // flank width beyond the exclusion, octaves

private:
    struct Channel
    {
        std::vector<float> inFifo;    // last N input samples; the newest hop is filled at [N - H, N)
        std::vector<float> outAcc;    // overlap-add accumulator, N samples, index 0 = oldest output
        std::vector<float> outFifo;   // H finished output samples handed out during the next hop
        std::vector<float> fftBuf;    // 2N (JUCE real-FFT layout)
        std::vector<float> binGain;   // N/2 + 1 real gains applied to this frame
        // detector / gain computer state
        std::vector<float> powAvg;    // N/2 + 1 recursively averaged |X|^2 (un-bias-corrected EMA)
        std::vector<float> powAvgF;   // the same with the fast time constant
        std::vector<float> levelDb;   // per band
        std::vector<float> baseDb;    // per band
        std::vector<float> levelFDb;  // per band, fast estimate
        std::vector<float> baseFDb;   // per band, fast estimate
        float refMeanS = 0.0f, refMeanF = 0.0f;   // mean band level at the last full baseline refresh (slow / fast)
        std::vector<unsigned char> fastOwns;   // per band: 1 = the fast estimate is in charge (release latch)
        std::vector<float> redDb;     // per band, attack/release state (dB, >= 0)
        std::vector<float> smoothDb;  // per band, after frequency smoothing
        std::vector<float> outDb;     // per band, after stereo link (what is applied)
        std::vector<float> exAdjDb;   // per band, excess at auditory resolution (sub-bin correction, low f only)
    };

    void buildGrid();
    void updateSigma() noexcept;
    void updateSigmaFor(const std::vector<double>& vfTime, long long frames, std::vector<float>& sigmaOut) noexcept;
    void processFrame(int numCh, const Params& p) noexcept;
    // Detector + gain computer: writes Channel::binGain for channels [0, numCh). Returns false when every
    // gain is exactly 1 (the multiply is then skipped).
    bool computeGains(int numCh, const Params& p) noexcept;
    void detectChannel(Channel& ch, double biasCorr, double biasCorrFast) noexcept;
    // refreshPeriod: each band's flank baseline (the median-heavy part) is recomputed every refreshPeriod-th frame, staggered over the
    // bands; levels are exact every frame. Every baseline is recomputed on the first frames and whenever the mean band level has moved
    // by more than kBaselineJumpDb since the last full refresh (a broadband onset: the stale baseline would show false excess).
    void bandLevelsAndBaseline(const float* S, float* L, float* base, double biasCorr, int refreshPeriod, float& refMean) noexcept;
    void subBinCorrection(Channel& ch, double biasCorr) noexcept;
    float median(const int* idx, int n, const float* values) noexcept;

    double sampleRate_ = 0.0;
    float detectorTauMs_ = kDefaultDetectorTauMs;
    float fastTauMs_ = kDefaultFastTauMs;
    FrameTier tier_ = FrameTier::Normal;
    int slowPeriod_ = 4, fastPeriod_ = 2;   // baseline refresh periods in frames
    int fftSize_ = 0, hop_ = 0, numChannels_ = 0;
    int hopFill_ = 0;
    long long frames_ = 0;

    std::unique_ptr<juce::dsp::FFT> fft_;
    std::vector<float> window_;      // sqrt-Hann (periodic), analysis
    std::vector<float> synthesis_;   // sqrt-Hann × 1/Σw² of its hop phase
    Channel ch_[kMaxChannels];

    // ---- band grid (ERB-rate spaced), built in prepare() ----
    int numBands_ = 0;
    double erbLo_ = 0.0, erbStep_ = 1.0;
    std::vector<float> bandHz_;
    std::vector<int>   bwStart_, bwBin_;  std::vector<float> bwW_;   // band <- bins (CSR), weights include f_k
    std::vector<int>   flStart_[2], fl_[2];                          // flank band lists per side (0 = below, 1 = above)
    std::vector<int>   lobeLo_, lobeHi_;                             // per band: bands inside its main-lobe exclusion zone
    std::vector<int>   binBand_;  std::vector<float> binFrac_;       // bin -> (band j, t) for G(f) interpolation
    // ---- statistics ----
    float emaA_ = 0.0f, emaB_ = 1.0f;     // per-frame power average: S = a S + b P
    double emaAn_ = 1.0;                  // a^n (bias correction 1 / (1 - a^n))
    std::vector<double> vfTime_;          // variance factor of the bias-corrected average after n frames (index n-1)
    float emaAF_ = 0.0f, emaBF_ = 1.0f;   // the same for the fast average
    double emaAnF_ = 1.0;
    std::vector<double> vfTimeF_;
    std::vector<float> vfBin_;            // per band: variance factor of the bin weighting
    std::vector<float> bandX_;            // per band log2(f)
    std::vector<float> sideX_[2];         // per band and side: mean log2(f) of the flank bands
    int slopeLo_ = 0, slopeHi_ = 0;       // band range of the wideband tilt fit (one-sided flank extrapolation)
    double slopeXMean_ = 0.0, slopeSxx_ = 1.0;
    std::vector<float> sideVf_[2];        // per band and side: mean bin variance factor of the flank bands
    std::vector<float> sideNeff_[2];      // per band and side: effective independent flank values
    std::vector<float> sigmaE_;           // per band std-dev of excess (dB) at the current frame count
    std::vector<float> sigmaEF_;          // the same for the fast estimate
    // ---- sub-bin (auditory-resolution) excess at low f, where the analysis kernel is wider than an ERB ----
    int kLowMax_ = 0;                     // last bin whose ERB is narrower than the analysis kernel's ENBW
    float kernelVar_ = 0.0f;              // second moment (bins^2) a narrowband source shows over +/-2 bins
    std::vector<float> erbBins_;          // per bin: ERB(f_k) in bins
    std::vector<float> binX_, binF_;      // per bin scratch: excess fraction, correction factor
    std::vector<float> scratch_;          // median scratch
    std::vector<float> tmpBand_;          // per band scratch
    std::vector<float> estBand_;          // per band: the excess estimate (dB) the gain computer reduces by
};

} // namespace xleth::dsp::resonance
