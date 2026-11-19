#pragma once

/**
 * TempoTrimAnchor — keeps every clip's trim on the same instant of its source
 * when the project tempo changes.
 *
 * Clip::regionOffset says how far into its region a clip starts, and it is
 * stored in musical ticks. A tick is a different length of time at a different
 * tempo, so leaving the number alone across a tempo change MOVES the start: a
 * clip trimmed to begin 0.21 s into its source at 140 BPM began 0.43 s in at
 * 70 BPM. Every left-trimmed clip, every right half of a split and every
 * auto-trimmed clip changed what it played, and split halves stopped joining
 * up.
 *
 * The trim is a statement about the SOURCE ("start here in the audio"), so the
 * tick count is rescaled to describe the same number of seconds at the new
 * tempo:
 *
 *     newOffsetTicks = oldOffsetTicks * newBpm / oldBpm
 *
 * Syllable starts are stored in seconds and are unaffected; a clip with no
 * trim has nothing to rescale.
 *
 * Usage, from a command that changes the tempo:
 *     offsets = captureTrimOffsets(timeline)       before anything changes
 *     applyTrimOffsets(timeline, offsets, old, new) in execute()
 *     restoreTrimOffsets(timeline, offsets)         in undo(): the exact
 *                                  original ticks, so undo is lossless
 *                                  whatever rounding apply did
 * apply always starts from the captured ticks, never from the current ones, so
 * a redo lands on exactly the same numbers as the first execute.
 */

#include "model/Timeline.h"

#include <cmath>
#include <cstdint>
#include <unordered_map>

namespace xleth {
namespace tempotrim {

/** clip id -> regionOffset ticks, for every trimmed clip. */
using TrimOffsets = std::unordered_map<int, int64_t>;

inline TrimOffsets captureTrimOffsets(const Timeline& timeline)
{
    TrimOffsets offsets;
    for (const Clip* c : timeline.getAllClips())
        if (c && c->regionOffset.ticks > 0)
            offsets[c->id] = c->regionOffset.ticks;
    return offsets;
}

inline void applyTrimOffsets(Timeline& timeline, const TrimOffsets& offsets,
                             double oldBpm, double newBpm)
{
    if (!(oldBpm > 0.0) || !(newBpm > 0.0) || oldBpm == newBpm) return;
    const double scale = newBpm / oldBpm;
    for (const auto& [clipId, ticks] : offsets) {
        if (Clip* c = timeline.getClipMutable(clipId))
            c->regionOffset = TickTime{
                static_cast<int64_t>(std::llround(static_cast<double>(ticks) * scale)) };
    }
}

inline void restoreTrimOffsets(Timeline& timeline, const TrimOffsets& offsets)
{
    for (const auto& [clipId, ticks] : offsets) {
        if (Clip* c = timeline.getClipMutable(clipId))
            c->regionOffset = TickTime{ ticks };
    }
}

} // namespace tempotrim
} // namespace xleth
