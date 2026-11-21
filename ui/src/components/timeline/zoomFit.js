// Horizontal zoom-out limit + scroll bound for the Timeline (and its Video-tab
// mirror). Pure functions, so the two properties the viewport has to hold are
// directly testable:
//
//   1. Zoomed all the way out, the WHOLE song is on screen: the minimum zoom
//      is derived from the song's length and the canvas width, not a fixed
//      px/beat constant (the old fixed floor of 8 px/beat showed ~22 bars in a
//      700px panel, whatever the song's length).
//
//   2. The scroll bound is a continuous, non-decreasing function of zoom that
//      reaches exactly 0 at the minimum zoom. Near the minimum, the scrollable
//      room past the song shrinks smoothly to nothing. A zoom-out from anywhere
//      in the song then glides to the start, instead of the clamp yanking
//      scroll to 0 in the last frame. The bound never depends on a value that
//      zooming itself changes, such as the canvas width or the scrollbar's
//      presence, so the clamp and the fit cannot feed back into each other.

import { BEATS_PER_BAR, MAX_PPB, ticksToBeats } from '../../constants/timeline.js'

// Even an empty or very short project zooms out to at least this much, so a
// one-bar sketch isn't locked at a magnified "fit".
export const FIT_MIN_BEATS = 16 * BEATS_PER_BAR
// Breathing room past the last clip at the fit zoom, so the song's final clip
// doesn't sit flush against the canvas edge.
export const FIT_TAIL_FRACTION = 0.02
export const FIT_TAIL_MIN_BEATS = BEATS_PER_BAR
// Absolute zoom floor: only reached by a song of many thousands of bars.
export const ABS_MIN_PPB = 0.01
// The zoom range, as a ratio above the fit zoom, over which the scroll room
// past the song blends from none (at the fit) to the full workspace.
export const FIT_BLEND_RATIO = 4

/**
 * Last beat any timeline item reaches. Items use the engine's
 * {positionTicks, durationTicks} shape; `extraTicks` covers point-like items
 * (the Video tab's cues) that have a tick but no duration.
 */
export function contentEndBeats(lists = [], extraTicks = []) {
  let endTicks = 0
  for (const list of lists) {
    if (!list) continue
    for (const item of list) {
      const end = (item?.positionTicks ?? 0) + (item?.durationTicks ?? 0)
      if (end > endTicks) endTicks = end
    }
  }
  for (const t of extraTicks) if (t > endTicks) endTicks = t
  return ticksToBeats(endTicks)
}

/** Beats the fully-zoomed-out view spans: the song plus a small tail. */
export function fitBeatsFor(contentEnd) {
  const end = Number.isFinite(contentEnd) && contentEnd > 0 ? contentEnd : 0
  const tail = Math.max(FIT_TAIL_MIN_BEATS, end * FIT_TAIL_FRACTION)
  return Math.max(FIT_MIN_BEATS, end + tail)
}

/** The px/beat at which `fitBeats` exactly fills `canvasWidth`. */
export function minPpbFor(canvasWidth, fitBeats) {
  if (!(canvasWidth > 0) || !(fitBeats > 0)) return ABS_MIN_PPB
  return Math.min(MAX_PPB, Math.max(ABS_MIN_PPB, canvasWidth / fitBeats))
}

/**
 * Horizontal scroll bound (in beats) at zoom `ppb`.
 *
 * Zoomed well in (≥ FIT_BLEND_RATIO × minPpb), this is the full workspace:
 * `workspaceBeats - visibleBeats`, the same bound as before this module. At
 * `minPpb` it is 0. In between, the room past the song (workspace minus fit)
 * is blended in by log-zoom, so the bound is continuous in `ppb`.
 */
export function maxScrollFor({ ppb, canvasWidth, workspaceBeats, fitBeats, minPpb }) {
  if (!(ppb > 0) || !(canvasWidth > 0)) return 0
  const visible = canvasWidth / ppb
  const fit = fitBeats > 0 ? fitBeats : visible
  const workspace = Math.max(fit, workspaceBeats || 0)
  const floor = minPpb > 0 ? minPpb : ppb
  const t = Math.min(1, Math.max(0, Math.log(ppb / floor) / Math.log(FIT_BLEND_RATIO)))
  return Math.max(0, (fit - visible) + (workspace - fit) * t)
}

/**
 * Normalises one wheel event into a zoom exponent for `ZOOM_FACTOR ** n`.
 * n is positive to zoom in and negative to zoom out.
 *
 * A mouse notch (|deltaY| ≥ 100 px, or any line/page-mode event) is exactly
 * one step, as before. A touchpad or precision wheel sends many small deltas
 * per gesture, and each one now counts only as its share of a notch. Before,
 * every one of those events was a full 1.15× step, so a single pinch or
 * flick could race dozens of steps, and a gesture ending with tiny deltas of
 * the opposite sign bounced the zoom in and out at the limit.
 */
export function wheelZoomSteps(deltaY, deltaMode = 0) {
  if (!Number.isFinite(deltaY) || deltaY === 0) return 0
  const px = deltaMode === 0 ? deltaY : Math.sign(deltaY) * 100
  return -Math.max(-1, Math.min(1, px / 100))
}
