import { useEffect, useMemo, useRef } from 'react'
import { useThemeEpoch } from '../../../theming/useThemeEpoch.js'
import { lfoTimeline, timeTicks } from './modTime.js'
import {
  RULER_H, drawTicks, hLine, palette, prepCanvas, rgba, vLine,
} from './modCanvas.js'
import { BEHAVIOR_FREE } from './modConstants.js'

// ── LFO over time (read-only) ────────────────────────────────────────────────
// What the LFO sends from the moment a note starts, TO SCALE on the same time
// ruler the envelope uses: the cycle repeating at its rate, after its Delay, under
// its Rise, with Phase and Smooth applied as the engine applies them. A slow LFO
// shows a fraction of a cycle and a fast one shows many; nothing is stretched to
// fit. Drawn from the configured values (modTime.lfoValueAt mirrors the engine's
// advanceModLfo), not from a running voice: it is the plan, not a meter, so it
// does not move.

const PAD_L = 30
const PAD_R = 10
const PAD_V = 5

export default function LfoTimeline({
  lfo, color, width = 460, height = 72, spanSec = 1, sync = false, bpm = 120, timing, label = 'LFO',
}) {
  const canvasRef = useRef(null)
  const themeEpoch = useThemeEpoch()
  const box = useMemo(() => ({
    x: PAD_L, y: RULER_H + PAD_V,
    w: Math.max(20, width - PAD_L - PAD_R),
    h: Math.max(12, height - RULER_H - PAD_V * 2),
  }), [width, height])

  useEffect(() => {
    const c = canvasRef.current
    if (!c) return
    const ctx = prepCanvas(c, width, height)
    const pal = palette(color)
    const right = box.x + box.w
    const bottom = box.y + box.h
    const yOf = (v) => box.y + box.h / 2 - v * (box.h / 2)
    const pps = box.w / spanSec

    ctx.fillStyle = pal.bg
    ctx.fillRect(0, 0, width, height)
    ctx.fillStyle = pal.header
    ctx.fillRect(0, 0, width, RULER_H)

    const ticks = timeTicks(spanSec, box.w, { sync, bpm }).map((t) => ({ ...t, x: box.x + t.sec * pps }))
    drawTicks(ctx, pal, ticks, { rulerY: 0, plotY0: box.y, plotY1: bottom, clipX0: box.x, clipX1: right })

    ctx.font = pal.font
    ctx.textBaseline = 'middle'
    ctx.textAlign = 'right'
    ctx.strokeStyle = pal.line
    ctx.lineWidth = 1
    hLine(ctx, yOf(0), box.x, right)
    ctx.fillStyle = pal.ink2
    ctx.fillText('+1', box.x - 5, yOf(1) + 3)
    ctx.fillText('−1', box.x - 5, yOf(-1) - 3)

    // Delay and Rise, marked where they end.
    ctx.textAlign = 'left'
    const mark = (sec, text) => {
      if (!(sec > 1e-6) || sec >= spanSec) return
      const x = box.x + sec * pps
      ctx.strokeStyle = pal.ink2
      ctx.setLineDash([2, 3])
      vLine(ctx, x, box.y, bottom)
      ctx.setLineDash([])
      ctx.fillStyle = pal.ink2
      ctx.fillText(text, x + 4, bottom - 6)
    }
    mark(timing.delaySec, 'delay')
    if (Math.abs((timing.riseSec || 0) - (timing.delaySec || 0)) * pps > 34 || !(timing.delaySec > 1e-6)) {
      mark(timing.riseSec, 'rise')
    }

    // The trace: per pixel column the range the LFO covers in it, so a fast LFO
    // is a band, never an alias.
    const cols = lfoTimeline(lfo, spanSec, box.w, timing)
    ctx.beginPath()
    cols.forEach((col, i) => {
      const x = box.x + (i / (cols.length - 1)) * box.w
      if (i === 0) ctx.moveTo(x, yOf(col.hi))
      else ctx.lineTo(x, yOf(col.hi))
    })
    for (let i = cols.length - 1; i >= 0; i--) {
      ctx.lineTo(box.x + (i / (cols.length - 1)) * box.w, yOf(cols[i].lo))
    }
    ctx.closePath()
    ctx.fillStyle = rgba(pal.signal, 0.35)
    ctx.fill()
    ctx.strokeStyle = pal.signal
    ctx.lineWidth = 1.5
    ctx.lineJoin = 'round'
    ctx.beginPath()
    cols.forEach((col, i) => {
      const x = box.x + (i / (cols.length - 1)) * box.w
      const y = yOf((col.lo + col.hi) / 2)
      if (i === 0) ctx.moveTo(x, y)
      else ctx.lineTo(x, y)
    })
    // The centre line is only meaningful while a column holds less than a cycle.
    if (timing.rateHz * (spanSec / box.w) < 0.25) ctx.stroke()
  }, [lfo, color, width, height, box, spanSec, sync, bpm, timing, themeEpoch])

  const free = (lfo.behavior ?? 0) === BEHAVIOR_FREE
  return (
    <canvas
      ref={canvasRef}
      role="img"
      aria-label={`${label} over time, drawn to scale${free ? ' (Free: the phase follows the transport, shown from a cycle start)' : ''}`}
      data-lfo-timeline=""
      style={{ display: 'block', width, height }}
    />
  )
}
