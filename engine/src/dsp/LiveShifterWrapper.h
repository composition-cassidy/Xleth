#pragma once
#include <juce_audio_basics/juce_audio_basics.h>

#include <atomic>
#include <memory>
#include <vector>

namespace RubberBand { class RubberBandLiveShifter; }

namespace xleth::dsp {

// --- LiveShifterWrapper -----------------------------------------------------
//
// RAII wrapper over RubberBand::RubberBandLiveShifter (Rubber Band v4.0.0,
// already vendored as `rubberband_static`), adapting it to XLETH's realtime
// audio path. Pitch only - the LiveShifter has no time ratio, so duration is
// preserved structurally.
//
// Two engine modes will sit on this wrapper:
//   Smart - Window::Medium + Formant::Shifted   + channelsTogether
//   Voice - Window::Short  + Formant::Preserved, Formant knob -> setFormantScale
//
// --- What the LiveShifter's own header requires of us -----------------------
//
// 1. shift() consumes and produces EXACTLY getBlockSize() frames (512 in the R3
//    implementation), de-interleaved, with input and output arrays that may not
//    alias. The engine hands us variable block sizes, so process() runs an
//    input FIFO and an output FIFO across it - see the FIFO invariant below.
//
// 2. setPitchScale() "may not be called concurrently with shift()", and there
//    is no internal mutex. The formant setters are in the same position. So all
//    three are STAGED in atomics by the setters and applied on the audio
//    thread, in the gap between whole-block shift() calls. Nothing else in this
//    class touches the shifter.
//
// 3. getStartDelay() must be read with the pitch already set, and R3LiveShifter
//    only re-measures its resampler delays while m_firstProcess is true. Hence
//    the sweep in prepare(), before any shift().
//
// 4. getStartDelay() returns size_t but computes a signed int that goes
//    NEGATIVE for downward shifts (about -1536 at -24 st, 48 kHz), so it is
//    read back through int64_t and clamped at 0. Taking max() of the raw size_t
//    would latch the wrapped ~1.8e19 instead.
//
// 5. The window and channel options are fixed at construction; only
//    setFormantOption() is mutable at runtime. setWindowOption() and
//    setChannelsTogether() therefore rebuild the shifter and are prepare /
//    message-thread only.
//
// --- LATENCY INVARIANCE (hard requirement) ----------------------------------
//
// The reported latency is fixed for the lifetime of a prepare() and does not
// move when pitch is automated. This is the whole point of the class: XLETH's
// automation write path deliberately bypasses onParameterValueChanged
// (XlethEffectBase.h:250-262), so a latency-affecting parameter automates its
// value WITHOUT re-running PDC, and any pitch-dependent latency would desync
// silently.
//
// The hazard here is real and large. Measured impulse delay through this
// wrapper at 48 kHz, BEFORE compensation:
//
//     -24 st  6396      0 st  3136     +12 st  4160
//     -12 st  4225     +7 st  3646     +24 st  5439
//
// - a 3260-sample (68 ms) swing across the pitch range.
//
// Three findings shape the fix, all measured rather than assumed:
//
//   (a) max(getStartDelay()) over the sweep is 8832 at 48 kHz, which matches
//       NONE of the real delays above. The header's number describes the
//       shifter's start-up alignment, not its steady-state pipeline delay, so
//       padding to it would report a latency the effect does not have. It is
//       still computed and exposed through getMaxStartDelay(), as a sanity
//       bound and because it is cheap.
//
//   (b) The real delay is very nearly a function of the current pitch, so
//       measuring it once per configuration and padding up to the worst case
//       works: prepare() calibrates by impulse over a 2-semitone grid and
//       reports
//
//           latency = blockSize + max(curve)
//
//       with the output running through a pad delay line held at
//       max(curve) - curve(pitch). Measured residual after compensation, on a
//       stream that sets its pitch and plays: worst 30 samples (0.62 ms), from
//       3260 samples (68 ms) uncompensated.
//
//   (c) It is NOT exactly a function of pitch - the pipeline is path dependent.
//       Reached by walking a 2-semitone grid, +18 st settles at 4293 samples;
//       reached by a jump from unity it settles at 5571. The calibration
//       therefore measures every point along the path the runtime actually
//       takes (reset, prime at unity, jump to the target pitch, settle), which
//       is what collapses the residual in (b) to 30 samples.
//
//       What that path-matching cannot cover is automation that jumps a long
//       way from some third pitch. An instantaneous +24 st -> -24 st leap - the
//       most extreme move available - lands 421 samples (8.8 ms) off, against
//       3260 uncompensated. Removing that last piece would mean tracking the
//       shifter's internal ring levels, i.e. modifying vendored Rubber Band
//       source. It is bounded, it decays as the automation continues, and the
//       REPORTED latency never moves, so PDC never desyncs - the residual is an
//       alignment error inside a pitch sweep, not a drifting compensation.
//
// The calibration is cached per (sample rate, channels, options), so only the
// first prepare() of a given configuration pays it: about 390 ms, against 40 ms
// for every prepare() after that.
//
// The `blockSize` term is the FIFO adapter's own delay. Pre-filling the output
// FIFO with blockSize zeros at prepare makes `inCount + outCount == blockSize`
// an invariant of process(), which (a) guarantees the drain can never underrun
// for any request up to maxBlockSize and (b) pins the adapter delay at exactly
// blockSize instead of letting it wander with the caller's block size.
//
// --- Realtime contract ------------------------------------------------------
//
// prepare() allocates and runs the calibration. process() allocates nothing,
// locks nothing, logs nothing. The shifter itself is documented realtime safe
// at debug level 0, which is what we set.
//
// --- TWO-PHASE RESET (spare shifter) ----------------------------------------
//
// A reset has to prime away the start-up pre-pad (kPrimeBlocks silent shift()
// calls, ~15 ms of CPU), and live playback resets under the effect chain's
// realtime claim, during which the whole chain renders silence. Priming inline
// cost ~30 ms of silence per seek on a Pitch Shifter track.
//
// So the wrapper owns a SECOND shifter, primed ahead of time into exactly the
// state a reset produces, and reset() just swaps it in:
//
//   primeSpare()  - the expensive half. Runs OFF the claim, concurrently with
//                   process(), and touches nothing process() touches.
//   reset()       - the cheap half, run where it always was. Adopts the primed
//                   spare (a pointer swap plus FIFO/pad clears) when one is
//                   ready, and falls back to priming inline when not, so a
//                   caller that never primes gets the old behaviour.
//   markStale()   - for a wrapper the effect is not currently running: the
//                   next process() adopts the spare itself (realtime safe - it
//                   is the same swap), so an inactive engine costs the reset
//                   nothing at all.
//
// Ownership of spare_ is handed across threads by spareReady_:
//   false - the primer owns it; reset()/process() never touch it.
//   true  - reset()/process() own it; primeSpare() never touches it.
// Each side publishes the handoff with a release store and takes it with an
// acquire load, so the two never touch the spare at the same time.
//
// A spare primed ahead of time is bit-identical to a shifter primed inline
// (same options, same reset() + unity + kPrimeBlocks path), which is what keeps
// an export deterministic whichever path its reset took.
//
class LiveShifterWrapper
{
public:
    enum class Window  { Short, Medium };
    enum class Formant { Shifted, Preserved };

    static constexpr double kMaxSemitones = 24.0;

    // Delay-curve calibration grid: 2-semitone steps over +/-24 st, linearly
    // interpolated in semitones. The curve is smooth (it is built from
    // max(1, p) and max(1, 1/p) terms), so this resolution costs a handful of
    // samples of fit error - see the residual the test reports.
    static constexpr int kCalPoints   = 25;
    static constexpr int kCalStepSemis = 2;

    // Crossfade length, in samples, when the pad depth changes. A pad change is
    // a step in the output's time base; crossfading two read taps makes it
    // inaudible without the Doppler a slewed read head would introduce.
    static constexpr int kPadFadeLen = 256;

    LiveShifterWrapper();
    ~LiveShifterWrapper();

    LiveShifterWrapper(const LiveShifterWrapper&)            = delete;
    LiveShifterWrapper& operator=(const LiveShifterWrapper&) = delete;

    // --- Construction-time options (message thread only) ---
    // These are baked into the shifter's constructor options, so changing one
    // after prepare() rebuilds the shifter. Never call from the audio thread.
    void setWindowOption(Window w);
    void setChannelsTogether(bool together);

    // Allocates, sweeps the pitch range, calibrates the delay curve, builds the
    // shifter. Message thread only. Safe to call repeatedly.
    void prepare(double sampleRate, int numChannels, int maxBlockSize);

    // Drops all buffered audio. Never concurrent with process(). Adopts the
    // primed spare when one is ready - cheap, allocation free and realtime
    // safe, which is what lets a live seek reset the effect on the audio
    // thread (XlethPitchShifterEffect::resetOnAudioThread checks
    // isSpareReady() first). Otherwise calls the shifter's reset() and primes
    // inline, which is NOT realtime safe. See TWO-PHASE RESET above.
    void reset();

    // The expensive half of reset(): primes the spare shifter if it is not
    // already primed. Off the audio thread; safe to run concurrently with
    // process() and reset(), NOT with prepare() or another primeSpare().
    // Returns true iff it primed (false: already ready, or not prepared).
    bool primeSpare();

    // True when the next reset() (or stale process()) will be a swap.
    bool isSpareReady() const noexcept { return spareReady_.load(std::memory_order_acquire); }

    // Reset this wrapper lazily: the next process() adopts the primed spare
    // before touching audio (or, if none is ready, just drops its buffered
    // audio). For a wrapper the owning effect is not running. Same threading
    // as reset().
    void markStale() noexcept { stale_.store(true, std::memory_order_release); }

    // --- Audio-thread safe setters (staged, applied between shift() calls) ---

    // Pitch in semitones + cents, clamped to +/-kMaxSemitones combined.
    void setPitch(int semitones, int cents) noexcept;

    // Formant envelope scale (target/source). 0.0 is Rubber Band's "automatic"
    // sentinel: 1/pitchScale under Formant::Preserved, 1.0 under
    // Formant::Shifted. Any other value shifts formants by that amount
    // regardless of the option - which is what the Voice mode's Formant knob
    // drives.
    void setFormantScale(float scale) noexcept;

    // Runtime-mutable, unlike the window option: the LiveShifter header says
    // setFormantOption "may be called at any time in any mode".
    void setFormantOption(Formant f) noexcept;

    // --- Queries ---

    // Constant for the lifetime of a prepare(). Never varies with pitch.
    int getLatencySamples() const noexcept { return latencySamples_; }

    // The shifter's fixed shift() granularity, 0 before prepare().
    int getBlockSize() const noexcept { return blockSize_; }

    // max(getStartDelay()) over the +/-24 st sweep, clamped at 0. Diagnostic
    // only - see finding (a) above for why it does not drive the padding.
    int getMaxStartDelay() const noexcept { return maxStartDelay_; }

    // The calibrated worst-case pipeline delay, excluding the FIFO adapter.
    int getCalibratedMaxDelay() const noexcept { return targetDelay_; }

    // Calibrated pipeline delay at a given pitch, before padding. Exposed so
    // the test can report the raw curve it is compensating.
    int getCalibratedDelayAt(double semitones) const noexcept;

    double getPitchRatio() const noexcept { return pitchTarget_.load(std::memory_order_relaxed); }
    bool   isPrepared()    const noexcept { return prepared_; }

    // In-place. Realtime safe: no allocation, no locking, no logging.
    // Blocks larger than the prepared maximum, or with more channels than
    // prepared, are left untouched rather than reallocating.
    void process(juce::AudioBuffer<float>& block) noexcept;

private:
    void rebuild();                       // (re)construct the shifter from options
    int  sweepMaxStartDelay();            // +/-24 st sweep; leaves pitch restored
    void calibrateDelayCurve();           // impulse sweep, cached per configuration
    int  measureDelayAtRatio(double ratio, int settleBlocks, int captureBlocks);
    void applyStagedParams() noexcept;    // audio thread, between shift() calls
    int  optionFlags() const noexcept;
    std::unique_ptr<RubberBand::RubberBandLiveShifter> makeShifter() const;
    void adoptSpare() noexcept;           // swap the primed spare in
    void clearStreamState() noexcept;     // FIFOs + pad line back to post-prepare

    std::unique_ptr<RubberBand::RubberBandLiveShifter> shifter_;

    // --- Spare shifter (see TWO-PHASE RESET). Its own silent scratch, so
    //     priming never touches shiftIn_/shiftOut_, which process() uses. ---
    std::unique_ptr<RubberBand::RubberBandLiveShifter> spare_;
    juce::AudioBuffer<float>  spareIn_;
    juce::AudioBuffer<float>  spareOut_;
    std::vector<const float*> spareInPtrs_;
    std::vector<float*>       spareOutPtrs_;
    std::atomic<bool> spareReady_ { false };
    std::atomic<bool> stale_      { false };

    // --- Options (construction-time except formant) ---
    Window window_           = Window::Medium;
    bool   channelsTogether_ = true;

    // --- Prepared state ---
    double sampleRate_     = 0.0;
    int    numChannels_    = 0;
    int    maxBlockSize_   = 0;
    int    blockSize_      = 0;
    int    maxStartDelay_  = 0;   // diagnostic, from getStartDelay()
    int    targetDelay_    = 0;   // max of the calibrated curve
    int    latencySamples_ = 0;
    bool   prepared_       = false;

    std::vector<int>   delayCurve_;   // kCalPoints entries, -24 st .. +24 st
    std::vector<float> calScratch_;   // impulse capture, prepare() only

    // --- FIFOs. Invariant across process(): inCount_ + outCount_ == blockSize_,
    //     seeded by pre-filling the output FIFO with blockSize_ zeros. ---
    juce::AudioBuffer<float> inFifo_;    // capacity blockSize_ + maxBlockSize_
    juce::AudioBuffer<float> outFifo_;   // capacity blockSize_ + maxBlockSize_
    int inCount_  = 0;
    int outCount_ = 0;

    // Scratch handed to shift(). Input and output must not alias, so these are
    // two distinct buffers, both owned.
    juce::AudioBuffer<float>  shiftIn_;
    juce::AudioBuffer<float>  shiftOut_;
    std::vector<const float*> shiftInPtrs_;
    std::vector<float*>       shiftOutPtrs_;

    // --- Pad delay line: holds total latency constant across pitch. ---
    juce::AudioBuffer<float> padLine_;
    int padCapacity_ = 0;
    int padWrite_    = 0;
    int padCurrent_  = 0;   // depth being read now
    int padPrevious_ = 0;   // depth being faded out of
    int padFade_     = 0;   // samples of crossfade remaining, 0 = settled

    // --- Staged parameters (any thread -> audio thread) ---
    std::atomic<double> pitchTarget_   { 1.0 };
    // The same pitch in semitones, so the audio thread can index the delay
    // curve without a log2() to undo the pow() the setter just did.
    std::atomic<double> semisTarget_   { 0.0 };
    std::atomic<double> formantTarget_ { 0.0 };
    std::atomic<int>    formantOption_ { (int) Formant::Shifted };

    // Last values actually pushed into the shifter, so applyStagedParams() only
    // calls the setters when something really changed.
    double appliedPitch_      = -1.0;
    double appliedFormant_    = -1.0;
    int    appliedFormantOpt_ = -1;
};

} // namespace xleth::dsp
