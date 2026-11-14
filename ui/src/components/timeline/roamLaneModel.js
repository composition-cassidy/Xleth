// Roam key lane: the geometry of one lane under a track (docs/XLETH_LENS_ROAM_SPEC.md, P10).
//
// A lane is a graph of ONE Roam parameter against the arrangement's own timeline
// ticks: x is time (the same scroll and zoom as the clips above it), y is the
// value. Pure: no React, no store, no DOM. The painter (roamLaneDrawing.js) and the
// pointer gesture (roamLaneGesture.js) both read their positions from here, so a
// key is drawn where it is hit.

import { DEFAULT_TRACK_HEIGHT, pixelToTickExact, tickToPixel } from '../../constants/timeline.js'
import {
  keysOfChannel, laneValueToY, laneYToValue, roamLaneRange, sortedForDisplay,
} from '../../lensRoam/roamKeyModel.js'

// Heights are authored at DEFAULT_TRACK_HEIGHT (36) and scale with the track height,
// like the Reel, macro and automation lanes.
const LANE_H = 60
const LANE_MIN_H = 48
const LANE_PAD = 6          // above and below the plotted range
export const ROAM_KEY_R = 4.5      // drawn radius of a key
export const ROAM_KEY_HIT_R = 11   // hit radius: the 24 px target floor, radius 12 less a hair

export function roamLaneHeight(trackHeight = DEFAULT_TRACK_HEIGHT) {
  return Math.max(LANE_MIN_H, Math.round(LANE_H * trackHeight / DEFAULT_TRACK_HEIGHT))
}

/** The plotted band inside a lane row: { top, height }. */
export function roamLaneInner(row) {
  const pad = Math.min(LANE_PAD, Math.floor(row.height / 6))
  return { top: row.y + pad, height: Math.max(1, row.height - pad * 2) }
}

/** The lane's value range for its channel (see roamLaneRange). */
export function laneRangeFor(channel, keys, base) {
  return roamLaneRange(channel, keys, base)
}

/** A key's pixel position in the lane: { x, y }. */
export function keyPixel(key, row, range, scrollOffset, ppb) {
  return {
    x: tickToPixel(key.pos, scrollOffset, ppb),
    y: laneValueToY(range, roamLaneInner(row), key.value),
  }
}

/** The (tick, value) under a pixel in a lane. `tick` is unrounded; the caller snaps it. */
export function lanePointAt(row, range, channel, localX, localY, scrollOffset, ppb) {
  return {
    tick: Math.max(0, pixelToTickExact(localX, scrollOffset, ppb)),
    value: laneYToValue(range, roamLaneInner(row), localY, channel),
  }
}

/**
 * What is under (localX, localY) in a Roam lane?
 *
 * @param {object} args
 * @param {object} args.trackLayout   buildTrackLayout's result (roamRowAtY)
 * @param {(trackId:number)=>({base:object, keys:object[]}|undefined)} args.dataOf   the lane's data (draft applied)
 * @param {(trackId:number)=>string} args.channelOf   the parameter each lane shows
 * @param {'roam'|'sweep'} [args.kind]   which lane: the Roam lane (default) or the Sweep
 *   lane (P11), the same graph over Lens channels
 * @returns {null | { row, trackId, channel, range, key: object|null, tick: number, value: number }}
 *   null when the point is not in a Roam lane. `key` is the nearest key of the
 *   lane's channel within the hit radius (the later one wins a tie, like the engine).
 */
export function hitTestRoamLane({ trackLayout, dataOf, channelOf, kind = 'roam' }, localX, localY, scrollOffset, ppb) {
  const row = (kind === 'sweep' ? trackLayout?.sweepRowAtY : trackLayout?.roamRowAtY)?.(localY)
  if (!row) return null
  const trackId = row.parentTrackId
  const channel = channelOf(trackId)
  const data = dataOf(trackId) ?? { base: {}, keys: [] }
  const range = laneRangeFor(channel, data.keys, data.base)
  const at = lanePointAt(row, range, channel, localX, localY, scrollOffset, ppb)
  let key = null
  let best = ROAM_KEY_HIT_R * ROAM_KEY_HIT_R
  for (const k of keysOfChannel(data.keys, channel)) {
    const p = keyPixel(k, row, range, scrollOffset, ppb)
    const d = (p.x - localX) ** 2 + (p.y - localY) ** 2
    if (d <= best) { best = d; key = k }
  }
  return { row, trackId, channel, range, key, tick: at.tick, value: at.value }
}

/** The keys of the lane's channel in time order, for the painter. */
export function laneKeys(keys, channel) {
  return sortedForDisplay(keys).filter((k) => k.channel === channel)
}
