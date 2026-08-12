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

// ── Envelope shape (read-only preview) ───────────────────────────────────────
// A DAHDSR trace normalised to a 0..1 timeline, with a fixed "held sustain"
// segment so the preview reads like the classic envelope diagram. Times are
// seconds (already resolved from ms or BPM by the caller); tensions match the
// engine's per-segment shapeTension.
export function buildEnvelopePath(env, { sustainHoldFrac = 0.18 } = {}) {
  const d = Math.max(0, env.delaySec || 0)
  const a = Math.max(0, env.attackSec || 0)
  const h = Math.max(0, env.holdSec || 0)
  const dec = Math.max(0, env.decaySec || 0)
  const r = Math.max(0, env.releaseSec || 0)
  const sus = Math.max(0, Math.min(1, env.sustain ?? 1))

  // Total timeline: the active stages plus a fixed sustain-hold window so a
  // zero-release patch still shows the sustain plateau.
  const active = d + a + h + dec + r
  const total = active + (active > 0 ? active * sustainHoldFrac : 1) || 1

  const susHold = active > 0 ? active * sustainHoldFrac : total
  const pts = []
  const push = (tSec, level) => pts.push({ x: tSec / total, y: level })

  let t = 0
  push(t, 0)                        // delay floor
  t += d; push(t, 0)
  // attack 0→1
  if (a > 0) {
    const steps = 24
    for (let i = 1; i <= steps; i++) {
      const f = i / steps
      pts.push({ x: (t + a * f) / total, y: shapeTension(f, env.attackTension || 0) })
    }
    t += a
  } else { push(t, 1) }
  t += h; push(t, 1)                 // hold at peak
  // decay 1→sustain
  if (dec > 0) {
    const steps = 24
    for (let i = 1; i <= steps; i++) {
      const f = i / steps
      pts.push({ x: (t + dec * f) / total, y: 1 - (1 - sus) * shapeTension(f, env.decayTension || 0) })
    }
    t += dec
  } else { push(t, sus) }
  t += susHold; push(t, sus)         // sustain plateau
  // release sustain→0
  if (r > 0) {
    const steps = 24
    for (let i = 1; i <= steps; i++) {
      const f = i / steps
      pts.push({ x: (t + r * f) / total, y: sus * (1 - shapeTension(f, env.releaseTension || 0)) })
    }
    t += r
  } else { push(t, 0) }
  return pts
}
