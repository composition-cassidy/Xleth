#include "dsp/GranularShifter.h"
#include "audio/HermiteInterp.h"

#include <algorithm>
#include <cmath>

namespace xleth::dsp {

namespace {
constexpr double kPi = 3.14159265358979323846;

// Extra history beyond the nominal 2 * maxGrain read-head centre. The read head
// runs behind the centre by at most (1 - rMin) * G/2 = 0.375 * maxGrain (rMin =
// 2^-2 = 0.25), and Hermite needs one sample older than that. Half a grain plus
// a 64-sample guard covers it with room to spare.
constexpr double kHistoryGrainsBeyondCentre = 0.5;
constexpr int    kHistoryGuardSamples       = 64;
} // namespace

void GranularShifter::prepare(double sampleRate, int numChannels,
                              int maxBlockSize, int numStreams)
{
    prepared_ = false;

    sampleRate_   = (sampleRate > 0.0) ? sampleRate : 48000.0;
    numChannels_  = std::max(1, numChannels);
    maxBlockSize_ = std::max(1, maxBlockSize);
    numStreams_   = std::clamp(numStreams, kMinStreams, kMaxStreams);

    maxGrainSamples_ = std::max(4, (int) std::lround(kMaxGrainMs * 0.001 * sampleRate_));
    minGrainSamples_ = std::max(4, (int) std::lround(kMinGrainMs * 0.001 * sampleRate_));

    // THE latency invariant. Depends on the sample rate and nothing else - not
    // on the grain size, not on the pitch ratio. See the header.
    latencySamples_ = 2 * maxGrainSamples_;

    ringSize_ = latencySamples_
              + (int) std::ceil(kHistoryGrainsBeyondCentre * maxGrainSamples_)
              + kHistoryGuardSamples;

    // Mirrored: 2 * ringSize_ frames, every sample written twice. See header.
    ring_.setSize(numChannels_, 2 * ringSize_, false, true, false);

    // Per-channel overlap-add accumulator, owned so process() never allocates.
    acc_.assign((size_t) numChannels_, 0.0f);

    if ((int) windowTable_.size() != kWindowTableSize + 1) {
        windowTable_.assign(kWindowTableSize + 1, 0.0f);
        // Periodic Hann. Periodic (not symmetric) is what makes S evenly
        // staggered copies sum to exactly S/2.
        for (int i = 0; i <= kWindowTableSize; ++i)
            windowTable_[(size_t) i] =
                0.5f * (1.0f - (float) std::cos(2.0 * kPi * (double) i / (double) kWindowTableSize));
    }

    // The overlap-add's nominal steady-state window sum, and the floor that
    // stops the normaliser amplifying a transient dip into a blow-up. Relative
    // to the nominal rather than absolute, so it means the same thing at every
    // stream count.
    winSumNominal_ = 0.5f * (float) numStreams_;
    winSumFloor_   = kWinSumFloorFraction * winSumNominal_;

    if (grainSamplesTarget_.load(std::memory_order_relaxed) <= 0)
        grainSamplesTarget_.store((minGrainSamples_ + maxGrainSamples_) / 2,
                                  std::memory_order_relaxed);
    else
        grainSamplesTarget_.store(std::clamp(grainSamplesTarget_.load(std::memory_order_relaxed),
                                             minGrainSamples_, maxGrainSamples_),
                                  std::memory_order_relaxed);

    prepared_ = true;
    reset();
}

void GranularShifter::reset() noexcept
{
    if (! prepared_) return;

    ring_.clear();
    writeIdx_ = 0;

    const int    len   = std::clamp(grainSamplesTarget_.load(std::memory_order_relaxed),
                                    minGrainSamples_, maxGrainSamples_);
    const double ratio = ratioTarget_.load(std::memory_order_relaxed);

    // Every slot starts finished...
    for (auto& g : grains_) { g.len = len; g.ratio = ratio; g.pos = len; }

    // ...then seed numStreams_ of them, evenly spread across one grain period,
    // so the overlap-add is already in steady state on the very first output
    // sample: no fade-in transient, and the window sum starts at its nominal.
    for (int s = 0; s < numStreams_; ++s)
        grains_[(size_t) s].pos = (s * len) / numStreams_;

    // The most advanced seeded grain (s == numStreams_ - 1) finishes one hop
    // from now, so that is when the next launch is due.
    nextSlot_   = 0;
    hopCounter_ = std::max(1, len / numStreams_);
}

void GranularShifter::setPitch(int semitones, int cents) noexcept
{
    const double semis = std::clamp((double) semitones + (double) cents / 100.0,
                                    -kMaxSemitones, kMaxSemitones);
    ratioTarget_.store(std::pow(2.0, semis / 12.0), std::memory_order_relaxed);
}

void GranularShifter::setGrainSizeMs(double ms) noexcept
{
    if (! prepared_) return;
    const double clamped = std::clamp(ms, kMinGrainMs, kMaxGrainMs);
    const int    n       = std::clamp((int) std::lround(clamped * 0.001 * sampleRate_),
                                      minGrainSamples_, maxGrainSamples_);
    grainSamplesTarget_.store(n, std::memory_order_relaxed);
}

float GranularShifter::windowAt(double phase) const noexcept
{
    // phase is in [0, 1). Linear interpolation of a 4096-point Hann is accurate
    // to ~1e-7, which is well below the shifter's own artefact floor.
    const double x    = phase * (double) kWindowTableSize;
    const int    i    = (int) x;
    const float  frac = (float) (x - (double) i);
    const float  a    = windowTable_[(size_t) i];
    const float  b    = windowTable_[(size_t) (i + 1)];
    return a + frac * (b - a);
}

float GranularShifter::readHermite(int channel, double delay) const noexcept
{
    // Convert "delay behind the write head" into a fractional index in the ring,
    // where index increases with NEWER samples - the order hermiteSample()
    // expects, since it reads pos-1 .. pos+2 ascending.
    //
    // The sign matters: a delay of d.25 sits a QUARTER of a sample OLDER than
    // integer delay d, which is a quarter of a sample LOWER in index. Feeding
    // hermiteSample a positive fraction of the delay instead reads d.25 as
    // d - 0.25, a sawtooth timing error of up to two samples at the fractional-
    // phase rate. That measured as 42 dB of extra out-of-band energy, and it
    // vanished at ratio exactly 2 - where the fraction is always zero - which is
    // what gave it away.
    //
    // 2 * ringSize_ is added before truncating so the floor is a plain cast:
    // delay < ringSize_ and writeIdx_ >= 0, so the sum is always positive.
    const double idx = (double) (writeIdx_ - 1 + 2 * ringSize_) - delay;

    const int    ii = (int) idx;
    const double ff = idx - (double) ii;

    int i0 = ii % ringSize_;
    if (i0 < 0) i0 += ringSize_;

    // Pick the copy whose 4-tap neighbourhood [ri-1, ri+2] stays inside the
    // 2 * ringSize_ array. Both branches are equivalent modulo ringSize_, so the
    // samples read are identical either way.
    const int ri = (i0 < ringSize_ - 2) ? (i0 + ringSize_) : i0;

    return xleth::audio::hermiteSample(ring_, channel, (double) ri + ff);
}

void GranularShifter::launchGrain(Grain& g) noexcept
{
    g.pos   = 0;
    g.len   = std::clamp(grainSamplesTarget_.load(std::memory_order_relaxed),
                         minGrainSamples_, maxGrainSamples_);
    g.ratio = ratioTarget_.load(std::memory_order_relaxed);
}

void GranularShifter::process(juce::AudioBuffer<float>& block) noexcept
{
    if (! prepared_) return;

    const int n  = block.getNumSamples();
    const int ch = block.getNumChannels();
    if (n <= 0 || n > maxBlockSize_ || ch <= 0 || ch > numChannels_) return;

    const double centreDelay = (double) latencySamples_;
    float* const acc         = acc_.data();

    for (int i = 0; i < n; ++i)
    {
        // 1. Push this frame into the mirrored ring (two stores per channel).
        for (int c = 0; c < ch; ++c)
        {
            const float x = block.getSample(c, i);
            ring_.setSample(c, writeIdx_, x);
            ring_.setSample(c, writeIdx_ + ringSize_, x);
        }
        // Channels the caller did not supply keep whatever was there; they are
        // never read back, because the grain loop below only touches [0, ch).

        writeIdx_ = (writeIdx_ + 1 == ringSize_) ? 0 : writeIdx_ + 1;

        // 2. Launch, on a shared hop clock rather than per stream.
        //
        //    Letting each stream relaunch when its OWN grain ends looks
        //    equivalent - and is, while the size is fixed - but it permanently
        //    deforms the stagger the first time the size changes: a stream
        //    running a 2640-sample grain relaunches 2640 samples later instead
        //    of one NEW hop later, and the streams never re-space. The grains
        //    then stop tiling the period evenly, the window sum dips, the
        //    normaliser below hits its floor and the shifter stops being exact.
        //    Driving every launch off a shared hop keeps the spacing even by
        //    construction, and re-converges within one grain of any change.
        if (hopCounter_ <= 0)
        {
            // Round-robin to the next FINISHED slot, so a launch can never cut
            // a sounding grain short. There are more slots than concurrent
            // grains precisely so that this always finds one.
            for (int k = 0; k < kMaxGrains; ++k)
            {
                Grain& cand = grains_[(size_t) ((nextSlot_ + k) % kMaxGrains)];
                if (cand.pos >= cand.len)
                {
                    launchGrain(cand);
                    nextSlot_   = (nextSlot_ + k + 1) % kMaxGrains;
                    hopCounter_ = std::max(1, cand.len / numStreams_);
                    break;
                }
            }
            // If every slot happened to be busy the hop still has to advance,
            // or this branch would retry on every sample.
            if (hopCounter_ <= 0)
                hopCounter_ = std::max(1, grainSamplesTarget_.load(std::memory_order_relaxed)
                                             / numStreams_);
        }
        --hopCounter_;

        // 3. Overlap-add every sounding grain. `acc_` is sized in prepare(), so
        //    this writes into already-owned storage rather than allocating.
        for (int c = 0; c < ch; ++c) acc[c] = 0.0f;
        float winSum = 0.0f;

        for (auto& g : grains_)
        {
            if (g.pos >= g.len) continue;   // finished, contributes nothing

            const double phase = (double) g.pos / (double) g.len;
            const float  w     = windowAt(phase);
            winSum += w;

            // delay(t) = L + (r - 1) * (G/2 - t): exactly L at the window peak,
            // for every ratio and every grain length. That is the invariant.
            const double delay = centreDelay
                               + (g.ratio - 1.0) * (0.5 * (double) g.len - (double) g.pos);

            // The clamp is a cheap guard, never active for any (rate, ratio,
            // size) triple the public setters can produce: the proven bounds
            // are [L - 1.49*maxGrain, L + 0.375*maxGrain] against a ring of
            // L + 0.5*maxGrain + 64.
            const double safeDelay = std::clamp(delay, 2.0, (double) (ringSize_ - 3));

            for (int c = 0; c < ch; ++c)
                acc[c] += w * readHermite(c, safeDelay);

            ++g.pos;
        }

        // 4. Normalise by the RUNNING window sum. In steady state that is the
        //    constant numStreams/2, so it costs one divide and changes nothing.
        //    Across a grain-size change, where two grain lengths coexist for one
        //    period, it is what holds the overlap-add at unity gain. At unity
        //    pitch every grain reads the same sample, so sum/sum makes the whole
        //    shifter a bit-exact delay - which is what the latency test relies
        //    on, and why the floor must never engage in normal operation.
        const float norm = 1.0f / std::max(winSum, winSumFloor_);
        for (int c = 0; c < ch; ++c)
            block.setSample(c, i, acc[c] * norm);
    }
}

} // namespace xleth::dsp
