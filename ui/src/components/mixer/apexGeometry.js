// Coordinate math + parameter tables for the APEX editor.
//
// Two canvas surfaces share this module:
//   • the curve editor — both axes are dB in [CURVE_MIN_DB, CURVE_MAX_DB], and
//     evalCurveAt / tensionWarp are exact JS ports of the engine LUT builder
//     (ApexDsp.h buildCurveLut / tensionWarp) so the drawn curve matches the
//     gain the audio thread actually applies.
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

// Per-segment tension warp. t is the normalised position inside a segment
// (0..1); tension -1..+1 with 0 == linear. Exact port of engine tensionWarp:
//   tension  0 -> t           tension +1 -> t^0.25 (soft knee)
//   tension -1 -> t^4 (hard knee)
export function tensionWarp(t, tension) {
  if (tension > -1e-4 && tension < 1e-4) return t
  const p = Math.pow(4, -clamp(tension, -1, 1))
  return Math.pow(clamp(t, 0, 1), p)
}

// Evaluate the compiled transfer curve at an input level (dB) → output (dB).
// Outside the authored domain the endpoint GAIN is held (unity slope), matching
// the engine so silence is never amplified and hot signal gets no extra makeup.
export function evalCurveAt(curve, inDb) {
  const nodes = curve?.nodes
  if (!Array.isArray(nodes) || nodes.length < 2) return inDb   // unity gain
  const first = nodes[0]
  const last = nodes[nodes.length - 1]
  if (inDb <= first.in) return inDb + (first.out - first.in)
  if (inDb >= last.in) return inDb + (last.out - last.in)
  let seg = 0
  while (seg < nodes.length - 2 && inDb > nodes[seg + 1].in) seg++
  const a = nodes[seg]
  const b = nodes[seg + 1]
  const w = b.in - a.in
  const t = w > 1e-6 ? (inDb - a.in) / w : 0
  const tension = curve.tensions?.[seg] ?? 0
  return a.out + (b.out - a.out) * tensionWarp(t, tension)
}

// ── Curve editor ↔ canvas mapping ─────────────────────────────────────────────
// plot = { x, y, w, h } in CSS pixels. Both axes span the same dB box.

export function inDbToX(inDb, plot) {
  const t = (inDb - CURVE_MIN_DB) / (CURVE_MAX_DB - CURVE_MIN_DB)
  return plot.x + t * plot.w
}
export function xToInDb(px, plot) {
  const t = (px - plot.x) / plot.w
  return CURVE_MIN_DB + t * (CURVE_MAX_DB - CURVE_MIN_DB)
}
export function outDbToY(outDb, plot) {
  const t = (outDb - CURVE_MIN_DB) / (CURVE_MAX_DB - CURVE_MIN_DB)
  return plot.y + (1 - t) * plot.h   // y inverted: higher out = higher on screen
}
export function yToOutDb(py, plot) {
  const t = 1 - (py - plot.y) / plot.h
  return CURVE_MIN_DB + t * (CURVE_MAX_DB - CURVE_MIN_DB)
}

// The visual position of a segment's tension handle: the midpoint input of the
// segment, evaluated on the live curve so the handle rides the drawn line.
export function segmentHandlePoint(curve, seg, plot) {
  const a = curve.nodes[seg]
  const b = curve.nodes[seg + 1]
  const midIn = (a.in + b.in) / 2
  const outAtMid = evalCurveAt(curve, midIn)
  return { x: inDbToX(midIn, plot), y: outDbToY(outAtMid, plot), inDb: midIn }
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
