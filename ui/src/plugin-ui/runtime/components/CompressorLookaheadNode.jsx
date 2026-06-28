import { useCallback, useEffect, useRef } from 'react'
import { usePluginUI } from '../PluginUIContext.js'
import { resolveFormat } from '../formats.js'
import { styleToCSS } from '../styleToCSS.js'

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value))
}

function valueFromPointer(event, element, min, max) {
  const rect = element.getBoundingClientRect()
  const y = clamp(event.clientY - rect.top, 0, Math.max(1, rect.height))
  const t = 1 - y / Math.max(1, rect.height)
  return min + t * (max - min)
}

function drawLookaheadPreview(canvas, value, min, max) {
  const rect = canvas.getBoundingClientRect()
  const dpr = Math.max(1, window.devicePixelRatio || 1)
  const cssW = Math.max(1, Math.round(rect.width))
  const cssH = Math.max(1, Math.round(rect.height))
  const targetW = Math.round(cssW * dpr)
  const targetH = Math.round(cssH * dpr)
  if (canvas.width !== targetW || canvas.height !== targetH) {
    canvas.width = targetW
    canvas.height = targetH
  }

  const ctx = canvas.getContext('2d')
  if (!ctx) return

  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.clearRect(0, 0, cssW, cssH)

  const cs = getComputedStyle(canvas)
  const accent = cs.getPropertyValue('--theme-accent').trim() || '#4ecdc4'
  const text = cs.getPropertyValue('--theme-text').trim() || '#fff'
  const pct = clamp((value - min) / ((max - min) || 1), 0, 1)
  const meterW = Math.max(24, Math.min(34, cssW * 0.24))
  const waveX = meterW + Math.max(12, cssW * 0.06)
  const waveW = Math.max(24, cssW - waveX - 8)

  ctx.save()
  ctx.globalAlpha = 0.72
  ctx.fillStyle = accent
  ctx.fillRect(0, cssH * (1 - pct), meterW, cssH * pct)
  ctx.globalAlpha = 0.16
  ctx.fillRect(meterW, cssH * (1 - pct), 1, cssH * pct)
  ctx.restore()

  const drawWave = (color, alpha, xShift, ampScale) => {
    ctx.save()
    ctx.strokeStyle = color
    ctx.globalAlpha = alpha
    ctx.lineWidth = 1.6
    ctx.beginPath()
    const baseY = cssH * 0.52
    const amp = cssH * 0.22 * ampScale
    for (let i = 0; i <= 72; i++) {
      const t = i / 72
      const x = waveX + t * waveW + xShift
      const env = Math.max(0, 1 - t * 0.85)
      const y = baseY
        + Math.sin(t * Math.PI * 8) * amp * env
        + Math.sin(t * Math.PI * 21) * amp * 0.24 * env
      if (i === 0) ctx.moveTo(x, y)
      else ctx.lineTo(x, y)
    }
    ctx.stroke()
    ctx.restore()
  }

  drawWave(accent, 0.42, -pct * waveW * 0.18, 1.08)
  drawWave(text, 0.9, 0, 0.82)
}

export default function CompressorLookaheadNode({ node }) {
  const { manifest, params, setParam } = usePluginUI()
  const { props = {}, style = {} } = node
  const paramId = props.param || 'lookahead'
  const meta = manifest?.params?.[paramId]
  const canvasRef = useRef(null)
  const draggingRef = useRef(false)

  if (!meta) return null

  const value = params[paramId] ?? meta.defaultValue
  const formatFn = resolveFormat(props.format || meta.format)
  const label = props.label ?? meta.label

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    drawLookaheadPreview(canvas, value, meta.min, meta.max)
  }, [meta.min, meta.max, value])

  const commitFromPointer = useCallback((event) => {
    const next = valueFromPointer(event, event.currentTarget, meta.min, meta.max)
    setParam(paramId, clamp(next, meta.min, meta.max))
  }, [meta.min, meta.max, paramId, setParam])

  const handlePointerDown = useCallback((event) => {
    draggingRef.current = true
    event.currentTarget.setPointerCapture?.(event.pointerId)
    commitFromPointer(event)
    event.preventDefault()
  }, [commitFromPointer])

  const handlePointerMove = useCallback((event) => {
    if (!draggingRef.current) return
    commitFromPointer(event)
    event.preventDefault()
  }, [commitFromPointer])

  const handlePointerUp = useCallback((event) => {
    draggingRef.current = false
    event.currentTarget.releasePointerCapture?.(event.pointerId)
  }, [])

  const handleKeyDown = useCallback((event) => {
    const span = meta.max - meta.min
    const step = span / (event.shiftKey ? 20 : 100)
    let next = value
    if (event.key === 'ArrowUp' || event.key === 'ArrowRight') next += step
    else if (event.key === 'ArrowDown' || event.key === 'ArrowLeft') next -= step
    else if (event.key === 'Home') next = meta.min
    else if (event.key === 'End') next = meta.max
    else return
    setParam(paramId, clamp(next, meta.min, meta.max))
    event.preventDefault()
  }, [meta.min, meta.max, paramId, setParam, value])

  return (
    <div
      className="pluginui-compressor-lookahead"
      style={styleToCSS(style)}
      data-pluginui-id={node.id}
      title={`${label}: ${formatFn(value)}`}
    >
      <div
        className="pluginui-compressor-lookahead-box"
        role="slider"
        tabIndex={0}
        aria-label={label}
        aria-valuemin={meta.min}
        aria-valuemax={meta.max}
        aria-valuenow={Number(value.toFixed(3))}
        aria-valuetext={formatFn(value)}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
        onKeyDown={handleKeyDown}
      >
        <canvas ref={canvasRef} className="pluginui-compressor-lookahead-canvas" />
      </div>
      <div className="pluginui-compressor-slider-label">{label}</div>
    </div>
  )
}
