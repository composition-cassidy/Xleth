#pragma once

// PresentationClockSmoother — a continuous audio clock for the preview thread.
//
// Transport::getPositionSamples() only moves when the audio callback runs, so
// the video thread sees a staircase: flat for a whole device period (10 ms at
// 441 @ 44.1 kHz, ~20 ms when shared-mode WASAPI delivers two blocks per
// wake-up), then a jump. Sampling that staircase at 60 fps turns into output
// frame indices that repeat and skip — measured on BFDIA 9: 300 repeats and
// 300 skips per 900 published frames in poster mode, i.e. a third of the
// preview's frames were duplicates even when every frame arrived on time.
//
// This extrapolates the staircase along a monotonic wall clock and keeps the
// estimate inside the staircase's own bounds:
//   - never BELOW the latest raw position (the audio has provably got there),
//   - never more than maxLeadUs AHEAD of it (if the callbacks stall, the video
//     holds instead of running off on its own),
//   - re-anchored outright on a discontinuity (seek, loop wrap, restart).
// Between those rails it advances at exactly the sample rate, so once it has
// locked onto the top edge of the staircase it is a straight line.
//
// Pure arithmetic: the caller supplies the time, so tests can drive it
// deterministically. Single-threaded (the video thread owns its instance).
// Nothing here is read by, or touches, the audio callback.

#include <cstdint>

class PresentationClockSmoother {
public:
    // Maximum the estimate may run ahead of the last raw position. Covers a
    // bursty two-block shared-mode WASAPI wake-up with room to spare; the
    // estimate only sits near this rail when the callback is genuinely late.
    static constexpr int64_t kDefaultMaxLeadUs = 40000;
    // A raw jump this far outside the rails is a seek / loop wrap, not jitter.
    static constexpr int64_t kDiscontinuityUs = 150000;

    void reset() { valid_ = false; }

    // rawSamples: the transport position as read right now (pre-latency).
    // nowUs:      a monotonic timestamp in microseconds.
    // Returns the smoothed position in samples.
    int64_t update(int64_t rawSamples, int64_t nowUs, int sampleRate,
                   int64_t maxLeadUs = kDefaultMaxLeadUs)
    {
        if (sampleRate <= 0) { valid_ = false; return rawSamples; }
        if (!valid_ || sampleRate != sampleRate_) {
            anchor(rawSamples, nowUs, sampleRate);
            return rawSamples;
        }

        const int64_t predicted =
            anchorSamples_ + (nowUs - anchorUs_) * sampleRate_ / 1000000;
        const int64_t maxLead = maxLeadUs * sampleRate_ / 1000000;
        const int64_t discontinuity = kDiscontinuityUs * sampleRate_ / 1000000;

        if (rawSamples < predicted - maxLead - discontinuity
            || rawSamples > predicted + discontinuity) {
            // Seek, loop wrap, or a stall long enough to be one.
            anchor(rawSamples, nowUs, sampleRate_);
            ++reanchorCount_;
            return rawSamples;
        }
        if (predicted < rawSamples) {
            // Fell below the floor: the callback has already rendered past us.
            anchor(rawSamples, nowUs, sampleRate_);
            return rawSamples;
        }
        if (predicted > rawSamples + maxLead) {
            // Ran too far ahead of audio that has actually been produced.
            anchor(rawSamples + maxLead, nowUs, sampleRate_);
            return rawSamples + maxLead;
        }
        return predicted;
    }

    // Wall-clock microseconds until the smoothed clock reaches targetSamples,
    // measured from the nowUs passed to the last update(). <= 0 if it already
    // has. Valid only after update() returned a playing position.
    int64_t usUntil(int64_t targetSamples, int64_t fromSamples) const
    {
        if (!valid_ || sampleRate_ <= 0) return 0;
        return (targetSamples - fromSamples) * 1000000 / sampleRate_;
    }

    uint64_t reanchorCount() const { return reanchorCount_; }

private:
    void anchor(int64_t samples, int64_t nowUs, int sampleRate)
    {
        anchorSamples_ = samples;
        anchorUs_      = nowUs;
        sampleRate_    = sampleRate;
        valid_         = true;
    }

    bool     valid_         = false;
    int64_t  anchorSamples_ = 0;
    int64_t  anchorUs_      = 0;
    int      sampleRate_    = 0;
    uint64_t reanchorCount_ = 0;
};
