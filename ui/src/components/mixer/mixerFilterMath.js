// ─── mixerFilterMath.js ───────────────────────────────────────────────────────
// Pure frequency-axis and first-order filter-response math shared by every
// mixer panel that draws a draggable filter curve (Delay, Reverb).
//
// Both engines build the same topology — a first-order low-pass at the "hi"
// corner in series with a first-order high-pass at the "lo" corner:
//
//   XlethDelayEffect.h  — feedback-path filter (filter_lo / filter_hi)
//   XlethReverbEffect.h — wet-path filter, one-pole coefficients
//                         exp(-2*pi*f/sr) for both hicut and locut
//
// so the response maths is genuinely common rather than coincidentally
// similar. Only the parameter ids and their legal ranges differ, and those
// stay with each panel.
//
// Nothing here touches the DOM. Every export is directly unit-testable.

/** Clamps v to [lo, hi]. */
export function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v))
}

export const FILTER_F_MIN = 20
export const FILTER_F_MAX = 20000

/**
 * Magnitude (linear, 0–1) of a first-order low-pass at `hiHz` in series with a
 * first-order high-pass at `loHz`, evaluated at `freqHz`. 6 dB/oct on both
 * skirts.
 */
export function filterMagnitude(freqHz, loHz, hiHz) {
  const f = Math.max(freqHz, 1e-6)
  const lo = Math.max(loHz, 1e-6)
  const hi = Math.max(hiHz, 1e-6)
  const rLo = f / lo
  const hp = rLo / Math.sqrt(1 + rLo * rLo)
  const lp = 1 / Math.sqrt(1 + (f / hi) * (f / hi))
  return hp * lp
}

/** Same response expressed in dB, floored at -60 dB so it stays plottable. */
export function filterMagnitudeDb(freqHz, loHz, hiHz) {
  const mag = filterMagnitude(freqHz, loHz, hiHz)
  return Math.max(-60, 20 * Math.log10(Math.max(mag, 1e-6)))
}

/** Log-maps a frequency to a normalised x position in [0, 1]. */
export function freqToNorm(freqHz, fMin = FILTER_F_MIN, fMax = FILTER_F_MAX) {
  const f = clamp(freqHz, fMin, fMax)
  return (Math.log2(f) - Math.log2(fMin)) / (Math.log2(fMax) - Math.log2(fMin))
}

/** Inverse of freqToNorm — maps a normalised x back to a frequency. */
export function normToFreq(norm, fMin = FILTER_F_MIN, fMax = FILTER_F_MAX) {
  const n = clamp(norm, 0, 1)
  return fMin * Math.pow(2, n * (Math.log2(fMax) - Math.log2(fMin)))
}

/** Maps a dB value to a normalised y position in [0, 1] (0 = top of the plot). */
export function dbToNorm(db, dbTop = 3, dbBottom = -33) {
  return clamp((dbTop - db) / (dbTop - dbBottom), 0, 1)
}

/**
 * Picks which filter handle a pointer at normalised x is grabbing.
 * Returns 'lo', 'hi', or null when the pointer is nowhere near either.
 *
 * `fMin`/`fMax` must match the axis the caller drew, otherwise the hit test
 * disagrees with the pixels (the Reverb curve uses a narrower axis than the
 * Delay curve).
 */
export function pickFilterHandle(
  xNorm, loHz, hiHz, tolerance = 0.06, fMin = FILTER_F_MIN, fMax = FILTER_F_MAX,
) {
  const dLo = Math.abs(xNorm - freqToNorm(loHz, fMin, fMax))
  const dHi = Math.abs(xNorm - freqToNorm(hiHz, fMin, fMax))
  if (dLo > tolerance && dHi > tolerance) return null
  return dLo <= dHi ? 'lo' : 'hi'
}

/** "80 Hz" / "1.20 kHz" / "12.0 kHz" */
export function formatHz(freqHz) {
  if (freqHz >= 10000) return `${(freqHz / 1000).toFixed(1)} kHz`
  if (freqHz >= 1000) return `${(freqHz / 1000).toFixed(2)} kHz`
  return `${Math.round(freqHz)} Hz`
}
