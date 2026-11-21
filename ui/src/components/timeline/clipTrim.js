/**
 * clipTrim — what dragging one edge of a clip does to it, in both domains.
 *
 * A clip reads the source window
 *
 *     [regionOffsetTicks, regionOffsetTicks + durationTicks / stretchRatio)
 *
 * and a reversed clip plays that window BACKWARDS (ClipRenderCache.cpp; the
 * picture follows the sound). So which end of the window sits under which edge
 * of the clip depends on the direction:
 *
 *                     left edge plays      right edge plays
 *     forward clip    window START         window END
 *     reversed clip   window END           window START
 *
 * Trimming an edge has one rule: the audio under the OTHER edge must not move.
 * That decides which end of the window the trim takes from, and therefore
 * whether regionOffset (the window's start) changes:
 *
 *                     trim LEFT edge       trim RIGHT edge
 *     forward clip    offset moves         offset stays
 *     reversed clip   offset stays         offset moves
 *
 * Treating a reversed clip as forward got both of its columns wrong: dragging
 * its right edge cut the beginning of what you hear and slid the rest earlier,
 * and dragging its left edge cut the end.
 *
 * The same table gives the limits when an edge is dragged OUTWARD. The window
 * can grow at its start only until regionOffset reaches 0, and at its end only
 * until it reaches the end of the region's audio.
 *
 * Both functions are pure and are used by the drag preview and by the commit,
 * so the edge drawn while dragging is the edge that is applied on release.
 *
 * Splitting is not here: the engine owns it (model/ClipSplit.h) and the
 * renderer asks it to split.
 */

import { sourceTicksForTimelineTicks, timelineTicksForSourceTicks } from './clipSourceDomain.js'

const ticks = (v, fallback = 0) => (Number.isFinite(v) ? v : fallback)

function describe(clip) {
  return {
    position: ticks(clip?.positionTicks),
    duration: ticks(clip?.durationTicks),
    offset: Math.max(0, ticks(clip?.regionOffsetTicks)),
    ratio: clip?.stretchRatio ?? 1.0,
    reversed: Boolean(clip?.reversed),
  }
}

// How much longer (in TIMELINE ticks) the clip may get by growing the window
// at its start / at its end. Infinity when the region's length is unknown.
function headroom(c, regionSourceTicks) {
  const atStart = timelineTicksForSourceTicks(c.offset, c.ratio)
  const known = Number.isFinite(regionSourceTicks) && regionSourceTicks < Number.MAX_SAFE_INTEGER
  const windowEnd = c.offset + sourceTicksForTimelineTicks(c.duration, c.ratio)
  const atEnd = known
    ? Math.max(0, timelineTicksForSourceTicks(Math.max(0, regionSourceTicks - windowEnd), c.ratio))
    : Infinity
  return { atStart, atEnd }
}

/**
 * Drag the RIGHT edge so the clip is `requestedDurationTicks` long.
 *
 * @param {object} clip  { positionTicks, durationTicks, regionOffsetTicks, stretchRatio, reversed }
 * @param {number} requestedDurationTicks
 * @param {object} [limits]
 * @param {number} [limits.regionSourceTicks]  length of the region's audio in source ticks
 * @param {number} [limits.minDurationTicks]
 * @returns {{ durationTicks: number, regionOffsetTicks: number }}
 */
export function resolveRightTrim(clip, requestedDurationTicks, { regionSourceTicks = Infinity, minDurationTicks = 1 } = {}) {
  const c = describe(clip)
  const room = headroom(c, regionSourceTicks)
  // The right edge reveals the window's END on a forward clip, its START on a
  // reversed one.
  const maxDuration = c.duration + (c.reversed ? room.atStart : room.atEnd)
  let duration = Math.max(minDurationTicks, ticks(requestedDurationTicks, c.duration))
  if (duration > maxDuration) duration = Math.max(minDurationTicks, maxDuration)

  if (!c.reversed) return { durationTicks: duration, regionOffsetTicks: c.offset }
  const removed = sourceTicksForTimelineTicks(c.duration - duration, c.ratio)
  return { durationTicks: duration, regionOffsetTicks: Math.max(0, c.offset + removed) }
}

/**
 * Drag the LEFT edge to `requestedPositionTicks`. The right edge stays put.
 *
 * @returns {{ positionTicks: number, durationTicks: number, regionOffsetTicks: number }}
 */
export function resolveLeftTrim(clip, requestedPositionTicks, { regionSourceTicks = Infinity, minDurationTicks = 1 } = {}) {
  const c = describe(clip)
  const end = c.position + c.duration
  const room = headroom(c, regionSourceTicks)
  // The left edge reveals the window's START on a forward clip, its END on a
  // reversed one.
  const earliest = Math.max(0, c.position - (c.reversed ? room.atEnd : room.atStart))
  const latest = end - minDurationTicks
  let position = Math.min(ticks(requestedPositionTicks, c.position), latest)
  position = Math.max(earliest, position)

  const duration = end - position
  if (c.reversed) return { positionTicks: position, durationTicks: duration, regionOffsetTicks: c.offset }
  const moved = sourceTicksForTimelineTicks(position - c.position, c.ratio)
  return { positionTicks: position, durationTicks: duration, regionOffsetTicks: Math.max(0, c.offset + moved) }
}
