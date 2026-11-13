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
