// Landings: the renderer's model (docs/XLETH_LANDING_SPEC.md §8).
//
// A Landing is one track's move into its slot in a cue's incoming snapshot,
// ending exactly on the cue pin. The engine owns the data and renders the move;
// this module is the pure half of the UI: defaults, normalization, the payload
// builder, and the lead-in geometry the cue lane draws. No React, no IPC.
//
// setCueLandings REPLACES a cue's whole list, so every write goes through
// buildCueLandings and carries every field of every landing. The numbers here
// mirror TrackLanding in engine/src/model/TimelineTypes.h; the engine clamps
// again, so a drifted constant can only make the UI's preview differ from what
// is stored, never store something invalid.
import { snapBeatToGrid, pixelToBeat, beatsToTicks, ticksToBeats } from '../../constants/timeline.js'

export const LANDING_MAX_PER_CUE = 16
export const LANDING_DEFAULT_LEAD_IN_TICKS = beatsToTicks(1)    // one beat
export const LANDING_MAX_LEAD_IN_TICKS = beatsToTicks(16)       // four bars of 4/4
export const LANDING_DEFAULT_EDGE_ANGLE = 270             // from the bottom

export const LANDING_FROM_OPTIONS = Object.freeze([
  Object.freeze({ value: 'edge', label: 'Edge', hint: 'Edge: slides in from outside the frame' }),
  Object.freeze({ value: 'grow', label: 'Grow', hint: 'Grow: opens from the centre of its slot' }),
  Object.freeze({ value: 'whereItWas', label: 'Where it was', hint: 'Where it was: moves from its place in the outgoing snapshot' }),
  Object.freeze({ value: 'custom', label: 'Custom', hint: 'Custom: moves from a rectangle you set' }),
])
const FROM_VALUES = new Set(LANDING_FROM_OPTIONS.map((option) => option.value))

// The three named curves. Land is the default: a strong ease-out, so the track
// arrives early and settles on the beat.
export const LANDING_EASING_PRESETS = Object.freeze({
  land:   Object.freeze({ label: 'Land',   curve: Object.freeze({ x1: 0.22, y1: 1, x2: 0.36, y2: 1 }) }),
  glide:  Object.freeze({ label: 'Glide',  curve: Object.freeze({ x1: 0.65, y1: 0, x2: 0.35, y2: 1 }) }),
  linear: Object.freeze({ label: 'Linear', curve: Object.freeze({ x1: 0, y1: 0, x2: 1, y2: 1 }) }),
})
const LAND = LANDING_EASING_PRESETS.land.curve

export const DEFAULT_LANDING = Object.freeze({
  trackId: -1,
  leadInTicks: LANDING_DEFAULT_LEAD_IN_TICKS,
  from: 'edge',
  edgeAngleDeg: LANDING_DEFAULT_EDGE_ANGLE,
  custom: Object.freeze({ x: 0, y: 0, w: 0, h: 0 }),
  fromOpacity: 1,
  easing: LAND,
})

const clamp = (value, min, max) => Math.min(max, Math.max(min, value))
const finiteOr = (value, fallback) => {
  const numeric = Number(value)
  return Number.isFinite(numeric) ? numeric : fallback
}

function normalizeAngle(value) {
  const numeric = Number(value)
  if (!Number.isFinite(numeric)) return LANDING_DEFAULT_EDGE_ANGLE
  return ((Math.round(numeric) % 360) + 360) % 360
}

export function normalizeLandingCurve(raw) {
  const keys = ['x1', 'y1', 'x2', 'y2']
  if (!raw || typeof raw !== 'object' || !keys.every((key) => Number.isFinite(raw[key]))) {
    return { ...LAND }
  }
  return { x1: clamp(raw.x1, 0, 1), y1: clamp(raw.y1, 0, 1), x2: clamp(raw.x2, 0, 1), y2: clamp(raw.y2, 0, 1) }
}

// Which named curve this is, or 'custom'.
export function landingEasingPreset(curve) {
  const normalized = normalizeLandingCurve(curve)
  for (const [key, preset] of Object.entries(LANDING_EASING_PRESETS)) {
    if (['x1', 'y1', 'x2', 'y2'].every((k) => Math.abs(normalized[k] - preset.curve[k]) < 1e-6)) return key
  }
  return 'custom'
}

// One complete landing with every field present and in range.
export function normalizeLanding(raw) {
  const source = raw && typeof raw === 'object' ? raw : {}
  const custom = source.custom && typeof source.custom === 'object' ? source.custom : {}
  const trackId = Number(source.trackId)
  return {
    trackId: Number.isInteger(trackId) && trackId >= 0 ? trackId : -1,
    leadInTicks: clamp(Math.round(finiteOr(source.leadInTicks, LANDING_DEFAULT_LEAD_IN_TICKS)),
      0, LANDING_MAX_LEAD_IN_TICKS),
    from: FROM_VALUES.has(source.from) ? source.from : 'edge',
    edgeAngleDeg: normalizeAngle(source.edgeAngleDeg ?? LANDING_DEFAULT_EDGE_ANGLE),
    custom: {
      x: clamp(finiteOr(custom.x, 0), 0, 1),
      y: clamp(finiteOr(custom.y, 0), 0, 1),
      w: clamp(finiteOr(custom.w, 0), 0, 1),
      h: clamp(finiteOr(custom.h, 0), 0, 1),
    },
    fromOpacity: clamp(finiteOr(source.fromOpacity, 1), 0, 1),
    easing: normalizeLandingCurve(source.easing),
  }
}

// Merge one edit into the FULL landing list the engine expects.
//
//   buildCueLandings(current)                          the list, normalized
//   buildCueLandings(current, { trackId, ...fields })  edit that track's landing,
//                                                      or add one (defaults + fields)
//   buildCueLandings(current, { trackId, remove: true }) remove it
//
// `custom` and `easing` patches merge field by field, so a drag of one custom
// edge keeps the other three. The result is de-duplicated by track (the later
// entry wins, at the earlier position) and capped at 16, the engine's own
// rules, so what the UI previews is what the engine stores. A new landing on a
// full cue is turned away: the list comes back unchanged.
export function buildCueLandings(current, patch) {
  const list = []
  for (const raw of Array.isArray(current) ? current : []) {
    const landing = normalizeLanding(raw)
    if (landing.trackId < 0) continue
    const at = list.findIndex((entry) => entry.trackId === landing.trackId)
    if (at >= 0) list[at] = landing
    else if (list.length < LANDING_MAX_PER_CUE) list.push(landing)
  }
  if (!patch || typeof patch !== 'object') return list

  const trackId = Number(patch.trackId)
  if (!Number.isInteger(trackId) || trackId < 0) return list
  const index = list.findIndex((entry) => entry.trackId === trackId)

  if (patch.remove === true) {
    if (index >= 0) list.splice(index, 1)
    return list
  }

  const base = index >= 0 ? list[index] : normalizeLanding({ trackId })
  const { remove: _remove, custom, easing, ...fields } = patch
  const merged = normalizeLanding({
    ...base,
    ...fields,
    trackId,
    custom: custom && typeof custom === 'object' ? { ...base.custom, ...custom } : base.custom,
    easing: easing && typeof easing === 'object' ? { ...base.easing, ...easing } : base.easing,
  })
  if (index >= 0) list[index] = merged
  else if (list.length < LANDING_MAX_PER_CUE) list.push(merged)
  return list
}

// ── Which snapshot a cue leaves, and what each one places ───────────────────

// The snapshot in effect just before `cueTick`: the previous cue whose snapshot
// still exists, else the default. The engine's rule (Timeline::snapshotAt).
export function outgoingSnapshotId(cues, cueTick, defaultSnapshotId, snapshots) {
  const known = new Set((snapshots || []).map((snapshot) => snapshot.id))
  let id = defaultSnapshotId
  let found = known.has(defaultSnapshotId)
  for (const cue of [...(cues || [])].sort((a, b) => a.tick - b.tick)) {
    if (cue.tick >= cueTick) break
    if (known.has(cue.snapshotId)) { id = cue.snapshotId; found = true }
  }
  if (!found && snapshots && snapshots.length > 0) return snapshots[0].id
  return id
}

// The pin of the previous cue that still resolves, or 0: a lead-in cannot
// start before the outgoing snapshot exists, so the engine clamps it there.
export function leadInFloorTick(cues, cueTick, snapshots) {
  const known = new Set((snapshots || []).map((snapshot) => snapshot.id))
  let floor = 0
  for (const cue of [...(cues || [])].sort((a, b) => a.tick - b.tick)) {
    if (cue.tick >= cueTick) break
    if (known.has(cue.snapshotId)) floor = cue.tick
  }
  return Math.min(floor, cueTick)
}

const idsOf = (snapshot, key) => (Array.isArray(snapshot?.[key]) ? snapshot[key] : [])

export function trackHasSlot(snapshot, trackId) {
  return idsOf(snapshot, 'slotTrackIds').includes(trackId)
}

// Placed at all: a grid slot or a fullscreen layer. "Where it was" needs this
// of the outgoing snapshot; without it the engine falls back to Grow.
export function trackIsPlaced(snapshot, trackId) {
  return trackHasSlot(snapshot, trackId) || idsOf(snapshot, 'fullscreenTrackIds').includes(trackId)
}

// Tracks the Add landing menu offers: a grid slot in the cue's snapshot and no
// landing on this cue yet, in the snapshot's slot order.
export function landingCandidates(cue, snapshots, tracks) {
  const incoming = (snapshots || []).find((snapshot) => snapshot.id === cue?.snapshotId)
  if (!incoming) return []
  const taken = new Set((cue.landings || []).map((landing) => landing.trackId))
  const byId = new Map((tracks || []).map((track) => [track.id, track]))
  const out = []
  for (const trackId of idsOf(incoming, 'slotTrackIds')) {
    if (taken.has(trackId) || out.some((entry) => entry.trackId === trackId)) continue
    const track = byId.get(trackId)
    if (!track) continue                       // a slot left behind by a deleted track
    out.push({ trackId, name: track.name || `Track ${trackId}` })
  }
  return out
}

// ── Lead-in tails on the cue lane ───────────────────────────────────────────

export const LANDING_TAIL_ROWS = 4

// Where a landing really starts: the stored lead-in, clamped at the previous
// cue (resolve-time clamp; the stored value is never rewritten).
export function landingStartTick(pinTick, leadInTicks, floorTick = 0) {
  return Math.max(pinTick - Math.max(0, leadInTicks), Math.min(floorTick, pinTick))
}

// One bar per landing, left of the pin, stacked in up to four rows. Landings
// past the fourth are not drawn; `overflow` is how many, for a "+N" label.
export function landingTails(cue, floorTick = 0) {
  const landings = buildCueLandings(cue?.landings)
  const tails = landings.slice(0, LANDING_TAIL_ROWS).map((landing, row) => ({
    trackId: landing.trackId,
    row,
    leadInTicks: landing.leadInTicks,
    startTick: landingStartTick(cue.tick, landing.leadInTicks, floorTick),
    pinTick: cue.tick,
  }))
  return { tails, overflow: Math.max(0, landings.length - LANDING_TAIL_ROWS) }
}

// Where the tails sit inside the 24px lane: four 2px rows on a 3px pitch along
// the bottom, under the transition band and its grips. A tail's left end is its
// grip; the hit area around it is wider than what is drawn, and the lead-in
// NumberBox in the cue editor is the same edit without a drag.
export const LANDING_TAIL_TOP = 11
export const LANDING_TAIL_PITCH = 3
export const LANDING_TAIL_HEIGHT = 2
export const LANDING_TAIL_GRIP_PX = 6        // reach either side of the end
const TAIL_HIT_TOP = 6                       // above this the lane's own click wins

export function landingTailRowY(row) {
  return LANDING_TAIL_TOP + row * LANDING_TAIL_PITCH
}

// Which tail end is under the pointer. `tails` are one cue's (landingTails),
// `tickToX` maps a tick to a lane x. Among the ends within reach the one whose
// row is nearest the pointer wins, so two landings that start on the same beat
// are still separately grabbable.
export function hitLandingTail(tails, localX, localY, tickToX) {
  if (!Array.isArray(tails) || localY < TAIL_HIT_TOP) return null
  let best = null
  let bestDistance = Infinity
  for (const tail of tails) {
    if (Math.abs(localX - tickToX(tail.startTick)) > LANDING_TAIL_GRIP_PX) continue
    const rowCentre = landingTailRowY(tail.row) + LANDING_TAIL_HEIGHT / 2
    const distance = Math.abs(localY - rowCentre)
    if (distance < bestDistance) { best = tail; bestDistance = distance }
  }
  return best
}

// A dragged tail end -> a lead-in in whole ticks. Snaps to the musical grid by
// default (Alt frees the snap, still whole ticks), never crosses the pin, never
// starts before the previous cue, and stays within the four-bar maximum.
export function tailLeadInTicks(localX, scrollOffset, pixelsPerBeat, modifiers, granularity, pinTick, floorTick = 0) {
  const beat = pixelToBeat(localX, scrollOffset, pixelsPerBeat)
  const snappedBeat = snapBeatToGrid(Math.max(0, beat), modifiers, granularity)
  const handleTick = Math.max(Math.min(floorTick, pinTick), beatsToTicks(snappedBeat))
  return clamp(pinTick - handleTick, 0, LANDING_MAX_LEAD_IN_TICKS)
}

// Lead-in in beats, for the inspector's NumberBox, snapped to the grid step.
export function snapLeadInBeats(beats, granularity) {
  const snapped = snapBeatToGrid(Math.max(0, beats), {}, granularity)
  return clamp(snapped, 0, ticksToBeats(LANDING_MAX_LEAD_IN_TICKS))
}
