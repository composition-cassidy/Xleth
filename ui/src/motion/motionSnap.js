// Motion view snapping (docs/XLETH_MOTION_VIEW_DESIGN.md 5.4).
//
// Timeline keys (Roam, Sweep, Mask, clip Lens): within SNAP_PX of the pointer the
// nearest of note-ons / note-offs of the key's track, clip edges of that track and
// other keys on the visible rows; else the grid (snapTickToGrid, the toolbar
// granularity). Alt = no snap. A tie between two candidates at the same distance
// goes to the stronger kind: note-on, then note-off, then clip edge, then key.
//
// Note-relative keys (hit curve, a note's own keys) keep their anchor and snap to
// musical steps measured inside their note: from the note-on (Head), back from the
// clamped note end (Tail), and to 0 / 0.25 / 0.5 / 0.75 / 1 of the Body.
//
// Pure: no React, no store. A gesture builds ONE candidate index when it starts
// (buildSnapIndex) and snaps every pointer move against it with a binary search,
// so a drag allocates nothing per move.

import { GRANULARITY_BEATS, beatsToTicks, snapTickToGrid } from '../constants/timeline.js'
import { positionAtNoteTime, zoneSpan } from '../lensRoam/lensKeyModel.js'
import { lowerBound } from './useMotionData.js'
import { rowKeyTicks, rowKeys, visibleRowRange } from './rowRegistry.js'

/** Snap reach, CSS px. */
export const SNAP_PX = 8

/** Candidate kinds, strongest first (the tie-break order). */
export const SNAP_KIND = Object.freeze({ noteOn: 0, noteOff: 1, clipEdge: 2, key: 3 })
export const SNAP_KIND_NAMES = Object.freeze(['noteOn', 'noteOff', 'clipEdge', 'key'])

/** The Body fractions a Body key snaps to. */
export const BODY_STEPS = Object.freeze([0, 0.25, 0.5, 0.75, 1])

const fin = (v) => typeof v === 'number' && Number.isFinite(v)

/** The grid step in ticks of a toolbar granularity ('1/16' -> 240). */
export function gridStepTicks(granularity = '1/16') {
  const beats = GRANULARITY_BEATS[granularity] ?? GRANULARITY_BEATS['1/16']
  return Math.max(1, beatsToTicks(beats))
}

/**
 * The candidate index a drag snaps against: every candidate tick, sorted, with its
 * kind. Built once per gesture.
 *   data        MotionData (noteStrip, clipsByTrack)
 *   trackIds    the tracks whose note-ons / offs and clip edges count (the dragged keys' tracks)
 *   layout, scrollTop, height   the visible rows whose keys count (other keys)
 *   excludeIds  key instance ids that move with the drag (never a candidate)
 * Returns { ticks: Float64Array, kinds: Uint8Array, count }.
 */
export function buildSnapIndex({ data, trackIds = [], layout = null, scrollTop = 0, height = 0, excludeIds = null } = {}) {
  const ticks = []
  const kinds = []
  const push = (t, k) => { if (fin(t) && t >= 0) { ticks.push(t); kinds.push(k) } }
  const seenTracks = new Set()
  for (const id of trackIds) {
    if (seenTracks.has(id) || !data) continue
    seenTracks.add(id)
    const track = data.tracksById?.get(id)
    if (track?.type === 'Pattern') {
      const s = data.noteStrip(id)
      for (let i = 0; i < s.count; i++) {
        push(s.starts[i], SNAP_KIND.noteOn)
        push(s.ends[i], SNAP_KIND.noteOff)
      }
    } else {
      for (const c of data.clipsByTrack?.get(id) ?? []) {
        push(c.positionTicks, SNAP_KIND.clipEdge)
        push(c.positionTicks + c.durationTicks, SNAP_KIND.clipEdge)
      }
    }
  }
  if (layout && data && height > 0) {
    const [r0, r1] = visibleRowRange(layout, scrollTop, height)
    for (let r = r0; r < r1; r++) {
      const row = layout.rows[r]
      if (row.kind !== 'prop') continue
      const list = rowKeys(row, data)
      const ts = rowKeyTicks(row, data)
      for (let i = 0; i < list.length; i++) {
        if (excludeIds?.has(list[i].id) || list[i].outside) continue
        push(ts[i], SNAP_KIND.key)
      }
    }
  }
  const order = ticks.map((_, i) => i).sort((a, b) => (ticks[a] - ticks[b]) || (kinds[a] - kinds[b]))
  const out = { ticks: new Float64Array(order.length), kinds: new Uint8Array(order.length), count: order.length }
  order.forEach((j, i) => { out.ticks[i] = ticks[j]; out.kinds[i] = kinds[j] })
  return out
}

/** The nearest candidate within `reach` ticks of `tick` (ties: the stronger kind), or null. */
export function nearestCandidate(index, tick, reach) {
  if (!index || index.count === 0 || !(reach > 0)) return null
  const lo = lowerBound(index.ticks, tick - reach, index.count)
  let best = -1
  let bestD = Infinity
  for (let i = lo; i < index.count; i++) {
    const t = index.ticks[i]
    if (t > tick + reach) break
    const d = Math.abs(t - tick)
    if (d < bestD - 1e-9 || (Math.abs(d - bestD) <= 1e-9 && index.kinds[i] < index.kinds[best])) {
      best = i
      bestD = d
    }
  }
  return best < 0 ? null : { tick: index.ticks[best], kind: SNAP_KIND_NAMES[index.kinds[best]] }
}

/**
 * The tick a dragged timeline key lands on.
 *   tick         the unsnapped tick
 *   modifiers    { alt, ctrl } (Alt = free; Ctrl = the 1/8 override of snapTickToGrid)
 *   granularity  the toolbar Snap value
 *   candidates   a buildSnapIndex result, or sorted plain ticks
 *   ticksPerPx   timeline ticks per CSS pixel at the current zoom
 * Returns { tick, kind: 'free' | 'grid' | 'noteOn' | 'noteOff' | 'clipEdge' | 'key' | 'candidate' }.
 */
export function snapMotionTick(tick, { modifiers = {}, granularity = '1/16', candidates = null, ticksPerPx = 0 } = {}) {
  if (modifiers.alt) return { tick: Math.max(0, Math.round(tick)), kind: 'free' }
  const reach = SNAP_PX * ticksPerPx
  if (candidates && ticksPerPx > 0) {
    if (candidates.ticks instanceof Float64Array) {
      const hit = nearestCandidate(candidates, tick, reach)
      if (hit) return { tick: Math.max(0, Math.round(hit.tick)), kind: hit.kind }
    } else if (candidates.length > 0) {
      let best = null
      for (const c of candidates) {
        const d = Math.abs(c - tick)
        if (d <= reach && (best === null || d < Math.abs(best - tick))) best = c
      }
      if (best !== null) return { tick: Math.max(0, Math.round(best)), kind: 'candidate' }
    }
  }
  return { tick: Math.max(0, snapTickToGrid(tick, modifiers, granularity)), kind: 'grid' }
}

/**
 * A note-relative key's position, snapped to musical steps inside its note (5.4):
 * Head counts whole grid steps from the note-on, Tail whole grid steps back from the
 * clamped note end, Body snaps to BODY_STEPS. The anchor never changes.
 *   span       lensKeyModel.noteSpan of the note
 *   anchor     'Head' | 'Body' | 'Tail'
 *   noteTime   the unsnapped place, ticks since the note-on
 *   step       the grid step in ticks (gridStepTicks); Alt = free
 * Returns the key's pos (Head / Tail whole ticks, Body a fraction), clamped into the zone.
 */
export function snapNotePos(span, anchor, noteTime, { step = 240, alt = false } = {}) {
  const raw = positionAtNoteTime(span, anchor, noteTime)
  if (anchor === 'Body') {
    if (alt) return Math.round(raw * 1e4) / 1e4
    let best = BODY_STEPS[0]
    for (const f of BODY_STEPS) if (Math.abs(f - raw) < Math.abs(best - raw)) best = f
    return best
  }
  if (alt || !(step > 0)) return Math.round(raw)
  // Snap the note TIME (what the user sees) to whole steps from the zone's origin, then back to a position.
  const [lo, hi] = zoneSpan(span, anchor)
  const t = Math.min(hi, Math.max(lo, noteTime))
  let snapped
  if (anchor === 'Tail') {
    const fromEnd = span.noteLen - t
    snapped = span.noteLen - Math.round(fromEnd / step) * step
  } else {
    snapped = Math.round(t / step) * step
  }
  snapped = Math.min(hi, Math.max(lo, snapped))
  return Math.round(positionAtNoteTime(span, anchor, snapped))
}

export default snapMotionTick
