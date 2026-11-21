import React, { useCallback, useEffect, useRef } from 'react'
import { formatValue } from '../../ui-kit'
import { useDprEpoch } from '../../ui-kit/dpr'
import { useThemeEpoch } from '../../theming/useThemeEpoch.js'
import { uiCanvasFont } from '../../styles/typography.js'
import {
  buildDistortionCurvePoints, normalizeDistortionParams,
} from '../../plugin-ui/runtime/visualizers/distortionPainter.js'

// The Distortion's hero: the active mode's transfer function, output against
// input, drawn from the same pure math the engine's per-sample switch is ported
// from (distortionPainter.js), so the picture matches the sound. There is no
// engine feed to draw, so it is redrawn only when a parameter (or the theme, or the
// pixel ratio) changes, never per frame. Downsample is a sample-and-hold in time
// and has no place on a static y = f(x) plot, so it does not move this curve.
//
// Colours come from the canvas's own computed style at draw time; tokenValue() is
// never called here.

const PAD = { l: 26, r: 10, t: 10, b: 20 }
const TICKS = [-1, -0.5, 0, 0.5, 1]

function readColors(el) {
  const cs = typeof getComputedStyle === 'function' ? getComputedStyle(el) : null
  const get = (name, fb) => cs?.getPropertyValue(name)?.trim() || fb
  return {
    ground: get('--ui-g0', '#141414'),
    grid: get('--ui-g4', '#3A3A3A'),
    zero: get('--ui-boundary', '#747474'),
    text: get('--ui-ink-3', '#929292'),
    unity: get('--ui-ink-3', '#929292'),
    value: get('--ui-value', '#33CED6'),
  }
}

const tick = (v) => formatValue(v, 'dB', { unitless: true, decimals: v === 0 || Math.abs(v) === 1 ? 0 : 1, signed: v > 0 })

export default function DistortionCurveCanvas({ mode, drive, symmetry, bits }) {
  const canvasRef = useRef(null)
  const themeEpoch = useThemeEpoch()
  const dprEpoch = useDprEpoch()

  const paint = useCallback(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const cssW = canvas.clientWidth
    const cssH = canvas.clientHeight
    if (cssW < 40 || cssH < 40) return
    const dpr = Math.max(1, window.devicePixelRatio || 1)
    const tw = Math.round(cssW * dpr)
    const th = Math.round(cssH * dpr)
    if (canvas.width !== tw || canvas.height !== th) { canvas.width = tw; canvas.height = th }
    const ctx = canvas.getContext('2d', { alpha: false })
    if (!ctx) return
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    const c = readColors(canvas)

    const plotW = Math.max(10, cssW - PAD.l - PAD.r)
    const plotH = Math.max(10, cssH - PAD.t - PAD.b)
    const xOf = (a) => PAD.l + ((Math.max(-1, Math.min(1, a)) + 1) / 2) * plotW
    const yOf = (a) => PAD.t + (1 - (Math.max(-1, Math.min(1, a)) + 1) / 2) * plotH

    ctx.fillStyle = c.ground
    ctx.fillRect(0, 0, cssW, cssH)

    // Grid at -1, -0.5, 0, 0.5, 1 on both axes; the zero axes stronger.
    ctx.lineWidth = 1
    ctx.font = uiCanvasFont('10px')
    ctx.fillStyle = c.text
    for (const a of TICKS) {
      const gx = Math.round(xOf(a)) + 0.5
      const gy = Math.round(yOf(a)) + 0.5
      ctx.strokeStyle = a === 0 ? c.zero : c.grid
      ctx.beginPath()
      ctx.moveTo(gx, PAD.t); ctx.lineTo(gx, PAD.t + plotH)
      ctx.moveTo(PAD.l, gy); ctx.lineTo(PAD.l + plotW, gy)
      ctx.stroke()
    }
    ctx.textBaseline = 'top'
    ctx.textAlign = 'center'
    for (const a of [-1, 0, 1]) ctx.fillText(tick(a), xOf(a), PAD.t + plotH + 4)
    ctx.textBaseline = 'middle'
    ctx.textAlign = 'right'
    for (const a of [-1, 0, 1]) ctx.fillText(tick(a), PAD.l - 4, yOf(a))
    ctx.textAlign = 'left'
    ctx.textBaseline = 'top'
    ctx.fillText('Out', PAD.l + 4, PAD.t + 3)
    ctx.textAlign = 'right'
    ctx.textBaseline = 'bottom'
    ctx.fillText('In', PAD.l + plotW - 4, PAD.t + plotH - 3)

    // Unity (out = in), dashed.
    ctx.save()
    ctx.setLineDash([2, 4])
    ctx.strokeStyle = c.unity
    ctx.globalAlpha = 0.6
    ctx.beginPath()
    ctx.moveTo(xOf(-1), yOf(-1)); ctx.lineTo(xOf(1), yOf(1))
    ctx.stroke()
    ctx.restore()

    // The curve: dense enough that Crush's stairs and Hard clip's corner stay sharp.
    const points = buildDistortionCurvePoints(
      normalizeDistortionParams({ mode, drive, symmetry, bits }),
      plotW,
    )
    ctx.beginPath()
    points.forEach((p, i) => {
      if (i === 0) ctx.moveTo(xOf(p.xin), yOf(p.y)); else ctx.lineTo(xOf(p.xin), yOf(p.y))
    })
    ctx.lineJoin = 'round'
    ctx.lineCap = 'round'
    ctx.strokeStyle = c.value
    ctx.lineWidth = 2
    ctx.stroke()
  }, [mode, drive, symmetry, bits])

  useEffect(() => { paint() }, [paint, themeEpoch, dprEpoch])
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || typeof ResizeObserver === 'undefined') return undefined
    const ro = new ResizeObserver(() => paint())
    ro.observe(canvas)
    return () => ro.disconnect()
  }, [paint])

  return <canvas ref={canvasRef} role="img" aria-label="Distortion transfer curve, output against input" />
}
