// Shared coordinate / geometry helpers for the Parametric EQ panel.
//
// Extracted from EqPanel.jsx in EQ-A so the painter, the band-row inspector
// (EQ-C), and the analyzer-controls overlay (EQ-B) can all consume the same
// transforms without copy-paste.

export const SVG_W = 640
export const SVG_H = 280
export const PAD_L = 36
export const PAD_R = 8
export const PAD_T = 8
export const PAD_B = 20
export const PLOT_W = SVG_W - PAD_L - PAD_R
export const PLOT_H = SVG_H - PAD_T - PAD_B

export const FREQ_MIN = 20
export const FREQ_MAX = 20000

export const ANA_DB_MIN = -80
export const ANA_DB_MAX = 12

export const RESPONSE_SIZE = 512

export function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v))
}

export function freqToX(f) {
  const t = (Math.log(f) - Math.log(FREQ_MIN)) / (Math.log(FREQ_MAX) - Math.log(FREQ_MIN))
  return PAD_L + t * PLOT_W
}

export function xToFreq(x) {
  const t = (x - PAD_L) / PLOT_W
  return Math.exp(Math.log(FREQ_MIN) + t * (Math.log(FREQ_MAX) - Math.log(FREQ_MIN)))
}

export function dbToY_response(db, dbZoom) {
  const clamped = clamp(db, -dbZoom, dbZoom)
  const t = (clamped - dbZoom) / (-dbZoom - dbZoom)
  return PAD_T + t * PLOT_H
}

export function dbToY_analyzer(db) {
  const clamped = clamp(db, ANA_DB_MIN, ANA_DB_MAX)
  const t = (clamped - ANA_DB_MAX) / (ANA_DB_MIN - ANA_DB_MAX)
  return PAD_T + t * PLOT_H
}

// Range-aware variant: rangeDb=null falls back to ANA_DB_MIN (same as dbToY_analyzer).
export function dbToY_analyzerWithRange(db, rangeDb) {
  const topDb = ANA_DB_MAX
  const botDb = rangeDb != null ? ANA_DB_MAX - rangeDb : ANA_DB_MIN
  const clamped = clamp(db, botDb, topDb)
  const t = (clamped - topDb) / (botDb - topDb)
  return PAD_T + t * PLOT_H
}

export function yToDb_response(y, dbZoom) {
  const t = (y - PAD_T) / PLOT_H
  return dbZoom + t * (-2 * dbZoom)
}

export function evalResponseAt(curveData, freq) {
  const t = (Math.log(freq) - Math.log(FREQ_MIN)) / (Math.log(FREQ_MAX) - Math.log(FREQ_MIN))
  const idx = t * (RESPONSE_SIZE - 1)
  const lo = Math.floor(idx)
  const hi = Math.min(lo + 1, RESPONSE_SIZE - 1)
  const frac = idx - lo
  return curveData[lo] * (1 - frac) + curveData[hi] * frac
}
