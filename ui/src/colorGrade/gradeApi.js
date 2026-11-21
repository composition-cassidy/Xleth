// Color Grade: the ONE renderer entry point to the engine.
//
// A target is { level: 'source' | 'clip' | 'region' | 'layer' | 'master', id }.
//
// A drag is three calls, and ends as ONE undo step:
//   previewGrade(target, grade)   live write, no undo entry; the picture moves
//   commitGrade(target, grade)    the release: one engine UndoManager command
//   cancelGrade(target)           Escape: puts back what was there
// A change that is not a drag (a typed value, a reset, Auto, paste) is a
// commitGrade on its own.
//
// setManyGrades writes several targets as one undo step (bulk apply).
//
// Every write that changes something dispatches 'color-grade-changed' on
// timelineEvents, so the indicators, the stack view and any other open panel
// refetch. A failed call logs and resolves to null; the caller drops its draft.

import { timelineEvents } from '../timelineEvents.js'
import { normalizeGrade } from './gradeModel.js'

const TAG = '[ColorGrade]'

export const GRADE_CHANGED = 'color-grade-changed'

const warned = new Set()

function fn(name) {
  const f = window.xleth?.colorGrade?.[name]
  if (typeof f !== 'function') {
    // A missing link in the bridge must not look like a write that worked.
    // Said once per method: the summary asks on every timeline change.
    if (!warned.has(name)) {
      warned.add(name)
      console.warn(`${TAG} colorGrade.${name} is unavailable; nothing sent`)
    }
    return null
  }
  return f
}

async function call(name, args) {
  const f = fn(name)
  if (!f) return null
  try {
    return (await f(...args)) ?? null
  } catch (err) {
    console.error(`${TAG} ${name} failed:`, err?.message ?? err)
    return null
  }
}

function announce(detail, clipsTouched = false) {
  timelineEvents.dispatchEvent(new CustomEvent(GRADE_CHANGED, { detail }))
  // A clip's grade travels on the clip itself (clip.colorGrade), which is what
  // the timeline draws its indicator from and what copy / paste carries, so a
  // clip-level write also asks the arrangement to refetch its clips.
  if (clipsTouched) timelineEvents.dispatchEvent(new Event('timeline-clips-changed'))
}

/** { level, id, exists, grade, isDefault, isNeutral, lutError } or null. */
export async function getGrade(target) {
  const res = await call('get', [target])
  return res ? { ...res, grade: normalizeGrade(res.grade) } : null
}

/**
 * Every grade that is not the default:
 *   { sources:[{id,grade,active}], clips, regions, layers, master:{grade,active}|null, compare }
 */
export async function getAllGrades() {
  const res = await call('getAll', [])
  if (!res) return null
  const list = (arr) => (Array.isArray(arr) ? arr : []).map((e) => ({ ...e, grade: normalizeGrade(e.grade) }))
  return {
    sources: list(res.sources),
    clips: list(res.clips),
    regions: list(res.regions),
    layers: list(res.layers),
    master: res.master ? { ...res.master, grade: normalizeGrade(res.master.grade) } : null,
    compare: res.compare === true,
  }
}

/** Live write of a drag in progress. No undo entry, no event. */
export function previewGrade(target, grade) {
  return call('preview', [target, grade])
}

/** The undo boundary. Resolves to the engine's post-state, with `changed`. */
export async function commitGrade(target, grade, label) {
  const res = await call('commit', label ? [target, grade, label] : [target, grade])
  if (!res) return null
  const out = { ...res, grade: normalizeGrade(res.grade) }
  // Announced even when nothing changed: a drag that ended where it began
  // still moved the picture while it was in flight, and listeners showing a
  // live summary must settle back.
  announce({ target, changed: res.changed === true }, target?.level === 'clip' && res.changed === true)
  return out
}

export async function cancelGrade(target) {
  const res = await call('cancel', [target])
  if (!res) return null
  announce({ target, changed: false })
  return { ...res, grade: normalizeGrade(res.grade) }
}

/** entries = [{ level, id, grade }]. One undo step. Resolves to { changed: n }. */
export async function setManyGrades(entries, label) {
  if (!Array.isArray(entries) || entries.length === 0) return { changed: 0 }
  const res = await call('setMany', label ? [entries, label] : [entries])
  if (!res) return null
  announce({ many: true, changed: res.changed > 0 },
    res.changed > 0 && entries.some((e) => e.level === 'clip'))
  return res
}

/**
 * Look at the footage behind a target. Resolves to
 *   { ok, analysis:{ r, g, b, luma, blackPoint, whitePoint, median, ... }, auto: grade }
 * or { ok:false, error }. Slow (it decodes frames): show that it is working.
 */
export async function analyzeGrade(target, opts) {
  const res = await call('analyze', opts ? [target, opts] : [target])
  if (!res) return { ok: false, error: 'The engine did not answer.' }
  return res.ok ? { ...res, auto: normalizeGrade(res.auto) } : res
}

/** Preview-only: every grade off while held. Never saved, never exported. */
export function setCompare(on) {
  const f = fn('setCompare')
  if (!f) return
  try { f(on === true) } catch (err) { console.error(`${TAG} setCompare failed:`, err?.message ?? err) }
}

/** Is this a usable .cube file? { ok, size, title } or { ok:false, error }. */
export async function checkLut(path) {
  return (await call('checkLut', [path])) ?? { ok: false, error: 'The engine did not answer.' }
}
