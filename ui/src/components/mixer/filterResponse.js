// ─── filterResponse.js ────────────────────────────────────────────────────────
// JS port of XlethFilterEffect's per-stage transfer-function maths, used ONLY to
// draw the faint per-slot guide curves in FilterPanel. The bold aggregate curve
// is always the authoritative array from audio_filterGetResponseCurve — this
// file never replaces it.
//
// Ported 1:1 from engine/src/audio/XlethFilterEffect.h (designStage +
// getResponseCurve's complex evaluation). Drive is a nonlinearity and, exactly
// like the engine's own curve, is not modelled. Sample rate is assumed 44.1 kHz
// (the engine exposes no getSampleRate RPC for the filter); the only visible
// consequence is a hair of prewarp error right at 20 kHz on the faint guides,
// well below the authoritative aggregate's accuracy.

const K_MIN_CUTOFF_HZ  = 10.0
const K_NYQUIST_FACTOR = 0.45
const K_MIN_Q          = 0.5
const K_MAX_Q          = 30.0
const K_NEUTRAL_Q      = 0.70710678118654752
const K_SELF_OSC_Q     = 29.99
const K_SELF_OSC_DAMP  = 0.02

export const RESPONSE_SIZE = 512
export const FREQ_MIN = 20
export const FREQ_MAX = 20000

// Butterworth section Qs, ascending, for a cascade of S sections (engine table).
const BW_TABLE = [
  [0.70710678118654752, 0, 0, 0],
  [0.54119610014619698, 1.30656296487637652, 0, 0],
  [0, 0, 0, 0],                                    // 3 sections unused
  [0.50979557910415918, 0.60134488693504527, 0.89997622313641557, 2.56291544774150011],
]

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)) }

function butterworthQ(stageCount, stageIndex) {
  const s = clamp(stageCount - 1, 0, 3)
  const i = clamp(stageIndex, 0, 3)
  const q = BW_TABLE[s][i]
  return q > 0 ? q : K_NEUTRAL_Q
}

function clampCutoff(fc, sr) {
  return clamp(fc, K_MIN_CUTOFF_HZ, sr * K_NYQUIST_FACTOR)
}

function stageQ(userQ, stageCount, stageIndex) {
  const base = clamp(userQ, K_MIN_Q, K_MAX_Q)
  const q = base * (butterworthQ(stageCount, stageIndex) / K_NEUTRAL_Q)
  return clamp(q, K_MIN_Q, K_MAX_Q)
}

// slope 0 is a genuine first-order section, which only exists for lp/hp.
function usesOnePole(type, slope) {
  return slope === 0 && (type === 0 || type === 1)
}

function slopeApplies(type) {
  // LP12, HP12, BP, Notch, Morph
  return type === 0 || type === 1 || type === 2 || type === 3 || type === 8
}

function stageCountFor(type, slope) {
  if (!slopeApplies(type)) return 1
  switch (slope) {
    case 0:  return 1   // 6 dB fallback for non-lp/hp types
    case 2:  return 2   // 24 dB
    case 3:  return 4   // 48 dB
    default: return 1   // 12 dB
  }
}

// The whole coefficient bank for one SVF section (engine designStage).
function designStage(type, fc, q, gainDb, morph, sr, selfOsc) {
  const pi = Math.PI
  fc = clampCutoff(fc, sr)
  q  = clamp(q, K_MIN_Q, K_MAX_Q)

  let g = Math.tan(pi * fc / sr)
  let k = selfOsc ? K_SELF_OSC_DAMP : (1.0 / q)
  let m0 = 0.0, m1 = 0.0, m2 = 1.0

  switch (type) {
    case 0: // LP12
      m0 = 0.0; m1 = 0.0; m2 = 1.0
      break
    case 1: // HP12
      m0 = 1.0; m1 = -k; m2 = -1.0
      break
    case 2: // BP
      m0 = 0.0; m1 = k; m2 = 0.0
      break
    case 3: // Notch
      m0 = 1.0; m1 = -k; m2 = 0.0
      break
    case 4: // Allpass
      m0 = 1.0; m1 = -2.0 * k; m2 = 0.0
      break
    case 5: { // Peak
      const A = Math.pow(10.0, gainDb / 40.0)
      k = selfOsc ? K_SELF_OSC_DAMP : (1.0 / (q * A))
      m0 = 1.0; m1 = k * (A * A - 1.0); m2 = 0.0
      break
    }
    case 6: { // LowShelf
      const A = Math.pow(10.0, gainDb / 40.0)
      g = g / Math.sqrt(A)
      m0 = 1.0; m1 = k * (A - 1.0); m2 = A * A - 1.0
      break
    }
    case 7: { // HighShelf
      const A = Math.pow(10.0, gainDb / 40.0)
      g = g * Math.sqrt(A)
      m0 = A * A; m1 = k * (1.0 - A) * A; m2 = 1.0 - A * A
      break
    }
    case 8: { // Morph: lp -> notch -> hp
      const tt = clamp(morph, 0.0, 1.0)
      if (tt <= 0.5) {
        const u = tt * 2.0
        m0 = u
        m1 = u * (-k)
        m2 = 1.0 - u
      } else {
        const u = (tt - 0.5) * 2.0
        m0 = 1.0
        m1 = -k
        m2 = -u
      }
      break
    }
    default:
      break
  }
  return { g, k, m0, m1, m2 }
}

// ── Minimal complex arithmetic on [re, im] ──────────────────────────────────
function cAdd(a, b) { return [a[0] + b[0], a[1] + b[1]] }
function cSub(a, b) { return [a[0] - b[0], a[1] - b[1]] }
function cMul(a, b) { return [a[0] * b[0] - a[1] * b[1], a[0] * b[1] + a[1] * b[0]] }
function cScale(a, s) { return [a[0] * s, a[1] * s] }
function cDiv(a, b) {
  const d = b[0] * b[0] + b[1] * b[1]
  if (d < 1e-30) return [1.0, 0.0]
  return [(a[0] * b[0] + a[1] * b[1]) / d, (a[1] * b[0] - a[0] * b[1]) / d]
}
function cAbs(a) { return Math.hypot(a[0], a[1]) }

// Log-spaced 20 Hz .. 20 kHz, matching the engine's getResponseCurve grid.
export function responseFrequencies(n = RESPONSE_SIZE) {
  const out = new Float64Array(n)
  const logMin = Math.log(FREQ_MIN)
  const logMax = Math.log(FREQ_MAX)
  for (let i = 0; i < n; i++) {
    const t = n > 1 ? i / (n - 1) : 0
    out[i] = Math.exp(logMin + t * (logMax - logMin))
  }
  return out
}

// Per-slot magnitude in dB, INCLUDING the slot's dry/wet mix crossfade, so the
// faint per-slot curves sum (in dB) to the bold aggregate the engine returns.
// Returns null for a disabled slot (nothing to draw).
export function slotResponseDb(slot, sr = 44100, n = RESPONSE_SIZE) {
  if (!slot || !slot.enabled) return null

  const type  = clamp(Math.round(slot.type ?? 0), 0, 8)
  const slope = clamp(Math.round(slot.slope ?? 1), 0, 3)
  const cut   = Number(slot.cutoff ?? 1000)
  const q     = Number(slot.q ?? 0.7071)
  const gain  = Number(slot.gain ?? 0)
  const morph = Number(slot.morph ?? 0)
  const mix   = clamp(Number(slot.mix ?? 1), 0, 1)

  const onePole  = usesOnePole(type, slope)
  const highPass = (type === 1)
  const stages   = onePole ? 1 : stageCountFor(type, slope)
  const fc       = clampCutoff(cut, sr)
  const selfOsc  = q >= K_SELF_OSC_Q

  // Pre-design every stage once.
  const oneG = onePole ? Math.tan(Math.PI * fc / sr) : 0
  const st = []
  if (!onePole) {
    for (let s = 0; s < stages; s++) {
      st.push(designStage(type, fc, stageQ(q, stages, s), gain, morph, sr, selfOsc))
    }
  }

  const freqs = responseFrequencies(n)
  const out = new Float32Array(n)

  for (let i = 0; i < n; i++) {
    const w = 2.0 * Math.PI * freqs[i] / sr
    const zInv = [Math.cos(-w), Math.sin(-w)]
    const A = cSub([1, 0], zInv) // 1 - z^-1
    const B = cAdd([1, 0], zInv) // 1 + z^-1

    let Hs = [1, 0]
    if (onePole) {
      const gB = cScale(B, oneG)
      const den = cAdd(A, gB)
      Hs = highPass ? cDiv(A, den) : cDiv(gB, den)
    } else {
      const AA = cMul(A, A)
      const AB = cMul(A, B)
      const BB = cMul(B, B)
      for (let s = 0; s < stages; s++) {
        const { g, k, m0, m1, m2 } = st[s]
        const den = cAdd(cAdd(AA, cScale(AB, k * g)), cScale(BB, g * g))
        const num = cAdd(cAdd(cScale(den, m0), cScale(AB, m1 * g)), cScale(BB, m2 * g * g))
        Hs = cMul(Hs, cDiv(num, den))
      }
    }

    // Per-slot dry/wet crossfade is linear, so it belongs in H.
    const H = cAdd(cScale([1, 0], 1 - mix), cScale(Hs, mix))
    const mag = cAbs(H)
    out[i] = 20.0 * Math.log10(Math.max(mag, 1e-12))
  }
  return out
}
