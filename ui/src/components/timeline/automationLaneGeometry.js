// Phase B — pure geometry/sampling helpers for automation clips. Mirrors the
// discipline of macroLaneGeometry.js (pure, unit-testable, no DOM) but for the
// CANVAS-drawn automation clip layer: no point editing in this phase (Phase C),
// so there is no per-point hit-testing here — only clip-level move/trim and
// envelope value sampling for the dotted hold-line.
//
// Field names verified end-to-end against the running RPC bridge (not just
// the engine's file-persistence JSON, which uses different short keys):
// AutomationClip → { id, laneId, envelopeId, positionTicks, durationTicks,
// offsetTicks }; AutomationPoint → { tick, value, curveType, tension }.

import { PPQ } from '../../constants/timeline.js'

export const AUTOMATION_CLIP_PAD = 2
export const AUTOMATION_RESIZE_HIT_WIDTH_PX = 6
export const AUTOMATION_MIN_DURATION_TICKS = 120 // 1/32 note, matches selectTool's pattern/clip floor

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v
}

// Pixel rect (canvas viewport space) for an automation clip, given the lane
// row's own y/height from trackLayout.getAutomationLaneRows().
export function automationClipPixelRect(clip, laneRow, pixelsPerBeat, scrollOffset, minWidthPx = 24) {
  if (!clip || !laneRow) return null
  const x = ((clip.positionTicks / PPQ) - scrollOffset) * pixelsPerBeat
  const rawW = (clip.durationTicks / PPQ) * pixelsPerBeat
  const w = Math.max(minWidthPx, rawW)
  const y = laneRow.y + AUTOMATION_CLIP_PAD
  const h = Math.max(1, laneRow.height - 2 * AUTOMATION_CLIP_PAD)
  return { x, y, w, h }
}

export function isOnAutomationClipRightEdge(localX, positionTicks, durationTicks, pixelsPerBeat, scrollOffset, hitWidth = AUTOMATION_RESIZE_HIT_WIDTH_PX) {
  const endBeat = (positionTicks + durationTicks) / PPQ
  const rightEdgePx = (endBeat - scrollOffset) * pixelsPerBeat
  return Math.abs(localX - rightEdgePx) <= hitWidth
}

export function isOnAutomationClipLeftEdge(localX, positionTicks, pixelsPerBeat, scrollOffset, hitWidth = AUTOMATION_RESIZE_HIT_WIDTH_PX) {
  const startBeat = positionTicks / PPQ
  const leftEdgePx = (startBeat - scrollOffset) * pixelsPerBeat
  return Math.abs(localX - leftEdgePx) <= hitWidth
}

// Sorted, value-clamped envelope points — same discipline as the engine's
// insert-sorted invariant, defensive against any out-of-order/malformed data.
export function sortedEnvelopePoints(points) {
  if (!Array.isArray(points)) return []
  return points
    .filter((p) => Number.isFinite(p?.tick) && Number.isFinite(p?.value))
    .map((p) => ({ tick: Math.max(0, Math.round(p.tick)), value: clamp(p.value, 0, 1) }))
    .sort((a, b) => a.tick - b.tick)
}

// Linear-interpolated envelope value at an intra-envelope tick (holds the
// first point's value before it, the last point's value after it — same
// semantics as the engine's evaluation core and paramtrack's hold-after-last).
export function sampleEnvelopeValueAtTick(points, tick) {
  const pts = sortedEnvelopePoints(points)
  if (pts.length === 0) return 0
  if (pts.length === 1) return pts[0].value
  if (tick <= pts[0].tick) return pts[0].value
  const last = pts[pts.length - 1]
  if (tick >= last.tick) return last.value
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i]
    const b = pts[i + 1]
    if (tick >= a.tick && tick <= b.tick) {
      const span = b.tick - a.tick
      const frac = span <= 0 ? 0 : (tick - a.tick) / span
      return clamp(a.value + frac * (b.value - a.value), 0, 1)
    }
  }
  return last.value
}

// Build the canvas polyline points (absolute viewport pixel space, clipped to
// the clip's visible window by the caller via ctx.clip()) for an envelope's
// points as seen through one clip's [offsetTicks, offsetTicks+durationTicks)
// window. Envelope tick 0 sits at `clip.positionTicks - clip.offsetTicks` on
// the timeline (originTick), so a point at intra-envelope tick `t` sits at
// timeline tick `clip.positionTicks - clip.offsetTicks + t`.
export function buildAutomationCurveCanvasPoints(points, clip, pixelsPerBeat, scrollOffset, contentTop, contentHeight) {
  const pts = sortedEnvelopePoints(points)
  if (pts.length === 0) return []
  const originTick = clip.positionTicks - (clip.offsetTicks ?? 0)
  return pts.map((p) => {
    const timelineTick = originTick + p.tick
    const x = ((timelineTick / PPQ) - scrollOffset) * pixelsPerBeat
    const y = contentTop + (1 - p.value) * contentHeight
    return { x, y }
  })
}

// The dotted hold-line: from the last point's timeline position (or the clip
// start if the envelope has no points before the clip's visible window) to the
// clip's right edge, at the held value — FL-parity indication that the
// parameter holds past the last point.
export function buildAutomationHoldLine(points, clip, pixelsPerBeat, scrollOffset, contentTop, contentHeight) {
  const pts = sortedEnvelopePoints(points)
  if (pts.length === 0) return null
  const offsetTicks = clip.offsetTicks ?? 0
  const windowEndTick = offsetTicks + clip.durationTicks
  const last = pts[pts.length - 1]
  // Nothing to hold if the last point already sits at/after the clip's right edge.
  if (last.tick >= windowEndTick) return null
  const originTick = clip.positionTicks - offsetTicks
  const startX = ((originTick + last.tick) / PPQ - scrollOffset) * pixelsPerBeat
  const endX = ((originTick + windowEndTick) / PPQ - scrollOffset) * pixelsPerBeat
  const y = contentTop + (1 - last.value) * contentHeight
  return { x1: startX, x2: endX, y }
}
