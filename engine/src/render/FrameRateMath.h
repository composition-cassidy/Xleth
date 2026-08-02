#pragma once

/**
 * FrameRateMath — the single authority for time ↔ frame ↔ PTS conversion.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * XLETH converts between three representations of "when":
 *
 *     seconds  --(A)-->  frame index  --(B)-->  stream PTS
 *
 * (A) happens in FrameCollector (which source frame does this note need?).
 * (B) happens in RenderVideoDecoder (what do I hand av_seek_frame?).
 *
 * Historically these two conversions used DIFFERENT frame rates. (B) computed
 * its frame duration as `AVRational{1, (int)round(fps)}`, and std::round()
 * silently snaps every NTSC-fractional rate to an integer: 23.976 → 24,
 * 29.97 → 30, 59.94 → 60. The result was a 1000/1001 (~0.1%) error in every
 * frame→PTS conversion, so the round trip was asymmetric and the delivered
 * frame drifted earlier by `frameIndex / 1001` frames — invisible at the start
 * of a file, ~21 frames (0.88 s) at 916 s deep. Everything here exists so that
 * both directions are driven by ONE AVRational and cannot drift apart again.
 *
 * ROUNDING CONVENTIONS (these are load-bearing — do not "clean them up")
 * ---------------------------------------------------------------------
 * frameToPts()  rounds DOWN.  Verified against the real muxer output: for a
 *   HandBrake/x264 MP4 at r_frame_rate=24000/1001 in time_base=1/90000, the
 *   ideal frame duration is 3753.75 ticks and the actual frame timestamps are
 *   exactly floor(N * 3753.75) — 0, 3753, 7507, 11261, 15015, 18768, 22522,
 *   26276, 30030, … — with no accumulated drift over all 33697 frames.
 *   Rounding to NEAREST instead would place the target one tick ABOVE the real
 *   timestamp for every N ≡ 1,2 (mod 4), and decodeFrame()'s `pts >= target`
 *   acceptance test would then skip past the requested frame and deliver N+1.
 *
 * ptsToFrame()  rounds to NEAREST.  Its input is a real decoded timestamp,
 *   which sits up to one tick BELOW the ideal grid because of the floor above.
 *   Nearest recovers the true index exactly; flooring here would return N-1.
 *
 * timeToFrameFloor()  rounds DOWN, matching what a video player shows: frame N
 *   is the frame whose interval [N/fps, (N+1)/fps) contains t. The region
 *   picker in the UI is a Chromium <video> element and uses exactly these
 *   semantics, so the engine must too or the picked frame and the rendered
 *   frame disagree by one.
 *
 * Together these give an exact round trip: ptsToFrame(frameToPts(n)) == n for
 * every n in a source's range (see engine/test/test_frame_timing.cpp).
 */

#include <cmath>
#include <cstdint>

extern "C" {
#include <libavutil/avutil.h>       // AV_NOPTS_VALUE
#include <libavutil/mathematics.h>  // av_rescale_q, av_rescale_q_rnd
#include <libavutil/rational.h>     // AVRational, av_inv_q, av_q2d, av_d2q
}

namespace xleth {
namespace frametiming {

/** True if a rational is usable as a frame rate. */
inline bool isValidRate(AVRational r)
{
    return r.num > 0 && r.den > 0;
}

/**
 * Pick the authoritative frame rate for a stream.
 *
 * r_frame_rate WINS. It is the container's declared base rate and, for CFR
 * content, is exact (e.g. 24000/1001). avg_frame_rate is total_frames divided
 * by container duration, so it is contaminated by duration rounding and by any
 * trailing partial frame — for the reference source it reads 189545625/7905632
 * (23.97565…) against a true 23.976023976…, which is wrong in the 5th decimal.
 * It is only a fallback for streams that declare no r_frame_rate at all.
 *
 * @param rFrameRate    stream->r_frame_rate
 * @param avgFrameRate  stream->avg_frame_rate
 * @param outUsedFallback  set true when r_frame_rate was unusable
 * @param outVfrSuspect    set true when r and avg disagree by more than
 *                         ~0.5% relative — a real signal that the stream is
 *                         variable-frame-rate, which no constant-rate model
 *                         (including this one) can represent correctly.
 *                         Small divergence is normal container rounding.
 */
inline AVRational chooseFrameRate(AVRational rFrameRate,
                                  AVRational avgFrameRate,
                                  bool*      outUsedFallback = nullptr,
                                  bool*      outVfrSuspect   = nullptr)
{
    if (outUsedFallback) *outUsedFallback = false;
    if (outVfrSuspect)   *outVfrSuspect   = false;

    AVRational chosen;
    if (isValidRate(rFrameRate)) {
        chosen = rFrameRate;
    } else if (isValidRate(avgFrameRate)) {
        chosen = avgFrameRate;
        if (outUsedFallback) *outUsedFallback = true;
    } else {
        chosen = AVRational{30, 1};
        if (outUsedFallback) *outUsedFallback = true;
        return chosen;
    }

    if (outVfrSuspect && isValidRate(rFrameRate) && isValidRate(avgFrameRate)) {
        const double r   = av_q2d(rFrameRate);
        const double avg = av_q2d(avgFrameRate);
        if (r > 0.0 && std::fabs(r - avg) / r > 0.005)
            *outVfrSuspect = true;
    }
    return chosen;
}

/**
 * Frame index → stream PTS, in the stream's own time base.
 *
 * Rounds DOWN to match how muxers lay a fractional frame duration onto an
 * integer tick grid (see the file header). `startTime` is the stream's
 * start_time, or 0 when it is AV_NOPTS_VALUE — av_seek_frame() operates on raw
 * stream timestamps and does NOT apply the container's edit list, so a stream
 * with a non-zero start must have it added back here.
 */
inline int64_t frameToPts(int64_t    frameIndex,
                          AVRational frameRate,
                          AVRational timeBase,
                          int64_t    startTime)
{
    if (!isValidRate(frameRate) || !isValidRate(timeBase))
        return 0;

    int64_t pts = av_rescale_q_rnd(frameIndex,
                                   av_inv_q(frameRate),
                                   timeBase,
                                   AV_ROUND_DOWN);
    if (startTime != AV_NOPTS_VALUE)
        pts += startTime;
    return pts;
}

/**
 * Stream PTS → frame index. Exact inverse of frameToPts() for real timestamps.
 * Rounds to NEAREST (see the file header).
 */
inline int64_t ptsToFrame(int64_t    pts,
                          AVRational frameRate,
                          AVRational timeBase,
                          int64_t    startTime)
{
    if (!isValidRate(frameRate) || !isValidRate(timeBase))
        return 0;

    const int64_t base = (startTime != AV_NOPTS_VALUE) ? startTime : 0;
    return av_rescale_q(pts - base, timeBase, av_inv_q(frameRate));
}

/**
 * Half of one frame's duration, expressed in stream time-base ticks.
 *
 * Used as the tolerance when deciding whether a decoded frame IS the requested
 * frame. Accepting the first frame with `pts >= target - halfFrame` instead of
 * `pts >= target` makes the decoder robust to a muxer that rounds frame
 * timestamps UP rather than down: the previous frame sits a full frame below
 * the target, so a half-frame window can never admit it.
 */
inline int64_t halfFramePts(AVRational frameRate, AVRational timeBase)
{
    if (!isValidRate(frameRate) || !isValidRate(timeBase))
        return 0;
    return av_rescale_q(1, av_inv_q(frameRate), timeBase) / 2;
}

/**
 * Seconds → frame index, FLOOR semantics: returns the N for which
 * t ∈ [N/fps, (N+1)/fps). Negative and non-finite times clamp to 0.
 *
 * Implementation note — why the intermediate scaling:
 * A naive floor(t * num / den) is unsafe exactly ON a frame boundary. Frame N
 * starts at N*den/num seconds, which is generally not representable as a
 * double, so the incoming value can land one ulp BELOW the true boundary and
 * floor to N-1. We therefore quantize to 1/SUB of a frame and round to nearest
 * before flooring, which absorbs that representation error. SUB = 1e6 makes
 * the tolerance one millionth of a frame (~42 ns at 23.976 fps) — vastly
 * larger than the ~1e-10 s double error at realistic timeline positions, and
 * vastly smaller than anything that could push a genuinely interior time
 * across a boundary.
 *
 * The scaled product stays well inside the 2^53 exactly-representable integer
 * range: a 4-hour 60 fps timeline reaches ~8.6e14 sub-frame units.
 */
inline int64_t timeToFrameFloor(double seconds, AVRational frameRate)
{
    if (!isValidRate(frameRate))
        return 0;
    if (!std::isfinite(seconds) || seconds <= 0.0)
        return 0;

    constexpr double SUB = 1000000.0;
    const double scaled = seconds * static_cast<double>(frameRate.num) * SUB
                        / static_cast<double>(frameRate.den);

    // Guard the int64 conversion for absurd inputs rather than invoking UB.
    if (scaled >= 9.0e18)
        return static_cast<int64_t>(9.0e18 / SUB);

    const int64_t sub = static_cast<int64_t>(std::llround(scaled));
    return sub / static_cast<int64_t>(SUB);
}

/**
 * Resolve a SourceMedia's frame rate to an exact rational.
 *
 * Projects written before the rational was persisted carry only a double, so
 * reconstruct it with av_d2q. For every real-world rate this recovers the exact
 * ratio (23.976023976023978 → 24000/1001) because the next continued-fraction
 * convergent past the true rate has a denominator far beyond the 1e6 limit.
 */
inline AVRational rateFromSource(int fpsNum, int fpsDen, double legacyFps)
{
    if (fpsNum > 0 && fpsDen > 0)
        return AVRational{fpsNum, fpsDen};
    if (std::isfinite(legacyFps) && legacyFps > 0.0)
        return av_d2q(legacyFps, 1000000);
    return AVRational{30, 1};
}

} // namespace frametiming
} // namespace xleth
