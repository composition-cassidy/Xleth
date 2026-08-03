// ─── PhaserVisualizerCanvas.jsx ───────────────────────────────────────────────
// Flat, hard-edged log-frequency response for the Phaser panel: a dry baseline
// with sweeping notch dips (phase-cancellation bands) moving inside the sweep
// range. The sweep range itself is the control surface for freq_low/freq_high —
// its edges are draggable directly on the canvas, following the same
// grab-relative interaction contract as DelayFilterCurve:
//
//   pointerdown  grabs the nearer edge and records the grab offset — the value
//                never jumps to the click point
//   pointermove  previews locally (onPreview) so the band tracks the pointer
//   pointerup    commits the final value (onCommit) — pointer capture means
//                this still fires if the pointer leaves the window
//
// Unlike DelayFilterCurve this canvas also runs a continuous rAF loop (the
// notch sweep animates), so drag state lives in refs rather than React state —
// the loop already repaints every frame regardless, and refs give the dragged
// edge zero-lag feedback without waiting on a React round trip.
//
// Data source: param-driven only. No engine data, no IPC calls except the
// freq_low/freq_high writes made through onPreview/onCommit.
//
// Lifecycle note:
//   PhaserPanel returns null when target is null, which fully unmounts this
//   component. React calls the useEffect cleanup → cancelled = true +
//   cancelAnimationFrame → zero background animation after close.

import { useEffect, useRef, useCallback } from 'react'
import { clamp, freqToNorm, normToFreq, pickFilterHandle, formatHz } from './mixerFilterMath.js'
import { withAlpha, readMixerCanvasTheme, syncCanvasSize, MONO, MONO_SM } from './mixerCanvasTheme.js'

// ── Pure helpers (exported for unit tests) ───────────────────────────────────

// Display axis — spans the union of both params' engine ranges so the whole
// sweep band is always on-screen.
const AXIS_FREQ_MIN = 20
const AXIS_FREQ_MAX = 16000

// Each handle's own engine range (XlethPhaserEffect.h). These are narrower
// than the display axis — freq_low tops out at 2000 Hz, freq_high starts at
// 200 Hz — so a handle can be dragged well past its legal range on-screen; the
// engine would silently re-clamp an out-of-range write, producing a value the
// panel never showed the user. Every drag must clamp to these, not just the
// shared axis.
const LO_MIN = 20
const LO_MAX = 2000
const HI_MIN = 200
const HI_MAX = 16000
const MIN_GAP_HZ = 50
const PAD_X = 8

/**
 * Maps a frequency (Hz) to an x position within [0, drawW] using a log axis
 * spanning AXIS_FREQ_MIN–AXIS_FREQ_MAX. Frequency is clamped before mapping.
 */
export function freqToX(freq, drawW) {
  return freqToNorm(Number(freq), AXIS_FREQ_MIN, AXIS_FREQ_MAX) * drawW
}

/**
 * Clamps and orders freq_low / freq_high to their own engine ranges, then
 * enforces a minimum 50 Hz gap between them. Returns [safeLow, safeHigh].
 */
export function safeFreqBounds(lo, hi) {
  const lo2 = clamp(Number(lo), LO_MIN, LO_MAX)
  const hi2 = clamp(Number(hi), Math.max(HI_MIN, lo2 + MIN_GAP_HZ), HI_MAX)
  return [lo2, hi2]
}

/**
 * Converts the stages value (1–6) to the number of visible notch dips.
 * The engine's stages param is a count of second-order allpass stages, and
 * each second-order stage produces exactly one notch — so notchCount is
 * stages itself (XlethPhaserEffect.h: "1–6 number of second-order allpass
 * stages (= number of notches)"), not stages/2.
 */
export function stagesToNotchCount(stages) {
  return Math.max(1, Math.min(6, Math.round(Number(stages))))
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

/** Gaussian notch: returns 0–1 (1 = full cancellation at the notch centre). */
function gaussianNotch(logFreq, logCenter, sigma) {
  const d = (logFreq - logCenter) / sigma
  return Math.exp(-0.5 * d * d)
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function PhaserVisualizerCanvas({ params, onPreview, onCommit }) {
  const canvasRef = useRef(null)
  const paramsRef = useRef(params)
  const rafRef    = useRef(0)

  // Drag/hover state lives in refs, not React state — the rAF loop already
  // repaints every frame, so a ref read there is zero-lag and needs no extra
  // re-renders.
  const dragRef  = useRef(null) // { handle: 'lo' | 'hi', offsetNorm }
  const hoverRef = useRef(null) // 'lo' | 'hi' | null
  const liveRef  = useRef({ lo: params.freq_low ?? 100, hi: params.freq_high ?? 4000 })

  // Keep latest params readable on every frame without restarting the rAF loop.
  paramsRef.current = params
  // liveRef is the drag source of truth; only resync it from props between
  // drags (mid-drag, the pointer handlers below are the only writer).
  if (!dragRef.current) {
    liveRef.current = { lo: params.freq_low ?? 100, hi: params.freq_high ?? 4000 }
  }

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return

    let cancelled = false
    const t0 = performance.now()

    const MAX_SAMPLES = 700
    const samplesL = new Float32Array(MAX_SAMPLES)
    const samplesR = new Float32Array(MAX_SAMPLES)

    function draw(now) {
      if (cancelled) return

      const p = paramsRef.current
      const { cssW, cssH, dpr } = syncCanvasSize(canvas, 420, 176)
      const ctx = canvas.getContext('2d', { alpha: false })
      if (!ctx) { rafRef.current = requestAnimationFrame(draw); return }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)

      const th = readMixerCanvasTheme(canvas)
      const t = now - t0

      // ── Param → visual quantities ─────────────────────────────────────────
      const rate   = clamp(p.rate   ?? 0.5, 0.05, 5)
      const depthN = clamp01((p.depth ?? 80) / 100)
      const widthN = clamp01((p.width ?? 50) / 100)
      const mixN   = clamp01((p.mix   ?? 50) / 100)
      const stages = p.stages   ?? 6
      const fb     = p.feedback ?? 40

      const [freqLo, freqHi] = safeFreqBounds(liveRef.current.lo, liveRef.current.hi)
      const notchCount = stagesToNotchCount(stages)
      const { magnitude: fbMag, sign: fbSign } = normalizeFeedback(fb)
      const angVel = rateToAngVel(rate)

      // Width: phase offset between L and R sweep oscillators.
      const widthPhase = widthN * (Math.PI * 0.65)
      // Notch sigma: bandwidth in log-freq space (slightly wider at high depth).
      const notchSigma = 0.15 + depthN * 0.10
      // Notch depth: fraction of maxDip (small minimum so the UI stays readable).
      const notchDepth = 0.15 + depthN * 0.80
      // Mix drives overall wet-layer opacity.
      const wetAlpha = 0.25 + mixN * 0.75

      // ── Layout — fills the stage edge to edge ─────────────────────────────
      const LABEL_H = 13
      const drawX0 = PAD_X
      const drawX1 = cssW - PAD_X
      const drawW  = drawX1 - drawX0
      const respTop = 12
      const respBot = cssH - LABEL_H
      const respH   = respBot - respTop
      const baseline = respTop + respH * 0.42
      const maxDip   = (respBot - baseline) * 0.90

      const fToX = (f) => drawX0 + freqToX(f, drawW)

      // ── Background — flat, no gradients ───────────────────────────────────
      ctx.fillStyle = th.well
      ctx.fillRect(0, 0, cssW, cssH)

      // ── Sweep range band (the draggable control surface) ─────────────────
      const bandX0 = fToX(freqLo)
      const bandX1 = fToX(freqHi)
      ctx.fillStyle = withAlpha(th.accent, 0.07)
      ctx.fillRect(bandX0, respTop, bandX1 - bandX0, respH)

      // ── Frequency grid (flat, faint) ───────────────────────────────────────
      ctx.strokeStyle = withAlpha(th.border, 0.85)
      ctx.lineWidth = 1
      ctx.beginPath()
      for (const f of [50, 100, 200, 500, 1000, 2000, 5000, 10000]) {
        const gx = Math.round(fToX(f)) + 0.5
        ctx.moveTo(gx, respTop)
        ctx.lineTo(gx, respBot)
      }
      ctx.stroke()

      // ── Dry baseline ───────────────────────────────────────────────────────
      const baseY = Math.round(baseline) + 0.5
      ctx.strokeStyle = withAlpha(th.borderStrong, 1)
      ctx.lineWidth = 1
      ctx.beginPath()
      ctx.moveTo(drawX0, baseY)
      ctx.lineTo(drawX1, baseY)
      ctx.stroke()

      // ── Compute notch log-centres for L and R channels ────────────────────
      const logSweepLo    = Math.log(freqLo)
      const logSweepRange = Math.log(freqHi) - logSweepLo
      const logAxisMin    = Math.log(AXIS_FREQ_MIN)
      const logAxisRange  = Math.log(AXIS_FREQ_MAX) - logAxisMin

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
        const logF = logAxisMin + (s / STEPS) * logAxisRange
        let dipL = 0, dipR = 0
        for (let i = 0; i < notchCount; i++) {
          dipL += gaussianNotch(logF, notchLogL[i], notchSigma)
          dipR += gaussianNotch(logF, notchLogR[i], notchSigma)
        }
        samplesL[s] = notchDepth * Math.min(1, dipL)
        samplesR[s] = notchDepth * Math.min(1, dipR)
      }

      // ── R channel — accent at reduced alpha, drawn first (behind L) ───────
      // Single hue throughout: L/R are distinguished by opacity, not colour.
      ctx.save()
      ctx.globalAlpha = wetAlpha * 0.45
      ctx.beginPath()
      ctx.moveTo(drawX0, baseline)
      for (let s = 0; s < STEPS; s++) ctx.lineTo(drawX0 + (s / STEPS) * drawW, baseline + samplesR[s] * maxDip)
      ctx.lineTo(drawX1, baseline)
      ctx.closePath()
      ctx.fillStyle = withAlpha(th.accent, 0.16)
      ctx.fill()

      ctx.beginPath()
      for (let s = 0; s < STEPS; s++) {
        const x = drawX0 + (s / STEPS) * drawW
        const y = baseline + samplesR[s] * maxDip
        s === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)
      }
      ctx.strokeStyle = withAlpha(th.accent, 0.55)
      ctx.lineWidth = 1
      ctx.stroke()
      ctx.restore()

      // ── L channel — full accent, drawn on top ──────────────────────────────
      ctx.save()
      ctx.globalAlpha = wetAlpha
      ctx.beginPath()
      ctx.moveTo(drawX0, baseline)
      for (let s = 0; s < STEPS; s++) ctx.lineTo(drawX0 + (s / STEPS) * drawW, baseline + samplesL[s] * maxDip)
      ctx.lineTo(drawX1, baseline)
      ctx.closePath()
      ctx.fillStyle = withAlpha(th.accent, 0.22)
      ctx.fill()

      ctx.beginPath()
      for (let s = 0; s < STEPS; s++) {
        const x = drawX0 + (s / STEPS) * drawW
        const y = baseline + samplesL[s] * maxDip
        s === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)
      }
      ctx.strokeStyle = th.accent
      ctx.lineWidth = 1.5
      ctx.stroke()
      ctx.restore()

      // ── Feedback polarity marker at each L notch centre ────────────────────
      // Positive feedback: a filled resonance spike above the baseline. Negative
      // feedback: a hollow tick — same geometry, no fill, so polarity reads at a
      // glance without a second hue.
      if (fbMag > 0.04) {
        const spikeH = maxDip * 0.16 * fbMag
        for (let i = 0; i < notchCount; i++) {
          const lcX = Math.round(fToX(Math.exp(notchLogL[i]))) + 0.5
          ctx.save()
          ctx.globalAlpha = wetAlpha
          if (fbSign >= 0) {
            ctx.fillStyle = withAlpha(th.accent, 0.55 + fbMag * 0.35)
            ctx.fillRect(lcX - 1, baseline - spikeH, 2, spikeH)
          } else {
            ctx.strokeStyle = withAlpha(th.accent, 0.45 + fbMag * 0.3)
            ctx.lineWidth = 1
            ctx.strokeRect(lcX - 1.5, baseline - spikeH, 3, spikeH)
          }
          ctx.restore()
        }
      }

      // ── Sweep band edge handles (draggable) ────────────────────────────────
      const activeHandle = dragRef.current?.handle || hoverRef.current
      const drawHandle = (f, x, isActive) => {
        ctx.strokeStyle = withAlpha(th.accent, isActive ? 0.9 : 0.4)
        ctx.lineWidth = isActive ? 2 : 1
        ctx.beginPath()
        ctx.moveTo(x, respTop)
        ctx.lineTo(x, respBot)
        ctx.stroke()

        const s = isActive ? 9 : 7
        const hy = respTop + 5
        ctx.fillStyle = isActive ? th.accent : withAlpha(th.accent, 0.75)
        ctx.fillRect(Math.round(x - s / 2), Math.round(hy - s / 2), s, s)
        ctx.strokeStyle = th.well
        ctx.lineWidth = 1
        ctx.strokeRect(Math.round(x - s / 2) + 0.5, Math.round(hy - s / 2) + 0.5, s - 1, s - 1)
      }
      drawHandle(freqLo, Math.round(bandX0) + 0.5, activeHandle === 'lo')
      drawHandle(freqHi, Math.round(bandX1) + 0.5, activeHandle === 'hi')

      // ── Frequency readouts, pinned to the plot corners ─────────────────────
      ctx.font = MONO
      ctx.textBaseline = 'top'
      ctx.textAlign = 'left'
      ctx.fillStyle = activeHandle === 'lo' ? th.accent : withAlpha(th.textMuted, 1)
      ctx.fillText(`LOW ${formatHz(freqLo)}`, drawX0 + 2, respTop + 2)
      ctx.textAlign = 'right'
      ctx.fillStyle = activeHandle === 'hi' ? th.accent : withAlpha(th.textMuted, 1)
      ctx.fillText(`HIGH ${formatHz(freqHi)}`, drawX1 - 2, respTop + 2)

      // ── Frequency axis tick labels ─────────────────────────────────────────
      const LABEL_FREQS = [20,    100,   1000, 4000, 16000]
      const LABEL_TEXTS = ['20', '100',  '1k', '4k', '16k']
      ctx.font = MONO_SM
      ctx.textAlign = 'center'
      ctx.textBaseline = 'top'
      ctx.fillStyle = withAlpha(th.textSubtle, 0.9)
      for (let i = 0; i < LABEL_FREQS.length; i++) {
        ctx.fillText(LABEL_TEXTS[i], fToX(LABEL_FREQS[i]), respBot + 3)
      }

      rafRef.current = requestAnimationFrame(draw)
    }

    rafRef.current = requestAnimationFrame(draw)

    return () => {
      cancelled = true
      cancelAnimationFrame(rafRef.current)
    }
  }, []) // Empty deps — all per-frame data flows through refs.

  // ── Drag interaction — mirrors DelayFilterCurve's contract exactly ────────
  const normFromEvent = useCallback((e) => {
    const canvas = canvasRef.current
    if (!canvas) return 0
    const rect = canvas.getBoundingClientRect()
    const plotW = Math.max(10, rect.width - PAD_X * 2)
    return clamp((e.clientX - rect.left - PAD_X) / plotW, 0, 1)
  }, [])

  const valueFor = useCallback((handle, norm) => {
    const freq = normToFreq(norm, AXIS_FREQ_MIN, AXIS_FREQ_MAX)
    const { lo, hi } = liveRef.current
    return handle === 'lo'
      ? clamp(freq, LO_MIN, Math.min(LO_MAX, hi - MIN_GAP_HZ))
      : clamp(freq, Math.max(HI_MIN, lo + MIN_GAP_HZ), HI_MAX)
  }, [])

  const handlePointerDown = useCallback((e) => {
    const norm = normFromEvent(e)
    const { lo, hi } = liveRef.current
    // Always grab the nearer handle, but drag relatively from the grab point so
    // an imprecise click never yanks the value across the spectrum.
    const handle = pickFilterHandle(norm, lo, hi, 0.06, AXIS_FREQ_MIN, AXIS_FREQ_MAX)
    if (!handle) return
    e.preventDefault()
    try { e.currentTarget.setPointerCapture(e.pointerId) } catch { /* older engines */ }
    const handleNorm = freqToNorm(handle === 'lo' ? lo : hi, AXIS_FREQ_MIN, AXIS_FREQ_MAX)
    dragRef.current = { handle, offsetNorm: handleNorm - norm }
    hoverRef.current = handle
  }, [normFromEvent])

  const handlePointerMove = useCallback((e) => {
    const drag = dragRef.current
    const norm = normFromEvent(e)
    if (!drag) {
      const { lo, hi } = liveRef.current
      hoverRef.current = pickFilterHandle(norm, lo, hi, 0.035, AXIS_FREQ_MIN, AXIS_FREQ_MAX)
      return
    }
    const next = valueFor(drag.handle, clamp(norm + drag.offsetNorm, 0, 1))
    liveRef.current = drag.handle === 'lo'
      ? { ...liveRef.current, lo: next }
      : { ...liveRef.current, hi: next }
    onPreview?.(drag.handle === 'lo' ? 'freq_low' : 'freq_high', next)
  }, [normFromEvent, valueFor, onPreview])

  const handlePointerUp = useCallback(() => {
    const drag = dragRef.current
    if (!drag) return
    dragRef.current = null
    const { lo, hi } = liveRef.current
    onCommit?.(drag.handle === 'lo' ? 'freq_low' : 'freq_high', drag.handle === 'lo' ? lo : hi)
  }, [onCommit])

  return (
    <canvas
      ref={canvasRef}
      className="phaser-stage-canvas"
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerUp}
      onPointerLeave={() => { if (!dragRef.current) hoverRef.current = null }}
      title="Drag the sweep band edges to set FREQ LOW / FREQ HIGH"
      style={{ display: 'block', width: '100%', height: '100%', cursor: 'ew-resize', touchAction: 'none' }}
    />
  )
}
