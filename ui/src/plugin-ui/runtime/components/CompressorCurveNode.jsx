import { useCallback, useEffect, useRef } from 'react'
import { VIZ_TYPE } from '../../../constants/dynamicsViz.js'
import { usePluginUI } from '../PluginUIContext.js'
import { useDynamicsVizSubscription } from '../useDynamicsVizSubscription.js'
import { styleToCSS } from '../styleToCSS.js'
import { buildCompressorDisplayHistory } from '../visualizers/compressorPainter.js'
import { readDynamicsTheme } from '../visualizers/theme.js'
import { softKneeOutputDb } from '../visualizers/scaling.js'

const SCALE = Object.freeze({ minDb: -60, maxDb: 0 })

// Waveform fades. The display is one uninterrupted canvas now: the level
// history spans the full width, including the stretch the transfer curve
// crosses, so it needs to get out of the curve's way rather than be clipped
// out of it.
//   • horizontal — ramps in from the left edge and is fully opaque by the
//     midpoint, which is where the curve's interesting region ends.
//   • vertical — a gentle drop toward the bottom edge so the silhouette
//     doesn't read as a solid block.
const WAVE_FADE = Object.freeze({
  horizontalCompleteAt: 0.5,
  topAlpha: 0.6,
  midAlpha: 0.3,
  midStop: 0.55,
  bottomAlpha: 0.02,
})

// Curve sampling step in CSS px. The soft-knee transfer function is C1
// continuous, so a coarse sample fed through Catmull-Rom smoothing produces a
// cleaner path than the old per-pixel polyline.
const CURVE_STEP_PX = 3

function finiteOr(value, fallback) {
  return Number.isFinite(value) ? value : fallback
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value))
}

function normalizeParams(params, bindings = {}) {
  const thresholdParam = bindings.thresholdParam || 'threshold'
  const ratioParam = bindings.ratioParam || 'ratio'
  const kneeParam = bindings.kneeParam || 'knee'
  const makeupParam = bindings.makeupParam || 'makeup'
  return {
    threshold: clamp(finiteOr(params?.[thresholdParam], -20), -60, 0),
    ratio: clamp(finiteOr(params?.[ratioParam], 4), 1, 100),
    knee: clamp(finiteOr(params?.[kneeParam], 6), 0, 24),
    makeup: clamp(finiteOr(params?.[makeupParam], 0), 0, 36),
  }
}

function dbToX(db, plot) {
  const t = (clamp(db, SCALE.minDb, SCALE.maxDb) - SCALE.minDb) / (SCALE.maxDb - SCALE.minDb)
  return plot.x + t * plot.w
}

function dbToY(db, plot) {
  const t = (clamp(db, SCALE.minDb, SCALE.maxDb) - SCALE.minDb) / (SCALE.maxDb - SCALE.minDb)
  return plot.y + (1 - t) * plot.h
}

function xToDb(x, plot) {
  const t = clamp((x - plot.x) / Math.max(1, plot.w), 0, 1)
  return SCALE.minDb + t * (SCALE.maxDb - SCALE.minDb)
}

function yToDb(y, plot) {
  const t = 1 - clamp((y - plot.y) / Math.max(1, plot.h), 0, 1)
  return SCALE.minDb + t * (SCALE.maxDb - SCALE.minDb)
}

function rgba(color, alpha) {
  if (!color) return `rgba(255, 255, 255, ${alpha})`
  const rgbaMatch = color.match(/^rgba\(([^)]+)\)$/i)
  if (rgbaMatch) {
    const parts = rgbaMatch[1].split(',').map((part) => part.trim())
    return parts.length >= 3 ? `rgba(${parts[0]}, ${parts[1]}, ${parts[2]}, ${alpha})` : color
  }
  if (color.startsWith('rgb(')) return color.replace('rgb(', 'rgba(').replace(')', `, ${alpha})`)
  const shortHex = color.trim().match(/^#([0-9a-f])([0-9a-f])([0-9a-f])$/i)
  if (shortHex) {
    const r = parseInt(shortHex[1] + shortHex[1], 16)
    const g = parseInt(shortHex[2] + shortHex[2], 16)
    const b = parseInt(shortHex[3] + shortHex[3], 16)
    return `rgba(${r}, ${g}, ${b}, ${alpha})`
  }
  const longHex = color.trim().match(/^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i)
  if (longHex) {
    const r = parseInt(longHex[1], 16)
    const g = parseInt(longHex[2], 16)
    const b = parseInt(longHex[3], 16)
    return `rgba(${r}, ${g}, ${b}, ${alpha})`
  }
  return color
}

// Alpha ramp applied to the waveform across the display width. Multiplied into
// the vertical gradient's own alpha via globalAlpha, which is what makes the
// two fades compose without an offscreen pass.
function waveformFadeAt(x, plot) {
  const span = Math.max(1, plot.w * WAVE_FADE.horizontalCompleteAt)
  const t = clamp((x - plot.x) / span, 0, 1)
  // Smoothstep rather than a straight ramp: a linear fade is already half
  // opaque a quarter of the way in, which reads as "no fade at all".
  return t * t * (3 - 2 * t)
}

// The level history, drawn edge to edge as a filled silhouette with a lit top
// edge. Columns are emitted at 1 CSS px so each one can carry its own
// horizontal-fade alpha.
function drawWaveform(ctx, plot, ring, theme) {
  const columns = buildCompressorDisplayHistory(ring, plot.w, { columnWidthPx: 1 })
  if (columns.length < 2) return

  const bottom = plot.y + plot.h
  const fill = ctx.createLinearGradient(0, plot.y, 0, bottom)
  fill.addColorStop(0, rgba(theme.textMuted || '#888', WAVE_FADE.topAlpha))
  fill.addColorStop(WAVE_FADE.midStop, rgba(theme.textMuted || '#888', WAVE_FADE.midAlpha))
  fill.addColorStop(1, rgba(theme.textMuted || '#888', WAVE_FADE.bottomAlpha))

  ctx.save()
  ctx.fillStyle = fill

  // Filled body — one bar per column so the horizontal fade can vary along x.
  for (let i = 0; i < columns.length; i++) {
    const col = columns[i]
    const x = plot.x + col.x
    const alpha = waveformFadeAt(x, plot)
    if (alpha <= 0.002) continue
    const next = columns[i + 1]
    const width = next ? Math.max(1, (plot.x + next.x) - x) : 1
    const y = dbToY(finiteOr(col.inputDb, SCALE.minDb), plot)
    if (bottom - y < 0.5) continue
    ctx.globalAlpha = alpha
    ctx.fillRect(x, y, width, bottom - y)
  }

  // Lit top edge — drawn per segment so it shares the same fade.
  ctx.lineWidth = 1.4
  ctx.lineJoin = 'round'
  ctx.lineCap = 'round'
  ctx.strokeStyle = theme.text || '#e0e0e0'
  for (let i = 1; i < columns.length; i++) {
    const prev = columns[i - 1]
    const col = columns[i]
    const x0 = plot.x + prev.x
    const x1 = plot.x + col.x
    const alpha = waveformFadeAt(x1, plot)
    if (alpha <= 0.002) continue
    ctx.globalAlpha = alpha * 0.85
    ctx.beginPath()
    ctx.moveTo(x0, dbToY(finiteOr(prev.inputDb, SCALE.minDb), plot))
    ctx.lineTo(x1, dbToY(finiteOr(col.inputDb, SCALE.minDb), plot))
    ctx.stroke()
  }
  ctx.restore()
}

// Live input-level marker — the thin vertical rule that tracks where the
// current signal sits on the input axis. Suppressed when the ring is empty or
// pinned to the floor so an idle panel stays clean.
function drawInputMarker(ctx, plot, ring, theme) {
  const bucket = typeof ring?.last === 'function' ? ring.last() : null
  const inDb = bucket?.inLevelDb
  if (!Number.isFinite(inDb) || inDb <= SCALE.minDb + 0.5) return

  const x = dbToX(inDb, plot)
  ctx.save()
  ctx.strokeStyle = rgba(theme.text || '#e0e0e0', 0.55)
  ctx.lineWidth = 1
  ctx.beginPath()
  ctx.moveTo(x, plot.y)
  ctx.lineTo(x, plot.y + plot.h)
  ctx.stroke()
  ctx.restore()
}

function curvePointForInput(inputDb, plot, params) {
  const outDb = softKneeOutputDb(inputDb, params.threshold, params.ratio, params.knee, params.makeup)
  return {
    x: dbToX(inputDb, plot),
    y: dbToY(outDb, plot),
    inputDb,
    outDb,
  }
}

function drawThresholdGuides(ctx, plot, params, theme) {
  const thresholdX = dbToX(params.threshold, plot)
  const thresholdY = dbToY(params.threshold, plot)
  ctx.save()
  ctx.strokeStyle = rgba(theme.accent || '#4ecdc4', 0.55)
  ctx.lineWidth = 2
  ctx.lineCap = 'butt'
  ctx.setLineDash([2, 6])
  ctx.beginPath()
  ctx.moveTo(thresholdX, plot.y)
  ctx.lineTo(thresholdX, plot.y + plot.h)
  ctx.moveTo(plot.x, thresholdY)
  ctx.lineTo(plot.x + plot.w, thresholdY)
  ctx.stroke()
  ctx.setLineDash([])
  ctx.restore()
}

// Catmull-Rom through the sampled points, emitted as cubic beziers. Keeps the
// stroke a true vector path — no per-pixel stair-stepping, and the knee reads
// as a curve instead of a chain of short segments.
function traceSmoothPath(ctx, points) {
  if (points.length < 2) return
  ctx.moveTo(points[0].x, points[0].y)
  if (points.length === 2) {
    ctx.lineTo(points[1].x, points[1].y)
    return
  }
  for (let i = 0; i < points.length - 1; i++) {
    const p0 = points[i === 0 ? 0 : i - 1]
    const p1 = points[i]
    const p2 = points[i + 1]
    const p3 = points[i + 2] ?? p2
    ctx.bezierCurveTo(
      p1.x + (p2.x - p0.x) / 6,
      p1.y + (p2.y - p0.y) / 6,
      p2.x - (p3.x - p1.x) / 6,
      p2.y - (p3.y - p1.y) / 6,
      p2.x,
      p2.y,
    )
  }
}

function buildCurvePoints(plot, params) {
  const points = []
  const span = SCALE.maxDb - SCALE.minDb
  const steps = Math.max(2, Math.ceil(plot.w / CURVE_STEP_PX))
  for (let i = 0; i <= steps; i++) {
    const inputDb = SCALE.minDb + (i / steps) * span
    points.push(curvePointForInput(inputDb, plot, params))
  }
  return points
}

function drawCurve(ctx, plot, params, theme) {
  const accent = theme.accent || '#4ecdc4'
  const points = buildCurvePoints(plot, params)

  ctx.save()
  ctx.lineJoin = 'round'
  ctx.lineCap = 'round'

  // Dim wide under-stroke, then the bright core. The pair softens the edge
  // without a blur filter and keeps the line readable over the waveform.
  ctx.beginPath()
  traceSmoothPath(ctx, points)
  ctx.strokeStyle = rgba(accent, 0.18)
  ctx.lineWidth = 4
  ctx.stroke()

  ctx.strokeStyle = accent
  ctx.lineWidth = 2.4
  ctx.stroke()
  ctx.restore()
}

function buildHandles(plot, params) {
  const thresholdPoint = curvePointForInput(params.threshold, plot, params)
  const kneeInput = clamp(params.threshold - params.knee * 0.5, SCALE.minDb, SCALE.maxDb)
  const kneePoint = curvePointForInput(kneeInput, plot, params)
  // Pulled a few px inside the right edge — the plot now runs to the frame, so
  // a handle sitting exactly at maxDb would be drawn half-clipped.
  const ratioPoint = curvePointForInput(xToDb(plot.x + plot.w - 12, plot), plot, params)

  return [
    { type: 'threshold', x: thresholdPoint.x, y: thresholdPoint.y, r: 9 },
    { type: 'knee', x: kneePoint.x, y: kneePoint.y, r: 8 },
    { type: 'ratio', x: ratioPoint.x, y: ratioPoint.y, r: 9 },
  ]
}

// Quiet crosshair markers. The curve stays draggable, but the handles no
// longer read as filled dots competing with the waveform behind them.
function drawHandles(ctx, handles, theme) {
  const accent = theme.accent || '#4ecdc4'
  ctx.save()
  ctx.lineWidth = 1.2
  ctx.lineCap = 'round'
  for (const handle of handles) {
    ctx.strokeStyle = rgba(accent, 0.9)
    ctx.fillStyle = rgba(theme.bgInset || '#0f0f0f', 0.85)
    ctx.beginPath()
    ctx.arc(handle.x, handle.y, 4.5, 0, Math.PI * 2)
    ctx.fill()
    ctx.stroke()
    ctx.beginPath()
    ctx.moveTo(handle.x - 7, handle.y)
    ctx.lineTo(handle.x + 7, handle.y)
    ctx.moveTo(handle.x, handle.y - 7)
    ctx.lineTo(handle.x, handle.y + 7)
    ctx.strokeStyle = rgba(accent, 0.55)
    ctx.stroke()
  }
  ctx.restore()
}

function drawCurveEditor(ctx, w, h, ring, params, theme) {
  ctx.clearRect(0, 0, w, h)
  ctx.fillStyle = theme.bgInset || '#0f0f0f'
  ctx.fillRect(0, 0, w, h)

  // Edge to edge: the waveform and the curve both run into the frame, so the
  // plot is the whole canvas rather than an inset box.
  const plot = {
    x: 0,
    y: 0,
    w: Math.max(1, w),
    h: Math.max(1, h),
  }

  drawWaveform(ctx, plot, ring, theme)
  drawInputMarker(ctx, plot, ring, theme)
  drawThresholdGuides(ctx, plot, params, theme)
  drawCurve(ctx, plot, params, theme)

  const handles = buildHandles(plot, params)
  drawHandles(ctx, handles, theme)
  return { plot, handles }
}

function nearestHandle(handles, x, y) {
  let nearest = null
  let best = Number.POSITIVE_INFINITY
  for (const handle of handles || []) {
    const distance = Math.hypot(x - handle.x, y - handle.y)
    if (distance < best) {
      nearest = handle
      best = distance
    }
  }
  return best <= 24 ? nearest : null
}

export default function CompressorCurveNode({ node }) {
  const { target, params, setParam } = usePluginUI()
  const { props = {}, style = {} } = node
  const canvasRef = useRef(null)
  const paramsRef = useRef(params)
  const bindingsRef = useRef(null)
  const geometryRef = useRef(null)
  const activeHandleRef = useRef(null)
  const thresholdParam = props.thresholdParam || 'threshold'
  const ratioParam = props.ratioParam || 'ratio'
  const kneeParam = props.kneeParam || 'knee'
  const makeupParam = props.makeupParam || 'makeup'

  paramsRef.current = params
  bindingsRef.current = { thresholdParam, ratioParam, kneeParam, makeupParam }

  const sub = useDynamicsVizSubscription(target?.trackId, target?.nodeId, VIZ_TYPE.COMPRESSOR)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    let cancelled = false
    let rafId = 0

    const draw = () => {
      if (cancelled) return
      const cssW = canvas.clientWidth || 1
      const cssH = canvas.clientHeight || 1
      const dpr = Math.max(1, window.devicePixelRatio || 1)
      const targetW = Math.round(cssW * dpr)
      const targetH = Math.round(cssH * dpr)
      if (canvas.width !== targetW || canvas.height !== targetH) {
        canvas.width = targetW
        canvas.height = targetH
      }

      const ctx = canvas.getContext('2d', { alpha: false })
      if (ctx) {
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
        const theme = readDynamicsTheme(canvas)
        geometryRef.current = drawCurveEditor(
          ctx,
          cssW,
          cssH,
          sub.ringRef?.current,
          normalizeParams(paramsRef.current, bindingsRef.current),
          theme,
        )
      }
      rafId = requestAnimationFrame(draw)
    }

    rafId = requestAnimationFrame(draw)
    return () => {
      cancelled = true
      cancelAnimationFrame(rafId)
    }
  }, [sub])

  const updateActiveHandle = useCallback((event) => {
    const canvas = canvasRef.current
    const geometry = geometryRef.current
    const active = activeHandleRef.current
    if (!canvas || !geometry || !active) return

    const rect = canvas.getBoundingClientRect()
    const x = event.clientX - rect.left
    const y = event.clientY - rect.top
    const plot = geometry.plot
    const p = normalizeParams(paramsRef.current, bindingsRef.current)

    if (active === 'threshold') {
      setParam(thresholdParam, clamp(yToDb(y, plot), -60, 0))
    } else if (active === 'knee') {
      const db = xToDb(x, plot)
      const nextKnee = clamp(Math.abs(p.threshold - db) * 2, 0, 24)
      setParam(kneeParam, nextKnee)
    } else if (active === 'ratio') {
      const targetOut = yToDb(y, plot)
      const overshoot = Math.max(0.001, 0 - p.threshold)
      const denom = targetOut - p.threshold - p.makeup
      const nextRatio = denom <= 0.001 ? 100 : overshoot / denom
      setParam(ratioParam, clamp(nextRatio, 1, 100))
    }
  }, [kneeParam, ratioParam, setParam, thresholdParam])

  const handlePointerDown = useCallback((event) => {
    const canvas = canvasRef.current
    const geometry = geometryRef.current
    if (!canvas || !geometry) return
    const rect = canvas.getBoundingClientRect()
    const x = event.clientX - rect.left
    const y = event.clientY - rect.top
    const hit = nearestHandle(geometry.handles, x, y)
    if (!hit) return
    activeHandleRef.current = hit.type
    canvas.setPointerCapture?.(event.pointerId)
    updateActiveHandle(event)
    event.preventDefault()
  }, [updateActiveHandle])

  const handlePointerMove = useCallback((event) => {
    if (!activeHandleRef.current) return
    updateActiveHandle(event)
    event.preventDefault()
  }, [updateActiveHandle])

  const handlePointerUp = useCallback((event) => {
    activeHandleRef.current = null
    canvasRef.current?.releasePointerCapture?.(event.pointerId)
  }, [])

  return (
    <div
      className="pluginui-compressor-curve"
      style={styleToCSS(style)}
      data-pluginui-id={node.id}
    >
      <canvas
        ref={canvasRef}
        className="pluginui-compressor-curve-canvas"
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
      />
    </div>
  )
}
