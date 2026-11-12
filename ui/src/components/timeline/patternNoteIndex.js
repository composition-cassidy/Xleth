// Per-pattern note index for the mini piano-roll drawn inside pattern blocks.
//
// The block preview used to, for every visible block on every frame: allocate a
// pitch array to find min/max (with a spread that overflows the stack on very
// large patterns), then walk EVERY note of EVERY loop iteration of the block,
// on screen or not. A 64-bar block looping a 1-bar pattern zoomed in to one bar
// did 64x the work it needed to.
//
// This keeps, per pattern, the notes sorted by start plus the few aggregates
// the preview needs, so a draw only visits notes that can touch the viewport.
//
// Cached in a WeakMap keyed by the pattern's `notes` ARRAY. Pattern data only
// ever arrives as fresh objects from the engine (TimelineView.setPatterns), and
// a rename keeps the same notes array, so array identity is an exact revision
// key: the entry is dropped by GC with the array it describes.

const _cache = new WeakMap()

const EMPTY = Object.freeze({
  count: 0,
  starts: new Float64Array(0),
  durations: new Float64Array(0),
  pitches: new Float64Array(0),
  minPitch: 0,
  maxPitch: 0,
  minStart: 0,
  maxStart: 0,
  maxDuration: 0,
})

export function getPatternNoteIndex(pattern) {
  const notes = pattern?.notes
  if (!Array.isArray(notes) || notes.length === 0) return EMPTY
  let index = _cache.get(notes)
  if (index) return index

  const n = notes.length
  const order = new Array(n)
  for (let i = 0; i < n; i++) order[i] = i
  order.sort((a, b) => (notes[a].positionTicks - notes[b].positionTicks) || (a - b))

  const starts = new Float64Array(n)
  const durations = new Float64Array(n)
  const pitches = new Float64Array(n)
  let minPitch = Infinity, maxPitch = -Infinity, maxDuration = 0
  for (let i = 0; i < n; i++) {
    const note = notes[order[i]]
    starts[i] = note.positionTicks
    durations[i] = note.durationTicks
    pitches[i] = note.pitch
    if (note.pitch < minPitch) minPitch = note.pitch
    if (note.pitch > maxPitch) maxPitch = note.pitch
    if (note.durationTicks > maxDuration) maxDuration = note.durationTicks
  }

  index = {
    count: n, starts, durations, pitches,
    minPitch, maxPitch,
    minStart: starts[0], maxStart: starts[n - 1],
    maxDuration,
  }
  _cache.set(notes, index)
  return index
}

// First i with starts[i] >= value.
function lowerBound(starts, value) {
  let lo = 0, hi = starts.length
  while (lo < hi) {
    const mid = (lo + hi) >>> 1
    if (starts[mid] < value) lo = mid + 1
    else hi = mid
  }
  return lo
}

/**
 * Visit the note instances of a block that can be on screen.
 *
 * A block plays its pattern as an endless tape (`tape = loop * patternLength +
 * note.positionTicks`) and shows the slice [offsetTicks, offsetTicks +
 * durationTicks) of it. A note is part of the block when its START falls in
 * that slice. `viewLoTape`/`viewHiTape` narrow it further to the part of the
 * tape that maps into the viewport; pass -Infinity/Infinity to visit all.
 *
 * `visit(tapeTick, durationTicks, pitch)` is called once per visible instance.
 */
export function forEachBlockNote(pattern, block, viewLoTape, viewHiTape, visit) {
  const index = getPatternNoteIndex(pattern)
  const patLen = pattern?.lengthTicks
  if (index.count === 0 || !(patLen > 0)) return

  const windowStart = block.offsetTicks || 0
  const windowEnd = windowStart + block.durationTicks

  // Loop range the block spans, exactly as the engine clamps it: with block
  // looping off only iteration 0 sounds, the rest of the block is silence.
  const firstLoop = Math.floor(windowStart / patLen)
  let lastLoop = Math.floor((windowEnd - 1) / patLen)
  if (block.loopEnabled === false) lastLoop = Math.min(lastLoop, 0)

  // Tape range worth visiting: the block's own slice, intersected with the
  // viewport. A note is visible while start < hi and start + duration > lo.
  const lo = Math.max(windowStart, viewLoTape - index.maxDuration)
  const hi = Math.min(windowEnd, viewHiTape)
  if (!(hi > lo)) return

  // Loops that can place a note start inside [lo, hi). Notes may sit at or past
  // the pattern length, so the bound uses the real min/max start, not [0, len).
  const loopLo = Math.max(firstLoop, Math.ceil((lo - index.maxStart) / patLen))
  const loopHi = Math.min(lastLoop, Math.floor((hi - index.minStart) / patLen))

  const { starts, durations, pitches, count } = index
  for (let L = loopLo; L <= loopHi; L++) {
    const base = L * patLen
    for (let i = lowerBound(starts, lo - base); i < count; i++) {
      const tape = base + starts[i]
      if (tape >= hi) break
      if (tape < windowStart) continue
      if (tape + durations[i] <= viewLoTape) continue
      visit(tape, durations[i], pitches[i])
    }
  }
}
