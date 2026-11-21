import React, { useCallback, useEffect, useRef } from 'react'
import { formatValue } from '../../ui-kit'
import { useDprEpoch } from '../../ui-kit/dpr'
import { useThemeEpoch } from '../../theming/useThemeEpoch.js'
import { uiCanvasFont } from '../../styles/typography.js'
import {
  MAX_POINTS, MIN_POINTS, clamp, curveSamples, applySnap, isEndPoint, clampBetweenNeighbours,
} from './waveshaperCurve.js'

// The Waveshaper's hero: the transfer curve as an editable canvas. Same
// mechanics as the editor's SVG, redrawn on canvas:
//
//   click empty      add a point (up to 32)
//   drag a point     move it; the curve follows locally, one write on release
//   right-click      remove a point (never below two)
//   Snap zero        pulls a coordinate onto 0 near it; Lock ends pins the end points
//   Show input       the out = in diagonal;  Smooth curve   spline or straight segments
//
// Added for the Floor (every drag has an alternative): the canvas takes focus,
// [ and ] step through the points, the arrow keys nudge the selected one (Shift
// for 0.1), Delete removes it, and the Point section types exact values.
// A dragged point stays between its neighbours so it never swaps places with one.
// tokenValue() is never called; colours are read from the canvas's own style.

const PAD = { l: 26, r: 10, t: 10, b: 20 }
const HIT_PX = 12
const CLICK_SLOP_PX = 4
const NUDGE = 0.01
const TICKS = [-1, -0.5, 0, 0.5, 1]
const tick = (v) => formatValue(v, 'dB', { unitless: true, decimals: v === 0 || Math.abs(v) === 1 ? 0 : 1, signed: v > 0 })

function readColors(el) {
  const cs = typeof getComputedStyle === 'function' ? getComputedStyle(el) : null
  const get = (name, fb) => cs?.getPropertyValue(name)?.trim() || fb
  return {
    ground: get('--ui-g0', '#141414'),
    grid: get('--ui-g4', '#3A3A3A'),
    zero: get('--ui-boundary', '#747474'),
    text: get('--ui-ink-3', '#929292'),
    ink: get('--ui-ink', '#E6E6E6'),
    ink2: get('--ui-ink-2', '#B4B4B4'),
    value: get('--ui-value', '#33CED6'),
  }
}

// The plot is the largest square the canvas holds, centred; the axes are [-1, 1].
function geometry(w, h) {
  const size = Math.max(10, Math.min(w - PAD.l - PAD.r, h - PAD.t - PAD.b))
  const x0 = PAD.l + Math.max(0, (w - PAD.l - PAD.r - size) / 2)
  const y0 = PAD.t
  return {
    size, x0, y0,
    xOf: (a) => x0 + ((clamp(a, -1, 1) + 1) / 2) * size,
    yOf: (a) => y0 + (1 - (clamp(a, -1, 1) + 1) / 2) * size,
    ax: (px) => clamp(((px - x0) / size) * 2 - 1, -1, 1),
    ay: (py) => clamp(1 - ((py - y0) / size) * 2, -1, 1),
  }
}

export default function WaveshaperCurveCanvas({
  points, selectedIndex, flags, onSelect, onPreview, onCommit, onAdd, onRemove,
}) {
  const canvasRef = useRef(null)
  const themeEpoch = useThemeEpoch()
  const dprEpoch = useDprEpoch()
  const dragRef = useRef(null)
  const propsRef = useRef(null)
  propsRef.current = { points, selectedIndex, flags, onSelect, onPreview, onCommit, onAdd, onRemove }

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
    const g = geometry(cssW, cssH)
    const { points: pts, selectedIndex: sel, flags: f } = propsRef.current

    ctx.fillStyle = c.ground
    ctx.fillRect(0, 0, cssW, cssH)

    ctx.lineWidth = 1
    for (const a of TICKS) {
      const gx = Math.round(g.xOf(a)) + 0.5
      const gy = Math.round(g.yOf(a)) + 0.5
      ctx.strokeStyle = a === 0 ? c.zero : c.grid
      ctx.beginPath()
      ctx.moveTo(gx, g.y0); ctx.lineTo(gx, g.y0 + g.size)
      ctx.moveTo(g.x0, gy); ctx.lineTo(g.x0 + g.size, gy)
      ctx.stroke()
    }
    ctx.font = uiCanvasFont('10px')
    ctx.fillStyle = c.text
    ctx.textBaseline = 'top'
    ctx.textAlign = 'center'
    for (const a of [-1, 0, 1]) ctx.fillText(tick(a), g.xOf(a), g.y0 + g.size + 4)
    ctx.textBaseline = 'middle'
    ctx.textAlign = 'right'
    for (const a of [-1, 0, 1]) ctx.fillText(tick(a), g.x0 - 4, g.yOf(a))
    ctx.textAlign = 'left'
    ctx.textBaseline = 'top'
    ctx.fillText('Out', g.x0 + 4, g.y0 + 3)
    ctx.textAlign = 'right'
    ctx.textBaseline = 'bottom'
    ctx.fillText('In', g.x0 + g.size - 4, g.y0 + g.size - 3)

    if (f.showInput) {
      ctx.save()
      ctx.setLineDash([2, 4])
      ctx.strokeStyle = c.ink2
      ctx.globalAlpha = 0.6
      ctx.beginPath()
      ctx.moveTo(g.xOf(-1), g.yOf(-1)); ctx.lineTo(g.xOf(1), g.yOf(1))
      ctx.stroke()
      ctx.restore()
    }

    const samples = curveSamples(pts, f.smoothCurve)
    if (samples.length >= 2) {
      ctx.beginPath()
      samples.forEach(([x, y], i) => { if (i === 0) ctx.moveTo(g.xOf(x), g.yOf(y)); else ctx.lineTo(g.xOf(x), g.yOf(y)) })
      ctx.lineJoin = 'round'
      ctx.strokeStyle = c.value
      ctx.lineWidth = 2
      ctx.stroke()
    }

    // Points on top: selected = filled, a locked end = a square, the rest ringed circles.
    pts.forEach(([x, y], i) => {
      const px = g.xOf(x)
      const py = g.yOf(y)
      const selected = i === sel
      const locked = f.lockEnds && isEndPoint(pts, i)
      const r = selected ? 6 : 4.5
      ctx.beginPath()
      if (locked) ctx.rect(px - r, py - r, r * 2, r * 2); else ctx.arc(px, py, r, 0, 2 * Math.PI)
      ctx.fillStyle = selected ? c.value : c.ground
      ctx.fill()
      ctx.lineWidth = 2
      ctx.strokeStyle = locked ? c.ink2 : (selected ? c.ink : c.value)
      ctx.stroke()
    })
  }, [])

  useEffect(() => { paint() }, [paint, points, selectedIndex, flags, themeEpoch, dprEpoch])
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || typeof ResizeObserver === 'undefined') return undefined
    const ro = new ResizeObserver(() => paint())
    ro.observe(canvas)
    return () => ro.disconnect()
  }, [paint])

  const local = (e) => {
    const r = canvasRef.current.getBoundingClientRect()
    return { x: e.clientX - r.left, y: e.clientY - r.top, w: r.width, h: r.height }
  }

  const hitIndex = (x, y, w, h) => {
    const g = geometry(w, h)
    const { points: pts } = propsRef.current
    let best = -1
    let bestD = HIT_PX
    pts.forEach(([px, py], i) => {
      const d = Math.hypot(g.xOf(px) - x, g.yOf(py) - y)
      if (d <= bestD) { best = i; bestD = d }
    })
    return best
  }

  const valueAt = (drag, x, y, w, h) => {
    const g = geometry(w, h)
    const { points: pts, flags } = propsRef.current
    let [vx, vy] = applySnap(g.ax(x), g.ay(y), flags.snapZero)
    vx = clampBetweenNeighbours(pts, drag.index, vx)
    return [vx, vy]
  }

  const onPointerDown = (e) => {
    const { x, y, w, h } = local(e)
    canvasRef.current.focus({ preventScroll: true })
    const i = hitIndex(x, y, w, h)
    const { points: pts, flags } = propsRef.current
    if (e.button === 2) {
      e.preventDefault()
      if (i >= 0 && pts.length > MIN_POINTS && !(flags.lockEnds && isEndPoint(pts, i))) propsRef.current.onRemove?.(i)
      return
    }
    if (e.button !== 0) return
    if (i >= 0) {
      propsRef.current.onSelect?.(i)
      if (!(flags.lockEnds && isEndPoint(pts, i))) {
        dragRef.current = { kind: 'move', index: i, orig: pts[i], moved: false }
        canvasRef.current.setPointerCapture?.(e.pointerId)
      }
      e.preventDefault()
      return
    }
    dragRef.current = { kind: 'add', x, y }
    canvasRef.current.setPointerCapture?.(e.pointerId)
  }

  const onPointerMove = (e) => {
    const canvas = canvasRef.current
    const { x, y, w, h } = local(e)
    const drag = dragRef.current
    if (!drag) {
      const { points: pts, flags } = propsRef.current
      const i = hitIndex(x, y, w, h)
      canvas.style.cursor = i < 0 ? 'crosshair' : (flags.lockEnds && isEndPoint(pts, i) ? 'default' : 'grab')
      return
    }
    if (drag.kind !== 'move') return
    drag.moved = true
    const [vx, vy] = valueAt(drag, x, y, w, h)
    propsRef.current.onPreview?.(drag.index, vx, vy)
  }

  const endDrag = (e) => {
    const canvas = canvasRef.current
    const drag = dragRef.current
    dragRef.current = null
    if (e?.pointerId != null && canvas?.hasPointerCapture?.(e.pointerId)) canvas.releasePointerCapture(e.pointerId)
    if (!drag) return
    const { x, y, w, h } = local(e)
    if (e.type !== 'pointerup') {
      if (drag.kind === 'move') propsRef.current.onPreview?.(drag.index, drag.orig[0], drag.orig[1])
      return
    }
    if (drag.kind === 'move') {
      // A click that only selects a point writes nothing.
      if (!drag.moved) return
      const [vx, vy] = valueAt(drag, x, y, w, h)
      propsRef.current.onCommit?.(drag.index, vx, vy)
      return
    }
    // A press that barely moved on empty ground adds a point there.
    if (Math.hypot(x - drag.x, y - drag.y) <= CLICK_SLOP_PX && propsRef.current.points.length < MAX_POINTS) {
      const g = geometry(w, h)
      const [vx, vy] = applySnap(g.ax(x), g.ay(y), propsRef.current.flags.snapZero)
      propsRef.current.onAdd?.(vx, vy)
    }
  }

  const onKeyDown = (e) => {
    const { points: pts, selectedIndex: sel, flags } = propsRef.current
    if (e.key === 'Escape' && dragRef.current?.kind === 'move') {
      const drag = dragRef.current
      dragRef.current = null
      propsRef.current.onPreview?.(drag.index, drag.orig[0], drag.orig[1])
      e.preventDefault()
      return
    }
    if (e.key === '[' || e.key === ']') {
      if (pts.length === 0) return
      propsRef.current.onSelect?.((Math.max(0, sel) + (e.key === ']' ? 1 : -1) + pts.length) % pts.length)
      e.preventDefault()
      return
    }
    const pt = pts[sel]
    if (!pt) return
    const locked = flags.lockEnds && isEndPoint(pts, sel)
    if (e.key === 'Delete' || e.key === 'Backspace') {
      if (pts.length > MIN_POINTS && !locked) propsRef.current.onRemove?.(sel)
      e.preventDefault()
      return
    }
    if (!/^Arrow(Left|Right|Up|Down)$/.test(e.key) || locked) return
    const step = e.shiftKey ? NUDGE * 10 : NUDGE
    let [vx, vy] = pt
    if (e.key === 'ArrowLeft') vx -= step
    if (e.key === 'ArrowRight') vx += step
    if (e.key === 'ArrowUp') vy += step
    if (e.key === 'ArrowDown') vy -= step
    vx = clampBetweenNeighbours(pts, sel, clamp(vx, -1, 1))
    propsRef.current.onCommit?.(sel, vx, clamp(vy, -1, 1))
    e.preventDefault()
  }

  const count = points.length
  return (
    <canvas
      ref={canvasRef}
      role="application"
      aria-label={`Waveshaper curve, ${count} points. Click to add a point, drag to move, right-click or Delete to remove, `
        + 'arrow keys nudge the selected point, [ and ] select a point.'}
      tabIndex={0}
      data-hint="Click: add a point · Drag: move · Right-click or Delete: remove · Arrows: nudge · [ ]: select"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onKeyDown={onKeyDown}
      onContextMenu={(e) => e.preventDefault()}
    />
  )
}
