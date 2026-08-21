// Shared math for the Zoom/Pan/Rot keyframe timeline (P1 of the keyframe
// editor). Mirrors engine/src/util/ParamTrackEase.h and
// engine/src/model/ParamTrack.cpp::evaluate exactly so the local preview
// during a drag matches what the engine will render on commit — keep the
// two in sync if either changes.

export const clamp01 = (x) => Math.max(0, Math.min(1, x))

// ── exp2 / log2 — zoom's canonical interpolation space (see ZprTracks in
// engine/src/model/TimelineTypes.h: zoomLog2 is log2 of the linear factor) ──
export const exp2 = (x) => Math.pow(2, x)
export const log2 = (x) => Math.log2(x)

// ── Cubic-bezier evaluator, CSS semantics, fixed (0,0)/(1,1) endpoints ─────
function bernsteinCubic(c1, c2, s) {
  const A = 1 + 3 * c1 - 3 * c2
  const B = 3 * c2 - 6 * c1
  const C = 3 * c1
  return ((A * s + B) * s + C) * s
}

function bernsteinCubicSlope(c1, c2, s) {
  const A = 1 + 3 * c1 - 3 * c2
  const B = 3 * c2 - 6 * c1
  const C = 3 * c1
  return (3 * A * s + 2 * B) * s + C
}

const FAST_P1X = 1 / 3
const FAST_P2X = 2 / 3
const FAST_EPS = 1e-9

function isIdentityInX(p1x, p2x) {
  return Math.abs(p1x - FAST_P1X) < FAST_EPS && Math.abs(p2x - FAST_P2X) < FAST_EPS
}

function solveCurveX(p1x, p2x, x) {
  let t = x
  for (let i = 0; i < 8; i++) {
    const err = bernsteinCubic(p1x, p2x, t) - x
    if (Math.abs(err) < 1e-7) return t
    const d = bernsteinCubicSlope(p1x, p2x, t)
    if (Math.abs(d) < 1e-12) break
    const next = t - err / d
    if (!(next >= 0 && next <= 1)) break
    t = next
  }
  let lo = 0, hi = 1
  t = x
  for (let i = 0; i < 64; i++) {
    t = 0.5 * (lo + hi)
    const err = bernsteinCubic(p1x, p2x, t) - x
    if (Math.abs(err) < 1e-7) return t
    if (err > 0) hi = t; else lo = t
    if (hi - lo < 1e-7) break
  }
  return t
}

// p1x/p2x clamped to [0,1] (required for a monotonic x->t solve); p1y/p2y
// deliberately UNCLAMPED — overshoot/anticipation curves live outside [0,1].
export function paramTrackEase(p1x, p1y, p2x, p2y, x) {
  p1x = clamp01(p1x)
  p2x = clamp01(p2x)
  if (x <= 0) return 0
  if (x >= 1) return 1
  if (isIdentityInX(p1x, p2x)) return bernsteinCubic(p1y, p2y, x)
  return bernsteinCubic(p1y, p2y, solveCurveX(p1x, p2x, x))
}

export const IDENTITY_CURVE = [1 / 3, 1 / 3, 2 / 3, 2 / 3]

// ── ParamTrack evaluation — mirrors ParamTrack.cpp::evaluate exactly ───────
// track shape: { constantValue, keys: [{ t, v, c:[p1x,p1y,p2x,p2y] }] }
export function evaluateTrack(track, normalizedTime) {
  const keys = track?.keys || []
  if (keys.length === 0) return track?.constantValue ?? 0
  if (normalizedTime <= keys[0].t) return keys[0].v
  if (normalizedTime >= keys[keys.length - 1].t) return keys[keys.length - 1].v

  let i = 0
  while (i + 1 < keys.length && keys[i + 1].t <= normalizedTime) i++
  if (i + 1 >= keys.length) return keys[keys.length - 1].v

  const a = keys[i], b = keys[i + 1]
  const span = b.t - a.t
  if (span <= 0) return b.v
  const x = (normalizedTime - a.t) / span
  const c = a.c || IDENTITY_CURVE
  const e = paramTrackEase(c[0], c[1], c[2], c[3], x)
  return a.v + (b.v - a.v) * e
}

// ── Keyframe CRUD — maintains sort-by-t, mirrors ParamTrack.h semantics ────
export function emptyTrack(constantValue = 0) {
  return { constantValue, keys: [] }
}

export function trackAnimated(track) {
  return !!track?.keys?.length
}

// Inserts (or replaces, if t matches an existing key within epsilon) and
// returns a NEW track object + the index the key landed at.
export function insertKeyframe(track, key) {
  const keys = (track?.keys || []).slice()
  const eps = 1e-9
  const existingIndex = keys.findIndex(k => Math.abs(k.t - key.t) < eps)
  if (existingIndex >= 0) {
    keys[existingIndex] = { ...keys[existingIndex], ...key }
  } else {
    keys.push(key)
    keys.sort((a, b) => a.t - b.t)
  }
  return { ...track, keys }
}

export function removeKeyframe(track, index) {
  const keys = (track?.keys || []).slice()
  if (index < 0 || index >= keys.length) return track
  keys.splice(index, 1)
  return { ...track, keys }
}

export function moveKeyframe(track, index, newT) {
  const keys = (track?.keys || []).slice()
  if (index < 0 || index >= keys.length) return track
  const key = { ...keys[index], t: clamp01(newT) }
  keys.splice(index, 1)
  let insertAt = keys.findIndex(k => k.t > key.t)
  if (insertAt < 0) insertAt = keys.length
  keys.splice(insertAt, 0, key)
  return { ...track, keys }
}

export function setKeyframeValue(track, index, value) {
  const keys = (track?.keys || []).slice()
  if (index < 0 || index >= keys.length) return track
  keys[index] = { ...keys[index], v: value }
  return { ...track, keys }
}

export function setKeyframeCurve(track, index, curve) {
  const keys = (track?.keys || []).slice()
  if (index < 0 || index >= keys.length) return track
  keys[index] = { ...keys[index], c: curve.slice() }
  return { ...track, keys }
}

// ── Bezier presets ───────────────────────────────────────────────────────
// Linear and Back-out come from the approved legacy-migration table
// (engine/src/model/ParamTrack.h) — p1x/p2x = 1/3, 2/3 exactly. Back-out's
// p1y is a LIVE drag target (overshoot), not a fixed value; the chip just
// seeds the same default as the old overshoot slider (1.70158 -> p1y
// (s+3)/3). The other six are not part of that table (it only covers the
// legacy migration, not new hand-authored curves) — standard, documented
// easing constants, called out here so they're easy to correct later.
export const BEZIER_PRESETS = [
  { name: 'Linear',   curve: [1 / 3, 1 / 3, 2 / 3, 2 / 3] },
  { name: 'Smooth',   curve: [0.42, 0, 0.58, 1] },        // CSS ease-in-out
  { name: 'Sharp',    curve: [0.9, 0.05, 0.1, 0.95] },    // steep S-curve
  { name: 'Fast',     curve: [0.42, 0, 1, 1] },           // CSS ease-in (accelerates)
  { name: 'Slow',     curve: [0, 0, 0.58, 1] },           // CSS ease-out (decelerates)
  { name: 'Hold',     curve: [1, 0, 1, 0] },              // flat, snaps at the very end
  { name: 'Back out', curve: [1 / 3, (1.70158 + 3) / 3, 2 / 3, 1] },
  // Not truly representable as ONE cubic segment (same reason Elastic/Spring
  // fall back to Linear in the legacy table) — single-hump overshoot
  // approximation, not a real multi-bounce.
  { name: 'Bounce out', curve: [0.175, 0.885, 0.32, 1.275] },
]

export function curveMatchesPreset(curve, preset, eps = 1e-3) {
  if (!curve || curve.length !== 4) return false
  return curve.every((v, i) => Math.abs(v - preset[i]) < eps)
}

// ── Musical length resolution ───────────────────────────────────────────
// index -> beats. 1 bar = 4 beats (4/4 assumed, matching the rest of the
// timeline's bar math elsewhere in this codebase).
export const MUSICAL_DIVISIONS = [
  { label: '1/32',   beats: 1 / 8 },
  { label: '1/16',   beats: 1 / 4 },
  { label: '1/8',    beats: 1 / 2 },
  { label: '1/4',    beats: 1 },
  { label: '1/2',    beats: 2 },
  { label: '1 bar',  beats: 4 },
  { label: '2 bars', beats: 8 },
]

export function musicalDivisionToMs(index, bpm) {
  const safeBpm = Number.isFinite(bpm) && bpm > 0 ? bpm : 120
  const div = MUSICAL_DIVISIONS[index] ?? MUSICAL_DIVISIONS[2]
  return (60000 / safeBpm) * div.beats
}

// Resolves a ZoomPanRotSettings-shaped object's configured length to a
// concrete ms value for display/preview. Note mode needs the triggering
// note's gate length, which isn't known outside note-trigger context — the
// caller passes it in when available (falls back to durationMs otherwise).
export function resolveLengthMs(zpr, bpm, noteGateLengthMs) {
  const mode = zpr?.lengthMode ?? 1
  if (mode === 0) return zpr?.durationMs ?? 300
  if (mode === 2) {
    const gate = Number.isFinite(noteGateLengthMs) ? noteGateLengthMs : (zpr?.durationMs ?? 300)
    const pct = zpr?.notePercentage ?? 100
    return gate * (pct / 100)
  }
  return musicalDivisionToMs(zpr?.musicalDivision ?? 2, bpm)
}

// ── Ramer-Douglas-Peucker keyframe thinning (real-time recording) ──────────
// Points are { t, v } in the same normalized-window / canonical-value space
// evaluateTrack already reads. Standard RDP: keep the point with the largest
// perpendicular distance from the chord between the two ends; recurse on both
// sides if it clears the tolerance, otherwise collapse the whole run to just
// the two ends.

function perpendicularDistance(pt, a, b) {
  const dx = b.t - a.t
  const dy = b.v - a.v
  const len = Math.hypot(dx, dy)
  if (len < 1e-12) return Math.hypot(pt.t - a.t, pt.v - a.v)
  return Math.abs(dy * pt.t - dx * pt.v + b.t * a.v - b.v * a.t) / len
}

export function rdpSimplify(points, tolerance) {
  if (points.length < 3) return points.slice()
  const a = points[0]
  const b = points[points.length - 1]
  let maxDist = 0
  let index = 0
  for (let i = 1; i < points.length - 1; i++) {
    const d = perpendicularDistance(points[i], a, b)
    if (d > maxDist) { maxDist = d; index = i }
  }
  if (maxDist > tolerance) {
    const left = rdpSimplify(points.slice(0, index + 1), tolerance)
    const right = rdpSimplify(points.slice(index), tolerance)
    return left.slice(0, -1).concat(right)
  }
  return [a, b]
}

// A recorded gesture mixes channels of very different scale (panX ~0.1-0.4,
// zoomLog2 ~0-2, rotationDeg in whole degrees) — one raw tolerance number
// would over-simplify large-scale channels and under-simplify small-scale
// ones. Expressing tolerance as a FRACTION of the channel's own recorded
// peak-to-peak range makes a single user-facing knob apply evenly across all
// four. A channel with no real range at all (never moved) collapses straight
// to its two endpoints regardless of tolerance.
export function rdpSimplifyNormalized(points, toleranceFraction) {
  if (points.length < 3) return points.slice()
  let minV = points[0].v
  let maxV = points[0].v
  for (const p of points) {
    if (p.v < minV) minV = p.v
    if (p.v > maxV) maxV = p.v
  }
  const range = maxV - minV
  if (range < 1e-9) return [points[0], points[points.length - 1]]
  return rdpSimplify(points, toleranceFraction * range)
}

export function formatMs(ms) {
  if (!Number.isFinite(ms)) return '—'
  return ms >= 1000 ? `${(ms / 1000).toFixed(2)}s` : `${Math.round(ms)} ms`
}
