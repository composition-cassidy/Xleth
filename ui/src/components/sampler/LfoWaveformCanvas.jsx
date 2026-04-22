import { useRef, useEffect, useCallback } from 'react'
import { tokenValue } from '../../theming/tokenValue.ts'

const HANDLE_R = 4
const HANDLE_HIT = 10
const MAX_POINTS = 64

export default function LfoWaveformCanvas({
  waveform = [], color = tokenValue('--theme-sampler-lfo-color-volume'), width = 200, height = 80,
  onLiveChange, onCommit,
}) {
  const canvasRef = useRef(null)
  const dragRef = useRef(null) // { idx, startX, startY }

  // --- Drawing ---
  const draw = useCallback(() => {
    const c = canvasRef.current
    if (!c) return
    const dpr = window.devicePixelRatio || 1
    c.width = width * dpr
    c.height = height * dpr
    c.style.width = `${width}px`
    c.style.height = `${height}px`
    const ctx = c.getContext('2d')
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)

    // Background
    ctx.fillStyle = '#0a0a10'
    ctx.fillRect(0, 0, width, height)

    // Grid: center line
    ctx.strokeStyle = 'rgba(255,255,255,0.08)'
    ctx.lineWidth = 1
    ctx.beginPath()
    ctx.moveTo(0, height / 2)
    ctx.lineTo(width, height / 2)
    ctx.stroke()

    // Quarter lines
    ctx.strokeStyle = 'rgba(255,255,255,0.04)'
    ctx.beginPath()
    ctx.moveTo(0, height * 0.25)
    ctx.lineTo(width, height * 0.25)
    ctx.moveTo(0, height * 0.75)
    ctx.lineTo(width, height * 0.75)
    ctx.stroke()

    // Resolve points: use waveform or sine fallback
    const pts = waveform.length >= 2
      ? waveform
      : defaultSine()

    // Convert to pixel coords
    const px = pts.map(p => ({
      x: p.t * width,
      y: (1 - (p.v + 1) / 2) * height, // v=-1→bottom, v=1→top
    }))

    // Filled area
    if (px.length >= 2) {
      ctx.beginPath()
      ctx.moveTo(px[0].x, height / 2)
      for (const p of px) ctx.lineTo(p.x, p.y)
      ctx.lineTo(px[px.length - 1].x, height / 2)
      ctx.closePath()
      ctx.fillStyle = color + '18'
      ctx.fill()

      // Stroke
      ctx.beginPath()
      ctx.moveTo(px[0].x, px[0].y)
      for (let i = 1; i < px.length; i++) ctx.lineTo(px[i].x, px[i].y)
      ctx.strokeStyle = color
      ctx.lineWidth = 1.5
      ctx.stroke()
    }

    // Handles (only if user has custom waveform)
    if (waveform.length >= 2) {
      for (let i = 0; i < px.length; i++) {
        const isDragging = dragRef.current && dragRef.current.idx === i
        ctx.beginPath()
        ctx.arc(px[i].x, px[i].y, isDragging ? HANDLE_R + 1 : HANDLE_R, 0, Math.PI * 2)
        ctx.fillStyle = isDragging ? tokenValue('--theme-fg-inverse') : color
        ctx.fill()
        ctx.strokeStyle = '#0a0a10'
        ctx.lineWidth = 1
        ctx.stroke()
      }
    }
  }, [waveform, color, width, height])

  useEffect(() => { draw() }, [draw])

  // --- Hit testing ---
  const canvasPos = useCallback((e) => {
    const c = canvasRef.current
    if (!c) return { x: 0, y: 0 }
    const rect = c.getBoundingClientRect()
    return { x: e.clientX - rect.left, y: e.clientY - rect.top }
  }, [])

  const hitHandle = useCallback((px, py) => {
    if (waveform.length < 2) return -1
    for (let i = 0; i < waveform.length; i++) {
      const hx = waveform[i].t * width
      const hy = (1 - (waveform[i].v + 1) / 2) * height
      if (Math.hypot(px - hx, py - hy) <= HANDLE_HIT) return i
    }
    return -1
  }, [waveform, width, height])

  // --- Mouse handlers ---
  const onMouseDown = useCallback((e) => {
    if (e.button === 2) return // right-click handled by context menu
    const { x, y } = canvasPos(e)
    const idx = hitHandle(x, y)
    if (idx >= 0) {
      // Start drag
      dragRef.current = { idx }
      e.preventDefault()
    } else {
      // Click empty space → add point
      if (waveform.length >= MAX_POINTS) return
      const t = Math.max(0, Math.min(1, x / width))
      const v = Math.max(-1, Math.min(1, 1 - (y / height) * 2))
      let pts = waveform.length >= 2 ? [...waveform] : [...defaultSine()]
      pts.push({ t, v })
      pts.sort((a, b) => a.t - b.t)
      onLiveChange?.(pts)
      onCommit?.(pts)
    }
  }, [waveform, canvasPos, hitHandle, width, height, onLiveChange, onCommit])

  const onMouseMove = useCallback((e) => {
    if (!dragRef.current) return
    const { x, y } = canvasPos(e)
    const { idx } = dragRef.current
    const pts = [...waveform]
    // Clamp time between neighbors (keep endpoints at 0 and 1)
    let tMin = 0, tMax = 1
    if (idx > 0) tMin = pts[idx - 1].t + 0.001
    if (idx < pts.length - 1) tMax = pts[idx + 1].t - 0.001
    // First and last points are locked to t=0 and t=1
    let t = pts[idx].t
    if (idx > 0 && idx < pts.length - 1) {
      t = Math.max(tMin, Math.min(tMax, x / width))
    }
    const v = Math.max(-1, Math.min(1, 1 - (y / height) * 2))
    pts[idx] = { t, v }
    onLiveChange?.(pts)
  }, [waveform, canvasPos, width, height, onLiveChange])

  const onMouseUp = useCallback(() => {
    if (dragRef.current) {
      dragRef.current = null
      onCommit?.(waveform)
    }
  }, [waveform, onCommit])

  // Global mouse move/up during drag
  useEffect(() => {
    const move = (e) => onMouseMove(e)
    const up = () => onMouseUp()
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
    return () => {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
    }
  }, [onMouseMove, onMouseUp])

  // Right-click to delete
  const onContextMenu = useCallback((e) => {
    e.preventDefault()
    if (waveform.length <= 2) return // keep at least 2 endpoints
    const { x, y } = canvasPos(e)
    const idx = hitHandle(x, y)
    if (idx < 0) return
    // Don't delete first or last
    if (idx === 0 || idx === waveform.length - 1) return
    const pts = waveform.filter((_, i) => i !== idx)
    onLiveChange?.(pts)
    onCommit?.(pts)
  }, [waveform, canvasPos, hitHandle, onLiveChange, onCommit])

  return (
    <canvas
      ref={canvasRef}
      onMouseDown={onMouseDown}
      onContextMenu={onContextMenu}
      style={{
        borderRadius: 4,
        border: '1px solid var(--theme-sampler-key-border)',
        cursor: 'crosshair',
        display: 'block',
      }}
    />
  )
}

function defaultSine(n = 33) {
  return Array.from({ length: n }, (_, i) => ({
    t: i / (n - 1),
    v: Math.sin((i / (n - 1)) * Math.PI * 2),
  }))
}
