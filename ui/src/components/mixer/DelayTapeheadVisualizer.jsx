// ─── DelayTapeheadVisualizer.jsx ──────────────────────────────────────────────
// Self-contained canvas visualizer for the Delay bespoke panel.
// Animation runs in one requestAnimationFrame loop, starts on mount, stops on
// unmount. No engine data polled — purely param-driven via paramsRef.
//
// Thread/lifecycle note:
//   DelayPanel returns null when delayStore.target is null, which fully unmounts
//   this component. React calls the useEffect cleanup: cancelled = true +
//   cancelAnimationFrame — zero background work after close.

import { useEffect, useRef } from 'react'

// ── Pure helpers (exported for unit tests) ───────────────────────────────────

/** Clamps v to [lo, hi]. */
export function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v))
}

/** Maps mix (0–100 %) to wet opacity in [0.12, 1.0]. */
export function mixToAlpha(mixPct) {
  return 0.12 + clamp(mixPct / 100, 0, 1) * 0.88
}

/** Maps feedback (0–95 %) to per-echo decay factor in [0, 1]. */
export function feedbackToDecay(fbPct) {
  return clamp(fbPct / 95, 0, 1)
}

/** Returns the LFO phase in radians given rate (Hz) and elapsed time (ms). */
export function lfoPhase(rateHz, elapsedMs) {
  return (2 * Math.PI * rateHz * elapsedMs) / 1000
}

/**
 * Maps a delay time (ms) to a normalised x position [0, 1].
 * axisMaxMs is the total visible range in ms.
 */
export function timeToNorm(timeMs, axisMaxMs) {
  return clamp(timeMs / axisMaxMs, 0, 1)
}

/**
 * Derives the visible axis range (ms) from current L and R delay times.
 * Keeps the first tapehead at roughly 33 % of the visible width.
 * Result is clamped to [800, 5000] ms.
 */
export function computeAxisMax(timeLMs, timeRMs) {
  const peak = Math.max(timeLMs, timeRMs, 1)
  return clamp(peak * 2.8, 800, 5000)
}

// Decode a legacy sync_div index to a display label for the sync grid.
// Matches engine kDivFractions order exactly:
//   0=1/1, 1=1/2, 2=1/2D, 3=1/4, 4=1/4D, 5=1/4T,
//   6=1/8, 7=1/8D, 8=1/8T, 9=1/16, 10=1/16D, 11=1/16T
const SYNC_DIV_LABELS = [
  '1/1','1/2','1/2D','1/4','1/4D','1/4T',
  '1/8','1/8D','1/8T','1/16','1/16D','1/16T',
]

/** Returns the display label for a legacy sync_div index (0–11). */
export function syncDivLabel(idx) {
  const i = Math.round(clamp(idx ?? 3, 0, 11))
  return SYNC_DIV_LABELS[i] ?? '1/4'
}

// Beat-fraction multipliers, parallel to engine kDivFractions.
const K_FRACS = [4, 2, 3, 1, 1.5, 2/3, 0.5, 0.75, 1/3, 0.25, 0.375, 1/6]

// ── Internal theme reader ─────────────────────────────────────────────────────

function readDelayTheme(canvas) {
  const cs  = canvas ? getComputedStyle(canvas) : null
  const get = (k, fb) => { const v = cs?.getPropertyValue(k)?.trim(); return v || fb }
  return { bgInset: get('--theme-bg-inset', '#0d0d14') }
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function DelayTapeheadVisualizer({ params }) {
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

      // DPR-aware backing-store resize.
      const dpr  = Math.max(1, window.devicePixelRatio || 1)
      const rect = canvas.getBoundingClientRect()
      const cssW = rect.width  > 0 ? rect.width  : 520
      const cssH = rect.height > 0 ? rect.height : 150
      const tw   = Math.round(cssW * dpr)
      const th   = Math.round(cssH * dpr)
      if (canvas.width !== tw || canvas.height !== th) {
        canvas.width  = tw
        canvas.height = th
      }

      const ctx = canvas.getContext('2d', { alpha: false })
      if (!ctx) { rafRef.current = requestAnimationFrame(draw); return }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)

      const { bgInset } = readDelayTheme(canvas)
      const t = now - t0

      // ── Param extraction ──────────────────────────────────────────────────
      const timeL    = clamp(p.time_l       ?? 500,   1,    5000)
      const timeR    = clamp(p.time_r       ?? 500,   1,    5000)
      const feedback = clamp(p.feedback     ?? 30,    0,    95)
      const mix      = clamp(p.mix          ?? 30,    0,    100)
      const filterLo = clamp(p.filter_lo    ?? 80,    20,   2000)
      const filterHi = clamp(p.filter_hi    ?? 12000, 1000, 20000)
      const modRate  = clamp(p.mod_rate     ?? 0.3,   0.01, 5)
      const modDepth = clamp(p.mod_depth    ?? 15,    0,    100)
      const widthPct = clamp(p.stereo_width ?? 50,    0,    100)
      const duckAmt  = clamp(p.duck_amount  ?? 0,     0,    100)
      const synced   = (p.sync ?? 0) >= 0.5
      const divL     = Math.round(clamp(p.sync_div_l ?? 3, 0, 11))
      const divR     = Math.round(clamp(p.sync_div_r ?? 3, 0, 11))

      const fbDecay   = feedbackToDecay(feedback)
      const mixAlpha  = mixToAlpha(mix)
      const depthNorm = clamp(modDepth / 100, 0, 1)
      const widthNorm = clamp(widthPct / 100, 0, 1)
      const duckNorm  = clamp(duckAmt  / 100, 0, 1)

      // Filter openness: ratio of audible band width on a log scale.
      // 1.0 = fully open (20–20k), 0 = very narrow band.
      const logRange = Math.log2(20000) - Math.log2(20)  // ≈ 10 octaves
      const filterOpenness = clamp((Math.log2(filterHi) - Math.log2(filterLo)) / logRange, 0, 1)

      const axisMax = computeAxisMax(timeL, timeR)

      // LFO phases: R is offset by width × π to mirror the Flanger stereo model.
      const lfoL = lfoPhase(modRate, t)
      const lfoR = lfoL + widthNorm * Math.PI

      // Wobble: 12 % of the base delay time, capped at 120 ms.
      const wobbleL = depthNorm * Math.min(timeL * 0.12, 120)
      const wobbleR = depthNorm * Math.min(timeR * 0.12, 120)

      const instL = clamp(timeL + wobbleL * Math.sin(lfoL), 1, 5000)
      const instR = clamp(timeR + wobbleR * Math.sin(lfoR), 1, 5000)

      // Canvas layout.
      const padL  = cssW * 0.07
      const padR  = cssW * 0.93
      const axisW = padR - padL
      const cy    = cssH * 0.44

      const toX = (ms) => padL + timeToNorm(ms, axisMax) * axisW

      // Write-head (input signal): fixed near the left edge.
      const writeX = padL + cssW * 0.018

      // Tapehead vertical positions: L above axis, R below, spread by width.
      const vSpread = cssH * 0.16 * widthNorm
      const tapLY   = cy - vSpread - depthNorm * cssH * 0.08 * Math.sin(lfoL)
      const tapRY   = cy + vSpread + depthNorm * cssH * 0.08 * Math.sin(lfoR)
      const tapLX   = toX(instL)
      const tapRX   = toX(instR)

      // ── Background ────────────────────────────────────────────────────────

      ctx.fillStyle = bgInset
      ctx.fillRect(0, 0, cssW, cssH)

      // Warm amber glow centred between the two tapeheads.
      const glowCX = (tapLX + tapRX) * 0.5
      const ambG   = ctx.createRadialGradient(glowCX, cy, 0, glowCX, cy, cssW * 0.52)
      ambG.addColorStop(0,   'rgba(140,  80,   0, 0.10)')
      ambG.addColorStop(0.5, 'rgba( 70,  30,  90, 0.05)')
      ambG.addColorStop(1,   'rgba(  0,   0,   0, 0)')
      ctx.fillStyle = ambG
      ctx.fillRect(0, 0, cssW, cssH)

      // Cool purple accent, offset toward the right.
      const purX = cssW * 0.72
      const purG = ctx.createRadialGradient(purX, cy * 0.70, 0, purX, cy * 0.70, cssW * 0.46)
      purG.addColorStop(0, 'rgba(55, 15, 100, 0.07)')
      purG.addColorStop(1, 'rgba( 0,  0,   0, 0)')
      ctx.fillStyle = purG
      ctx.fillRect(0, 0, cssW, cssH)

      // Corner vignette.
      const vigG = ctx.createRadialGradient(
        cssW * 0.5, cssH * 0.5, Math.min(cssW, cssH) * 0.2,
        cssW * 0.5, cssH * 0.5, Math.max(cssW, cssH) * 0.8,
      )
      vigG.addColorStop(0, 'rgba(0,0,0,0)')
      vigG.addColorStop(1, 'rgba(0,0,0,0.38)')
      ctx.fillStyle = vigG
      ctx.fillRect(0, 0, cssW, cssH)

      // ── Sync beat grid ────────────────────────────────────────────────────
      if (synced) {
        // Use a nominal 140 BPM for grid spacing — this is visual only.
        const beatMs  = 60000 / 140
        const stepL   = beatMs * K_FRACS[divL]
        const stepR   = beatMs * K_FRACS[divR]
        const minStep = Math.min(stepL, stepR)

        ctx.save()
        ctx.strokeStyle = 'rgba(190, 150, 255, 0.07)'
        ctx.lineWidth   = 1
        for (let g = 1; g * minStep <= axisMax && g <= 32; g++) {
          const gx = toX(minStep * g)
          if (gx < padL || gx > padR) continue
          ctx.beginPath()
          ctx.moveTo(gx, cssH * 0.08)
          ctx.lineTo(gx, cssH * 0.78)
          ctx.stroke()
        }
        ctx.restore()

        // Division labels above the tapeheads.
        ctx.save()
        ctx.font         = '8px monospace'
        ctx.textAlign    = 'center'
        ctx.textBaseline = 'bottom'
        ctx.fillStyle    = 'rgba(205, 175, 255, 0.55)'
        ctx.fillText(syncDivLabel(divL), tapLX, tapLY - 9)
        ctx.fillText(syncDivLabel(divR), tapRX, tapRY - 9)
        ctx.restore()
      }

      // ── Horizontal axis ───────────────────────────────────────────────────

      ctx.save()
      ctx.strokeStyle = 'rgba(180, 140, 255, 0.10)'
      ctx.lineWidth   = 1
      ctx.setLineDash([3, 7])
      ctx.beginPath()
      ctx.moveTo(padL, cy)
      ctx.lineTo(padR, cy)
      ctx.stroke()
      ctx.setLineDash([])

      // Tick spacing adapts to the visible range.
      const ticks = axisMax <= 1200 ? [100, 250, 500, 750, 1000]
                  : axisMax <= 2500 ? [250, 500, 1000, 1500, 2000]
                  : [500, 1000, 2000, 3000, 4000, 5000]

      ctx.font         = '8px monospace'
      ctx.textAlign    = 'center'
      ctx.textBaseline = 'top'
      for (const ms of ticks) {
        if (ms > axisMax) break
        const tx = toX(ms)
        ctx.strokeStyle = 'rgba(180, 140, 255, 0.12)'
        ctx.lineWidth   = 1
        ctx.beginPath()
        ctx.moveTo(tx, cy - 3)
        ctx.lineTo(tx, cy + 3)
        ctx.stroke()
        ctx.fillStyle = 'rgba(180, 140, 255, 0.22)'
        const label = ms >= 1000 ? `${(ms / 1000).toFixed(ms % 1000 === 0 ? 0 : 1)}s` : `${ms}`
        ctx.fillText(label, tx, cy + 5)
      }
      ctx.restore()

      // ── Filter shading over the echo region ───────────────────────────────
      // Darker purple tint behind the tapeheads and echoes when band is narrow.
      const filterTint = 1 - filterOpenness
      if (filterTint > 0.06) {
        const fxL    = Math.min(tapLX, tapRX)
        const fShadow = ctx.createLinearGradient(fxL, 0, padR, 0)
        fShadow.addColorStop(0,    `rgba(18,8,38,0)`)
        fShadow.addColorStop(0.12, `rgba(18,8,38,${(filterTint * 0.20).toFixed(3)})`)
        fShadow.addColorStop(1,    `rgba(18,8,38,${(filterTint * 0.35).toFixed(3)})`)
        ctx.fillStyle = fShadow
        ctx.fillRect(fxL, cssH * 0.04, padR - fxL, cssH * 0.80)
      }

      // ── Echo repeat ghosts (n = 2 .. 5) ──────────────────────────────────
      // Each nth echo sits at n×instTime and fades as fbDecay^(n-1).
      // Drawn back-to-front (largest n first) so nearer echoes render on top.
      const ECHO_COUNT = 5
      for (let n = ECHO_COUNT; n >= 2; n--) {
        const echoAlpha = mixAlpha * Math.pow(fbDecay, n - 1)
        if (echoAlpha < 0.013) continue

        const exL = toX(clamp(instL * n, 1, 5000))
        const exR = toX(clamp(instR * n, 1, 5000))
        const eyL = tapLY + (n - 1) * vSpread * 0.12
        const eyR = tapRY - (n - 1) * vSpread * 0.12
        const r   = Math.max(0.5, 3.8 - n * 0.5)

        if (exL <= padR + 8) {
          ctx.save()
          ctx.globalAlpha = echoAlpha * 0.68
          const egL = ctx.createRadialGradient(exL, eyL, 0, exL, eyL, r * 2.2)
          egL.addColorStop(0, 'rgba(255, 200, 70, 0.95)')
          egL.addColorStop(1, 'rgba(178,  88,  5, 0)')
          ctx.fillStyle = egL
          ctx.beginPath()
          ctx.arc(exL, eyL, r, 0, 2 * Math.PI)
          ctx.fill()
          ctx.restore()
        }

        if (exR <= padR + 8) {
          ctx.save()
          ctx.globalAlpha = echoAlpha * 0.68
          const egR = ctx.createRadialGradient(exR, eyR, 0, exR, eyR, r * 2.2)
          egR.addColorStop(0, 'rgba(200, 145, 255, 0.95)')
          egR.addColorStop(1, 'rgba( 78,  28, 152, 0)')
          ctx.fillStyle = egR
          ctx.beginPath()
          ctx.arc(exR, eyR, r, 0, 2 * Math.PI)
          ctx.fill()
          ctx.restore()
        }
      }

      // ── Write-head (input signal, dimmed by duck) ─────────────────────────
      const writeAlpha = 0.72 - duckNorm * 0.56
      const whR        = 4.5
      ctx.save()
      ctx.globalAlpha = writeAlpha
      ctx.shadowBlur  = 8 + (1 - duckNorm) * 6
      ctx.shadowColor = 'rgba(255, 210, 60, 0.8)'
      const wG = ctx.createRadialGradient(writeX, cy, 0, writeX, cy, whR * 1.8)
      wG.addColorStop(0,   'rgba(255, 242, 158, 1.0)')
      wG.addColorStop(0.4, 'rgba(242, 178,  30, 0.85)')
      wG.addColorStop(1,   'rgba(118,  48,   0, 0)')
      ctx.fillStyle = wG
      ctx.beginPath()
      ctx.arc(writeX, cy, whR, 0, 2 * Math.PI)
      ctx.fill()
      ctx.restore()

      // ── Feedback glow on write-head ───────────────────────────────────────
      if (fbDecay > 0.03) {
        const fgR  = 7 + fbDecay * 18
        const fbGl = ctx.createRadialGradient(writeX, cy, 0, writeX, cy, fgR)
        fbGl.addColorStop(0, `rgba(222,145,20,${(0.18 * fbDecay).toFixed(3)})`)
        fbGl.addColorStop(1, 'rgba(222,145,20,0)')
        ctx.save()
        ctx.fillStyle = fbGl
        ctx.beginPath()
        ctx.arc(writeX, cy, fgR, 0, 2 * Math.PI)
        ctx.fill()
        ctx.restore()
      }

      // ── Connector lines: write-head → L and R tapeheads ──────────────────
      const connAlpha = 0.04 + fbDecay * 0.18
      const connWidth = 0.7 + fbDecay * 1.5

      ctx.save()
      ctx.lineWidth   = connWidth
      ctx.shadowBlur  = fbDecay * 7
      ctx.shadowColor = 'rgba(200, 130, 30, 0.5)'
      const glL = ctx.createLinearGradient(writeX, cy, tapLX, tapLY)
      glL.addColorStop(0, `rgba(222,155,30,${(connAlpha * 1.3).toFixed(3)})`)
      glL.addColorStop(1, 'rgba(255,205,75,0)')
      ctx.strokeStyle = glL
      ctx.beginPath()
      ctx.moveTo(writeX, cy)
      ctx.lineTo(tapLX, tapLY)
      ctx.stroke()

      ctx.shadowColor = 'rgba(130, 80, 222, 0.5)'
      const glR = ctx.createLinearGradient(writeX, cy, tapRX, tapRY)
      glR.addColorStop(0, `rgba(155, 95,235,${(connAlpha * 1.3).toFixed(3)})`)
      glR.addColorStop(1, 'rgba(200,140,255,0)')
      ctx.strokeStyle = glR
      ctx.beginPath()
      ctx.moveTo(writeX, cy)
      ctx.lineTo(tapRX, tapRY)
      ctx.stroke()
      ctx.restore()

      // ── L tapehead (amber) ────────────────────────────────────────────────
      const headR    = 5.5
      const glowBlur = 5 + fbDecay * 16

      ctx.save()
      ctx.globalAlpha = mixAlpha
      ctx.shadowBlur  = glowBlur
      ctx.shadowColor = 'rgba(242, 155, 20, 0.85)'
      const lgH = ctx.createRadialGradient(tapLX, tapLY, 0, tapLX, tapLY, headR * 1.8)
      lgH.addColorStop(0,    'rgba(255, 242, 140, 1.0)')
      lgH.addColorStop(0.35, 'rgba(242, 175,  30, 0.9)')
      lgH.addColorStop(1,    'rgba(175,  85,  10, 0)')
      ctx.fillStyle = lgH
      ctx.beginPath()
      ctx.arc(tapLX, tapLY, headR, 0, 2 * Math.PI)
      ctx.fill()
      ctx.restore()

      // ── R tapehead (purple) ───────────────────────────────────────────────
      ctx.save()
      ctx.globalAlpha = mixAlpha
      ctx.shadowBlur  = glowBlur
      ctx.shadowColor = 'rgba(140, 78, 222, 0.85)'
      const rgH = ctx.createRadialGradient(tapRX, tapRY, 0, tapRX, tapRY, headR * 1.8)
      rgH.addColorStop(0,    'rgba(222, 155, 255, 1.0)')
      rgH.addColorStop(0.35, 'rgba(150,  78, 232, 0.9)')
      rgH.addColorStop(1,    'rgba( 75,  28, 155, 0)')
      ctx.fillStyle = rgH
      ctx.beginPath()
      ctx.arc(tapRX, tapRY, headR, 0, 2 * Math.PI)
      ctx.fill()
      ctx.restore()

      // ── Duck shading on input region ──────────────────────────────────────
      if (duckNorm > 0.05) {
        const duckG = ctx.createLinearGradient(0, 0, writeX + cssW * 0.14, 0)
        duckG.addColorStop(0, `rgba(0,0,0,${(duckNorm * 0.30).toFixed(3)})`)
        duckG.addColorStop(1, 'rgba(0,0,0,0)')
        ctx.fillStyle = duckG
        ctx.fillRect(0, cssH * 0.05, writeX + cssW * 0.14, cssH * 0.78)
      }

      // ── Stereo width indicator (bottom strip) ─────────────────────────────
      const indY    = cssH - 11
      const indSpan = cssW * 0.35
      const indOsc  = Math.sin(lfoL * 0.5) * depthNorm * 1.5
      const indLX   = cssW * 0.5 - indSpan * widthNorm * 0.9 + indOsc * 0.4
      const indRX   = cssW * 0.5 + indSpan * widthNorm * 0.9 - indOsc * 0.4
      const indDot  = 2.6 + depthNorm * 1.2
      const indA    = 0.25 + mixAlpha * 0.40

      ctx.save()
      ctx.strokeStyle = 'rgba(200, 175, 255, 0.06)'
      ctx.lineWidth   = 1
      ctx.beginPath()
      ctx.moveTo(cssW * 0.5 - indSpan * 1.05, indY)
      ctx.lineTo(cssW * 0.5 + indSpan * 1.05, indY)
      ctx.stroke()
      ctx.restore()

      ctx.save()
      ctx.strokeStyle = 'rgba(200, 175, 255, 0.12)'
      ctx.lineWidth   = 1
      ctx.beginPath()
      ctx.moveTo(cssW * 0.5, indY - 2)
      ctx.lineTo(cssW * 0.5, indY + 2)
      ctx.stroke()
      ctx.restore()

      ctx.save()
      ctx.globalAlpha = indA
      ctx.shadowBlur  = 3 + depthNorm * 3
      ctx.shadowColor = 'rgba(242, 155, 20, 0.70)'
      const liG = ctx.createRadialGradient(indLX, indY, 0, indLX, indY, indDot * 2.2)
      liG.addColorStop(0, 'rgba(255, 212,  80, 0.95)')
      liG.addColorStop(1, 'rgba(195, 112,  10, 0)')
      ctx.fillStyle = liG
      ctx.beginPath()
      ctx.arc(indLX, indY, indDot, 0, 2 * Math.PI)
      ctx.fill()
      ctx.restore()

      ctx.save()
      ctx.globalAlpha = indA
      ctx.shadowBlur  = 3 + depthNorm * 3
      ctx.shadowColor = 'rgba(140, 75, 222, 0.70)'
      const riG = ctx.createRadialGradient(indRX, indY, 0, indRX, indY, indDot * 2.2)
      riG.addColorStop(0, 'rgba(212, 150, 255, 0.95)')
      riG.addColorStop(1, 'rgba( 95,  45, 178, 0)')
      ctx.fillStyle = riG
      ctx.beginPath()
      ctx.arc(indRX, indY, indDot, 0, 2 * Math.PI)
      ctx.fill()
      ctx.restore()

      rafRef.current = requestAnimationFrame(draw)
    }

    rafRef.current = requestAnimationFrame(draw)

    // Cleanup: cancelled flag stops the in-flight guard immediately;
    // cancelAnimationFrame drops the pending queued call.
    return () => {
      cancelled = true
      cancelAnimationFrame(rafRef.current)
    }
  }, []) // Empty deps: all per-frame data flows through paramsRef.

  return (
    <canvas
      ref={canvasRef}
      className="delay-viz-canvas"
      style={{ display: 'block', width: '100%', height: '100%' }}
    />
  )
}
