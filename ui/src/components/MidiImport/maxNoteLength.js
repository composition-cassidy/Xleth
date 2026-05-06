// Shared constants/helpers for the MIDI-import "maximum note length" clamp.
// See MidiImportDialog.jsx for the rationale (FL Studio drum-roll sanitation).
import { PPQ } from '../../constants/timeline.js'

export const MAX_NOTE_LENGTH_OPTIONS = [
  { value: 0,  label: 'Off' },
  { value: 4,  label: '1/4' },
  { value: 8,  label: '1/8' },
  { value: 16, label: '1/16' },
  { value: 32, label: '1/32' },
  { value: 64, label: '1/64' },
]

export const DEFAULT_MAX_NOTE_LENGTH_STORAGE_KEY = 'xleth.midiImport.defaultMaxNoteLengthDenom'
export const DEFAULT_MAX_NOTE_LENGTH_DENOM = 16

// 1/4 = 1 quarter = PPQ ticks. 1/16 = PPQ * 4 / 16 = 240 at PPQ=960.
// denom = 0 means Off (no clamp), encoded as 0 ticks on the wire.
export function denomToTicks(denom) {
  return denom > 0 ? Math.round((PPQ * 4) / denom) : 0
}

// Read default applied to NEW output-track rows. Distinguishes "no stored value"
// from a stored "0" (Off) — Number(null) === 0, which would otherwise validate
// against the option list and silently override the default on first run.
export function readDefaultMaxNoteLengthDenom() {
  const stored = localStorage.getItem(DEFAULT_MAX_NOTE_LENGTH_STORAGE_KEY)
  if (stored == null) return DEFAULT_MAX_NOTE_LENGTH_DENOM
  const raw = Number(stored)
  return MAX_NOTE_LENGTH_OPTIONS.some(o => o.value === raw)
    ? raw
    : DEFAULT_MAX_NOTE_LENGTH_DENOM
}
