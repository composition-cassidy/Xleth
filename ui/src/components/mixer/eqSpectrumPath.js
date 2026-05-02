// EQ-A/B spectrum path generator. Aggregates the 2048-bin engine analyzer
// output into 1/N-octave bars, applies optional pink-noise tilt and
// per-bar max-hold decay, and emits two SVG path strings: a closed fill
// path and an open max-hold trace.
//
// The rendered path uses only M / L / Z commands — no midpoint smoothing,
// no Bézier — so local peaks read crisply at high bar density.
//
// EQ-B: computeSpectrumPaths accepts an optional `opts` argument that
// controls barsPerOctave (resolution), decayDbPerSec (speed), and rangeDb
// (vertical scale). All three default to the EQ-A values when omitted so
// the existing call sites and tests continue to work unchanged.

import {
  PAD_L, PAD_T, PLOT_H, PLOT_W,
  FREQ_MIN, FREQ_MAX, ANA_DB_MIN, ANA_DB_MAX,
  freqToX, dbToY_analyzerWithRange,
} from './eqGeometry.js'

export const BARS_PER_OCTAVE  = 24
export const DECAY_DB_PER_SEC = 24

// Memoised bar-edge tables keyed by barsPerOctave.
const _edgeCache = new Map()

export function getBarEdges(barsPerOctave) {
  if (_edgeCache.has(barsPerOctave)) return _edgeCache.get(barsPerOctave)
  const edges = []
  const startLog = Math.log2(FREQ_MIN)
  const endLog   = Math.log2(FREQ_MAX)
  const steps    = Math.ceil((endLog - startLog) * barsPerOctave)
  for (let i = 0; i <= steps; i++) {
    edges.push(Math.pow(2, startLog + (i / barsPerOctave)))
  }
  _edgeCache.set(barsPerOctave, edges)
  return edges
}

// Default bar edges (24 bars/oct) kept as a named export for backward compat.
export const FREQ_BAR_EDGES = getBarEdges(BARS_PER_OCTAVE)

// Module-level max-hold state. resetMaxHold() should be called when a new
// EQ instance opens, the bar count changes, or the polling loop restarts.
let maxHoldPost     = null
let maxHoldPre      = null
let maxHoldLastTime = 0
let lastDebugTime   = 0

export function resetMaxHold(which) {
  if (which === 'pre')  { maxHoldPre = null; return }
  if (which === 'post') { maxHoldPost = null; maxHoldLastTime = 0; return }
  maxHoldPost     = null
  maxHoldPre      = null
  maxHoldLastTime = 0
}

// opts shape (all optional):
//   barsPerOctave  — render bar density (12/18/24/36)
//   decayDbPerSec  — max-hold fall speed (8/24/48 dB/s)
//   rangeDb        — analyzer y-axis range in dB (60/90/120); null → use ANA_DB_MIN
export function computeSpectrumPaths(data, nyquist, slopeDbPerOct, isPost, opts = {}) {
  if (!data || data.length === 0) return { fill: '', maxHold: '' }

  const {
    barsPerOctave  = BARS_PER_OCTAVE,
    decayDbPerSec  = DECAY_DB_PER_SEC,
    rangeDb        = null,
  } = opts

  const barEdges = getBarEdges(barsPerOctave)
  const bins     = data.length
  const numBars  = barEdges.length - 1
  const floorDb  = rangeDb != null ? ANA_DB_MAX - rangeDb : ANA_DB_MIN

  let maxHold = isPost ? maxHoldPost : maxHoldPre
  if (!maxHold || maxHold.length !== numBars) {
    maxHold = new Float32Array(numBars).fill(-Infinity)
    if (isPost) maxHoldPost = maxHold
    else        maxHoldPre  = maxHold
  }

  const now   = performance.now()
  const dtSec = maxHoldLastTime > 0 ? (now - maxHoldLastTime) / 1000 : 0
  if (isPost) maxHoldLastTime = now

  const barDb = new Float32Array(numBars)

  for (let k = 0; k < numBars; k++) {
    const fLo = barEdges[k]
    const fHi = barEdges[k + 1]

    const loBin = Math.max(1, Math.floor(fLo * bins / nyquist))
    const hiBin = Math.min(bins - 1, Math.ceil(fHi * bins / nyquist))

    let maxDb = -Infinity
    if (hiBin >= loBin) {
      for (let b = loBin; b <= hiBin; b++) {
        if (data[b] > maxDb) maxDb = data[b]
      }
    } else {
      const centerBin = (fLo + fHi) / 2 * bins / nyquist
      const b0   = Math.max(0, Math.floor(centerBin))
      const b1   = Math.min(bins - 1, b0 + 1)
      const frac = centerBin - b0
      maxDb = data[b0] * (1 - frac) + data[b1] * frac
    }

    if (slopeDbPerOct !== 0) {
      const centerHz = Math.sqrt(fLo * fHi)
      maxDb += slopeDbPerOct * Math.log2(centerHz / 1000)
    }

    barDb[k] = maxDb

    if (maxDb > maxHold[k]) {
      maxHold[k] = maxDb
    } else {
      maxHold[k] = Math.max(floorDb, maxHold[k] - decayDbPerSec * dtSec)
    }
  }

  if (typeof window !== 'undefined' && window.XLETH_DEBUG && isPost) {
    const t = performance.now()
    if (t - lastDebugTime >= 1000) {
      lastDebugTime = t
      const above = Array.from(barDb).filter(db => db > -60).length
      const peak  = Math.max(...Array.from(barDb))
      // eslint-disable-next-line no-console
      console.log(`[EQ-Render] bars >-60dB: ${above}, peak: ${peak.toFixed(1)}dB`)
    }
  }

  const xArr     = new Array(numBars)
  const yFillArr = new Array(numBars)
  const yHoldArr = new Array(numBars)

  for (let k = 0; k < numBars; k++) {
    const fCenter = Math.sqrt(barEdges[k] * barEdges[k + 1])
    xArr[k]     = freqToX(fCenter)
    yFillArr[k] = dbToY_analyzerWithRange(barDb[k], rangeDb)
    yHoldArr[k] = dbToY_analyzerWithRange(maxHold[k], rangeDb)
  }

  // EQ-A: straight L-segments between bar centers, no midpoint smoothing.
  // Path emits only M / L / Z so peaks read crisply at 1/N-oct density.
  const fillParts = [`M ${PAD_L} ${(PAD_T + PLOT_H).toFixed(1)}`]
  const holdParts = []

  for (let k = 0; k < numBars; k++) {
    fillParts.push(`L ${xArr[k].toFixed(1)} ${yFillArr[k].toFixed(1)}`)
    holdParts.push(k === 0
      ? `M ${xArr[k].toFixed(1)} ${yHoldArr[k].toFixed(1)}`
      : `L ${xArr[k].toFixed(1)} ${yHoldArr[k].toFixed(1)}`)
  }

  fillParts.push(`L ${(PAD_L + PLOT_W).toFixed(1)} ${(PAD_T + PLOT_H).toFixed(1)} Z`)
  return { fill: fillParts.join(' '), maxHold: holdParts.join(' ') }
}
