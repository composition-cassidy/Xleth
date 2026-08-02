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

} // namespace anchoring
} // namespace xleth
