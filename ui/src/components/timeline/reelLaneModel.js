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
// Clones (docs/XLETH_CLONE_SPEC.md, "Timeline and Motion view"). A source with
// Voice clones splits its notes across voices (cloneModel.assignVoices, decided
// from the pattern alone): the source's own lane keeps only voice 0 plus the
// OVERFLOW notes it plays (flagged REEL_FLAG_OVERFLOW), and Voice clone k gets
// the notes of voice k. A Trail clone gets the source's voice-0 clips shifted
// delayTicks later. All of them come out of the ONE walk below over the source's
// blocks, so the tape / loop / offset math exists once. Clone tracks have no
// blocks of their own; their entries are keyed by the clone's track id.
//
// PURE: no React, no store, no DOM. The result is typed arrays so a 2,000-note
// pattern is a handful of allocations per data change and ZERO per frame.

import { DEFAULT_TRACK_HEIGHT } from '../../constants/timeline.js'
import { isClone, trailClonesOf, voiceClonesOf, voiceMapFor } from '../../clones/cloneModel.js'

/** The lane grows to this many sub-rows, then compresses. */
export const REEL_MAX_SUB_ROWS = 3

/** A clip narrower than this (CSS px) is a plain block: no thumbnail. */
export const REEL_THUMB_MIN_W = 28

/** Width of the badge slot at a clip's right edge (Nudge "+", Own "O"). */
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
 * Height of a Clone's row. A Clone's row IS its lane (it has no blocks), but it
 * also carries the Clone's header (name, kind tag, hide control), so it is never
 * shorter than a track row. Collapsed with its source's Reel lane, it is the same
 * strip, which is still the 24px hit floor its header needs.
 */
export function cloneLaneHeight({ subRows = 1, collapsed = false, trackHeight = DEFAULT_TRACK_HEIGHT } = {}) {
  if (collapsed) return REEL_COLLAPSED_H
  return Math.max(trackHeight, reelLaneHeight({ subRows, trackHeight }))
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

// A clip's per-note Lens state (spec: Follow / Nudge / Own), from its note's
// `lensOverride` (absent = Follow). One override covers EVERY placement and loop
// pass of its note (it lives on the pattern note), so all of that note's ghost
// clips carry the same badge. Stored per clip as a code in the `modes` array.
export const REEL_MODE_FOLLOW = 'follow'
export const REEL_MODE_NUDGE = 'nudge'
export const REEL_MODE_OWN = 'own'
const MODE_BY_CODE = [REEL_MODE_FOLLOW, REEL_MODE_NUDGE, REEL_MODE_OWN]

/** The mode code (0 Follow, 1 Nudge, 2 Own) of an engine note. */
export function noteLensModeCode(note) {
  const mode = note?.lensOverride?.mode
  if (mode === 'Nudge') return 1
  if (mode === 'Own') return 2
  return 0
}

/** The Lens state of clip `i`: REEL_MODE_FOLLOW | REEL_MODE_NUDGE | REEL_MODE_OWN. */
export function reelClipMode(track, i) {
  return MODE_BY_CODE[track?.modes?.[i] ?? 0] ?? REEL_MODE_FOLLOW
}

// Per-clip flag bits (the `flags` array).
/** The note overflows: more notes sound than the source has voices, so the source cell plays it. */
export const REEL_FLAG_OVERFLOW = 1

/** True when clip `i` is an overflow note (only ever set in a source's own lane). */
export function reelClipOverflows(track, i) {
  return ((track?.flags?.[i] ?? 0) & REEL_FLAG_OVERFLOW) !== 0
}

const EMPTY_TRACK = Object.freeze({
  count: 0,
  starts: new Float64Array(0),
  ends: new Float64Array(0),
  noteIds: new Int32Array(0),
  patternIds: new Int32Array(0),
  regionIds: new Int32Array(0),
  modes: new Uint8Array(0),
  flags: new Uint8Array(0),
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
 *   Such a track's Clones get an entry too (keyed by the Clone's track id): the
 *   notes that Clone's cell plays.
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
    // A Clone has no blocks: its lane comes out of its source's walk below.
    if (track?.type !== 'Pattern' || isClone(track)) continue
    const blocks = blocksByTrack.get(track.id)
    if (!blocks || blocks.length === 0) continue

    const voiceClones = voiceClonesOf(tracks, track.id)
    const trailClones = trailClonesOf(tracks, track.id)
    const voiceCount = voiceClones.length
    // One bucket per voice: 0 is the source cell, k is the k-th Voice clone.
    // (Counting is the same walk as filling, so fill plain arrays and copy them
    // into typed arrays once: clip counts are in the thousands, not millions.)
    const buckets = Array.from({ length: voiceCount + 1 }, newBucket)
    // noteId -> { voice, overflow } per pattern, only when there are voices to split across.
    const voiceMaps = voiceCount > 0 ? new Map() : null
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

      let voiceMap = null
      if (voiceMaps) {
        voiceMap = voiceMaps.get(pattern.id)
        if (!voiceMap) {
          voiceMap = voiceMapFor(pattern, voiceCount)
          voiceMaps.set(pattern.id, voiceMap)
        }
      }

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
          const slot = voiceMap?.get(note.id)
          const voice = slot && slot.voice >= 0 && slot.voice <= voiceCount ? slot.voice : 0
          const b = buckets[voice]
          b.starts.push(start)
          b.ends.push(end)
          b.noteIds.push(note.id)
          b.patternIds.push(pattern.id)
          b.regionIds.push(pattern.regionId)
          b.modes.push(noteLensModeCode(note))
          b.flags.push(slot?.overflow ? REEL_FLAG_OVERFLOW : 0)
        }
      }
    }

    if (!hasVideo) continue
    byTrack.set(track.id, packTrack(buckets[0]))
    voiceClones.forEach((clone, k) => byTrack.set(clone.id, packTrack(buckets[k + 1])))
    // A Trail replays the source cell (voice 0, overflow included) delayTicks
    // later. Overflow is only marked where it can be fixed: the source's lane.
    for (const clone of trailClones) {
      byTrack.set(clone.id, packTrack(buckets[0], trailDelayTicks(clone), false))
    }
  }

  return { byTrack, stillByRegion }
}

function newBucket() {
  return { starts: [], ends: [], noteIds: [], patternIds: [], regionIds: [], modes: [], flags: [] }
}

/** A Trail clone's delay in ticks (never negative). */
export function trailDelayTicks(clone) {
  const d = Math.round(Number(clone?.clone?.delayTicks) || 0)
  return d > 0 ? d : 0
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

// Packs one bucket into the lane's typed arrays, sorted by start. `shift` moves
// every clip later (a Trail clone); `keepFlags` false drops the per-clip flags.
function packTrack(bucket, shift = 0, keepFlags = true) {
  const {
    starts: startsIn, ends: endsIn, noteIds: noteIdsIn, patternIds: patternIdsIn,
    regionIds: regionIdsIn, modes: modesIn, flags: flagsIn,
  } = bucket
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
  const modes = new Uint8Array(n)
  const flags = new Uint8Array(n)
  const rows = new Uint8Array(n)

  // Greedy interval colouring in start order: a clip joins the first sub-row
  // that is already free at its start. Butted clips (end == start) share a row.
  // The row a clip lands on is stored as a Uint8, so the depth is capped at 255;
  // anything deeper than that shares the last row (never reached by real notes).
  const rowEnds = []
  let maxLen = 0
  for (let k = 0; k < n; k++) {
    const i = order[k]
    starts[k] = startsIn[i] + shift
    ends[k] = endsIn[i] + shift
    noteIds[k] = noteIdsIn[i]
    patternIds[k] = patternIdsIn[i]
    regionIds[k] = regionIdsIn[i]
    modes[k] = modesIn?.[i] ?? 0
    flags[k] = keepFlags ? (flagsIn?.[i] ?? 0) : 0
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
    starts, ends, noteIds, patternIds, regionIds, modes, flags, rows,
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
