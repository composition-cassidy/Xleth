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

// ── Phase C — point geometry, hit-testing and edit math ──────────────────────
// Everything below is pure and canvas-space only: the locked spec forbids DOM
// overlays on the timeline canvas (they drift under scroll/zoom and corrupt
// hit-testing), so points are hit-tested against the same numbers that drew
// them. `automationClipBodyRect` is the SINGLE definition of a clip's body and
// envelope-content bands — drawAutomationClips and the hit-tests both call it,
// so the drawn curve and the clickable curve can never disagree.

// Point hit radius in SCREEN pixels. Being a pixel radius is what makes the
// hit-test zoom-aware: the grab area stays the same size on screen no matter
// how many ticks a pixel is worth.
export const AUTOMATION_POINT_HIT_RADIUS_PX = 6
export const AUTOMATION_POINT_DRAW_RADIUS_PX = 2.2
// A double-click that lands within this many pixels of the drawn curve counts
// as "on the envelope" — anywhere else inside the clip body still adds a point
// at the clicked height, which is what FL does.
export const AUTOMATION_CLIP_HEADER_MAX_PX = 12

// The clip's body rect plus the envelope-content band inside it. Mirrors the
// header/padding math drawAutomationClips uses; both now read it from here.
export function automationClipBodyRect(clip, laneRow, pixelsPerBeat, scrollOffset, minWidthPx = 24) {
  if (!clip || !laneRow) return null
  const x = ((clip.positionTicks / PPQ) - scrollOffset) * pixelsPerBeat
  const w = Math.max(minWidthPx, (clip.durationTicks / PPQ) * pixelsPerBeat)
  const y = laneRow.y + AUTOMATION_CLIP_PAD
  const h = Math.max(1, laneRow.height - 2 * AUTOMATION_CLIP_PAD)
  const headerH = Math.min(AUTOMATION_CLIP_HEADER_MAX_PX, Math.max(0, h - 6))
  const contentTop = y + headerH + 1
  const contentHeight = Math.max(1, h - headerH - 3)
  return { x, y, w, h, headerH, contentTop, contentHeight }
}

// Envelope tick 0 in TIMELINE ticks. A point at intra-envelope tick t sits at
// `originTick + t`; the clip only SHOWS [offsetTicks, offsetTicks + duration).
export function automationEnvelopeOriginTick(clip) {
  return clip.positionTicks - (clip.offsetTicks ?? 0)
}

// Is this intra-envelope tick inside the window the clip displays?
export function isTickInsideClipWindow(clip, tick) {
  const offset = clip.offsetTicks ?? 0
  return tick >= offset && tick <= offset + clip.durationTicks
}

// Canvas x/y for one envelope point seen through one clip. Pure inverse of
// canvasPosToEnvelopePoint below.
export function envelopePointToCanvasPos(point, clip, laneRow, pixelsPerBeat, scrollOffset) {
  const body = automationClipBodyRect(clip, laneRow, pixelsPerBeat, scrollOffset)
  if (!body) return null
  const timelineTick = automationEnvelopeOriginTick(clip) + point.tick
  return {
    x: ((timelineTick / PPQ) - scrollOffset) * pixelsPerBeat,
    y: body.contentTop + (1 - clamp(point.value, 0, 1)) * body.contentHeight,
  }
}

// Canvas x/y → { tick, value }: tick is an INTRA-ENVELOPE tick clamped to the
// clip's visible window, value is normalized [0,1] with y inverted (top = 1).
// `snapTick` (optional) is applied in TIMELINE tick space so a snapped point
// lands on the same grid line the ruler draws, not on a clip-relative offset.
export function canvasPosToEnvelopePoint(localX, localY, clip, laneRow, pixelsPerBeat, scrollOffset, snapTick = null) {
  const body = automationClipBodyRect(clip, laneRow, pixelsPerBeat, scrollOffset)
  if (!body) return null
  let timelineTick = (localX / pixelsPerBeat + scrollOffset) * PPQ
  if (typeof snapTick === 'function') timelineTick = snapTick(timelineTick)
  const offset = clip.offsetTicks ?? 0
  const rawTick = Math.round(timelineTick - automationEnvelopeOriginTick(clip))
  const tick = Math.round(clamp(rawTick, offset, offset + clip.durationTicks))
  const value = clamp(1 - (localY - body.contentTop) / body.contentHeight, 0, 1)
  return { tick, value }
}

// Nearest envelope point within AUTOMATION_POINT_HIT_RADIUS_PX of (localX,
// localY), searched in SCREEN space so the grab area is zoom-independent.
// Returns { index, point, x, y, distance } — `index` indexes the SORTED point
// list, which is the same index the engine's point commands address because
// the engine keeps its own points sorted by the same key.
export function hitTestAutomationPoint(points, clip, laneRow, localX, localY, pixelsPerBeat, scrollOffset, radiusPx = AUTOMATION_POINT_HIT_RADIUS_PX) {
  const pts = sortedEnvelopePoints(points)
  if (pts.length === 0) return null
  const body = automationClipBodyRect(clip, laneRow, pixelsPerBeat, scrollOffset)
  if (!body) return null
  const originTick = automationEnvelopeOriginTick(clip)
  let best = null
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i]
    if (!isTickInsideClipWindow(clip, p.tick)) continue // not visible in this clip
    const x = ((originTick + p.tick) / PPQ - scrollOffset) * pixelsPerBeat
    const y = body.contentTop + (1 - p.value) * body.contentHeight
    const dx = localX - x
    const dy = localY - y
    const distance = Math.hypot(dx, dy)
    if (distance <= radiusPx && (best === null || distance < best.distance)) {
      best = { index: i, point: p, x, y, distance }
    }
  }
  return best
}

// Applies a pending point drag to a point list without mutating it — the LOCAL
// PREVIEW the canvas draws while the pointer is down. The single engine commit
// happens on mouseup; nothing here touches IPC.
//
// Moving a point past a neighbour re-sorts the list, so the committed index is
// re-derived from the reshaped list rather than assumed stable.
export function applyPointDragPreview(points, pointIndex, tick, value) {
  const pts = sortedEnvelopePoints(points)
  if (pointIndex < 0 || pointIndex >= pts.length) return pts
  const next = pts.map((p, i) => (i === pointIndex ? { ...p, tick, value: clamp(value, 0, 1) } : p))
  return next.sort((a, b) => a.tick - b.tick)
}
