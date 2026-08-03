// ─── FlangerVisualizerCanvas.jsx ──────────────────────────────────────────────
// The Flanger panel's centrepiece: a flat, hard-edged comb/sweep display.
//
// Reads left→right as the 0.1–5 ms delay axis. The centre rule is the dry
// reference; comb teeth and read-heads are everything else, all derived from
// a live engine parameter — nothing decorative:
//
//   delay              → horizontal position of the base tap (write-head)
//   rate               → LFO angular velocity driving the read-head sweep
//   depth              → comb-teeth height, sweep amplitude and strand amplitude
//   feedback (bipolar) → comb-teeth polarity: positive teeth rise above the
//                         centre rule (solid fill), negative teeth drop below
//                         it (hollow outline) — same accent hue, mirrored and
//                         differently weighted so sign reads at a glance
//   width              → L/R read-head phase offset and the bottom spread ticks
//   mix                → wet alpha of the comb/read-heads; the dry tick at the
//                         axis head tracks (1 - mix)
//
// Style: no gradients, no glow, no rounded corners. One accent (the theme
// token), used only where it carries meaning. Neutral greys carry structure.
//
// Thread/lifecycle note:
//   FlangerPanel returns null when flangerStore.target is null, which unmounts
//   this component entirely. React therefore calls the useEffect cleanup, which
//   sets cancelled = true and calls cancelAnimationFrame — zero background work.

import { useEffect, useRef } from 'react'
import {
  withAlpha,
  readMixerCanvasTheme,
  syncCanvasSize,
  MONO,
  MONO_SM,
} from './mixerCanvasTheme.js'

// ── Pure helpers (exported for unit tests) ───────────────────────────────────

/** Clamps v to [0, 1]. */
export function clamp01(v) {
  return Math.max(0, Math.min(1, v))
}

/**
 * Maps rate (Hz) to angular velocity in rad/ms.
 * Multiply by elapsed ms to get total radians swept.
 */
export function rateToAngVel(rateHz) {
  return (2 * Math.PI * rateHz) / 1000
}

/**
 * Maps feedback (-95..95 %) to a normalized bipolar value in [-1, 1].
 * Sign carries polarity; magnitude drives intensity.
 */
export function normFeedback(fb) {
  return Math.max(-1, Math.min(1, fb / 95))
}

/**
 * Maps mix (0–100 %) to wet alpha in [0.15, 1.0].
 * Floor at 0.15 so read-heads remain faintly visible even at dry=100.
 */
export function mixToAlpha(mixPct) {
  return 0.15 + clamp01(mixPct / 100) * 0.85
}

/**
 * Maps a delay value (ms) to a normalized position on the 0.1–5 ms axis.
 * Values outside the axis are clamped to [0, 1].
 */
export function delayToNorm(delayMs) {
  return clamp01((Math.max(0.1, delayMs) - 0.1) / (5 - 0.1))
}

/**
 * Maps width (0–100 %) to LFO phase offset in [0, π].
 * Matches the engine: stereo phase difference = (width/100) × π rad.
 */
export function widthToPhaseOffset(widthPct) {
  return clamp01(widthPct / 100) * Math.PI
}

// ── Component ─────────────────────────────────────────────────────────────────

const TEETH_COUNT = 9
const AXIS_TICKS = [0.1, 1, 2, 3, 4, 5]

export default function FlangerVisualizerCanvas({ params }) {
  const canvasRef = useRef(null)
  const paramsRef = useRef(params)
  const rafRef    = useRef(0)

  // Keep latest params readable every frame without restarting the rAF loop.
  paramsRef.current = params

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return

    let cancelled = false
    const t0 = performance.now()

    function draw(now) {
      if (cancelled) return

      const p = paramsRef.current
      const size = syncCanvasSize(canvas, 420, 200)
      const ctx = canvas.getContext('2d', { alpha: false })
      if (!ctx) { rafRef.current = requestAnimationFrame(draw); return }
      const { cssW, cssH, dpr } = size
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)

      const th = readMixerCanvasTheme(canvas)
      const t = now - t0

      // ── Param extraction ──────────────────────────────────────────────────
      const rate        = Math.max(0.05, Math.min(10, p.rate     ?? 0.5))
      const depth        = Math.max(0,    Math.min(100, p.depth  ?? 70))
      const delayMs      = Math.max(0.1,  Math.min(5, p.delay    ?? 1.5))
      const feedbackRaw  = Math.max(-95,  Math.min(95, p.feedback ?? 50))
      const widthPct     = Math.max(0,    Math.min(100, p.width  ?? 50))
      const mix          = Math.max(0,    Math.min(100, p.mix    ?? 50))

      const angVel      = rateToAngVel(rate)
      const fbNorm      = normFeedback(feedbackRaw) // -1..1, sign = polarity
      const fbAbs       = Math.abs(fbNorm)          // 0..1, magnitude only
      const depthNorm   = clamp01(depth / 100)
      const mixAlpha    = mixToAlpha(mix)
      const phaseOffset = widthToPhaseOffset(widthPct)
      const widthNorm   = clamp01(widthPct / 100)

      // LFO phase for L and R read-heads (R is phase-shifted by width × π).
      const lfoL = angVel * t
      const lfoR = lfoL + phaseOffset

      // ── Layout — fills the stage edge to edge, minimal axis padding ───────
      const padL = 22
      const padR = cssW - 14
      const axisW = Math.max(20, padR - padL)
      const topY = 18
      const botY = cssH - 16
      const cy = Math.round((topY + botY) / 2) + 0.5
      const laneH = (botY - topY) / 2 - 3

      const toX = (ms) => padL + delayToNorm(ms) * axisW
      const baseX = toX(delayMs)

      // Sweep range in ms: depth drives how far the read-heads move from the
      // base delay. Capped at 70 % of base delay or 2 ms to stay readable.
      const sweepMs = depthNorm * Math.min(delayMs * 0.7, 2.0)
      const instDelayL = Math.max(0.1, Math.min(5, delayMs + sweepMs * Math.sin(lfoL)))
      const instDelayR = Math.max(0.1, Math.min(5, delayMs + sweepMs * Math.sin(lfoR)))
      const tapLX = toX(instDelayL)
      const tapRX = toX(instDelayR)

      // ── Background ────────────────────────────────────────────────────────
      ctx.fillStyle = th.well
      ctx.fillRect(0, 0, cssW, cssH)

      // ── Delay axis ────────────────────────────────────────────────────────
      ctx.strokeStyle = withAlpha(th.border, 0.9)
      ctx.lineWidth = 1
      ctx.beginPath()
      ctx.moveTo(padL - 6, topY + 0.5)
      ctx.lineTo(padR, topY + 0.5)
      ctx.moveTo(padL - 6, botY + 0.5)
      ctx.lineTo(padR, botY + 0.5)
      ctx.stroke()

      ctx.font = MONO_SM
      ctx.textAlign = 'center'
      ctx.textBaseline = 'top'
      ctx.fillStyle = withAlpha(th.textSubtle, 0.8)
      for (const ms of AXIS_TICKS) {
        const tx = Math.round(toX(ms)) + 0.5
        ctx.strokeStyle = withAlpha(th.border, 0.85)
        ctx.lineWidth = 1
        ctx.beginPath()
        ctx.moveTo(tx, cy - 4)
        ctx.lineTo(tx, cy + 4)
        ctx.stroke()
        if (tx > padL + 6 && tx < padR - 6) {
          ctx.fillStyle = withAlpha(th.textSubtle, 0.75)
          ctx.fillText(String(ms), tx, botY + 3)
        }
      }

      // ── Centre rule (the dry reference) ───────────────────────────────────
      ctx.strokeStyle = withAlpha(th.borderStrong, 1)
      ctx.lineWidth = 1
      ctx.beginPath()
      ctx.moveTo(padL - 6, cy)
      ctx.lineTo(padR, cy)
      ctx.stroke()

      // ── Base delay marker ─────────────────────────────────────────────────
      ctx.save()
      ctx.strokeStyle = withAlpha(th.accent, 0.3)
      ctx.lineWidth = 1
      ctx.setLineDash([2, 4])
      ctx.beginPath()
      ctx.moveTo(baseX, topY)
      ctx.lineTo(baseX, botY)
      ctx.stroke()
      ctx.restore()

      // ── Comb teeth ─────────────────────────────────────────────────────────
      // Flat vertical bars centred on the write-head, bell-profiled by depth.
      // Positive feedback: solid fill, rising ABOVE the centre rule.
      // Negative feedback: hollow outline, dropping BELOW the centre rule.
      // Same accent hue in both cases — polarity reads from direction + weight.
      const teethSpread = axisW * 0.34
      const teethAlpha = 0.10 + fbAbs * 0.55
      const positive = fbNorm >= 0

      ctx.save()
      for (let i = 0; i < TEETH_COUNT; i++) {
        const norm = i / (TEETH_COUNT - 1)
        const tx = Math.round(baseX - teethSpread * 0.5 + norm * teethSpread) + 0.5
        const peak = 1 - Math.abs(norm - 0.5) * 2 // bell: tallest at centre
        const toothH = Math.max(1, laneH * (0.14 + peak * depthNorm * 0.82))

        if (positive) {
          ctx.fillStyle = withAlpha(th.accent, teethAlpha * (0.4 + peak * 0.6))
          ctx.fillRect(tx - 2, cy - toothH, 3, toothH)
        } else {
          ctx.strokeStyle = withAlpha(th.accent, teethAlpha * (0.4 + peak * 0.6))
          ctx.lineWidth = 1
          ctx.strokeRect(tx - 2, cy, 3, toothH)
        }
      }
      ctx.restore()

      // ── Dry strand ─────────────────────────────────────────────────────────
      // One crisp polyline across the full axis — neutral, always present,
      // amplitude tracks depth so modulation energy reads at rest too.
      const strandAmp = Math.max(2, laneH * 0.42) * depthNorm
      const strandHz = 2.4
      const phase = t * rate * 0.0022
      const STEPS = 64

      ctx.save()
      ctx.strokeStyle = withAlpha(th.textMuted, 0.55)
      ctx.lineWidth = 1.5
      ctx.lineJoin = 'round'
      ctx.beginPath()
      for (let s = 0; s <= STEPS; s++) {
        const frac = s / STEPS
        const x = padL + frac * axisW
        const y = cy + Math.sin(2 * Math.PI * strandHz * frac + phase) * strandAmp
        s === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)
      }
      ctx.stroke()
      ctx.restore()

      // ── Read-heads ────────────────────────────────────────────────────────
      // Flat squares, no glow. L is solid, R is hollow — same hue, different
      // weight, so the two channels stay distinct without a second colour.
      const headS = 6
      ctx.save()
      ctx.globalAlpha = mixAlpha
      ctx.fillStyle = withAlpha(th.accent, 1)
      ctx.fillRect(Math.round(tapLX - headS / 2), Math.round(cy - headS / 2), headS, headS)
      ctx.restore()

      ctx.save()
      ctx.globalAlpha = mixAlpha
      ctx.strokeStyle = withAlpha(th.accent, 1)
      ctx.lineWidth = 1.5
      ctx.strokeRect(Math.round(tapRX - headS / 2) + 0.5, Math.round(cy - headS / 2) + 0.5, headS, headS)
      ctx.restore()

      // Write-head: small fixed tick at the base delay position.
      ctx.save()
      ctx.fillStyle = withAlpha(th.textSubtle, 0.9)
      ctx.fillRect(Math.round(baseX) - 1, Math.round(cy) - 1, 2, 2)
      ctx.restore()

      // Lane tags — mirrors DelayEchoFieldVisualizer's L/R text convention.
      ctx.font = MONO
      ctx.textAlign = 'left'
      ctx.textBaseline = 'middle'
      ctx.fillStyle = withAlpha(th.textMuted, 1)
      ctx.fillText('L', padL - 16, cy - 8)
      ctx.fillText('R', padL - 16, cy + 8)

      // ── Width spread ticks (bottom edge) ──────────────────────────────────
      const indY = botY - 3
      const indSpan = axisW * 0.22
      const indLX = cssW * 0.5 - indSpan * widthNorm
      const indRX = cssW * 0.5 + indSpan * widthNorm
      const indA = 0.25 + (mix / 100) * 0.4

      ctx.save()
      ctx.globalAlpha = indA
      ctx.fillStyle = withAlpha(th.accent, 1)
      ctx.fillRect(Math.round(indLX) - 1, indY - 1, 2, 2)
      ctx.fillRect(Math.round(indRX) - 1, indY - 1, 2, 2)
      ctx.restore()

      // ── Dry tick at the axis head ─────────────────────────────────────────
      // Height tracks the dry proportion — mirrors DelayEchoFieldVisualizer's
      // "DRY" column so the two panels share the same visual vocabulary.
      const dryH = laneH * (1 - clamp01(mix / 100)) * 0.9
      ctx.fillStyle = withAlpha(th.textMuted, 0.5)
      ctx.fillRect(padL - 8, cy - dryH, 2, dryH * 2)

      // ── Readout ────────────────────────────────────────────────────────────
      ctx.font = MONO_SM
      ctx.textAlign = 'right'
      ctx.textBaseline = 'top'
      ctx.fillStyle = withAlpha(th.textSubtle, 1)
      ctx.fillText(
        `${rate.toFixed(2)} HZ  ·  FB ${feedbackRaw >= 0 ? '+' : ''}${Math.round(feedbackRaw)}%  ·  W ${Math.round(widthPct)}%`,
        padR,
        6,
      )

      rafRef.current = requestAnimationFrame(draw)
    }

    rafRef.current = requestAnimationFrame(draw)

    // Cleanup: cancelled = true stops the in-flight frame guard immediately;
    // cancelAnimationFrame drops the pending queued call. Both together
    // guarantee no drawing occurs after unmount.
    return () => {
      cancelled = true
      cancelAnimationFrame(rafRef.current)
    }
  }, []) // Empty deps: all per-frame data flows through paramsRef.

  return (
    <canvas
      ref={canvasRef}
      className="flanger-stage-canvas"
      style={{ display: 'block', width: '100%', height: '100%' }}
    />
  )
}
