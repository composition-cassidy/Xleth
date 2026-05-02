// ─── ChorusOrbitVisualizer.jsx ────────────────────────────────────────────────
// Self-contained canvas visualizer for the Chorus bespoke panel.
// All animation runs inside one requestAnimationFrame loop that starts on mount
// and stops on unmount. No engine data is polled; visuals derive entirely from
// the current param values via a ref so the rAF loop never needs to restart.
//
// Thread/lifecycle note:
//   ChorusPanel returns null when chorusStore.target is null, which unmounts this
//   component entirely. React therefore calls the useEffect cleanup, which sets
//   cancelled = true and calls cancelAnimationFrame — zero background animation.

import { useEffect, useRef } from 'react'

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
 * Maps feedback (0–25) to a glow blur value between baseBlur and maxBlur.
 * Input clamped to [0, 25].
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

// ── Internal theme reader ─────────────────────────────────────────────────────

function readChorusTheme(canvas) {
  const cs  = canvas ? getComputedStyle(canvas) : null
  const get = (k, fb) => { const v = cs?.getPropertyValue(k)?.trim(); return v || fb }
  return { bgInset: get('--theme-bg-inset', '#0d0d14') }
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

    // Trail buffers — one slot per voice (pre-allocated for max 10).
    // Defined inside the effect closure so they're owned by this instance
    // and freed automatically when the component unmounts.
    const TRAIL_LEN = 6
    const trails    = Array.from({ length: 10 }, () => [])

    function draw(now) {
      if (cancelled) return

      const p = paramsRef.current

      // DPR-aware backing-store resize (matches DynamicsVisualizerCanvas pattern)
      const dpr  = Math.max(1, window.devicePixelRatio || 1)
      const rect = canvas.getBoundingClientRect()
      const cssW = rect.width  > 0 ? rect.width  : 420
      const cssH = rect.height > 0 ? rect.height : 210
      const tw   = Math.round(cssW * dpr)
      const th   = Math.round(cssH * dpr)
      if (canvas.width !== tw || canvas.height !== th) {
        canvas.width  = tw
        canvas.height = th
      }

      const ctx = canvas.getContext('2d', { alpha: false })
      if (!ctx) { rafRef.current = requestAnimationFrame(draw); return }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)

      const { bgInset } = readChorusTheme(canvas)

      const t  = now - t0
      const cx = cssW / 2
      const cy = cssH / 2

      // ── Param → visual quantities ──────────────────────────────────────────
      const voices       = clampVoices(p.voices ?? 2)
      const rate         = Math.max(0.05,  p.rate     ?? 0.8)
      const depth        = Math.max(0,     p.depth    ?? 50)
      const delayMs      = Math.max(7,     p.delay    ?? 15)
      const feedback     = Math.max(0,     p.feedback ?? 0)
      const widthPct     = Math.max(0,     p.width    ?? 80)
      const mix          = Math.max(0,     p.mix      ?? 50)

      const angVel       = rateToAngularVelocity(rate)
      const baseR        = cssH * 0.32
      const orbitRy      = delayToOrbitRadius(delayMs, baseR)
      const orbitRx      = widthToEllipseRx(orbitRy, widthPct)
      const glowBlur     = feedbackToGlow(feedback, 5, 26)
      const orbAlpha     = mixToOrbAlpha(mix)
      const orbR         = Math.max(3.5, cssH * 0.05)
      const centralR     = Math.max(5,   cssH * 0.07)
      const depthNorm    = depth / 100
      const feedbackNorm = Math.max(0, Math.min(1, feedback / 25))
      const widthNorm    = Math.max(0, Math.min(1, widthPct / 100))
      // Feedback-driven connector appearance
      const connAlpha    = 0.06 + feedbackNorm * 0.24
      const connWidth    = 1.0  + feedbackNorm * 1.5
      const connGlow     = feedbackNorm * 6

      // ── Background ────────────────────────────────────────────────────────

      // Base dark fill
      ctx.fillStyle = bgInset
      ctx.fillRect(0, 0, cssW, cssH)

      // Warm amber radial glow centered on the orbits
      const ambR = Math.max(orbitRx, orbitRy) * 1.9
      const ambG = ctx.createRadialGradient(cx, cy, 0, cx, cy, ambR)
      ambG.addColorStop(0,    'rgba(160, 100,   0, 0.12)')
      ambG.addColorStop(0.45, 'rgba( 80,  40, 100, 0.06)')
      ambG.addColorStop(1,    'rgba(  0,   0,   0, 0)')
      ctx.fillStyle = ambG
      ctx.fillRect(0, 0, cssW, cssH)

      // Cool purple glow offset slightly from center — adds depth/asymmetry
      const coolX = cx + cssW * 0.10
      const coolY = cy - cssH * 0.07
      const coolG = ctx.createRadialGradient(coolX, coolY, 0, coolX, coolY, cssW * 0.48)
      coolG.addColorStop(0,   'rgba(60, 20, 110, 0.09)')
      coolG.addColorStop(1,   'rgba( 0,  0,   0, 0)')
      ctx.fillStyle = coolG
      ctx.fillRect(0, 0, cssW, cssH)

      // Vignette — gently darken the canvas corners
      const vigInn = Math.min(cssW, cssH) * 0.25
      const vigOut = Math.max(cssW, cssH) * 0.85
      const vigG   = ctx.createRadialGradient(cx, cy, vigInn, cx, cy, vigOut)
      vigG.addColorStop(0,   'rgba(0, 0, 0, 0)')
      vigG.addColorStop(1,   'rgba(0, 0, 0, 0.35)')
      ctx.fillStyle = vigG
      ctx.fillRect(0, 0, cssW, cssH)

      // ── Orbit guide rings ─────────────────────────────────────────────────
      ctx.save()
      ctx.lineWidth = 1

      // Outermost stereo-field reference ring (very faint)
      ctx.strokeStyle = 'rgba(160, 110, 255, 0.05)'
      ctx.setLineDash([2, 8])
      ctx.beginPath()
      ctx.ellipse(cx, cy, orbitRx * 1.30, orbitRy * 1.30, 0, 0, 2 * Math.PI)
      ctx.stroke()

      // Main orbit ring — clearly shows where voices travel
      ctx.strokeStyle = 'rgba(180, 130, 255, 0.14)'
      ctx.setLineDash([4, 6])
      ctx.beginPath()
      ctx.ellipse(cx, cy, orbitRx, orbitRy, 0, 0, 2 * Math.PI)
      ctx.stroke()

      // Inner reference ring
      ctx.strokeStyle = 'rgba(180, 130, 255, 0.07)'
      ctx.setLineDash([2, 9])
      ctx.beginPath()
      ctx.ellipse(cx, cy, orbitRx * 0.68, orbitRy * 0.68, 0, 0, 2 * Math.PI)
      ctx.stroke()

      ctx.setLineDash([])
      ctx.restore()

      // ── Compute orb positions + per-orb variance ──────────────────────────
      // Using irrational-ish multipliers per voice so size/alpha cycles never
      // align across voices, keeping the field looking alive even at rest.
      const orbData = []
      for (let i = 0; i < voices; i++) {
        const initPhase = (2 * Math.PI * i) / voices
        const wobble    = Math.sin(t * 0.00075 * (i + 1) + initPhase) * depthNorm * 0.16
        const angle     = initPhase + t * angVel
        const rx        = orbitRx * (1 + wobble)
        const ry        = orbitRy * (1 + wobble * 0.5)
        const ox        = cx + rx * Math.cos(angle)
        const oy        = cy + ry * Math.sin(angle)
        const sizeVar   = 1 + Math.sin(t * 0.00042 * (i * 1.618 + 1) + i * 2.09) * 0.18
        const alphaVar  = 0.85 + Math.sin(t * 0.00058 * (i * 1.31  + 1) + i * 1.73) * 0.15
        orbData.push({
          ox, oy,
          thisOrbR:  orbR * sizeVar,
          thisAlpha: Math.min(1, orbAlpha * alphaVar),
        })
      }

      // Maintain trail history: push current position, trim oldest, clear
      // slots for inactive voices so past trails don't linger.
      for (let i = 0; i < voices; i++) {
        trails[i].push({ ox: orbData[i].ox, oy: orbData[i].oy })
        if (trails[i].length > TRAIL_LEN) trails[i].shift()
      }
      for (let i = voices; i < 10; i++) {
        if (trails[i].length) trails[i].length = 0
      }

      // ── Orb trails ────────────────────────────────────────────────────────
      // Draw oldest→newest (excluding the current position which the orb covers).
      // Progress normalises to actual trail length so trails fade in smoothly
      // on the first few frames rather than blinking at full strength.
      for (let i = 0; i < voices; i++) {
        const trail             = trails[i]
        const { thisOrbR, thisAlpha } = orbData[i]
        for (let j = 0; j < trail.length - 1; j++) {
          const progress   = (j + 1) / trail.length   // 0 = oldest, ~1 = just-before-current
          const { ox, oy } = trail[j]
          const trailAlpha = thisAlpha * progress * 0.28
          const trailR     = thisOrbR  * (0.35 + progress * 0.55)
          ctx.save()
          ctx.globalAlpha = trailAlpha
          const tg = ctx.createRadialGradient(ox, oy, 0, ox, oy, trailR)
          tg.addColorStop(0, 'rgba(190, 120, 255, 0.85)')
          tg.addColorStop(1, 'rgba( 90,  40, 160, 0)')
          ctx.fillStyle = tg
          ctx.beginPath()
          ctx.arc(ox, oy, trailR, 0, 2 * Math.PI)
          ctx.fill()
          ctx.restore()
        }
      }

      // ── Connectors: center → each orb ─────────────────────────────────────
      // Line width and glow scale with feedback so the coupling is tangible.
      for (const { ox, oy } of orbData) {
        ctx.save()
        ctx.lineWidth   = connWidth
        ctx.shadowBlur  = connGlow
        ctx.shadowColor = 'rgba(200, 140, 40, 0.5)'
        const g = ctx.createLinearGradient(cx, cy, ox, oy)
        g.addColorStop(0,   `rgba(200, 150,  20, ${connAlpha.toFixed(3)})`)
        g.addColorStop(0.7, `rgba(160,  80, 200, ${(connAlpha * 0.5).toFixed(3)})`)
        g.addColorStop(1,   'rgba(120,  60, 180, 0)')
        ctx.strokeStyle = g
        ctx.beginPath()
        ctx.moveTo(cx, cy)
        ctx.lineTo(ox, oy)
        ctx.stroke()
        ctx.restore()
      }

      // ── Input strand ──────────────────────────────────────────────────────
      // Sine wave through center. Bell envelope tapers amplitude near the edges
      // so it reads as naturally attenuated, not opacity-clipped.
      // Both passes are ~30 % quieter than v1 so the strand doesn't dominate.

      const strandW  = cssW * 0.68
      const strandX0 = cx - strandW * 0.5
      const maxAmp   = Math.max(2, cssH * 0.095)
      const amp      = maxAmp * (0.25 + depthNorm * 0.75)
      const strandHz = 2.5
      const phase    = t * rate * 0.003
      const STEPS    = 90

      // Soft glow pass
      ctx.save()
      ctx.lineCap   = 'round'
      ctx.lineJoin  = 'round'
      ctx.lineWidth = 5.5
      {
        const gg = ctx.createLinearGradient(strandX0, 0, strandX0 + strandW, 0)
        gg.addColorStop(0,    'rgba(184, 120,  0, 0)')
        gg.addColorStop(0.15, 'rgba(184, 120,  0, 0.10)')
        gg.addColorStop(0.5,  'rgba(200, 140, 10, 0.15)')
        gg.addColorStop(0.85, 'rgba(184, 120,  0, 0.10)')
        gg.addColorStop(1,    'rgba(184, 120,  0, 0)')
        ctx.strokeStyle = gg
      }
      ctx.beginPath()
      for (let s = 0; s <= STEPS; s++) {
        const frac = s / STEPS
        const x    = strandX0 + frac * strandW
        const env  = Math.sin(Math.PI * frac)
        const y    = cy + Math.sin(2 * Math.PI * strandHz * frac + phase) * amp * env
        s === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)
      }
      ctx.stroke()
      ctx.restore()

      // Crisp centre pass
      ctx.save()
      ctx.lineCap   = 'round'
      ctx.lineJoin  = 'round'
      ctx.lineWidth = 1.5
      {
        const sg = ctx.createLinearGradient(strandX0, 0, strandX0 + strandW, 0)
        sg.addColorStop(0,    'rgba(255, 210,  80, 0)')
        sg.addColorStop(0.12, 'rgba(255, 210,  80, 0.48)')
        sg.addColorStop(0.5,  'rgba(255, 235, 120, 0.62)')
        sg.addColorStop(0.88, 'rgba(255, 210,  80, 0.48)')
        sg.addColorStop(1,    'rgba(255, 210,  80, 0)')
        ctx.strokeStyle = sg
      }
      ctx.beginPath()
      for (let s = 0; s <= STEPS; s++) {
        const frac = s / STEPS
        const x    = strandX0 + frac * strandW
        const env  = Math.sin(Math.PI * frac)
        const y    = cy + Math.sin(2 * Math.PI * strandHz * frac + phase) * amp * env
        s === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)
      }
      ctx.stroke()
      ctx.restore()

      // ── Chorus voice orbs ─────────────────────────────────────────────────
      for (const { ox, oy, thisOrbR, thisAlpha } of orbData) {
        ctx.save()
        ctx.globalAlpha = thisAlpha
        ctx.shadowBlur  = glowBlur * 2.2
        ctx.shadowColor = 'rgba(140, 80, 220, 0.8)'
        const og = ctx.createRadialGradient(ox, oy, 0, ox, oy, thisOrbR)
        og.addColorStop(0,    'rgba(210, 150, 255, 0.95)')
        og.addColorStop(0.45, 'rgba(140,  80, 220, 0.75)')
        og.addColorStop(1,    'rgba( 80,  30, 160, 0)')
        ctx.fillStyle = og
        ctx.beginPath()
        ctx.arc(ox, oy, thisOrbR, 0, 2 * Math.PI)
        ctx.fill()
        ctx.restore()
      }

      // ── Central dry orb ───────────────────────────────────────────────────
      ctx.save()
      ctx.shadowBlur  = glowBlur + 14
      ctx.shadowColor = 'rgba(240, 180, 20, 0.85)'
      const cg = ctx.createRadialGradient(cx, cy, 0, cx, cy, centralR)
      cg.addColorStop(0,    'rgba(255, 245, 180, 1.0)')
      cg.addColorStop(0.35, 'rgba(240, 180,  30, 0.9)')
      cg.addColorStop(0.75, 'rgba(180,  90,  10, 0.5)')
      cg.addColorStop(1,    'rgba(120,  50,   0, 0)')
      ctx.fillStyle = cg
      ctx.beginPath()
      ctx.arc(cx, cy, centralR, 0, 2 * Math.PI)
      ctx.fill()
      ctx.restore()

      // ── Stereo width indicator ─────────────────────────────────────────────
      // A param-driven L/R node pair near the bottom of the canvas.
      // Amber = left, purple = right. Spread = width. Opacity = mix.
      // Depth adds a gentle oscillation so it reads as "alive" at high depth.

      const indY     = cssH - 13
      const indSpan  = cssW * 0.34
      const osc      = Math.sin(t * angVel * 0.5) * depthNorm * 2.5
      const indLX    = cx - indSpan * widthNorm * 0.9 + osc * 0.5
      const indRX    = cx + indSpan * widthNorm * 0.9 - osc * 0.5
      const indR     = 3.0 + depthNorm * 1.5
      const indAlpha = 0.3 + (mix / 100) * 0.45

      // Guide line
      ctx.save()
      ctx.strokeStyle = 'rgba(200, 180, 255, 0.07)'
      ctx.lineWidth   = 1
      ctx.beginPath()
      ctx.moveTo(cx - indSpan * 1.05, indY)
      ctx.lineTo(cx + indSpan * 1.05, indY)
      ctx.stroke()
      ctx.restore()

      // Center tick mark
      ctx.save()
      ctx.strokeStyle = 'rgba(200, 180, 255, 0.13)'
      ctx.lineWidth   = 1
      ctx.beginPath()
      ctx.moveTo(cx, indY - 2.5)
      ctx.lineTo(cx, indY + 2.5)
      ctx.stroke()
      ctx.restore()

      // L node (amber)
      ctx.save()
      ctx.globalAlpha = indAlpha
      ctx.shadowBlur  = 5 + depthNorm * 3
      ctx.shadowColor = 'rgba(240, 160, 20, 0.7)'
      const lg = ctx.createRadialGradient(indLX, indY, 0, indLX, indY, indR * 2.2)
      lg.addColorStop(0, 'rgba(255, 215,  80, 0.95)')
      lg.addColorStop(1, 'rgba(200, 120,  10, 0)')
      ctx.fillStyle = lg
      ctx.beginPath()
      ctx.arc(indLX, indY, indR, 0, 2 * Math.PI)
      ctx.fill()
      ctx.restore()

      // R node (purple)
      ctx.save()
      ctx.globalAlpha = indAlpha
      ctx.shadowBlur  = 5 + depthNorm * 3
      ctx.shadowColor = 'rgba(140, 80, 220, 0.7)'
      const rg = ctx.createRadialGradient(indRX, indY, 0, indRX, indY, indR * 2.2)
      rg.addColorStop(0, 'rgba(210, 155, 255, 0.95)')
      rg.addColorStop(1, 'rgba(100,  50, 180, 0)')
      ctx.fillStyle = rg
      ctx.beginPath()
      ctx.arc(indRX, indY, indR, 0, 2 * Math.PI)
      ctx.fill()
      ctx.restore()

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
