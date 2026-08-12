import { useRef, useEffect, useCallback } from 'react'
import { tokenValue } from '../../../theming/tokenValue.ts'
import { useThemeEpoch } from '../../../theming/useThemeEpoch.js'
import { evalLfoShape } from './modEval.js'
import { SEG_LINE, MAX_LFO_POINTS } from './modConstants.js'

// ── LFO shape point editor (canvas only) ─────────────────────────────────────
// A controlled canvas over the engine's `{t, v, seg, tension}[]` shape. Drawing
// goes through evalLfoShape so STEP / LINE / CURVE segments and the cyclic wrap
// look EXACTLY like the audio thread renders them.
//
// This is deliberately canvas-drawn end to end — points, grid, handles and the
// hit-testing all live in canvas pixel space. A DOM-overlay handle layer would
// drift against the canvas on scroll/zoom and corrupt hit-testing, which the
// panel scrolls, so it is never used here.
//
// Interactions:
//   drag handle          move the point (t clamped between neighbours, v in ±1)
//   double-click empty   add a point (LINE segment) at the cursor
//   right / alt click    delete a point (keeps a minimum of two)
//   click handle         select it (segment tools + tension act on the selection)
//
// Edits are LOCAL until mouseup: a drag streams through onPreview; onCommit
// fires once, on release. Discrete edits (add / delete) commit immediately.

const HANDLE_R = 4
const HANDLE_HIT = 11
const PAD_Y = 8

function snapTo(value, divisions, lo, hi) {
  if (!divisions || divisions < 1) return value
  const span = hi - lo
  const step = span / divisions
  const snapped = lo + Math.round((value - lo) / step) * step
  return Math.max(lo, Math.min(hi, snapped))
}

export default function ModShapeCanvas({
  points,
  selectedIdx = -1,
  snapX = 0,
  snapY = 0,
  color,
  width = 460,
  height = 150,
  onPreview,
  onCommit,
  onSelect,
}) {
  const canvasRef = useRef(null)
  const dragRef = useRef(null)
  const themeEpoch = useThemeEpoch()
  const pointsRef = useRef(points)
  pointsRef.current = points

  const xOf = useCallback((t) => t * width, [width])
  const yOf = useCallback((v) => (height / 2) - v * (height / 2 - PAD_Y), [height])
  const tOf = useCallback((px) => Math.max(0, Math.min(1, px / width)), [width])
  const vOf = useCallback((py) => Math.max(-1, Math.min(1, (height / 2 - py) / (height / 2 - PAD_Y))), [height])

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

    // Snap grid.
    ctx.strokeStyle = gridCol
    ctx.globalAlpha = 0.5
    ctx.lineWidth = 1
    if (snapX >= 1) {
      for (let i = 1; i < snapX; i++) {
        const x = (i / snapX) * width
        ctx.beginPath(); ctx.moveTo(x + 0.5, 0); ctx.lineTo(x + 0.5, height); ctx.stroke()
      }
    }
    if (snapY >= 1) {
      for (let i = 1; i < snapY; i++) {
        const y = (i / snapY) * height
        ctx.beginPath(); ctx.moveTo(0, y + 0.5); ctx.lineTo(width, y + 0.5); ctx.stroke()
      }
    }
    ctx.globalAlpha = 1

    // Zero line.
    ctx.strokeStyle = gridCol
    ctx.lineWidth = 1
    ctx.beginPath(); ctx.moveTo(0, height / 2 + 0.5); ctx.lineTo(width, height / 2 + 0.5); ctx.stroke()

    const pts = pointsRef.current
    if (!Array.isArray(pts) || pts.length === 0) return

    // Shape fill + line, sampled through the engine evaluator (smooth = 0: the
    // editor shows the raw editable shape).
    const line = []
    for (let px = 0; px <= width; px++) {
      const phase = px / width
      line.push({ x: px, y: yOf(evalLfoShape(pts, phase, 0)) })
    }

    const rgb = hexToRgb(resolvedColor)
    ctx.beginPath()
    ctx.moveTo(0, line[0].y)
    for (const p of line) ctx.lineTo(p.x, p.y)
    ctx.lineTo(width, height / 2)
    ctx.lineTo(0, height / 2)
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

    // Handles.
    const cardBg = tokenValue('--theme-bg-elevated')
    for (let i = 0; i < pts.length; i++) {
      const px = xOf(pts[i].t)
      const py = yOf(pts[i].v)
      const sel = i === selectedIdx
      ctx.beginPath()
      ctx.arc(px, py, sel ? HANDLE_R + 1.5 : HANDLE_R, 0, Math.PI * 2)
      ctx.fillStyle = sel ? resolvedColor : cardBg
      ctx.fill()
      ctx.strokeStyle = resolvedColor
      ctx.lineWidth = 1.5
      ctx.stroke()
    }
  }, [color, width, height, snapX, snapY, selectedIdx, xOf, yOf, themeEpoch])

  useEffect(() => { draw() }, [draw])

  const hitTest = useCallback((mx, my) => {
    const pts = pointsRef.current
    for (let i = 0; i < pts.length; i++) {
      if (Math.hypot(mx - xOf(pts[i].t), my - yOf(pts[i].v)) <= HANDLE_HIT) return i
    }
    return -1
  }, [xOf, yOf])

  const localXY = useCallback((clientX, clientY) => {
    const c = canvasRef.current
    const rect = c.getBoundingClientRect()
    return [
      (clientX - rect.left) * (width / rect.width),
      (clientY - rect.top) * (height / rect.height),
    ]
  }, [width, height])

  const onMouseDown = useCallback((e) => {
    const c = canvasRef.current
    if (!c) return
    e.preventDefault()
    const [mx, my] = localXY(e.clientX, e.clientY)
    const idx = hitTest(mx, my)

    // Delete: right-button or Alt on a handle (keep at least two points).
    if (idx >= 0 && (e.button === 2 || e.altKey)) {
      const pts = pointsRef.current
      if (pts.length <= 2) return
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
      const pts = pointsRef.current
      const next = pts.map((p) => ({ ...p }))
      const p = next[ds.idx]

      // v is always free (snapped). t is locked to 0 for the first point (it
      // anchors the cycle start); other points move within their neighbours so
      // the list stays sorted and indices stay stable through the drag.
      let v = vOf(my2)
      if (snapY >= 1) v = snapTo(v, snapY, -1, 1)
      p.v = Number(v.toFixed(4))

      if (ds.idx > 0) {
        let t = tOf(mx2)
        if (snapX >= 1) t = snapTo(t, snapX, 0, 1)
        const lo = next[ds.idx - 1].t + 1e-4
        const hi = ds.idx < next.length - 1 ? next[ds.idx + 1].t - 1e-4 : 1
        p.t = Number(Math.max(lo, Math.min(hi, t)).toFixed(4))
      }
      onPreview?.(next)
    }
    const onUp = () => {
      const ds = dragRef.current
      dragRef.current = null
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      if (ds) onCommit?.(pointsRef.current)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }, [hitTest, localXY, onCommit, onPreview, onSelect, snapX, snapY, tOf, vOf])

  const onDoubleClick = useCallback((e) => {
    const c = canvasRef.current
    if (!c) return
    e.preventDefault()
    const pts = pointsRef.current
    if (hitTest(...localXY(e.clientX, e.clientY)) >= 0) return   // dbl-click on a handle: ignore
    if (pts.length >= MAX_LFO_POINTS) return
    const [mx, my] = localXY(e.clientX, e.clientY)
    let t = tOf(mx)
    let v = vOf(my)
    if (snapX >= 1) t = snapTo(t, snapX, 0, 1)
    if (snapY >= 1) v = snapTo(v, snapY, -1, 1)
    const np = { t: Number(t.toFixed(4)), v: Number(v.toFixed(4)), seg: SEG_LINE, tension: 0 }
    const next = [...pts, np].sort((a, b) => a.t - b.t)
    onCommit?.(next)
    onSelect?.(next.indexOf(np))
  }, [hitTest, localXY, onCommit, onSelect, snapX, snapY, tOf, vOf])

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
