// What the Param EQ's Spectral bands do on the Core engine (spectral_engine = 1),
// derived in the UI from the band parameters alone: no RPC, no bridge.
// Mirrors XlethParametricEQ (engine/src/audio/XlethEQEffect.h):
//   refreshCoreRegions        - regions, depth cap, dominant band, upward bands
//   spectralCoreChannelMode   - the channel-routing conflict
//   computeCoefficients / writeResponseTraces - the curve the engine draws
// Contract: engine/src/dsp/ResonanceCore.md, "Using the core in the Param EQ".
//
// Pure functions, no React, no store.

import {
  clampSlope, isCascadeSlope, isCutBandType, slopeSections, firstOrderSection, cascadeMagSq,
} from './eqSlope.js'

export const SPECTRAL_ENGINE_LEGACY = 0
export const SPECTRAL_ENGINE_CORE = 1
export const SPECTRAL_QUALITY_DEFAULT = 1 // Normal
export const CORE_MAX_DEPTH_DB = 24 // Legacy allowed the full gain range (30 dB)

const LOG_MIN = Math.log(20)
const LOG_MAX = Math.log(20000)

// ── UI strings (hint bar text and notes) ────────────────────────────────────
export const ENGINE_HINT = 'Legacy is the original analysis. Core is the newer shared engine: lower latency, '
  + 'detects both channels. Settings do not sound identical across engines.'
export const QUALITY_HINT = 'Core analysis size. Fast has the least latency, High the finest frequency detail.'
export const LATENCY_HINT = 'Latency this instance adds, as reported by the engine'
export const CORE_GAIN_HINT = 'Spectral depth. On Core the cut stops at 24 dB (deeper settings cut 24 dB) '
  + 'and a positive gain does nothing.'
export const CORE_UPWARD_HINT = 'Inactive on Core: Spectral bands only cut, so a positive gain does nothing here.'
export const CORE_CONFLICT_NOTE = 'Spectral bands ask for different channels, so Core runs them all in Stereo.'
export const coreSharedNote = (dominant) => `Core uses band ${dominant + 1}'s values.`
export const coreSharedHint = (dominant) => `Shared on Core: Spectral bands use one detector, so sensitivity, `
  + `selectivity, attack and release come from band ${dominant + 1} (the deepest cut).`
export const CORE_DOMINANT_HINT = 'On Core this also sets the other Spectral bands (this band is the deepest cut).'

export const isCoreEngine = (engine) => Math.round(Number(engine) || 0) === SPECTRAL_ENGINE_CORE

// An enabled Spectral band (mode 2). `enabled` arrives as a boolean or 0/1.
export const isActiveSpectral = (band) => !!band && Number(band.mode) === 2 && !!Number(band.enabled)

// ── Status: dominant band, upward bands, channel conflict ───────────────────
// dominant: the band whose settings drive the core's detector (sensitivity,
//   selectivity, attack, release): the deepest cut after the 24 dB cap, the
//   lowest index on a tie (the engine compares with a strict >). -1 = none.
// upward:   enabled Spectral bands with gain > 0 (inert on Core: cuts only).
// conflict: enabled Spectral bands ask for different channel routings; the
//   core then runs all of them as Stereo.
export function coreSpectralStatus(bands) {
  let depth = 0
  let dominant = -1
  const upward = []
  const cuts = []
  let channel = null
  let conflict = false
  ;(bands || []).forEach((b, i) => {
    if (!isActiveSpectral(b)) return
    const g = Number(b.gain) || 0
    if (g < 0) {
      cuts.push(i)
      const d = Math.min(-g, CORE_MAX_DEPTH_DB)
      if (d > depth) { depth = d; dominant = i }
    } else if (g > 0) {
      upward.push(i)
    }
    const ch = b.channel || 'stereo'
    if (channel === null) channel = ch
    else if (ch !== channel) conflict = true
  })
  return { dominant, upward, cuts, conflict, depthDb: depth }
}

// ── The engine's biquads (computeCoefficients, coefficients stored as float) ─
export function engineBiquad(type, freq, gainDb, q, sr) {
  const w0 = (2 * Math.PI * freq) / sr
  const cosw = Math.cos(w0)
  const sinw = Math.sin(w0)
  const alpha = sinw / (2 * q)
  const A = Math.pow(10, gainDb / 40)
  const sqrtA = Math.sqrt(A)
  let b0 = 1, b1 = 0, b2 = 0, a0 = 1, a1 = 0, a2 = 0
  switch (type) {
    case 0: // Bell
      b0 = 1 + alpha * A; b1 = -2 * cosw; b2 = 1 - alpha * A
      a0 = 1 + alpha / A; a1 = -2 * cosw; a2 = 1 - alpha / A
      break
    case 1: { // Low Shelf
      const s = 2 * sqrtA * alpha
      b0 = A * ((A + 1) - (A - 1) * cosw + s); b1 = 2 * A * ((A - 1) - (A + 1) * cosw); b2 = A * ((A + 1) - (A - 1) * cosw - s)
      a0 = (A + 1) + (A - 1) * cosw + s; a1 = -2 * ((A - 1) + (A + 1) * cosw); a2 = (A + 1) + (A - 1) * cosw - s
      break
    }
    case 2: { // High Shelf
      const s = 2 * sqrtA * alpha
      b0 = A * ((A + 1) + (A - 1) * cosw + s); b1 = -2 * A * ((A - 1) + (A + 1) * cosw); b2 = A * ((A + 1) + (A - 1) * cosw - s)
      a0 = (A + 1) - (A - 1) * cosw + s; a1 = 2 * ((A - 1) - (A + 1) * cosw); a2 = (A + 1) - (A - 1) * cosw - s
      break
    }
    case 3: // Low Pass
      b0 = (1 - cosw) / 2; b1 = 1 - cosw; b2 = (1 - cosw) / 2
      a0 = 1 + alpha; a1 = -2 * cosw; a2 = 1 - alpha
      break
    case 4: // High Pass
      b0 = (1 + cosw) / 2; b1 = -(1 + cosw); b2 = (1 + cosw) / 2
      a0 = 1 + alpha; a1 = -2 * cosw; a2 = 1 - alpha
      break
    case 5: // Notch
      b0 = 1; b1 = -2 * cosw; b2 = 1
      a0 = 1 + alpha; a1 = -2 * cosw; a2 = 1 - alpha
      break
    case 6: { // Tilt: Low Shelf at a fixed Q of 0.5
      const s = 2 * sqrtA * (sinw / (2 * 0.5))
      b0 = A * ((A + 1) - (A - 1) * cosw + s); b1 = 2 * A * ((A - 1) - (A + 1) * cosw); b2 = A * ((A + 1) - (A - 1) * cosw - s)
      a0 = (A + 1) + (A - 1) * cosw + s; a1 = -2 * ((A - 1) + (A + 1) * cosw); a2 = (A + 1) + (A - 1) * cosw - s
      break
    }
    default:
      break
  }
  const f = Math.fround
  return { b0: f(b0 / a0), b1: f(b1 / a0), b2: f(b2 / a0), a1: f(a1 / a0), a2: f(a2 / a0) }
}

// |H(e^jw)|^2 of a biquad (the engine's complex evaluation, written out).
function magSq(c, freq, sr) {
  const w = (2 * Math.PI * freq) / sr
  const cw = Math.cos(w), sw = Math.sin(w), c2 = Math.cos(2 * w), s2 = Math.sin(2 * w)
  const nRe = c.b0 + c.b1 * cw + c.b2 * c2
  const nIm = -c.b1 * sw - c.b2 * s2
  const dRe = 1 + c.a1 * cw + c.a2 * c2
  const dIm = -c.a1 * sw - c.a2 * s2
  const d = dRe * dRe + dIm * dIm
  return d > 1e-30 ? (nRe * nRe + nIm * nIm) / d : 1
}

// The engine's response grid: n log-spaced frequencies from 20 Hz to 20 kHz.
export function responseFreqs(n) {
  const out = new Float64Array(n)
  for (let i = 0; i < n; i++) out[i] = Math.exp(LOG_MIN + (i / (n - 1)) * (LOG_MAX - LOG_MIN))
  return out
}

// A band's filter as the engine builds it (computeBandCascade): the sections of
// a steep Low / High Pass slope, or the one biquad every other band is
// (including the 6 / 12 dB/oct slopes). Gain is the biquad's gain (depth, for
// a Spectral band).
function engineSections(band, sr) {
  const type = Math.round(Number(band.type) || 0)
  const freq = Math.max(Number(band.freq) || 1000, 20)
  const q = Math.max(Number(band.q) || 0.707, 0.1)
  if (isCutBandType(type)) {
    const slope = clampSlope(band.slope ?? 1)
    if (isCascadeSlope(slope)) return slopeSections(type === 4, freq, q, slope, sr)
    if (slope === 0) return [firstOrderSection(type === 4, freq, sr)]
  }
  return [engineBiquad(type, freq, Number(band.gain) || 0, q, sr)]
}

// What the engine's Stereo trace holds for one enabled Spectral band: its own
// filter (band type and slope, gain as depth), in dB.
function engineSpectralDb(band, freq, sr) {
  return 10 * Math.log10(Math.max(cascadeMagSq(engineSections(band, sr), freq, sr), 1e-30))
}

// A Core region's cut at `freq` in dB (<= 0): the band's bell at |gain| (at
// least 1 dB) normalised to 1 at its centre, times the band's own capped
// depth. A Low / High Pass band is the exception: its region is its own slope
// (attenuation over depth, see below). 0 for a band that is not a cut.
export function coreRegionCutDb(band, freq, sr) {
  const g = Number(band.gain) || 0
  if (g >= 0) return 0
  const shapeDb = Math.max(-g, 1)
  // A Low / High Pass band's region is its slope: the filter's attenuation in
  // dB over the depth, capped at 1 (updateSpectralWeights / refreshCoreRegions).
  if (isCutBandType(band.type)) {
    const attDb = -10 * Math.log10(Math.max(cascadeMagSq(engineSections(band, sr), freq, sr), 1e-30))
    return -Math.min(Math.max(attDb / shapeDb, 0), 1) * Math.min(-g, CORE_MAX_DEPTH_DB)
  }
  const c = engineBiquad(0, Math.max(Number(band.freq) || 1000, 20), shapeDb, Math.max(Number(band.q) || 0.707, 0.1), sr)
  const shape = Math.min(Math.max((10 * Math.log10(Math.max(magSq(c, freq, sr), 1e-30))) / shapeDb, 0), 1)
  return -shape * Math.min(-g, CORE_MAX_DEPTH_DB)
}

// The Core's union of regions at `freq`: the MAXIMUM cut over the enabled
// Spectral cut bands (Legacy's masks multiplied, i.e. their cuts added in dB).
export function coreUnionCutDb(bands, freq, sr) {
  let cut = 0
  for (const b of bands || []) {
    if (!isActiveSpectral(b)) continue
    const d = coreRegionCutDb(b, freq, sr)
    if (d < cut) cut = d
  }
  return cut
}

const FLOOR_DB = -299 // the engine floors exact nulls at -300 dB; leave those alone

// The Stereo trace as the Core renders it: every enabled Spectral band's
// plain biquad (what the engine drew) taken out, the union of the Core
// regions put in. Upward and 0 dB Spectral bands therefore draw nothing; cuts
// stop at 24 dB; overlapping regions take the deeper cut, not the sum.
// Returns the trace unchanged (same object) when no Spectral band is enabled.
export function applyCoreSpectralToTrace(trace, bands, sr) {
  if (!trace || !(sr > 0)) return trace
  const spectral = (bands || []).filter(isActiveSpectral)
  if (spectral.length === 0) return trace
  const n = trace.length
  const freqs = responseFreqs(n)
  const out = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    const db = trace[i]
    if (!(db > FLOOR_DB)) { out[i] = db; continue }
    let v = db
    for (const b of spectral) v -= engineSpectralDb(b, freqs[i], sr)
    v += coreUnionCutDb(spectral, freqs[i], sr)
    out[i] = v
  }
  return out
}

// The response curves to display, given the engine's curves ({ stereo, left,
// ... }) and the EQ's state. Legacy: the engine's curves, the same object.
// Core: the Stereo trace through applyCoreSpectralToTrace (Spectral bands are
// always on the Stereo trace: the engine folds their routing for the curve).
export function displayResponseCurves(curves, { spectralEngine, bands, sampleRate }) {
  if (!curves || !curves.stereo || !isCoreEngine(spectralEngine)) return curves
  const stereo = applyCoreSpectralToTrace(curves.stereo, bands, sampleRate)
  return stereo === curves.stereo ? curves : { ...curves, stereo }
}

// One band's display fill on Core (dB per frequency), or null when the band
// draws nothing there (not an enabled Spectral cut).
export function coreBandFillDb(band, freqs, sr) {
  if (!isActiveSpectral(band) || !((Number(band.gain) || 0) < 0)) return null
  return Array.from(freqs, (f) => coreRegionCutDb(band, f, sr))
}
