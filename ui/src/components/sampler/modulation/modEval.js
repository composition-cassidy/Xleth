// Faithful JS port of the engine's modulation shape/curve evaluation
// (engine/src/audio/SamplerModulation.h). The editors draw with these so the
// preview a user edits is EXACTLY what the audio thread renders — no second,
// drifting definition of the shape.
//
// The one deliberate omission is SMOOTH in the shape editor: the canvas draws
// the raw piecewise shape (smooth = 0) because that is the editable data. The
// SMOOTH knob's effect is a global morph applied at playback; showing it in the
// editor would move the curve out from under the points the user is dragging.

import { SEG_STEP, SEG_CURVE } from './modConstants.js'

// t^(2^(-2·tension)): 0 = linear, positive covers most of the range early.
export function shapeTension(t, tension) {
  if (Math.abs(tension) < 0.001) return t
  const exponent = Math.pow(2, -tension * 2)
  return Math.pow(Math.max(0, t), exponent)
}

export function smoothStep01(f) {
  if (f <= 0) return 0
  if (f >= 1) return 1
  return f * f * (3 - 2 * f)
}

// One segment's interpolation fraction. `smooth` is 0..1 (0..100 in config).
export function lfoSegmentFraction(f, segment, tension, smooth = 0) {
  f = Math.max(0, Math.min(1, f))
  smooth = Math.max(0, Math.min(1, smooth))
  if (segment === SEG_STEP) {
    if (smooth <= 1e-6) return 0
    const knee = 1 - smooth
    if (f <= knee) return 0
    return smoothStep01((f - knee) / smooth)
  }
  const shaped = segment === SEG_CURVE ? shapeTension(f, tension) : f
  if (smooth <= 1e-6) return shaped
  return shaped + (smoothStep01(f) - shaped) * smooth
}

// Evaluate one cycle of an LFO shape at phase in [0,1]. `points` is the wire
// array [{t,v,seg,tension}], assumed sorted by t. numPoints 0 = sine, 1 = const.
export function evalLfoShape(points, phase, smooth = 0) {
  const n = Array.isArray(points) ? points.length : 0
  if (n === 0) return Math.sin(phase * Math.PI * 2)
  if (n === 1) return points[0].v
  phase = Math.max(0, Math.min(1, phase))

  let i = -1
  for (let k = 0; k < n; k++) {
    if (points[k].t <= phase) i = k
    else break
  }

  let t0, v0, t1, v1, seg, tension
  if (i < 0) {
    const last = points[n - 1], first = points[0]
    t0 = last.t - 1; v0 = last.v; t1 = first.t; v1 = first.v
    seg = last.seg; tension = last.tension
  } else if (i === n - 1) {
    const last = points[n - 1], first = points[0]
    t0 = last.t; v0 = last.v; t1 = first.t + 1; v1 = first.v
    seg = last.seg; tension = last.tension
  } else {
    const a = points[i], b = points[i + 1]
    t0 = a.t; v0 = a.v; t1 = b.t; v1 = b.v
    seg = a.seg; tension = a.tension
  }

  const span = t1 - t0
  const f = span > 1e-9 ? (phase - t0) / span : 0
  return v0 + (v1 - v0) * lfoSegmentFraction(f, seg ?? 1, tension ?? 0, smooth)
}

// VELO / NOTE response curve. `points` is [{x,y,tension}] sorted by x.
// Fewer than two points = identity, matching the engine.
export function evalModCurve(points, x) {
  const n = Array.isArray(points) ? points.length : 0
  if (n === 0) return Math.max(0, Math.min(1, x))
  if (n === 1) return points[0].y
  x = Math.max(0, Math.min(1, x))
  if (x <= points[0].x) return points[0].y
  if (x >= points[n - 1].x) return points[n - 1].y
  for (let k = 0; k + 1 < n; k++) {
    const a = points[k], b = points[k + 1]
    if (x > b.x) continue
    const span = b.x - a.x
    if (span < 1e-9) return a.y
    const f = (x - a.x) / span
    return a.y + (b.y - a.y) * shapeTension(f, a.tension ?? 0)
  }
  return points[n - 1].y
}
