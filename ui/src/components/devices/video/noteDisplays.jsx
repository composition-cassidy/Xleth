import React, { useCallback, useEffect, useRef } from 'react'
import { formatValue } from '../../../ui-kit'
import { useDprEpoch } from '../../../ui-kit/dpr'
import { useThemeEpoch } from '../../../theming/useThemeEpoch.js'
import { uiCanvasFont } from '../../../styles/typography.js'
import { bounceDisplacement, bounceTotalMs, noteFadeGain } from './videoMotionMath.js'

// The per-note devices' heroes. Each draws the engine's own maths
// (videoMotionMath.js, ported from AnimationManager.cpp and NoteFade.h) from the
// device's parameters: there is no engine feed for these, so they redraw on a
// parameter, theme or pixel-ratio change only, never per frame. Colours come from
// the canvas's computed style at draw time; tokenValue() is never called here.

const PAD = { l: 34, r: 8, t: 8, b: 18 }

function readColors(el) {
  const cs = typeof getComputedStyle === 'function' ? getComputedStyle(el) : null
  const get = (name, fb) => cs?.getPropertyValue(name)?.trim() || fb
  return {
    ground: get('--ui-g0', '#141414'),
    grid: get('--ui-g4', '#3A3A3A'),
    zero: get('--ui-boundary', '#747474'),
    text: get('--ui-ink-3', '#929292'),
    value: get('--ui-value', '#33CED6'),
  }
}

function useCanvasPaint(draw, deps) {
  const canvasRef = useRef(null)
  const themeEpoch = useThemeEpoch()
  const dprEpoch = useDprEpoch()
  // eslint-disable-next-line react-hooks/exhaustive-deps
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
    ctx.fillStyle = c.ground
    ctx.fillRect(0, 0, cssW, cssH)
    ctx.font = uiCanvasFont('10px')
    draw(ctx, cssW, cssH, c)
  }, deps)
  useEffect(() => { paint() }, [paint, themeEpoch, dprEpoch])
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || typeof ResizeObserver === 'undefined') return undefined
    const ro = new ResizeObserver(() => paint())
    ro.observe(canvas)
    return () => ro.disconnect()
  }, [paint])
  return canvasRef
}

function plotFrame(ctx, w, h, c) {
  const plotW = Math.max(10, w - PAD.l - PAD.r)
  const plotH = Math.max(10, h - PAD.t - PAD.b)
  return { plotW, plotH, x0: PAD.l, y0: PAD.t }
}

/**
 * Bounce: the cell's displacement along the bounce direction against time,
 * one line per repeat (each repeat decays by half), from the note at 0 ms to
 * the end of the last repeat. Distance is a share of the cell. (A slide-note
 * bounce is shaped by the note's own slide curve, so it has no display.)
 */
export function BounceCurveCanvas({ bounce }) {
  const totalMs = bounceTotalMs(bounce)
  const distance = bounce?.distance ?? 0.15
  const ref = useCanvasPaint((ctx, w, h, c) => {
    const { plotW, plotH, x0, y0 } = plotFrame(ctx, w, h, c)
    // y spans -0.25 .. 1.25 of the distance so an ease-out-back overshoot is visible.
    const lo = -0.25
    const hi = 1.25
    const yOf = (frac) => y0 + (1 - (frac - lo) / (hi - lo)) * plotH
    const xOf = (ms) => x0 + (ms / Math.max(1, totalMs)) * plotW

    ctx.lineWidth = 1
    for (const g of [0, 0.5, 1]) {
      ctx.strokeStyle = g === 0 ? c.zero : c.grid
      const gy = Math.round(yOf(g)) + 0.5
      ctx.beginPath(); ctx.moveTo(x0, gy); ctx.lineTo(x0 + plotW, gy); ctx.stroke()
    }
    ctx.fillStyle = c.text
    ctx.textAlign = 'right'
    ctx.textBaseline = 'middle'
    ctx.fillText(formatValue(distance * 100, '%'), x0 - 4, yOf(1))
    ctx.fillText('0', x0 - 4, yOf(0))
    ctx.textAlign = 'left'
    ctx.textBaseline = 'top'
    ctx.fillText('0', x0, y0 + plotH + 4)
    ctx.textAlign = 'right'
    ctx.fillText(formatValue(totalMs, 'ms'), x0 + plotW, y0 + plotH + 4)

    ctx.strokeStyle = c.value
    ctx.lineWidth = 2
    ctx.lineJoin = 'round'
    ctx.beginPath()
    const steps = Math.max(48, Math.round(plotW))
    for (let i = 0; i <= steps; i += 1) {
      const ms = (i / steps) * totalMs
      const d = distance > 0 ? bounceDisplacement(bounce, ms) / distance : 0
      const x = xOf(ms)
      const y = yOf(d)
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y)
    }
    ctx.stroke()
  }, [bounce?.distance, bounce?.durationMs, bounce?.repeatCount, bounce?.easingType, bounce?.overshoot, totalMs, distance])
  return <canvas ref={ref} role="img" aria-label={`Bounce: displacement over ${formatValue(totalMs, 'ms')}`} />
}

/**
 * Note fade: the opacity a note's picture gets from its start to its end,
 * drawn on a one-beat note at the project tempo (the fixed-length modes depend
 * on the note's length, which this nominal note makes concrete).
 */
export function NoteFadeCanvas({ noteFade, bpm }) {
  const ref = useCanvasPaint((ctx, w, h, c) => {
    const { plotW, plotH, x0, y0 } = plotFrame(ctx, w, h, c)
    const yOf = (g) => y0 + (1 - g) * plotH
    const xOf = (p) => x0 + p * plotW
    ctx.lineWidth = 1
    for (const g of [0, 0.5, 1]) {
      ctx.strokeStyle = g === 0 ? c.zero : c.grid
      const gy = Math.round(yOf(g)) + 0.5
      ctx.beginPath(); ctx.moveTo(x0, gy); ctx.lineTo(x0 + plotW, gy); ctx.stroke()
    }
    ctx.fillStyle = c.text
    ctx.textAlign = 'right'
    ctx.textBaseline = 'middle'
    ctx.fillText('100 %', x0 - 4, yOf(1))
    ctx.fillText('0', x0 - 4, yOf(0))
    ctx.textBaseline = 'top'
    ctx.textAlign = 'left'
    ctx.fillText('Note start', x0, y0 + plotH + 4)
    ctx.textAlign = 'right'
    ctx.fillText('End', x0 + plotW, y0 + plotH + 4)

    ctx.strokeStyle = c.value
    ctx.lineWidth = 2
    ctx.lineJoin = 'round'
    ctx.beginPath()
    const steps = Math.max(64, Math.round(plotW))
    for (let i = 0; i <= steps; i += 1) {
      const p = i / steps
      const g = noteFade?.enabled === false ? 1 : noteFadeGain(noteFade, p, 1, bpm)
      if (i === 0) ctx.moveTo(xOf(p), yOf(g)); else ctx.lineTo(xOf(p), yOf(g))
    }
    ctx.stroke()
  }, [JSON.stringify(noteFade ?? null), bpm])
  return <canvas ref={ref} role="img" aria-label={`Note fade: opacity across a one-beat note at ${Math.round(bpm)} BPM`} />
}
