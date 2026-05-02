// ─── PhaserVisualizerCanvas.jsx ───────────────────────────────────────────────
// Self-contained canvas visualiser for the bespoke Phaser panel.
// Draws an animated log-frequency response: a flat dry baseline with sweeping
// notch dips (phase-cancellation bands) moving inside the selected sweep range.
//
// Data source: param-driven only. No engine data, no IPC calls.
//
// Lifecycle note:
//   PhaserPanel returns null when target is null, which fully unmounts this
//   component. React calls the useEffect cleanup → cancelled = true +
//   cancelAnimationFrame → zero background animation after close.

import { useEffect, useRef } from 'react'

// ── Pure helpers (exported for unit tests) ───────────────────────────────────

const AXIS_FREQ_MIN = 20
const AXIS_FREQ_MAX = 16000

/**
 * Maps a frequency (Hz) to an x position within [0, drawW] using a log axis
 * spanning AXIS_FREQ_MIN–AXIS_FREQ_MAX. Frequency is clamped before mapping.
 */
export function freqToX(freq, drawW) {
  const logMin = Math.log(AXIS_FREQ_MIN)
  const logMax = Math.log(AXIS_FREQ_MAX)
  const clamped = Math.max(AXIS_FREQ_MIN, Math.min(AXIS_FREQ_MAX, Number(freq)))
  return ((Math.log(clamped) - logMin) / (logMax - logMin)) * drawW
}

/**
 * Clamps and orders freq_low / freq_high, enforcing a minimum 50 Hz gap.
 * Returns [safeLow, safeHigh].
 */
export function safeFreqBounds(lo, hi) {
  const lo2 = Math.max(AXIS_FREQ_MIN, Math.min(Number(lo), AXIS_FREQ_MAX - 50))
  const hi2 = Math.max(lo2 + 50, Math.min(Number(hi), AXIS_FREQ_MAX))
  return [lo2, hi2]
}

/**
 * Converts the stages value (2 | 4 | 6 | 8 | 10 | 12) to the number of
 * visible notch dips. A phaser with N all-pass stages produces N/2 notches.
 */
export function stagesToNotchCount(stages) {
  return Math.max(1, Math.round(Number(stages) / 2))
}

/**
 * Returns the normalised magnitude (0–1) and sign of feedback.
 * The full parameter range is ±95 %, so magnitude = |feedback| / 95.
 */
export function normalizeFeedback(feedback) {
  const fb = Number(feedback)
  return { magnitude: Math.min(1, Math.abs(fb) / 95), sign: fb < 0 ? -1 : 1 }
}

/** Clamps a value to [0, 1]. */
export function clamp01(v) {
  return Math.max(0, Math.min(1, Number(v)))
}

/**
 * Converts a rate in Hz to angular velocity in rad/ms.
 * Multiply by elapsed ms to get the total angle swept.
 */
export function rateToAngVel(rateHz) {
  return (2 * Math.PI * Math.max(0.01, Number(rateHz))) / 1000
}

// ── Private helpers ───────────────────────────────────────────────────────────

// Pre-compute log-axis constants once at module load.
const LOG_AXIS_MIN   = Math.log(AXIS_FREQ_MIN)
const LOG_AXIS_RANGE = Math.log(AXIS_FREQ_MAX) - LOG_AXIS_MIN

/** Gaussian notch: returns 0–1 (1 = full cancellation at the notch centre). */
function gaussianNotch(logFreq, logCenter, sigma) {
  const d = (logFreq - logCenter) / sigma
  return Math.exp(-0.5 * d * d)
}

function readTheme(canvas) {
  const cs  = canvas ? getComputedStyle(canvas) : null
  const get = (k, fb) => { const v = cs?.getPropertyValue(k)?.trim(); return v || fb }
  return { bgInset: get('--theme-bg-inset', '#0d0d14') }
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function PhaserVisualizerCanvas({ params }) {
  const canvasRef = useRef(null)
  const paramsRef = useRef(params)
  const rafRef    = useRef(0)

  // Keep latest params readable on every frame without restarting the rAF loop.
  paramsRef.current = params

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return

    let cancelled = false
    const t0 = performance.now()

    // Pre-allocate sample arrays to avoid per-frame heap allocation.
    const MAX_SAMPLES = 700
    const samplesL    = new Float32Array(MAX_SAMPLES)
    const samplesR    = new Float32Array(MAX_SAMPLES)

    function draw(now) {
      if (cancelled) return

      const p = paramsRef.current

      // ── DPR-aware backing-store resize ────────────────────────────────────
      const dpr  = Math.max(1, window.devicePixelRatio || 1)
      const rect = canvas.getBoundingClientRect()
      const cssW = rect.width  > 0 ? rect.width  : 480
      const cssH = rect.height > 0 ? rect.height : 200
      const tw   = Math.round(cssW * dpr)
      const th   = Math.round(cssH * dpr)
      if (canvas.width !== tw || canvas.height !== th) {
        canvas.width  = tw
        canvas.height = th
      }

      const ctx = canvas.getContext('2d', { alpha: false })
      if (!ctx) { rafRef.current = requestAnimationFrame(draw); return }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)

      const t = now - t0
      const { bgInset } = readTheme(canvas)

      // ── Param → visual quantities ─────────────────────────────────────────
      const rate   = Math.max(0.01, p.rate      ?? 0.5)
      const depthN = clamp01((p.depth    ?? 80) / 100)
      const freqLo = p.freq_low  ?? 100
      const freqHi = p.freq_high ?? 4000
      const widthN = clamp01((p.width    ?? 50) / 100)
      const mixN   = clamp01((p.mix      ?? 50) / 100)
      const stages = p.stages    ?? 6
      const fb     = p.feedback  ?? 40

      const [safeFreqLo, safeFreqHi] = safeFreqBounds(freqLo, freqHi)
      const notchCount = stagesToNotchCount(stages)
      const { magnitude: fbMag, sign: fbSign } = normalizeFeedback(fb)
      const angVel = rateToAngVel(rate)

      // Width: phase offset between L and R sweep oscillators.
      // At width=100 % the two channels are ~π/2 out of phase.
      const widthPhase = widthN * (Math.PI * 0.65)

      // Notch sigma: bandwidth in log-freq space (slightly wider at high depth).
      const notchSigma = 0.17 + depthN * 0.11
      // Notch depth: fraction of maxDip (small minimum so the UI stays readable).
      const notchDepth = 0.15 + depthN * 0.82
      // Mix drives overall wet-layer opacity.
      const wetAlpha = 0.22 + mixN * 0.78

      // ── Layout constants ──────────────────────────────────────────────────
      const PAD_X   = 12
      const PAD_TOP = 7
      const LABEL_H = 15   // Hz-label strip below response area
      const STERO_H = 17   // stereo-indicator strip at very bottom
      const padBot  = LABEL_H + STERO_H + 2

      const drawX0 = PAD_X
      const drawX1 = cssW - PAD_X
      const drawW  = drawX1 - drawX0

      const respTop = PAD_TOP
      const respBot = cssH - padBot
      const respH   = respBot - respTop

      // Baseline = "full signal" reference line.  Notches dip downward from it.
      const baseline = respTop + respH * 0.41
      const maxDip   = (respBot - baseline) * 0.87

      // Convenience: freq → canvas x (within the draw area).
      const fToX = (f) => drawX0 + freqToX(f, drawW)

      // ── Background ───────────────────────────────────────────────────────
      ctx.fillStyle = bgInset
      ctx.fillRect(0, 0, cssW, cssH)

      // Warm amber radial glow
      const ambG = ctx.createRadialGradient(
        cssW * 0.46, cssH * 0.38, 0,
        cssW * 0.46, cssH * 0.38, cssW * 0.60
      )
      ambG.addColorStop(0,    'rgba(155, 90,  5, 0.11)')
      ambG.addColorStop(0.45, 'rgba( 70, 35, 90, 0.05)')
      ambG.addColorStop(1,    'rgba(  0,  0,  0, 0)')
      ctx.fillStyle = ambG
      ctx.fillRect(0, 0, cssW, cssH)

      // Cool purple offset glow (upper-right)
      const purG = ctx.createRadialGradient(
        cssW * 0.68, cssH * 0.28, 0,
        cssW * 0.68, cssH * 0.28, cssW * 0.44
      )
      purG.addColorStop(0, 'rgba(55, 18, 108, 0.08)')
      purG.addColorStop(1, 'rgba( 0,  0,   0, 0)')
      ctx.fillStyle = purG
      ctx.fillRect(0, 0, cssW, cssH)

      // Corner vignette
      const vigG = ctx.createRadialGradient(
        cssW * 0.5, cssH * 0.5, Math.min(cssW, cssH) * 0.20,
        cssW * 0.5, cssH * 0.5, Math.max(cssW, cssH) * 0.80
      )
      vigG.addColorStop(0, 'rgba(0,0,0,0)')
      vigG.addColorStop(1, 'rgba(0,0,0,0.32)')
      ctx.fillStyle = vigG
      ctx.fillRect(0, 0, cssW, cssH)

      // ── Sweep range band ──────────────────────────────────────────────────
      const bandX0 = fToX(safeFreqLo)
      const bandX1 = fToX(safeFreqHi)

      const bandG = ctx.createLinearGradient(bandX0, 0, bandX1, 0)
      bandG.addColorStop(0,   'rgba(210, 120, 20, 0.05)')
      bandG.addColorStop(0.5, 'rgba(130,  55, 190, 0.07)')
      bandG.addColorStop(1,   'rgba(210, 120, 20, 0.05)')
      ctx.fillStyle = bandG
      ctx.fillRect(bandX0, respTop, bandX1 - bandX0, respBot - respTop)

      // Band edge tick markers
      ctx.save()
      ctx.strokeStyle = 'rgba(200, 128, 28, 0.20)'
      ctx.lineWidth   = 1
      ctx.setLineDash([3, 5])
      ctx.beginPath()
      ctx.moveTo(bandX0, respTop); ctx.lineTo(bandX0, respBot)
      ctx.moveTo(bandX1, respTop); ctx.lineTo(bandX1, respBot)
      ctx.stroke()
      ctx.setLineDash([])
      ctx.restore()

      // ── Frequency grid (very faint) ───────────────────────────────────────
      ctx.save()
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.03)'
      ctx.lineWidth   = 1
      for (const f of [50, 100, 200, 500, 1000, 2000, 4000, 8000]) {
        const gx = fToX(f)
        ctx.beginPath(); ctx.moveTo(gx, respTop); ctx.lineTo(gx, respBot); ctx.stroke()
      }
      ctx.restore()

      // ── Compute notch log-centres for L and R channels ────────────────────
      const logSweepLo    = Math.log(safeFreqLo)
      const logSweepRange = Math.log(safeFreqHi) - logSweepLo

      const notchLogL = []
      const notchLogR = []
      for (let i = 0; i < notchCount; i++) {
        const phi    = t * angVel + (i * (2 * Math.PI / notchCount))
        const sweepL = 0.5 + 0.5 * Math.sin(phi)
        const sweepR = 0.5 + 0.5 * Math.sin(phi + widthPhase)
        notchLogL.push(logSweepLo + sweepL * logSweepRange)
        notchLogR.push(logSweepLo + sweepR * logSweepRange)
      }

      // ── Sample response curves across the frequency axis ──────────────────
      const STEPS = Math.min(MAX_SAMPLES, Math.ceil(drawW))
      for (let s = 0; s < STEPS; s++) {
        // Map sample index to log frequency linearly across the full axis.
        const logF = LOG_AXIS_MIN + (s / STEPS) * LOG_AXIS_RANGE
        let dipL = 0, dipR = 0
        for (let i = 0; i < notchCount; i++) {
          dipL += gaussianNotch(logF, notchLogL[i], notchSigma)
          dipR += gaussianNotch(logF, notchLogR[i], notchSigma)
        }
        samplesL[s] = notchDepth * Math.min(1, dipL)
        samplesR[s] = notchDepth * Math.min(1, dipR)
      }

      // ── R channel — purple, drawn first (behind L) ────────────────────────
      ctx.save()
      ctx.globalAlpha = wetAlpha * 0.72

      // Fill: from baseline down into the notch dip.
      ctx.beginPath()
      ctx.moveTo(drawX0, baseline)
      for (let s = 0; s < STEPS; s++) {
        ctx.lineTo(drawX0 + (s / STEPS) * drawW, baseline + samplesR[s] * maxDip)
      }
      ctx.lineTo(drawX1, baseline)
      ctx.closePath()

      const rFill = ctx.createLinearGradient(0, baseline, 0, baseline + maxDip)
      if (fbSign < 0) {
        rFill.addColorStop(0, `rgba(110, 50, 200, ${0.14 + fbMag * 0.14})`)
        rFill.addColorStop(1, `rgba( 50, 18, 130, 0.02)`)
      } else {
        rFill.addColorStop(0, `rgba( 90, 42, 175, 0.13)`)
        rFill.addColorStop(1, `rgba( 45, 16, 110, 0.02)`)
      }
      ctx.fillStyle = rFill
      ctx.fill()

      // R channel stroke
      ctx.globalAlpha = wetAlpha * 0.55
      ctx.beginPath()
      for (let s = 0; s < STEPS; s++) {
        const x = drawX0 + (s / STEPS) * drawW
        const y = baseline + samplesR[s] * maxDip
        s === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)
      }
      if (fbSign < 0) {
        ctx.shadowBlur  = 3 + fbMag * 9
        ctx.shadowColor = 'rgba(120, 55, 220, 0.65)'
      }
      ctx.strokeStyle = 'rgba(140, 75, 225, 0.55)'
      ctx.lineWidth   = 1.2
      ctx.stroke()
      ctx.restore()

      // ── L channel — amber, drawn on top ───────────────────────────────────
      ctx.save()
      ctx.globalAlpha = wetAlpha

      ctx.beginPath()
      ctx.moveTo(drawX0, baseline)
      for (let s = 0; s < STEPS; s++) {
        ctx.lineTo(drawX0 + (s / STEPS) * drawW, baseline + samplesL[s] * maxDip)
      }
      ctx.lineTo(drawX1, baseline)
      ctx.closePath()

      const lFill = ctx.createLinearGradient(0, baseline, 0, baseline + maxDip)
      if (fbSign >= 0) {
        lFill.addColorStop(0, `rgba(220, 128, 10, ${0.20 + fbMag * 0.18})`)
        lFill.addColorStop(1, `rgba(130,  60,  4, 0.03)`)
      } else {
        lFill.addColorStop(0, `rgba(180, 100, 12, 0.16)`)
        lFill.addColorStop(1, `rgba(100,  50,  4, 0.02)`)
      }
      ctx.fillStyle = lFill
      ctx.fill()

      // L channel stroke
      ctx.globalAlpha = wetAlpha * 0.90
      ctx.beginPath()
      for (let s = 0; s < STEPS; s++) {
        const x = drawX0 + (s / STEPS) * drawW
        const y = baseline + samplesL[s] * maxDip
        s === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)
      }
      if (fbSign >= 0) {
        ctx.shadowBlur  = 4 + fbMag * 12
        ctx.shadowColor = `rgba(255, 175, 28, ${0.35 + fbMag * 0.45})`
      } else {
        ctx.shadowBlur  = 2 + fbMag * 5
        ctx.shadowColor = 'rgba(200, 130, 20, 0.30)'
      }
      ctx.strokeStyle = fbSign >= 0
        ? `rgba(255, 188, 42, ${0.72 + fbMag * 0.28})`
        : 'rgba(200, 142, 22, 0.65)'
      ctx.lineWidth = 1.6
      ctx.stroke()
      ctx.restore()

      // ── Dry baseline line ─────────────────────────────────────────────────
      ctx.save()
      const blG = ctx.createLinearGradient(drawX0, 0, drawX1, 0)
      blG.addColorStop(0,    'rgba(255, 202, 75, 0)')
      blG.addColorStop(0.10, 'rgba(255, 202, 75, 0.32)')
      blG.addColorStop(0.50, 'rgba(255, 215, 85, 0.38)')
      blG.addColorStop(0.90, 'rgba(255, 202, 75, 0.32)')
      blG.addColorStop(1,    'rgba(255, 202, 75, 0)')
      ctx.strokeStyle = blG
      ctx.lineWidth   = 0.9
      ctx.beginPath()
      ctx.moveTo(drawX0, baseline)
      ctx.lineTo(drawX1, baseline)
      ctx.stroke()
      ctx.restore()

      // ── Positive-feedback resonance spikes above the baseline ─────────────
      // At high positive feedback, a real phaser develops a small resonant peak
      // just outside the notch. Visualised as a narrow amber spike rising above
      // the baseline at each L-channel notch centre.
      if (fbSign >= 0 && fbMag > 0.06) {
        const spikeH = maxDip * 0.13 * fbMag
        for (let i = 0; i < notchCount; i++) {
          const lcX = drawX0 + freqToX(Math.exp(notchLogL[i]), drawW)
          ctx.save()
          ctx.globalAlpha = wetAlpha * fbMag * 0.55
          ctx.shadowBlur  = 7 + fbMag * 10
          ctx.shadowColor = 'rgba(255, 185, 32, 0.85)'
          const spkG = ctx.createLinearGradient(0, baseline - spikeH, 0, baseline)
          spkG.addColorStop(0, 'rgba(255, 235, 90, 0.90)')
          spkG.addColorStop(1, 'rgba(255, 170, 22, 0.05)')
          ctx.fillStyle = spkG
          ctx.fillRect(lcX - 1.2, baseline - spikeH, 2.4, spikeH)
          ctx.restore()
        }
      }

      // ── Frequency tick labels ─────────────────────────────────────────────
      const LABEL_FREQS = [20,    100,   1000, 4000, 16000]
      const LABEL_TEXTS = ['20', '100',  '1k', '4k', '16k']
      ctx.save()
      ctx.font         = '9px system-ui, sans-serif'
      ctx.textAlign    = 'center'
      ctx.textBaseline = 'top'
      ctx.fillStyle    = 'rgba(175, 155, 215, 0.35)'
      for (let i = 0; i < LABEL_FREQS.length; i++) {
        ctx.fillText(LABEL_TEXTS[i], fToX(LABEL_FREQS[i]), respBot + 3)
      }
      ctx.restore()

      // ── Stereo width indicator (bottom strip) ─────────────────────────────
      // Amber = L channel, purple = R channel.  Spread driven by width param.
      const indY     = cssH - STERO_H * 0.5 - 1
      const indSpan  = drawW * 0.30
      const indCX    = drawX0 + drawW * 0.5
      const indLX    = indCX - indSpan * widthN
      const indRX    = indCX + indSpan * widthN
      const indR     = 2.5 + depthN * 1.5
      const indAlpha = 0.28 + mixN * 0.45

      // Guide line
      ctx.save()
      ctx.strokeStyle = 'rgba(190, 170, 225, 0.07)'
      ctx.lineWidth   = 1
      ctx.beginPath()
      ctx.moveTo(indCX - indSpan * 1.08, indY)
      ctx.lineTo(indCX + indSpan * 1.08, indY)
      ctx.stroke()
      ctx.restore()

      // L node (amber)
      ctx.save()
      ctx.globalAlpha = indAlpha
      ctx.shadowBlur  = 4 + depthN * 3
      ctx.shadowColor = 'rgba(240, 162, 20, 0.70)'
      const lgG = ctx.createRadialGradient(indLX, indY, 0, indLX, indY, indR * 2.2)
      lgG.addColorStop(0, 'rgba(255, 215, 80, 0.95)')
      lgG.addColorStop(1, 'rgba(205, 120, 12, 0)')
      ctx.fillStyle = lgG
      ctx.beginPath(); ctx.arc(indLX, indY, indR, 0, Math.PI * 2); ctx.fill()
      ctx.restore()

      // R node (purple)
      ctx.save()
      ctx.globalAlpha = indAlpha
      ctx.shadowBlur  = 4 + depthN * 3
      ctx.shadowColor = 'rgba(142, 80, 220, 0.70)'
      const rgG = ctx.createRadialGradient(indRX, indY, 0, indRX, indY, indR * 2.2)
      rgG.addColorStop(0, 'rgba(212, 158, 255, 0.95)')
      rgG.addColorStop(1, 'rgba(102,  52, 182, 0)')
      ctx.fillStyle = rgG
      ctx.beginPath(); ctx.arc(indRX, indY, indR, 0, Math.PI * 2); ctx.fill()
      ctx.restore()

      rafRef.current = requestAnimationFrame(draw)
    }

    rafRef.current = requestAnimationFrame(draw)

    // Cleanup: both guards together ensure no drawing occurs after unmount —
    // cancelled = true stops the in-flight guard; cancelAnimationFrame drops
    // the already-queued-but-not-yet-fired next call.
    return () => {
      cancelled = true
      cancelAnimationFrame(rafRef.current)
    }
  }, []) // Empty deps — all per-frame data flows through paramsRef.current.

  return (
    <canvas
      ref={canvasRef}
      className="phaser-viz-canvas"
      style={{ display: 'block', width: '100%', height: '100%' }}
    />
  )
}
