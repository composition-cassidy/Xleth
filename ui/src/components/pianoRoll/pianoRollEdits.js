// FL Studio-style piano roll edits, as pure functions over a note list.
//
// Every edit takes the pattern's notes and returns the COMPLETE list after the
// edit, so the caller commits it with one timeline.editPatternNotes call (one
// undo entry, however many notes moved, appeared or vanished). Notes keep
// their `id`; a new note has none. `_select: true` marks notes the editor
// should select once the commit lands (new copies, slices, painted notes); the
// commit layer strips it before anything reaches the engine.
//
// Ticks throughout (PPQ 960). A "range" is a time selection {start, end},
// end exclusive.

import { PPQ, GRANULARITY_BEATS } from '../../constants/timeline.js'
import { PITCH_MIN, PITCH_MAX } from './pianoRollGeometry.js'

export const BAR_TICKS = PPQ * 4
export const MIN_NOTE_TICKS = 60

/** One snap step in ticks for a Snap select value (falls back to 1/16). */
export function snapTicksOf(snap) {
  const beats = GRANULARITY_BEATS[snap] ?? GRANULARITY_BEATS['1/16']
  return Math.max(1, Math.round(beats * PPQ))
}

const noteEnd = (n) => n.positionTicks + n.durationTicks
const clampPitch = (p) => Math.max(PITCH_MIN, Math.min(PITCH_MAX, p))
const floorTo = (t, step) => Math.floor(t / step) * step
const ceilTo = (t, step) => Math.ceil(t / step) * step

/** The notes an edit acts on: the selection, or every note when nothing is selected. */
export function targetIds(notes, selectedIds) {
  if (selectedIds && selectedIds.size > 0) return new Set(selectedIds)
  return new Set(notes.map((n) => n.id))
}

// ── Selection ───────────────────────────────────────────────────────────────

export function invertSelection(notes, selectedIds) {
  return new Set(notes.filter((n) => !selectedIds?.has(n.id)).map((n) => n.id))
}

/** Random half of the selection (or of every note). Never empty when there is something to pick. */
export function randomSelection(notes, selectedIds, rng = Math.random) {
  const pool = notes.filter((n) => !selectedIds?.size || selectedIds.has(n.id))
  if (!pool.length) return new Set()
  const picked = pool.filter(() => rng() < 0.5)
  if (!picked.length) picked.push(pool[Math.floor(rng() * pool.length) % pool.length])
  return new Set(picked.map((n) => n.id))
}

/** Notes that start off the snap grid (swung or hand-placed). */
export function offGridSelection(notes, snapTicks) {
  return new Set(notes.filter((n) => n.positionTicks % snapTicks !== 0).map((n) => n.id))
}

export function notesStartingIn(notes, range) {
  if (!range) return new Set()
  return new Set(notes
    .filter((n) => n.positionTicks >= range.start && n.positionTicks < range.end)
    .map((n) => n.id))
}

export function notesOfPitchRange(notes, lo, hi) {
  const a = Math.min(lo, hi)
  const b = Math.max(lo, hi)
  return new Set(notes.filter((n) => n.pitch >= a && n.pitch <= b).map((n) => n.id))
}

/** Time span of the given notes, widened outward to the snap grid. */
export function spanOf(notes, ids, snapTicks) {
  const list = notes.filter((n) => ids.has(n.id))
  if (!list.length) return null
  const start = floorTo(Math.min(...list.map((n) => n.positionTicks)), snapTicks)
  let end = ceilTo(Math.max(...list.map(noteEnd)), snapTicks)
  if (end <= start) end = start + snapTicks
  return { start, end }
}

/** The same-length range immediately before (dir -1) or after (dir +1). */
export function shiftRange(range, dir) {
  const len = range.end - range.start
  const start = Math.max(0, range.start + dir * len)
  return { start, end: start + len }
}

// ── Edits ───────────────────────────────────────────────────────────────────

export function deleteNotes(notes, ids) {
  return notes.filter((n) => !ids.has(n.id))
}

/** Move by a tick delta, clamped so no moved note starts before 0. */
export function moveBy(notes, ids, deltaTicks) {
  const moving = notes.filter((n) => ids.has(n.id))
  if (!moving.length) return notes
  const minStart = Math.min(...moving.map((n) => n.positionTicks))
  const d = Math.max(-minStart, deltaTicks)
  if (d === 0) return notes
  return notes.map((n) => (ids.has(n.id) ? { ...n, positionTicks: n.positionTicks + d } : n))
}

/**
 * Rotate inside the bars the notes occupy: what falls off one end comes back
 * in at the other.
 */
export function rotate(notes, ids, deltaTicks) {
  const moving = notes.filter((n) => ids.has(n.id))
  if (!moving.length) return notes
  const start = floorTo(Math.min(...moving.map((n) => n.positionTicks)), BAR_TICKS)
  const end = Math.max(start + BAR_TICKS, ceilTo(Math.max(...moving.map((n) => n.positionTicks + 1)), BAR_TICKS))
  const len = end - start
  return notes.map((n) => {
    if (!ids.has(n.id)) return n
    const rel = (((n.positionTicks - start + deltaTicks) % len) + len) % len
    return { ...n, positionTicks: start + rel }
  })
}

/**
 * Transpose. `stepPitch(pitch, dir)` maps one step (a semitone, or a scale
 * degree under scale lock); octave jumps pass `semitones` instead. The whole
 * group is clamped so its intervals survive hitting the keyboard edge.
 */
export function transpose(notes, ids, { semitones = 0, dir = 0, stepPitch = null } = {}) {
  const moving = notes.filter((n) => ids.has(n.id))
  if (!moving.length) return notes
  if (stepPitch && dir) {
    return notes.map((n) => (ids.has(n.id) ? { ...n, pitch: clampPitch(stepPitch(n.pitch, dir)) } : n))
  }
  const lo = Math.min(...moving.map((n) => n.pitch))
  const hi = Math.max(...moving.map((n) => n.pitch))
  const d = Math.max(PITCH_MIN - lo, Math.min(PITCH_MAX - hi, semitones))
  if (d === 0) return notes
  return notes.map((n) => (ids.has(n.id) ? { ...n, pitch: n.pitch + d } : n))
}

export function setVelocity(notes, ids, velocity) {
  const v = Math.max(0, Math.min(1, velocity))
  return notes.map((n) => (ids.has(n.id) ? { ...n, velocity: v } : n))
}

/** Every note's length to one snap step. */
export function discardLengths(notes, ids, lengthTicks) {
  return notes.map((n) => (ids.has(n.id) ? { ...n, durationTicks: Math.max(MIN_NOTE_TICKS, lengthTicks) } : n))
}

/** Note starts to the nearest snap line (lengths untouched). */
export function quantizeStarts(notes, ids, snapTicks) {
  return notes.map((n) => (ids.has(n.id)
    ? { ...n, positionTicks: Math.max(0, Math.round(n.positionTicks / snapTicks) * snapTicks) }
    : n))
}

/**
 * Copies of the source notes placed right after them. The range defaults to
 * the sources' grid-widened span; the copies are offset by its length and
 * come back marked for selection, with the range they now occupy.
 */
export function duplicateRight(notes, selectedIds, range, snapTicks) {
  const ids = range
    ? notesStartingIn(notes, range)
    : targetIds(notes, selectedIds)
  const span = range || spanOf(notes, ids, snapTicks)
  if (!span || !ids.size) return { notes, range: span }
  const len = span.end - span.start
  const copies = notes
    .filter((n) => ids.has(n.id))
    .map(({ id, ...rest }) => ({ ...rest, positionTicks: rest.positionTicks + len, _select: true }))
  return { notes: [...notes, ...copies], range: { start: span.start + len, end: span.end + len } }
}

/** Cut one note at `tick`; returns [left, right] or null when tick is not inside it. */
function splitNote(n, tick, selectRight = false) {
  if (tick <= n.positionTicks || tick >= noteEnd(n)) return null
  const left = { ...n, durationTicks: tick - n.positionTicks }
  const { id, ...rest } = n
  const right = { ...rest, positionTicks: tick, durationTicks: noteEnd(n) - tick }
  if (selectRight) right._select = true
  return [left, right]
}

/**
 * Slice notes at one tick. `ids` limits which notes are cut (null = any).
 * deleteSmallest drops the shorter half of each cut note (FL Right-Shift +
 * right-click); ties keep the left half.
 */
export function sliceAt(notes, ids, tick, { deleteSmallest = false } = {}) {
  const out = []
  for (const n of notes) {
    const parts = (!ids || ids.has(n.id)) ? splitNote(n, tick) : null
    if (!parts) { out.push(n); continue }
    if (!deleteSmallest) { out.push(...parts); continue }
    const [left, right] = parts
    if (right.durationTicks > left.durationTicks) out.push({ ...right, id: n.id })
    else out.push(left)
  }
  return out
}

/**
 * Slice along a drawn line. Each pitch row between the line's two ends is cut
 * at the tick where the line crosses it (a vertical line cuts every row at
 * one tick, a diagonal one staggers the cuts).
 */
export function sliceAlongLine(notes, { tick0, pitch0, tick1, pitch1 }) {
  const lo = Math.min(pitch0, pitch1)
  const hi = Math.max(pitch0, pitch1)
  const tickAt = (pitch) => {
    if (pitch0 === pitch1) return tick0
    const t = (pitch - pitch0) / (pitch1 - pitch0)
    return Math.round(tick0 + t * (tick1 - tick0))
  }
  const out = []
  for (const n of notes) {
    const parts = n.pitch >= lo && n.pitch <= hi ? splitNote(n, tickAt(n.pitch)) : null
    if (parts) out.push(...parts)
    else out.push(n)
  }
  return out
}

/** Push every note starting at or after range.start right by the range length. */
export function insertSpace(notes, range, { slice = false } = {}) {
  const len = range.end - range.start
  if (len <= 0) return notes
  const base = slice ? sliceAt(notes, null, range.start) : notes
  return base.map((n) => (n.positionTicks >= range.start ? { ...n, positionTicks: n.positionTicks + len } : n))
}

/** Remove what starts inside the range and close the gap behind it. */
export function deleteSpace(notes, range) {
  const len = range.end - range.start
  if (len <= 0) return notes
  return notes
    .filter((n) => n.positionTicks < range.start || n.positionTicks >= range.end)
    .map((n) => (n.positionTicks >= range.end ? { ...n, positionTicks: n.positionTicks - len } : n))
}

/**
 * Shift+drag a right edge: resize WITHOUT overlapping. The dragged notes'
 * ends move by `deltaTicks`; any other note (any pitch) that starts where a
 * dragged note ended, or that the new end would run into, has its START moved
 * to the new end with its own end held, so the boundary between them moves
 * instead of the notes overlapping. Notes that already touched stay touching
 * when the edge is pulled back.
 *
 * A selected note that starts exactly where another dragged note ends is a
 * follower, not a resized note — dragging the boundary of a fully selected
 * legato run moves the boundary.
 *
 * The delta is clamped so nothing drops below MIN_NOTE_TICKS. Returns
 * { notes, delta, touched } — `touched` are the ids whose geometry changed
 * (for previews).
 */
export function legatoResize(notes, draggedIds, anchorId, deltaTicks, minTicks = MIN_NOTE_TICKS) {
  const byId = new Map(notes.map((n) => [n.id, n]))
  const ends = new Set(notes.filter((n) => draggedIds.has(n.id)).map(noteEnd))
  const resized = new Set()
  for (const id of draggedIds) {
    const n = byId.get(id)
    if (!n) continue
    if (id !== anchorId && ends.has(n.positionTicks)) continue
    resized.add(id)
  }
  if (!resized.size) return { notes, delta: 0, touched: new Set() }

  // Clamp: resized notes keep minTicks, and no follower can be squeezed below it.
  let lo = -Infinity
  let hi = Infinity
  for (const id of resized) {
    const d = byId.get(id)
    lo = Math.max(lo, minTicks - d.durationTicks)
    const end = noteEnd(d)
    for (const f of notes) {
      if (resized.has(f.id) || f.positionTicks < end) continue
      hi = Math.min(hi, noteEnd(f) - minTicks - end)
    }
  }
  const delta = Math.max(lo, Math.min(hi, deltaTicks))

  const newStart = new Map()
  for (const id of resized) {
    const d = byId.get(id)
    const oldEnd = noteEnd(d)
    const newEnd = oldEnd + delta
    for (const f of notes) {
      if (resized.has(f.id)) continue
      const s = f.positionTicks
      const follows = s === oldEnd || (s > oldEnd && s < newEnd)
      if (!follows) continue
      newStart.set(f.id, Math.max(newStart.get(f.id) ?? -Infinity, newEnd))
    }
  }
  const touched = new Set()
  const out = notes.map((n) => {
    if (resized.has(n.id)) {
      if (delta === 0) return n
      touched.add(n.id)
      return { ...n, durationTicks: n.durationTicks + delta }
    }
    const s = newStart.get(n.id)
    if (s == null || s === n.positionTicks) return n
    touched.add(n.id)
    return { ...n, positionTicks: s, durationTicks: noteEnd(n) - s }
  })
  return { notes: out, delta, touched }
}

/**
 * Paint: one note per slot the stroke crosses. `cells` is the ordered list of
 * {slot, pitch} the pointer visited; mono keeps only the last pitch per slot.
 * Slots that already hold a note of that pitch at that start are skipped.
 */
export function paintNotes(existing, cells, { originTicks, slotTicks, template, mono = false }) {
  const bySlot = new Map()
  const seen = new Set()
  const ordered = []
  for (const c of cells) {
    const key = `${c.slot}:${c.pitch}`
    if (mono) bySlot.set(c.slot, c.pitch)
    else if (!seen.has(key)) { seen.add(key); ordered.push(c) }
  }
  const list = mono ? Array.from(bySlot, ([slot, pitch]) => ({ slot, pitch })) : ordered
  const taken = new Set(existing.map((n) => `${n.positionTicks}:${n.pitch}`))
  const out = []
  for (const { slot, pitch } of list) {
    const positionTicks = originTicks + slot * slotTicks
    if (positionTicks < 0 || taken.has(`${positionTicks}:${pitch}`)) continue
    out.push({ ...template, positionTicks, durationTicks: slotTicks, pitch: clampPitch(pitch), _select: true })
  }
  return out
}

// ── Commit plumbing ─────────────────────────────────────────────────────────

/** Strip editor-only flags; what the engine sees. */
export function toEngineNote(n) {
  const out = {
    positionTicks: Math.max(0, Math.round(n.positionTicks)),
    durationTicks: Math.max(1, Math.round(n.durationTicks)),
    pitch: clampPitch(n.pitch),
    velocity: n.velocity ?? 1,
  }
  if (Number.isInteger(n.id) && n.id > 0) out.id = n.id
  if (n.isSlide) {
    out.isSlide = true
    out.slideCurveCx = n.slideCurveCx ?? 0.5
    out.slideCurveCy = n.slideCurveCy ?? 0.5
  }
  // Per-note Lens override (docs/XLETH_LENS_ROAM_SPEC.md, Ruling 6). editPatternNotes
  // REPLACES the pattern's note list, so a note sent without it loses it. Opaque
  // here: the engine owns the format. Absent = Follow.
  if (n.lensOverride) out.lensOverride = n.lensOverride
  // Voice pin (Clones, docs/XLETH_CLONE_SPEC.md): same reason. Absent / -1 = Auto.
  if (Number.isInteger(n.voicePin) && n.voicePin >= 0) out.voicePin = n.voicePin
  return out
}

/**
 * A note as a NEW note for another pattern (Make Unique Copy): everything the
 * engine keeps, Lens override and voice pin included, minus the id (the target
 * pattern assigns one).
 */
export function toNewNoteCopy(n) {
  const { id, ...rest } = toEngineNote(n)
  return rest
}

/**
 * Per-note operations that turn `before` into `after`, for the fallback path
 * when the engine has no editPatternNotes (an older native module).
 */
export function diffNotes(before, after) {
  const prev = new Map(before.map((n) => [n.id, n]))
  const keep = new Set()
  const moves = []
  const resizes = []
  const velocities = []
  const adds = []
  after.forEach((n, index) => {
    const old = Number.isInteger(n.id) && n.id > 0 ? prev.get(n.id) : null
    if (!old) { adds.push({ note: n, index }); return }
    keep.add(n.id)
    if (old.positionTicks !== n.positionTicks || old.pitch !== n.pitch) {
      moves.push({ noteId: n.id, positionTicks: n.positionTicks, pitch: n.pitch })
    }
    if (old.durationTicks !== n.durationTicks) resizes.push({ noteId: n.id, durationTicks: n.durationTicks })
    if ((old.velocity ?? 1) !== (n.velocity ?? 1)) velocities.push({ noteId: n.id, velocity: n.velocity ?? 1 })
  })
  const removes = before.filter((n) => !keep.has(n.id)).map((n) => n.id)
  return { removes, moves, resizes, velocities, adds }
}

/** True when two lists describe the same notes (nothing to commit). */
export function sameNotes(a, b) {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    const x = a[i]
    const y = b[i]
    if (x.id !== y.id || x.positionTicks !== y.positionTicks || x.durationTicks !== y.durationTicks
      || x.pitch !== y.pitch || (x.velocity ?? 1) !== (y.velocity ?? 1) || !!y._select
      // By reference: edits spread a note and keep its override object, so
      // only a real override change makes a new one.
      || (x.lensOverride ?? null) !== (y.lensOverride ?? null)
      || (x.voicePin ?? -1) !== (y.voicePin ?? -1)) return false
  }
  return true
}
