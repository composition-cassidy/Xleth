#pragma once

/**
 * ClipSourceAnchor — where in the SOURCE file a clip's playhead starts.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * Three subsystems have to agree, to the frame, on the answer to "which instant
 * of the source does this clip begin at?":
 *
 *   - MixEngine            (audio readhead; findActiveClips / enqueueClipRender)
 *   - XlethEngineService   (realtime preview VideoEvent build)
 *   - OfflineRenderer      (export VideoEvent build)
 *
 * The two video builders each open-coded the same expression, and that
 * duplication has already shipped a real A/V desync: OfflineRenderer omitted the
 * syllable term, pinning every syllable clip's video to the region head while
 * its audio played the correct syllable — a render-only error that grew with the
 * syllable's distance into the region. Both now call this one function so they
 * cannot drift apart again.
 *
 * THE THREE TERMS
 * ---------------
 *   regionStartTimeSec   Where the region begins in the source file.
 *   syllableStartTimeSec REGION-RELATIVE seconds (0 == regionStartTimeSec) for
 *                        syllable clips; 0 for ordinary clips. Region-relative
 *                        because MixEngine loads region-only audio, so audio
 *                        sample 0 is regionStartTimeSec.
 *   regionOffsetTicks    Musical trim INTO the region, in 960-PPQ ticks. Written
 *                        by AutoTrimClipCommand (leading-silence trim) and by
 *                        left-edge clip resize. Zero for untrimmed clips, and a
 *                        clip with zero offset therefore anchors EXACTLY at the
 *                        region start — no epsilon, no rounding.
 *
 * SOURCE TICKS ARE NOT TIMELINE TICKS (stretchRatio)
 * --------------------------------------------------
 * regionOffset is measured in SOURCE time: ClipRenderCache applies it to the raw
 * PCM *before* the stretcher runs, so a clip of timeline duration D consumes only
 * D / stretchRatio source ticks. Any edit that converts a timeline distance into
 * a regionOffset — splitting a clip, dragging its left edge — must divide by the
 * ratio, and any edit that compares a regionOffset against a timeline duration
 * must multiply. Adding the two domains directly is the classic bug here: a 1.50×
 * clip split in half gave the right half an offset 1.5× too deep, so it started
 * late AND ran out of source before its end (silent tail). Use
 * sourceTicksForTimelineTicks / timelineTicksForSourceTicks below; never open-code
 * the division.
 *
 * TEMPO DEPENDENCE (deliberate, and a known wart — see the note below)
 * -------------------------------------------------------------------
 * regionOffset is stored in musical ticks, so converting it to source seconds
 * needs the project tempo: a trimmed clip anchors at a different source instant
 * if the BPM changes. That is how the sampler treats the field for AUDIO too
 * (MixEngine converts the same ticks with TickTime::toSamples at the same BPM),
 * so audio and video stay locked to each other at any tempo — which is the
 * property that actually matters. It does mean a leading-silence trim measured
 * in seconds and stored in ticks stops lining up with that silence if the tempo
 * later changes; fixing that belongs in AutoTrimClipCommand and the clip data
 * model, not here, because it is an audio-domain decision.
 *
 * FRAME ACCURACY
 * --------------
 * This returns an exact source instant in seconds. Converting it to a frame
 * index is the caller's job and must go through
 * xleth::frametiming::timeToFrameFloor (see render/FrameRateMath.h), which
 * floors with the source's exact rational frame rate — the same semantics the
 * UI's Chromium <video> region picker uses.
 *
 * NOTE ON THE PICKER: the picker seeks to region.startTime (ui SampleRow /
 * SampleThumbnail) and knows nothing about any clip's trim. So for a TRIMMED
 * clip the picker's frame and the timeline's rendered frame are answers to two
 * different questions and are expected to differ by the trim. They coincide
 * exactly when regionOffsetTicks == 0.
 */

#include <cmath>
#include <cstdint>

namespace xleth {
namespace anchoring {

/** Ticks per quarter note. Matches TickTime's 960-PPQ grid. */
inline constexpr double kTicksPerBeat = 960.0;

/**
 * Convert a musical tick count to seconds at a given tempo.
 * Identical by construction to TickTime::toSeconds(bpm) — kept as a free
 * function so this header stays dependency-free and unit-testable without
 * pulling in the timeline model.
 */
inline double ticksToSeconds(int64_t ticks, double bpm)
{
    if (!(bpm > 0.0)) return 0.0;
    return (static_cast<double>(ticks) / kTicksPerBeat) * (60.0 / bpm);
}

/**
 * The source-file instant, in seconds, at which a clip's playhead starts.
 *
 * Ordinary clip:  regionStart + regionOffset
 * Syllable clip:  regionStart + syllableStart + regionOffset
 *
 * Pass syllableStartTimeSec = 0.0 for a clip with no syllable. With a zero
 * regionOffset and no syllable this returns regionStartTimeSec unchanged, bit
 * for bit.
 */
inline double clipSourceAnchorSeconds(double  regionStartTimeSec,
                                      int64_t regionOffsetTicks,
                                      double  bpm,
                                      double  syllableStartTimeSec = 0.0)
{
    return regionStartTimeSec
         + syllableStartTimeSec
         + ticksToSeconds(regionOffsetTicks, bpm);
}

/**
 * Sanitize a clip stretchRatio for use as a divisor. Mirrors the audio path's
 * clamp (ClipRenderCache treats |ratio-1| <= 1e-4 as unity; the DSP wrappers
 * clamp to >= 0.1), so a corrupt or zero ratio can never produce inf/NaN ticks.
 */
inline double effectiveStretchRatio(double stretchRatio)
{
    if (!(stretchRatio > 0.0)) return 1.0;
    return stretchRatio;
}

/**
 * How many SOURCE ticks a clip consumes over `timelineTicks` of timeline.
 * At unity ratio this is the identity, so untouched projects are unaffected.
 */
inline int64_t sourceTicksForTimelineTicks(int64_t timelineTicks, double stretchRatio)
{
    const double r = effectiveStretchRatio(stretchRatio);
    if (r == 1.0) return timelineTicks;
    return static_cast<int64_t>(std::llround(static_cast<double>(timelineTicks) / r));
}

/**
 * Inverse of the above: the timeline span produced by `sourceTicks` of source.
 * Use when clamping a timeline duration against a source-domain budget (e.g.
 * "how long can this clip be before it runs off the end of the region?").
 */
inline int64_t timelineTicksForSourceTicks(int64_t sourceTicks, double stretchRatio)
{
    const double r = effectiveStretchRatio(stretchRatio);
    if (r == 1.0) return sourceTicks;
    return static_cast<int64_t>(std::llround(static_cast<double>(sourceTicks) * r));
}

} // namespace anchoring
} // namespace xleth
