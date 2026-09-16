#pragma once
#include <juce_audio_basics/juce_audio_basics.h>

#include <array>
#include <atomic>
#include <vector>

namespace xleth::dsp {

// --- GranularShifter --------------------------------------------------------
//
// Realtime, duration-preserving granular pitch shifter.
//
// Overlapping Hann-windowed grains are read out of a circular input buffer at
// `pitchRatio` samples per output sample and overlap-added at the *original*
// rate, so the output advances 1:1 with the input - pitch moves, duration does
// not. Time ratio is fixed at 1.0 by construction; there is no stretch mode.
//
// Pitch is 2^((semitones + cents/100) / 12), clamped to +/-24 semitones.
// Grain size is 10-100 ms. Both are audio-thread settable at any time.
//
// --- Known artifact profile (measured, see test_pitch_shift_dsp) ------------
//
// Two families, and they are not the same thing:
//
//   Images / aliases from the fractional read head. Measured as the energy a
//   200 Hz .. 5 kHz band puts above where shifting can legitimately carry it:
//   -57.6 dB worst case over +/-12 st, and -114.6 dB at ratio exactly 2, where
//   the read head lands on integers and the interpolator never runs. This is
//   what the Hermite read head buys, and it is the number worth defending.
//
//   Grain-rate modulation. Every relaunch advances the read phase by
//   2*pi*f*(r-1)*G, so the overlap-add is amplitude-modulated at the grain rate
//   and sidebands appear at f_out +/- k/G. On a PURE SINE at an unlucky
//   frequency the crossfading grains land in antiphase and null the carrier
//   outright. This is intrinsic to every delay-line / granular shifter - the
//   classic "warble" - and no choice of window removes it. Fixing it needs
//   correlation-aligned grain placement (WSOLA) or pitch-synchronous placement
//   (PSOLA), both of which are different algorithms, not tunings of this one.
//
// Per-grain length jitter was tried as a mitigation and REMOVED. It spreads the
// discrete sideband into a broadband floor without lowering it, and it measured
// worse on both of the numbers that matter: the aliasing figure above, and the
// peak output slope at grain boundaries. If it is ever revisited, note that it
// must stay one-sided (never longer than the requested size) or it breaks the
// read-head bounds the latency invariant rests on.
//
// There is deliberately NO formant control. A granular shifter resamples whole
// grains, which moves the spectral envelope with the pitch by construction;
// preserving formants needs a cepstral/LPC corrector on top, which is a
// separate DSP project. See PITCH SHIFTER AUDIT.txt section 2.1.
//
// --- LATENCY INVARIANCE (hard requirement) ----------------------------------
//
// Reported latency is ALWAYS 2 * kMaxGrainMs (200 ms), whatever the grain size
// and whatever the pitch ratio. It is computed once, in prepare(), from the
// sample rate alone.
//
// This is not cosmetic. Grain size and pitch are both automatable, and XLETH's
// automation write path deliberately bypasses onParameterValueChanged (see
// XlethEffectBase.h:250-262), so a latency-affecting parameter automates its
// value WITHOUT re-running PDC. A pitch- or size-dependent latency would
// therefore desync silently - the same hazard class as the known PDC-desync
// bug. Making latency a constant removes the hazard at the source.
//
// How the constant is achieved: each grain's read head is *centred* on a fixed
// delay L = 2 * maxGrainSamples. Within a grain of length G and ratio r the
// delay runs
//
//     delay(t) = L + (r - 1) * (G/2 - t),   t in [0, G)
//
// so it is exactly L at the grain's midpoint, where the Hann window peaks. The
// algorithmic delay is therefore L for every r and every G, with no output pad
// FIFO needed. The excursion either side is bounded by |r-1| * G/2, and the
// worst case (r = 2^2 = 4, G = maxGrain) is 1.49 * maxGrain < L - i.e. the read
// head can never overtake the write head, which is precisely why L is 2x the
// maximum grain and not less.
//
// At r == 1 the delay is a constant integer L, every grain reads the same
// sample, and the normalised overlap-add sums to exactly 1 - so unity pitch is
// a bit-exact pass-through delayed by L. That is what the latency test
// measures, and it is why the measurement is exact rather than approximate.
//
// --- Realtime contract ------------------------------------------------------
//
// prepare() allocates. process() allocates nothing, locks nothing, logs
// nothing, and is noexcept. Parameter setters are lock-free atomic stores and
// are safe from any thread.
//
class GranularShifter
{
public:
    static constexpr double kMinGrainMs   = 10.0;
    static constexpr double kMaxGrainMs   = 100.0;
    static constexpr double kMaxSemitones = 24.0;

    // Number of concurrently overlapping grain streams. 2 is the minimum for
    // gapless Hann overlap-add.
    //
    // The default is 2, chosen by measurement, and 4 is deliberately NOT the
    // default even though more overlap sounds like it should be smoother. With
    // S evenly staggered streams the grain phases sit at k * 2*pi*f*(r-1)*G/S,
    // and at S = 4 those four phasors can land on 0, 90, 180 and 270 degrees
    // and annihilate the carrier completely. Measured on a pure sine, worst
    // grain-rate skirt energy relative to the carrier's own main lobe:
    //
    //     -12 st    2 streams   0.0 dB      4 streams  +34.6 dB
    //      +7 st    2 streams  +4.3 dB      4 streams  +44.2 dB
    //     +12 st    2 streams   0.0 dB      4 streams  +23.6 dB
    //
    // Aliasing is a wash (worst case -57.6 dB at 2 streams vs -55.1 dB at 4),
    // so there is nothing on the other side of the trade. 4 stays selectable
    // through prepare() for callers that want it. Numbers from
    // test_pitch_shift_dsp, sections [1b] and [2].
    static constexpr int kDefaultStreams = 2;
    static constexpr int kMinStreams     = 2;
    static constexpr int kMaxStreams     = 4;

    GranularShifter() = default;

    // Allocates. Message thread only. `numStreams` is clamped to
    // [kMinStreams, kMaxStreams]. Safe to call repeatedly.
    void prepare(double sampleRate, int numChannels, int maxBlockSize,
                 int numStreams = kDefaultStreams);

    // Clears history and re-staggers the grain streams. Cheap and
    // allocation-free, so it is safe from the audio thread between blocks.
    void reset() noexcept;

    // Pitch in semitones + cents, clamped to +/-kMaxSemitones combined.
    // Audio-thread safe; takes effect on the next grain launch per stream, so
    // the change is Hann-crossfaded in rather than stepped.
    void setPitch(int semitones, int cents) noexcept;

    // Grain size in milliseconds, clamped to [kMinGrainMs, kMaxGrainMs].
    // Audio-thread safe; latched per grain at launch, same as pitch.
    void setGrainSizeMs(double ms) noexcept;

    // Constant for the lifetime of a prepare(). Never varies with pitch or
    // grain size - see the latency-invariance note above.
    int getLatencySamples() const noexcept { return latencySamples_; }

    double getPitchRatio()  const noexcept { return ratioTarget_.load(std::memory_order_relaxed); }
    double getGrainSizeMs() const noexcept;
    int    getNumStreams()  const noexcept { return numStreams_; }
    bool   isPrepared()     const noexcept { return prepared_; }

    // In-place. `block` must have at most the prepared channel count and at
    // most the prepared maximum block size; anything larger is left untouched
    // rather than reallocating.
    //
    // Realtime safe: no allocation, no locking, no logging.
    void process(juce::AudioBuffer<float>& block) noexcept;

private:
    // One grain stream. Pitch ratio and length are latched at launch so that a
    // mid-flight parameter change never discontinuously retargets a grain that
    // is already sounding; the new value fades in with the next grain's Hann
    // envelope instead.
    struct Grain
    {
        int    pos   = 0;    // output samples elapsed within this grain
        int    len   = 1;    // grain length in output samples (latched)
        double ratio = 1.0;  // input samples consumed per output sample (latched)
    };

    // Hann lookup, read by normalised phase with linear interpolation, so one
    // table serves every grain length without a per-sample cos().
    static constexpr int kWindowTableSize = 4096;

    // Grain slots. More than kMaxStreams so that a launch on the hop clock can
    // always find a FINISHED slot and never truncates a sounding grain, even
    // while a grain-size change has two lengths in flight at once.
    static constexpr int kMaxGrains = kMaxStreams + 2;

    // Floor on the running window-sum divisor, as a fraction of the nominal
    // sum (numStreams/2). In steady state the sum of S evenly staggered Hann
    // windows is exactly that nominal - the S phase-shifted cosine terms cancel
    // - so the normaliser is a no-op and the shifter is a bit-exact delay at
    // unity pitch. The floor is only a blow-up guard; if it ever engages in
    // normal operation, the grain scheduler has lost its even spacing and the
    // exactness goes with it.
    static constexpr float kWinSumFloorFraction = 0.25f;

    float windowAt(double phase) const noexcept;
    float readHermite(int channel, double delay) const noexcept;
    void  launchGrain(Grain& g) noexcept;

    // --- Prepared state ---
    double sampleRate_      = 0.0;
    int    numChannels_     = 0;
    int    maxBlockSize_    = 0;
    int    numStreams_      = kDefaultStreams;
    int    maxGrainSamples_ = 0;
    int    minGrainSamples_ = 0;
    int    latencySamples_  = 0;   // == 2 * maxGrainSamples_
    int    ringSize_        = 0;   // logical circular capacity, in frames
    bool   prepared_        = false;

    // Circular input history, stored MIRRORED: `ring_` holds 2 * ringSize_
    // frames and every input sample is written at both `w` and `w + ringSize_`.
    // That makes any 4-tap Hermite neighbourhood contiguous, which lets us call
    // audio/HermiteInterp.h's hermiteSample() directly instead of hand-rolling
    // a wrapping variant of the same kernel.
    juce::AudioBuffer<float> ring_;
    int writeIdx_ = 0;                    // next write slot, in [0, ringSize_)

    std::array<Grain, kMaxGrains> grains_ {};
    std::vector<float>            windowTable_;
    std::vector<float>            acc_;   // per-channel OLA accumulator, owned

    // Shared hop clock: one launch every (grain length / numStreams) output
    // samples, round-robin across the slots. See process() for why the launch
    // cannot be driven per stream.
    int hopCounter_ = 0;
    int nextSlot_   = 0;

    float winSumNominal_ = 1.0f;   // numStreams / 2
    float winSumFloor_   = 0.25f;  // kWinSumFloorFraction * winSumNominal_

    // Targets, written from any thread, latched per grain on the audio thread.
    std::atomic<double> ratioTarget_        { 1.0 };
    std::atomic<int>    grainSamplesTarget_ { 0 };

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR(GranularShifter)
};

} // namespace xleth::dsp
