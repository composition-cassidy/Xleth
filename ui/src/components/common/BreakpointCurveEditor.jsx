import { useCallback, useEffect, useRef } from 'react'
import { useTokenValue } from '../../theming/tokenValue.ts'
import { useThemeEpoch } from '../../theming/useThemeEpoch.js'
import {
  TV_ADAPTER,
  makeGeometry,
  hitTestPoints,
  movePoint,
  insertPoint,
  removePoint,
} from './breakpointCurveMath.js'

// ── Shared breakpoint curve editor (canvas) ──────────────────────────────────
//
// The one reusable point-editor surface for XLETH. Feature panels supply an
// ADAPTER (point schema), a SAMPLER (how the curve between points is evaluated —
// which must mirror whatever the engine actually plays), and axis/grid
// decoration. Everything else — DPR-aware sizing, geometry, hit-testing, drag /
// add / delete gestures, theme-reactive redraw — lives here so a third feature
// never has to reimplement it.
//
// HARD RULE: this is canvas draw calls end to end. Points, grid, handles and
// hit-testing all live in canvas pixel space. A DOM-overlay handle layer drifts
// against the canvas under scroll/zoom and corrupts hit-testing, so it is never
// used. (Same rule ModShapeCanvas.jsx documents; this component is the shared
// home for it.)
//
// EDIT DISCIPLINE: a drag is LOCAL. Pointer-move streams through onPreview and
// touches no IPC; onCommit fires exactly once, on release — one gesture, one
// undo step. Discrete edits (add / delete) commit immediately, because they are
// already a single gesture.
//
// `editable: false` renders the curve ghosted with no handles and swallows no
// gestures — used when a built-in shape is selected and the breakpoints are not
// the source of truth.
//
// AUXILIARY HANDLES (`handles`) are extra draggable diamonds that are NOT
// breakpoints — the Scratch editor's per-segment tension handles are the first
// user. They are positioned by the feature in curve space, hit-tested BEFORE the
// breakpoints (they sit on the curve, where a stray point-drag would be a much
// worse mistake than a stray tension-drag), and reported back in both curve and
// pixel space so the feature can decide what a drag means. They follow the same
// edit discipline as everything else here: preview during the drag, one commit
// on release.

const HANDLE_R = 4
const HANDLE_HIT = 11
const DIAMOND_R = 3.5
const DIAMOND_HIT = 9

export default function BreakpointCurveEditor({
  points,
  adapter = TV_ADAPTER,
  // (points, adapter, phase) -> value. Defaults to the caller passing a curve
  // it has already decided how to read; supply the engine-faithful evaluator.
  sample,
  width = 432,
  height = 220,
  pad,
  tMin = 0, tMax = 1,
  vMin = -1, vMax = 1,
  editable = true,
  selectedIdx = -1,
  minPoints = 2,
  maxPoints = 64,
  lockEndpoints = false,
  // Decoration
  gridXDivisions = 4,
  gridYValues = [-1, -0.5, 0.5, 1],
  strongGridYValues = [],  // drawn in the axis colour, for values that carry
                           // meaning of their own (Scratch: +1x, 0x, -1x)
  zeroLine = 0,
  xLabels = null,          // [{ t, text }]
  yLabels = null,          // [{ v, text }]
  notes = null,            // [{ v, text, side: 'left' | 'right' }]
  accentToken = '--xleth-flat-accent',
  fillCurve = true,
  // Auxiliary (non-breakpoint) handles, e.g. per-segment tension diamonds.
  handles = null,          // [{ t, v, active?: bool }]
  className,
  ariaLabel,
  onPreview,
  onCommit,
  onSelect,
  onHandlePreview,         // (index, { t, v, px, py, geo }) => void  — no IPC
  onHandleCommit,          // (index) => void  — once, on release
  onHandleReset,           // (index) => void  — right-click / Alt-click
}) {
  const canvasRef = useRef(null)
  const dragRef = useRef(null)
  const themeEpoch = useThemeEpoch()

  // Palette is read through useTokenValue (ThemeContext), NOT tokenValue(:root).
  //
  // ThemeProvider writes :root in a useEffect, and child effects run BEFORE
  // parent effects — so a canvas that reads :root inside its own mount-time draw
  // effect paints an unthemed frame (every token resolves to '', and an invalid
  // fillStyle silently leaves the context black) and never redraws, because
  // nothing re-renders it afterwards. Reading from the context keeps the palette
  // coherent with the render tree and repaints when the theme changes.
  // tokenValue.ts documents this exact hazard. useTokenValue falls back to the
  // :root read when there is no provider, so isolated tests still work.
  const bgInset = useTokenValue('--theme-bg-inset')
  const bgWell = useTokenValue('--xleth-flat-well')
  const gridCol = useTokenValue('--xleth-flat-border')
  const axisCol = useTokenValue('--xleth-flat-border-strong')
  const labelCol = useTokenValue('--xleth-flat-text-muted')
  const ghostCol = useTokenValue('--xleth-flat-text-secondary')
  const handleFill = useTokenValue('--xleth-flat-panel')
  const accentCol = useTokenValue(accentToken)
  const accentFallback = useTokenValue('--theme-accent')

  // Live mirrors so the pointer handlers never close over a stale list.
  const pointsRef = useRef(points)
  pointsRef.current = points
  const handlesRef = useRef(handles)
  handlesRef.current = handles

  const geo = makeGeometry({ width, height, pad, tMin, tMax, vMin, vMax })
  const geoRef = useRef(geo)
  geoRef.current = geo

  const draw = useCallback(() => {
    const c = canvasRef.current
    if (!c) return
    const ctx = c.getContext('2d')
    if (!ctx) return

    const dpr = (typeof window !== 'undefined' && window.devicePixelRatio) || 1
    c.width = Math.max(1, Math.round(width * dpr))
    c.height = Math.max(1, Math.round(height * dpr))
    c.style.width = `${width}px`
    c.style.height = `${height}px`
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)

    const bg = bgInset || bgWell
    const accent = accentCol || accentFallback
    const curveCol = (editable ? accent : ghostCol) || accent

    const g = geoRef.current

    ctx.clearRect(0, 0, width, height)
    if (bg) { ctx.fillStyle = bg; ctx.fillRect(0, 0, width, height) }

    // Grid.
    ctx.lineWidth = 1
    ctx.strokeStyle = gridCol
    for (let i = 0; i <= gridXDivisions; i++) {
      const x = Math.round(g.xOf(tMin + ((tMax - tMin) * i) / gridXDivisions)) + 0.5
      ctx.beginPath(); ctx.moveTo(x, g.top); ctx.lineTo(x, g.plotBottom); ctx.stroke()
    }
    for (const v of gridYValues) {
      const y = Math.round(g.yOf(v)) + 0.5
      ctx.beginPath(); ctx.moveTo(g.left, y); ctx.lineTo(g.plotRight, y); ctx.stroke()
    }

    // Gridlines the feature has singled out as meaningful.
    if (strongGridYValues?.length) {
      ctx.strokeStyle = axisCol
      ctx.setLineDash([4, 4])
      for (const v of strongGridYValues) {
        const y = Math.round(g.yOf(v)) + 0.5
        ctx.beginPath(); ctx.moveTo(g.left, y); ctx.lineTo(g.plotRight, y); ctx.stroke()
      }
      ctx.setLineDash([])
      ctx.strokeStyle = gridCol
    }

    // Zero line, drawn stronger than the grid.
    if (zeroLine != null) {
      const y = Math.round(g.yOf(zeroLine)) + 0.5
      ctx.strokeStyle = axisCol
      ctx.beginPath(); ctx.moveTo(g.left, y); ctx.lineTo(g.plotRight, y); ctx.stroke()
    }

    // Axis labels and in-plot notes.
    if (labelCol && (xLabels || yLabels || notes)) {
      ctx.fillStyle = labelCol
      ctx.font = '10px "Cascadia Mono", Consolas, monospace'
      if (yLabels) {
        ctx.textAlign = 'right'
        for (const { v, text } of yLabels) ctx.fillText(text, g.left - 4, g.yOf(v) + 3)
      }
      if (xLabels) {
        ctx.textAlign = 'center'
        for (const { t, text } of xLabels) ctx.fillText(text, g.xOf(t), height - 4)
      }
      if (notes) {
        for (const { v, text, side } of notes) {
          ctx.textAlign = side === 'left' ? 'left' : 'right'
          const x = side === 'left' ? g.left + 4 : g.plotRight - 4
          ctx.fillText(text, x, g.yOf(v) + 3)
        }
      }
      ctx.textAlign = 'start'
    }

    // Curve, sampled once per pixel column through the feature's evaluator so
    // what is drawn is what the engine will play.
    const pts = pointsRef.current
    const columns = Math.max(2, Math.round(g.plotW))
    const line = new Array(columns + 1)
    for (let i = 0; i <= columns; i++) {
      const t = tMin + ((tMax - tMin) * i) / columns
      const v = sample ? sample(pts, adapter, t) : 0
      line[i] = [g.left + (i / columns) * g.plotW, g.yOf(Number.isFinite(v) ? v : 0)]
    }

    if (fillCurve && editable && accent) {
      ctx.beginPath()
      ctx.moveTo(line[0][0], line[0][1])
      for (let i = 1; i <= columns; i++) ctx.lineTo(line[i][0], line[i][1])
      ctx.lineTo(g.plotRight, g.yOf(zeroLine ?? 0))
      ctx.lineTo(g.left, g.yOf(zeroLine ?? 0))
      ctx.closePath()
      ctx.globalAlpha = 0.09
      ctx.fillStyle = accent
      ctx.fill()
      ctx.globalAlpha = 1
    }

    ctx.beginPath()
    ctx.moveTo(line[0][0], line[0][1])
    for (let i = 1; i <= columns; i++) ctx.lineTo(line[i][0], line[i][1])
    ctx.strokeStyle = curveCol
    ctx.lineWidth = 1.5
    if (!editable) ctx.globalAlpha = 0.75
    ctx.stroke()
    ctx.globalAlpha = 1

    // Handles — only when the breakpoints are the live source of truth.
    if (!editable || !Array.isArray(pts)) return

    // Auxiliary diamonds first, so a breakpoint handle overlapping one is drawn
    // on top — matching the hit-test order being the other way round is
    // deliberate: the diamond sits ON the curve and is the easier target to
    // grab by accident, so it wins the pointer but loses the paint.
    if (Array.isArray(handlesRef.current)) {
      for (const h of handlesRef.current) {
        if (!h) continue
        const on = Boolean(h.active)
        ctx.save()
        ctx.translate(g.xOf(h.t), g.yOf(h.v))
        ctx.rotate(Math.PI / 4)
        ctx.fillStyle = handleFill
        ctx.strokeStyle = on ? accent : ghostCol
        ctx.lineWidth = 1.5
        ctx.fillRect(-DIAMOND_R, -DIAMOND_R, DIAMOND_R * 2, DIAMOND_R * 2)
        ctx.strokeRect(-DIAMOND_R, -DIAMOND_R, DIAMOND_R * 2, DIAMOND_R * 2)
        ctx.restore()
      }
    }

    for (let i = 0; i < pts.length; i++) {
      const { t, v } = adapter.read(pts[i])
      const px = g.xOf(t)
      const py = g.yOf(v)
      const sel = i === selectedIdx
      ctx.beginPath()
      ctx.arc(px, py, sel ? HANDLE_R + 1.5 : HANDLE_R, 0, Math.PI * 2)
      ctx.fillStyle = handleFill
      ctx.fill()
      ctx.lineWidth = 2
      ctx.strokeStyle = accent
      ctx.stroke()
      if (sel) {
        ctx.beginPath()
        ctx.arc(px, py, 2, 0, Math.PI * 2)
        ctx.fillStyle = accent
        ctx.fill()
      }
    }
  }, [
    width, height, editable, selectedIdx, adapter, sample,
    gridXDivisions, gridYValues, strongGridYValues, zeroLine,
    xLabels, yLabels, notes, fillCurve, handles,
    tMin, tMax, vMin, vMax, themeEpoch,
    bgInset, bgWell, gridCol, axisCol, labelCol, ghostCol, handleFill,
    accentCol, accentFallback,
  ])

  useEffect(() => { draw() })

  // Convert a client-space event into canvas-local pixels. Uses the element's
  // rendered rect so CSS scaling never skews hit-testing.
  const localXY = useCallback((clientX, clientY) => {
    const c = canvasRef.current
    if (!c) return [0, 0]
    const rect = c.getBoundingClientRect()
    const sx = rect.width ? width / rect.width : 1
    const sy = rect.height ? height / rect.height : 1
    return [(clientX - rect.left) * sx, (clientY - rect.top) * sy]
  }, [width, height])

  const onPointerDown = useCallback((e) => {
    if (!editable) return
    const [mx, my] = localXY(e.clientX, e.clientY)
    const pts = pointsRef.current

    // Auxiliary diamonds win the pointer: they sit on the curve, so letting a
    // breakpoint steal the grab would move a point the user meant to bend.
    const aux = handlesRef.current
    if (Array.isArray(aux) && aux.length) {
      const g0 = geoRef.current
      let hIdx = -1
      let hBest = DIAMOND_HIT
      for (let i = 0; i < aux.length; i++) {
        const h = aux[i]
        if (!h) continue
        const d = Math.hypot(mx - g0.xOf(h.t), my - g0.yOf(h.v))
        if (d <= hBest) { hBest = d; hIdx = i }
      }
      if (hIdx >= 0) {
        if (e.button === 2 || e.altKey) { onHandleReset?.(hIdx); return }
        if (e.button !== 0) return
        e.preventDefault()
        let moved = false
        const onHMove = (ev) => {
          const [hx, hy] = localXY(ev.clientX, ev.clientY)
          const g = geoRef.current
          moved = true
          // LOCAL only — no IPC while the pointer is down.
          onHandlePreview?.(hIdx, { t: g.tOf(hx), v: g.vOf(hy), px: hx, py: hy, geo: g })
        }
        const onHUp = () => {
          window.removeEventListener('pointermove', onHMove)
          window.removeEventListener('pointerup', onHUp)
          if (moved) onHandleCommit?.(hIdx)
        }
        window.addEventListener('pointermove', onHMove)
        window.addEventListener('pointerup', onHUp)
        return
      }
    }

    const idx = hitTestPoints(pts, adapter, geoRef.current, mx, my, HANDLE_HIT)

    // Delete: right button or Alt on a handle. Discrete — commits immediately.
    if (idx >= 0 && (e.button === 2 || e.altKey)) {
      const next = removePoint(pts, idx, { minPoints })
      if (next) { onSelect?.(-1); onCommit?.(next) }
      return
    }
    if (e.button !== 0) return
    if (idx < 0) return

    e.preventDefault()
    onSelect?.(idx)
    // `latest` is the drag's own authority on the current shape. It must NOT be
    // read back from pointsRef on release: the preview round-trips through a
    // store and a React render, so a fast drag (or a batch of pointermoves in
    // one task) can reach pointerup before the prop has caught up, and
    // committing pointsRef there would silently save the PRE-drag shape.
    dragRef.current = { idx, moved: false, latest: pointsRef.current }

    const onMove = (ev) => {
      const drag = dragRef.current
      if (!drag) return
      const [mx2, my2] = localXY(ev.clientX, ev.clientY)
      const g = geoRef.current
      const next = movePoint(
        drag.latest, adapter, drag.idx, g.tOf(mx2), g.vOf(my2), { lockEndpoints },
      )
      drag.latest = next
      drag.moved = true
      // LOCAL only — no IPC while the pointer is down.
      onPreview?.(next)
    }
    const onUp = () => {
      const drag = dragRef.current
      dragRef.current = null
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      // One gesture => one commit => one undo step.
      if (drag?.moved) onCommit?.(drag.latest)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }, [
    editable, localXY, adapter, minPoints, lockEndpoints,
    onCommit, onPreview, onSelect,
    onHandlePreview, onHandleCommit, onHandleReset,
  ])

  const onDoubleClick = useCallback((e) => {
    if (!editable) return
    const [mx, my] = localXY(e.clientX, e.clientY)
    const pts = pointsRef.current
    // A double-click ON a handle — breakpoint or auxiliary — is not an insert.
    if (hitTestPoints(pts, adapter, geoRef.current, mx, my, HANDLE_HIT) >= 0) return
    if (Array.isArray(handlesRef.current)) {
      const g0 = geoRef.current
      for (const h of handlesRef.current) {
        if (h && Math.hypot(mx - g0.xOf(h.t), my - g0.yOf(h.v)) <= DIAMOND_HIT) return
      }
    }
    e.preventDefault()
    const g = geoRef.current
    const { points: next, index } = insertPoint(pts, adapter, g.tOf(mx), g.vOf(my), { maxPoints })
    if (index < 0) return
    onSelect?.(index)
    onCommit?.(next)
  }, [editable, localXY, adapter, maxPoints, onCommit, onSelect])

  return (
    <canvas
      ref={canvasRef}
      className={className}
      role="img"
      aria-label={ariaLabel}
      data-editable={editable ? 'true' : 'false'}
      onPointerDown={onPointerDown}
      onDoubleClick={onDoubleClick}
      onContextMenu={(e) => e.preventDefault()}
      style={{ display: 'block', cursor: editable ? 'crosshair' : 'default' }}
    />
  )
}
