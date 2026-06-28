import { useCallback, useEffect, useRef } from 'react'
import { VIZ_TYPE } from '../../../constants/dynamicsViz.js'
import { usePluginUI } from '../PluginUIContext.js'
import { useDynamicsVizSubscription } from '../useDynamicsVizSubscription.js'
import { styleToCSS } from '../styleToCSS.js'
import { buildCompressorDisplayHistory } from '../visualizers/compressorPainter.js'
import { readDynamicsTheme } from '../visualizers/theme.js'
import { softKneeOutputDb } from '../visualizers/scaling.js'

const SCALE = Object.freeze({ minDb: -60, maxDb: 0 })
const GRID_DB = Object.freeze([-60, -48, -36, -24, -12, 0])

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

function drawGrid(ctx, plot, theme) {
  ctx.save()
  ctx.strokeStyle = theme.grid || '#333'
  ctx.lineWidth = 1
  ctx.globalAlpha = 0.34
  ctx.beginPath()
  for (const db of GRID_DB) {
    const y = Math.round(dbToY(db, plot)) + 0.5
    ctx.moveTo(plot.x, y)
    ctx.lineTo(plot.x + plot.w, y)
    const x = Math.round(dbToX(db, plot)) + 0.5
    ctx.moveTo(x, plot.y)
    ctx.lineTo(x, plot.y + plot.h)
  }
  ctx.stroke()
  ctx.restore()
}

function drawSpectrum(ctx, plot, ring, params, theme) {
  const columns = buildCompressorDisplayHistory(ring, plot.w, { columnWidthPx: 1 })
  if (!columns.length) return

  ctx.save()
  ctx.strokeStyle = theme.accent || '#4ecdc4'
  ctx.lineWidth = 1
  for (const col of columns) {
    const x = plot.x + col.x
    const inDb = finiteOr(col.inputDb, SCALE.minDb)
    const predicted = softKneeOutputDb(inDb, params.threshold, params.ratio, params.knee, params.makeup)
    const yIn = dbToY(inDb, plot)
    const yOut = dbToY(predicted, plot)
    const compressed = Math.max(0, yOut - yIn)
    ctx.globalAlpha = compressed > 0.5 ? 0.46 : 0.78
    ctx.beginPath()
    ctx.moveTo(x, plot.y + plot.h)
    ctx.lineTo(x, yOut)
    ctx.stroke()
  }
  ctx.restore()
}

function drawKneeGradient(ctx, plot, params, theme) {
  if (params.knee <= 0.01) return
  const low = params.threshold - params.knee * 0.5
  const high = params.threshold + params.knee * 0.5
  const x0 = clamp(Math.min(dbToX(low, plot), dbToX(high, plot)), plot.x, plot.x + plot.w)
  const x1 = clamp(Math.max(dbToX(low, plot), dbToX(high, plot)), plot.x, plot.x + plot.w)
  if (x1 - x0 < 1) return

  ctx.save()
  const grad = ctx.createLinearGradient(0, plot.y, 0, plot.y + plot.h)
  grad.addColorStop(0, rgba(theme.accent || '#4ecdc4', 0.26))
  grad.addColorStop(0.52, rgba(theme.accent || '#4ecdc4', 0.10))
  grad.addColorStop(1, rgba(theme.accent || '#4ecdc4', 0))
  ctx.fillStyle = grad
  ctx.fillRect(x0, plot.y, x1 - x0, plot.h)
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

function drawCurve(ctx, plot, params, theme) {
  ctx.save()
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.20)'
  ctx.lineWidth = 1
  ctx.setLineDash([4, 5])
  ctx.beginPath()
  ctx.moveTo(dbToX(SCALE.minDb, plot), dbToY(SCALE.minDb, plot))
  ctx.lineTo(dbToX(SCALE.maxDb, plot), dbToY(SCALE.maxDb, plot))
  ctx.stroke()
  ctx.setLineDash([])
  ctx.restore()

  const thresholdX = dbToX(params.threshold, plot)
  const thresholdY = dbToY(params.threshold, plot)
  ctx.save()
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.30)'
  ctx.lineWidth = 1
  ctx.setLineDash([2, 5])
  ctx.beginPath()
  ctx.moveTo(thresholdX + 0.5, plot.y)
  ctx.lineTo(thresholdX + 0.5, plot.y + plot.h)
  ctx.moveTo(plot.x, thresholdY + 0.5)
  ctx.lineTo(plot.x + plot.w, thresholdY + 0.5)
  ctx.stroke()
  ctx.restore()

  ctx.save()
  ctx.strokeStyle = '#d7d9e2'
  ctx.lineWidth = 2.2
  ctx.lineJoin = 'round'
  ctx.lineCap = 'round'
  ctx.beginPath()
  for (let px = 0; px <= plot.w; px++) {
    const inputDb = SCALE.minDb + (px / Math.max(1, plot.w)) * (SCALE.maxDb - SCALE.minDb)
    const pt = curvePointForInput(inputDb, plot, params)
    if (px === 0) ctx.moveTo(pt.x, pt.y)
    else ctx.lineTo(pt.x, pt.y)
  }
  ctx.stroke()
  ctx.restore()
}

function buildHandles(plot, params) {
  const thresholdPoint = curvePointForInput(params.threshold, plot, params)
  const kneeInput = clamp(params.threshold - params.knee * 0.5, SCALE.minDb, SCALE.maxDb)
  const kneePoint = curvePointForInput(kneeInput, plot, params)
  const ratioPoint = curvePointForInput(SCALE.maxDb, plot, params)

  return [
    { type: 'threshold', x: thresholdPoint.x, y: thresholdPoint.y, r: 9 },
    { type: 'knee', x: kneePoint.x, y: kneePoint.y, r: 8 },
    { type: 'ratio', x: ratioPoint.x, y: ratioPoint.y, r: 9 },
  ]
}

function drawHandles(ctx, handles, theme) {
  for (const handle of handles) {
    ctx.save()
    ctx.fillStyle = handle.type === 'knee'
      ? rgba(theme.accent || '#4ecdc4', 0.85)
      : '#f8f8fb'
    ctx.strokeStyle = handle.type === 'ratio'
      ? rgba(theme.accent || '#4ecdc4', 0.9)
      : 'rgba(255, 255, 255, 0.95)'
    ctx.lineWidth = 1.4
    ctx.beginPath()
    if (handle.type === 'knee') {
      ctx.moveTo(handle.x, handle.y - 6)
      ctx.lineTo(handle.x + 6, handle.y)
      ctx.lineTo(handle.x, handle.y + 6)
      ctx.lineTo(handle.x - 6, handle.y)
      ctx.closePath()
    } else {
      ctx.arc(handle.x, handle.y, 5.5, 0, Math.PI * 2)
    }
    ctx.fill()
    ctx.stroke()
    ctx.restore()
  }
}

function drawCurveEditor(ctx, w, h, ring, params, theme) {
  ctx.clearRect(0, 0, w, h)
  ctx.fillStyle = theme.bgInset || '#0f0f0f'
  ctx.fillRect(0, 0, w, h)

  const plot = {
    x: 8,
    y: 8,
    w: Math.max(1, w - 16),
    h: Math.max(1, h - 16),
  }

  drawGrid(ctx, plot, theme)
  drawSpectrum(ctx, plot, ring, params, theme)
  drawKneeGradient(ctx, plot, params, theme)
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
