// ─── PhanjerResponseCanvas.jsx ───────────────────────────────────────────────
// Full-width strip under the panel header that draws BOTH comb responses vs a
// log-frequency axis, purely as a function of the current params — no audio data
// and no IPC. It is a static picture that redraws whenever a param changes (the
// effect below re-runs on every `params` object identity change) plus on resize.
//
// The two curves mirror the engine's analytic feature sets (PhanjerEffect.h §3/§5):
//
//   FLANGER — an IIR comb evaluated at the sweep MIDPOINT delay dF (the geometric
//   centre of [delay_min, delay_max], which is where the sweep parks at depth 0).
//   |H(f)| = 1 / sqrt(1 − 2g·cos(2π f dF) + g²) with g = f_feedback/100. Peaks
//   land at k/dF, notches at (k+½)/dF; negative feedback swaps the two, exactly
//   as the comb formula does on its own.
//
//   PHASER — N second-order allpass notches at the centre-position stage
//   frequencies (computeStageFreqs with sweep s = 0), with feedback-driven
//   resonant peaks at the geometric midpoints between adjacent notches. Negative
//   feedback swaps notch/peak roles.
//
// Collision zones (peak-peak or notch-notch pairs within ⅓ octave — the engine's
// guard band) are highlighted with a vertical band at the coincidence frequency,
// after the same negative-feedback role swap the engine applies before pairing.
//
// Lifecycle: PhanjerPanel returns null when target is null, unmounting this
// component; the effect cleanup cancels the pending frame and disconnects the
// observer, so nothing runs while the panel is closed.

import { useEffect, useRef } from 'react'
import { clamp, freqToNorm } from './mixerFilterMath.js'
import { withAlpha, readMixerCanvasTheme, syncCanvasSize, MONO_SM } from './mixerCanvasTheme.js'

// ── Axis + engine constants (mirror PhanjerEffect.h) ─────────────────────────
const AXIS_FREQ_MIN = 20
const AXIS_FREQ_MAX = 20000
const FEATURE_CEILING_HZ = 8000       // §5 kFeatureCeilingHz
const GUARD_BAND_OCT = 0.333333       // §5 ⅓-octave guard band
const MAX_COMB_FEATURES = 8           // §5 kMaxCombFeatures
const MAX_STAGES = 6
const MIN_DELAY_MS = 0.1
const MAX_DELAY_MS = 20.0
const NOMINAL_SR = 48000              // only used for the stage-freq high clamp

// ── Pure helpers (exported for unit tests) ────────────────────────────────────

/** Log sweep midpoint delay in ms: d = sqrt(lo·hi). Mirrors computeDelayMs(0.5). */
export function centerDelayMs(delayMin, delayMax) {
  const lo = clamp(Math.min(delayMin, delayMax), MIN_DELAY_MS, MAX_DELAY_MS)
  const hi = clamp(Math.max(delayMin, delayMax), MIN_DELAY_MS, MAX_DELAY_MS)
  if (hi <= lo * 1.000001) return lo
  return Math.sqrt(lo * hi)
}

/**
 * Centre-position (sweep s = 0) allpass stage frequencies. Mirrors
 * PhanjerEffect::computeStageFreqs with sweepS = 0 and the fixed ±0.5 stagger.
 */
export function stageFreqs(freqMin, freqMax, numStages) {
  const lo = Math.max(20, Math.min(freqMin, freqMax))
  const hi = Math.max(lo * 1.01, Math.max(freqMin, freqMax))
  const c = Math.sqrt(lo * hi)
  const halfRangeLog = Math.log(hi / c)
  const n = clamp(Math.round(numStages), 1, MAX_STAGES)
  const out = []
  for (let i = 0; i < n; i++) {
    const stageT = n > 1 ? i / (n - 1) - 0.5 : 0
    const f = c * Math.exp(0.5 * stageT * halfRangeLog)
    out.push(clamp(f, 20, NOMINAL_SR * 0.499))
  }
  return out
}

/**
 * Flanger comb + notch feature sets up to the 8 kHz ceiling, with the
 * negative-feedback role swap applied (§5). Returns { peaks, notches }.
 */
export function flangerFeatures(delaySec, feedback) {
  const rawPeaks = []
  const rawNotches = []
  if (delaySec > 1e-9) {
    const f0 = 1 / delaySec
    for (let k = 1; k <= MAX_COMB_FEATURES; k++) {
      const f = k * f0
      if (f >= FEATURE_CEILING_HZ) break
      rawPeaks.push(f)
    }
    for (let k = 0; k < MAX_COMB_FEATURES; k++) {
      const f = (k + 0.5) * f0
      if (f >= FEATURE_CEILING_HZ) break
      rawNotches.push(f)
    }
  }
  // Negative feedback flips which frequencies reinforce (§5, DO NOT #4).
  return feedback < 0
    ? { peaks: rawNotches, notches: rawPeaks }
    : { peaks: rawPeaks, notches: rawNotches }
}

/**
 * Phaser notch + feedback-peak feature sets, with the negative-feedback swap.
 * PN = stage freqs, PP = sqrt(f_i·f_{i+1}). Returns { peaks, notches }.
 */
export function phaserFeatures(freqs, feedback) {
  const notches = freqs.slice()
  const peaks = []
  for (let i = 0; i + 1 < notches.length; i++) {
    peaks.push(Math.sqrt(notches[i] * notches[i + 1]))
  }
  return feedback < 0 ? { peaks: notches, notches: peaks } : { peaks, notches }
}

/**
 * Collision frequencies where a flanger feature coincides with a phaser feature
 * of the same class (peak-peak or notch-notch) within the ⅓-octave guard band.
 * Returns the geometric-mean frequency of each colliding pair.
 */
export function collisionFreqs(fl, ph) {
  const hits = []
  const scan = (a, b) => {
    for (const fa of a) {
      for (const fb of b) {
        if (fa <= 0 || fb <= 0) continue
        if (Math.abs(Math.log2(fa / fb)) < GUARD_BAND_OCT) {
          hits.push(Math.sqrt(fa * fb))
        }
      }
    }
  }
  scan(fl.peaks, ph.peaks)
  scan(fl.notches, ph.notches)
  return hits
}

// ── Private curve models ──────────────────────────────────────────────────────

/** IIR-comb magnitude in dB at frequency f (Hz) for delay dF (s), feedback g. */
function flangerDb(freqHz, delaySec, g) {
  const w = 2 * Math.PI * freqHz * delaySec
  const denom = Math.max(1e-4, 1 - 2 * g * Math.cos(w) + g * g)
  return 20 * Math.log10(1 / Math.sqrt(denom))
}

/** Gaussian bump/dip in log-freq space, 1 at centre falling off by `sigma`. */
function logBump(logF, logCenter, sigma) {
  const d = (logF - logCenter) / sigma
  return Math.exp(-0.5 * d * d)
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function PhanjerResponseCanvas({ params }) {
  const canvasRef = useRef(null)
  const paramsRef = useRef(params)
  paramsRef.current = params

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return

    let raf = 0

    function draw() {
      raf = 0
      const p = paramsRef.current
      const size = syncCanvasSize(canvas, 460, 90)
      if (!size) return
      const { cssW, cssH, dpr } = size
      const ctx = canvas.getContext('2d', { alpha: false })
      if (!ctx) return
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)

      const th = readMixerCanvasTheme(canvas)
      // Per-column accents — read from the live computed style so a theme swap
      // repaints correctly; never a hardcoded hex (never at module scope).
      const cs = typeof getComputedStyle === 'function' ? getComputedStyle(canvas) : null
      const flAccent = (cs?.getPropertyValue('--theme-mod-phanjer-flanger')?.trim()) || th.accent
      const phAccent = (cs?.getPropertyValue('--theme-mod-phanjer-phaser')?.trim()) || th.text

      // ── Param → quantities ────────────────────────────────────────────────
      const fFb = Number(p.f_feedback ?? 40)
      const pFb = Number(p.p_feedback ?? 40)
      const gF = clamp(fFb / 100, -0.95, 0.95)
      const delaySec = centerDelayMs(Number(p.f_delay_min ?? 1), Number(p.f_delay_max ?? 5)) / 1000
      const stages = stageFreqs(Number(p.p_freq_min ?? 100), Number(p.p_freq_max ?? 4000), p.p_stages ?? 6)
      const pFbMag = clamp(Math.abs(pFb) / 95, 0, 1)

      const fl = flangerFeatures(delaySec, fFb)
      const ph = phaserFeatures(stages, pFb)
      const collisions = collisionFreqs(fl, ph)

      // ── Layout ─────────────────────────────────────────────────────────────
      const PAD_X = 8
      const LABEL_H = 11
      const x0 = PAD_X
      const x1 = cssW - PAD_X
      const drawW = x1 - x0
      const top = 6
      const bot = cssH - LABEL_H
      const midY = (top + bot) / 2
      const halfH = (bot - top) / 2
      const DB_SPAN = 14 // ± dB mapped to ± halfH

      const fToX = (f) => x0 + freqToNorm(f, AXIS_FREQ_MIN, AXIS_FREQ_MAX) * drawW
      const dbToY = (db) => midY - clamp(db / DB_SPAN, -1, 1) * halfH

      // ── Background ─────────────────────────────────────────────────────────
      ctx.fillStyle = th.well
      ctx.fillRect(0, 0, cssW, cssH)

      // ── Collision highlight bands (drawn behind the curves) ────────────────
      for (const cf of collisions) {
        const cx = fToX(cf)
        const bandW = Math.max(3, drawW * (GUARD_BAND_OCT / Math.log2(AXIS_FREQ_MAX / AXIS_FREQ_MIN)))
        ctx.fillStyle = withAlpha(th.accent, 0.16)
        ctx.fillRect(cx - bandW / 2, top, bandW, bot - top)
        ctx.strokeStyle = withAlpha(th.accent, 0.6)
        ctx.lineWidth = 1
        ctx.beginPath()
        ctx.moveTo(Math.round(cx) + 0.5, top)
        ctx.lineTo(Math.round(cx) + 0.5, bot)
        ctx.stroke()
      }

      // ── Frequency grid ─────────────────────────────────────────────────────
      ctx.strokeStyle = withAlpha(th.border, 0.85)
      ctx.lineWidth = 1
      ctx.beginPath()
      for (const f of [50, 100, 200, 500, 1000, 2000, 5000, 10000]) {
        const gx = Math.round(fToX(f)) + 0.5
        ctx.moveTo(gx, top)
        ctx.lineTo(gx, bot)
      }
      ctx.stroke()

      // ── 0 dB baseline ──────────────────────────────────────────────────────
      const baseY = Math.round(midY) + 0.5
      ctx.strokeStyle = withAlpha(th.borderStrong, 1)
      ctx.beginPath()
      ctx.moveTo(x0, baseY)
      ctx.lineTo(x1, baseY)
      ctx.stroke()

      const STEPS = Math.max(2, Math.min(700, Math.ceil(drawW)))
      const logAxisMin = Math.log(AXIS_FREQ_MIN)
      const logAxisRange = Math.log(AXIS_FREQ_MAX) - logAxisMin

      // ── Phaser curve — notches (dips) + feedback peaks (bumps) ─────────────
      // Modelled in dB: sum of gaussian dips at PN and bumps at PP, scaled by
      // the feedback magnitude so a flat 0 % feedback still shows the notches.
      const phMixN = clamp(Number(p.p_mix ?? 75) / 100, 0, 1)
      const notchDb = 6 + pFbMag * 6
      const peakDb = pFbMag * 8
      const sigma = 0.16
      ctx.beginPath()
      for (let s = 0; s < STEPS; s++) {
        const logF = logAxisMin + (s / (STEPS - 1)) * logAxisRange
        let db = 0
        for (const nf of ph.notches) db -= notchDb * logBump(logF, Math.log(nf), sigma)
        for (const pf of ph.peaks) db += peakDb * logBump(logF, Math.log(pf), sigma)
        const x = x0 + (s / (STEPS - 1)) * drawW
        const y = dbToY(db * phMixN)
        s === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)
      }
      ctx.strokeStyle = phAccent
      ctx.lineWidth = 1.5
      ctx.stroke()

      // ── Flanger curve — analytic IIR comb ──────────────────────────────────
      const flMixN = clamp(Number(p.f_mix ?? 75) / 100, 0, 1)
      ctx.beginPath()
      for (let s = 0; s < STEPS; s++) {
        const logF = logAxisMin + (s / (STEPS - 1)) * logAxisRange
        const f = Math.exp(logF)
        const db = flangerDb(f, delaySec, gF) * flMixN
        const x = x0 + (s / (STEPS - 1)) * drawW
        const y = dbToY(db)
        s === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)
      }
      ctx.strokeStyle = flAccent
      ctx.lineWidth = 1.5
      ctx.stroke()

      // ── Corner legend + axis labels ────────────────────────────────────────
      ctx.font = MONO_SM
      ctx.textBaseline = 'top'
      ctx.textAlign = 'left'
      ctx.fillStyle = flAccent
      ctx.fillText('FLANGER', x0 + 2, top + 1)
      ctx.textAlign = 'right'
      ctx.fillStyle = phAccent
      ctx.fillText('PHASER', x1 - 2, top + 1)

      ctx.textAlign = 'center'
      ctx.fillStyle = withAlpha(th.textSubtle, 0.9)
      const LABEL_FREQS = [100, 1000, 10000]
      const LABEL_TEXTS = ['100', '1k', '10k']
      for (let i = 0; i < LABEL_FREQS.length; i++) {
        ctx.fillText(LABEL_TEXTS[i], fToX(LABEL_FREQS[i]), bot + 2)
      }
    }

    const schedule = () => {
      if (!raf) raf = requestAnimationFrame(draw)
    }
    schedule()

    let ro = null
    if (typeof ResizeObserver !== 'undefined') {
      ro = new ResizeObserver(schedule)
      ro.observe(canvas)
    }

    return () => {
      if (raf) cancelAnimationFrame(raf)
      if (ro) ro.disconnect()
    }
  }, [params])

  return (
    <canvas
      ref={canvasRef}
      className="phanjer-response-canvas"
      style={{ display: 'block', width: '100%', height: '100%' }}
    />
  )
}
