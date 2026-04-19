// Timeline canvas constants

export const TRACK_HEIGHT = 60
export const RULER_HEIGHT = 24
export const HEADER_WIDTH = 180

// Zoom: pixels per beat
export const MIN_PPB = 8       // ~4 bars visible at 1920px
export const MAX_PPB = 50000   // sample-level zoom (≤0.5 spp at 48kHz/140BPM)
export const DEFAULT_PPB = 40
export const ZOOM_FACTOR = 1.15

// Grid
export const BEATS_PER_BAR = 4
export const SUBDIVISIONS = 4  // 16th notes per beat
export const SUB_GRID_THRESHOLD = 80 // ppb above which 16th lines show

// Auto-scroll triggers when playhead exceeds this fraction of visible width
export const AUTO_SCROLL_MARGIN = 0.8

// Default project length in beats (can grow)
export const DEFAULT_LENGTH_BEATS = 128 // 32 bars

// Coordinate helpers
export function beatToPixel(beat, scrollOffset, ppb) {
  return (beat - scrollOffset) * ppb
}

export function pixelToBeat(px, scrollOffset, ppb) {
  return px / ppb + scrollOffset
}

// ── Tick / beat conversions (960 PPQ) ────────────────────────────────────────

export const PPQ = 960
export const CLIP_MIN_WIDTH_PX = 4
export const MIN_DURATION_TICKS_FREE = 60  // ~1/64 note, minimum when alt (free mode) is held

// Beat fraction per granularity key (e.g. '1/16' → 1/4 beat = 240 ticks at PPQ 960)
export const GRANULARITY_BEATS = {
  '1/64': 1 / 16,
  '1/32': 1 / 8,
  '1/16': 1 / 4,
  '1/8':  1 / 2,
  'Beat': 1,
  'Half': 2,
  'Bar':  4,
}

export function snapBeatToGrid(beat, modifiers = {}, granularity = '1/16') {
  if (modifiers.alt)   return beat                      // free (no snap)
  if (modifiers.shift) return Math.round(beat * 8) / 8  // 32nd note override
  if (modifiers.ctrl)  return Math.round(beat * 2) / 2  // 8th note override
  const div = 1 / (GRANULARITY_BEATS[granularity] ?? GRANULARITY_BEATS['1/16'])
  return Math.round(beat * div) / div
}

// Tick-domain snap — round-to-nearest semantics. Used by quantize operations.
export function snapTickToGrid(tick, modifiers = {}, granularity = '1/16') {
  if (modifiers.alt) return tick
  return Math.round(snapBeatToGrid(tick / PPQ, modifiers, granularity) * PPQ)
}

export function ticksToBeats(ticks) { return ticks / PPQ }
export function beatsToTicks(beats) { return Math.round(beats * PPQ) }

export function regionDurationToTicks(startTime, endTime, bpm) {
  const durationBeats = Math.abs(endTime - startTime) * (bpm / 60)
  return Math.round(durationBeats * PPQ)
}

/**
 * findFreePosition — slide a proposed clip position to the right until it
 * doesn't overlap any existing clip on the same track.
 *
 * @param {string} trackId       Track where the new clip will land
 * @param {number} startTicks    Proposed position (in ticks)
 * @param {number} durationTicks Proposed duration
 * @param {Array}  clips         Current clip list
 * @returns {number} Safe position (>= startTicks)
 */
export function findFreePosition(trackId, startTicks, durationTicks, clips) {
  if (!clips || clips.length === 0) return startTicks
  const trackClips = clips
    .filter(c => c.trackId === trackId)
    .sort((a, b) => a.positionTicks - b.positionTicks)
  let candidate = startTicks
  for (const clip of trackClips) {
    const clipEnd = clip.positionTicks + clip.durationTicks
    if (candidate < clipEnd && candidate + durationTicks > clip.positionTicks) {
      candidate = clipEnd
    }
  }
  return candidate
}
