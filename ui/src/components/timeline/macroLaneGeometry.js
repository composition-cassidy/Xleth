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
export const AUTOMATION_POINT_HIT_RADIUS_PX = 10
export const AUTOMATION_SEGMENT_HIT_RADIUS_PX = 8
export const AUTOMATION_RESIZE_HIT_WIDTH_PX = 6

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v
}

function finiteInt(value, fallback = 0) {
  if (!Number.isFinite(value)) return fallback
  return Math.round(value)
}

function positiveInt(value, fallback = 1) {
  const int = finiteInt(value, fallback)
  return int < 1 ? 1 : int
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
export function snapTickToTimelineGrid(tick, snapSetting = '1/16', ppq = PPQ, modifiers = {}) {
  const safePpq = Number.isFinite(ppq) && ppq > 0 ? ppq : PPQ
  const safeTick = finiteInt(tick, 0)
  if (modifiers?.alt) return Math.max(0, safeTick)
  const beat = snapBeatToGrid(safeTick / safePpq, modifiers, snapSetting)
  return Math.max(0, Math.round(beat * safePpq))
}

export function snapClipStartTick(
  startTick,
  modifiers = {},
  snapSetting = '1/16',
  minStartTick = 0,
  maxStartTick = Number.POSITIVE_INFINITY,
  ppq = PPQ,
) {
  const minTick = Math.max(0, finiteInt(minStartTick, 0))
  const maxTick = Number.isFinite(maxStartTick)
    ? Math.max(minTick, finiteInt(maxStartTick, minTick))
    : Number.POSITIVE_INFINITY
  return clamp(snapTickToTimelineGrid(startTick, snapSetting, ppq, modifiers), minTick, maxTick)
}

export function snapClipEndTick(
  endTick,
  startTick = 0,
  minLengthTicks = 1,
  modifiers = {},
  snapSetting = '1/16',
  maxEndTick = Number.POSITIVE_INFINITY,
  ppq = PPQ,
) {
  const start = Math.max(0, finiteInt(startTick, 0))
  const minEnd = start + positiveInt(minLengthTicks, 1)
  const maxTick = Number.isFinite(maxEndTick)
    ? Math.max(minEnd, finiteInt(maxEndTick, minEnd))
    : Number.POSITIVE_INFINITY
  return clamp(snapTickToTimelineGrid(endTick, snapSetting, ppq, modifiers), minEnd, maxTick)
}

export function snapAutomationPointTick(
  localTick,
  clip,
  modifiers = {},
  snapSetting = '1/16',
  ppq = PPQ,
  bounds = {},
) {
  const startTick = Math.max(0, finiteInt(clip?.startTick, 0))
  const lengthTicks = Math.max(0, finiteInt(clip?.lengthTicks, 0))
  const minTick = Math.min(lengthTicks, Math.max(0, finiteInt(bounds.minTick, 0)))
  const maxCandidate = Number.isFinite(bounds.maxTick)
    ? finiteInt(bounds.maxTick, lengthTicks)
    : lengthTicks
  const maxTick = Math.max(minTick, Math.min(lengthTicks, maxCandidate))
  const absoluteTick = startTick + finiteInt(localTick, 0)
  const snappedAbsoluteTick = snapTickToTimelineGrid(absoluteTick, snapSetting, ppq, modifiers)
  return clamp(snappedAbsoluteTick - startTick, minTick, maxTick)
}

export function snapTick(tick, modifiers = {}, granularity = '1/16') {
  return snapTickToTimelineGrid(tick, granularity, PPQ, modifiers)
}

// A clip's new startTick when moved by a pixel delta, snapped, clamped to >= 0.
export function moveStartTick(origStartTick, dxPx, pixelsPerBeat, modifiers, granularity) {
  const delta = pxDeltaToTickDelta(dxPx, pixelsPerBeat)
  return snapClipStartTick(origStartTick + delta, modifiers, granularity)
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

function automationPointToPixel(point, pixelsPerBeat, contentTop, contentHeight) {
  return {
    x: (finiteInt(point.tick, 0) / PPQ) * pixelsPerBeat,
    y: valueToY(point.value, contentTop, contentHeight),
  }
}

function emptyAutomationTarget(laneId = null) {
  return { kind: 'none', laneId, cursor: 'default' }
}

function distanceSq(a, b) {
  const dx = a.x - b.x
  const dy = a.y - b.y
  return dx * dx + dy * dy
}

function distanceToSegmentSq(point, a, b) {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const lenSq = dx * dx + dy * dy
  if (lenSq <= 0) return distanceSq(point, a)
  const t = clamp(((point.x - a.x) * dx + (point.y - a.y) * dy) / lenSq, 0, 1)
  const projected = { x: a.x + t * dx, y: a.y + t * dy }
  return distanceSq(point, projected)
}

export function findAutomationPointHit({
  clip,
  pointX,
  pointY,
  pixelsPerBeat,
  contentTop,
  contentHeight,
  hitRadius = AUTOMATION_POINT_HIT_RADIUS_PX,
  laneId = null,
} = {}) {
  const points = Array.isArray(clip?.points) ? clip.points : []
  if (!Number.isFinite(pointX) || !Number.isFinite(pointY) || points.length === 0) {
    return emptyAutomationTarget(laneId)
  }

  const pointer = { x: pointX, y: pointY }
  const radiusSq = hitRadius * hitRadius
  let best = null
  for (let pointIndex = 0; pointIndex < points.length; pointIndex += 1) {
    const point = points[pointIndex]
    if (!Number.isFinite(point?.tick) || !Number.isFinite(point?.value)) continue
    const px = automationPointToPixel(point, pixelsPerBeat, contentTop, contentHeight)
    const d = distanceSq(pointer, px)
    if (d <= radiusSq && (!best || d < best.distanceSq)) {
      best = { pointIndex, distanceSq: d }
    }
  }
  if (!best) return emptyAutomationTarget(laneId)
  return {
    kind: 'point',
    clipId: clip.clipId,
    laneId,
    pointIndex: best.pointIndex,
    cursor: 'move',
  }
}

export function findAutomationSegmentHit({
  clip,
  pointX,
  pointY,
  pixelsPerBeat,
  contentTop,
  contentHeight,
  hitRadius = AUTOMATION_SEGMENT_HIT_RADIUS_PX,
  laneId = null,
} = {}) {
  const points = Array.isArray(clip?.points) ? clip.points : []
  if (!Number.isFinite(pointX) || !Number.isFinite(pointY) || points.length < 2) {
    return emptyAutomationTarget(laneId)
  }

  const pointer = { x: pointX, y: pointY }
  const radiusSq = hitRadius * hitRadius
  let best = null
  for (let segmentIndex = 0; segmentIndex < points.length - 1; segmentIndex += 1) {
    const a = points[segmentIndex]
    const b = points[segmentIndex + 1]
    if (
      !Number.isFinite(a?.tick) ||
      !Number.isFinite(a?.value) ||
      !Number.isFinite(b?.tick) ||
      !Number.isFinite(b?.value)
    ) {
      continue
    }
    const pa = automationPointToPixel(a, pixelsPerBeat, contentTop, contentHeight)
    const pb = automationPointToPixel(b, pixelsPerBeat, contentTop, contentHeight)
    const d = distanceToSegmentSq(pointer, pa, pb)
    if (d <= radiusSq && (!best || d < best.distanceSq)) {
      best = { segmentIndex, distanceSq: d }
    }
  }
  if (!best) return emptyAutomationTarget(laneId)
  return {
    kind: 'segment',
    clipId: clip.clipId,
    laneId,
    segmentIndex: best.segmentIndex,
    cursor: 'crosshair',
  }
}

export function hitTestMacroAutomationClip({
  clip,
  laneId = null,
  pointX,
  pointY,
  pixelsPerBeat,
  contentTop,
  contentHeight,
  clipHeight = Number.POSITIVE_INFINITY,
  pointHitRadius = AUTOMATION_POINT_HIT_RADIUS_PX,
  segmentHitRadius = AUTOMATION_SEGMENT_HIT_RADIUS_PX,
  resizeHitWidth = AUTOMATION_RESIZE_HIT_WIDTH_PX,
} = {}) {
  if (!clip || !Number.isFinite(pointX) || !Number.isFinite(pointY)) {
    return emptyAutomationTarget(laneId)
  }

  const pointTarget = findAutomationPointHit({
    clip,
    laneId,
    pointX,
    pointY,
    pixelsPerBeat,
    contentTop,
    contentHeight,
    hitRadius: pointHitRadius,
  })
  if (pointTarget.kind !== 'none') return pointTarget

  const segmentTarget = findAutomationSegmentHit({
    clip,
    laneId,
    pointX,
    pointY,
    pixelsPerBeat,
    contentTop,
    contentHeight,
    hitRadius: segmentHitRadius,
  })
  if (segmentTarget.kind !== 'none') return segmentTarget

  const clipWidth = Math.max(2, (positiveInt(clip.lengthTicks, 1) / PPQ) * pixelsPerBeat)
  const insideClipBody =
    pointX >= 0 &&
    pointX <= clipWidth &&
    pointY >= 0 &&
    pointY <= clipHeight

  if (!insideClipBody) return emptyAutomationTarget(laneId)

  if (pointX <= resizeHitWidth) {
    return { kind: 'resize-start', clipId: clip.clipId, laneId, cursor: 'ew-resize' }
  }
  if (pointX >= clipWidth - resizeHitWidth) {
    return { kind: 'resize-end', clipId: clip.clipId, laneId, cursor: 'ew-resize' }
  }
  return { kind: 'clip-body', clipId: clip.clipId, laneId, cursor: 'grab' }
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

export function buildSegmentLinePoints(points, segmentIndex, pixelsPerBeat, contentTop, contentHeight) {
  if (!Array.isArray(points) || segmentIndex < 0 || segmentIndex >= points.length - 1) return ''
  const a = points[segmentIndex]
  const b = points[segmentIndex + 1]
  if (
    !Number.isFinite(a?.tick) ||
    !Number.isFinite(a?.value) ||
    !Number.isFinite(b?.tick) ||
    !Number.isFinite(b?.value)
  ) {
    return ''
  }
  const pa = automationPointToPixel(a, pixelsPerBeat, contentTop, contentHeight)
  const pb = automationPointToPixel(b, pixelsPerBeat, contentTop, contentHeight)
  return `${pa.x.toFixed(2)},${pa.y.toFixed(2)} ${pb.x.toFixed(2)},${pb.y.toFixed(2)}`
}

function sortedPoints(points) {
  if (!Array.isArray(points)) return []
  return points
    .filter((p) => Number.isFinite(p?.tick) && Number.isFinite(p?.value))
    .map((p) => ({ tick: Math.max(0, finiteInt(p.tick, 0)), value: clamp(p.value, 0, 1) }))
    .sort((a, b) => a.tick - b.tick)
}

function sampleLinearPointValue(points, localTick) {
  const pts = sortedPoints(points)
  if (pts.length === 0) return 0
  if (pts.length === 1) return pts[0].value
  if (localTick <= pts[0].tick) return pts[0].value
  const last = pts[pts.length - 1]
  if (localTick >= last.tick) return last.value
  for (let i = 0; i < pts.length - 1; i += 1) {
    const a = pts[i]
    const b = pts[i + 1]
    if (localTick >= a.tick && localTick <= b.tick) {
      const span = b.tick - a.tick
      const t = span <= 0 ? 0 : (localTick - a.tick) / span
      return clamp(a.value + t * (b.value - a.value), 0, 1)
    }
  }
  return last.value
}

export function buildLoopGhostCurveSegments(points, clip, pixelsPerBeat, contentTop, contentHeight) {
  const pts = sortedPoints(points)
  if (!clip?.loopEnabled || pts.length < 2) return []
  const firstTick = pts[0].tick
  const lastTick = pts[pts.length - 1].tick
  const loopLengthTicks = lastTick - firstTick
  const clipLengthTicks = Math.max(0, finiteInt(clip.lengthTicks, 0))
  if (loopLengthTicks <= 0 || firstTick + loopLengthTicks >= clipLengthTicks) return []

  const segments = []
  for (let offset = loopLengthTicks; firstTick + offset < clipLengthTicks; offset += loopLengthTicks) {
    const repeated = pts
      .map((p) => ({ tick: p.tick + offset, value: p.value }))
      .filter((p) => p.tick >= 0 && p.tick <= clipLengthTicks)

    const repeatEnd = lastTick + offset
    if (repeatEnd > clipLengthTicks) {
      repeated.push({
        tick: clipLengthTicks,
        value: sampleLinearPointValue(pts, clipLengthTicks - offset),
      })
    }

    const deduped = []
    for (const point of repeated.sort((a, b) => a.tick - b.tick)) {
      const last = deduped[deduped.length - 1]
      if (last && last.tick === point.tick) {
        deduped[deduped.length - 1] = point
      } else {
        deduped.push(point)
      }
    }
    if (deduped.length >= 2) {
      segments.push(buildCurvePoints(deduped, clip, pixelsPerBeat, contentTop, contentHeight))
    }
  }
  return segments
}

export function buildLoopRepeatDividers(points, clip, pixelsPerBeat) {
  const pts = sortedPoints(points)
  if (!clip?.loopEnabled || pts.length < 2) return []
  const firstTick = pts[0].tick
  const lastTick = pts[pts.length - 1].tick
  const loopLengthTicks = lastTick - firstTick
  const clipLengthTicks = Math.max(0, finiteInt(clip.lengthTicks, 0))
  if (loopLengthTicks <= 0) return []

  const dividers = []
  for (let tick = firstTick + loopLengthTicks; tick < clipLengthTicks; tick += loopLengthTicks) {
    dividers.push((tick / PPQ) * pixelsPerBeat)
  }
  return dividers
}
