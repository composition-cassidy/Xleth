#pragma once

// ─── ResonanceCore — shared resonance detector / gain computer / spectral renderer ──
// Stage 1 of the resonance-suppressor rewrite (docs/RESONANCE_SUPPRESSOR_AUDIT.md
// §5.2 / §6). One self-contained DSP object, NOT wired into any effect yet. No
// juce::AudioProcessor / APVTS dependency: it is driven with raw channel pointers
// and a POD parameter block, so it can be unit-tested and benchmarked headless.
//
// Signal path (per channel, block-size independent, latency = N exactly):
//
//   input ─► ring ─► sqrt-Hann ─► real FFT(N) ─┬─► detector ─► gain computer ─► G(f)
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
//   knee to a target reduction (whole excess, capped by depth), smoothed per band by attack / release, across bands by [1 2 1] / 4 (Params::sharpness
//   narrows / broadens this; 0.5 = exactly [1 2 1] / 4), optionally linked between channels, scaled by the optional per-band weight curve, interpolated to the bins
//   and applied as a real, zero-phase gain.
//
// Every time constant is in milliseconds and independent of N and of the sample rate (converted with the hop duration in prepare()); only the analysis
// window itself (10.7 / 21.3 / 42.7 ms for the three frame tiers at <= 50 kHz) scales with N.
//
// Units: levels and reductions are dB, thresholds are in sigma of the excess estimate, times are ms, frequencies Hz. Latency is N samples of the tier in use.
//
// Low frequencies (below kLowSplitHz = 400 Hz, every tier): a resonance narrower than the analysis kernel cannot be represented by the 96-band gain curve ([1 2 1] / 4
// smoothing and linear interpolation to the bins cannot carry a 12.5 Hz notch at 100 Hz), so below the split a PER-BIN path runs next to the band path: each sub-bin peak
// (position, mass, width from the bin excess) gets a cut vector looked up from a table solved in prepare() against that tier's window (cut-only, minimum-norm notch whose
// renderer response at the peak equals the excess an auditory filter centred on it would see), scaled by the band path's detection state and knee, attack / release,
// depth ceiling, stereo link and weight curve, and combined with the band curve by max() per bin. Above the split every bin gain is bit-identical to the core without
// it (setLowFreqBinPath(false)). The Fast tier (94 Hz bins) still cannot localise a 100 / 150 Hz resonance: its cut spans a whole bin. ResonanceCore.md section 4.
//
// Live frame-tier switching (ResonanceCore.md section 9). prepare() builds one complete engine per tier (FFT object, windows, bin <-> band maps, statistics tables,
// per-channel overlap-add and detector state) and one input ring per channel that every engine reads its frames from. requestTier() (any thread) stores the wish
// in one atomic; process() adopts it at the start of a call: the new tier's engine takes over the detector and gain state (remapped to its bins), runs next to the
// old one until its overlap-add output is complete (3 hops of the new tier), and then the output crossfades from the old engine to the new one over
// kTierCrossfadeMs. Until that crossfade starts the output (and currentLatency()) stay on the old tier; from its first sample they are on the new one. Nothing is
// allocated, freed, constructed or locked by a switch.
//
// Realtime contract: prepare() / release() allocate and run on a non-audio thread.
// process(), reset() and requestTier() never allocate, lock or log.
//
// Threading: a Core is NOT thread-safe and owns no thread. One instance per audio chain; prepare(), release(), setFrameTier(), setDetectorTimeConstantMs(),
// setFastTimeConstantMs(), setHopPhaseOffset() and setKeepDetectorStateOnTierSwitch() are called on a non-audio thread while the instance is not processing (the
// setters are structural and take effect at the next prepare()). process(), reset() and the introspection accessors belong to the audio (processing) thread.
// Params is passed by value to every process() call and may change freely between calls (tests T4 / T6 / P1 run with parameters swept every block, without
// allocation); process() sanitises it (non-finite -> default, every field clamped to its range). setVizSink() belongs to the processing thread (between process()
// calls) or to a non-audio thread while the instance is not processing. Any thread: requestTier(), latencyFor(), fftSizeFor(), currentLatency(), frameTier(),
// tierSwitchCount() and lastMaxReductionDb() (atomics / pure functions).

#include <juce_dsp/juce_dsp.h>

#include <atomic>
#include <cstdint>
#include <memory>
#include <vector>

namespace xleth::dsp::resonance
{

constexpr int kMaxChannels = 2;
constexpr int kGridBands   = 96;   // detector / gain grid: ERB-rate spaced, 20 Hz .. min(0.45 fs, 20 kHz)

// Parameter block, copied by value into process() once per block. Plain data only. process() sanitises a copy at intake (ResonanceCore.md 9.6): a non-finite
// float field is replaced by its default below, every float field is then clamped to the range given here. Valid values pass through bit-identically.
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
    // sharpness: 0..1. Narrowness of the applied cut: the cross-band smoothing of the band reduction curve. 0.5 (default) = the [1 2 1] / 4 smoothing (the historical
    //        behaviour, bit-identical); towards 1 the smoothing fades out (1 = none, the narrowest cut); towards 0 three further [1 2 1] / 4 passes are blended in
    //        (0 = [1 2 1]^4 / 256, the broadest). Monotonic: lower = broader. Detection is not affected. Applied per frame, after attack / release.
    float sharpness   = 0.5f;
    // weightCurve: nullptr = flat 1 (the historical behaviour). Otherwise numBands() floats on the core's band grid (centres: Core::bandCentreHz(i)), each clamped to
    //        [0, kMaxWeight] (negative = 0; NaN / +-Inf = 1, i.e. that band unweighted). It scales the applied reduction of its band, the Resonance Suppressor's weighting
    //        semantics: w <= 1 gives w x R (0 = the band is never cut), w > 1 gives min(w x R, max(Rmax, R)) (deeper, up to the depth ceiling Rmax; it never creates a
    //        cut where nothing was detected). Applied per frame after attack / release and the stereo link (both channels use the same curve). The array is read during
    //        process() only; it must stay valid for that call.
    const float* weightCurve = nullptr;
};

constexpr float kMaxWeight = 2.5f;   // upper clamp of Params::weightCurve (the RS weighting range is [0, 2.5])

// Visualization tap. Once per hop and per processed channel the processing thread fills one VizFrame (a member of the Core: no allocation) and calls
// VizSink::onResonanceFrame() synchronously, from inside process(), after the gains of that frame are final. The frame is valid only during the call; the sink must
// copy what it needs, must not block, lock, allocate or log (it runs on the audio thread), and must not call back into the Core.
struct VizFrame
{
    long long hopIndex = 0;    // 0-based index of this frame (== framesProcessed() before it); both channels of one hop share it
    int   channel      = 0;    // 0 .. processed channels - 1 (Mid / Side: whatever the caller fed as that channel)
    int   numBands     = 0;    // == Core::numBands() (kGridBands); entries [numBands, kGridBands) are unused
    int   hopSize      = 0;    // samples per hop of the tier in use; without a tier switch since reset() the frame's input ends
                               // hopSize x (hopIndex + 1) - hopPhaseOffset() samples into the stream (after a switch hopIndex keeps counting frames of the tier in use)
    float maxReductionDb = 0.0f;   // max over bands of reductionDb (this channel)
    // Per band, on the core's grid (centres Core::bandCentreHz(i)):
    //   levelDb:    the detector's input level, 10 log10 of the bias-corrected, per-octave weighted average of |X_k|^2 (the 40 ms fast estimate; the 200 ms slow one when the
    //               fast path is off). Pink noise reads flat. It is NOT dBFS: a constant offset that depends on N separates it from any calibrated scale; differences are exact dB.
    //   baselineDb: the flank baseline of that estimate (levelDb - baselineDb = the band's excess, the quantity the detector thresholds).
    //   reductionDb: the applied reduction (>= 0 dB), after attack / release, sharpness, stereo link and weightCurve: exactly what G(f) is built from.
    float levelDb[kGridBands]     = {};
    float baselineDb[kGridBands]  = {};
    float reductionDb[kGridBands] = {};
};

class VizSink
{
public:
    virtual void onResonanceFrame(const VizFrame& frame) noexcept = 0;
protected:
    ~VizSink() = default;
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

    // Allocates everything process() will ever touch, for ALL frame tiers (sized for the largest tier at this rate). numChannels is clamped to 1..kMaxChannels.
    void prepare(double sampleRate, int maxBlockSize, int numChannels);
    void release();
    // Clears all signal state (input ring, overlap-add, detector, gain smoothers) of every tier. A tier transition in progress is completed at once: the core
    // continues on the requested tier, as a freshly prepared instance of that tier would. A pending requestTier() stays pending. RT-safe.
    void reset() noexcept;

    // Frame tiers. N = 512 / 1024 / 2048 at <= 50 kHz (window about 10.7 / 21.3 / 42.7 ms), doubled per sample-rate octave above that. Every time constant stays in ms.
    enum class FrameTier { Fast = 0, Normal = 1, High = 2 };
    // The tier the next prepare() starts on (structural: non-audio thread, not processing). Live changes go through requestTier().
    void setFrameTier(FrameTier t) noexcept { target_ = static_cast<int>(t); activeTier_.store(static_cast<int>(t), std::memory_order_relaxed); }
    // Ask for a live tier change. Callable from ANY thread, at any time (also before prepare() and while process() runs): one atomic store (release); the last
    // request before process() looks wins, earlier ones are overwritten. process() reads it (acquire exchange) at the start of a call when no transition is running
    // and adopts it; a request for the tier already in use is consumed and ignored; a request made during a transition waits for its end. Out-of-range values clamp.
    void requestTier(FrameTier t) noexcept
    {
        const int v = static_cast<int>(t);
        pendingTier_.store(v < 0 ? 0 : (v > 2 ? 2 : v), std::memory_order_release);
    }
    // The tier the output is aligned to (any thread, relaxed). It changes on the first sample of the crossfade to the new tier.
    FrameTier frameTier() const noexcept { return static_cast<FrameTier>(activeTier_.load(std::memory_order_relaxed)); }
    // The tier the core is on or switching to: frameTier() outside a transition, the new tier during one (processing thread).
    FrameTier targetFrameTier() const noexcept { return static_cast<FrameTier>(target_); }
    bool tierTransitionActive() const noexcept { return trans_.active; }               // processing thread
    long long tierSwitchCount() const noexcept { return switches_.load(std::memory_order_relaxed); }   // adopted requests since prepare() (any thread)
    static int fftSizeFor(double sampleRate, FrameTier tier = FrameTier::Normal) noexcept;
    // Latency in samples for a given rate and tier (constant; independent of every Params field). Pure: any thread, before or after prepare().
    static int latencyFor(double sampleRate, FrameTier tier = FrameTier::Normal) noexcept { return fftSizeFor(sampleRate, tier); }
    // The latency the output is aligned to right now: latencyFor(sampleRate(), frameTier()). Any thread (relaxed atomic). During a tier crossfade the output is a
    // blend of the old and the new alignment; this already reads the new latency for the whole crossfade.
    int currentLatency() const noexcept { return latency_.load(std::memory_order_relaxed); }
    // Length of the tier crossfade (5 ms, the family of the EQ spectral restart fade-in): round(kTierCrossfadeMs x sampleRate) samples, >= 1.
    static constexpr float kTierCrossfadeMs = 5.0f;
    int tierCrossfadeSamples() const noexcept { return fadeLen_; }
    // Study option (structural, before prepare(); default true): on a tier switch the new tier starts from the old tier's detector / gain state (remapped power
    // averages, per-band reductions and latches, bias-correction and sigma counters). false = the new tier starts from reset state (the measured alternative, 9.4).
    void setKeepDetectorStateOnTierSwitch(bool keep) noexcept { keepState_ = keep; }
    // Study / reference option (structural, before prepare(); default true): the low-frequency per-bin path below kLowSplitHz. false = no per-bin path and the band path
    // keeps the legacy sub-bin depth correction everywhere: bit-identical to the core before the path existed (the reference the bit-identity tests compare against).
    void setLowFreqBinPath(bool on) noexcept { lfPath_ = on; }
    bool lowFreqBinPath() const noexcept { return lfPath_; }

    // Hop phase offset (structural: set before prepare(); default 0 = the historical behaviour, bit-identical). Shifts the initial frame grid by `samples` (any integer, taken modulo the hop):
    // the hop counter starts that many samples into a hop, so the first frame completes after hop - offset input samples and then every hop. The stream behaves as if it had been preceded by
    // `offset` zero samples: latency stays exactly N, steady-state COLA and every detector time constant are unchanged. Use: a thread that runs n instances back to back gives instance i the
    // offset i x hop / n, so their hops (all of the FFT / detector / gain work) complete in different blocks instead of all in the same one (ResonanceCore.md, "Multi-instance bursts").
    // The offset is kept as a FRACTION of the prepare-time tier's hop (o / H); every tier uses floor(fraction x its hop), on the same stream clock, so a staggering of
    // several instances survives tier switches (exactly whenever the offset times the smallest hop is a multiple of the prepare-time hop, e.g. any multiple of 4
    // samples from a High prepare, of 2 from Normal; hopPhaseOffsetForInstance(i, hop) satisfies it for up to hop / 4 instances; see 9.5).
    void setHopPhaseOffset(int samples) noexcept { hopPhaseOffset_ = samples; }
    int hopPhaseOffset() const noexcept;   // the applied offset of the tier in use, in [0, hop), valid after prepare()
    // The offset for instance `instanceIndex` (0, 1, 2, ...) of any number of instances in one thread: the base-2 van der Corput sequence (bit reversal of the index)
    // times the hop, floored: 0, hop/2, hop/4, 3 hop/4, hop/8, 5 hop/8, 3 hop/8, 7 hop/8, hop/16, ... Every prefix of n instances is spread as evenly as a dyadic
    // grid allows, so instances can be added without re-spacing the others. Result in [0, hop); 0 for instanceIndex <= 0 or hop <= 1.
    static int hopPhaseOffsetForInstance(int instanceIndex, int hop) noexcept;

    // Visualization tap (see VizFrame / VizSink). nullptr (default) = off; the cost of the off state is one pointer test per hop. Set it on the processing thread
    // between process() calls, or on another thread while the instance is not processing; the sink must outlive its use.
    void setVizSink(VizSink* sink) noexcept { vizSink_ = sink; }
    VizSink* vizSink() const noexcept { return vizSink_; }

    // Meter: the largest applied band reduction (dB, >= 0) of the LAST completed frame, after every stage (exactly what reductionDb / bandReductionDb hold).
    // channel 0 / 1: that channel; -1 (default): the max over the channels that frame processed. Updated once per hop on the processing thread with relaxed atomic
    // stores; readable from any thread. 0 after prepare() / reset().
    float lastMaxReductionDb(int channel = -1) const noexcept
    {
        if (channel < 0) return meterAll_.load(std::memory_order_relaxed);
        return channel < kMaxChannels ? meterCh_[channel].load(std::memory_order_relaxed) : 0.0f;
    }

    // In place. Channels [0, min(numChannels, prepared channels)) are processed; any others are untouched.
    // numSamples may be any value >= 0 (it is NOT limited to the prepared maxBlockSize).
    // dryOut (optional, nullptr = off): per processed channel a buffer of numSamples (a null entry skips that channel) that receives the input on EXACTLY the
    // timeline of the wet output: delayed by currentLatency() outside a transition and crossfaded between the old and the new latency with the same gains as the
    // wet output during one. At depth 0 the wet output equals dryOut within the COLA error (-160 dBFS), at every moment of a switch, so an effect that mixes
    // (1 - mix) x dryOut + mix x wet never combs. dryOut must not alias the channel buffers.
    // auxIn / auxOut (optional, both or neither): one delay-only channel (numSamples each) that is NOT analysed or processed; auxOut receives auxIn on
    // exactly the dryOut timeline. It is the Mid / Side recipe's other component (8.3, 9.2): Mid mode processes M as channel 0 and passes S here, so
    // L' = M' + S_d and R' = M' - S_d stay aligned through a tier switch. Pass it on every call while it is in use (its ring is written only when
    // auxIn != nullptr); reset() clears it. auxOut must not alias anything else.
    void process(float* const* channels, int numChannels, int numSamples, const Params& p, float* const* dryOut = nullptr,
                 const float* auxIn = nullptr, float* auxOut = nullptr) noexcept;

    // ---- hooks (stage 1: not implemented) ----
    int numRegions() const noexcept { return 1; }
    RegionOutput regionOutput(int /*regionIndex*/) const noexcept { return {}; }

    // ---- introspection (tests / bench; read on the processing thread between process() calls) ----
    // All of them describe the tier the output is aligned to (frameTier()).
    int fftSize() const noexcept { return eng_[active_].N; }
    int hopSize() const noexcept { return eng_[active_].H; }
    int numBins() const noexcept { return eng_[active_].N / 2 + 1; }
    double sampleRate() const noexcept { return sampleRate_; }
    long long framesProcessed() const noexcept { return frames_; }   // frames of the tier in use (one count per hop; continues across a switch)
    // Band grid (valid after prepare()): numBands() bands (kGridBands), centres ERB-rate spaced from 20 Hz to min(0.45 fs, 20 kHz). Params::weightCurve and every
    // per-band array use this indexing. The grid depends on the sample rate only (not on the frame tier).
    int numBands() const noexcept { return numBands_; }
    float bandCentreHz(int b) const noexcept { return bandHz_[static_cast<size_t>(b)]; }
    float bandHz(int b) const noexcept { return bandHz_[static_cast<size_t>(b)]; }   // alias of bandCentreHz
    // Last frame's per-band values (dB), length numBands().
    const float* bandLevelDb(int c) const noexcept    { return eng_[active_].ch[c].levelDb.data(); }    // averaged level, per-octave units
    const float* bandBaselineDb(int c) const noexcept { return eng_[active_].ch[c].baseDb.data(); }     // robust flank baseline
    const float* bandReductionDb(int c) const noexcept{ return eng_[active_].ch[c].outDb.data(); }      // applied reduction (>= 0); below the split = max(band, per-bin path)
    // Last frame's per-bin real gains (linear, numBins() entries): exactly what multiplied the spectrum (band curve and per-bin path combined).
    const float* binGains(int c) const noexcept       { return eng_[active_].ch[c].binGain.data(); }
    int lowFreqBins() const noexcept                   { return eng_[active_].lfBins; }               // bins [1, lowFreqBins()) are below kLowSplitHz
    // Bytes the low-frequency path's prepare()-time tables hold (all three tiers): notch table + line-source moment tables.
    size_t lowFreqTableBytes() const noexcept;
    const float* bandSigmaDb() const noexcept         { return eng_[active_].sigmaE.data(); }           // std-dev of (level - baseline) on noise
    const float* bandSigmaFastDb() const noexcept     { return eng_[active_].sigmaEF.data(); }          // the same for the fast estimate
    const float* bandFastLevelDb(int c) const noexcept    { return eng_[active_].ch[c].levelFDb.data(); }
    const float* bandFastBaselineDb(int c) const noexcept { return eng_[active_].ch[c].baseFDb.data(); }
    // Detection threshold in units of sigma_E for a sensitivity (0..1): 6 sigma at 0, 4 at 0.5, 2 at 1.
    static float thresholdSigmas(float sensitivity) noexcept
    {
        const float s = sensitivity < 0.0f ? 0.0f : (sensitivity > 1.0f ? 1.0f : sensitivity);
        return 6.0f - 4.0f * s;
    }
    // The sanitised copy process() works on (ResonanceCore.md 9.6). Exposed for tests and for an effect that wants to show what is in effect.
    static Params sanitizeParams(const Params& p) noexcept;
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
    // Onset rule, in FAST sigmas: fast - slow > 2.0 -> the band uses the fast estimate (the slow average needs ~200 ms to reach a new level, the fast one ~40 ms, so a real
    // onset opens a gap of several fast sigmas within a few frames). History: 2.5 came from the first, symmetric (+-2.5) attempt and met G8a on the default noise only; at
    // 500 Hz the fast estimate's sigma is 1.2 / 1.5 / 1.9 dB (F / N / H), the onset gap of a +12 dB / Q 8 bell peaks at ~3.3 dB at N, so 2.5 sigma (3.8 dB) fired in only
    // 24 - 40 % of the rise frames and the 200 ms slow average stayed in charge (G8a 500 Hz failed on 3 - 4 of 6 dev seeds; docs/RS_LOWFREQ_DIAGNOSIS.md, H5). 1.5 sigma
    // (the diagnosis' prototype) hands clean noise to the fast estimate too often: unit test F1 (pink noise, sensitivity 1) mean cut 0.243 dB against its 0.2 dB bound.
    // 2.0 sigma keeps F1 at 0.116 dB (ResonanceCore.md 1.4).
    static constexpr float kSwitchUpSigmas    = 2.0f;
    // Knee width while the FAST estimate is in charge (onset or release latch), in fast sigmas: Hard 0.5, Soft 1.0 (one third of the steady knee, 1.5 / 3 sigma, in both
    // modes). The fast estimate's sigma is 2 - 3x the slow one's, so the steady knee width would leave an onset at a fraction of its depth until the slow average caught up.
    static constexpr float kFastKneeSigmasHard = 0.5f;
    static constexpr float kFastKneeSigmasSoft = 1.0f;
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
    // Low-frequency per-bin path (ResonanceCore.md section 4).
    //   kLowSplitHz: bins below it get the per-bin path (every tier, every sample rate; Hz, not an ERB-vs-kernel rule). 400 Hz: a Q 8 bell is narrower than one bin of the
    //     Normal tier below ~370 Hz, the band path already meets G1 at 500 Hz on every tier, and the G8a onset cell (500 Hz) stays entirely on the band path.
    //   kLowSplitGuardBands: the band path's own change below the split (no sub-bin depth correction: the per-bin path now carries the sub-bin depth) is limited to bands
    //     more than this many bands below the first band at / above the split, so the cross-band smoothing (reach <= 4 bands at sharpness 0) and the band -> bin
    //     interpolation leave every bin at / above the split bit-identical.
    static constexpr float kLowSplitHz        = 400.0f;
    static constexpr int   kLowSplitGuardBands = 6;
    static constexpr int   kLfDeltaSteps = 32;        // notch table: sub-bin offset of the peak in [0, 1], 33 rows
    static constexpr int   kLfDepthSteps = 24;        // notch table: depth 0 .. kLfDepthMaxDb in 1 dB steps, 25 columns
    static constexpr float kLfDepthMaxDb = 24.0f;     // the deepest ceiling (Hard, depth 1)
    static constexpr int   kLfTaps       = 6;         // notch table: cut on bins floor(p) - 2 .. floor(p) + 3
    static constexpr int   kLfLineSteps  = 32;        // line-source moment tables: peak offset -0.5 .. +0.5 bin, 33 rows
    static constexpr int   kLfWidthSteps = 24;        // line-source share table: source widths 0 .. 8 bins, 25 columns

private:
    struct Channel
    {
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
        // low-frequency per-bin path (bins [0, lfBins) of this engine)
        std::vector<float> lfRed;     // per bin, attack / release state of the per-bin cut (dB, >= 0)
        std::vector<float> lfOut;     // per bin, after the stereo link (dB), before the weight curve
    };

    // Everything that depends on the frame size N: one per tier, all built in prepare().
    struct Engine
    {
        int N = 0, H = 0;
        int slowPeriod = 4, fastPeriod = 2;   // baseline refresh periods in frames
        int hopOffset = 0;                    // frames end at stream positions e with (e + hopOffset) % H == 0
        std::unique_ptr<juce::dsp::FFT> fft;
        std::vector<float> window;            // sqrt-Hann (periodic), analysis
        std::vector<float> synthesis;         // sqrt-Hann × 1/Σw² of its hop phase
        // band <- bins (CSR, weights include f_k), flank band lists per side, main-lobe zones, bin -> band interpolation
        std::vector<int>   bwStart, bwBin;  std::vector<float> bwW;
        std::vector<int>   flStart[2], fl[2];
        std::vector<int>   lobeLo, lobeHi;
        std::vector<int>   binBand;  std::vector<float> binFrac;
        // statistics
        float emaA = 0.0f, emaB = 1.0f;       // per-frame power average: S = a S + b P
        std::vector<double> vfTime;           // variance factor of the bias-corrected average after n frames (index n-1)
        float emaAF = 0.0f, emaBF = 1.0f;     // the same for the fast average
        std::vector<double> vfTimeF;
        std::vector<float> vfBin;             // per band: variance factor of the bin weighting
        std::vector<float> sideX[2];          // per band and side: mean log2(f) of the flank bands
        std::vector<float> sideVf[2];         // per band and side: mean bin variance factor of the flank bands
        std::vector<float> sideNeff[2];       // per band and side: effective independent flank values
        std::vector<float> sigmaE, sigmaEF;   // per band std-dev of excess (dB) at the current frame count (slow / fast)
        // sub-bin (auditory-resolution) excess at low f
        int kLowMax = 0;                      // last bin whose ERB is narrower than the analysis kernel's ENBW
        float kernelVar = 0.0f;               // second moment (bins^2) a narrowband source shows over +/-2 bins
        std::vector<float> erbBins;           // per bin: ERB(f_k) in bins
        // low-frequency per-bin path (all built in prepare(); see kLowSplitHz)
        int lfBins = 0;                       // bins [1, lfBins) lie below kLowSplitHz
        int lfBandSplit = 0;                  // first band whose centre is >= kLowSplitHz (bands below it are folded with the per-bin path for publishing)
        int lfBandLo = 0;                     // bands below this one run without the sub-bin depth correction (lfBandSplit - kLowSplitGuardBands)
        std::vector<float> lfTable;           // [(kLfDeltaSteps + 1) x (kLfDepthSteps + 1) x kLfTaps] cut (dB) on bins floor(p) - 2 .. + 3
        std::vector<float> lfLineC;           // [3 x (kLfLineSteps + 1)] line source at k0 + d: excess centroid - k0 (window truncated at bin 1 for k0 = 1, 2)
        std::vector<float> lfLineShare;       // [3 x (kLfLineSteps + 1) x (kLfWidthSteps + 1)] share of the window's excess in bin k0 for a source of width w bins
        std::vector<float> lfWidths;          // [kLfWidthSteps + 1] source widths of the share table, bins
        // running state
        double emaAn = 1.0, emaAnF = 1.0;     // a^n (bias correction 1 / (1 - a^n)), slow / fast
        long long frames = 0;                 // detector frame count of this engine (sigma tables, baseline stagger)
        long long nextEnd = 0;                // stream position at which this engine's next frame completes
        bool forceRefresh = false;            // next frame recomputes every baseline (set by a tier switch that kept the state)
        Channel ch[kMaxChannels];
    };

    struct Transition
    {
        bool active = false;
        int from = 0, to = 0;                 // engine indices
        long long valid = 0;                  // stream position of the new engine's first complete output sample == start of the crossfade
    };

    void buildSharedGrid();
    void buildEngine(Engine& e, FrameTier tier);
    void resetEngine(Engine& e) noexcept;
    int hopOffsetFor(int hop) const noexcept;
    void updateSigma(Engine& e) noexcept;
    void updateSigmaFor(const Engine& e, const std::vector<double>& vfTime, long long frames, std::vector<float>& sigmaOut) noexcept;
    void processFrame(Engine& e, long long end, int numCh, const Params& p, bool publish) noexcept;
    void emitViz(const Engine& e, int numCh) noexcept;
    // Detector + gain computer: writes Channel::binGain for channels [0, numCh). Returns false when every
    // gain is exactly 1 (the multiply is then skipped). publish = false: meters are not written (an engine that is not the output's).
    bool computeGains(Engine& e, int numCh, const Params& p, bool publish) noexcept;
    void detectChannel(Engine& e, Channel& ch, double biasCorr, double biasCorrFast) noexcept;
    // refreshPeriod: each band's flank baseline (the median-heavy part) is recomputed every refreshPeriod-th frame, staggered over the
    // bands; levels are exact every frame. Every baseline is recomputed on the first frames, after a state-keeping tier switch and whenever the mean band level has moved
    // by more than kBaselineJumpDb since the last full refresh (a broadband onset: the stale baseline would show false excess).
    void bandLevelsAndBaseline(const Engine& e, const float* S, float* L, float* base, double biasCorr, int refreshPeriod, float& refMean) noexcept;
    void subBinCorrection(const Engine& e, Channel& ch, double biasCorr) noexcept;
    void buildLowFreqTables(Engine& e);
    // Per-bin target of one channel's low-frequency path (dB, written to lfTgt_[0, lfBins)), from the slow bin excess and the band path's gated knee (kGate_).
    void lowFreqTargets(const Engine& e, const Channel& ch, double biasCorr, float rMax, bool hard) noexcept;
    static void remapLowFreq(const Engine& from, const Engine& to, const float* src, float* dst) noexcept;
    float median(const int* idx, int n, const float* values) noexcept;
    // Tier switching (audio thread).
    void adoptPendingTier(int numCh, const Params& p) noexcept;
    void transferState(const Engine& from, Engine& to, int numCh) noexcept;
    static void remapPower(const Engine& from, const Engine& to, const float* src, float* dst) noexcept;
    struct Io { float* const* channels; float* const* dryOut; const float* auxIn; float* auxOut; };
    int processSteady(const Io& io, int numCh, int offset, int n, const Params& p) noexcept;
    int processTransition(const Io& io, int numCh, int offset, int n, const Params& p) noexcept;
    void ringWrite(float* ring, long long at, const float* src, int n) const noexcept;
    void ringRead(const float* ring, long long at, float* dst, int n) const noexcept;
    float ringAt(const float* ring, long long at) const noexcept { return ring[static_cast<size_t>(at & ringMask_)]; }

    double sampleRate_ = 0.0;
    float detectorTauMs_ = kDefaultDetectorTauMs;
    float fastTauMs_ = kDefaultFastTauMs;
    bool prepared_ = false;
    bool keepState_ = true;
    bool lfPath_ = true;               // low-frequency per-bin path (structural, setLowFreqBinPath)
    int numChannels_ = 0;
    int hopPhaseOffset_ = 0;           // as set by setHopPhaseOffset()
    int hopOffset0_ = 0, hop0_ = 1;    // the applied offset at prepare() and the prepare-time tier's hop: the stored fraction hopOffset0_ / hop0_
    long long frames_ = 0;             // published frames (framesProcessed(), VizFrame::hopIndex)
    long long pos_ = 0;                // stream position: input samples consumed since prepare() / reset()
    int fadeLen_ = 1;                  // tier crossfade, samples

    // Tiers: engines, the one the output is aligned to, the target, the request, the transition.
    Engine eng_[3];
    int active_ = 1;                   // engine the output (and the introspection) is aligned to
    int target_ = 1;                   // tier on or switching to; also the prepare-time tier (setFrameTier)
    std::atomic<int> activeTier_ { 1 };
    std::atomic<int> latency_ { 0 };
    std::atomic<int> pendingTier_ { -1 };   // -1 = no request
    std::atomic<long long> switches_ { 0 };
    Transition trans_;

    // Input ring per channel: the analysis FIFO of every engine and the source of the aligned dry. Length a power of two >= 2 x the largest N.
    std::vector<float> ring_[kMaxChannels];
    std::vector<float> auxRing_;          // the delay-only aux channel (same length)
    long long ringMask_ = 0;

    // ---- band grid (ERB-rate spaced, depends on the sample rate only), built in prepare() ----
    int numBands_ = 0;
    double erbLo_ = 0.0, erbStep_ = 1.0;
    std::vector<float> bandHz_;
    std::vector<float> bandX_;            // per band log2(f)
    int slopeLo_ = 0, slopeHi_ = 0;       // band range of the wideband tilt fit (one-sided flank extrapolation)
    double slopeXMean_ = 0.0, slopeSxx_ = 1.0;
    // ---- scratch (sized for the largest tier) ----
    std::vector<float> binX_, binF_;      // per bin scratch: excess fraction, correction factor
    std::vector<float> scratch_;          // median scratch
    std::vector<float> tmpBand_;          // per band scratch
    std::vector<float> estBand_;          // per band: the excess estimate (dB) the gain computer reduces by
    std::vector<float> kGate_;            // per band: the gated knee of the current channel (0 when the band's estimate is <= 0), read by the per-bin path
    std::vector<float> lfX_, lfTgt_, lfW_;   // per low-frequency bin: excess fraction, per-bin target (dB), interpolated weight
    // ---- visualization tap and meters ----
    VizSink* vizSink_ = nullptr;
    VizFrame vizFrame_;                   // filled in place once per hop and channel while a sink is set
    std::atomic<float> meterCh_[kMaxChannels] = {};
    std::atomic<float> meterAll_ { 0.0f };
};

} // namespace xleth::dsp::resonance
