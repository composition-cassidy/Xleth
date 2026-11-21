// Which notes the Advanced Lens editor is editing, and where the playhead sits
// inside them (docs/XLETH_LENS_ROAM_SPEC.md, P9). Pure: no React, no IPC.
//
// The notes come from the SHARED note selection (useNoteSelectionStore: the Piano
// Roll and the Reel lane both publish into it, keyed {patternId -> Set(noteId)}),
// so a click in either one is a selection here. A note belongs to this Lens
// panel's source {trackId, regionId} when its pattern plays that region.

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v))

/** 'Follow' | 'Nudge' | 'Own' of an engine note (absent override = Follow). */
export function noteModeOf(note) {
  const m = note?.lensOverride?.mode
  return m === 'Nudge' || m === 'Own' ? m : 'Follow'
}

/** One mode for the whole selection, or 'Mixed'. */
export function summarizeMode(notes) {
  if (!notes?.length) return 'Follow'
  const first = noteModeOf(notes[0])
  return notes.every((n) => noteModeOf(n) === first) ? first : 'Mixed'
}

/**
 * The selected notes that play `regionId`, in a stable order (pattern id, then
 * note position). Each entry is the engine note plus its pattern address.
 *
 * @param {Object<string, Set<number>>} byPattern   the shared selection
 * @param {Map<number, {id:number, regionId:number, notes:Array}>} patterns   by pattern id
 * @returns {Array<{patternId:number, noteId:number, note:object}>}
 */
export function selectedNotesForRegion(byPattern, patterns, regionId) {
  const out = []
  const ids = Object.keys(byPattern ?? {}).map(Number).sort((a, b) => a - b)
  for (const patternId of ids) {
    const pattern = patterns.get(patternId)
    if (!pattern || pattern.regionId !== regionId) continue
    const sel = byPattern[patternId]
    const notes = (pattern.notes ?? [])
      .filter((n) => sel?.has(n.id) && !n.isSlide && n.id > 0)
      .sort((a, b) => a.positionTicks - b.positionTicks)
    for (const note of notes) out.push({ patternId, noteId: note.id, note })
  }
  return out
}

/**
 * Where one pattern note plays on the timeline: every block placement and loop
 * pass, as [start, end) ticks. The same walk the Reel lane model uses, so the
 * editor and the lane agree on what "this note" is.
 *
 * @param {{id:number, lengthTicks:number}} pattern
 * @param {{id:number, positionTicks:number, durationTicks:number, offsetTicks?:number, loopEnabled?:boolean, patternId:number}[]} blocks
 *        the blocks that play this pattern
 */
export function notePlacements(pattern, note, blocks) {
  const out = []
  const patLen = pattern?.lengthTicks
  if (!(patLen > 0) || !note) return out
  for (const block of blocks ?? []) {
    if (block.patternId !== pattern.id) continue
    const blockDur = block.durationTicks
    if (!(blockDur > 0)) continue
    const windowStart = block.offsetTicks || 0
    const windowEnd = windowStart + blockDur
    if (windowEnd <= 0) continue
    const blockPos = block.positionTicks
    const blockEnd = blockPos + blockDur
    const firstLoop = Math.max(0, Math.floor(windowStart / patLen))
    let lastLoop = Math.floor((windowEnd - 1) / patLen)
    if (block.loopEnabled === false) lastLoop = Math.min(lastLoop, 0)
    for (let L = firstLoop; L <= lastLoop; L++) {
      const tape = L * patLen + note.positionTicks
      if (tape < windowStart || tape >= windowEnd) continue
      const start = blockPos + (tape - windowStart)
      // The video stops where the note is clamped to its block (spec Ruling 4).
      const end = Math.min(start + note.durationTicks, blockEnd)
      if (end > start) out.push({ start, end })
    }
  }
  return out.sort((a, b) => a.start - b.start)
}

/**
 * The note-relative time of the playhead. Inside a placement it is exact; when
 * the playhead is outside every placement the first one is used and the time is
 * clamped to its ends, so the readout is the note's first or last frame (and says so).
 *
 * @returns {{t:number, len:number, inside:boolean, edge:'start'|'end'|null}|null}
 */
export function noteTimeAtPlayhead(placements, playheadTick) {
  if (!placements?.length) return null
  for (const p of placements) {
    if (playheadTick >= p.start && playheadTick < p.end) {
      return { t: playheadTick - p.start, len: p.end - p.start, inside: true, edge: null }
    }
  }
  const p = placements[0]
  const len = p.end - p.start
  const t = clamp(playheadTick - p.start, 0, len)
  return { t, len, inside: false, edge: playheadTick < p.start ? 'start' : 'end' }
}

/** Playhead (beats) -> ticks. */
export const beatsToLensTicks = (beats) => beats * 960
