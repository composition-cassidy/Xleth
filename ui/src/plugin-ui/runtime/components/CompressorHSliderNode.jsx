import { useCallback, useMemo, useRef } from 'react'
import { usePluginUI } from '../PluginUIContext.js'
import { resolveFormat } from '../formats.js'
import { styleToCSS } from '../styleToCSS.js'

// Horizontal sibling of CompressorSliderNode — a flat rectangular track that
// fills from the left. Used for TRIM in the Resonance Suppressor so it matches
// the mockup (horizontal bar rather than a knob).

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value))
}

function valueToPercent(value, min, max) {
  const span = max - min || 1
  return clamp((value - min) / span, 0, 1) * 100
}

function valueFromPointer(event, element, min, max) {
  const rect = element.getBoundingClientRect()
  const x = clamp(event.clientX - rect.left, 0, Math.max(1, rect.width))
  const t = x / Math.max(1, rect.width)
  return min + t * (max - min)
}

export default function CompressorHSliderNode({ node }) {
  const { manifest, params, setParam } = usePluginUI()
  const { props = {}, style = {} } = node
  const paramId = props.param
  const meta = manifest?.params?.[paramId]
  const draggingRef = useRef(false)

  const formatFn = useMemo(
    () => resolveFormat(props.format || meta?.format),
    [props.format, meta?.format],
  )

  const commitFromPointer = useCallback((event) => {
    if (!meta) return
    const next = valueFromPointer(event, event.currentTarget, meta.min, meta.max)
    setParam(paramId, clamp(next, meta.min, meta.max))
  }, [meta, paramId, setParam])

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
    if (meta) setParam(paramId, meta.defaultValue)
  }, [meta, paramId, setParam])

  const handleKeyDown = useCallback((event) => {
    if (!meta) return
    const span = meta.max - meta.min
    const step = span / (event.shiftKey ? 20 : 100)
    let next = params[paramId] ?? meta.defaultValue
    if (event.key === 'ArrowUp' || event.key === 'ArrowRight') next += step
    else if (event.key === 'ArrowDown' || event.key === 'ArrowLeft') next -= step
    else if (event.key === 'Home') next = meta.min
    else if (event.key === 'End') next = meta.max
    else return
    setParam(paramId, clamp(next, meta.min, meta.max))
    event.preventDefault()
  }, [meta, params, paramId, setParam])

  if (!meta) return null

  const value = params[paramId] ?? meta.defaultValue
  const pct = valueToPercent(value, meta.min, meta.max)
  const label = props.label ?? meta.label
  const readout = formatFn(value)

  return (
    <div
      className="pluginui-compressor-hslider"
      style={styleToCSS(style)}
      data-pluginui-id={node.id}
      title={`${label}: ${readout}`}
    >
      <div
        className="pluginui-compressor-hslider-track"
        role="slider"
        tabIndex={0}
        aria-label={label}
        aria-valuemin={meta.min}
        aria-valuemax={meta.max}
        aria-valuenow={Number(value.toFixed(3))}
        aria-valuetext={readout}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
        onDoubleClick={handleDoubleClick}
        onKeyDown={handleKeyDown}
      >
        <div className="pluginui-compressor-hslider-fill" style={{ width: `${pct}%` }} />
      </div>
      <div className="pluginui-compressor-hslider-foot">
        <span className="pluginui-compressor-hslider-label">{label}</span>
        <span className="pluginui-compressor-hslider-readout">{readout}</span>
      </div>
    </div>
  )
}
