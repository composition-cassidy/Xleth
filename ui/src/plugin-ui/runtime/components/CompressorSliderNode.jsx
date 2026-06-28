import { useCallback, useMemo, useRef } from 'react'
import { usePluginUI } from '../PluginUIContext.js'
import { resolveFormat } from '../formats.js'
import { styleToCSS } from '../styleToCSS.js'

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value))
}

function valueToPercent(value, min, max) {
  const span = max - min || 1
  return clamp((value - min) / span, 0, 1) * 100
}

function valueFromPointer(event, element, min, max) {
  const rect = element.getBoundingClientRect()
  const y = clamp(event.clientY - rect.top, 0, Math.max(1, rect.height))
  const t = 1 - y / Math.max(1, rect.height)
  return min + t * (max - min)
}

export default function CompressorSliderNode({ node }) {
  const { manifest, params, setParam } = usePluginUI()
  const { props = {}, style = {} } = node
  const paramId = props.param
  const meta = manifest?.params?.[paramId]
  const draggingRef = useRef(false)

  const formatFn = useMemo(
    () => resolveFormat(props.format || meta?.format),
    [props.format, meta?.format],
  )

  if (!meta) return null

  const value = params[paramId] ?? meta.defaultValue
  const pct = valueToPercent(value, meta.min, meta.max)
  const label = props.label ?? meta.label
  const title = `${label}: ${formatFn(value)}`
  const inlineStyle = styleToCSS(style)

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

  const handleDoubleClick = useCallback(() => {
    setParam(paramId, meta.defaultValue)
  }, [meta.defaultValue, paramId, setParam])

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
      className="pluginui-compressor-slider"
      style={inlineStyle}
      data-pluginui-id={node.id}
      title={title}
    >
      <div
        className="pluginui-compressor-slider-track"
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
        onDoubleClick={handleDoubleClick}
        onKeyDown={handleKeyDown}
      >
        <div className="pluginui-compressor-slider-fill" style={{ height: `${pct}%` }} />
      </div>
      <div className="pluginui-compressor-slider-label">{label}</div>
    </div>
  )
}
