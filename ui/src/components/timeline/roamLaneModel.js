// Roam key lane: the geometry of one lane under a track (docs/XLETH_LENS_ROAM_SPEC.md, P10).
//
// A lane is a graph of ONE Roam parameter against the arrangement's own timeline
// ticks: x is time (the same scroll and zoom as the clips above it), y is the
// value. Pure: no React, no store, no DOM. The painter (roamLaneDrawing.js) and the
// pointer gesture (roamLaneGesture.js) both read their positions from here, so a
// key is drawn where it is hit.

import { DEFAULT_TRACK_HEIGHT, pixelToTickExact, tickToPixel } from '../../constants/timeline.js'
import {
  bezierHandlePoints, keysOfChannel, laneValueToY, laneYToValue, roamLaneRange, sameKeyRef, sortedForDisplay,
} from '../../lensRoam/roamKeyModel.js'

// Heights are authored at DEFAULT_TRACK_HEIGHT (36) and scale with the track height,
// like the Reel, macro and automation lanes.
const LANE_H = 60
const LANE_MIN_H = 48
const LANE_PAD = 6          // above and below the plotted range
export const ROAM_KEY_R = 4.5      // drawn radius of a key
export const ROAM_KEY_HIT_R = 11   // hit radius: the 24 px target floor, radius 12 less a hair
export const ROAM_HANDLE_R = 3.5   // drawn radius of a Bezier handle
export const ROAM_HANDLE_HIT_R = 9 // a handle sits close to its key; it wins only when nearer

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
 * @param {object} args.trackLayout   a lane-row provider supplied by the caller:
 *   { roamRowAtY, getRoamRows, sweepRowAtY, getSweepRows } (not buildTrackLayout's
 *   result, which has no Roam / Sweep rows since R17); `*RowAtY(localY)` returns the
 *   lane row under a y ({ parentTrackId, y, height }) or null
 * @param {(trackId:number)=>({base:object, keys:object[]}|undefined)} args.dataOf   the lane's data (draft applied)
 * @param {(trackId:number)=>string} args.channelOf   the parameter each lane shows
 * @param {'roam'|'sweep'} [args.kind]   which lane: the Roam lane (default) or the Sweep
 *   lane (P11), the same graph over Lens channels
 * @param {(ref:{trackId,channel,pos})=>boolean} [args.isSelected]   which keys are selected:
 *   only a selected Bezier key shows (and so offers) its handles
 * @returns {null | { row, trackId, channel, range, key: object|null, handle: object|null,
 *   tick: number, value: number }}
 *   null when the point is not in a Roam lane. `key` is the nearest key of the
 *   lane's channel within the hit radius (the later one wins a tie, like the engine).
 *   `handle` is { key, next, which: 1|2 } when a shown Bezier handle is nearer than any key.
 */
export function hitTestRoamLane({ trackLayout, dataOf, channelOf, kind = 'roam', isSelected = null },
  localX, localY, scrollOffset, ppb) {
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
  let handle = null
  if (isSelected) {
    let hBest = Math.min(best, ROAM_HANDLE_HIT_R * ROAM_HANDLE_HIT_R)
    const segs = laneBezierSegments(laneKeys(data.keys, channel),
      (k) => isSelected({ trackId, channel, pos: k.pos }), row, range, scrollOffset, ppb)
    for (const s of segs) {
      for (const which of [1, 2]) {
        const h = which === 1 ? s.h1 : s.h2
        const d = (h.x - localX) ** 2 + (h.y - localY) ** 2
        if (d < hBest) { hBest = d; handle = { key: s.key, next: s.next, which } }
      }
    }
  }
  return { row, trackId, channel, range, key: handle ? null : key, handle, tick: at.tick, value: at.value }
}

/**
 * The Bezier segments whose handles a lane shows: one per SELECTED Bezier key that has
 * a next key. `keys` are the lane's keys in time order (laneKeys). Each is
 * { key, next, from, to, h1, h2 } in lane pixels (bezierHandlePoints).
 */
export function laneBezierSegments(keys, isSelectedKey, row, range, scrollOffset, ppb) {
  const inner = roamLaneInner(row)
  const toX = (k) => tickToPixel(k.pos, scrollOffset, ppb)
  const toY = (v) => laneValueToY(range, inner, v)
  const out = []
  for (let i = 0; i + 1 < keys.length; i++) {
    const a = keys[i]
    if (a.interp !== 'Bezier' || !isSelectedKey(a)) continue
    out.push({ key: a, next: keys[i + 1], ...bezierHandlePoints(a, keys[i + 1], toX, toY) })
  }
  return out
}

/** Is `ref` the lane's selected key or one of its multi-selection? */
export function refIsSelected(ref, selected, multi) {
  return sameKeyRef(selected, ref) || (multi ?? []).some((r) => sameKeyRef(r, ref))
}

/**
 * The keys inside a marquee (local px rect {x0, y0, x1, y1}, any corner order) over
 * every lane row of one kind, as refs { trackId, channel, pos }. A row counts when it
 * overlaps the rect; a key counts when its drawn centre is inside it. `trackLayout` is
 * the same lane-row provider as hitTestRoamLane's (getRoamRows / getSweepRows).
 */
export function keysInMarquee({ trackLayout, dataOf, channelOf, kind = 'roam' }, rect, scrollOffset, ppb) {
  const rows = (kind === 'sweep' ? trackLayout?.getSweepRows?.() : trackLayout?.getRoamRows?.()) ?? []
  const x0 = Math.min(rect.x0, rect.x1)
  const x1 = Math.max(rect.x0, rect.x1)
  const y0 = Math.min(rect.y0, rect.y1)
  const y1 = Math.max(rect.y0, rect.y1)
  const out = []
  for (const row of rows) {
    if (row.y > y1 || row.y + row.height < y0) continue
    const trackId = row.parentTrackId
    const channel = channelOf(trackId)
    const data = dataOf(trackId) ?? { base: {}, keys: [] }
    const range = laneRangeFor(channel, data.keys, data.base)
    for (const k of keysOfChannel(data.keys, channel)) {
      const p = keyPixel(k, row, range, scrollOffset, ppb)
      if (p.x >= x0 && p.x <= x1 && p.y >= y0 && p.y <= y1) out.push({ trackId, channel, pos: k.pos })
    }
  }
  return out
}

/** The keys of the lane's channel in time order, for the painter. */
export function laneKeys(keys, channel) {
  return sortedForDisplay(keys).filter((k) => k.channel === channel)
}
