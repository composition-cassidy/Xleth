import { useRef, useEffect, useCallback, useMemo } from 'react'
import { useThemeEpoch } from '../../../theming/useThemeEpoch.js'
import { evalLfoShape } from './modEval.js'
import { SEG_LINE, MAX_LFO_POINTS } from './modConstants.js'
import {
  HANDLE_HIT, RULER_H, drawHandle, drawTag, drawTicks, hLine, palette, prepCanvas, rgba,
} from './modCanvas.js'

// ── LFO shape point editor (canvas only) ─────────────────────────────────────
// A controlled canvas over the engine's `{t, v, seg, tension}[]` shape: ONE cycle,
// on a phase ruler (0, 1/4, 1/2, 3/4, and how long the cycle lasts) and a value
// axis (+1, 0, −1). Drawing goes through evalLfoShape so Step / Line / Curve
// segments and the cyclic wrap look EXACTLY like the audio thread renders them.
// How the cycle plays out in time (rate, delay, rise) is the strip under it
// (LfoTimeline): this canvas is the shape, that one is the scale.
//
// Canvas-drawn end to end: points, grid, handles and hit-testing all live in
// canvas pixel space, so nothing drifts when the panel scrolls.
//
// Interactions:
//   drag handle          move the point (t clamped between neighbours, v in ±1)
//   double-click empty   add a point (Line segment) at the cursor
//   right / alt click    delete a point (keeps a minimum of two)
//   click handle         select it (segment tools + tension act on the selection)
//
// Edits are LOCAL until mouseup: a drag streams through onPreview; onCommit
// fires once, on release. Discrete edits (add / delete) commit immediately.

const PAD_L = 30
const PAD_R = 10
const PAD_T = 8
const PAD_B = 8

function snapTo(value, divisions, lo, hi) {
  if (!divisions || divisions < 1) return value
  const span = hi - lo
  const step = span / divisions
  const snapped = lo + Math.round((value - lo) / step) * step
  return Math.max(lo, Math.min(hi, snapped))
}

const PHASE_LABELS = { 0: '0', 1: '1/4', 2: '1/2', 3: '3/4' }
const signed2 = (v) => `${v > 0 ? '+' : (v < 0 ? '−' : '')}${Math.abs(v).toFixed(2)}`

export default function ModShapeCanvas({
  points,
  selectedIdx = -1,
  snapX = 0,
  snapY = 0,
  color,
  width = 460,
  height = 150,
  cycleText = '',
  onPreview,
  onCommit,
  onSelect,
}) {
  const canvasRef = useRef(null)
  const dragRef = useRef(null)
  const themeEpoch = useThemeEpoch()
  const pointsRef = useRef(points)
  pointsRef.current = points

  const box = useMemo(() => ({
    x: PAD_L, y: RULER_H + PAD_T,
    w: Math.max(20, width - PAD_L - PAD_R),
    h: Math.max(20, height - RULER_H - PAD_T - PAD_B),
  }), [width, height])

  const xOf = useCallback((t) => box.x + t * box.w, [box])
  const yOf = useCallback((v) => box.y + box.h / 2 - v * (box.h / 2), [box])
  const tOf = useCallback((px) => Math.max(0, Math.min(1, (px - box.x) / box.w)), [box])
  const vOf = useCallback((py) => Math.max(-1, Math.min(1, (box.y + box.h / 2 - py) / (box.h / 2))), [box])

  const draw = useCallback(() => {
    const c = canvasRef.current
    if (!c) return
    const ctx = prepCanvas(c, width, height)
    const pal = palette(color)
    const right = box.x + box.w
    const bottom = box.y + box.h

    ctx.fillStyle = pal.bg
    ctx.fillRect(0, 0, width, height)
    ctx.fillStyle = pal.header
    ctx.fillRect(0, 0, width, RULER_H)

    // Snap grid (faint), under the quarter-cycle ruler lines.
    ctx.lineWidth = 1
    ctx.strokeStyle = pal.faint
    if (snapX >= 1) {
      for (let i = 1; i < snapX; i++) {
        const x = Math.round(xOf(i / snapX)) + 0.5
        ctx.beginPath(); ctx.moveTo(x, box.y); ctx.lineTo(x, bottom); ctx.stroke()
      }
    }
    if (snapY >= 1) {
      for (let i = 1; i < snapY; i++) hLine(ctx, box.y + (i / snapY) * box.h, box.x, right)
    }

    // Phase ruler: quarters of one cycle, and how long that cycle lasts.
    const ticks = []
    for (let i = 0; i <= 8; i++) {
      ticks.push({ x: xOf(i / 8), major: i % 2 === 0, label: i % 2 === 0 && i < 8 ? PHASE_LABELS[i / 2] : '' })
    }
    drawTicks(ctx, pal, ticks, { rulerY: 0, plotY0: box.y, plotY1: bottom, clipX0: box.x, clipX1: right })
    ctx.font = pal.font
    ctx.textBaseline = 'middle'
    if (cycleText) {
      ctx.fillStyle = pal.ink2
      ctx.textAlign = 'right'
      ctx.fillText(cycleText, right, RULER_H / 2 - 1)
    }

    // Value axis: +1, 0, −1.
    ctx.textAlign = 'right'
    for (const [v, text] of [[1, '+1'], [0, '0'], [-1, '−1']]) {
      ctx.strokeStyle = pal.line
      hLine(ctx, yOf(v), box.x, right)
      ctx.fillStyle = pal.ink2
      ctx.fillText(text, box.x - 5, yOf(v))
    }

    const pts = pointsRef.current
    if (!Array.isArray(pts) || pts.length === 0) return

    // Shape, sampled through the engine evaluator (smooth = 0: the editor shows
    // the raw editable shape). Flat fill to the zero line.
    const n = Math.max(2, Math.round(box.w))
    ctx.beginPath()
    ctx.moveTo(box.x, yOf(0))
    for (let i = 0; i <= n; i++) ctx.lineTo(box.x + (i / n) * box.w, yOf(evalLfoShape(pts, i / n, 0)))
    ctx.lineTo(right, yOf(0))
    ctx.closePath()
    ctx.fillStyle = rgba(pal.signal, 0.14)
    ctx.fill()

    ctx.beginPath()
    ctx.strokeStyle = pal.signal
    ctx.lineWidth = 1.5
    ctx.lineJoin = 'round'
    for (let i = 0; i <= n; i++) {
      const x = box.x + (i / n) * box.w
      const y = yOf(evalLfoShape(pts, i / n, 0))
      if (i === 0) ctx.moveTo(x, y)
      else ctx.lineTo(x, y)
    }
    ctx.stroke()

    for (let i = 0; i < pts.length; i++) {
      drawHandle(ctx, pal, xOf(pts[i].t), yOf(pts[i].v), { active: i === selectedIdx })
    }
    // The selected point's position, printed: phase as a share of the cycle, value ±1.
    const sel = pts[selectedIdx]
    if (sel) {
      drawTag(ctx, pal, `${Math.round(sel.t * 100)} % · ${signed2(sel.v)}`, xOf(sel.t), yOf(sel.v), box)
    }
  }, [color, width, height, box, snapX, snapY, selectedIdx, cycleText, xOf, yOf, themeEpoch])

  // `points` is read through a ref inside draw, so it is a dependency here.
  useEffect(() => { draw() }, [draw, points])

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
      (clientX - rect.left) * (width / (rect.width || width)),
      (clientY - rect.top) * (height / (rect.height || height)),
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
      role="img"
      aria-label="LFO shape, one cycle"
      onMouseDown={onMouseDown}
      onDoubleClick={onDoubleClick}
      onContextMenu={(e) => e.preventDefault()}
      style={{ display: 'block', cursor: 'crosshair', width, height }}
    />
  )
}
