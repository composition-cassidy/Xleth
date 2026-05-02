// ─── FlangerVisualizerCanvas.jsx ──────────────────────────────────────────────
// Self-contained canvas visualizer for the Flanger bespoke panel.
// All animation runs inside one requestAnimationFrame loop that starts on mount
// and stops on unmount. No engine data is polled; visuals derive entirely from
// the current param values via a ref so the rAF loop never needs to restart.
//
// Thread/lifecycle note:
//   FlangerPanel returns null when flangerStore.target is null, which unmounts
//   this component entirely. React therefore calls the useEffect cleanup, which
//   sets cancelled = true and calls cancelAnimationFrame — zero background work.

import { useEffect, useRef } from 'react'

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

// ── Internal theme reader ─────────────────────────────────────────────────────

function readFlangerTheme(canvas) {
  const cs  = canvas ? getComputedStyle(canvas) : null
  const get = (k, fb) => { const v = cs?.getPropertyValue(k)?.trim(); return v || fb }
  return { bgInset: get('--theme-bg-inset', '#0d0d14') }
}

// ── Component ─────────────────────────────────────────────────────────────────

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

    // Trail buffers for L and R read-heads (pre-allocated, owned by this closure).
    const TRAIL_LEN = 10
    const trailL = []
    const trailR = []

    function draw(now) {
      if (cancelled) return

      const p = paramsRef.current

      // DPR-aware backing-store resize (matches ChorusOrbitVisualizer pattern).
      const dpr  = Math.max(1, window.devicePixelRatio || 1)
      const rect = canvas.getBoundingClientRect()
      const cssW = rect.width  > 0 ? rect.width  : 420
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

      const { bgInset } = readFlangerTheme(canvas)
      const t = now - t0

      // ── Param extraction ──────────────────────────────────────────────────
      const rate        = Math.max(0.05, p.rate     ?? 0.5)
      const depth       = Math.max(0,    p.depth    ?? 70)
      const delayMs     = Math.max(0.1,  p.delay    ?? 1.5)
      const feedbackRaw =                p.feedback ?? 50
      const widthPct    = Math.max(0,    p.width    ?? 50)
      const mix         = Math.max(0,    p.mix      ?? 50)

      const angVel      = rateToAngVel(rate)
      const fbNorm      = normFeedback(feedbackRaw) // -1..1, sign = polarity
      const fbAbs       = Math.abs(fbNorm)          // 0..1, magnitude only
      const depthNorm   = clamp01(depth / 100)
      const mixAlpha    = mixToAlpha(mix)
      const phaseOffset = widthToPhaseOffset(widthPct)
      const widthNorm   = clamp01(widthPct / 100)

      // LFO phase for L and R channels (R is phase-shifted by width × π).
      const lfoL = angVel * t
      const lfoR = lfoL + phaseOffset

      // Sweep range in ms: depth drives how far the tap moves from the base delay.
      // Capped at 70 % of base delay or 2 ms to stay readable at all param combos.
      const sweepMs = depthNorm * Math.min(delayMs * 0.7, 2.0)

      // Instantaneous delay tap positions (ms), clamped to the visible axis.
      const instDelayL = Math.max(0.1, Math.min(5, delayMs + sweepMs * Math.sin(lfoL)))
      const instDelayR = Math.max(0.1, Math.min(5, delayMs + sweepMs * Math.sin(lfoR)))

      // Canvas layout
      const cy    = cssH * 0.46        // horizontal axis y
      const padL  = cssW * 0.08
      const padR  = cssW * 0.92
      const axisW = padR - padL

      const toX = (ms) => padL + delayToNorm(ms) * axisW
      const baseX = toX(delayMs)
      const tapLX = toX(instDelayL)
      const tapRX = toX(instDelayR)

      // Vertical oscillation: gives the read-heads a 2D arc that traces the LFO cycle.
      const vertAmp = cssH * 0.15 * depthNorm
      const tapLY   = cy + vertAmp * Math.sin(lfoL)
      const tapRY   = cy + vertAmp * Math.sin(lfoR)

      // ── Background ────────────────────────────────────────────────────────

      ctx.fillStyle = bgInset
      ctx.fillRect(0, 0, cssW, cssH)

      // Warm amber radial glow anchored to the base delay marker.
      const ambG = ctx.createRadialGradient(baseX, cy, 0, baseX, cy, cssW * 0.55)
      ambG.addColorStop(0,    'rgba(150, 90,   0, 0.11)')
      ambG.addColorStop(0.4,  'rgba( 80, 40, 100, 0.06)')
      ambG.addColorStop(1,    'rgba(  0,  0,   0, 0)')
      ctx.fillStyle = ambG
      ctx.fillRect(0, 0, cssW, cssH)

      // Cool purple accent glow, offset for depth and asymmetry.
      const purX = cssW * 0.64
      const purY = cy * 0.72
      const purG = ctx.createRadialGradient(purX, purY, 0, purX, purY, cssW * 0.48)
      purG.addColorStop(0,   'rgba(60, 20, 110, 0.08)')
      purG.addColorStop(1,   'rgba( 0,  0,   0, 0)')
      ctx.fillStyle = purG
      ctx.fillRect(0, 0, cssW, cssH)

      // Corner vignette.
      const vigG = ctx.createRadialGradient(
        cssW * 0.5, cssH * 0.5, Math.min(cssW, cssH) * 0.2,
        cssW * 0.5, cssH * 0.5, Math.max(cssW, cssH) * 0.8,
      )
      vigG.addColorStop(0, 'rgba(0, 0, 0, 0)')
      vigG.addColorStop(1, 'rgba(0, 0, 0, 0.38)')
      ctx.fillStyle = vigG
      ctx.fillRect(0, 0, cssW, cssH)

      // ── Comb-filter teeth ─────────────────────────────────────────────────
      // Translucent vertical bars centered on the average instantaneous tap.
      // They shift with the LFO, giving a visual impression of the comb filter
      // peaks sweeping through the delay range. Brightness scales with |feedback|.
      // Color: amber for positive feedback (resonant peaks), purple for negative
      // (phase-inverted — the "cold" flanger sound).
      const avgInstDelay = (instDelayL + instDelayR) * 0.5
      const avgTapX      = toX(avgInstDelay)
      const teethCount   = 7
      const teethSpread  = axisW * 0.52
      const teethAlpha   = 0.035 + fbAbs * 0.065

      const [tr, tg, tb] = fbNorm >= 0 ? [210, 120, 10] : [100, 60, 210]

      ctx.save()
      for (let i = 0; i < teethCount; i++) {
        const norm   = i / (teethCount - 1)
        const tx     = avgTapX - teethSpread * 0.5 + norm * teethSpread
        const peak   = 1 - Math.abs(norm - 0.5) * 2  // bell: tallest at centre
        const toothH = cssH * (0.22 + peak * 0.36)
        const toothY = (cssH - toothH) * 0.5

        const tGrad = ctx.createLinearGradient(tx, toothY, tx, toothY + toothH)
        tGrad.addColorStop(0,   `rgba(${tr},${tg},${tb},0)`)
        tGrad.addColorStop(0.35,`rgba(${tr},${tg},${tb},${(teethAlpha * 1.5).toFixed(3)})`)
        tGrad.addColorStop(0.65,`rgba(${tr},${tg},${tb},${(teethAlpha * 1.5).toFixed(3)})`)
        tGrad.addColorStop(1,   `rgba(${tr},${tg},${tb},0)`)
        ctx.fillStyle = tGrad
        ctx.fillRect(tx - 2, toothY, 4, toothH)
      }
      ctx.restore()

      // ── Delay axis ────────────────────────────────────────────────────────

      ctx.save()
      ctx.strokeStyle = 'rgba(180, 140, 255, 0.11)'
      ctx.lineWidth   = 1
      ctx.setLineDash([3, 7])
      ctx.beginPath()
      ctx.moveTo(padL, cy)
      ctx.lineTo(padR, cy)
      ctx.stroke()
      ctx.setLineDash([])

      // Tick marks and ms labels.
      ctx.font         = '8px monospace'
      ctx.textAlign    = 'center'
      ctx.textBaseline = 'top'
      for (const ms of [0.1, 0.5, 1, 2, 3, 5]) {
        const tx = toX(ms)
        ctx.strokeStyle = 'rgba(180, 140, 255, 0.15)'
        ctx.lineWidth   = 1
        ctx.beginPath()
        ctx.moveTo(tx, cy - 4)
        ctx.lineTo(tx, cy + 4)
        ctx.stroke()
        ctx.fillStyle = 'rgba(180, 140, 255, 0.24)'
        ctx.fillText(String(ms), tx, cy + 7)
      }
      ctx.restore()

      // ── Base delay marker ─────────────────────────────────────────────────
      // Vertical dashed amber line at the `delay` param position.
      ctx.save()
      ctx.strokeStyle = 'rgba(220, 160, 30, 0.18)'
      ctx.lineWidth   = 1
      ctx.setLineDash([2, 5])
      ctx.beginPath()
      ctx.moveTo(baseX, cssH * 0.12)
      ctx.lineTo(baseX, cssH * 0.80)
      ctx.stroke()
      ctx.setLineDash([])
      ctx.restore()

      // ── Dry input strand ──────────────────────────────────────────────────
      // Amber sine wave running horizontally through the axis. Amplitude scales
      // with depth so the strand shows modulation energy at a glance.
      const strandW  = cssW * 0.83
      const strandX0 = cssW * 0.085
      const maxAmp   = Math.max(2, cssH * 0.048)
      const strandHz = 3.0
      const phase    = t * rate * 0.0022
      const STEPS    = 80

      // Soft glow pass.
      ctx.save()
      ctx.lineCap   = 'round'
      ctx.lineJoin  = 'round'
      ctx.lineWidth = 5
      {
        const gg = ctx.createLinearGradient(strandX0, 0, strandX0 + strandW, 0)
        gg.addColorStop(0,    'rgba(184, 120,  0, 0)')
        gg.addColorStop(0.12, 'rgba(184, 120,  0, 0.09)')
        gg.addColorStop(0.50, 'rgba(200, 140, 10, 0.13)')
        gg.addColorStop(0.88, 'rgba(184, 120,  0, 0.09)')
        gg.addColorStop(1,    'rgba(184, 120,  0, 0)')
        ctx.strokeStyle = gg
      }
      ctx.beginPath()
      for (let s = 0; s <= STEPS; s++) {
        const frac = s / STEPS
        const x    = strandX0 + frac * strandW
        const env  = Math.sin(Math.PI * frac)
        const y    = cy + Math.sin(2 * Math.PI * strandHz * frac + phase) * maxAmp * env
        s === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)
      }
      ctx.stroke()
      ctx.restore()

      // Crisp strand pass.
      ctx.save()
      ctx.lineCap   = 'round'
      ctx.lineJoin  = 'round'
      ctx.lineWidth = 1.5
      {
        const sg = ctx.createLinearGradient(strandX0, 0, strandX0 + strandW, 0)
        sg.addColorStop(0,    'rgba(255, 210,  80, 0)')
        sg.addColorStop(0.1,  'rgba(255, 210,  80, 0.40)')
        sg.addColorStop(0.5,  'rgba(255, 235, 120, 0.54)')
        sg.addColorStop(0.9,  'rgba(255, 210,  80, 0.40)')
        sg.addColorStop(1,    'rgba(255, 210,  80, 0)')
        ctx.strokeStyle = sg
      }
      ctx.beginPath()
      for (let s = 0; s <= STEPS; s++) {
        const frac = s / STEPS
        const x    = strandX0 + frac * strandW
        const env  = Math.sin(Math.PI * frac)
        const y    = cy + Math.sin(2 * Math.PI * strandHz * frac + phase) * maxAmp * env
        s === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)
      }
      ctx.stroke()
      ctx.restore()

      // ── Trails for L and R read-heads ─────────────────────────────────────
      trailL.push({ x: tapLX, y: tapLY })
      trailR.push({ x: tapRX, y: tapRY })
      if (trailL.length > TRAIL_LEN) trailL.shift()
      if (trailR.length > TRAIL_LEN) trailR.shift()

      for (let j = 0; j < trailL.length - 1; j++) {
        const prog  = (j + 1) / trailL.length
        const { x, y } = trailL[j]
        const ta = mixAlpha * prog * 0.20
        const tr2 = 3.5 + prog * 3.5
        ctx.save()
        ctx.globalAlpha = ta
        const tgL = ctx.createRadialGradient(x, y, 0, x, y, tr2)
        tgL.addColorStop(0, 'rgba(255, 205, 70, 0.9)')
        tgL.addColorStop(1, 'rgba(200, 110,  5, 0)')
        ctx.fillStyle = tgL
        ctx.beginPath()
        ctx.arc(x, y, tr2, 0, 2 * Math.PI)
        ctx.fill()
        ctx.restore()
      }

      for (let j = 0; j < trailR.length - 1; j++) {
        const prog  = (j + 1) / trailR.length
        const { x, y } = trailR[j]
        const ta = mixAlpha * prog * 0.20
        const tr2 = 3.5 + prog * 3.5
        ctx.save()
        ctx.globalAlpha = ta
        const tgR = ctx.createRadialGradient(x, y, 0, x, y, tr2)
        tgR.addColorStop(0, 'rgba(200, 140, 255, 0.9)')
        tgR.addColorStop(1, 'rgba( 85,  35, 175, 0)')
        ctx.fillStyle = tgR
        ctx.beginPath()
        ctx.arc(x, y, tr2, 0, 2 * Math.PI)
        ctx.fill()
        ctx.restore()
      }

      // ── Connector lines: write-head → L and R taps ───────────────────────
      // Width and glow scale with |feedback|. Color follows feedback polarity.
      const connAlpha = 0.05 + fbAbs * 0.22
      const connWidth = 0.8 + fbAbs * 1.6
      const connGlow  = fbAbs * 8

      ctx.save()
      ctx.lineWidth   = connWidth
      ctx.shadowBlur  = connGlow
      ctx.shadowColor = fbNorm >= 0 ? 'rgba(200, 140, 40, 0.55)' : 'rgba(100, 60, 220, 0.55)'

      const glL = ctx.createLinearGradient(baseX, cy, tapLX, tapLY)
      glL.addColorStop(0, `rgba(220, 160, 30, ${(connAlpha * 1.2).toFixed(3)})`)
      glL.addColorStop(1, 'rgba(255, 210, 80, 0)')
      ctx.strokeStyle = glL
      ctx.beginPath()
      ctx.moveTo(baseX, cy)
      ctx.lineTo(tapLX, tapLY)
      ctx.stroke()

      const glR = ctx.createLinearGradient(baseX, cy, tapRX, tapRY)
      glR.addColorStop(0, `rgba(160, 100, 240, ${(connAlpha * 1.2).toFixed(3)})`)
      glR.addColorStop(1, 'rgba(200, 140, 255, 0)')
      ctx.strokeStyle = glR
      ctx.beginPath()
      ctx.moveTo(baseX, cy)
      ctx.lineTo(tapRX, tapRY)
      ctx.stroke()
      ctx.restore()

      // ── Feedback glow around write-head ───────────────────────────────────
      // Positive feedback: warm amber aura. Negative feedback: cool purple aura.
      if (fbAbs > 0.02) {
        const glowR = 8 + fbAbs * 20
        const [fr, fg, fb2] = fbNorm >= 0 ? [220, 150, 20] : [100, 55, 240]
        const fbG = ctx.createRadialGradient(baseX, cy, 0, baseX, cy, glowR)
        fbG.addColorStop(0,   `rgba(${fr},${fg},${fb2},${(0.20 * fbAbs).toFixed(3)})`)
        fbG.addColorStop(1,   `rgba(${fr},${fg},${fb2},0)`)
        ctx.save()
        ctx.fillStyle = fbG
        ctx.beginPath()
        ctx.arc(baseX, cy, glowR, 0, 2 * Math.PI)
        ctx.fill()
        ctx.restore()
      }

      // ── L read-head (amber) ───────────────────────────────────────────────
      const headR    = 5.5
      const glowBlur = 6 + fbAbs * 18

      ctx.save()
      ctx.globalAlpha = mixAlpha
      ctx.shadowBlur  = glowBlur
      ctx.shadowColor = 'rgba(240, 160, 20, 0.85)'
      const lgH = ctx.createRadialGradient(tapLX, tapLY, 0, tapLX, tapLY, headR * 1.7)
      lgH.addColorStop(0,    'rgba(255, 245, 150, 1.0)')
      lgH.addColorStop(0.35, 'rgba(240, 180,  30, 0.9)')
      lgH.addColorStop(1,    'rgba(180,  90,  10, 0)')
      ctx.fillStyle = lgH
      ctx.beginPath()
      ctx.arc(tapLX, tapLY, headR, 0, 2 * Math.PI)
      ctx.fill()
      ctx.restore()

      // ── R read-head (purple) ──────────────────────────────────────────────
      ctx.save()
      ctx.globalAlpha = mixAlpha
      ctx.shadowBlur  = glowBlur
      ctx.shadowColor = 'rgba(140, 80, 220, 0.85)'
      const rgH = ctx.createRadialGradient(tapRX, tapRY, 0, tapRX, tapRY, headR * 1.7)
      rgH.addColorStop(0,    'rgba(220, 160, 255, 1.0)')
      rgH.addColorStop(0.35, 'rgba(150,  80, 230, 0.9)')
      rgH.addColorStop(1,    'rgba( 80,  30, 160, 0)')
      ctx.fillStyle = rgH
      ctx.beginPath()
      ctx.arc(tapRX, tapRY, headR, 0, 2 * Math.PI)
      ctx.fill()
      ctx.restore()

      // ── Write-head (base delay position) ─────────────────────────────────
      // Smaller fixed amber dot — the origin from which both taps sweep.
      const whR = 4
      ctx.save()
      ctx.shadowBlur  = 8 + fbAbs * 6
      ctx.shadowColor = 'rgba(240, 180, 20, 0.9)'
      const wG = ctx.createRadialGradient(baseX, cy, 0, baseX, cy, whR * 1.6)
      wG.addColorStop(0,    'rgba(255, 245, 180, 1.0)')
      wG.addColorStop(0.4,  'rgba(240, 180,  30, 0.85)')
      wG.addColorStop(1,    'rgba(120,  50,   0, 0)')
      ctx.fillStyle = wG
      ctx.beginPath()
      ctx.arc(baseX, cy, whR, 0, 2 * Math.PI)
      ctx.fill()
      ctx.restore()

      // ── Stereo width indicator (bottom strip) ─────────────────────────────
      // L (amber) and R (purple) node pair whose spread reflects width %.
      // Gentle oscillation driven by depth makes it feel alive at rest.
      // Pattern matches ChorusOrbitVisualizer for visual consistency.
      const indY    = cssH - 13
      const indSpan = cssW * 0.36
      const osc     = Math.sin(angVel * t * 0.5) * depthNorm * 2.0
      const indLX   = cssW * 0.5 - indSpan * widthNorm * 0.9 + osc * 0.5
      const indRX   = cssW * 0.5 + indSpan * widthNorm * 0.9 - osc * 0.5
      const indDot  = 2.8 + depthNorm * 1.2
      const indA    = 0.28 + (mix / 100) * 0.45

      ctx.save()
      ctx.strokeStyle = 'rgba(200, 180, 255, 0.07)'
      ctx.lineWidth   = 1
      ctx.beginPath()
      ctx.moveTo(cssW * 0.5 - indSpan * 1.06, indY)
      ctx.lineTo(cssW * 0.5 + indSpan * 1.06, indY)
      ctx.stroke()
      ctx.restore()

      ctx.save()
      ctx.strokeStyle = 'rgba(200, 180, 255, 0.13)'
      ctx.lineWidth   = 1
      ctx.beginPath()
      ctx.moveTo(cssW * 0.5, indY - 2.5)
      ctx.lineTo(cssW * 0.5, indY + 2.5)
      ctx.stroke()
      ctx.restore()

      ctx.save()
      ctx.globalAlpha = indA
      ctx.shadowBlur  = 4 + depthNorm * 3
      ctx.shadowColor = 'rgba(240, 160, 20, 0.7)'
      const liG = ctx.createRadialGradient(indLX, indY, 0, indLX, indY, indDot * 2.2)
      liG.addColorStop(0, 'rgba(255, 215,  80, 0.95)')
      liG.addColorStop(1, 'rgba(200, 120,  10, 0)')
      ctx.fillStyle = liG
      ctx.beginPath()
      ctx.arc(indLX, indY, indDot, 0, 2 * Math.PI)
      ctx.fill()
      ctx.restore()

      ctx.save()
      ctx.globalAlpha = indA
      ctx.shadowBlur  = 4 + depthNorm * 3
      ctx.shadowColor = 'rgba(140, 80, 220, 0.7)'
      const riG = ctx.createRadialGradient(indRX, indY, 0, indRX, indY, indDot * 2.2)
      riG.addColorStop(0, 'rgba(210, 155, 255, 0.95)')
      riG.addColorStop(1, 'rgba(100,  50, 180, 0)')
      ctx.fillStyle = riG
      ctx.beginPath()
      ctx.arc(indRX, indY, indDot, 0, 2 * Math.PI)
      ctx.fill()
      ctx.restore()

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
      className="flanger-viz-canvas"
      style={{ display: 'block', width: '100%', height: '100%' }}
    />
  )
}
