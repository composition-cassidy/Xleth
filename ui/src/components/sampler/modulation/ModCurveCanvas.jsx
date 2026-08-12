import { useRef, useEffect, useCallback } from 'react'
import { tokenValue } from '../../../theming/tokenValue.ts'
import { useThemeEpoch } from '../../../theming/useThemeEpoch.js'
import { evalModCurve } from './modEval.js'
import { MAX_CURVE_POINTS } from './modConstants.js'

// ── VELO / NOTE response-curve editor (canvas only) ──────────────────────────
// A controlled canvas over the engine's `{x, y, tension}[]` response curve
// (input 0..1 → output 0..1). Fewer than two points is identity, so the editor
// materialises the two endpoints on first edit and never lets them be removed —
// a response curve must span the whole input range.
//
// Canvas-drawn end to end for the same reason as the shape editor: DOM handles
// would drift against the scrolled panel and corrupt hit-testing.

const HANDLE_R = 4
const HANDLE_HIT = 11
const PAD = 8

export default function ModCurveCanvas({
  points,
  selectedIdx = -1,
  color,
  width = 300,
  height = 150,
  onPreview,
  onCommit,
  onSelect,
}) {
  const canvasRef = useRef(null)
  const dragRef = useRef(null)
  const themeEpoch = useThemeEpoch()

  // Identity curve (<2 points) draws — and edits — as the diagonal endpoints.
  const effective = Array.isArray(points) && points.length >= 2
    ? points
    : [{ x: 0, y: 0, tension: 0 }, { x: 1, y: 1, tension: 0 }]
  const effRef = useRef(effective)
  effRef.current = effective

  const xOf = useCallback((x) => PAD + x * (width - 2 * PAD), [width])
  const yOf = useCallback((y) => (height - PAD) - y * (height - 2 * PAD), [height])
  const xIn = useCallback((px) => Math.max(0, Math.min(1, (px - PAD) / (width - 2 * PAD))), [width])
  const yIn = useCallback((py) => Math.max(0, Math.min(1, ((height - PAD) - py) / (height - 2 * PAD))), [height])

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

    const bg = tokenValue('--theme-sampler-envelope-bg') || tokenValue('--theme-bg-primary')
    const gridCol = tokenValue('--theme-border-subtle')
    const resolvedColor = color?.startsWith('var(')
      ? tokenValue(color.slice(4, -1)) || tokenValue('--theme-accent')
      : (color || tokenValue('--theme-accent'))

    ctx.fillStyle = bg
    ctx.fillRect(0, 0, width, height)

    // Quartile grid + the identity diagonal for reference.
    ctx.strokeStyle = gridCol
    ctx.globalAlpha = 0.5
    ctx.lineWidth = 1
    for (let i = 1; i < 4; i++) {
      const gx = xOf(i / 4), gy = yOf(i / 4)
      ctx.beginPath(); ctx.moveTo(gx + 0.5, yOf(0)); ctx.lineTo(gx + 0.5, yOf(1)); ctx.stroke()
      ctx.beginPath(); ctx.moveTo(xOf(0), gy + 0.5); ctx.lineTo(xOf(1), gy + 0.5); ctx.stroke()
    }
    ctx.globalAlpha = 0.35
    ctx.setLineDash([3, 3])
    ctx.beginPath(); ctx.moveTo(xOf(0), yOf(0)); ctx.lineTo(xOf(1), yOf(1)); ctx.stroke()
    ctx.setLineDash([])
    ctx.globalAlpha = 1

    const pts = effRef.current
    const rgb = hexToRgb(resolvedColor)

    // Curve, sampled through the engine evaluator.
    const line = []
    const steps = Math.max(2, width - 2 * PAD)
    for (let i = 0; i <= steps; i++) {
      const x = i / steps
      line.push({ x: xOf(x), y: yOf(evalModCurve(pts, x)) })
    }
    ctx.beginPath()
    ctx.moveTo(line[0].x, line[0].y)
    for (const p of line) ctx.lineTo(p.x, p.y)
    ctx.lineTo(xOf(1), yOf(0))
    ctx.lineTo(xOf(0), yOf(0))
    ctx.closePath()
    const grad = ctx.createLinearGradient(0, 0, 0, height)
    grad.addColorStop(0, `rgba(${rgb.r},${rgb.g},${rgb.b},0.16)`)
    grad.addColorStop(1, `rgba(${rgb.r},${rgb.g},${rgb.b},0.02)`)
    ctx.fillStyle = grad
    ctx.fill()

    ctx.beginPath()
    ctx.strokeStyle = resolvedColor
    ctx.lineWidth = 1.5
    for (let i = 0; i < line.length; i++) {
      if (i === 0) ctx.moveTo(line[i].x, line[i].y)
      else ctx.lineTo(line[i].x, line[i].y)
    }
    ctx.stroke()

    const cardBg = tokenValue('--theme-bg-elevated')
    for (let i = 0; i < pts.length; i++) {
      const px = xOf(pts[i].x), py = yOf(pts[i].y)
      const sel = i === selectedIdx
      ctx.beginPath()
      ctx.arc(px, py, sel ? HANDLE_R + 1.5 : HANDLE_R, 0, Math.PI * 2)
      ctx.fillStyle = sel ? resolvedColor : cardBg
      ctx.fill()
      ctx.strokeStyle = resolvedColor
      ctx.lineWidth = 1.5
      ctx.stroke()
    }
  }, [color, width, height, selectedIdx, xOf, yOf, themeEpoch])

  useEffect(() => { draw() }, [draw])

  const hitTest = useCallback((mx, my) => {
    const pts = effRef.current
    for (let i = 0; i < pts.length; i++) {
      if (Math.hypot(mx - xOf(pts[i].x), my - yOf(pts[i].y)) <= HANDLE_HIT) return i
    }
    return -1
  }, [xOf, yOf])

  const localXY = useCallback((clientX, clientY) => {
    const rect = canvasRef.current.getBoundingClientRect()
    return [
      (clientX - rect.left) * (width / rect.width),
      (clientY - rect.top) * (height / rect.height),
    ]
  }, [width, height])

  const onMouseDown = useCallback((e) => {
    if (!canvasRef.current) return
    e.preventDefault()
    const [mx, my] = localXY(e.clientX, e.clientY)
    const idx = hitTest(mx, my)
    const pts = effRef.current

    // Delete an interior point (endpoints are permanent).
    if (idx > 0 && idx < pts.length - 1 && (e.button === 2 || e.altKey)) {
      const next = pts.filter((_, i) => i !== idx)
      onCommit?.(next)
      onSelect?.(-1)
      return
    }
    if (idx < 0) return

    onSelect?.(idx)
    dragRef.current = { idx }
    const onMove = (ev) => {
      const ds = dragRef.current
      if (!ds) return
      const [mx2, my2] = localXY(ev.clientX, ev.clientY)
      const cur = effRef.current
      const next = cur.map((p) => ({ ...p }))
      const p = next[ds.idx]
      p.y = Number(yIn(my2).toFixed(4))
      // Endpoints keep their x (0 and 1); interior points move between neighbours.
      if (ds.idx > 0 && ds.idx < next.length - 1) {
        const lo = next[ds.idx - 1].x + 1e-4
        const hi = next[ds.idx + 1].x - 1e-4
        p.x = Number(Math.max(lo, Math.min(hi, xIn(mx2))).toFixed(4))
      }
      onPreview?.(next)
    }
    const onUp = () => {
      const ds = dragRef.current
      dragRef.current = null
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      if (ds) onCommit?.(effRef.current)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }, [hitTest, localXY, onCommit, onPreview, onSelect, xIn, yIn])

  const onDoubleClick = useCallback((e) => {
    if (!canvasRef.current) return
    e.preventDefault()
    const [mx, my] = localXY(e.clientX, e.clientY)
    if (hitTest(mx, my) >= 0) return
    const pts = effRef.current
    if (pts.length >= MAX_CURVE_POINTS) return
    const np = { x: Number(xIn(mx).toFixed(4)), y: Number(yIn(my).toFixed(4)), tension: 0 }
    const next = [...pts, np].sort((a, b) => a.x - b.x)
    onCommit?.(next)
    onSelect?.(next.indexOf(np))
  }, [hitTest, localXY, onCommit, onSelect, xIn, yIn])

  return (
    <canvas
      ref={canvasRef}
      onMouseDown={onMouseDown}
      onDoubleClick={onDoubleClick}
      onContextMenu={(e) => e.preventDefault()}
      style={{ display: 'block', cursor: 'crosshair', width: '100%', height }}
    />
  )
}

function hexToRgb(hex) {
  if (typeof hex !== 'string') return { r: 120, g: 200, b: 210 }
  let h = hex.trim()
  if (h.startsWith('#')) h = h.slice(1)
  if (h.length === 3) h = h.split('').map((ch) => ch + ch).join('')
  const n = parseInt(h, 16)
  if (Number.isNaN(n)) return { r: 120, g: 200, b: 210 }
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 }
}
