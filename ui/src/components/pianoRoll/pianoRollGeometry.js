// Pure geometry shared by the Piano Roll canvases (keys, ruler, grid, lane).
// No DOM, no tokens: every function takes plain numbers so the alignment
// contracts (a key sits on exactly the grid row of its pitch, a ruler label on
// exactly its grid line) are unit-testable.

export const PITCH_MIN = 12   // C0
export const PITCH_MAX = 131  // B9
export const NUM_PITCHES = PITCH_MAX - PITCH_MIN + 1

const BLACK_KEY_SET = new Set([1, 3, 6, 8, 10])
const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']

export function isBlackKey(pitch) {
  return BLACK_KEY_SET.has(((pitch % 12) + 12) % 12)
}

export function pitchLabel(pitch) {
  const octave = Math.floor(pitch / 12) - 1
  return `${NOTE_NAMES[((pitch % 12) + 12) % 12]}${octave}`
}

/** Top y (CSS px, canvas-local) of a pitch row. The canvas and the keys both use this. */
export function rowY(pitch, pixelsPerSemitone, scrollY) {
  return (PITCH_MAX - pitch) * pixelsPerSemitone - scrollY
}

/** Pitch under a canvas-local y, clamped to the keyboard range. */
export function pitchAtY(y, pixelsPerSemitone, scrollY) {
  const p = PITCH_MAX - Math.floor((y + scrollY) / pixelsPerSemitone)
  return Math.max(PITCH_MIN, Math.min(PITCH_MAX, p))
}

/** Rows that intersect [0, height), top to bottom. */
export function visibleRows(pixelsPerSemitone, scrollY, height) {
  const rows = []
  if (!(pixelsPerSemitone > 0)) return rows
  const top = pitchAtY(0, pixelsPerSemitone, scrollY)
  for (let p = top; p >= PITCH_MIN; p--) {
    const y = rowY(p, pixelsPerSemitone, scrollY)
    if (y >= height) break
    if (y + pixelsPerSemitone <= 0) continue
    rows.push({ pitch: p, y, black: isBlackKey(p) })
  }
  return rows
}

// Grid lines never sit closer than this many CSS px (DAW grammar: adaptive).
export const MIN_LINE_SPACING_PX = 6

/**
 * Which line tiers to draw at a zoom: bars always, beats and 16th steps only
 * when they would be at least MIN_LINE_SPACING_PX apart. When even bars
 * crowd (very far out), only every Nth bar is drawn.
 */
export function gridTiers(pixelsPerBeat, beatsPerBar = 4) {
  const step = pixelsPerBeat / 4
  let barEvery = 1
  while (pixelsPerBeat * beatsPerBar * barEvery < MIN_LINE_SPACING_PX) barEvery *= 2
  return {
    steps: step >= MIN_LINE_SPACING_PX,
    beats: pixelsPerBeat >= MIN_LINE_SPACING_PX,
    barEvery,
  }
}

const BAR_LABEL_MIN_PX = 28
const BEAT_LABEL_MIN_PX = 36

/**
 * Ruler marks for the visible range: bar lines with their number (thinned to
 * every 2nd/4th/… bar when labels would collide) and beat lines labelled
 * "bar.beat" when there is room. x is canvas-local, the same x the grid draws.
 */
export function rulerMarks(pixelsPerBeat, scrollX, width, beatsPerBar = 4) {
  const marks = []
  if (!(pixelsPerBeat > 0) || !(width > 0)) return marks
  const barPx = pixelsPerBeat * beatsPerBar
  let labelEvery = 1
  while (barPx * labelEvery < BAR_LABEL_MIN_PX) labelEvery *= 2
  const beatLabels = pixelsPerBeat >= BEAT_LABEL_MIN_PX
  const startBeat = Math.max(0, Math.floor(scrollX / pixelsPerBeat))
  const endBeat = Math.ceil((scrollX + width) / pixelsPerBeat)
  for (let b = startBeat; b <= endBeat; b++) {
    const x = b * pixelsPerBeat - scrollX
    if (x < -40 || x > width) continue
    const bar = Math.floor(b / beatsPerBar)
    if (b % beatsPerBar === 0) {
      marks.push({ x, kind: 'bar', label: bar % labelEvery === 0 ? String(bar + 1) : null })
    } else {
      marks.push({ x, kind: 'beat', label: beatLabels ? `${bar + 1}.${(b % beatsPerBar) + 1}` : null })
    }
  }
  return marks
}
