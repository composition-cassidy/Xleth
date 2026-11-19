// Voice pins in the Piano Roll (docs/XLETH_CLONE_SPEC.md, "Pinned"). A note's
// `voicePin` says which cell plays it: absent / -1 Auto, 0 the source track,
// k the source's k-th Voice clone. Pure helpers: the toolbar's Voice control and
// the "V1" marker the canvas draws on a pinned note share them.

import { VOICE_PIN_AUTO, voicePinOptions } from '../../clones/cloneModel.js'

/** The pin a note carries: VOICE_PIN_AUTO (-1), 0 for the source, k for Voice clone k. */
export function notePin(note) {
  return Number.isInteger(note?.voicePin) && note.voicePin >= 0 ? note.voicePin : VOICE_PIN_AUTO
}

/**
 * The selection's pin: the one pin every selected note shares, 'mixed' when they
 * differ, null when nothing (that still exists) is selected.
 */
export function selectionPin(notes, selectedIds) {
  if (!selectedIds || selectedIds.size === 0 || !Array.isArray(notes)) return null
  let pin = null
  for (const n of notes) {
    if (!selectedIds.has(n.id)) continue
    const p = notePin(n)
    if (pin === null) pin = p
    else if (pin !== p) return 'mixed'
  }
  return pin
}

/**
 * The marker drawn on a pinned note: "V0" for the source, "V1", "V2"… for its
 * Voice clones. Null for an Auto note, when the pattern's track has no Voice
 * clones, and for a pin to a Clone that no longer exists (that note is Auto).
 */
export function voicePinMark(note, voiceCount) {
  const count = Math.max(0, Math.trunc(voiceCount || 0))
  const p = notePin(note)
  if (count === 0 || p < 0 || p > count) return null
  return `V${p}`
}

/** The Voice control's options for a source: Auto, the source, then each Voice clone. */
export function voicePinSelectOptions(tracks, sourceId) {
  return voicePinOptions(tracks, sourceId).map((o) => ({
    value: o.pin,
    label: o.label,
    hint: o.pin === VOICE_PIN_AUTO
      ? 'Auto: the note takes the lowest free voice'
      : `Pin to ${o.label}: marked V${o.pin} on the note`,
  }))
}

/** {patternId, noteId} refs for the selected notes of one pattern, in note order. */
export function selectedNoteRefs(patternId, notes, selectedIds) {
  if (!Number.isInteger(patternId) || !selectedIds || selectedIds.size === 0) return []
  return (notes ?? []).filter((n) => selectedIds.has(n.id)).map((n) => ({ patternId, noteId: n.id }))
}
