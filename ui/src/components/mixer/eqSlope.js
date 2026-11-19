// Low Pass / High Pass slopes of the Parametric EQ, mirrored for the UI.
// Port of engine/src/dsp/EqSlopeDesign.h (same maths, double precision): the
// Core display needs the exact filter a band draws so that a Spectral ("Reso")
// region lines up with its slope. Pure functions, no React, no store.
//
//   index  slope        filter
//   0      6 dB/oct     1st order (Q ignored)
//   1      12 dB/oct    2nd order RBJ biquad with Q (DEFAULT, the pre-slope filter)
//   2..7   18..96       Butterworth, order 3 / 4 / 6 / 8 / 12 / 16
//   8      Brickwall    Chebyshev II, order 16, 100 dB stop band
//
// Every slope has its -3 dB point at the band frequency.

export const BAND_SLOPES = [
  '6 dB/oct', '12 dB/oct', '18 dB/oct', '24 dB/oct', '36 dB/oct', '48 dB/oct', '72 dB/oct', '96 dB/oct', 'Brickwall',
]
export const DEFAULT_SLOPE = 1
export const BRICKWALL_SLOPE = 8

const TYPE_LOW_PASS = 3
const TYPE_HIGH_PASS = 4
const BUTTER_Q = 0.7071067811865476
const BUTTER_ORDER = [1, 2, 3, 4, 6, 8, 12, 16, 16]

export const isCutBandType = (type) => {
  const t = Math.round(Number(type))
  return t === TYPE_LOW_PASS || t === TYPE_HIGH_PASS
}

export const clampSlope = (slope) => {
  const s = Math.round(Number(slope))
  return Number.isFinite(s) ? Math.min(Math.max(s, 0), BAND_SLOPES.length - 1) : DEFAULT_SLOPE
}

// Slopes with more than one section (18 dB/oct and up).
export const isCascadeSlope = (slope) => clampSlope(slope) >= 2

function firstOrder(highPass, K) {
  const inv = 1 / (1 + K)
  return highPass
    ? { b0: inv, b1: -inv, b2: 0, a1: (K - 1) * inv, a2: 0 }
    : { b0: K * inv, b1: K * inv, b2: 0, a1: (K - 1) * inv, a2: 0 }
}

function bilinear(n2, n1, n0, d2, d1, d0) {
  const inv = 1 / (d2 + d1 + d0)
  return {
    b0: (n2 + n1 + n0) * inv,
    b1: 2 * (n0 - n2) * inv,
    b2: (n2 - n1 + n0) * inv,
    a1: 2 * (d0 - d2) * inv,
    a2: (d2 - d1 + d0) * inv,
  }
}

function sectionToDigital(highPass, omega, n2, n1, n0, d2, d1, d0) {
  if (!highPass) return bilinear(n2, n1 * omega, n0 * omega * omega, d2, d1 * omega, d0 * omega * omega)
  return bilinear(n0, n1 * omega, n2 * omega * omega, d0, d1 * omega, d2 * omega * omega)
}

let cheby2Cache = null
function cheby2Proto(order, stopDb) {
  if (cheby2Cache) return cheby2Cache
  const n = order / 2
  const invEps = Math.sqrt(10 ** (stopDb / 10) - 1)
  const v0 = Math.asinh(invEps) / order
  const sh = Math.sinh(v0)
  const ch = Math.cosh(v0)
  const secs = []
  for (let k = 0; k < n; k++) {
    const theta = (Math.PI * (2 * (k + 1) - 1)) / (2 * order)
    const sig = -sh * Math.sin(theta)
    const om = ch * Math.cos(theta)
    const mag2 = sig * sig + om * om
    const pm2 = 1 / mag2
    const cosT = Math.cos(theta)
    const zk2 = 1 / (cosT * cosT)
    secs.push({ n2: pm2 / zk2, n0: pm2, d1: -2 * (sig / mag2), d0: pm2 })
  }
  const magSq = (w) => {
    let m = 1
    for (const s of secs) {
      const nr = s.n0 - s.n2 * w * w
      const dr = s.d0 - w * w
      const di = s.d1 * w
      m *= (nr * nr) / (dr * dr + di * di)
    }
    return m
  }
  let lo = 1e-4
  let hi = 1
  for (let i = 0; i < 80; i++) {
    const mid = 0.5 * (lo + hi)
    if (magSq(mid) > 0.5) lo = mid
    else hi = mid
  }
  cheby2Cache = { secs, omegaC: 0.5 * (lo + hi) }
  return cheby2Cache
}

// The slope's filter as a list of biquad sections {b0,b1,b2,a1,a2} for a Low
// Pass (highPass = false) or High Pass band; slope >= 2 only.
export function slopeSections(highPass, freqHz, q, slope, sr) {
  const f = Math.min(Math.max(freqHz, 1), 0.49 * sr)
  const K = Math.tan((Math.PI * f) / sr)
  const out = []
  if (slope === BRICKWALL_SLOPE) {
    const { secs, omegaC } = cheby2Proto(16, 100)
    const omega = highPass ? K * omegaC : K / omegaC
    for (let k = secs.length - 1; k >= 0; k--) {
      const s = secs[k]
      out.push(sectionToDigital(highPass, omega, s.n2, 0, s.n0, 1, s.d1, s.d0))
    }
    return out
  }
  const order = BUTTER_ORDER[slope]
  const qScale = Math.max(q, 0.1) / BUTTER_Q
  if (order % 2 === 1) out.push(firstOrder(highPass, K))
  for (let k = Math.floor(order / 2) - 1; k >= 0; k--) {
    let qk = 1 / (2 * Math.sin((Math.PI * (2 * k + 1)) / (2 * order)))
    if (k === 0) qk *= qScale
    out.push(sectionToDigital(highPass, K, 0, 0, 1, 1, 1 / qk, 1))
  }
  return out
}

// 6 dB/oct section: the one first-order case that stays a single float biquad
// in the engine (b2 = a2 = 0).
export function firstOrderSection(highPass, freqHz, sr) {
  const f = Math.min(Math.max(freqHz, 1), 0.49 * sr)
  const c = firstOrder(highPass, Math.tan((Math.PI * f) / sr))
  const r = Math.fround
  return { b0: r(c.b0), b1: r(c.b1), b2: 0, a1: r(c.a1), a2: 0 }
}

// |H(e^jw)|^2 of one section / a list of sections.
export function sectionMagSq(c, freq, sr) {
  const w = (2 * Math.PI * freq) / sr
  const cw = Math.cos(w), sw = Math.sin(w), c2 = Math.cos(2 * w), s2 = Math.sin(2 * w)
  const nRe = c.b0 + c.b1 * cw + c.b2 * c2
  const nIm = -c.b1 * sw - c.b2 * s2
  const dRe = 1 + c.a1 * cw + c.a2 * c2
  const dIm = -c.a1 * sw - c.a2 * s2
  const d = dRe * dRe + dIm * dIm
  return d > 1e-300 ? (nRe * nRe + nIm * nIm) / d : 1
}

export function cascadeMagSq(sections, freq, sr) {
  let m = 1
  for (const s of sections) m *= sectionMagSq(s, freq, sr)
  return m
}
