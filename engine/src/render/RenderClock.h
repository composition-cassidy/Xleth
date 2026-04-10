#pragma once

/**
 * RenderClock — Integer-accurate timing utility for the offline render pipeline.
 *
 * ALL timestamp conversions flow from Transport::positionSamples_ (int64_t).
 * Every conversion that feeds into PTS, frame index, or PPQ uses av_rescale_q /
 * av_rescale (128-bit intermediate) to prevent overflow and eliminate floating-
 * point accumulation drift.
 *
 * WHY INTEGER ARITHMETIC MATTERS:
 *   Accumulating 1.0/29.97 per frame drifts ~1 frame after 10 minutes.
 *   av_rescale_q works on rationals with a 128-bit intermediate product,
 *   so samplePos 2^53 at 48 kHz (>5900 years) is still exact.
 *
 * This class is stateless — no singletons, no global state, no accumulated
 * deltas.  Every method derives its result from the sample position argument.
 */

#include <cstdint>
#include <utility>

extern "C" {
#include <libavutil/mathematics.h>   // av_rescale_q, av_rescale
#include <libavutil/rational.h>      // AVRational
}

// ---------------------------------------------------------------------------
// Debug logging — compiled out in release builds
// ---------------------------------------------------------------------------
#ifdef XLETH_DEBUG
    #include <cstdio>
    #define RCLOCK_LOG(fmt, ...) std::fprintf(stderr, "[RenderClock] " fmt "\n", ##__VA_ARGS__)
#else
    #define RCLOCK_LOG(fmt, ...) ((void)0)
#endif

// ---------------------------------------------------------------------------
// Standard frame-rate constants (AVRational = {num, den})
// ---------------------------------------------------------------------------
namespace FPS {
    inline constexpr AVRational FPS_24    = { 24,    1    };
    inline constexpr AVRational FPS_25    = { 25,    1    };
    inline constexpr AVRational FPS_29_97 = { 30000, 1001 };
    inline constexpr AVRational FPS_30    = { 30,    1    };
    inline constexpr AVRational FPS_60    = { 60,    1    };
}

// ---------------------------------------------------------------------------
// RenderClock — pure static utility, no state
// ---------------------------------------------------------------------------
class RenderClock
{
public:
    RenderClock() = delete;   // not instantiable

    // ----- sample <-> video frame ------------------------------------------

    /**
     * Convert a sample position to a 0-based video frame index.
     *
     * Uses av_rescale_q with:
     *   src time base = {1, sampleRate}          (one sample)
     *   dst time base = {fps.den, fps.num}       (one frame period)
     *
     * The destination time base is the *duration* of one frame, i.e. den/num
     * seconds.  av_rescale_q expects {num, den} of the time base, which for
     * "one frame = fps.den / fps.num seconds" is {fps.den, fps.num}.
     */
    static int64_t sampleToVideoFrame(int64_t samplePos, int sampleRate,
                                      AVRational fps);

    /**
     * Inverse of sampleToVideoFrame — returns the first sample of the given
     * frame.
     */
    static int64_t videoFrameToSample(int64_t frame, int sampleRate,
                                      AVRational fps);

    // ----- sample -> PPQ (960 pulses per quarter note) ---------------------

    /**
     * samplePos * bpm * PPQ / (60 * sampleRate)
     *
     * Computed via av_rescale to keep 128-bit intermediates.
     * bpm is accepted as double but truncated to integer milli-BPM internally
     * to stay in the integer domain (precision: 0.001 BPM).
     */
    static int64_t sampleToPPQ(int64_t samplePos, int sampleRate, double bpm);

    // ----- sample <-> seconds (display only) --------------------------------

    /** Floating-point — acceptable because this is DISPLAY ONLY, never PTS. */
    static double sampleToSeconds(int64_t samplePos, int sampleRate);

    /** UI input: user types a timecode, we snap to the nearest sample. */
    static int64_t secondsToSample(double seconds, int sampleRate);

    // ----- frame boundary helpers (offline render loop) ---------------------

    /**
     * Returns the sample position where the NEXT video frame begins,
     * i.e. videoFrameToSample(currentFrame + 1).
     */
    static int64_t nextFrameBoundary(int64_t currentSample, int sampleRate,
                                     AVRational fps);

    /**
     * Returns (firstFrame, lastFrame) whose boundaries fall within the audio
     * buffer [bufferStart, bufferStart + bufferSize).
     *
     * "Falls within" means the frame's first sample >= bufferStart AND
     * the frame's first sample < bufferStart + bufferSize.
     *
     * If no frame boundary falls inside this buffer, returns
     * (firstFrame, firstFrame - 1) so that first > last signals "empty".
     */
    static std::pair<int64_t, int64_t> frameBoundsForBuffer(
        int64_t bufferStart, int bufferSize, int sampleRate, AVRational fps);

    // ----- validation (test-friendly) --------------------------------------

    /**
     * Runs a set of known-good timing assertions.  Returns true if all pass.
     * Logs each check via RCLOCK_LOG regardless of build mode when called
     * explicitly (the caller can gate on XLETH_DEBUG if desired).
     */
    static bool validate();

private:
    static constexpr int PPQ = 960;
};
