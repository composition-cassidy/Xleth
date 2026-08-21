// ── Snap to Scale ────────────────────────────────────────────────────────────
// Diatonic mode table + pitch-class helpers for the Piano Roll's scale lock.
// Pure functions, no DOM — the canvas uses them for placement/drag snapping and
// for shading out-of-scale rows, and the toolbar uses the label tables.
//
// Every mode here is a rotation of the same 7-note diatonic set, so each one
// contains exactly seven pitch classes and `snapPitchToScale` can never fail to
// find a member within 6 semitones.

export const SCALE_MODES = [
  { id: 'ionian',     label: 'Major / Ionian',  intervals: [0, 2, 4, 5, 7, 9, 11] },
  { id: 'dorian',     label: 'Dorian',          intervals: [0, 2, 3, 5, 7, 9, 10] },
  { id: 'phrygian',   label: 'Phrygian',        intervals: [0, 1, 3, 5, 7, 8, 10] },
  { id: 'lydian',     label: 'Lydian',          intervals: [0, 2, 4, 6, 7, 9, 11] },
  { id: 'mixolydian', label: 'Mixolydian',      intervals: [0, 2, 4, 5, 7, 9, 10] },
  { id: 'aeolian',    label: 'Minor / Aeolian', intervals: [0, 2, 3, 5, 7, 8, 10] },
  { id: 'locrian',    label: 'Locrian',         intervals: [0, 1, 3, 5, 6, 8, 10] },
]

export const ROOT_NOTES = [
  'C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B',
]

export const DEFAULT_SCALE = { enabled: false, root: 0, mode: 'ionian' }

function intervalsFor(modeId) {
  const mode = SCALE_MODES.find((m) => m.id === modeId)
  return (mode || SCALE_MODES[0]).intervals
}

// The seven pitch classes (0..11) of `modeId` transposed to `root`.
export function scalePitchClasses(root, modeId) {
  const r = ((root % 12) + 12) % 12
  return intervalsFor(modeId).map((i) => (i + r) % 12)
}

export function isPitchInScale(pitch, root, modeId) {
  const pc = ((pitch % 12) + 12) % 12
  return scalePitchClasses(root, modeId).includes(pc)
}

// Nearest in-scale pitch to `pitch`, searching outward one semitone at a time.
// Ties (a scale tone equally far above and below) resolve DOWNWARD, so dragging
// across a gap moves in the same direction the cursor is travelling rather than
// jumping ahead of it. Result is clamped into [minPitch, maxPitch]; if a bound
// is not itself in scale the search continues inward from it.
export function snapPitchToScale(pitch, root, modeId, minPitch = 0, maxPitch = 127) {
  if (isPitchInScale(pitch, root, modeId) && pitch >= minPitch && pitch <= maxPitch) {
    return pitch
  }
  for (let d = 1; d <= 12; d++) {
    const down = pitch - d
    if (down >= minPitch && down <= maxPitch && isPitchInScale(down, root, modeId)) return down
    const up = pitch + d
    if (up >= minPitch && up <= maxPitch && isPitchInScale(up, root, modeId)) return up
  }
  return Math.max(minPitch, Math.min(maxPitch, pitch))
}

// The next scale tone strictly above (dir > 0) or below (dir < 0) `pitch`.
// Used for scale-degree transposition, where a semitone key press must always
// land on a DIFFERENT degree — snapPitchToScale alone can return `pitch` itself
// when the step falls inside a whole-tone gap. Returns `pitch` unchanged when
// the range bound leaves nowhere to go.
export function nextScalePitch(pitch, dir, root, modeId, minPitch = 0, maxPitch = 127) {
  const step = dir >= 0 ? 1 : -1
  for (let p = pitch + step; p >= minPitch && p <= maxPitch; p += step) {
    if (isPitchInScale(p, root, modeId)) return p
  }
  return pitch
}

// Human-readable name for the current lock, e.g. "F# Minor / Aeolian".
export function scaleLabel(root, modeId) {
  const mode = SCALE_MODES.find((m) => m.id === modeId) || SCALE_MODES[0]
  return `${ROOT_NOTES[((root % 12) + 12) % 12]} ${mode.label}`
}
