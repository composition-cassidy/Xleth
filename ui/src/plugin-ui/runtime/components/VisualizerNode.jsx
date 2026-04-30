import { useState } from 'react'
import { styleToCSS } from '../styleToCSS.js'
import { usePluginUI } from '../PluginUIContext.js'
import DynamicsVisualizerCanvas from '../visualizers/DynamicsVisualizerCanvas.jsx'
import { COMPRESSOR_SOURCE_DEFAULT_PRESET } from '../visualizers/compressorPainter.js'
import { LIMITER_SOURCE_DEFAULT_PRESET } from '../visualizers/limiterPainter.js'

// Source keys this node knows how to render via the Compressor pipeline.
// Must match the manifest allow-list (compressor.js).
const COMPRESSOR_SOURCE_KEYS = new Set([
  'compressor.levelHistory',
  'compressor.gainReductionHistory',
  'compressor.transferCurve',
  'compressor.detector',
  'compressor.combined',
])

// Source keys for the Limiter pipeline. Must match limiter.js manifest.
const LIMITER_SOURCE_KEYS = new Set([
  'limiter.realtime',
  'limiter.gainReductionHistory',
  'limiter.meterOnly',
])

function isKnownSource(source) {
  return COMPRESSOR_SOURCE_KEYS.has(source) || LIMITER_SOURCE_KEYS.has(source)
}

function defaultPresetForSource(source) {
  if (LIMITER_SOURCE_KEYS.has(source)) {
    return LIMITER_SOURCE_DEFAULT_PRESET[source] || 'limiterRealtime'
  }
  return COMPRESSOR_SOURCE_DEFAULT_PRESET[source] || 'levelHistory'
}

function Placeholder({ inlineStyle, label, nodeId }) {
  return (
    <div className="pluginui-visualizer-placeholder" style={inlineStyle} data-pluginui-id={nodeId}>
      <span className="pluginui-visualizer-placeholder-text">
        {label || 'Visualization unavailable'}
      </span>
    </div>
  )
}

export default function VisualizerNode({ node }) {
  const { props = {}, style = {}, _vizUnavailable } = node
  const { heightPx, source, preset } = props
  const ctx = usePluginUI()
  const [unavailableReason, setUnavailableReason] = useState(null)

  const inlineStyle = {
    ...styleToCSS(style),
    ...(heightPx ? { height: `${heightPx}px` } : {}),
  }

  // Soft-error path from validator: source not in manifest allow-list.
  if (_vizUnavailable) {
    return <Placeholder inlineStyle={inlineStyle} nodeId={node.id} />
  }

  // No engine target → nothing to subscribe to.
  if (!ctx?.target) {
    return <Placeholder inlineStyle={inlineStyle} nodeId={node.id} />
  }

  // Missing engine API at runtime (e.g., older bridge build) → placeholder.
  const apiAvailable =
    typeof window?.xleth?.audio?.setEffectVisualizationEnabled === 'function' &&
    typeof window?.xleth?.audio?.drainEffectVizFrames === 'function'
  if (!apiAvailable) {
    return <Placeholder inlineStyle={inlineStyle} nodeId={node.id} />
  }

  // Unknown source key (defence in depth — manifest already gates this).
  if (!isKnownSource(source)) {
    return <Placeholder inlineStyle={inlineStyle} nodeId={node.id} />
  }

  // Schema mismatch surfaced from the subscription → placeholder.
  if (unavailableReason && unavailableReason.startsWith('schema-mismatch')) {
    return <Placeholder inlineStyle={inlineStyle} nodeId={node.id} />
  }
  if (unavailableReason === 'no-engine-api'
      || unavailableReason === 'unsupported-type:compressor'
      || unavailableReason === 'unsupported-type:limiter') {
    return <Placeholder inlineStyle={inlineStyle} nodeId={node.id} />
  }

  const effectivePreset = preset || defaultPresetForSource(source)

  return (
    <div className="pluginui-visualizer-canvas-wrap" style={inlineStyle} data-pluginui-id={node.id}>
      <DynamicsVisualizerCanvas
        trackId={ctx.target.trackId}
        nodeId={ctx.target.nodeId}
        sourceKey={source}
        preset={effectivePreset}
        heightPx={heightPx || 110}
        params={ctx.params}
        onUnavailable={setUnavailableReason}
      />
    </div>
  )
}
