// Shared clip rectangle geometry — used by canvas draw path and DOM overlays
// to keep them numerically aligned. The math here is verbatim with the
// `drawClips` body in timelineDrawing.js (CLIP_PAD = 2 there as well).

import {
  PPQ,
  TRACK_HEIGHT,
  CLIP_MIN_WIDTH_PX,
  beatToPixel,
} from '../../constants/timeline'

export const CLIP_PAD = 2

export function getClipRect(clip, trackIdToIndex, scrollOffset, ppb, trackLayout = null) {
  if (!clip || !trackIdToIndex) return null
  const trackIdx = trackIdToIndex[clip.trackId]
  if (trackIdx == null) return null
  const x = beatToPixel(clip.positionTicks / PPQ, scrollOffset, ppb)
  const rawW = (clip.durationTicks / PPQ) * ppb
  const w = rawW < CLIP_MIN_WIDTH_PX ? CLIP_MIN_WIDTH_PX : rawW
  // FXG.4-h-r1: macro automation child lanes shift later tracks down, so resolve
  // the track top through the layout when one is supplied (else contiguous).
  const top = (trackLayout && typeof trackLayout.trackTop === 'function')
    ? trackLayout.trackTop(trackIdx)
    : trackIdx * TRACK_HEIGHT
  const y = top + CLIP_PAD
  const h = TRACK_HEIGHT - 2 * CLIP_PAD
  return { x, y, w, h }
}

export function clipHasFxIntent(clip) {
  const m = clip?.modulation
  if (!m) return false
  return Boolean(
    (m.enabled && (m.vibrato?.enabled || m.scratch?.enabled)) ||
    m.video?.vibratoSwirlEnabled ||
    m.video?.scratchWaveEnabled
  )
}
