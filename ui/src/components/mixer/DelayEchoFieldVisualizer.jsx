// ─── DelayEchoFieldVisualizer.jsx ─────────────────────────────────────────────
// The Delay panel's centrepiece: a flat, hard-edged "echo field".
//
// Reads left→right as time. The centre rule is the input instant; L taps grow
// upward, R taps grow downward. Everything on screen is derived from a live
// engine parameter — nothing decorative:
//
//   time_l / time_r  → horizontal position of each lane's tap series
//   feedback         → tap count and the decay envelope's slope
//   mix              → wet opacity, and the height of the DRY column at the head
//   stereo_width     → ping-pong cross-feed: energy transfer between lanes,
//                      plus the zigzag bounce trace when cross-feed is engaged
//   mod_rate/_depth  → per-tap horizontal wobble (animated)
//   duck_amount      → attenuation shade over the early field
//   sync/sync_div_*  → grid switches from milliseconds to musical divisions
//
// Style: no gradients, no glow, no rounded corners. One accent, used only where
// it carries meaning (wet energy, sync state). Neutral greys carry structure.
//
// Thread/lifecycle note:
//   DelayPanel returns null when delayStore.target is null, which unmounts this
//   component. React runs the effect cleanup: cancelled = true +
//   cancelAnimationFrame — zero background work after close.

import { useEffect, useRef } from 'react'
import {
  clamp,
  mixToAlpha,
  feedbackToDecay,
  lfoPhase,
  timeToNorm,
  computeAxisMax,
  divisionToMs,
  echoTaps,
  crossFeedForMode,
  singleModeLaneTimes,
  STEREO_MODE_SINGLE,
} from './delayVizMath.js'
import {
  withAlpha,
  readMixerCanvasTheme,
  syncCanvasSize,
  MONO,
  MONO_SM,
} from './mixerCanvasTheme.js'

const BAR_W = 4
const MAX_TAPS = 14

export default function DelayEchoFieldVisualizer({ params, bpm = 120 }) {
  const canvasRef = useRef(null)
  const paramsRef = useRef(params)
  const bpmRef = useRef(bpm)
  const rafRef = useRef(0)

  // Keep the latest values readable every frame without restarting the loop.
  paramsRef.current = params
  bpmRef.current = bpm

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return

    let cancelled = false
    const t0 = performance.now()

    function draw(now) {
      if (cancelled) return

      const p = paramsRef.current
      const size = syncCanvasSize(canvas, 660, 236)
      const ctx = canvas.getContext('2d', { alpha: false })
      if (!ctx) { rafRef.current = requestAnimationFrame(draw); return }
      const { cssW, cssH, dpr } = size
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)

      const th = readMixerCanvasTheme(canvas)
      const t = now - t0

      // ── Params ────────────────────────────────────────────────────────────
      const feedback = clamp(p.feedback ?? 30, 0, 95)
      const mix = clamp(p.mix ?? 30, 0, 100)
      const modRate = clamp(p.mod_rate ?? 0.3, 0.01, 5)
      const modDepth = clamp(p.mod_depth ?? 15, 0, 100)
      const widthPct = clamp(p.stereo_width ?? 50, 0, 100)
      const duckAmt = clamp(p.duck_amount ?? 0, 0, 100)
      const synced = (p.sync ?? 0) >= 0.5
      const divL = Math.round(clamp(p.sync_div_l ?? 3, 0, 11))
      const divR = Math.round(clamp(p.sync_div_r ?? 3, 0, 11))
      const stereoMode = Math.round(clamp(p.stereo_mode ?? 1, 0, 2))

      // In sync the engine derives its delay from the transport tempo, so the
      // field must plot the division — not the (now inactive) free-time knob.
      let timeL = synced
        ? clamp(divisionToMs(divL, bpmRef.current), 1, 5000)
        : clamp(p.time_l ?? 500, 1, 5000)
      let timeR = synced
        ? clamp(divisionToMs(divR, bpmRef.current), 1, 5000)
        : clamp(p.time_r ?? 500, 1, 5000)

      // Single: one time base drives both lines, spread symmetrically by the
      // (repurposed) stereo_width knob — the R lane's own time/div is inactive.
      if (stereoMode === STEREO_MODE_SINGLE) {
        const lane = singleModeLaneTimes(timeL, widthPct)
        timeL = lane.timeL
        timeR = lane.timeR
      }

      // Effective cross-feed for the tap simulation: Single forces 0 (no
      // zigzag — spread already separated the lanes above), PingPong forces
      // 100 (always fully alternating), Dual passes the knob through.
      const crossPct = crossFeedForMode(stereoMode, widthPct)

      const mixAlpha = mixToAlpha(mix)
      const fbDecay = feedbackToDecay(feedback)
      const depthNorm = clamp(modDepth / 100, 0, 1)
      const widthNorm = clamp(crossPct / 100, 0, 1)
      const duckNorm = clamp(duckAmt / 100, 0, 1)
      const axisMax = computeAxisMax(timeL, timeR)

      // ── Layout ────────────────────────────────────────────────────────────
      const padL = 40
      const padR = cssW - 14
      const axisW = Math.max(20, padR - padL)
      const topY = 20
      const botY = cssH - 20
      const cy = Math.round((topY + botY) / 2) + 0.5
      const laneH = (botY - topY) / 2 - 4

      const toX = (ms) => padL + timeToNorm(ms, axisMax) * axisW

      // ── Background ────────────────────────────────────────────────────────
      ctx.fillStyle = th.well
      ctx.fillRect(0, 0, cssW, cssH)

      // Lane bands — a single flat step darker than the well would be invisible,
      // so structure comes from hairlines instead.
      ctx.strokeStyle = withAlpha(th.border, 0.9)
      ctx.lineWidth = 1
      ctx.beginPath()
      ctx.moveTo(padL - 6, topY + 0.5)
      ctx.lineTo(padR, topY + 0.5)
      ctx.moveTo(padL - 6, botY + 0.5)
      ctx.lineTo(padR, botY + 0.5)
      ctx.stroke()

      // ── Time grid ─────────────────────────────────────────────────────────
      // Free: round millisecond steps. Sync: the actual division steps, tinted
      // with the accent so "the grid is musical now" reads at a glance.
      const gridStep = synced
        ? Math.min(divisionToMs(divL, bpmRef.current), divisionToMs(divR, bpmRef.current))
        : (axisMax <= 1200 ? 250 : axisMax <= 2500 ? 500 : 1000)
      const gridColor = synced ? withAlpha(th.accent, 0.13) : withAlpha(th.border, 0.85)

      ctx.strokeStyle = gridColor
      ctx.lineWidth = 1
      ctx.beginPath()
      for (let g = 1; g * gridStep <= axisMax && g <= 40; g++) {
        const gx = Math.round(toX(gridStep * g)) + 0.5
        if (gx <= padL || gx > padR) continue
        ctx.moveTo(gx, topY)
        ctx.lineTo(gx, botY)
      }
      ctx.stroke()

      // Grid labels along the bottom edge.
      ctx.font = MONO_SM
      ctx.textAlign = 'center'
      ctx.textBaseline = 'top'
      ctx.fillStyle = withAlpha(th.textSubtle, 0.75)
      for (let g = 1; g * gridStep <= axisMax && g <= 8; g++) {
        const ms = gridStep * g
        const gx = toX(ms)
        if (gx <= padL + 8 || gx > padR - 12) continue
        ctx.fillText(ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}`, gx, botY + 5)
      }

      // ── Centre rule (the input instant) ───────────────────────────────────
      ctx.strokeStyle = withAlpha(th.borderStrong, 1)
      ctx.lineWidth = 1
      ctx.beginPath()
      ctx.moveTo(padL - 6, cy)
      ctx.lineTo(padR, cy)
      ctx.stroke()

      // ── Tap series ────────────────────────────────────────────────────────
      const taps = echoTaps({
        timeLMs: timeL,
        timeRMs: timeR,
        feedbackPct: feedback,
        crossPct,
        axisMaxMs: axisMax,
        maxTaps: MAX_TAPS,
      })

      // Modulation: per-tap wobble that accumulates over the first few bounces,
      // matching how a modulated feedback loop smears successive repeats.
      const phase = lfoPhase(modRate, t)
      const wobbleMs = depthNorm * Math.min(timeL * 0.1, 90)
      const tapX = (baseMs, n, sign) =>
        toX(baseMs) + sign * wobbleMs * Math.sin(phase + n * 0.55) * Math.min(n, 4) * (axisW / axisMax) * 0.9

      // 0.86 keeps the loudest tap clear of the lane rule; the 0.7 gamma stops
      // late repeats collapsing into the centre line.
      const barH = (g) => Math.max(2, laneH * 0.86 * Math.pow(clamp(g, 0, 1), 0.7))
      const tapAlpha = (g) => clamp(mixAlpha * (0.3 + 0.7 * clamp(g, 0, 1)), 0.03, 1)

      // Ducking pulls the wet down while input is present — i.e. over the head
      // of the field, recovering as the input decays. Painting a shade there is
      // invisible against a near-black well, so the attenuation is applied to
      // the taps themselves, as an exponential recovery so it stays legible at
      // any delay time rather than snapping at a window edge.
      const duckSpanMs = axisMax * 0.3
      const duckGain = (ms) => 1 - duckNorm * 0.8 * Math.exp(-ms / duckSpanMs)

      const ptsL = []
      const ptsR = []
      for (const tap of taps) {
        const xL = tapX(tap.tL, tap.n, 1)
        const xR = tapX(tap.tR, tap.n, -1)
        const gL = tap.gL * duckGain(tap.tL)
        const gR = tap.gR * duckGain(tap.tR)
        if (xL <= padR) ptsL.push({ x: xL, y: cy - barH(gL), g: gL })
        if (xR <= padR) ptsR.push({ x: xR, y: cy + barH(gR), g: gR })
      }

      // Decay envelope — the silhouette of the whole repeat series. The region
      // is closed with vertical edges at the first and last tap so the shape
      // reads as "the repeats", not as a wedge anchored at the input.
      const drawEnvelope = (pts) => {
        if (pts.length < 2) return
        const first = pts[0]
        const last = pts[pts.length - 1]

        ctx.beginPath()
        ctx.moveTo(first.x, cy)
        for (const pt of pts) ctx.lineTo(pt.x, pt.y)
        ctx.lineTo(last.x, cy)
        ctx.closePath()
        ctx.fillStyle = withAlpha(th.accent, 0.1 * mixAlpha)
        ctx.fill()

        ctx.beginPath()
        ctx.moveTo(first.x, first.y)
        for (const pt of pts) ctx.lineTo(pt.x, pt.y)
        ctx.strokeStyle = withAlpha(th.accent, 0.32 * mixAlpha)
        ctx.lineWidth = 1
        ctx.stroke()
      }
      drawEnvelope(ptsL)
      drawEnvelope(ptsR)

      // Ping-pong bounce trace — only drawn when cross-feed is actually routing
      // energy between the lanes.
      const bounces = Math.min(ptsL.length, ptsR.length)
      if (widthNorm > 0.02 && bounces >= 2) {
        ctx.strokeStyle = withAlpha(th.accent, 0.08 + widthNorm * 0.26)
        ctx.lineWidth = 1
        ctx.beginPath()
        ctx.moveTo(ptsL[0].x, ptsL[0].y)
        for (let i = 0; i < bounces; i++) {
          ctx.lineTo(ptsL[i].x, ptsL[i].y)
          ctx.lineTo(ptsR[i].x, ptsR[i].y)
        }
        ctx.stroke()
      }

      // Hard tap bars with a square tip cap, drawn last so they sit on top of
      // the envelope fill.
      const drawBar = (pt, up) => {
        const x = Math.round(pt.x - BAR_W / 2)
        const h = Math.round(Math.abs(pt.y - cy))
        ctx.fillStyle = withAlpha(th.accent, tapAlpha(pt.g))
        ctx.fillRect(x, up ? Math.round(pt.y) : Math.round(cy), BAR_W, h)
        ctx.fillRect(x - 2, Math.round(pt.y) - (up ? 0 : 2), BAR_W + 4, 2)
      }
      for (const pt of ptsL) drawBar(pt, true)
      for (const pt of ptsR) drawBar(pt, false)

      // ── Duck-window bracket ───────────────────────────────────────────────
      // Marks the span whose repeats the attenuation above is acting on.
      if (duckNorm > 0.02) {
        const x0 = padL
        const x1 = toX(duckSpanMs)
        const by = topY + 8.5
        ctx.strokeStyle = withAlpha(th.textMuted, 0.35 + duckNorm * 0.45)
        ctx.lineWidth = 1
        ctx.beginPath()
        ctx.moveTo(x0, by - 3)
        ctx.lineTo(x0, by)
        ctx.lineTo(x1, by)
        ctx.lineTo(x1, by - 3)
        ctx.stroke()

        ctx.font = MONO_SM
        ctx.textAlign = 'center'
        ctx.textBaseline = 'top'
        ctx.fillStyle = withAlpha(th.textMuted, 0.5 + duckNorm * 0.45)
        ctx.fillText(`DUCK ${Math.round(duckAmt)}%`, (x0 + x1) / 2, by + 3)
      }

      // ── Dry column at the head ────────────────────────────────────────────
      // Height tracks the dry proportion, so pushing MIX up visibly trades the
      // grey column for accent-coloured repeats.
      const dryH = laneH * (1 - clamp(mix / 100, 0, 1)) * 0.92
      ctx.fillStyle = withAlpha(th.textMuted, 0.5)
      ctx.fillRect(padL - 1, cy - dryH, 2, dryH * 2)

      ctx.font = MONO_SM
      ctx.textAlign = 'center'
      ctx.textBaseline = 'top'
      ctx.fillStyle = withAlpha(th.textSubtle, 0.85)
      ctx.fillText('DRY', padL, botY + 5)

      // ── Lane tags ─────────────────────────────────────────────────────────
      // The knobs below now carry the precise time/division readout — this
      // canvas stays a silhouette, not a second copy of the numbers.
      ctx.font = MONO
      ctx.textAlign = 'left'
      ctx.textBaseline = 'middle'
      ctx.fillStyle = withAlpha(th.textMuted, 1)
      ctx.fillText('L', 10, cy - laneH * 0.62)
      ctx.fillText('R', 10, cy + laneH * 0.62)

      // Feedback readout, right-aligned against the top rule.
      ctx.textAlign = 'right'
      ctx.font = MONO_SM
      ctx.fillStyle = withAlpha(th.textSubtle, 1)
      ctx.fillText(
        `FB ${Math.round(feedback)}%  ·  ${taps.length} REPEAT${taps.length === 1 ? '' : 'S'}  ·  ${Math.round(fbDecay * 100)}% CARRY`,
        padR,
        6,
      )

      rafRef.current = requestAnimationFrame(draw)
    }

    rafRef.current = requestAnimationFrame(draw)

    return () => {
      cancelled = true
      cancelAnimationFrame(rafRef.current)
    }
  }, []) // Empty deps: all per-frame data flows through refs.

  return (
    <canvas
      ref={canvasRef}
      className="delay-stage-canvas"
      style={{ display: 'block', width: '100%', height: '100%' }}
    />
  )
}
