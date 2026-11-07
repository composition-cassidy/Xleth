import React, { useEffect, useRef } from 'react'
import { formatValue } from '../../ui-kit'
import { readMixerCanvasTheme, syncCanvasSize, MONO_SM } from '../mixer/mixerCanvasTheme.js'

import { subscribeDpr } from '../../ui-kit/dpr'
// The Flanger's LFO, drawn from the two parameters that define it. Not a signal
// tap: nothing here moves unless Rate or Depth does (the Sweep view is the
// same kind of display). Two cycles of a sine, the centre rule is the base
// delay, the bracket on the left is the depth, the label is the rate.
//
//   rate   -> cycles across the display (two cycles whatever the rate; the
//             readout carries the number)
//   depth  -> peak-to-peak height as a share of the display's half height
//   delay  -> the centre rule's label (the base delay the LFO sweeps around)
const RATE_MIN = 0.05
const RATE_MAX = 10

export default function FlangerLfoCanvas({ params }) {
  const canvasRef = useRef(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return undefined

    const paint = () => {
      const p = params
      const { cssW, cssH, dpr } = syncCanvasSize(canvas, 232, 200)
      const ctx = canvas.getContext('2d', { alpha: false })
      if (!ctx) return
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      const th = readMixerCanvasTheme(canvas)

      const rate = Math.max(RATE_MIN, Math.min(RATE_MAX, p.rate ?? 0.5))
      const depth = Math.max(0, Math.min(100, p.depth ?? 70))
      const delay = Math.max(0.1, Math.min(5, p.delay ?? 1.5))

      ctx.fillStyle = th.well
      ctx.fillRect(0, 0, cssW, cssH)

      const padL = 34
      const padR = 8
      const plotW = Math.max(10, cssW - padL - padR)
      const midY = cssH / 2
      const amp = (cssH / 2 - 22) * (depth / 100)

      // Centre rule = the base delay.
      ctx.strokeStyle = th.borderStrong
      ctx.lineWidth = 1
      ctx.beginPath()
      ctx.moveTo(padL, Math.round(midY) + 0.5)
      ctx.lineTo(cssW - padR, Math.round(midY) + 0.5)
      ctx.stroke()

      // Two cycles.
      ctx.strokeStyle = th.accent
      ctx.lineWidth = 1.5
      ctx.beginPath()
      const steps = Math.max(24, Math.floor(plotW / 2))
      for (let i = 0; i <= steps; i += 1) {
        const t = i / steps
        const x = padL + t * plotW
        const y = midY - Math.sin(t * Math.PI * 4) * amp
        if (i === 0) ctx.moveTo(x, y)
        else ctx.lineTo(x, y)
      }
      ctx.stroke()

      // Depth bracket on the left edge.
      ctx.strokeStyle = th.textMuted
      ctx.lineWidth = 1
      ctx.beginPath()
      ctx.moveTo(padL - 8, midY - amp)
      ctx.lineTo(padL - 5, midY - amp)
      ctx.lineTo(padL - 5, midY + amp)
      ctx.lineTo(padL - 8, midY + amp)
      ctx.stroke()

      ctx.font = MONO_SM
      ctx.textBaseline = 'top'
      ctx.textAlign = 'left'
      ctx.fillStyle = th.text
      ctx.fillText(`RATE ${formatValue(rate, 'Hz', { decimals: 2 })}`, padL, 6)
      ctx.fillText(`DEPTH ${formatValue(depth, '%')}`, padL + 96, 6)
      ctx.fillStyle = th.textMuted
      ctx.textBaseline = 'bottom'
      ctx.fillText(`CENTRE ${formatValue(delay, 'ms', { decimals: 2 })}`, padL, cssH - 6)
    }

    paint()
    // Window zoom changes the DPR without resizing the box: repaint at the new density.
    const offDpr = subscribeDpr(paint)
    if (typeof ResizeObserver === 'undefined') return offDpr
    const ro = new ResizeObserver(paint)
    ro.observe(canvas)
    return () => { ro.disconnect(); offDpr() }
  }, [params])

  return (
    <canvas
      ref={canvasRef}
      className="flanger-lfo-canvas"
      style={{ display: 'block', width: '100%', height: '100%' }}
    />
  )
}
