// Tone curve math for the Color Grade curves editor.
//
// evaluateCurve is the SAME function as xleth::grade::evaluateCurve in
// engine/src/model/ColorGrade.cpp (monotone cubic, Fritsch-Carlson), so the
// line the editor draws is the curve the engine bakes. curveMath.test.js pins
// the two to the same values.
//
// Points are [x, y] pairs in 0..1, sorted by x. Fewer than two points is the
// straight diagonal.

import { MAX_CURVE_POINTS, MIN_CURVE_GAP } from './gradeModel.js'

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v)

export function evaluateCurve(points, xIn) {
  const x = clamp01(xIn)
  const n = Array.isArray(points) ? points.length : 0
  if (n < 2) return x
  if (x <= points[0][0]) return clamp01(points[0][1])
  if (x >= points[n - 1][0]) return clamp01(points[n - 1][1])

  let lo = 0
  let hi = n - 1
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1
    if (points[mid][0] <= x) lo = mid
    else hi = mid
  }
  const k = lo

  const secant = (i) => (points[i + 1][1] - points[i][1]) / (points[i + 1][0] - points[i][0])
  // Zero at a local extremum, otherwise the weighted harmonic mean of the two
  // neighbouring slopes: the segment can then never overshoot its end points.
  const tangent = (i) => {
    if (i === 0) return secant(0)
    if (i === n - 1) return secant(n - 2)
    const d0 = secant(i - 1)
    const d1 = secant(i)
    if (d0 * d1 <= 0) return 0
    const h0 = points[i][0] - points[i - 1][0]
    const h1 = points[i + 1][0] - points[i][0]
    const w0 = 2 * h1 + h0
    const w1 = h1 + 2 * h0
    return (w0 + w1) / (w0 / d0 + w1 / d1)
  }

  const x0 = points[k][0]
  const x1 = points[k + 1][0]
  const y0 = points[k][1]
  const y1 = points[k + 1][1]
  const h = x1 - x0
  const t = (x - x0) / h
  const m0 = tangent(k)
  const m1 = tangent(k + 1)
  const t2 = t * t
  const t3 = t2 * t
  const y = (2 * t3 - 3 * t2 + 1) * y0
    + (t3 - 2 * t2 + t) * h * m0
    + (-2 * t3 + 3 * t2) * y1
    + (t3 - t2) * h * m1
  return clamp01(y)
}

/** The points an editor works on: an empty curve is shown as its two ends. */
export function editablePoints(points) {
  if (!Array.isArray(points) || points.length < 2) return [[0, 0], [1, 1]]
  return points.map((p) => [p[0], p[1]])
}

/** What gets stored: the plain diagonal is stored as no points at all. */
export function storedPoints(points) {
  if (!Array.isArray(points) || points.length < 2) return []
  if (points.length === 2
    && points[0][0] === 0 && points[0][1] === 0
    && points[1][0] === 1 && points[1][1] === 1) return []
  return points.map((p) => [p[0], p[1]])
}

/**
 * Add a point at (x, y). Returns { points, index }, or null when the curve is
 * full or the spot is already taken by a neighbour.
 */
export function addPoint(points, x, y) {
  const pts = editablePoints(points)
  if (pts.length >= MAX_CURVE_POINTS) return null
  const px = clamp01(x)
  const py = clamp01(y)
  let index = pts.findIndex((p) => p[0] > px)
  if (index < 0) index = pts.length
  const prev = pts[index - 1]
  const next = pts[index]
  if (prev && px - prev[0] < MIN_CURVE_GAP) return null
  if (next && next[0] - px < MIN_CURVE_GAP) return null
  pts.splice(index, 0, [px, py])
  return { points: pts, index }
}

/**
 * Move point `index` to (x, y). A point can never pass its neighbours, which
 * is what keeps the curve a function of x however it is dragged.
 */
export function movePoint(points, index, x, y) {
  const pts = editablePoints(points)
  if (index < 0 || index >= pts.length) return pts
  const lo = index > 0 ? pts[index - 1][0] + MIN_CURVE_GAP : 0
  const hi = index < pts.length - 1 ? pts[index + 1][0] - MIN_CURVE_GAP : 1
  pts[index] = [Math.min(hi, Math.max(lo, clamp01(x))), clamp01(y)]
  return pts
}

/** Remove a point. A curve always keeps its two ends. */
export function removePoint(points, index) {
  const pts = editablePoints(points)
  if (pts.length <= 2 || index < 0 || index >= pts.length) return pts
  pts.splice(index, 1)
  return pts
}

/** Index of the point within `radius` (in the same units as toPx output), or -1. */
export function hitTestPoint(points, px, py, toPx, radius) {
  let best = -1
  let bestD = radius * radius
  points.forEach((p, i) => {
    const [qx, qy] = toPx(p[0], p[1])
    const d = (qx - px) * (qx - px) + (qy - py) * (qy - py)
    if (d <= bestD) { bestD = d; best = i }
  })
  return best
}

/** `count` samples of the curve across 0..1, for drawing. */
export function sampleCurve(points, count = 128) {
  const out = new Array(count + 1)
  for (let i = 0; i <= count; i++) out[i] = evaluateCurve(points, i / count)
  return out
}
