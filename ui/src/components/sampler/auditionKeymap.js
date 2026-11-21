// ── Audition keymap ─────────────────────────────────────────────────────────
// The computer-keyboard piano the sampler panel listens on. Lifted out of
// SamplerPanelContent so the AuditionBar can SHOW what the panel listens for —
// previously the map was a closure inside an effect, which meant two octaves of
// live keybindings with nothing on screen saying they existed.
//
// Offsets are semitones above the base C, in the usual tracker layout:
//   Z S X D C V G B H N J M  -> lower octave  (C .. B)
//   Q 2 W 3 E R 5 T 6 Y 7 U  -> one octave up
//   I 9 O 0 P                -> and the first five of the next
const KEY_OFFSETS = {
  KeyZ: 0, KeyS: 1, KeyX: 2, KeyD: 3, KeyC: 4,
  KeyV: 5, KeyG: 6, KeyB: 7, KeyH: 8, KeyN: 9, KeyJ: 10, KeyM: 11,
  KeyQ: 12, Digit2: 13, KeyW: 14, Digit3: 15, KeyE: 16,
  KeyR: 17, Digit5: 18, KeyT: 19, Digit6: 20, KeyY: 21, Digit7: 22, KeyU: 23,
  KeyI: 24, Digit9: 25, KeyO: 26, Digit0: 27, KeyP: 28,
}

// C4 = 60 is the base the map was originally hard-coded at, so octave 0 keeps
// the bindings exactly where they have always been.
export const BASE_NOTE = 60

// Bounds chosen so EVERY bound key stays in MIDI range at every shift, rather
// than letting the top of the keyboard silently go dead near the limits:
//   lowest  key = BASE + 0  + 12*shift >= 0   ->  shift >= -5
//   highest key = BASE + 28 + 12*shift <= 127 ->  shift <= 3   (60+28+48 = 136)
export const MIN_OCTAVE_SHIFT = -5
export const MAX_OCTAVE_SHIFT = 3

export function clampOctaveShift(n) {
  const v = Math.round(Number(n) || 0)
  return Math.max(MIN_OCTAVE_SHIFT, Math.min(MAX_OCTAVE_SHIFT, v))
}

// code -> MIDI note for the current octave shift, or null if the key is not
// bound / the shifted note falls outside MIDI range.
export function noteForCode(code, octaveShift = 0) {
  const off = KEY_OFFSETS[code]
  if (off == null) return null
  const note = BASE_NOTE + off + clampOctaveShift(octaveShift) * 12
  return (note >= 0 && note <= 127) ? note : null
}

// The lowest note the map can currently produce — what the bar labels itself
// with, so "octave" means something the user can check against the keys.
export function lowNoteFor(octaveShift = 0) {
  return BASE_NOTE + clampOctaveShift(octaveShift) * 12
}

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']

export function noteName(midi) {
  const n = Math.round(Number(midi) || 0)
  // MIDI 60 is C4 here, matching the piano roll's labels.
  return `${NOTE_NAMES[((n % 12) + 12) % 12]}${Math.floor(n / 12) - 1}`
}
