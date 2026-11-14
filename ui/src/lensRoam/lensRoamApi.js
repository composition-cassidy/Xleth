// Lens + Roam: the ONE renderer entry point to the engine (docs/XLETH_LENS_ROAM_SPEC.md, P3).
//
// Lens frames the video inside its grid cell (fit, centerX, centerY, zoom,
// rotationDeg, flip). Roam moves the cell itself (offsetX, offsetY, scale,
// rotationDeg, bounds, layer). Names are final; never "Pan/Crop" or "Track Motion".
//
// Every setter and reset is ONE engine UndoManager command, so Ctrl+Z / undo.undo()
// restores it. `params` is a patch: fields left out keep their value. The engine
// parses strictly (unknown field, wrong type, non-finite number, unknown enum
// string => the call is rejected), and skips the command when nothing changes.
//
// Drags: preview locally, commit once on mouseup (beginLensRoamDrag below).
// There is deliberately no per-mousemove path to the engine.
//
// Each successful write resolves to the engine's post-state
//   { clipId, changed, lens } | { trackId, regionId, changed, explicit, lens } | { trackId, changed, roam }
// and, when something changed, dispatches 'lens-roam-changed' on timelineEvents with
// that post-state as `detail`. A failed write logs and resolves to null, so a caller
// can drop its local preview.

import { timelineEvents } from '../timelineEvents.js'

const TAG = '[LensBridge]'

export const LENS_FIELDS = ['fit', 'centerX', 'centerY', 'zoom', 'rotationDeg', 'flip']
export const ROAM_FIELDS = ['offsetX', 'offsetY', 'scale', 'rotationDeg', 'bounds', 'layer']

function timelineFn(name) {
  const fn = window.xleth?.timeline?.[name]
  if (typeof fn !== 'function') {
    // A missing link in the four-layer bridge must not look like a write that worked.
    console.warn(`${TAG} timeline.${name} is unavailable; nothing sent`)
    return null
  }
  return fn
}

async function call(name, label, args, { write }) {
  const fn = timelineFn(name)
  if (!fn) return null
  console.log(`${TAG} -> ${name} ${label}`)
  let res
  try {
    res = await fn(...args)
  } catch (err) {
    console.error(`${TAG} ${name} ${label} failed:`, err?.message ?? err)
    return null
  }
  if (write) {
    const value = res?.lens ?? res?.roam
    console.log(`${TAG} <- ${name} ${label} changed=${res?.changed}`, value)
    if (res?.changed) {
      timelineEvents.dispatchEvent(new CustomEvent('lens-roam-changed', { detail: res }))
    }
  } else {
    console.log(`${TAG} <- ${name} ${label}`, res)
  }
  return res ?? null
}

const show = (o) => JSON.stringify(o)

// ── Clip Track event Lens (eventId = clip id) ────────────────────────────────

export function setClipLens(clipId, params) {
  return call('setClipLens', `clip=${clipId} ${show(params)}`, [clipId, params], { write: true })
}

export function resetClipLens(clipId) {
  return call('resetClipLens', `clip=${clipId}`, [clipId], { write: true })
}

// ── Pattern Track source Lens ({trackId, regionId}) ──────────────────────────

export function setTrackLens(trackId, regionId, params) {
  return call('setTrackLens', `track=${trackId} region=${regionId} ${show(params)}`,
    [trackId, regionId, params], { write: true })
}

export function resetTrackLens(trackId, regionId) {
  return call('resetTrackLens', `track=${trackId} region=${regionId}`,
    [trackId, regionId], { write: true })
}

// ── Track Roam ───────────────────────────────────────────────────────────────

export function setTrackRoam(trackId, params) {
  return call('setTrackRoam', `track=${trackId} ${show(params)}`, [trackId, params], { write: true })
}

export function resetTrackRoam(trackId) {
  return call('resetTrackRoam', `track=${trackId}`, [trackId], { write: true })
}

// ── Per-note overrides (P8) ──────────────────────────────────────────────────
// A note is addressed by the spec's override key { patternId, noteId } (note ids
// are unique only inside one pattern), so one call can carry a Reel-lane
// selection that spans patterns and still be ONE undo step. Each resolves to
//   { changed, notes: [{ patternId, noteId, mode: 'Follow'|'Nudge'|'Own', lensOverride|null }] }
// and, when something changed, fires 'timeline-patterns-changed' (the override
// lives on the note, so the piano roll and the Reel lane refetch the pattern).

export const NOTE_LENS_MODES = ['Follow', 'Nudge', 'Own']

async function noteCall(name, label, args) {
  const res = await call(name, label, args, { write: false })
  if (res?.changed) timelineEvents.dispatchEvent(new Event('timeline-patterns-changed'))
  return res
}

/** Set notes to Follow, Nudge or Own. Nudge <-> Own keeps each note's keys. */
export function setNoteLensMode(notes, mode) {
  return noteCall('setNoteLensMode', `${show(notes)} -> ${mode}`, [notes, mode])
}

/** Replace one note's keys (Head / Body / Tail anchors). A Follow note becomes Nudge. */
export function setNoteLensKeys(note, keys) {
  return noteCall('setNoteLensKeys', `${show(note)} ${keys?.length ?? 0} keys`, [note, keys])
}

/** Drop the override of every listed note (undo restores them, keys included). */
export function revertNotesToFollow(notes) {
  return noteCall('revertNotesToFollow', show(notes), [notes])
}

// ── Hit curve (P8) ───────────────────────────────────────────────────────────
// A Pattern Track source's note animation. Resolves to
//   { trackId, regionId, changed, explicit, lens, hitCurve, zones, preset? }

/** Replace a source's hit curve: { keys: [...], zones?: { headTicks?, tailTicks?, shortNote? } }. */
export function setHitCurve(trackId, regionId, curve) {
  return call('setHitCurve', `track=${trackId} region=${regionId} ${curve?.keys?.length ?? 0} keys`,
    [trackId, regionId, curve], { write: true })
}

/** Apply a named preset ('Still' | 'Punch' | 'Punch + drift' | 'Zoom pulse'); the keys live in the engine. */
export function applyHitPreset(trackId, regionId, name) {
  return call('applyHitPreset', `track=${trackId} region=${regionId} '${name}'`,
    [trackId, regionId, name], { write: true })
}

// ── Getter ───────────────────────────────────────────────────────────────────

/**
 * Current static Lens/Roam values for a selection.
 * @param {{ clipIds?: number[], sources?: {trackId: number, regionId: number}[], trackIds?: number[] }} selection
 * @returns {Promise<{clips, sources, tracks, missing} | null>}
 */
export function getLensRoam(selection) {
  return call('getLensRoam', show(selection), [selection ?? {}], { write: false })
}

// ── Drag sessions ────────────────────────────────────────────────────────────

/** The fields of `next` that differ from `start`; null when none do. */
export function changedFields(start, next, fields) {
  let patch = null
  for (const f of fields) {
    if (next[f] !== undefined && next[f] !== start[f]) (patch ??= {})[f] = next[f]
  }
  return patch
}

/**
 * One drag gesture on a Lens or Roam value.
 *
 *   const drag = beginLensRoamDrag({ kind: 'clipLens', clipId: 12, start: lens })
 *   onMouseMove: drawPreview(drag.preview({ centerX, centerY }))   // local only, no IPC
 *   onMouseUp:   await drag.commit()                               // ONE command, or none
 *   onEscape:    drag.cancel()
 *
 * preview() only merges into a local value and never talks to the engine.
 * commit() sends the fields that differ from `start` as one set* call; a drag
 * that ends where it began sends nothing. A session commits at most once.
 *
 * @param {{ kind: 'clipLens'|'trackLens'|'trackRoam', clipId?: number, trackId?: number,
 *           regionId?: number, start: object }} opts
 */
export function beginLensRoamDrag({ kind, clipId, trackId, regionId, start }) {
  const fields = kind === 'trackRoam' ? ROAM_FIELDS : LENS_FIELDS
  const base = { ...start }
  let current = { ...start }
  let done = false

  return {
    get value() { return current },
    preview(patch) {
      if (!done) current = { ...current, ...patch }
      return current
    },
    async commit() {
      if (done) return null
      done = true
      const patch = changedFields(base, current, fields)
      if (!patch) return { changed: false, skipped: true }
      if (kind === 'clipLens') return setClipLens(clipId, patch)
      if (kind === 'trackLens') return setTrackLens(trackId, regionId, patch)
      if (kind === 'trackRoam') return setTrackRoam(trackId, patch)
      console.error(`${TAG} unknown drag kind '${kind}'`)
      return null
    },
    cancel() {
      done = true
      current = base
      return current
    },
  }
}
