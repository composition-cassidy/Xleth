#pragma once

/**
 * ClipSplit — cutting one clip into two at a timeline tick.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * A split has one job: afterwards the two pieces, played back to back, must be
 * indistinguishable from the clip that was cut. That is a statement about the
 * SOURCE each piece reads and about its fades, and both used to be wrong in a
 * way that only showed on particular clips:
 *
 *   - Reversed clips. A clip reads the source window
 *         [regionOffset, regionOffset + duration / stretchRatio)
 *     and a reversed clip plays that window BACKWARDS (ClipRenderCache; the
 *     video follows it, see ClipVideoModulationTiming.cpp). So the piece that
 *     comes first in time owns the END of the window. Splitting as if the clip
 *     played forwards handed each piece the other one's audio: the cut swapped
 *     the two halves of the sound.
 *
 *   - Fades. Fades are stored as a percentage of the clip's own length. Copying
 *     both percentages onto both pieces shortened the original fade-in, and
 *     put a fade-out and a fade-in on either side of the cut — an audible dip
 *     in the middle of what used to be continuous audio.
 *
 * There were also two implementations of the same arithmetic, one here in the
 * engine (the S key) and one in the renderer (the Split tool), which had
 * already drifted once (the stretched-clip offset bug described in
 * ClipSourceAnchor.h). The renderer now asks the engine to split; this is the
 * only place the rule lives.
 *
 * WHAT A SPLIT KEEPS
 * ------------------
 *   - position / duration   left = [start, cut), right = [cut, end)
 *   - source window         each piece reads exactly the part of the window it
 *                           played before, forwards or reversed
 *   - fade-in               stays on the left piece, same LENGTH as before
 *   - fade-out              stays on the right piece, same LENGTH as before
 *   - everything else       copied to both pieces (pitch, stretch, gain,
 *                           modulation, lens, ...)
 *
 * A fade longer than the piece that carries it is clamped to that piece. The
 * remainder is dropped rather than moved to the other piece: restarting it
 * there would bring back the dip.
 */

#include "model/ClipSourceAnchor.h"
#include "model/TimelineTypes.h"

#include <algorithm>
#include <cstdint>

namespace xleth {
namespace clipedit {

struct SplitClips {
    Clip left;
    Clip right;
};

/** True when `splitTick` falls strictly inside the clip, i.e. both pieces would have length. */
inline bool canSplitClipAt(const Clip& clip, int64_t splitTick)
{
    return splitTick > clip.position.ticks
        && splitTick < clip.position.ticks + clip.duration.ticks;
}

/**
 * Cut `clip` at `splitTick` (a timeline tick strictly inside it; check with
 * canSplitClipAt first). The pieces carry id 0: the timeline assigns ids when
 * they are added.
 */
inline SplitClips splitClipAt(const Clip& clip, int64_t splitTick)
{
    const int64_t start    = clip.position.ticks;
    const int64_t total    = clip.duration.ticks;
    const int64_t leftDur  = splitTick - start;
    const int64_t rightDur = total - leftDur;

    // regionOffset is SOURCE time and the durations are TIMELINE time: a
    // stretched clip consumes duration / stretchRatio of source.
    const int64_t leftSource  = anchoring::sourceTicksForTimelineTicks(leftDur,  clip.stretchRatio);
    const int64_t rightSource = anchoring::sourceTicksForTimelineTicks(rightDur, clip.stretchRatio);
    const int64_t offset      = clip.regionOffset.ticks;

    SplitClips out{clip, clip};
    out.left.id  = 0;
    out.right.id = 0;

    out.left.duration   = TickTime{leftDur};
    out.right.position  = TickTime{splitTick};
    out.right.duration  = TickTime{rightDur};

    if (clip.reversed) {
        // Played backwards: the first piece in time reads the END of the window.
        out.left.regionOffset  = TickTime{offset + rightSource};
        out.right.regionOffset = TickTime{offset};
    } else {
        out.left.regionOffset  = TickTime{offset};
        out.right.regionOffset = TickTime{offset + leftSource};
    }

    // Fades keep their length in ticks and stay at the end they belong to.
    const double fadeInTicks  = static_cast<double>(clip.fadeInPercent)  / 100.0 * static_cast<double>(total);
    const double fadeOutTicks = static_cast<double>(clip.fadeOutPercent) / 100.0 * static_cast<double>(total);

    out.left.fadeInPercent   = static_cast<float>(std::min(100.0, fadeInTicks  / static_cast<double>(leftDur)  * 100.0));
    out.left.fadeOutPercent  = 0.0f;
    out.right.fadeInPercent  = 0.0f;
    out.right.fadeOutPercent = static_cast<float>(std::min(100.0, fadeOutTicks / static_cast<double>(rightDur) * 100.0));

    return out;
}

} // namespace clipedit
} // namespace xleth
