import { useRef, useEffect, useCallback, useMemo } from 'react'
import { tokenValue } from '../../theming/tokenValue.ts'
import { useThemeEpoch } from '../../theming/useThemeEpoch.js'

// 8-point catmull-rom LFO editor.
//
// External shape: backend stores `{t, v}[]` (one cycle, t in [0,1]).
// Internal shape: 8 control points evenly spaced at t = i/8 for i in 0..7,
// with periodic boundary (point 7 connects back to point 0).
//
// On read: sample the incoming backend curve at t = i/8 to derive the 8 Y
// values (cheap linear interpolation between the existing points).
// On commit: rebuild a high-resolution `{t, v}[]` (33 samples + closing point)
// from the catmull-rom spline so the engine renders the same shape it sees
// in the editor. This preserves the IPC payload shape — the engine's linear
// interpolation between control points stays the source of truth at runtime.

const LFO_N = 8
const LFO_CYCLES = 2
const HANDLE_R = 4
const HANDLE_HIT = 10
const COMMIT_SAMPLES = 32

export function backendToY(waveform) {
  const Y = new Array(LFO_N).fill(0)
  if (!Array.isArray(waveform) || waveform.length < 2) {
    for (let i = 0; i < LFO_N; i++) Y[i] = Math.sin((i / LFO_N) * Math.PI * 2)
    return Y
  }
  const sorted = [...waveform].sort((a, b) => a.t - b.t)
  for (let i = 0; i < LFO_N; i++) {
    const t = i / LFO_N
    Y[i] = sampleLinear(sorted, t)
  }
  return Y
}

function sampleLinear(pts, t) {
  if (pts.length === 0) return 0
  if (t <= pts[0].t) return pts[0].v
  if (t >= pts[pts.length - 1].t) return pts[pts.length - 1].v
  for (let i = 1; i < pts.length; i++) {
    if (t <= pts[i].t) {
      const a = pts[i - 1], b = pts[i]
      const span = b.t - a.t
      const frac = span > 0 ? (t - a.t) / span : 0
      return a.v + (b.v - a.v) * frac
    }
  }
  return pts[pts.length - 1].v
}

function crom(p0, p1, p2, p3, t) {
  const t2 = t * t, t3 = t2 * t
  return 0.5 * ((2 * p1) + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 + (-p0 + 3 * p1 - 3 * p2 + p3) * t3)
}

function lfoSample(Y, t) {
  const N = Y.length
  const i = Math.floor(t)
  const f = t - i
  return crom(Y[((i - 1) % N + N) % N], Y[i % N], Y[(i + 1) % N], Y[(i + 2) % N], f)
}

export function yToBackend(Y) {
  const out = []
  for (let i = 0; i < COMMIT_SAMPLES; i++) {
    const t = i / COMMIT_SAMPLES
    const sampleT = t * LFO_N
    const v = lfoSample(Y, sampleT)
    out.push({ t: Number(t.toFixed(4)), v: Number(v.toFixed(4)) })
  }
  out.push({ t: 1, v: Number(Y[0].toFixed(4)) })
  return out
}

export default function LfoWaveformCanvas({
  waveform = [],
  color = tokenValue('--theme-sampler-mod-color-volume'),
  width = 400,
  height = 80,
  onLiveChange,
  onCommit,
}) {
  const canvasRef = useRef(null)
  const dragRef = useRef(null)
  const themeEpoch = useThemeEpoch()

  const Y = useMemo(() => backendToY(waveform), [waveform])
  const amp = (height / 2) - 6

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

    ctx.fillStyle = tokenValue('--theme-sampler-envelope-bg') || tokenValue('--theme-bg-primary')
    ctx.fillRect(0, 0, width, height)

    ctx.strokeStyle = tokenValue('--theme-border-subtle')
    ctx.lineWidth = 1
    ctx.beginPath()
    ctx.moveTo(0, height / 2 + 0.5)
    ctx.lineTo(width, height / 2 + 0.5)
    ctx.stroke()

    const cyclePxW = width / LFO_CYCLES

    ctx.beginPath()
    for (let px = 0; px <= width; px++) {
      const t = (px / width) * LFO_N * LFO_CYCLES
      const y = lfoSample(Y, t)
      const cy = height / 2 - y * amp
      if (px === 0) ctx.moveTo(px, cy)
      else ctx.lineTo(px, cy)
    }
    ctx.lineTo(width, height / 2)
    ctx.lineTo(0, height / 2)
    ctx.closePath()
    const fillColor = color
    const fr = parseInt(fillColor.slice(1, 3), 16)
    const fg = parseInt(fillColor.slice(3, 5), 16)
    const fb = parseInt(fillColor.slice(5, 7), 16)
    const grad = ctx.createLinearGradient(0, 0, 0, height)
    grad.addColorStop(0, `rgba(${fr},${fg},${fb},0.18)`)
    grad.addColorStop(1, `rgba(${fr},${fg},${fb},0.02)`)
    ctx.fillStyle = grad
    ctx.fill()

    ctx.beginPath()
    ctx.strokeStyle = color
    ctx.lineWidth = 1.5
    for (let px = 0; px <= width; px++) {
      const t = (px / width) * LFO_N * LFO_CYCLES
      const y = lfoSample(Y, t)
      const cy = height / 2 - y * amp
      if (px === 0) ctx.moveTo(px, cy)
      else ctx.lineTo(px, cy)
    }
    ctx.stroke()

    ctx.strokeStyle = tokenValue('--theme-border-subtle')
    ctx.lineWidth = 1
    ctx.setLineDash([2, 2])
    ctx.beginPath()
    ctx.moveTo(cyclePxW, 0)
    ctx.lineTo(cyclePxW, height)
    ctx.stroke()
    ctx.setLineDash([])

    const cardBg = tokenValue('--theme-bg-elevated')
    for (let i = 0; i < LFO_N; i++) {
      const px = (i / LFO_N) * cyclePxW
      const py = height / 2 - Y[i] * amp
      ctx.beginPath()
      ctx.arc(px, py, HANDLE_R, 0, Math.PI * 2)
      ctx.fillStyle = cardBg
      ctx.fill()
      ctx.strokeStyle = color
      ctx.lineWidth = 1.5
      ctx.stroke()
    }
  }, [Y, color, width, height, amp, themeEpoch])

  useEffect(() => { draw() }, [draw])

  const onMouseDown = useCallback((e) => {
    const c = canvasRef.current
    if (!c) return
    e.preventDefault()
    const rect = c.getBoundingClientRect()
    const cyclePxW = width / LFO_CYCLES
    const mx = (e.clientX - rect.left) * (width / rect.width)
    const my = (e.clientY - rect.top) * (height / rect.height)
    let hitIdx = -1
    for (let i = 0; i < LFO_N; i++) {
      const px = (i / LFO_N) * cyclePxW
      const py = height / 2 - Y[i] * amp
      if (Math.hypot(mx - px, my - py) <= HANDLE_HIT) { hitIdx = i; break }
    }
    if (hitIdx < 0) return

    dragRef.current = { idx: hitIdx, Y: [...Y] }

    const onMove = (ev) => {
      const ds = dragRef.current
      if (!ds) return
      const r2 = c.getBoundingClientRect()
      const my2 = (ev.clientY - r2.top) * (height / r2.height)
      const newY = Math.max(-1, Math.min(1, -(my2 - height / 2) / amp))
      const next = [...ds.Y]
      next[ds.idx] = Number(newY.toFixed(4))
      ds.Y = next
      onLiveChange?.(yToBackend(next))
    }
    const onUp = () => {
      const ds = dragRef.current
      dragRef.current = null
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      if (ds) onCommit?.(yToBackend(ds.Y))
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }, [Y, amp, height, width, onLiveChange, onCommit])

  return (
    <canvas
      ref={canvasRef}
      onMouseDown={onMouseDown}
      style={{ display: 'block', cursor: 'crosshair', width: '100%', height }}
    />
  )
}
