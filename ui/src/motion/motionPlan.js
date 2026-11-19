// Motion plans: a whole Motion view gesture as ONE undo entry
// (docs/XLETH_MOTION_VIEW_DESIGN.md 5.1, 5.4, R3, R4).
//
// A gesture (a key drag across tracks, a stopwatch OFF that removes keys AND sets
// the base, a paste, a parent attach) is planned locally as an ordered list of
// engine writes, then run once on pointerup:
//
//   { kind: 'roamKeys',      trackId, keys }                 setTrackRoamKeys
//   { kind: 'roamBase',      trackId, params }               setTrackRoam (a patch)
//   { kind: 'sweepKeys',     trackId, keys }                 setTrackSweepKeys
//   { kind: 'clipLensKeys',  clipId, keys }                  setClipLensKeys
//   { kind: 'clipLens',      clipId, params }                setClipLens (a patch)
//   { kind: 'hitCurve',      trackId, regionId, curve }      setHitCurve ({ keys, zones? })
//   { kind: 'trackLens',     trackId, regionId, params }     setTrackLens (a patch)
//   { kind: 'notesLensKeys', entries: [{ patternId, noteId, keys }] }  setNotesLensKeys
//   { kind: 'masks',         trackId, masks }                setTrackMasks (whole list)
//   { kind: 'fxKeys',        trackId, keys }                 setTrackFxKeys (a video effect's param keys,
//                            UI key shape: channel = 'uid:param', sent as { uid, param, ... })
//   { kind: 'fxBase',        trackId, index, param, value }  setVisualEffectParam (the effect's own value)
//   { kind: 'parent',        trackId, parentTrackId, opts? } setTrackParent
//   { kind: 'cloneSettings', trackId, patch }                setCloneSettings (a patch: a Trail's
//                            delayTicks / tint / opacity / opacityKeys (whole list, Motion view key
//                            shape, sent in wire form), a Voice clone's lensMode)
//
// runMotionPlan(plan, label) collapses writes to the same target (last wins; a
// patch merges field by field, later fields winning; every notesLensKeys write
// becomes ONE call with one entry per note), sends them through lensRoamApi
// inside the app's shared undo group (withSharedUndoGroup), and resolves to
//   { writes, results, rejected, changed, ok }
// writes = the collapsed plan in send order, results[i] = the engine post-state
// of writes[i] (null when that write failed), rejected[i] = the engine's
// `rejected` reason for writes[i] ('cycle', 'too_deep', ...) or null, changed =
// any result changed, ok = no write failed or was rejected. The refresh events
// come from lensRoamApi itself:
// 'lens-roam-changed' (detail = post-state) for Lens / Roam / Sweep / hit curve /
// mask / parent writes, 'timeline-patterns-changed' for note writes, and
// 'timeline-tracks-changed' for a parent change; Clone settings come from cloneApi
// ('timeline-tracks-changed' + 'clone-settings-changed', detail = post-state).
//
// The writes are sent in plan order without waiting for each answer: calls reach
// the engine in the order they are sent, so the gesture costs one round trip.
// No IPC happens before runMotionPlan (no IPC during drags).

import {
  setClipLens, setClipLensKeys, setHitCurve, setNotesLensKeys, setTrackFxKeys, setTrackLens, setTrackMasks,
  setTrackParent, setTrackRoam, setTrackRoamKeys, setTrackSweepKeys,
} from '../lensRoam/lensRoamApi.js'
import { setChainParam } from '../components/devices/video/videoFxWrites.js'
import { fxKeysToWire } from './fxModel.js'
import { withSharedUndoGroup } from '../components/timeline/undoGroup.js'
import { setCloneSettings } from '../clones/cloneApi.js'
import { clonePatchToWire } from './cloneMotion.js'

const PATCH_KINDS = new Set(['roamBase', 'clipLens', 'trackLens', 'hitCurve', 'cloneSettings'])
const PATCH_FIELD = { hitCurve: 'curve', cloneSettings: 'patch' }

const isId = (v) => Number.isInteger(v)

const KINDS = {
  roamKeys: { target: (w) => `roamKeys:${w.trackId}`, check: (w) => isId(w.trackId) && Array.isArray(w.keys), send: (w) => setTrackRoamKeys(w.trackId, w.keys) },
  roamBase: { target: (w) => `roamBase:${w.trackId}`, check: (w) => isId(w.trackId) && isPatch(w.params), send: (w) => setTrackRoam(w.trackId, w.params) },
  sweepKeys: { target: (w) => `sweepKeys:${w.trackId}`, check: (w) => isId(w.trackId) && Array.isArray(w.keys), send: (w) => setTrackSweepKeys(w.trackId, w.keys) },
  clipLensKeys: { target: (w) => `clipLensKeys:${w.clipId}`, check: (w) => isId(w.clipId) && Array.isArray(w.keys), send: (w) => setClipLensKeys(w.clipId, w.keys) },
  clipLens: { target: (w) => `clipLens:${w.clipId}`, check: (w) => isId(w.clipId) && isPatch(w.params), send: (w) => setClipLens(w.clipId, w.params) },
  hitCurve: {
    target: (w) => `hitCurve:${w.trackId}:${w.regionId}`,
    check: (w) => isId(w.trackId) && isId(w.regionId) && isPatch(w.curve) && Array.isArray(w.curve.keys),
    send: (w) => setHitCurve(w.trackId, w.regionId, w.curve),
  },
  trackLens: {
    target: (w) => `trackLens:${w.trackId}:${w.regionId}`,
    check: (w) => isId(w.trackId) && isId(w.regionId) && isPatch(w.params),
    send: (w) => setTrackLens(w.trackId, w.regionId, w.params),
  },
  notesLensKeys: {
    target: () => 'notesLensKeys',
    check: (w) => Array.isArray(w.entries) && w.entries.every((e) => isId(e?.patternId) && isId(e?.noteId) && Array.isArray(e.keys)),
    send: (w) => setNotesLensKeys(w.entries),
  },
  fxKeys: { target: (w) => `fxKeys:${w.trackId}`, check: (w) => isId(w.trackId) && Array.isArray(w.keys), send: (w) => setTrackFxKeys(w.trackId, fxKeysToWire(w.keys)) },
  fxBase: {
    target: (w) => `fxBase:${w.trackId}:${w.index}:${w.param}`,
    check: (w) => isId(w.trackId) && isId(w.index) && w.index >= 0 && isId(w.param) && Number.isFinite(w.value),
    send: async (w) => { await setChainParam(w.trackId, w.index, w.param, w.value); return { trackId: w.trackId, changed: true } },
  },
  masks: { target: (w) => `masks:${w.trackId}`, check: (w) => isId(w.trackId) && Array.isArray(w.masks), send: (w) => setTrackMasks(w.trackId, w.masks) },
  parent: {
    target: (w) => `parent:${w.trackId}`,
    check: (w) => isId(w.trackId) && isId(w.parentTrackId) && w.parentTrackId >= -1,
    send: (w) => setTrackParent(w.trackId, w.parentTrackId, w.opts),
  },
  cloneSettings: {
    target: (w) => `cloneSettings:${w.trackId}`,
    check: (w) => isId(w.trackId) && isPatch(w.patch) && Object.keys(w.patch).length > 0,
    send: (w) => setCloneSettings(w.trackId, clonePatchToWire(w.patch)),
  },
}

/** The write kinds a plan may hold. */
export const PLAN_KINDS = Object.freeze(Object.keys(KINDS))

function isPatch(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}

/** The target a write replaces ('roamKeys:12'); every note write shares one target. Throws on a malformed write. */
export function planTargetKey(write) {
  const k = KINDS[write?.kind]
  if (!k) throw new Error(`motionPlan: unknown write kind '${write?.kind}' (${PLAN_KINDS.join(', ')})`)
  if (!k.check(write)) throw new Error(`motionPlan: malformed '${write.kind}' write ${JSON.stringify(write)}`)
  return k.target(write)
}

function mergeWrite(prev, next) {
  if (!prev) return next
  if (next.kind === 'notesLensKeys') {
    const byNote = new Map(prev.entries.map((e) => [`${e.patternId}:${e.noteId}`, e]))
    for (const e of next.entries) {
      const key = `${e.patternId}:${e.noteId}`
      byNote.delete(key)   // re-insert so the entry order follows the last write
      byNote.set(key, e)
    }
    return { kind: 'notesLensKeys', entries: [...byNote.values()] }
  }
  if (PATCH_KINDS.has(next.kind)) {
    const field = PATCH_FIELD[next.kind] ?? 'params'
    return { ...next, [field]: { ...prev[field], ...next[field] } }
  }
  return next
}

/**
 * The plan with writes to one target collapsed into one write, placed where the
 * LAST of them was (last wins; patches merge, later fields winning; note entries
 * merge per note). Validates every write (throws on an unknown kind or a missing id).
 */
export function collapsePlan(plan) {
  const list = (plan ?? []).filter(Boolean)
  const merged = new Map()
  const lastIndex = new Map()
  list.forEach((w, i) => {
    const key = planTargetKey(w)
    merged.set(key, mergeWrite(merged.get(key), w))
    lastIndex.set(key, i)
  })
  return [...merged.keys()]
    .sort((a, b) => lastIndex.get(a) - lastIndex.get(b))
    .map((key) => merged.get(key))
}

/**
 * Run a gesture's writes as ONE undo entry (see the file header). A plan of one
 * write is sent without opening a group (it is one entry anyway); an empty plan
 * sends nothing. `group` is a test seam (default: the app's shared grouper).
 */
export async function runMotionPlan(plan, label = 'Motion edit', { group = withSharedUndoGroup } = {}) {
  const writes = collapsePlan(plan)
  if (writes.length === 0) return { writes, results: [], rejected: [], changed: false, ok: true }
  const send = () => Promise.all(writes.map((w) => Promise.resolve(KINDS[w.kind].send(w)).catch((err) => {
    console.error(`[MotionPlan] ${w.kind} failed:`, err?.message ?? err)
    return null
  })))
  const results = writes.length === 1 ? await send() : await group(label, send)
  // A semantic refusal (setTrackParent's `rejected`: a loop, too deep, ...) is
  // not a throw but the write did not happen: it counts as failed.
  const rejected = results.map((r) => (r && r.rejected ? r.rejected : null))
  return {
    writes,
    results,
    rejected,
    changed: results.some((r) => !!r?.changed),
    ok: results.every((r, i) => r !== null && r !== undefined && rejected[i] === null),
  }
}

export default runMotionPlan
