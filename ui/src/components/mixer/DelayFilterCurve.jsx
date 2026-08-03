// ─── DelayFilterCurve.jsx ─────────────────────────────────────────────────────
// Interactive feedback-path filter display — replaces the old LO CUT / HI CUT
// knob pair.
//
// The accent curve is the real response of the engine's feedback filter
// (XlethDelayEffect.h: a first-order low-pass at filter_hi in series with a
// first-order high-pass at filter_lo). Both corner handles are dragged directly
// on the canvas; the curve redraws from the same maths the audio uses.
//
// Interaction contract:
//   pointerdown  grabs the nearer handle and records the grab offset — the
//                value never jumps to the click point
//   pointermove  previews locally (onPreview) so the curve tracks the pointer
//   pointerup    commits the final value (onCommit) — pointer capture means
//                this still fires if the pointer leaves the window
//
// All readouts are painted on the canvas; there are no DOM overlays.

import { useEffect, useRef, useState, useCallback } from 'react'
import { useThemeEpoch } from '../../theming/useThemeEpoch.js'
import {
  clamp,
  filterMagnitudeDb,
  freqToNorm,
  normToFreq,
  dbToNorm,
  pickFilterHandle,
  formatHz,
  FILTER_F_MIN,
  FILTER_F_MAX,
} from './delayVizMath.js'
import {
  withAlpha,
  readMixerCanvasTheme,
  syncCanvasSize,
  MONO,
  MONO_SM,
} from './mixerCanvasTheme.js'

// Engine ranges — must match XlethDelayEffect.h's NormalisableRange bounds.
const LO_MIN = 20
const LO_MAX = 2000
const HI_MIN = 1000
const HI_MAX = 20000

const DB_TOP = 3
const DB_BOTTOM = -33

const GRID_FREQS = [50, 100, 200, 500, 1000, 2000, 5000, 10000]
const LABELLED_FREQS = new Set([100, 1000, 10000])

export default function DelayFilterCurve({ loHz, hiHz, onPreview, onCommit }) {
  const canvasRef = useRef(null)
  const dragRef = useRef(null) // { handle, offsetNorm }
  const liveRef = useRef({ lo: loHz, hi: hiHz })
  const [active, setActive] = useState(null)  // handle being dragged
  const [hover, setHover] = useState(null)    // handle under the pointer
  const themeEpoch = useThemeEpoch()

  liveRef.current = { lo: loHz, hi: hiHz }

  // ── Paint ──────────────────────────────────────────────────────────────────
  const paint = useCallback(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const { cssW, cssH, dpr } = syncCanvasSize(canvas, 260, 68)
    const ctx = canvas.getContext('2d', { alpha: false })
    if (!ctx) return
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)

    const th = readMixerCanvasTheme(canvas)
    const lo = clamp(loHz, LO_MIN, LO_MAX)
    const hi = clamp(hiHz, HI_MIN, HI_MAX)

    const padL = 6
    const padR = cssW - 6
    const plotW = Math.max(10, padR - padL)
    const topY = 11
    const botY = cssH - 11
    const plotH = Math.max(10, botY - topY)

    const xOf = (f) => padL + freqToNorm(f, FILTER_F_MIN, FILTER_F_MAX) * plotW
    const yOf = (db) => topY + dbToNorm(db, DB_TOP, DB_BOTTOM) * plotH

    ctx.fillStyle = th.well
    ctx.fillRect(0, 0, cssW, cssH)

    // Frequency grid.
    ctx.strokeStyle = withAlpha(th.border, 0.9)
    ctx.lineWidth = 1
    ctx.beginPath()
    for (const f of GRID_FREQS) {
      const gx = Math.round(xOf(f)) + 0.5
      ctx.moveTo(gx, topY)
      ctx.lineTo(gx, botY)
    }
    ctx.stroke()

    // 0 dB rule.
    const zeroY = Math.round(yOf(0)) + 0.5
    ctx.strokeStyle = withAlpha(th.borderStrong, 1)
    ctx.beginPath()
    ctx.moveTo(padL, zeroY)
    ctx.lineTo(padR, zeroY)
    ctx.stroke()

    ctx.font = MONO_SM
    ctx.textBaseline = 'top'
    ctx.textAlign = 'center'
    ctx.fillStyle = withAlpha(th.textSubtle, 0.85)
    for (const f of GRID_FREQS) {
      if (!LABELLED_FREQS.has(f)) continue
      ctx.fillText(f >= 1000 ? `${f / 1000}k` : String(f), xOf(f), botY + 3)
    }

    // Response curve.
    const pts = []
    for (let x = 0; x <= plotW; x += 2) {
      const f = normToFreq(x / plotW, FILTER_F_MIN, FILTER_F_MAX)
      pts.push([padL + x, yOf(filterMagnitudeDb(f, lo, hi))])
    }

    ctx.beginPath()
    ctx.moveTo(pts[0][0], botY)
    for (const [x, y] of pts) ctx.lineTo(x, y)
    ctx.lineTo(pts[pts.length - 1][0], botY)
    ctx.closePath()
    ctx.fillStyle = withAlpha(th.accent, 0.12)
    ctx.fill()

    ctx.beginPath()
    ctx.moveTo(pts[0][0], pts[0][1])
    for (const [x, y] of pts) ctx.lineTo(x, y)
    ctx.strokeStyle = th.accent
    ctx.lineWidth = 1.75
    ctx.stroke()

    // Handles.
    const drawHandle = (f, isActive) => {
      const hx = Math.round(xOf(f)) + 0.5
      const hy = yOf(filterMagnitudeDb(f, lo, hi))
      ctx.strokeStyle = withAlpha(th.accent, isActive ? 0.85 : 0.4)
      ctx.lineWidth = isActive ? 2 : 1
      ctx.beginPath()
      ctx.moveTo(hx, topY)
      ctx.lineTo(hx, botY)
      ctx.stroke()

      const s = isActive ? 9 : 7
      ctx.fillStyle = isActive ? th.accent : withAlpha(th.accent, 0.75)
      ctx.fillRect(Math.round(hx - s / 2), Math.round(hy - s / 2), s, s)
      ctx.strokeStyle = th.well
      ctx.lineWidth = 1
      ctx.strokeRect(Math.round(hx - s / 2) + 0.5, Math.round(hy - s / 2) + 0.5, s - 1, s - 1)
      return hx
    }

    const activeHandle = active || hover
    drawHandle(lo, activeHandle === 'lo')
    drawHandle(hi, activeHandle === 'hi')

    // Readouts are pinned to the plot corners rather than tracking their
    // handles: the handles converge in the middle of the band, and a
    // handle-following label collides with its partner there.
    ctx.font = MONO
    ctx.textBaseline = 'top'
    ctx.textAlign = 'left'
    ctx.fillStyle = activeHandle === 'lo' ? th.accent : withAlpha(th.textMuted, 1)
    ctx.fillText(`LO ${formatHz(lo)}`, padL + 2, 3)
    ctx.textAlign = 'right'
    ctx.fillStyle = activeHandle === 'hi' ? th.accent : withAlpha(th.textMuted, 1)
    ctx.fillText(`HI ${formatHz(hi)}`, padR - 2, 3)
  }, [loHz, hiHz, active, hover, themeEpoch])

  useEffect(() => { paint() }, [paint])

  // Repaint when the panel resizes — the canvas is width:100 % of a flex row.
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => paint())
    ro.observe(canvas)
    return () => ro.disconnect()
  }, [paint])

  // ── Drag ───────────────────────────────────────────────────────────────────
  const normFromEvent = useCallback((e) => {
    const canvas = canvasRef.current
    if (!canvas) return 0
    const rect = canvas.getBoundingClientRect()
    const padL = 6
    const plotW = Math.max(10, rect.width - 12)
    return clamp((e.clientX - rect.left - padL) / plotW, 0, 1)
  }, [])

  const valueFor = useCallback((handle, norm) => {
    const freq = normToFreq(norm, FILTER_F_MIN, FILTER_F_MAX)
    return handle === 'lo'
      ? clamp(freq, LO_MIN, LO_MAX)
      : clamp(freq, HI_MIN, HI_MAX)
  }, [])

  const handlePointerDown = useCallback((e) => {
    const norm = normFromEvent(e)
    const { lo, hi } = liveRef.current
    // Always grab the nearer handle, but drag relatively from the grab point so
    // an imprecise click never yanks the value across the spectrum.
    const handle = pickFilterHandle(norm, lo, hi, 1)
    if (!handle) return
    e.preventDefault()
    try { e.currentTarget.setPointerCapture(e.pointerId) } catch { /* older engines */ }
    const handleNorm = freqToNorm(handle === 'lo' ? lo : hi, FILTER_F_MIN, FILTER_F_MAX)
    dragRef.current = { handle, offsetNorm: handleNorm - norm }
    setActive(handle)
  }, [normFromEvent])

  const handlePointerMove = useCallback((e) => {
    const drag = dragRef.current
    const norm = normFromEvent(e)
    if (!drag) {
      const { lo, hi } = liveRef.current
      setHover(pickFilterHandle(norm, lo, hi, 0.05))
      return
    }
    const next = valueFor(drag.handle, clamp(norm + drag.offsetNorm, 0, 1))
    liveRef.current = drag.handle === 'lo'
      ? { ...liveRef.current, lo: next }
      : { ...liveRef.current, hi: next }
    onPreview?.(drag.handle === 'lo' ? 'filter_lo' : 'filter_hi', next)
  }, [normFromEvent, valueFor, onPreview])

  const handlePointerUp = useCallback(() => {
    const drag = dragRef.current
    if (!drag) return
    dragRef.current = null
    setActive(null)
    const { lo, hi } = liveRef.current
    onCommit?.(drag.handle === 'lo' ? 'filter_lo' : 'filter_hi', drag.handle === 'lo' ? lo : hi)
  }, [onCommit])

  return (
    <canvas
      ref={canvasRef}
      className="delay-filter-canvas"
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerUp}
      onPointerLeave={() => { if (!dragRef.current) setHover(null) }}
      title="Drag the corner handles to set the feedback filter band"
      style={{ display: 'block', width: '100%', height: '100%', cursor: 'ew-resize', touchAction: 'none' }}
    />
  )
}
