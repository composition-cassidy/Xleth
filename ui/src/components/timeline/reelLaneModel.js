// Reel lane model: the read-only video lane under a Pattern Track.
//
// One ghost clip per (non-slide) note instance. Nothing here is stored: the clips
// are DERIVED, every time, from the pattern blocks and the notes inside their
// patterns, so a piano roll edit moves them on the very next data refresh and the
// lane can never disagree with the piano roll. Position and length are not
// editable from the lane.
//
// The derivation mirrors the engine's video event builder
// (engine/src/render/VideoEventBuilder.cpp, buildPatternEvents) so a ghost clip
// sits exactly where the picture will:
//   - a block shows the slice [offset, offset + duration) of an endless tape made
//     of its pattern repeated end to end; iteration L puts a note at
//     L * patternLength + note.position, and a note belongs to the block when its
//     START falls inside the slice;
//   - with block looping off only iteration 0 exists;
//   - slide notes spawn no video cell, so they get no clip;
//   - the note-off is clamped to the block end (the video stops when the sound
//     stops, spec ruling 4);
//   - only a block whose pattern's region has a source WITH video produces clips.
//
// Overlapping clips stack into sub-rows (greedy interval colouring, so the sub-row
// count is the deepest overlap). The lane grows to REEL_MAX_SUB_ROWS rows and then
// compresses: more sub-rows share the same lane height.
//
// PURE: no React, no store, no DOM. The result is typed arrays so a 2,000-note
// pattern is a handful of allocations per data change and ZERO per frame.

import { DEFAULT_TRACK_HEIGHT } from '../../constants/timeline.js'

/** The lane grows to this many sub-rows, then compresses. */
export const REEL_MAX_SUB_ROWS = 3

/** A clip narrower than this (CSS px) is a plain block: no thumbnail. */
export const REEL_THUMB_MIN_W = 28

/** Width of the badge slot reserved at a clip's right edge (P8 fills it). */
export const REEL_BADGE_W = 12
/** A clip narrower than this has no badge slot; the slot would be the whole clip. */
export const REEL_BADGE_MIN_CLIP_W = 40

// Heights are authored at DEFAULT_TRACK_HEIGHT (36) and scale with the track
// height, like the macro and automation lanes.
const REEL_SUB_ROW_H = 16        // 16px rows: a 16:9 still is 28px wide, the thumbnail threshold
const REEL_PAD = 3               // above and below the stack
const REEL_COLLAPSED_H = 24      // the 24px hit floor: the strip is the only way to expand it

function scaled(px, trackHeight) {
  return Math.round(px * trackHeight / DEFAULT_TRACK_HEIGHT)
}

/** Height of one full-size sub-row at this track height. */
export function reelSubRowHeight(trackHeight = DEFAULT_TRACK_HEIGHT) {
  return Math.max(10, scaled(REEL_SUB_ROW_H, trackHeight))
}

/** Padding above and below the sub-row stack. */
export function reelLanePad(trackHeight = DEFAULT_TRACK_HEIGHT) {
  return Math.max(2, scaled(REEL_PAD, trackHeight))
}

/**
 * Height of the whole lane row. Depends on the track's DEEPEST overlap anywhere
 * in the project, not on what is on screen, so scrolling never changes it.
 * Collapsed, it is a thin strip that still carries the expand control.
 */
export function reelLaneHeight({ subRows = 1, collapsed = false, trackHeight = DEFAULT_TRACK_HEIGHT } = {}) {
  if (collapsed) return REEL_COLLAPSED_H
  const rows = Math.min(REEL_MAX_SUB_ROWS, Math.max(1, subRows))
  return reelLanePad(trackHeight) * 2 + rows * reelSubRowHeight(trackHeight)
}

/**
 * Vertical extent of sub-row `row` (0-based) inside a lane row `{ y, height }`.
 * With <= REEL_MAX_SUB_ROWS sub-rows each is full size; beyond that they share the
 * same inner height. Edges are rounded so neighbours share a pixel boundary.
 */
export function reelSubRowSpan(laneY, laneHeight, subRows, row, trackHeight = DEFAULT_TRACK_HEIGHT) {
  const pad = reelLanePad(trackHeight)
  const innerH = Math.max(1, laneHeight - pad * 2)
  // The lane height already encodes the row count up to REEL_MAX_SUB_ROWS (a
  // one-row lane is one row tall), so dividing the inner height by the count is
  // full size there and the compression beyond it.
  const rowStep = innerH / Math.max(1, subRows)
  const top = laneY + pad
  const y0 = Math.round(top + row * rowStep)
  const y1 = Math.round(top + (row + 1) * rowStep)
  return { y0, y1 }
}

/** All clips are Follow (uncoloured) until the per-note override UI lands (P8). */
export const REEL_MODE_FOLLOW = 'follow'
export function reelClipMode(/* patternId, noteId */) {
  return REEL_MODE_FOLLOW
}

const EMPTY_TRACK = Object.freeze({
  count: 0,
  starts: new Float64Array(0),
  ends: new Float64Array(0),
  noteIds: new Int32Array(0),
  patternIds: new Int32Array(0),
  regionIds: new Int32Array(0),
  rows: new Uint8Array(0),
  subRows: 1,
  maxLen: 0,
})

/** Which sub-row (if any) a clip occupies is stored per clip; this is the empty track. */
export function emptyReelTrack() {
  return EMPTY_TRACK
}

function regionHasVideo(region, sources) {
  if (!region) return false
  const source = sources?.[region.sourceId]
  return !!source && source.hasVideo === true
}

/**
 * Build the Reel model.
 *
 * @param {object}  args
 * @param {Array}   args.tracks         { id, type }
 * @param {Array}   args.patternBlocks  { id, trackId, patternId, positionTicks, durationTicks, offsetTicks, loopEnabled }
 * @param {object}  args.patterns       patternId -> { id, regionId, lengthTicks, notes[] }
 * @param {object}  args.regions        regionId -> { id, sourceId, startTime }
 * @param {object}  args.sources        sourceId -> { id, hasVideo, filePath, duration }
 * @returns {{ byTrack: Map<number, object>, stillByRegion: Map<number, object> }}
 *   byTrack has an entry ONLY for Pattern tracks that have video (at least one
 *   block resolving to a region with a video source), so "has an entry" is "shows
 *   a Reel lane". A video track with no notes yet still has an entry (count 0).
 */
export function buildReelModel({ tracks, patternBlocks, patterns, regions, sources } = {}) {
  const byTrack = new Map()
  const stillByRegion = new Map()
  if (!Array.isArray(tracks) || tracks.length === 0) return { byTrack, stillByRegion }

  const blocksByTrack = new Map()
  for (const block of patternBlocks ?? []) {
    let list = blocksByTrack.get(block.trackId)
    if (!list) { list = []; blocksByTrack.set(block.trackId, list) }
    list.push(block)
  }

  for (const track of tracks) {
    if (track?.type !== 'Pattern') continue
    const blocks = blocksByTrack.get(track.id)
    if (!blocks || blocks.length === 0) continue

    // First pass: how many clips, so the typed arrays are allocated once.
    // (Counting is the same walk as filling, so do both in one go with plain
    // arrays and copy: clip counts are in the thousands, not millions.)
    const starts = []
    const ends = []
    const noteIds = []
    const patternIds = []
    const regionIds = []
    let hasVideo = false

    for (const block of blocks) {
      const pattern = patterns?.[block.patternId]
      if (!pattern) continue
      const region = regions?.[pattern.regionId]
      if (!regionHasVideo(region, sources)) continue
      hasVideo = true
      if (!stillByRegion.has(region.id)) registerStill(stillByRegion, region, sources)

      const patLen = pattern.lengthTicks
      const blockDur = block.durationTicks
      const notes = pattern.notes
      if (!(patLen > 0) || !(blockDur > 0) || !Array.isArray(notes) || notes.length === 0) continue

      const windowStart = block.offsetTicks || 0
      const windowEnd = windowStart + blockDur
      if (windowEnd <= 0) continue
      const blockPos = block.positionTicks
      const blockEnd = blockPos + blockDur

      const firstLoop = Math.max(0, Math.floor(windowStart / patLen))
      let lastLoop = Math.floor((windowEnd - 1) / patLen)
      if (block.loopEnabled === false) lastLoop = Math.min(lastLoop, 0)

      for (let L = firstLoop; L <= lastLoop; L++) {
        const base = L * patLen
        for (let i = 0; i < notes.length; i++) {
          const note = notes[i]
          if (note.isSlide) continue
          const tape = base + note.positionTicks
          if (tape < windowStart || tape >= windowEnd) continue
          const start = blockPos + (tape - windowStart)
          const end = Math.min(start + note.durationTicks, blockEnd)
          if (!(end > start)) continue
          starts.push(start)
          ends.push(end)
          noteIds.push(note.id)
          patternIds.push(pattern.id)
          regionIds.push(pattern.regionId)
        }
      }
    }

    if (!hasVideo) continue
    byTrack.set(track.id, packTrack(starts, ends, noteIds, patternIds, regionIds))
  }

  return { byTrack, stillByRegion }
}

function registerStill(map, region, sources) {
  const source = sources?.[region.sourceId]
  if (!source) return
  map.set(region.id, {
    regionId: region.id,
    sourceId: source.id ?? region.sourceId,
    filePath: source.filePath,
    duration: source.duration,
    // The same frame the Samples grid shows for this region, so the two share
    // one still cache (sampleStills.js).
    timeSeconds: Math.max(0, (region.startTime ?? 0) + STILL_FRAME_OFFSET_S),
  })
}

// Matches SampleThumbnail's STILL_FRAME_OFFSET_S.
export const STILL_FRAME_OFFSET_S = 0.04

function packTrack(startsIn, endsIn, noteIdsIn, patternIdsIn, regionIdsIn) {
  const n = startsIn.length
  if (n === 0) return EMPTY_TRACK

  const order = new Array(n)
  for (let i = 0; i < n; i++) order[i] = i
  order.sort((a, b) =>
    (startsIn[a] - startsIn[b])
    || (endsIn[a] - endsIn[b])
    || (patternIdsIn[a] - patternIdsIn[b])
    || (noteIdsIn[a] - noteIdsIn[b]))

  const starts = new Float64Array(n)
  const ends = new Float64Array(n)
  const noteIds = new Int32Array(n)
  const patternIds = new Int32Array(n)
  const regionIds = new Int32Array(n)
  const rows = new Uint8Array(n)

  // Greedy interval colouring in start order: a clip joins the first sub-row
  // that is already free at its start. Butted clips (end == start) share a row.
  // The row a clip lands on is stored as a Uint8, so the depth is capped at 255;
  // anything deeper than that shares the last row (never reached by real notes).
  const rowEnds = []
  let maxLen = 0
  for (let k = 0; k < n; k++) {
    const i = order[k]
    starts[k] = startsIn[i]
    ends[k] = endsIn[i]
    noteIds[k] = noteIdsIn[i]
    patternIds[k] = patternIdsIn[i]
    regionIds[k] = regionIdsIn[i]
    const len = ends[k] - starts[k]
    if (len > maxLen) maxLen = len

    let r = 0
    while (r < rowEnds.length && rowEnds[r] > starts[k]) r++
    if (r === rowEnds.length) {
      if (rowEnds.length >= 255) r = 254
      else rowEnds.push(ends[k])
    }
    if (rowEnds[r] === undefined || ends[k] > rowEnds[r]) rowEnds[r] = ends[k]
    rows[k] = r
  }

  return {
    count: n,
    starts, ends, noteIds, patternIds, regionIds, rows,
    subRows: Math.max(1, rowEnds.length),
    maxLen,
  }
}

// ── Queries ────────────────────────────────────────────────────────────────

// First index with starts[i] >= value.
function lowerBound(starts, count, value) {
  let lo = 0
  let hi = count
  while (lo < hi) {
    const mid = (lo + hi) >>> 1
    if (starts[mid] < value) lo = mid + 1
    else hi = mid
  }
  return lo
}

/**
 * Visit every clip that can touch [loTick, hiTick). Allocation-free: calls
 * visit(index) with indices into the track's typed arrays.
 */
export function forEachReelClipInRange(track, loTick, hiTick, visit) {
  if (!track || track.count === 0) return
  const { starts, ends, count, maxLen } = track
  // A clip touches the range when start < hi and end > lo. Starts are sorted, so
  // skip everything that started more than maxLen before the range.
  for (let i = lowerBound(starts, count, loTick - maxLen); i < count; i++) {
    if (starts[i] >= hiTick) break
    if (ends[i] <= loTick) continue
    visit(i)
  }
}

/**
 * The clip under `tick` in sub-row `row`, or -1. Clips in one sub-row never
 * overlap, so at most one matches. `slackTicks` widens the hit zone (a clip drawn
 * at its 1px minimum width must still be clickable).
 */
export function reelClipAt(track, tick, row, slackTicks = 0) {
  if (!track || track.count === 0) return -1
  const { starts, ends, rows, count, maxLen } = track
  const lo = tick - slackTicks
  const hi = tick + slackTicks
  let i = lowerBound(starts, count, hi) - 1
  for (; i >= 0; i--) {
    if (starts[i] + maxLen + slackTicks < tick) break
    if (rows[i] !== row) continue
    if (ends[i] > lo && starts[i] <= hi) return i
  }
  return -1
}
