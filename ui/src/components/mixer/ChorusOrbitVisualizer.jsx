// ─── ChorusOrbitVisualizer.jsx ────────────────────────────────────────────────
// Self-contained canvas visualizer for the Chorus panel.
// All animation runs inside one requestAnimationFrame loop that starts on mount
// and stops on unmount. No engine data is polled; visuals derive entirely from
// the current param values via a ref so the rAF loop never needs to restart.
//
// Style: flat fills and hard-edged strokes only — no gradients, no shadow blur.
// Every colour comes from the canvas's computed theme tokens (mixerCanvasTheme),
// same convention as the Delay panel's echo-field visualizer. Orbit geometry
// fills the stage edge-to-edge (radii are derived from the canvas's own half-
// width/half-height rather than a fixed pixel base).
//
// Thread/lifecycle note:
//   ChorusPanel returns null when chorusStore.target is null, which unmounts this
//   component entirely. React therefore calls the useEffect cleanup, which sets
//   cancelled = true and calls cancelAnimationFrame — zero background animation.

import { useEffect, useRef } from 'react'
import {
  withAlpha,
  readMixerCanvasTheme,
  syncCanvasSize,
  MONO_SM,
} from './mixerCanvasTheme.js'

// ── Pure helpers (exported for unit tests) ───────────────────────────────────

/** Clamps and rounds voices to the discrete range [1, 10]. */
export function clampVoices(v) {
  return Math.max(1, Math.min(10, Math.round(v)))
}

/**
 * Converts a rate in Hz to angular velocity in rad/ms.
 * Multiply by elapsed ms to get total radians swept.
 */
export function rateToAngularVelocity(rateHz) {
  return (2 * Math.PI * rateHz) / 1000
}

/**
 * Maps delay (7–30 ms) to orbit radius.
 * At 7 ms → baseRadius. At 30 ms → baseRadius × 1.8.
 */
export function delayToOrbitRadius(delayMs, baseRadius) {
  const norm = Math.max(0, (delayMs - 7) / (30 - 7))
  return baseRadius * (1 + norm * 0.8)
}

/**
 * Maps feedback (0–25) to a value between base and max — used to scale the
 * flat coupling (connector alpha/width), not a blur radius.
 */
export function feedbackToGlow(feedbackPct, baseBlur, maxBlur) {
  const norm = Math.max(0, Math.min(1, feedbackPct / 25))
  return baseBlur + norm * (maxBlur - baseBlur)
}

/**
 * Maps mix (0–100) to orb alpha in [0.2, 1.0].
 * Even at mix=0 the voices are faintly visible so the user understands the UI.
 */
export function mixToOrbAlpha(mixPct) {
  const norm = Math.max(0, Math.min(1, mixPct / 100))
  return 0.2 + norm * 0.8
}

/**
 * Maps width (0–100) to x-radius of the orbit ellipse as a multiple of orbitRy.
 * width=0 → squished (≈ mono), width=50 → circle, width=100 → wide stereo spread.
 */
export function widthToEllipseRx(orbitRy, widthPct) {
  const norm = Math.max(0, Math.min(1, widthPct / 100))
  return orbitRy * (0.2 + norm * 1.6)
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function ChorusOrbitVisualizer({ params }) {
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
      const size = syncCanvasSize(canvas, 560, 200)
      const ctx = canvas.getContext('2d', { alpha: false })
      if (!ctx) { rafRef.current = requestAnimationFrame(draw); return }
      const { cssW, cssH, dpr } = size
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)

      const th = readMixerCanvasTheme(canvas)
      const t  = now - t0
      const cx = cssW / 2
      const cy = cssH / 2

      // ── Param → visual quantities ──────────────────────────────────────────
      const voices   = clampVoices(p.voices ?? 2)
      const rate     = Math.max(0.05, p.rate     ?? 0.8)
      const depth    = Math.max(0,    p.depth    ?? 50)
      const delayMs  = Math.max(7,    p.delay    ?? 15)
      const feedback = Math.max(0,    p.feedback ?? 0)
      const widthPct = Math.max(0,    p.width    ?? 80)
      const mix      = Math.max(0,    p.mix      ?? 50)

      const angVel = rateToAngularVelocity(rate)

      // Fill the stage edge-to-edge: margins only cover the width-indicator row
      // and the stroke width of the outermost ring.
      const marginX = 16
      const marginY = 20
      const maxRy   = Math.max(10, cssH / 2 - marginY)
      const maxRx   = Math.max(10, cssW / 2 - marginX)

      const orbitRy      = Math.min(maxRy, delayToOrbitRadius(delayMs, maxRy * 0.52))
      const orbitRx      = Math.min(maxRx, widthToEllipseRx(orbitRy, widthPct))
      const depthNorm    = Math.max(0, Math.min(1, depth / 100))
      const feedbackNorm = Math.max(0, Math.min(1, feedback / 25))
      const widthNorm    = Math.max(0, Math.min(1, widthPct / 100))
      const orbAlpha     = mixToOrbAlpha(mix)
      const connAlpha    = feedbackToGlow(feedback, 0.08, 0.5)
      const connWidth    = feedbackToGlow(feedback, 1, 2.2)
      const orbR         = Math.max(3, maxRy * 0.075)
      const centralR     = Math.max(4, maxRy * 0.11)

      // ── Background — flat fill, no gradients ───────────────────────────────
      ctx.fillStyle = th.well
      ctx.fillRect(0, 0, cssW, cssH)

      // ── Orbit guide rings — hard-edged, accent hue ─────────────────────────
      ctx.lineWidth = 1

      ctx.strokeStyle = withAlpha(th.accent, 0.06)
      ctx.setLineDash([2, 8])
      ctx.beginPath()
      ctx.ellipse(cx, cy, orbitRx * 1.22, orbitRy * 1.22, 0, 0, 2 * Math.PI)
      ctx.stroke()

      ctx.strokeStyle = withAlpha(th.accent, 0.18)
      ctx.setLineDash([4, 6])
      ctx.beginPath()
      ctx.ellipse(cx, cy, orbitRx, orbitRy, 0, 0, 2 * Math.PI)
      ctx.stroke()

      ctx.strokeStyle = withAlpha(th.accent, 0.09)
      ctx.setLineDash([2, 9])
      ctx.beginPath()
      ctx.ellipse(cx, cy, orbitRx * 0.62, orbitRy * 0.62, 0, 0, 2 * Math.PI)
      ctx.stroke()

      ctx.setLineDash([])

      // ── Compute orb positions ──────────────────────────────────────────────
      const orbData = []
      for (let i = 0; i < voices; i++) {
        const initPhase = (2 * Math.PI * i) / voices
        const wobble = Math.sin(t * 0.0009 * (i + 1) + initPhase) * depthNorm * 0.14
        const angle  = initPhase + t * angVel
        const rx = orbitRx * (1 + wobble)
        const ry = orbitRy * (1 + wobble * 0.5)
        orbData.push({
          ox: cx + rx * Math.cos(angle),
          oy: cy + ry * Math.sin(angle),
        })
      }

      // ── Connectors: centre → each orb — flat, feedback-driven ─────────────
      ctx.lineWidth   = connWidth
      ctx.strokeStyle = withAlpha(th.accent, connAlpha)
      ctx.beginPath()
      for (const { ox, oy } of orbData) {
        ctx.moveTo(cx, cy)
        ctx.lineTo(ox, oy)
      }
      ctx.stroke()

      // ── LFO strand — single crisp line through centre ─────────────────────
      const strandW  = cssW - marginX * 2
      const strandX0 = cx - strandW / 2
      const maxAmp   = maxRy * 0.5
      const amp      = maxAmp * (0.2 + depthNorm * 0.8)
      const strandHz = 1.5
      const phase    = t * rate * 0.003
      const STEPS    = 90

      ctx.lineWidth   = 1.25
      ctx.strokeStyle = withAlpha(th.accent, 0.5)
      ctx.beginPath()
      for (let s = 0; s <= STEPS; s++) {
        const frac = s / STEPS
        const x    = strandX0 + frac * strandW
        const env  = Math.sin(Math.PI * frac)
        const y    = cy + Math.sin(2 * Math.PI * strandHz * frac + phase) * amp * env
        s === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)
      }
      ctx.stroke()

      // ── Chorus voice orbs — flat filled dots, crisp outline ────────────────
      for (const { ox, oy } of orbData) {
        ctx.fillStyle = withAlpha(th.accent, orbAlpha)
        ctx.beginPath()
        ctx.arc(ox, oy, orbR, 0, 2 * Math.PI)
        ctx.fill()
        ctx.lineWidth   = 1
        ctx.strokeStyle = withAlpha(th.text, 0.35)
        ctx.stroke()
      }

      // ── Central dry orb — neutral, the input signal ────────────────────────
      ctx.fillStyle = withAlpha(th.text, 0.85)
      ctx.beginPath()
      ctx.arc(cx, cy, centralR, 0, 2 * Math.PI)
      ctx.fill()
      ctx.lineWidth   = 1
      ctx.strokeStyle = withAlpha(th.borderStrong, 1)
      ctx.stroke()

      // ── Stereo width indicator ──────────────────────────────────────────────
      // A param-driven L/R node pair along the bottom edge. Spread = width.
      // Opacity = mix.
      const indY     = cssH - marginY * 0.5
      const indSpan  = maxRx * 0.9
      const indLX    = cx - indSpan * widthNorm
      const indRX    = cx + indSpan * widthNorm
      const indR     = 2.5
      const indAlpha = 0.3 + (mix / 100) * 0.5

      ctx.strokeStyle = withAlpha(th.border, 0.5)
      ctx.lineWidth   = 1
      ctx.beginPath()
      ctx.moveTo(cx - indSpan, indY)
      ctx.lineTo(cx + indSpan, indY)
      ctx.stroke()

      ctx.fillStyle = withAlpha(th.accent, indAlpha)
      ctx.beginPath()
      ctx.arc(indLX, indY, indR, 0, 2 * Math.PI)
      ctx.fill()
      ctx.beginPath()
      ctx.arc(indRX, indY, indR, 0, 2 * Math.PI)
      ctx.fill()

      ctx.font = MONO_SM
      ctx.textAlign = 'center'
      ctx.textBaseline = 'top'
      ctx.fillStyle = withAlpha(th.textMuted, 0.85)
      ctx.fillText('L', indLX, indY + 4)
      ctx.fillText('R', indRX, indY + 4)

      // Voice-count readout, top-right.
      ctx.textAlign = 'right'
      ctx.fillStyle = withAlpha(th.textSubtle, 0.9)
      ctx.fillText(`${voices} VOICE${voices === 1 ? '' : 'S'}`, cssW - marginX * 0.6, 6)

      rafRef.current = requestAnimationFrame(draw)
    }

    rafRef.current = requestAnimationFrame(draw)

    // Cleanup: cancelled = true stops the guard on the very next frame;
    // cancelAnimationFrame drops the pending queued call. Both together
    // guarantee no drawing occurs after unmount.
    return () => {
      cancelled = true
      cancelAnimationFrame(rafRef.current)
    }
  }, []) // Empty deps: all per-frame data is read through paramsRef.

  return (
    <canvas
      ref={canvasRef}
      className="chorus-viz-canvas"
      style={{ display: 'block', width: '100%', height: '100%' }}
    />
  )
}
