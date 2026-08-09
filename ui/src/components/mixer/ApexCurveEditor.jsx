import React, { useCallback, useEffect, useRef, useState } from 'react'
import { tokenValue } from '../../theming/tokenValue.ts'
import { useThemeEpoch } from '../../theming/useThemeEpoch.js'
import useApexStore from '../../stores/apexStore.js'
import { BAND_NAMES } from '../../stores/apexStore.js'
import {
  CURVE_MIN_DB, CURVE_MAX_DB, MAX_NODES, clamp,
  evalCurveAt, tensionWarp,
  inDbToX, xToInDb, outDbToY, yToOutDb, segmentHandlePoint,
} from './apexGeometry.js'

// APEX curve editor — canvas-drawn transfer-curve editor for the selected band.
//
// Canvas discipline (spec 7.1): everything is drawn to a single <canvas>; there
// are NO DOM overlays over it, and every hit-test is done in canvas pixel
// coordinates. Drag discipline: node/tension drags preview locally (React state
// held in THIS component, so knob rows don't re-render per move) and never touch
// IPC; the store commit — a single apexSetBandCurve + one undo entry — fires
// once on pointer-up.
//
// Editing (spec 4.3): drag a node to move it, double-click empty space to add a
// node, right-click a node to delete it, drag or wheel a segment handle to set
// that segment's tension. End nodes pin the ends (their input is fixed at the
// box edges); interior nodes move on both axes between their neighbours.

const PAD_L = 30
const PAD_R = 12
const PAD_T = 12
const PAD_B = 18
const NODE_HIT_R = 11
const HANDLE_HIT_R = 9
const MIN_IN_GAP = 0.25   // dB — keeps nodes strictly increasing in input
const CURVE_SAMPLES = 160

// Last-resort canvas fallbacks (tokens are the source of truth; these only
// apply before ThemeProvider has written :root, matching the Knob/visualizer
// canvas convention where a raw color is unavoidable).
function readColors(el) {
  const get = (name, fb) => {
    const inherited = el && typeof getComputedStyle === 'function'
      ? getComputedStyle(el).getPropertyValue(name).trim()
      : ''
    return inherited || tokenValue(name) || fb
  }
  return {
    bg:       get('--theme-bg-inset', '#111318'),
    grid:     get('--xleth-flat-border', 'rgba(255,255,255,0.10)'),
    gridZero: get('--xleth-flat-text-muted', 'rgba(255,255,255,0.28)'),
    unity:    get('--xleth-flat-text-muted', 'rgba(255,255,255,0.22)'),
    accent:   get('--theme-accent', '#fe589a'),
    text:     get('--xleth-flat-text-muted', 'rgba(255,255,255,0.55)'),
    nodeStroke: get('--theme-bg-inset', '#111318'),
  }
}

function withAlpha(color, alpha) {
  const v = String(color || '').trim()
  const hex = v.match(/^#([0-9a-f]{6})$/i)
  if (hex) {
    const n = parseInt(hex[1], 16)
    return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`
  }
  const rgb = v.match(/^rgba?\(([^)]+)\)/i)
  if (rgb) {
    const parts = rgb[1].split(',').map(s => s.trim())
    return `rgba(${parts[0]}, ${parts[1]}, ${parts[2]}, ${alpha})`
  }
  return v
}

export default function ApexCurveEditor() {
  const band = useApexStore(s => s.selectedBand)
  const storeCurve = useApexStore(s => s.curves[s.selectedBand])
  const previewCurve = useApexStore(s => s.previewCurve)
  const commitCurve = useApexStore(s => s.commitCurve)
  const snapshotCurve = useApexStore(s => s.snapshotCurve)
  const themeEpoch = useThemeEpoch()

  const canvasRef = useRef(null)
  const [dims, setDims] = useState({ w: 0, h: 0 })
  // Local drag preview: null when idle, else the in-flight curve. Draw source of
  // truth = local ?? store, so only THIS component repaints during a drag.
  const [local, setLocal] = useState(null)
  const dragRef = useRef(null)   // { kind, index/seg, before, ... }

  const effectiveCurve = local ?? storeCurve

  // Keep a ref to the latest curve so the ResizeObserver's draw sees it.
  const curveRef = useRef(effectiveCurve)
  curveRef.current = effectiveCurve

  const plotOf = useCallback((cssW, cssH) => ({
    x: PAD_L, y: PAD_T, w: Math.max(1, cssW - PAD_L - PAD_R), h: Math.max(1, cssH - PAD_T - PAD_B),
  }), [])

  const draw = useCallback(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const cssW = canvas.clientWidth || 0
    const cssH = canvas.clientHeight || 0
    if (cssW <= 0 || cssH <= 0) return
    const dpr = Math.max(1, window.devicePixelRatio || 1)
    const tw = Math.round(cssW * dpr)
    const th = Math.round(cssH * dpr)
    if (canvas.width !== tw || canvas.height !== th) { canvas.width = tw; canvas.height = th }
    const ctx = canvas.getContext('2d', { alpha: false })
    if (!ctx) return
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)

    const c = readColors(canvas)
    const plot = plotOf(cssW, cssH)
    const curve = curveRef.current

    // Background
    ctx.fillStyle = c.bg
    ctx.fillRect(0, 0, cssW, cssH)

    // Grid — dB lines at -24, -12, 0, +12 on both axes.
    const lines = [-24, -12, 0, 12]
    ctx.lineWidth = 1
    ctx.font = '9px system-ui, sans-serif'
    ctx.textBaseline = 'middle'
    for (const db of lines) {
      const y = outDbToY(db, plot)
      ctx.strokeStyle = db === 0 ? c.gridZero : c.grid
      ctx.beginPath(); ctx.moveTo(plot.x, y + 0.5); ctx.lineTo(plot.x + plot.w, y + 0.5); ctx.stroke()
      ctx.fillStyle = c.text
      ctx.textAlign = 'right'
      ctx.fillText(db > 0 ? `+${db}` : `${db}`, plot.x - 4, y)
      const x = inDbToX(db, plot)
      ctx.strokeStyle = db === 0 ? c.gridZero : c.grid
      ctx.beginPath(); ctx.moveTo(x + 0.5, plot.y); ctx.lineTo(x + 0.5, plot.y + plot.h); ctx.stroke()
    }

    // Unity reference diagonal (out == in).
    ctx.strokeStyle = withAlpha(c.unity, 0.6)
    ctx.setLineDash([3, 3])
    ctx.beginPath()
    ctx.moveTo(inDbToX(CURVE_MIN_DB, plot), outDbToY(CURVE_MIN_DB, plot))
    ctx.lineTo(inDbToX(CURVE_MAX_DB, plot), outDbToY(CURVE_MAX_DB, plot))
    ctx.stroke()
    ctx.setLineDash([])

    // Transfer curve (sampled through the exact engine evaluator).
    ctx.strokeStyle = c.accent
    ctx.lineWidth = 2
    ctx.lineJoin = 'round'
    ctx.beginPath()
    for (let i = 0; i <= CURVE_SAMPLES; i++) {
      const inDb = CURVE_MIN_DB + (i / CURVE_SAMPLES) * (CURVE_MAX_DB - CURVE_MIN_DB)
      const outDb = clamp(evalCurveAt(curve, inDb), CURVE_MIN_DB, CURVE_MAX_DB)
      const x = inDbToX(inDb, plot)
      const y = outDbToY(outDb, plot)
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y)
    }
    ctx.stroke()

    // Segment tension handles (small diamonds riding the curve midpoints).
    for (let seg = 0; seg < curve.nodes.length - 1; seg++) {
      const h = segmentHandlePoint(curve, seg, plot)
      const tension = curve.tensions[seg] ?? 0
      const active = Math.abs(tension) > 1e-3
      ctx.fillStyle = active ? c.accent : withAlpha(c.accent, 0.35)
      ctx.strokeStyle = c.nodeStroke
      ctx.lineWidth = 1
      ctx.beginPath()
      ctx.moveTo(h.x, h.y - 3.5)
      ctx.lineTo(h.x + 3.5, h.y)
      ctx.lineTo(h.x, h.y + 3.5)
      ctx.lineTo(h.x - 3.5, h.y)
      ctx.closePath()
      ctx.fill(); ctx.stroke()
    }

    // Nodes.
    for (let i = 0; i < curve.nodes.length; i++) {
      const n = curve.nodes[i]
      const x = inDbToX(n.in, plot)
      const y = outDbToY(n.out, plot)
      ctx.beginPath()
      ctx.arc(x, y, 4.5, 0, Math.PI * 2)
      ctx.fillStyle = c.accent
      ctx.fill()
      ctx.lineWidth = 1.5
      ctx.strokeStyle = c.nodeStroke
      ctx.stroke()
    }

    // Band label (bottom-right, muted).
    ctx.fillStyle = withAlpha(c.text, 0.9)
    ctx.textAlign = 'right'
    ctx.textBaseline = 'bottom'
    ctx.font = '9px system-ui, sans-serif'
    ctx.fillText(`${BAND_NAMES[band]} · IN→OUT dB`, plot.x + plot.w, cssH - 4)
  }, [band, plotOf])

  const drawRef = useRef(draw)
  drawRef.current = draw

  // Redraw when the curve / band / theme / size change.
  useEffect(() => { draw() }, [draw, effectiveCurve, dims, themeEpoch])

  // Track size via ResizeObserver.
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => {
      setDims({ w: canvas.clientWidth, h: canvas.clientHeight })
      drawRef.current()
    })
    ro.observe(canvas)
    return () => ro.disconnect()
  }, [])

  // ── Hit-testing (canvas CSS-pixel coordinates) ─────────────────────────────

  const mouseToPlot = useCallback((e) => {
    const canvas = canvasRef.current
    const rect = canvas.getBoundingClientRect()
    const cssW = canvas.clientWidth, cssH = canvas.clientHeight
    return { mx: e.clientX - rect.left, my: e.clientY - rect.top, plot: plotOf(cssW, cssH) }
  }, [plotOf])

  const hitNode = useCallback((mx, my, plot, curve) => {
    let best = -1, bestD = NODE_HIT_R * NODE_HIT_R
    for (let i = 0; i < curve.nodes.length; i++) {
      const x = inDbToX(curve.nodes[i].in, plot)
      const y = outDbToY(curve.nodes[i].out, plot)
      const d = (x - mx) ** 2 + (y - my) ** 2
      if (d < bestD) { bestD = d; best = i }
    }
    return best
  }, [])

  const hitHandle = useCallback((mx, my, plot, curve) => {
    let best = -1, bestD = HANDLE_HIT_R * HANDLE_HIT_R
    for (let seg = 0; seg < curve.nodes.length - 1; seg++) {
      const h = segmentHandlePoint(curve, seg, plot)
      const d = (h.x - mx) ** 2 + (h.y - my) ** 2
      if (d < bestD) { bestD = d; best = seg }
    }
    return best
  }, [])

  const cloneCurve = (curve) => ({
    nodes: curve.nodes.map(n => ({ in: n.in, out: n.out })),
    tensions: [...curve.tensions],
  })

  const handlePointerDown = useCallback((e) => {
    if (e.button !== 0) return   // left only; right-click handled by contextmenu
    const curve = curveRef.current
    const { mx, my, plot } = mouseToPlot(e)

    // Prefer a node hit, then a tension handle.
    const nodeIdx = hitNode(mx, my, plot, curve)
    if (nodeIdx >= 0) {
      e.preventDefault()
      try { e.currentTarget.setPointerCapture(e.pointerId) } catch { /* ignore */ }
      dragRef.current = {
        kind: 'node', index: nodeIdx, before: snapshotCurve(band),
        isEnd: nodeIdx === 0 || nodeIdx === curve.nodes.length - 1,
      }
      setLocal(cloneCurve(curve))
      return
    }

    const seg = hitHandle(mx, my, plot, curve)
    if (seg >= 0) {
      e.preventDefault()
      try { e.currentTarget.setPointerCapture(e.pointerId) } catch { /* ignore */ }
      dragRef.current = {
        kind: 'tension', seg, before: snapshotCurve(band),
        startY: my, startTension: curve.tensions[seg] ?? 0,
      }
      setLocal(cloneCurve(curve))
    }
  }, [band, mouseToPlot, hitNode, hitHandle, snapshotCurve])

  const handlePointerMove = useCallback((e) => {
    const d = dragRef.current
    if (!d) return
    e.preventDefault()
    const { mx, my, plot } = mouseToPlot(e)
    const next = cloneCurve(local ?? curveRef.current)

    if (d.kind === 'node') {
      const i = d.index
      const n = next.nodes[i]
      n.out = clamp(yToOutDb(my, plot), CURVE_MIN_DB, CURVE_MAX_DB)
      if (!d.isEnd) {
        const lo = next.nodes[i - 1].in + MIN_IN_GAP
        const hi = next.nodes[i + 1].in - MIN_IN_GAP
        n.in = clamp(xToInDb(mx, plot), lo, hi)
      }
      // Endpoints keep their pinned input at the box edge.
    } else if (d.kind === 'tension') {
      const a = next.nodes[d.seg]
      const b = next.nodes[d.seg + 1]
      const dOut = b.out - a.out
      if (Math.abs(dOut) > 1.0) {
        // Follow the cursor: invert the warp at the segment midpoint.
        const targetOut = yToOutDb(my, plot)
        let f = (targetOut - a.out) / dOut
        f = clamp(f, 0.001, 0.999)
        const p = Math.log(f) / Math.log(0.5)
        next.tensions[d.seg] = clamp(-Math.log(p) / Math.log(4), -1, 1)
      } else {
        // Near-flat segment: map vertical travel to a tension delta.
        const dy = d.startY - my
        next.tensions[d.seg] = clamp(d.startTension + dy / (plot.h * 0.6), -1, 1)
      }
    }

    setLocal(next)
  }, [local, mouseToPlot])

  const endDrag = useCallback((e) => {
    const d = dragRef.current
    if (!d) return
    dragRef.current = null
    try { e?.currentTarget?.releasePointerCapture?.(e.pointerId) } catch { /* ignore */ }
    const finalCurve = local ?? curveRef.current
    commitCurve(band, finalCurve.nodes, finalCurve.tensions, d.before)
    setLocal(null)
  }, [band, local, commitCurve])

  const handleDoubleClick = useCallback((e) => {
    const curve = curveRef.current
    const { mx, my, plot } = mouseToPlot(e)
    // Ignore a double-click that landed on an existing node (that's an edit).
    if (hitNode(mx, my, plot, curve) >= 0) return
    if (curve.nodes.length >= MAX_NODES) return
    const inDb = clamp(xToInDb(mx, plot), CURVE_MIN_DB, CURVE_MAX_DB)
    const outDb = clamp(yToOutDb(my, plot), CURVE_MIN_DB, CURVE_MAX_DB)
    const before = snapshotCurve(band)
    const next = cloneCurve(curve)
    // Insert sorted by input; a new segment inherits zero tension.
    let idx = next.nodes.findIndex(n => n.in > inDb)
    if (idx < 0) idx = next.nodes.length
    next.nodes.splice(idx, 0, { in: inDb, out: outDb })
    next.tensions.splice(Math.max(0, idx - 1), 0, 0)
    commitCurve(band, next.nodes, next.tensions, before)
  }, [band, mouseToPlot, hitNode, snapshotCurve, commitCurve])

  const handleContextMenu = useCallback((e) => {
    e.preventDefault()
    const curve = curveRef.current
    const { mx, my, plot } = mouseToPlot(e)
    const idx = hitNode(mx, my, plot, curve)
    // End nodes pin the curve ends and cannot be deleted (spec 4.3).
    if (idx <= 0 || idx >= curve.nodes.length - 1) return
    const before = snapshotCurve(band)
    const next = cloneCurve(curve)
    next.nodes.splice(idx, 1)
    next.tensions.splice(idx - 1, 1)   // drop the segment that closed up
    commitCurve(band, next.nodes, next.tensions, before)
  }, [band, mouseToPlot, hitNode, snapshotCurve, commitCurve])

  const handleWheel = useCallback((e) => {
    const curve = curveRef.current
    const { mx, my, plot } = mouseToPlot(e)
    const seg = hitHandle(mx, my, plot, curve)
    if (seg < 0) return
    e.preventDefault()
    const before = snapshotCurve(band)
    const next = cloneCurve(curve)
    const step = e.deltaY < 0 ? 0.08 : -0.08
    next.tensions[seg] = clamp((next.tensions[seg] ?? 0) + step, -1, 1)
    commitCurve(band, next.nodes, next.tensions, before)
  }, [band, mouseToPlot, hitHandle, snapshotCurve, commitCurve])

  return (
    <canvas
      ref={canvasRef}
      className="apex-curve-canvas"
      title="Drag node · Double-click add · Right-click delete · Drag/wheel handle = tension · Double-click empty background clears"
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onDoubleClick={handleDoubleClick}
      onContextMenu={handleContextMenu}
      onWheel={handleWheel}
      style={{ touchAction: 'none' }}
      data-band={band}
    />
  )
}
