import { useCallback, useMemo, useRef } from 'react'
import { usePluginUI } from '../PluginUIContext.js'
import { resolveFormat } from '../formats.js'
import { styleToCSS } from '../styleToCSS.js'
import { useDragLaw } from '../../../components/controls/dragLaw.js'

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value))
}

function valueToPercent(value, min, max) {
  const span = max - min || 1
  return clamp((value - min) / span, 0, 1) * 100
}

export default function CompressorSliderNode({ node }) {
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

  // Grab-relative drag law (ui/src/components/controls/dragLaw.js) — the same
  // rebasing-fine/reset/wheel/live-commit pipeline the sampler Knob and mixer
  // Fader use. Wired directly (not via the Fader primitive) because this
  // node's DOM/CSS contract (track/fill/thumb classNames, the rail variant)
  // is bespoke to plugin-ui and shared with app.css; the drag law owns only
  // the pointer-to-normalised-value math, so it drops in without touching
  // markup or styling.
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
  const resolveDragRange = useCallback(() => trackRef.current?.clientHeight || 1, [])

  const drag = useDragLaw({
    value,
    toNorm,
    fromNorm,
    dragRange: resolveDragRange,
    resetValue: meta?.defaultValue,
    onLiveChange: handleLiveChange,
    onCommit: handleCommit,
    axis: 'y',
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
    let next = value
    if (event.key === 'ArrowUp' || event.key === 'ArrowRight') next += step
    else if (event.key === 'ArrowDown' || event.key === 'ArrowLeft') next -= step
    else if (event.key === 'Home') next = meta.min
    else if (event.key === 'End') next = meta.max
    else return
    setParam(paramId, clamp(next, meta.min, meta.max))
    event.preventDefault()
  }, [meta, paramId, setParam, value])

  if (!meta) return null

  const pct = valueToPercent(value, meta.min, meta.max)
  const label = props.label ?? meta.label
  const title = `${label}: ${formatFn(value)}`
  const inlineStyle = styleToCSS(style)
  // 'rail' swaps the filled box for a thin rail with a wide flat thumb. Opt-in
  // per node so the layouts already using the boxed look are untouched.
  const isRail = props.variant === 'rail'
  const rootClass = `pluginui-compressor-slider${isRail ? ' pluginui-compressor-slider--rail' : ''}`

  return (
    <div
      className={rootClass}
      style={inlineStyle}
      data-pluginui-id={node.id}
      title={title}
    >
      <div
        ref={trackRef}
        className="pluginui-compressor-slider-track"
        role="slider"
        tabIndex={0}
        aria-label={label}
        aria-valuemin={meta.min}
        aria-valuemax={meta.max}
        aria-valuenow={Number(value.toFixed(3))}
        aria-valuetext={formatFn(value)}
        onPointerDown={drag.onPointerDown}
        onPointerMove={drag.onPointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
        onDoubleClick={handleDoubleClick}
        onKeyDown={handleKeyDown}
        onWheel={drag.onWheel}
      >
        {isRail
          ? <div className="pluginui-compressor-slider-thumb" style={{ bottom: `${pct}%` }} />
          : <div className="pluginui-compressor-slider-fill" style={{ height: `${pct}%` }} />}
      </div>
      <div className="pluginui-compressor-slider-label">{label}</div>
    </div>
  )
}
