import { deduplicatePoints } from '../../stores/waveshaperStore.js'

// Pure maths for the Waveshaper's curve editor: the display curve through the control
// points (the editor's natural cubic spline, or straight segments), the zero snap
// and the neighbour clamp that keeps a dragged point from changing places with
// another. Points live in the engine's [-1, 1] space and keep the engine's JSON
// format; nothing here changes what is sent.

export const MAX_POINTS = 32
export const MIN_POINTS = 2
export const SNAP_THRESHOLD = 0.06
const SAMPLES = 200
const MIN_GAP = 1e-3

export const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v))

export function sortedPoints(points) {
  if (!points || points.length === 0) return []
  return deduplicatePoints([...points].sort((a, b) => a[0] - b[0]))
}

/** Natural cubic spline through the sorted points, `samples` + 1 [x, y] pairs. */
export function splineSamples(points, samples = SAMPLES) {
  const sorted = sortedPoints(points)
  const n = sorted.length
  if (n < 2) return []
  if (n === 2) return [sorted[0], sorted[1]]
  const xs = sorted.map((p) => p[0])
  const ys = sorted.map((p) => p[1])
  const h = []
  for (let i = 0; i < n - 1; i++) h.push(Math.max(1e-7, xs[i + 1] - xs[i]))
  const alpha = [0]
  for (let i = 1; i < n - 1; i++) {
    alpha.push((3 / h[i]) * (ys[i + 1] - ys[i]) - (3 / h[i - 1]) * (ys[i] - ys[i - 1]))
  }
  const l = [1]
  const mu = [0]
  const z = [0]
  for (let i = 1; i < n - 1; i++) {
    l.push(2 * (xs[i + 1] - xs[i - 1]) - h[i - 1] * mu[i - 1])
    mu.push(h[i] / l[i])
    z.push((alpha[i] - h[i - 1] * z[i - 1]) / l[i])
  }
  const c = new Array(n).fill(0)
  const b = new Array(n - 1).fill(0)
  const d = new Array(n - 1).fill(0)
  for (let j = n - 2; j >= 0; j--) {
    c[j] = z[j] - mu[j] * c[j + 1]
    b[j] = (ys[j + 1] - ys[j]) / h[j] - (h[j] * (c[j + 1] + 2 * c[j])) / 3
    d[j] = (c[j + 1] - c[j]) / (3 * h[j])
  }
  const out = []
  for (let i = 0; i <= samples; i++) {
    const x = xs[0] + (i / samples) * (xs[n - 1] - xs[0])
    let seg = 0
    for (let j = n - 2; j >= 0; j--) { if (x >= xs[j]) { seg = j; break } }
    const dx = x - xs[seg]
    out.push([x, clamp(ys[seg] + b[seg] * dx + c[seg] * dx * dx + d[seg] * dx * dx * dx, -1, 1)])
  }
  return out
}

/** The curve to draw: the spline, or straight segments between the points. */
export function curveSamples(points, smooth) {
  return smooth ? splineSamples(points) : sortedPoints(points)
}

/** Pull a coordinate onto 0 when it is within the snap threshold. */
export function applySnap(x, y, snapZero) {
  if (!snapZero) return [x, y]
  return [
    Math.abs(x) < SNAP_THRESHOLD ? 0 : x,
    Math.abs(y) < SNAP_THRESHOLD ? 0 : y,
  ]
}

/** An end point is the first or last by x; Lock ends keeps them where they are. */
export function isEndPoint(points, index) {
  if (!points[index]) return false
  const sorted = sortedPoints(points)
  const x = points[index][0]
  return x === sorted[0][0] || x === sorted[sorted.length - 1][0]
}

/**
 * Keep a dragged point between its neighbours, so dragging never changes the
 * order of the points (the index being dragged stays the same point). `points`
 * must be sorted by x.
 */
export function clampBetweenNeighbours(points, index, x) {
  const lo = index > 0 ? points[index - 1][0] + MIN_GAP : -1
  const hi = index < points.length - 1 ? points[index + 1][0] - MIN_GAP : 1
  return clamp(x, Math.min(lo, hi), Math.max(lo, hi))
}
