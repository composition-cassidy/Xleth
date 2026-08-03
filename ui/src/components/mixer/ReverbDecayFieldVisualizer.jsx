// ─── ReverbDecayFieldVisualizer.jsx ───────────────────────────────────────────
// The Reverb panel's centrepiece: a flat, hard-edged "decay field".
//
// Reads left→right as time (logarithmic, 1 ms → 60 s) and bottom-up as energy
// (0 dB at the top, -60 dB at the floor). A log time axis is not a stylistic
// choice — pre-delay and the early reflections live at 2–100 ms while the tail
// can run to 42 s (decay 30 s × Hall's 1.4 decayScale), and no linear axis
// shows both. Every mark on screen is derived from a live engine parameter:
//
//   predelay   → the dead zone before anything arrives, and the onset marker
//   decay      → the envelope's slope and where the T60 marker lands
//   size       → line lengths: the density comb's spacing and the onset time
//   damping    → the HF curve, which collapses ahead of the broadband envelope
//   er_level   → early-reflection bar heights (Plate: the bloom cascade)
//   er_late    → the late tail's amplitude
//   mod_*      → the ripple riding on the envelope's top edge
//   hicut/locut→ (drawn on the strip's own filter curve, not here)
//   mix        → wet opacity, and the height of the DRY column at the head
//   smoothness → RING TAME feeds damping, and selects the legacy backend on
//                Generic — which is a different delay set, so the comb changes
//   style      → the topology itself; see below
//
// ── Per-style visual identity ────────────────────────────────────────────────
// Same geometry language for all four, different behaviour — because the engine
// genuinely runs four different backends (reverbVizMath.js documents them):
//
//   GENERIC  8 lines, mid-length, no input diffusion. The reference look:
//            a moderate comb, 12 ER arrivals out to 76 ms.
//   ROOM     8 SHORT lines (5.8–16.6 ms) — the comb piles up almost
//            immediately; 8 tight ER arrivals; the tail is visibly shorter at
//            the same DECAY (decayScale 0.75) and the ER bars stand taller
//            relative to it (erLateBalance 1.53).
//   PLATE    No ER bars at all — it has no ER bus. Instead the 4-stage input
//            diffuser cascade draws as nested bloom brackets at the head, and
//            the comb is the 4 cross-coupled tank delays: sparse and wide.
//   HALL     16 lines, the longest set — the densest, latest comb; ER bars are
//            pushed down (erLateBalance 0.375) and the tail runs 1.4× longer
//            than the knob says.
//
// Style is never signalled by hue. One accent carries wet energy, neutrals
// carry structure, and the differences are entirely geometric.
//
// Thread/lifecycle note:
//   ReverbPanel returns null when reverbStore.target is null, which unmounts
//   this component. React runs the effect cleanup: cancelled = true +
//   cancelAnimationFrame — zero background work after close.

import { useEffect, useRef } from 'react'
import {
  clamp,
  clamp01,
  styleIndexOf,
  styleDsp,
  backendTag,
  modalDelaysMs,
  lateOnsetMs,
  effectiveRt60Sec,
  decayAmplitude,
  hfLossPerPass,
  meanDampingPassMs,
  hfAmplitude,
  hfRt60Ms,
  erArrivals,
  erLateBalance,
  plateBloomStages,
  recirculationTimesMs,
  modLfoHz,
  modIntensity,
  timeToNorm,
  normToTime,
  ampToNorm,
  formatSeconds,
  formatTimeMs,
  AXIS_T_MAX_MS,
  STYLE_PLATE,
} from './reverbVizMath.js'
import {
  withAlpha,
  readMixerCanvasTheme,
  syncCanvasSize,
  MONO,
  MONO_SM,
} from './mixerCanvasTheme.js'

// Decade grid on the log time axis, plus the half-decades that keep the
// early-reflection region from reading as one undifferentiated block.
const GRID_TIMES_MS = [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000]
const LABELLED_TIMES_MS = new Set([1, 10, 100, 1000, 10000])
const DB_RULES = [-12, -24, -36, -48]

const ER_BAR_W = 3

export default function ReverbDecayFieldVisualizer({ params, styleIndex = 0 }) {
  const canvasRef = useRef(null)
  const paramsRef = useRef(params)
  const styleRef = useRef(styleIndex)
  const rafRef = useRef(0)

  // Keep the latest values readable every frame without restarting the loop.
  paramsRef.current = params
  styleRef.current = styleIndex

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return

    let cancelled = false
    const t0 = performance.now()

    function draw(now) {
      if (cancelled) return

      const p = paramsRef.current
      const { cssW, cssH, dpr } = syncCanvasSize(canvas, 700, 250)
      const ctx = canvas.getContext('2d', { alpha: false })
      if (!ctx) { rafRef.current = requestAnimationFrame(draw); return }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)

      const th = readMixerCanvasTheme(canvas)
      const elapsed = now - t0

      // ── Params ────────────────────────────────────────────────────────────
      const styleIdx = styleIndexOf(styleRef.current)
      const dsp = styleDsp(styleIdx)
      const isPlate = styleIdx === STYLE_PLATE

      const decay = clamp(p.decay ?? 2, 0.1, 30)
      const size = clamp(p.size ?? 50, 0, 100)
      const damping = clamp(p.damping ?? 50, 0, 100)
      const smoothness = clamp(p.smoothness ?? 0, 0, 100)
      const predelay = clamp(p.predelay ?? 10, 0, 100)
      const erLevel = clamp(p.er_level ?? 50, 0, 100)
      const erLate = clamp(p.er_late ?? 50, 0, 100)
      const modRate = clamp(p.mod_rate ?? 30, 0, 100)
      const modDepth = clamp(p.mod_depth ?? 20, 0, 100)
      const mix = clamp(p.mix ?? 30, 0, 100)

      // ── Derived DSP quantities ────────────────────────────────────────────
      const rt60 = effectiveRt60Sec(decay, styleIdx)
      const onsetMs = lateOnsetMs(styleIdx, size, predelay, smoothness)
      const delaysMs = modalDelaysMs(styleIdx, size, smoothness)
      const hfLoss = hfLossPerPass(damping, styleIdx, smoothness)
      const passMs = meanDampingPassMs(styleIdx, size, smoothness)
      const tailEndMs = onsetMs + rt60 * 1000
      const hfEndMs = onsetMs + hfRt60Ms(rt60, passMs, hfLoss)

      const lateNorm = clamp01(erLate / 100)
      const mixNorm = clamp01(mix / 100)
      // Wet opacity floor keeps the geometry legible at mix 0 — the parameters
      // are still doing something, they are just not audible yet.
      const wetAlpha = 0.16 + mixNorm * 0.84
      const modAmt = modIntensity(modRate, modDepth, styleIdx)
      const modHz = modLfoHz(modRate, styleIdx)

      // ── Layout ────────────────────────────────────────────────────────────
      const padL = 34
      const padR = cssW - 12
      const plotW = Math.max(20, padR - padL)
      const topY = 26
      const botY = cssH - 22
      const plotH = Math.max(20, botY - topY)

      const toX = (ms) => padL + timeToNorm(ms) * plotW
      const toY = (amp) => topY + ampToNorm(amp) * plotH
      // Inverse of toX — the envelope samplers below walk pixels and need the
      // time each one represents.
      const toMs = (x) => normToTime(clamp01((x - padL) / plotW))

      // ── Background ────────────────────────────────────────────────────────
      ctx.fillStyle = th.well
      ctx.fillRect(0, 0, cssW, cssH)

      // dB rules — flat hairlines, no gradient.
      ctx.strokeStyle = withAlpha(th.border, 0.9)
      ctx.lineWidth = 1
      ctx.beginPath()
      for (const db of DB_RULES) {
        const y = Math.round(topY + clamp01(-db / 60) * plotH) + 0.5
        ctx.moveTo(padL, y)
        ctx.lineTo(padR, y)
      }
      ctx.stroke()

      // Time grid.
      ctx.strokeStyle = withAlpha(th.border, 0.75)
      ctx.beginPath()
      for (const ms of GRID_TIMES_MS) {
        const gx = Math.round(toX(ms)) + 0.5
        if (gx <= padL || gx > padR) continue
        ctx.moveTo(gx, topY)
        ctx.lineTo(gx, botY)
      }
      ctx.stroke()

      // Floor + left rule frame the plot without boxing it in.
      ctx.strokeStyle = withAlpha(th.borderStrong, 1)
      ctx.beginPath()
      ctx.moveTo(padL, Math.round(botY) + 0.5)
      ctx.lineTo(padR, Math.round(botY) + 0.5)
      ctx.stroke()

      ctx.font = MONO_SM
      ctx.textBaseline = 'top'
      ctx.textAlign = 'center'
      ctx.fillStyle = withAlpha(th.textSubtle, 0.85)
      for (const ms of GRID_TIMES_MS) {
        if (!LABELLED_TIMES_MS.has(ms)) continue
        const gx = toX(ms)
        if (gx <= padL + 4 || gx > padR - 8) continue
        ctx.fillText(ms >= 1000 ? `${ms / 1000}s` : `${ms}ms`, gx, botY + 4)
      }

      // dB scale down the left gutter.
      ctx.textAlign = 'right'
      ctx.textBaseline = 'middle'
      ctx.fillStyle = withAlpha(th.textSubtle, 0.7)
      for (const db of DB_RULES) {
        ctx.fillText(`${db}`, padL - 5, topY + clamp01(-db / 60) * plotH)
      }

      // ── Pre-delay dead zone ───────────────────────────────────────────────
      // Nothing wet exists left of the onset. Shading it makes pre-delay a
      // visible span rather than an abstract number.
      if (onsetMs > 1) {
        const x1 = toX(onsetMs)
        ctx.fillStyle = withAlpha(th.borderStrong, 0.28)
        ctx.fillRect(padL, topY, Math.max(0, x1 - padL), plotH)

        // Onset rule.
        const ox = Math.round(x1) + 0.5
        ctx.strokeStyle = withAlpha(th.textMuted, 0.55)
        ctx.lineWidth = 1
        ctx.beginPath()
        ctx.moveTo(ox, topY)
        ctx.lineTo(ox, botY)
        ctx.stroke()

        // Pre-delay bracket, only when the knob is actually doing something.
        if (predelay > 0.5) {
          const px = toX(Math.max(1, predelay))
          const by = topY + 9.5
          ctx.strokeStyle = withAlpha(th.textMuted, 0.5)
          ctx.beginPath()
          ctx.moveTo(padL, by - 3)
          ctx.lineTo(padL, by)
          ctx.lineTo(px, by)
          ctx.lineTo(px, by - 3)
          ctx.stroke()

          ctx.font = MONO_SM
          ctx.textAlign = 'left'
          ctx.textBaseline = 'top'
          ctx.fillStyle = withAlpha(th.textMuted, 0.8)
          ctx.fillText(`PRE ${Math.round(predelay)}ms`, padL + 3, by + 2)
        }
      }

      // ── Density comb ──────────────────────────────────────────────────────
      // One hairline per recirculation arrival: every multiple of every delay
      // line that lands in the tail. This is the topology, drawn literally —
      // Hall's 16 long lines smear densely and late, Room's 8 short ones pile
      // up at the head, the Plate's 4 tank delays stay sparse and wide.
      {
        const combTimes = recirculationTimesMs(delaysMs, rt60 * 1000)
        ctx.strokeStyle = withAlpha(th.accent, 0.16 * wetAlpha * lateNorm)
        ctx.lineWidth = 1
        ctx.beginPath()
        for (const t of combTimes) {
          const at = onsetMs + t
          if (at > AXIS_T_MAX_MS) continue
          const amp = lateNorm * decayAmplitude(t, rt60)
          if (amp < 0.001) continue
          const gx = Math.round(toX(at)) + 0.5
          if (gx <= padL || gx > padR) continue
          ctx.moveTo(gx, toY(amp))
          ctx.lineTo(gx, botY)
        }
        ctx.stroke()
      }

      // ── Late tail envelope ────────────────────────────────────────────────
      // Broadband decay, with the modulation ripple riding its top edge.
      const envPts = []
      {
        const x0 = toX(onsetMs)
        const x1 = toX(Math.min(tailEndMs, AXIS_T_MAX_MS))
        const phase = (2 * Math.PI * modHz * elapsed) / 1000
        const ripplepx = modAmt * 7

        for (let x = x0; x <= x1; x += 2) {
          const tAbs = Math.max(onsetMs, toMs(x))
          const amp = lateNorm * decayAmplitude(tAbs - onsetMs, rt60)
          // The ripple is a displacement of the envelope edge, not a colour
          // change — it reads as the tail breathing.
          const wobble = ripplepx * Math.sin(phase + (x - x0) * 0.06)
          envPts.push([x, toY(amp) + wobble])
        }
        if (envPts.length >= 2) {
          ctx.beginPath()
          ctx.moveTo(envPts[0][0], botY)
          for (const [x, y] of envPts) ctx.lineTo(x, y)
          ctx.lineTo(envPts[envPts.length - 1][0], botY)
          ctx.closePath()
          ctx.fillStyle = withAlpha(th.accent, 0.17 * wetAlpha)
          ctx.fill()

          ctx.beginPath()
          ctx.moveTo(envPts[0][0], envPts[0][1])
          for (const [x, y] of envPts) ctx.lineTo(x, y)
          ctx.strokeStyle = withAlpha(th.accent, 0.9 * wetAlpha)
          ctx.lineWidth = 1.75
          ctx.stroke()
        }
      }

      // ── HF (damped) envelope ──────────────────────────────────────────────
      // The top octave's decay. It coincides with the broadband curve when
      // damping produces g = 0 and collapses ahead of it as damping rises —
      // the tail going dull before it goes quiet, which is what damping does.
      if (hfLoss < 0.999) {
        const x0 = toX(onsetMs)
        const x1 = toX(Math.min(hfEndMs, AXIS_T_MAX_MS))
        ctx.beginPath()
        let started = false
        for (let x = x0; x <= x1; x += 2) {
          const tAbs = Math.max(onsetMs, toMs(x))
          const amp = lateNorm * hfAmplitude(tAbs - onsetMs, rt60, passMs, hfLoss)
          const y = toY(amp)
          if (!started) { ctx.moveTo(x, y); started = true } else ctx.lineTo(x, y)
        }
        if (started) {
          ctx.strokeStyle = withAlpha(th.textMuted, 0.62)
          ctx.lineWidth = 1
          ctx.setLineDash([3, 3])
          ctx.stroke()
          ctx.setLineDash([])

          const lx = clamp(toX(Math.min(hfEndMs, AXIS_T_MAX_MS)), padL + 2, padR - 26)
          ctx.font = MONO_SM
          ctx.textAlign = 'left'
          ctx.textBaseline = 'bottom'
          ctx.fillStyle = withAlpha(th.textMuted, 0.75)
          ctx.fillText('HF', lx + 3, botY - 2)
        }
      }

      // ── Early reflections ─────────────────────────────────────────────────
      if (isPlate) {
        // The Plate has no ER bus. What it has is a 4-stage input-diffuser
        // cascade blended against the raw pre-delay signal — er_level IS that
        // blend ("BLOOM"). Drawing ER bars here would be a lie about the
        // algorithm, so the cascade draws as nested brackets instead: each
        // stage spans its own allpass delay, and the fill tracks the blend.
        const stages = plateBloomStages(erLevel, predelay)
        const blend = clamp01(erLevel / 100)
        stages.forEach((st, i) => {
          const xa = toX(Math.max(1, st.atMs - st.spanMs))
          const xb = toX(Math.max(1, st.atMs))
          const y = topY + 18 + i * 9
          const w = Math.max(1, xb - xa)
          ctx.fillStyle = withAlpha(th.accent, (0.10 + blend * 0.5) * wetAlpha)
          ctx.fillRect(xa, y, w, 5)
          ctx.strokeStyle = withAlpha(th.accent, (0.25 + blend * 0.55) * wetAlpha)
          ctx.lineWidth = 1
          ctx.strokeRect(Math.round(xa) + 0.5, Math.round(y) + 0.5, Math.round(w), 5)
        })

        ctx.font = MONO_SM
        ctx.textAlign = 'left'
        ctx.textBaseline = 'top'
        ctx.fillStyle = withAlpha(th.textMuted, 0.5 + blend * 0.45)
        ctx.fillText(
          `BLOOM ${Math.round(erLevel)}% · 4-STAGE DIFFUSION`,
          toX(Math.max(1, predelay)) + 4,
          topY + 18 + stages.length * 9 + 2,
        )
      } else {
        // One hard bar per engine ER tap, at its real arrival time, scaled by
        // er_level and the style's erGainScale.
        const taps = erArrivals(styleIdx, erLevel, predelay)
        for (const tap of taps) {
          const x = toX(tap.ms)
          if (x <= padL || x > padR) continue
          const y = toY(Math.max(tap.g, 1e-4))
          const h = Math.max(1, botY - y)
          ctx.fillStyle = withAlpha(th.accent, clamp(0.35 + tap.g * 0.6, 0, 1) * wetAlpha)
          ctx.fillRect(Math.round(x - ER_BAR_W / 2), Math.round(y), ER_BAR_W, h)
          // Square tip cap — the same hard-edged tap language the Delay field
          // uses, so the two stages read as one family.
          ctx.fillRect(Math.round(x - ER_BAR_W / 2) - 2, Math.round(y), ER_BAR_W + 4, 2)
        }
      }

      // ── T60 marker ────────────────────────────────────────────────────────
      {
        const tx = toX(Math.min(tailEndMs, AXIS_T_MAX_MS))
        if (tx > padL && tx <= padR) {
          const mx = Math.round(tx) + 0.5
          ctx.strokeStyle = withAlpha(th.accent, 0.5)
          ctx.lineWidth = 1
          ctx.setLineDash([2, 3])
          ctx.beginPath()
          ctx.moveTo(mx, topY)
          ctx.lineTo(mx, botY)
          ctx.stroke()
          ctx.setLineDash([])

          ctx.font = MONO
          ctx.textBaseline = 'top'
          // Flip the label inboard near the right edge so a long tail never
          // pushes its own readout off the canvas.
          const flip = mx > padR - 64
          ctx.textAlign = flip ? 'right' : 'left'
          ctx.fillStyle = withAlpha(th.accent, 0.95)
          ctx.fillText(`T60 ${formatSeconds(rt60)}`, mx + (flip ? -4 : 4), topY + 2)
        }
      }

      // ── Dry column at the head ────────────────────────────────────────────
      // Height tracks the dry proportion, so pushing MIX up visibly trades the
      // grey column for accent-coloured wet energy — same idiom as the Delay
      // panel's echo field.
      {
        const dryH = plotH * (1 - mixNorm) * 0.9
        ctx.fillStyle = withAlpha(th.textMuted, 0.5)
        ctx.fillRect(padL - 1, botY - dryH, 2, dryH)
        ctx.font = MONO_SM
        ctx.textAlign = 'center'
        ctx.textBaseline = 'top'
        ctx.fillStyle = withAlpha(th.textSubtle, 0.85)
        ctx.fillText('DRY', padL, botY + 4)
      }

      // ── Header line ───────────────────────────────────────────────────────
      // What is actually running, and the two derived numbers the knobs cannot
      // show on their own.
      {
        const stages = dsp.diffuserDelays.length
        ctx.font = MONO
        ctx.textAlign = 'left'
        ctx.textBaseline = 'top'
        ctx.fillStyle = withAlpha(th.textMuted, 1)
        ctx.fillText(
          `${dsp.label} · ${backendTag(styleIdx, smoothness)}`,
          padL, 7,
        )

        ctx.textAlign = 'right'
        ctx.font = MONO_SM
        ctx.fillStyle = withAlpha(th.textSubtle, 1)
        const bits = [
          `${delaysMs.length} ${isPlate ? 'TANK DELAYS' : 'LINES'}`,
          `${stages} DIFF`,
          isPlate ? `TANK ${Math.round(erLate)}%` : `ER×${erLateBalance(styleIdx).toFixed(2)}`,
          `ONSET ${formatTimeMs(onsetMs)}`,
        ]
        ctx.fillText(bits.join('  ·  '), padR, 8)
      }

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
      className="reverb-stage-canvas"
      style={{ display: 'block', width: '100%', height: '100%' }}
    />
  )
}
