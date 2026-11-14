// Per-note Lens override plumbing (docs/XLETH_LENS_ROAM_SPEC.md, Ruling 6; phase P5).
//
// A note's override lives ON the engine's PatternNote as `lensOverride`
// ({ mode: 'Nudge' | 'Own', keys: [...] }; absent = Follow), so the spec's
// {patternId, noteId} key is the note's own address. P5 only carries it: nothing
// evaluates it (P8) and no panel edits it (P8/P9). This module is the dev hook
// that sets one through the real piano-roll commit path, so the plumbing can be
// checked end to end: getPattern -> edit the list -> editPatternNotes (one
// UndoManager entry), exactly what a piano-roll edit does.

import { timelineEvents } from '../timelineEvents.js'
import { toEngineNote } from '../components/pianoRoll/pianoRollEdits.js'
import {
  setNoteLensMode, setNoteLensKeys, revertNotesToFollow, setHitCurve, applyHitPreset,
  setNotesLensKeys, setClipLensKeys, getHitPresets, setTrackRoamKeys,
} from './lensRoamApi.js'

const TAG = '[LensNote]'

/**
 * The note list with one note's override replaced. `override` null/undefined
 * clears it (Follow). Every other note is returned as the SAME object.
 */
export function withNoteLensOverride(notes, noteId, override) {
  let found = false
  const out = notes.map((n) => {
    if (n.id !== noteId) return n
    found = true
    const { lensOverride, ...rest } = n
    return override ? { ...rest, lensOverride: override } : rest
  })
  return found ? out : null
}

/**
 * Set (or clear, with null) one note's override. Resolves to the engine's
 * post-state of that note, or null when the pattern/note does not exist or the
 * call failed. One undo entry.
 */
export async function setNoteLensOverride(patternId, noteId, override) {
  const tl = window.xleth?.timeline
  if (typeof tl?.getPattern !== 'function' || typeof tl?.editPatternNotes !== 'function') {
    console.warn(`${TAG} timeline.getPattern/editPatternNotes unavailable; nothing sent`)
    return null
  }
  const pattern = await tl.getPattern(patternId)
  const next = pattern && withNoteLensOverride(pattern.notes || [], noteId, override)
  if (!next) {
    console.warn(`${TAG} pattern=${patternId} note=${noteId} not found`)
    return null
  }
  console.log(`${TAG} -> editPatternNotes pattern=${patternId} note=${noteId}`, override ?? 'Follow')
  let after
  try {
    after = await tl.editPatternNotes(patternId, next.map(toEngineNote))
  } catch (err) {
    console.error(`${TAG} editPatternNotes failed:`, err?.message ?? err)
    return null
  }
  const note = Array.isArray(after) ? after.find((n) => n.id === noteId) ?? null : null
  console.log(`${TAG} <- note=${noteId}`, note?.lensOverride ?? 'Follow')
  timelineEvents.dispatchEvent(new Event('timeline-pattern-changed'))
  return note
}

/** Read one note's override straight from the engine (null = Follow / not found). */
export async function getNoteLensOverride(patternId, noteId) {
  const pattern = await window.xleth?.timeline?.getPattern?.(patternId)
  const note = pattern?.notes?.find((n) => n.id === noteId)
  return note?.lensOverride ?? null
}

/**
 * Installs window.__xlethLensDev; returns the uninstaller. P8 adds the real edit
 * commands (one UndoManager entry each) so they can be driven end to end before
 * the Lens panel has controls for them.
 */
export function installNoteLensDevHook(win) {
  win.__xlethLensDev = {
    setNoteLensOverride, getNoteLensOverride,
    setNoteLensMode, setNoteLensKeys, revertNotesToFollow, setHitCurve, applyHitPreset,
    setNotesLensKeys, setClipLensKeys, getHitPresets, setTrackRoamKeys,
  }
  return () => { delete win.__xlethLensDev }
}
