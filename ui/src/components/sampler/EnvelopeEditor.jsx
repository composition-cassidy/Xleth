import { useRef, useEffect, useCallback, useState } from 'react'
import { tokenValue } from '../../theming/tokenValue.ts'

const HANDLE_R = 5
const HANDLE_HIT = 10
const SUSTAIN_VIS_MS = 200 // visual-only sustain phase for display
const CURVE_STEPS = 32     // sub-segments for tension curves

// Same tension curve as C++ engine: pow(t, pow(2, -tension*2))
function shapeTension(t, tension) {
  if (Math.abs(tension) < 0.001) return t
  const exponent = Math.pow(2, -tension * 2)
  return Math.pow(t, exponent)
}

function drawTensionCurve(ctx, x0, y0, x1, y1, tension) {
  for (let i = 1; i <= CURVE_STEPS; i++) {
    const t = i / CURVE_STEPS
    const shaped = shapeTension(t, tension)
    const x = x0 + (x1 - x0) * t
    const y = y0 + (y1 - y0) * shaped
    ctx.lineTo(x, y)
  }
}

export default function EnvelopeEditor({
  delayMs = 0, attackMs = 0, holdMs = 0, decayMs = 0, sustain = 1, releaseMs = 50,
  attackTension = 0, decayTension = 0, releaseTension = 0,
  onLiveChange, onCommit,
  width = 520, height = 120,
  color = tokenValue('--theme-sampler-lfo-color-volume'),
}) {
  const canvasRef = useRef(null)
  const dragRef = useRef(null)
  const [hoverHandle, setHoverHandle] = useState(null)

  const tMax = Math.max(500, delayMs + attackMs + holdMs + decayMs + SUSTAIN_VIS_MS + releaseMs)

  const paddingL = 8, paddingR = 8, paddingT = 8, paddingB = 8
  const plotW = width - paddingL - paddingR
  const plotH = height - paddingT - paddingB

  const timeToX = useCallback((t) => paddingL + (t / tMax) * plotW, [plotW, tMax])
  const ampToY  = useCallback((a) => paddingT + (1 - a) * plotH, [plotH])
  const xToTime = useCallback((x) => ((x - paddingL) / plotW) * tMax, [plotW, tMax])
  const yToAmp  = useCallback((y) => 1 - ((y - paddingT) / plotH), [plotH])

  // Compute the 7 control points
  const getPoints = useCallback(() => {
    const tDel = delayMs
    const tAtk = tDel + attackMs
    const tHld = tAtk + holdMs
    const tDec = tHld + decayMs
    const tSus = tDec + SUSTAIN_VIS_MS
    const tRel = tSus + releaseMs
    return {
      P0: { x: timeToX(0),    y: ampToY(0) },       // origin
      P1: { x: timeToX(tDel), y: ampToY(0) },       // end delay
      P2: { x: timeToX(tAtk), y: ampToY(1) },       // end attack (peak)
      P3: { x: timeToX(tHld), y: ampToY(1) },       // end hold
      P4: { x: timeToX(tDec), y: ampToY(sustain) },  // end decay
      P5: { x: timeToX(tSus), y: ampToY(sustain) },  // end sustain (visual)
      P6: { x: timeToX(tRel), y: ampToY(0) },       // end release
    }
  }, [delayMs, attackMs, holdMs, decayMs, sustain, releaseMs, timeToX, ampToY])

  // Draw
  useEffect(() => {
    const c = canvasRef.current
    if (!c) return
    const dpr = window.devicePixelRatio || 1
    c.width  = width * dpr
    c.height = height * dpr
    c.style.width = `${width}px`
    c.style.height = `${height}px`
    const ctx = c.getContext('2d')
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)

    // Background
    ctx.fillStyle = '#0a0a10'
    ctx.fillRect(0, 0, width, height)

    // Grid: horizontal amp lines
    ctx.strokeStyle = 'rgba(255,255,255,0.04)'
    ctx.lineWidth = 1
    ctx.beginPath()
    for (let i = 0; i <= 4; i++) {
      const y = paddingT + (i / 4) * plotH
      ctx.moveTo(paddingL, Math.round(y) + 0.5)
      ctx.lineTo(paddingL + plotW, Math.round(y) + 0.5)
    }
    ctx.stroke()

    const { P0, P1, P2, P3, P4, P5, P6 } = getPoints()

    // Filled envelope area
    ctx.beginPath()
    ctx.moveTo(P0.x, P0.y)
    ctx.lineTo(P1.x, P1.y)                                          // Delay: flat at 0
    drawTensionCurve(ctx, P1.x, P1.y, P2.x, P2.y, attackTension)   // Attack: curved
    ctx.lineTo(P3.x, P3.y)                                          // Hold: flat at 1
    drawTensionCurve(ctx, P3.x, P3.y, P4.x, P4.y, decayTension)    // Decay: curved
    ctx.lineTo(P5.x, P5.y)                                          // Sustain: flat
    drawTensionCurve(ctx, P5.x, P5.y, P6.x, P6.y, releaseTension)  // Release: curved
    ctx.lineTo(P6.x, ampToY(0))
    ctx.lineTo(P0.x, ampToY(0))
    ctx.closePath()
    const cr = parseInt(color.slice(1, 3), 16)
    const cg = parseInt(color.slice(3, 5), 16)
    const cb = parseInt(color.slice(5, 7), 16)
    ctx.fillStyle = `rgba(${cr},${cg},${cb},0.15)`
    ctx.fill()

    // Envelope line (same path, stroke)
    ctx.strokeStyle = color
    ctx.lineWidth = 2
    ctx.beginPath()
    ctx.moveTo(P0.x, P0.y)
    ctx.lineTo(P1.x, P1.y)
    drawTensionCurve(ctx, P1.x, P1.y, P2.x, P2.y, attackTension)
    ctx.lineTo(P3.x, P3.y)
    drawTensionCurve(ctx, P3.x, P3.y, P4.x, P4.y, decayTension)
    ctx.lineTo(P5.x, P5.y)
    drawTensionCurve(ctx, P5.x, P5.y, P6.x, P6.y, releaseTension)
    ctx.stroke()

    // Phase separator dashes
    ctx.strokeStyle = 'rgba(255,255,255,0.12)'
    ctx.lineWidth = 1
    ctx.setLineDash([3, 3])
    ctx.beginPath()
    // Delay/Attack boundary
    if (delayMs > 0) { ctx.moveTo(P1.x, 0); ctx.lineTo(P1.x, height) }
    // Hold/Decay boundary
    if (holdMs > 0)  { ctx.moveTo(P3.x, 0); ctx.lineTo(P3.x, height) }
    // Sustain boundaries
    ctx.moveTo(P4.x, 0); ctx.lineTo(P4.x, height)
    ctx.moveTo(P5.x, 0); ctx.lineTo(P5.x, height)
    ctx.stroke()
    ctx.setLineDash([])

    // Draggable handles
    const drawHandle = (p, active) => {
      ctx.fillStyle = active ? tokenValue('--theme-fg-inverse') : color
      ctx.strokeStyle = '#0a0a10'
      ctx.lineWidth = 2
      ctx.beginPath()
      ctx.arc(p.x, p.y, HANDLE_R, 0, Math.PI * 2)
      ctx.fill()
      ctx.stroke()
    }
    if (delayMs > 0) drawHandle(P1, hoverHandle === 'DL')
    drawHandle(P2, hoverHandle === 'A')
    if (holdMs > 0) drawHandle(P3, hoverHandle === 'H')
    drawHandle(P4, hoverHandle === 'D')
    drawHandle(P6, hoverHandle === 'R')
  }, [delayMs, attackMs, holdMs, decayMs, sustain, releaseMs,
      attackTension, decayTension, releaseTension,
      width, height, plotW, plotH, getPoints, ampToY, hoverHandle, color])

  const getLocalXY = useCallback((e) => {
    const rect = canvasRef.current?.getBoundingClientRect()
    if (!rect) return null
    return { x: e.clientX - rect.left, y: e.clientY - rect.top }
  }, [])

  const hitTest = useCallback((x, y) => {
    const pts = getPoints()
    const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y)
    if (delayMs > 0 && dist({ x, y }, pts.P1) <= HANDLE_HIT) return 'DL'
    if (dist({ x, y }, pts.P2) <= HANDLE_HIT) return 'A'
    if (holdMs > 0 && dist({ x, y }, pts.P3) <= HANDLE_HIT) return 'H'
    if (dist({ x, y }, pts.P4) <= HANDLE_HIT) return 'D'
    if (dist({ x, y }, pts.P6) <= HANDLE_HIT) return 'R'
    return null
  }, [getPoints, delayMs, holdMs])

  const handleMouseDown = useCallback((e) => {
    const pos = getLocalXY(e)
    if (!pos) return
    const handle = hitTest(pos.x, pos.y)
    if (!handle) return
    e.preventDefault()
    dragRef.current = {
      handle,
      startX: pos.x, startY: pos.y,
      del: delayMs, a: attackMs, h: holdMs, d: decayMs, s: sustain, r: releaseMs,
    }
  }, [getLocalXY, hitTest, delayMs, attackMs, holdMs, decayMs, sustain, releaseMs])

  useEffect(() => {
    const onMove = (e) => {
      const ds = dragRef.current
      const rect = canvasRef.current?.getBoundingClientRect()
      if (!rect) { if (!ds) return }
      if (ds) {
        const x = e.clientX - (rect?.left ?? 0)
        const y = e.clientY - (rect?.top  ?? 0)
        const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v))

        if (ds.handle === 'DL') {
          const newDel = clamp(Math.round(xToTime(x)), 0, 5000)
          onLiveChange?.({ delayMs: newDel })
        } else if (ds.handle === 'A') {
          // Attack endpoint: time from delay end
          const newA = clamp(Math.round(xToTime(x) - ds.del), 0, 5000)
          onLiveChange?.({ attackMs: newA })
        } else if (ds.handle === 'H') {
          // Hold endpoint: time from attack end
          const newH = clamp(Math.round(xToTime(x) - ds.del - ds.a), 0, 5000)
          onLiveChange?.({ holdMs: newH })
        } else if (ds.handle === 'D') {
          // Decay endpoint: time and sustain level
          const newD = clamp(Math.round(xToTime(x) - ds.del - ds.a - ds.h), 0, 5000)
          const newS = clamp(yToAmp(y), 0, 1)
          onLiveChange?.({ decayMs: newD, sustain: Number(newS.toFixed(3)) })
        } else if (ds.handle === 'R') {
          const tTotal = xToTime(x)
          const newR = clamp(Math.round(tTotal - ds.del - ds.a - ds.h - ds.d - SUSTAIN_VIS_MS), 0, 5000)
          onLiveChange?.({ releaseMs: newR })
        }
      } else {
        // hover test
        if (!rect) return
        const hx = e.clientX - rect.left
        const hy = e.clientY - rect.top
        if (hx < 0 || hx > width || hy < 0 || hy > height) {
          if (hoverHandle) setHoverHandle(null)
          return
        }
        const h = hitTest(hx, hy)
        if (h !== hoverHandle) setHoverHandle(h)
      }
    }
    const onUp = () => {
      if (dragRef.current) {
        dragRef.current = null
        onCommit?.()
      }
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
  }, [xToTime, yToAmp, hitTest, onLiveChange, onCommit, hoverHandle, width, height])

  return (
    <canvas
      ref={canvasRef}
      style={{
        cursor: hoverHandle || dragRef.current ? 'grab' : 'default',
        display: 'block',
        borderRadius: 4,
        border: '1px solid var(--theme-sampler-key-border)',
      }}
      onMouseDown={handleMouseDown}
    />
  )
}
