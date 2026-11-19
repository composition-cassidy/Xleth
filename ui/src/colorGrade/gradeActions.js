// Color Grade: the actions shared by the panel, the stack view and the menus,
// so "switch this level off" (or copy, paste, reset, open) is one piece of code
// whichever surface asks for it. The stack view's on/off and the panel's own
// on/off both call setGradeBypassed, which is why they can never disagree.

import { create } from 'zustand'
import { usePanelRegistry } from '../windowing/registry/PanelRegistry'
import { commitGrade, getGrade, setCompare, setManyGrades } from './gradeApi.js'
import { LEVEL_INFO, cloneGrade, neutralGrade, resetGrade, targetKey } from './gradeModel.js'

// ── Clipboard ────────────────────────────────────────────────────────────────
// One copied grade, with the level it came from. Paste goes to the same level
// elsewhere: source to source, layer to layer, master to master; a clip and a
// sample are the same step of the stack, so they paste to each other.

const levelClass = (level) => (level === 'region' ? 'clip' : level)

export const useGradeClipboard = create((set) => ({
  grade: null,
  level: null,
  copy: (level, grade) => set({ grade: cloneGrade(grade), level }),
  clear: () => set({ grade: null, level: null }),
}))

export function canPaste(clipboard, level) {
  return clipboard?.grade != null && levelClass(clipboard.level) === levelClass(level)
}

// ── Auto: what the engine last proposed for a target ─────────────────────────
// Kept per target so the Strength control goes on working after a tab switch,
// and so it never asks the engine to analyse the same footage twice.

export const useGradeAutoStore = create((set, get) => ({
  byKey: {},
  put: (target, entry) => set((s) => ({ byKey: { ...s.byKey, [targetKey(target)]: entry } })),
  patch: (target, patch) => set((s) => {
    const key = targetKey(target)
    const prev = s.byKey[key]
    return prev ? { byKey: { ...s.byKey, [key]: { ...prev, ...patch } } } : s
  }),
  drop: (target) => set((s) => {
    const next = { ...s.byKey }
    delete next[targetKey(target)]
    return { byKey: next }
  }),
  get: (target) => get().byKey[targetKey(target)] ?? null,
}))

// ── Hold to compare ──────────────────────────────────────────────────────────

export const useGradeCompare = create((set) => ({
  on: false,
  set: (on) => {
    setCompare(on)
    set({ on: on === true })
  },
}))

// ── Writes ───────────────────────────────────────────────────────────────────

/** Switch a level on or off. One undo step. Used by the panel AND the stack view. */
export async function setGradeBypassed(target, bypassed) {
  const current = await getGrade(target)
  if (!current?.exists) return null
  if (current.grade.bypassed === bypassed) return current
  return commitGrade(target, { ...current.grade, bypassed },
    `${bypassed ? 'Switch off' : 'Switch on'} ${LEVEL_INFO[target.level].title.toLowerCase()}`)
}

/** Put a whole grade back to neutral (its on/off state is kept). */
export async function resetWholeGrade(target) {
  const current = await getGrade(target)
  if (!current?.exists) return null
  return commitGrade(target, resetGrade(current.grade),
    `Reset ${LEVEL_INFO[target.level].title.toLowerCase()}`)
}

/**
 * Apply one grade to many sources as ONE undo step.
 * @param {object} grade            the grade to apply
 * @param {number[]} sourceIds      the targets
 * @param {Map<number, object>} existing  sources that already have a grade (id -> summary entry)
 * @param {'replace'|'skip'} onExisting   what to do with those
 * @returns {{ applied:number, skipped:number, changed:number }|null}
 */
export async function applyGradeToSources(grade, sourceIds, existing, onExisting) {
  const entries = []
  let skipped = 0
  for (const id of sourceIds) {
    if (existing?.has(id) && onExisting !== 'replace') { skipped++; continue }
    entries.push({ level: 'source', id, grade: cloneGrade(grade) })
  }
  if (entries.length === 0) return { applied: 0, skipped, changed: 0 }
  const res = await setManyGrades(entries,
    `Apply color grade to ${entries.length} source${entries.length === 1 ? '' : 's'}`)
  if (!res) return null
  return { applied: entries.length, skipped, changed: res.changed ?? 0 }
}

// ── The Color Grade window ───────────────────────────────────────────────────

/**
 * Open (or retarget) the Color Grade window.
 * @param {{level:string, id?:number}} target  the level to edit
 * @param {object} [context]
 * @param {string} [context.name]   the owner's name, for the header
 * @param {object} [context.stack]  the picture's whole stack, when it is known:
 *   { source:{id,name}, clip:{level:'clip'|'region', id, name}, layer:{id,name} }
 *   (any of the three may be missing). Master is always part of it.
 */
export function openColorGrade(target, context = {}) {
  const props = {
    target: target ?? { level: 'master' },
    name: context.name ?? '',
    stack: context.stack ?? null,
  }
  usePanelRegistry.getState().openPanel('colorGrade', props)
}

export { neutralGrade }
