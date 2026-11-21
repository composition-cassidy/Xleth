// Shared breakpoint-curve math — pure, DOM-free, React-free.
//
// This is the geometry + hit-testing + list-mutation core behind every
// breakpoint editor in XLETH. It was extracted rather than copied: the codebase
// already carried two independent implementations of the same arithmetic
// (ui/src/components/sampler/modulation/ModShapeCanvas.jsx and
// ui/src/windowing/panels/fxgraph/LfoEditor.tsx), and the per-clip Vibrato
// editor would have made three. Anything a feature can share lives here; the
// feature-specific parts (which curve evaluator to draw, how a point object is
// shaped, what the axes are labelled) arrive through an ADAPTER.
//
// The adapter is the seam:
//   read(point)        -> { t, v }   normalized breakpoint (t in tDomain, v in vDomain)
//   write(point, {t,v}) -> point     a NEW point carrying the moved coordinates
//   create({ t, v })   -> point      a brand-new point for an insert
//
// So the Sampler's `{ t, v, seg, tension }` and the engine's Vibrato
// `{ time, value }` are both drivable without either feature knowing about the
// other's schema.
//
// Being pure keeps it unit-testable without jsdom, canvas, or a ThemeProvider.

// ── Adapters ────────────────────────────────────────────────────────────────

// Default adapter for `{ t, v }` points (the Sampler LFO shape).
export const TV_ADAPTER = {
  read: (p) => ({ t: p.t, v: p.v }),
  write: (p, { t, v }) => ({ ...p, t, v }),
  create: ({ t, v }) => ({ t, v }),
}

// Adapter for the engine's SampleRegion::LfoBreakpoint `{ time, value }`,
// which is what ClipModulation::Vibrato::customShape serializes as.
export const TIME_VALUE_ADAPTER = {
  read: (p) => ({ t: p.time, v: p.value }),
  write: (p, { t, v }) => ({ ...p, time: t, value: v }),
  create: ({ t, v }) => ({ time: t, value: v }),
}

// ── Geometry ────────────────────────────────────────────────────────────────

export const DEFAULT_PAD = { left: 0, right: 0, top: 8, bottom: 8 }

// Build the bidirectional mapping between curve space (t, v) and canvas pixels.
// `pad` insets the plot area so handles at the extremes are not clipped in half
// by the canvas edge, and leaves room for axis labels.
export function makeGeometry({
  width,
  height,
  pad = DEFAULT_PAD,
  tMin = 0,
  tMax = 1,
  vMin = -1,
  vMax = 1,
} = {}) {
  const left = pad.left ?? 0
  const right = pad.right ?? 0
  const top = pad.top ?? 0
  const bottom = pad.bottom ?? 0

  const plotW = Math.max(1, width - left - right)
  const plotH = Math.max(1, height - top - bottom)
  const tSpan = tMax - tMin || 1
  const vSpan = vMax - vMin || 1

  const clamp = (x, lo, hi) => (x < lo ? lo : x > hi ? hi : x)

  return {
    left, right, top, bottom, plotW, plotH,
    tMin, tMax, vMin, vMax,
    plotRight: left + plotW,
    plotBottom: top + plotH,

    // curve space -> pixels
    xOf: (t) => left + ((t - tMin) / tSpan) * plotW,
    yOf: (v) => top + (1 - (v - vMin) / vSpan) * plotH,

    // pixels -> curve space (always clamped back into the domain)
    tOf: (px) => clamp(tMin + ((px - left) / plotW) * tSpan, tMin, tMax),
    vOf: (py) => clamp(vMax - ((py - top) / plotH) * vSpan, vMin, vMax),
  }
}

// ── Hit testing ─────────────────────────────────────────────────────────────

// Index of the point whose handle is under (mx, my), or -1. Searches back to
// front so the most recently drawn (topmost) handle wins an overlap, and
// returns the NEAREST candidate rather than the first within radius.
export function hitTestPoints(points, adapter, geo, mx, my, radius = 11) {
  if (!Array.isArray(points)) return -1
  let best = -1
  let bestDist = radius
  for (let i = points.length - 1; i >= 0; i--) {
    const { t, v } = adapter.read(points[i])
    const d = Math.hypot(mx - geo.xOf(t), my - geo.yOf(v))
    if (d <= bestDist) { bestDist = d; best = i }
  }
  return best
}

// ── List mutations ──────────────────────────────────────────────────────────

// Move point `idx` to (t, v), keeping the list sorted by t WITHOUT reordering:
// t is clamped between its neighbours so indices stay stable for the whole
// drag gesture. `lockEndpoints` pins the first/last point's t to the domain
// edges (a one-cycle LFO shape must start at 0 and end at 1).
export function movePoint(points, adapter, idx, t, v, {
  minGap = 1e-4,
  lockEndpoints = false,
  precision = 4,
} = {}) {
  if (!Array.isArray(points) || idx < 0 || idx >= points.length) return points
  const round = (x) => Number(x.toFixed(precision))

  const isFirst = idx === 0
  const isLast = idx === points.length - 1

  let nextT
  if (lockEndpoints && isFirst) nextT = adapter.read(points[0]).t
  else if (lockEndpoints && isLast) nextT = adapter.read(points[points.length - 1]).t
  else {
    const lo = isFirst ? -Infinity : adapter.read(points[idx - 1]).t + minGap
    const hi = isLast ? Infinity : adapter.read(points[idx + 1]).t - minGap
    // A crowded neighbourhood can invert the bounds; collapse to the midpoint
    // rather than letting the point jump past a neighbour.
    nextT = lo > hi ? (lo + hi) / 2 : Math.max(lo, Math.min(hi, t))
  }

  const out = points.slice()
  out[idx] = adapter.write(points[idx], { t: round(nextT), v: round(v) })
  return out
}

// Insert a new point at (t, v), returning the new list and the new point's
// index. Refuses past `maxPoints`. The list stays sorted by t.
export function insertPoint(points, adapter, t, v, { maxPoints = 64, precision = 4 } = {}) {
  const list = Array.isArray(points) ? points : []
  if (list.length >= maxPoints) return { points: list, index: -1 }
  const round = (x) => Number(x.toFixed(precision))
  const nt = round(t)
  const created = adapter.create({ t: nt, v: round(v) })

  let index = list.length
  for (let i = 0; i < list.length; i++) {
    if (adapter.read(list[i]).t > nt) { index = i; break }
  }
  const out = list.slice()
  out.splice(index, 0, created)
  return { points: out, index }
}

// Remove point `idx`, refusing to go below `minPoints`. Returns null when the
// removal is refused so callers can distinguish "no-op" from "new list".
export function removePoint(points, idx, { minPoints = 2 } = {}) {
  if (!Array.isArray(points)) return null
  if (idx < 0 || idx >= points.length) return null
  if (points.length <= minPoints) return null
  return points.filter((_, i) => i !== idx)
}

// ── Evaluation ──────────────────────────────────────────────────────────────

// Linear interpolation through a breakpoint table.
//
// This is a faithful port of the engine's evaluateCustomShape()
// (engine/src/model/ClipModulationEvaluator.cpp) — INCLUDING its edge cases:
// empty => 0, single point => that value, out-of-range clamps to the terminal
// breakpoint, and a zero-width span resolves to the left value. The editor must
// draw exactly what the audio thread will play, so this function has no licence
// to be "better" than the engine's.
export function evaluateLinearBreakpoints(points, adapter, p) {
  if (!Array.isArray(points) || points.length === 0) return 0
  if (points.length === 1) return adapter.read(points[0]).v

  const first = adapter.read(points[0])
  const last = adapter.read(points[points.length - 1])
  if (p <= first.t) return first.v
  if (p >= last.t) return last.v

  for (let i = 0; i + 1 < points.length; i++) {
    const a = adapter.read(points[i])
    const b = adapter.read(points[i + 1])
    if (p >= a.t && p <= b.t) {
      const span = b.t - a.t
      if (span <= 0) return a.v
      return a.v + ((p - a.t) / span) * (b.v - a.v)
    }
  }
  return last.v
}
