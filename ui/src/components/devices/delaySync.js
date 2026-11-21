import { syncDivLabel } from '../mixer/delayVizMath.js'

// The Delay's tempo-sync adapter (moved out of DelayPanel.jsx in Phase 4b, the
// mixer panel re-exports it). Labels print as note values: 1/8D, 1/16, 1/4T.

// ── Legacy sync adapter ─────────────────────────────────────────────────────
// The engine stores sync_div_l/r as an integer index 0–11 into kDivFractions.
// A future engine version will expose separate note + feel params. Until then
// we translate at the UI layer only — the engine always receives the legacy
// index; no fake params are ever sent.
//
// Index map (matches engine kDivFractions exactly):
//   0=1/1 str  1=1/2 str  2=1/2 dot
//   3=1/4 str  4=1/4 dot  5=1/4 tri
//   6=1/8 str  7=1/8 dot  8=1/8 tri
//   9=1/16 str 10=1/16 dot 11=1/16 tri
const SYNC_NOTE_FEEL = [
  { note: '1/1',  feel: 'straight' }, // 0
  { note: '1/2',  feel: 'straight' }, // 1
  { note: '1/2',  feel: 'dotted'   }, // 2
  { note: '1/4',  feel: 'straight' }, // 3
  { note: '1/4',  feel: 'dotted'   }, // 4
  { note: '1/4',  feel: 'triplet'  }, // 5
  { note: '1/8',  feel: 'straight' }, // 6
  { note: '1/8',  feel: 'dotted'   }, // 7
  { note: '1/8',  feel: 'triplet'  }, // 8
  { note: '1/16', feel: 'straight' }, // 9
  { note: '1/16', feel: 'dotted'   }, // 10
  { note: '1/16', feel: 'triplet'  }, // 11
]

/** Decodes a legacy sync_div index to { note, feel }. Clamps to [0, 11]. */
export function indexToNoteFeel(idx) {
  const i = Math.round(Math.max(0, Math.min(11, idx ?? 3)))
  return SYNC_NOTE_FEEL[i]
}

/**
 * Encodes a { note, feel } pair to the legacy engine index.
 * Returns null if the combo is not supported by the current engine.
 */
export function noteFeelToIndex(note, feel) {
  const i = SYNC_NOTE_FEEL.findIndex(e => e.note === note && e.feel === feel)
  return i === -1 ? null : i
}

/** Returns the feels available for a given note value. */
export function availableFeels(note) {
  return SYNC_NOTE_FEEL.filter(e => e.note === note).map(e => e.feel)
}

const NOTE_OPTIONS = ['1/1', '1/2', '1/4', '1/8', '1/16']

/** Sentinel option value for millisecond free-time mode. */
export const TIME_MODE_FREE = 'ms'

/** Encodes a note+feel pair as an option value ("1/4|dotted"). */
export function encodeTimeMode(note, feel) {
  return `${note}|${feel}`
}

/**
 * Decodes an option value back to a legacy engine index.
 * Returns null for free-time mode and for any unsupported combo — callers must
 * treat null as "do not write sync_div".
 */
export function decodeTimeMode(optionValue) {
  if (optionValue === TIME_MODE_FREE) return null
  const [note, feel] = String(optionValue).split('|')
  return noteFeelToIndex(note, feel)
}

// Built from the adapter itself, so the dropdown can never offer a combo the
// engine has no index for.
export const TIME_MODE_OPTIONS = [
  { value: TIME_MODE_FREE, label: 'Free (ms)', group: 'Mode' },
  ...NOTE_OPTIONS.flatMap(note =>
    availableFeels(note).map(feel => ({
      value: encodeTimeMode(note, feel),
      label: syncDivLabel(noteFeelToIndex(note, feel)),
      group: 'Musical division',
    }))
  ),
]
