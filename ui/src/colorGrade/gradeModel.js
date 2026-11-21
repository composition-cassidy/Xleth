// Color Grade: the renderer's model of a grade (engine/src/model/ColorGrade.h).
//
// The same grade exists at four levels, always applied in this order:
//   Source -> Clip (a clip, or a sample on a Pattern Track) -> Layer -> Master
// A grade here is the engine's JSON shape, unchanged:
//   { bypassed, exposure, contrast, saturation, vibrance, temperature, tint, hue,
//     lift:{x,y,lum}, gamma:{x,y,lum}, gain:{x,y,lum},
//     curves:{ master:[[x,y]...], r, g, b },   // [] = the straight diagonal
//     lut:{ path, amount } }
//
// Pure functions only: nothing here talks to the engine or to React.

export const EXPOSURE_RANGE = 4      // stops, +/-
export const HUE_RANGE = 180         // degrees, +/-
export const MAX_CURVE_POINTS = 16
export const MIN_CURVE_GAP = 1 / 512

export const LEVELS = ['source', 'clip', 'region', 'layer', 'master']

// The order a picture passes through the levels. Clip and region are the same
// step (one instance): a clip on a Clip Track, a sample on a Pattern Track.
export const STACK_ORDER = ['source', 'clip', 'layer', 'master']

// Plain language for an editor, not a colourist (spec "UI intent").
export const LEVEL_INFO = {
  source: {
    name: 'Source',
    title: 'Source grade',
    blurb: 'Fixes the footage itself. Every clip and sample cut from this source gets it.',
  },
  clip: {
    name: 'Clip',
    title: 'Clip grade',
    blurb: 'Changes this one clip only, after its source grade.',
  },
  region: {
    name: 'Sample',
    title: 'Sample grade',
    blurb: 'Changes this sample wherever a pattern plays it, after its source grade.',
  },
  layer: {
    name: 'Layer',
    title: 'Layer grade',
    blurb: 'The look of this track\'s cell on the grid, whatever it is showing.',
  },
  master: {
    name: 'Master',
    title: 'Master grade',
    blurb: 'The finished picture: the whole frame, in the preview and in the export.',
  },
}

const NEUTRAL_WHEEL = Object.freeze({ x: 0, y: 0, lum: 0 })

export function neutralGrade() {
  return {
    bypassed: false,
    exposure: 0,
    contrast: 0,
    saturation: 0,
    vibrance: 0,
    temperature: 0,
    tint: 0,
    hue: 0,
    lift: { ...NEUTRAL_WHEEL },
    gamma: { ...NEUTRAL_WHEEL },
    gain: { ...NEUTRAL_WHEEL },
    curves: { master: [], r: [], g: [], b: [] },
    lut: { path: '', amount: 1 },
  }
}

const num = (v, fallback = 0) => (Number.isFinite(v) ? v : fallback)

function normalizeWheel(w) {
  return { x: num(w?.x), y: num(w?.y), lum: num(w?.lum) }
}

function normalizePoints(points) {
  if (!Array.isArray(points)) return []
  const out = []
  for (const p of points) {
    if (Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1])) out.push([p[0], p[1]])
    else if (p && Number.isFinite(p.x) && Number.isFinite(p.y)) out.push([p.x, p.y])
  }
  return out
}

/** Any engine or stored value -> a complete grade (missing fields are neutral). */
export function normalizeGrade(g) {
  const n = neutralGrade()
  if (!g || typeof g !== 'object') return n
  return {
    bypassed: g.bypassed === true,
    exposure: num(g.exposure),
    contrast: num(g.contrast),
    saturation: num(g.saturation),
    vibrance: num(g.vibrance),
    temperature: num(g.temperature),
    tint: num(g.tint),
    hue: num(g.hue),
    lift: normalizeWheel(g.lift),
    gamma: normalizeWheel(g.gamma),
    gain: normalizeWheel(g.gain),
    curves: {
      master: normalizePoints(g.curves?.master),
      r: normalizePoints(g.curves?.r),
      g: normalizePoints(g.curves?.g),
      b: normalizePoints(g.curves?.b),
    },
    lut: {
      path: typeof g.lut?.path === 'string' ? g.lut.path : '',
      amount: num(g.lut?.amount, 1),
    },
  }
}

export function cloneGrade(g) {
  return normalizeGrade(g)
}

/** A curve that changes nothing: no points, or exactly the diagonal. */
export function curveIsIdentity(points) {
  if (!Array.isArray(points) || points.length < 2) return true
  if (points.length !== 2) return false
  return points[0][0] === 0 && points[0][1] === 0 && points[1][0] === 1 && points[1][1] === 1
}

export const wheelIsNeutral = (w) => !w || (w.x === 0 && w.y === 0 && w.lum === 0)

const BASIC_KEYS = ['exposure', 'contrast', 'saturation', 'vibrance', 'temperature', 'tint', 'hue']
const WHEEL_KEYS = ['lift', 'gamma', 'gain']
const CURVE_KEYS = ['master', 'r', 'g', 'b']

export const basicsAreNeutral = (g) => BASIC_KEYS.every((k) => g[k] === 0)
export const wheelsAreNeutral = (g) => WHEEL_KEYS.every((k) => wheelIsNeutral(g[k]))
export const curvesAreNeutral = (g) => CURVE_KEYS.every((k) => curveIsIdentity(g.curves[k]))
export const lutIsOff = (g) => !g.lut.path || g.lut.amount <= 0

/** True when the VALUES change no pixel (the on/off switch is not a value). */
export function isNeutral(g) {
  return basicsAreNeutral(g) && wheelsAreNeutral(g) && curvesAreNeutral(g) && lutIsOff(g)
}

/** True when this grade is being rendered: switched on and not neutral. */
export const isActive = (g) => !g.bypassed && !isNeutral(g)

function pointsEqual(a, b) {
  const ia = curveIsIdentity(a)
  const ib = curveIsIdentity(b)
  if (ia || ib) return ia && ib
  if (a.length !== b.length) return false
  return a.every((p, i) => p[0] === b[i][0] && p[1] === b[i][1])
}

const wheelsEqual = (a, b) => a.x === b.x && a.y === b.y && a.lum === b.lum

export function gradesEqual(a, b) {
  if (!a || !b) return a === b
  return a.bypassed === b.bypassed
    && BASIC_KEYS.every((k) => a[k] === b[k])
    && WHEEL_KEYS.every((k) => wheelsEqual(a[k], b[k]))
    && CURVE_KEYS.every((k) => pointsEqual(a.curves[k], b.curves[k]))
    && a.lut.path === b.lut.path && a.lut.amount === b.lut.amount
}

// ── Resets ───────────────────────────────────────────────────────────────────
// Per section and whole grade (spec: reset per control, per section, whole
// grade; per control is Ctrl+click on the control itself). The on/off switch
// is not a value, so no reset touches it.

export const SECTIONS = ['basics', 'wheels', 'curves', 'lut']

export function resetSection(g, section) {
  const n = neutralGrade()
  const out = cloneGrade(g)
  if (section === 'basics') BASIC_KEYS.forEach((k) => { out[k] = 0 })
  else if (section === 'wheels') WHEEL_KEYS.forEach((k) => { out[k] = { ...n[k] } })
  else if (section === 'curves') out.curves = n.curves
  else if (section === 'lut') out.lut = n.lut
  return out
}

export function resetGrade(g) {
  return { ...neutralGrade(), bypassed: g?.bypassed === true }
}

export function sectionIsNeutral(g, section) {
  if (section === 'basics') return basicsAreNeutral(g)
  if (section === 'wheels') return wheelsAreNeutral(g)
  if (section === 'curves') return curvesAreNeutral(g)
  if (section === 'lut') return lutIsOff(g) && !g.lut.path
  return true
}

// ── Auto ─────────────────────────────────────────────────────────────────────
// The engine proposes a full-strength correction (lift / gamma / gain plus
// vibrance or saturation, see autoGradeFromAnalysis). The strength control
// blends it in. Mirrors applyAutoGrade in ColorGrade.cpp: only the controls
// Auto owns are touched; everything else in `base` is kept.

// "+ 0" turns a negative zero (any negative value at strength 0) into plain 0.
const round3 = (v) => Math.round(v * 1000) / 1000 + 0

export function applyAuto(base, autoFull, strength) {
  const s = Math.min(1, Math.max(0, Number.isFinite(strength) ? strength : 1))
  const out = cloneGrade(base)
  const a = normalizeGrade(autoFull)
  for (const k of WHEEL_KEYS) {
    out[k] = { x: round3(a[k].x * s), y: round3(a[k].y * s), lum: round3(a[k].lum * s) }
  }
  out.saturation = round3(a.saturation * s)
  out.vibrance = round3(a.vibrance * s)
  return out
}

/** Would Auto change anything at full strength? (Healthy footage: no.) */
export function autoIsNoOp(autoFull) {
  const a = normalizeGrade(autoFull)
  return wheelsAreNeutral(a) && a.saturation === 0 && a.vibrance === 0
}

// ── Targets ──────────────────────────────────────────────────────────────────

/** { level, id } -> a stable string key. Master has no id. */
export function targetKey(target) {
  if (!target?.level) return ''
  return target.level === 'master' ? 'master' : `${target.level}:${target.id}`
}

export function sameTarget(a, b) {
  return targetKey(a) === targetKey(b)
}

/** A short list of what a grade changes, for a summary line ("Exposure, Curves"). */
export function describeGrade(g) {
  const parts = []
  if (!basicsAreNeutral(g)) parts.push('Basics')
  if (!wheelsAreNeutral(g)) parts.push('Tonal balance')
  if (!curvesAreNeutral(g)) parts.push('Curves')
  if (!lutIsOff(g)) parts.push('LUT')
  return parts
}
