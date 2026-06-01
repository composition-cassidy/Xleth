// FXG.4-h-r1 — Pure geometry for the macro automation child-lane DOM layer.
//
// The lane layer is rendered in the DOM (not on the timeline canvas) so points
// can be individually draggable handles, but it must stay numerically aligned
// with the canvas: clips use the same `(tick/PPQ - scrollOffset) * pixelsPerBeat`
// horizontal math the canvas uses for audio clips. These helpers are PURE so the
// move/resize/point math is unit-testable without a DOM.

import { PPQ, snapBeatToGrid } from '../../constants/timeline.js'

// Vertical inset of the curve drawing area inside a lane row, leaving room for
// the clip border / handles top and bottom.
export const LANE_CONTENT_PAD = 5

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v
}

// Horizontal pixel rect of a clip within the lane, in canvas viewport space.
export function clipPixelRect(clip, pixelsPerBeat, scrollOffset) {
  const left = (clip.startTick / PPQ - scrollOffset) * pixelsPerBeat
  const width = Math.max(2, (clip.lengthTicks / PPQ) * pixelsPerBeat)
  return { left, width }
}

// Convert a horizontal pixel delta to a tick delta at the current zoom.
export function pxDeltaToTickDelta(dxPx, pixelsPerBeat) {
  if (!Number.isFinite(pixelsPerBeat) || pixelsPerBeat <= 0) return 0
  return Math.round((dxPx / pixelsPerBeat) * PPQ)
}

// Snap a tick value to the active grid (round-to-nearest), honouring modifier
// overrides (alt = free, shift = 1/32, ctrl = 1/8) exactly like the canvas tools.
export function snapTick(tick, modifiers = {}, granularity = '1/16') {
  if (modifiers.alt) return Math.max(0, Math.round(tick))
  const beat = snapBeatToGrid(tick / PPQ, modifiers, granularity)
  return Math.max(0, Math.round(beat * PPQ))
}

// A clip's new startTick when moved by a pixel delta, snapped, clamped to >= 0.
export function moveStartTick(origStartTick, dxPx, pixelsPerBeat, modifiers, granularity) {
  const delta = pxDeltaToTickDelta(dxPx, pixelsPerBeat)
  return snapTick(origStartTick + delta, modifiers, granularity)
}

// Map an absolute viewport X to a clip-local tick (0..lengthTicks), used when
// adding/moving points. Result is clamped to the clip bounds.
export function xToClipLocalTick(xPx, clip, pixelsPerBeat, scrollOffset) {
  const globalBeat = xPx / pixelsPerBeat + scrollOffset
  const localTick = Math.round(globalBeat * PPQ - clip.startTick)
  return clamp(localTick, 0, clip.lengthTicks)
}

// Map a Y within the lane content band to a normalized value (0..1). Y grows
// downward, value grows upward, so value = 1 at the top of the content band.
export function yToValue(yPx, contentTop, contentHeight) {
  if (contentHeight <= 0) return 0
  const frac = (yPx - contentTop) / contentHeight
  return clamp(1 - frac, 0, 1)
}

// Map a normalized value (0..1) to a Y within the lane content band.
export function valueToY(value, contentTop, contentHeight) {
  return contentTop + (1 - clamp(value, 0, 1)) * contentHeight
}

// Map a clip-local tick to a viewport X.
export function clipLocalTickToX(localTick, clip, pixelsPerBeat, scrollOffset) {
  const globalBeat = (clip.startTick + localTick) / PPQ
  return (globalBeat - scrollOffset) * pixelsPerBeat
}

// Build an SVG polyline points string for a clip's curve within a lane row.
// `points` are clip-local {tick, value}. Coordinates are LANE-LOCAL (relative to
// the clip's own left edge / lane content band) so the <svg> can sit inside the
// clip element.
export function buildCurvePoints(points, clip, pixelsPerBeat, contentTop, contentHeight) {
  if (!Array.isArray(points) || points.length === 0) return ''
  const pxPerTick = (pixelsPerBeat / PPQ)
  return points
    .map((p) => {
      const x = p.tick * pxPerTick
      const y = contentTop + (1 - clamp(p.value, 0, 1)) * contentHeight
      return `${x.toFixed(2)},${y.toFixed(2)}`
    })
    .join(' ')
}
