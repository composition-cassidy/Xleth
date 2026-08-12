// Coordinate math + parameter tables for the APEX editor.
//
// Two canvas surfaces share this module:
//   • the curve editor — both axes span [CURVE_MIN_DB, CURVE_MAX_DB] on a
//     LEVEL-PROPORTIONAL scale (see levelNorm), and evalCurveAt / tensionWarp
//     are exact JS ports of the engine LUT builder (ApexDsp.h evalCurveDb /
//     tensionWarp) so the drawn curve matches the gain the audio thread
//     actually applies.
//   • the analysis display — log-frequency X, dB Y, driven by the viz spectrum.
//
// No CSS token lookups happen here; colors are the drawing components' concern.

import { CURVE_MIN_DB, CURVE_MAX_DB, MAX_NODES } from '../../stores/apexStore.js'

export { CURVE_MIN_DB, CURVE_MAX_DB, MAX_NODES }

// FFT geometry (engine DynamicsVizFrame.h): 2048-point real FFT → 1024 bins.
export const FFT_SIZE = 2048
export const SPECTRUM_BINS = FFT_SIZE / 2
export const ANALYSIS_FREQ_MIN = 20
export const ANALYSIS_DB_MIN = -96
export const ANALYSIS_DB_MAX = 6

export const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v))

// ── Curve math (mirror of ApexDsp.h) ─────────────────────────────────────────

// Corner rounding window, as a fraction of the shorter adjacent segment.
// Must equal kCornerRound.
export const CORNER_ROUND = 0.28

// Per-segment tension warp. t is the normalised position inside a segment;
// tension -1..+1 with 0 == linear. Exact port of engine tensionWarp — a cubic
// Hermite whose END SLOPES carry the tension:
//   tension  0 -> slopes 1, 1   (straight)
//   tension +1 -> slopes 3, 0   (soft knee: fast then flat)
//   tension -1 -> slopes 0, 3   (hard knee: flat then fast)
export function warpEndSlopes(tension) {
  const tau = clamp(tension, -1, 1)
  return {
    s0: tau >= 0 ? 1 + 2 * tau : 1 + tau,
    s1: tau >= 0 ? 1 - tau : 1 - 2 * tau,
  }
}

export function tensionWarp(t, tension) {
  if (tension > -1e-4 && tension < 1e-4) return t
  const { s0, s1 } = warpEndSlopes(tension)
  const a = s0 + s1 - 2
  const b = 3 - 2 * s0 - s1
  return ((a * t + b) * t + s0) * t
}

function segAt(nodes, tensions, seg, inDb) {
  const a = nodes[seg]
  const b = nodes[seg + 1]
  const w = b.in - a.in
  const t = w > 1e-6 ? (inDb - a.in) / w : 0
  return a.out + (b.out - a.out) * tensionWarp(t, tensions?.[seg] ?? 0)
}

// Segment slope (dOut/dIn) at an arbitrary point inside the segment — the warp
// is a cubic, so its derivative is exact. It must be taken AT THE WINDOW EDGE
// (not at the node) or the fillet joins a tensioned segment with a slope step.
function segSlope(nodes, tensions, seg, inDb) {
  const a = nodes[seg]
  const b = nodes[seg + 1]
  const w = b.in - a.in
  if (w <= 1e-6) return 0
  const { s0, s1 } = warpEndSlopes(tensions?.[seg] ?? 0)
  const ca = s0 + s1 - 2
  const cb = 3 - 2 * s0 - s1
  const t = clamp((inDb - a.in) / w, 0, 1)
  const dw = (3 * ca * t + 2 * cb) * t + s0
  return ((b.out - a.out) / w) * dw
}

// Half-width of the fillet window centred on interior node i, in dB.
function cornerRadius(nodes, i) {
  if (i <= 0 || i >= nodes.length - 1) return 0
  const lenL = nodes[i].in - nodes[i - 1].in
  const lenR = nodes[i + 1].in - nodes[i].in
  return CORNER_ROUND * Math.max(0, Math.min(lenL, lenR))
}

// Fillet across interior node i (port of engine filletDb): a cubic Hermite over
// [x_i - r, x_i + r] pinned to the adjacent segments' values AND slopes at the
// window edges, so the curve is C1 everywhere. It cuts the corner rather than
// passing through it — a cross-fade of two segments that agree at the node
// cannot do that, and would push a "1:1 then flat" limiter shape above its own
// authored ceiling on the way in.
function filletAt(nodes, tensions, i, r, inDb) {
  const x0 = nodes[i].in - r
  const x2 = nodes[i].in + r
  const span = x2 - x0
  const y0 = segAt(nodes, tensions, i - 1, x0)
  const y1 = segAt(nodes, tensions, i, x2)
  const m0 = segSlope(nodes, tensions, i - 1, x0) * span
  const m1 = segSlope(nodes, tensions, i, x2) * span
  const u = clamp((inDb - x0) / span, 0, 1)
  const u2 = u * u
  const u3 = u2 * u
  return (2 * u3 - 3 * u2 + 1) * y0
    + (u3 - 2 * u2 + u) * m0
    + (-2 * u3 + 3 * u2) * y1
    + (u3 - u2) * m1
}

// Evaluate the compiled transfer curve at an input level (dB) → output (dB).
// Segments are exact away from the nodes; around each interior node the corner
// is replaced by the fillet above. Outside the authored domain the endpoint
// GAIN is held (unity slope), matching the engine so silence is never amplified
// and hot signal gets no extra makeup.
export function evalCurveAt(curve, inDb) {
  const nodes = curve?.nodes
  if (!Array.isArray(nodes) || nodes.length < 2) return inDb   // unity gain
  const tensions = curve.tensions
  const first = nodes[0]
  const last = nodes[nodes.length - 1]
  if (inDb <= first.in) return inDb + (first.out - first.in)
  if (inDb >= last.in) return inDb + (last.out - last.in)

  let seg = 0
  while (seg < nodes.length - 2 && inDb > nodes[seg + 1].in) seg++

  const rL = cornerRadius(nodes, seg)
  if (rL > 0 && inDb < nodes[seg].in + rL) return filletAt(nodes, tensions, seg, rL, inDb)

  const rR = cornerRadius(nodes, seg + 1)
  if (rR > 0 && inDb > nodes[seg + 1].in - rR) return filletAt(nodes, tensions, seg + 1, rR, inDb)

  return segAt(nodes, tensions, seg, inDb)
}

// ── Curve editor ↔ canvas mapping ─────────────────────────────────────────────
// plot = { x, y, w, h } in CSS pixels. Both axes span the same box and use the
// same mapping, so unity (out == in) is always the box diagonal.
//
// The mapping is LEVEL-proportional, not dB-proportional: position is
// amplitude^AXIS_GAMMA rescaled to 0..1. Amplitude is 0 at silence, so
// CURVE_MIN_DB lands exactly on the edge and the axis genuinely reaches -inf —
// the same reason Maximus plots its curve on an amplitude axis. AXIS_GAMMA
// pulls the quiet half back out again (a raw amplitude axis would bunch
// everything below -12 dB into the first 6 % of the width): at 0.4 the ladder
// is 0 dB @ 57 %, -12 @ 33 %, -24 @ 18 %, -48 @ 9 %, -72 @ 3 %, silence @ 0.
export const AXIS_GAMMA = 0.4

const levelOf = db => Math.pow(10, (AXIS_GAMMA * db) / 20)
const LVL_MIN = levelOf(CURVE_MIN_DB)
const LVL_MAX = levelOf(CURVE_MAX_DB)

// dB → 0..1 across the box (0 == silence edge, 1 == CURVE_MAX_DB).
export function levelNorm(db) {
  return clamp((levelOf(db) - LVL_MIN) / (LVL_MAX - LVL_MIN), 0, 1)
}
// Inverse of levelNorm.
export function normLevel(t) {
  const lvl = clamp(t, 0, 1) * (LVL_MAX - LVL_MIN) + LVL_MIN
  return (20 / AXIS_GAMMA) * Math.log10(Math.max(lvl, 1e-12))
}

export function inDbToX(inDb, plot) {
  return plot.x + levelNorm(inDb) * plot.w
}
export function xToInDb(px, plot) {
  return normLevel((px - plot.x) / plot.w)
}
export function outDbToY(outDb, plot) {
  // y inverted: higher out = higher on screen
  return plot.y + (1 - levelNorm(outDb)) * plot.h
}
export function yToOutDb(py, plot) {
  return normLevel(1 - (py - plot.y) / plot.h)
}

// Grid ticks for the curve box. Chosen for the level-proportional axis: dense
// where the axis is (near 0 dB), sparse down in the tail. The silence edge is
// labelled separately by the editor.
export const CURVE_DB_TICKS = [12, 6, 0, -6, -12, -18, -24, -36, -48, -72]

// Label priority, most useful first. The editor places labels in this order and
// drops one that would collide with an already-placed label, so a cramped box
// keeps 0 / -12 / -24 rather than whatever happened to come last.
export const CURVE_LABEL_ORDER = [0, -12, 12, -24, -6, -48, 6, -18, -36, -72]

// The visual position of a segment's tension handle: the midpoint input of the
// segment, evaluated on the live curve so the handle rides the drawn line.
// The midpoint is always outside both corner-rounding windows (CORNER_ROUND is
// < 0.5), so the handle sits on the segment's own shape — which is what makes
// the drag inversion in ApexCurveEditor exact.
export function segmentHandlePoint(curve, seg, plot) {
  const a = curve.nodes[seg]
  const b = curve.nodes[seg + 1]
  const midIn = (a.in + b.in) / 2
  const outAtMid = evalCurveAt(curve, midIn)
  return { x: inDbToX(midIn, plot), y: outDbToY(outAtMid, plot), inDb: midIn }
}

// Inverse of the tension warp at a segment's midpoint: w(0.5) = 0.5 + 0.375*tau
// for every tension (both branches give s0 - s1 == 3*tau), so a drag can solve
// for the tension that puts the midpoint under the cursor in closed form.
export const MID_WARP_GAIN = 0.375
export function tensionForMidpoint(fraction) {
  return clamp((fraction - 0.5) / MID_WARP_GAIN, -1, 1)
}

// ── Analysis display mapping ──────────────────────────────────────────────────

export function freqToX(freq, plot, nyquist) {
  const fMin = ANALYSIS_FREQ_MIN
  const fMax = Math.max(fMin * 2, nyquist)
  const t = (Math.log(clamp(freq, fMin, fMax)) - Math.log(fMin)) / (Math.log(fMax) - Math.log(fMin))
  return plot.x + t * plot.w
}
export function analysisDbToY(db, plot) {
  const t = (clamp(db, ANALYSIS_DB_MIN, ANALYSIS_DB_MAX) - ANALYSIS_DB_MIN)
    / (ANALYSIS_DB_MAX - ANALYSIS_DB_MIN)
  return plot.y + (1 - t) * plot.h
}

// Frequency of spectrum bin i for a given sample rate.
export function binToFreq(i, sampleRate) {
  return (i * sampleRate) / FFT_SIZE
}

// ── Formatters ────────────────────────────────────────────────────────────────

export const fmtDb = v => `${v >= 0 ? '+' : ''}${v.toFixed(1)} dB`
export const fmtHz = v => (v >= 1000
  ? `${(v / 1000).toFixed(2).replace(/\.?0+$/, '')} kHz`
  : `${Math.round(v)} Hz`)
export const fmtMs = v => (v < 10 ? `${v.toFixed(1)} ms` : `${Math.round(v)} ms`)
export const fmtPctBipolar = v => `${v > 0 ? '+' : ''}${Math.round(v)} %`
export const fmtPct = v => `${Math.round(v)} %`

// ── Parameter tables ──────────────────────────────────────────────────────────
// skew values mirror the engine NormalisableRange::setSkewForCentre choices in
// XlethApexEffect::createLayout so knob travel matches the parameter curve.

// Per-band knob suffixes (full id = BAND_PREFIX[band] + suffix). Order = layout.
export const BAND_KNOBS = [
  { suffix: 'pre',   label: 'PRE GAIN',   min: -24, max: 24,  default: 0,   fmt: fmtDb },
  { suffix: 'post',  label: 'POST GAIN',  min: -24, max: 24,  default: 0,   fmt: fmtDb },
  { suffix: 'att',   label: 'ATT',        min: 0.1, max: 100, default: 5,   skew: 0.23, fmt: fmtMs },
  { suffix: 'rel',   label: 'REL',        min: 5,   max: 500, default: 100, skew: 0.42, fmt: fmtMs },
  { suffix: 'sus',   label: 'SUSTAIN',    min: 0,   max: 500, default: 0,   fmt: fmtMs },
  { suffix: 'satth', label: 'SAT THRESH', min: -100, max: 100, default: 0,  bipolar: true, fmt: fmtPctBipolar },
  { suffix: 'satcl', label: 'SAT CEIL',   min: -60, max: 0,   default: 0,   fmt: fmtDb },
  { suffix: 'sep',   label: 'STEREO SEP', min: -100, max: 100, default: 0,  bipolar: true, fmt: fmtPctBipolar },
]

// Right-panel global knobs (full id == the id field).
export const GLOBAL_KNOBS = {
  lookahead: { id: 'lookahead', label: 'LOOKAHEAD', min: 0, max: 20,  default: 0,   fmt: fmtMs },
  bandmix:   { id: 'bandmix',   label: 'BAND MIX',  min: 0, max: 100, default: 100, fmt: fmtPct },
  lowcut:    { id: 'lowcut',    label: 'LOW CUT',   min: 0, max: 100, default: 0,
    fmt: v => (v <= 0 ? 'Off' : `${Math.round(v)} Hz`) },
  split_lo:  { id: 'split_lo',  label: 'LOW SPLIT',  min: 40,   max: 1000,  default: 200,  skew: 0.39, fmt: fmtHz },
  split_hi:  { id: 'split_hi',  label: 'HIGH SPLIT', min: 1000, max: 18000, default: 2000, skew: 0.40, fmt: fmtHz },
}

// Band 4-state switch values (spec 3). Index == engine parameter value.
export const BAND_STATES = ['ON', 'COMP OFF', 'MUTED', 'OFF']

// Default value for any full param id — used to hydrate before the engine
// answers and as the knob Ctrl+click reset target.
export function paramDefault(id) {
  const g = Object.values(GLOBAL_KNOBS).find(k => k.id === id)
  if (g) return g.default
  if (id === 'slope_lo' || id === 'slope_hi') return 1
  const suffix = id.replace(/^(lo_|md_|hi_|ms_)/, '')
  if (suffix === 'state') return 0
  if (suffix === 'solo') return 0
  if (suffix === 'det') return 0
  const k = BAND_KNOBS.find(b => b.suffix === suffix)
  return k ? k.default : 0
}
