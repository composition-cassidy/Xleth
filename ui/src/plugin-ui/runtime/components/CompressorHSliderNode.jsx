import { useCallback, useMemo, useRef } from 'react'
import { usePluginUI } from '../PluginUIContext.js'
import { resolveFormat } from '../formats.js'
import { styleToCSS } from '../styleToCSS.js'
import { useDragLaw } from '../../../components/controls/dragLaw.js'

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

export default function CompressorHSliderNode({ node }) {
  const { manifest, params, setParam } = usePluginUI()
  const { props = {}, style = {} } = node
  const paramId = props.param
  const meta = manifest?.params?.[paramId]
  const trackRef = useRef(null)

  const formatFn = useMemo(
    () => resolveFormat(props.format || meta?.format),
    [props.format, meta?.format],
  )

  const value = meta ? (params[paramId] ?? meta.defaultValue) : 0
  const span = meta ? meta.max - meta.min : 1

  // See CompressorSliderNode.jsx for why this is wired to the shared drag law
  // (dragLaw.js) directly instead of the Fader primitive.
  const toNorm = useCallback(
    (v) => clamp((v - (meta?.min ?? 0)) / (span || 1), 0, 1),
    [meta, span],
  )
  const fromNorm = useCallback(
    (n) => (meta?.min ?? 0) + clamp(n, 0, 1) * span,
    [meta, span],
  )
  const handleLiveChange = useCallback((v) => setParam(paramId, v), [paramId, setParam])
  const handleCommit = useCallback((v) => setParam(paramId, v), [paramId, setParam])
  const resolveDragRange = useCallback(() => trackRef.current?.clientWidth || 1, [])

  const drag = useDragLaw({
    value,
    toNorm,
    fromNorm,
    dragRange: resolveDragRange,
    resetValue: meta?.defaultValue,
    onLiveChange: handleLiveChange,
    onCommit: handleCommit,
    axis: 'x',
  })

  const handlePointerUp = useCallback((event) => {
    drag.onPointerUp()
    event.currentTarget.releasePointerCapture?.(event.pointerId)
  }, [drag])

  const handleDoubleClick = useCallback(() => {
    if (meta) setParam(paramId, meta.defaultValue)
  }, [meta, paramId, setParam])

  const handleKeyDown = useCallback((event) => {
    if (!meta) return
    const stepSpan = meta.max - meta.min
    const step = stepSpan / (event.shiftKey ? 20 : 100)
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
        ref={trackRef}
        className="pluginui-compressor-hslider-track"
        role="slider"
        tabIndex={0}
        aria-label={label}
        aria-valuemin={meta.min}
        aria-valuemax={meta.max}
        aria-valuenow={Number(value.toFixed(3))}
        aria-valuetext={readout}
        onPointerDown={drag.onPointerDown}
        onPointerMove={drag.onPointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
        onDoubleClick={handleDoubleClick}
        onKeyDown={handleKeyDown}
        onWheel={drag.onWheel}
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
