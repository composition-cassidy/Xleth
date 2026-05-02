import { useState } from 'react'
import { styleToCSS } from '../styleToCSS.js'
import { usePluginUI } from '../PluginUIContext.js'
import DynamicsVisualizerCanvas from '../visualizers/DynamicsVisualizerCanvas.jsx'
import { COMPRESSOR_SOURCE_DEFAULT_PRESET } from '../visualizers/compressorPainter.js'
import { LIMITER_SOURCE_DEFAULT_PRESET } from '../visualizers/limiterPainter.js'
import { TRANSIENT_SOURCE_DEFAULT_PRESET } from '../visualizers/transientPainter.js'
import { MULTIBAND_SOURCE_DEFAULT_PRESET } from '../visualizers/multibandPainter.js'
import { RESONANCE_SOURCE_DEFAULT_PRESET } from '../visualizers/resonancePainter.js'
import ResonanceCurveOverlay from './ResonanceCurveOverlay.jsx'

// Editable overlays the runtime knows how to render on top of a viz canvas.
// Layout-level allow-list, narrow on purpose: if you want a new editable
// surface, add an entry here and a renderer below.
const OVERLAY_RENDERERS = {
  resonanceCurve: ResonanceCurveOverlay,
}

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

// Source keys for the Transient Processor pipeline. Must match
// manifests/transient.js.
const TRANSIENT_SOURCE_KEYS = new Set([
  'transient.shaper',
  'transient.envelope',
  'transient.gainChange',
])

// Source keys for the Overdone (multiband) pipeline. Must match
// manifests/overdone.js.
const OVERDONE_SOURCE_KEYS = new Set([
  'overdone.multiband',
  'overdone.bands',
  'overdone.gainReduction',
])

// Source keys for the Resonance Suppressor spectral visualizer.
const RESONANCE_SOURCE_KEYS = new Set([
  'resonance.combined',
  'resonance.spectrum',
  'resonance.reduction',
  'resonance.weighting',
])

function isKnownSource(source) {
  return COMPRESSOR_SOURCE_KEYS.has(source)
      || LIMITER_SOURCE_KEYS.has(source)
      || TRANSIENT_SOURCE_KEYS.has(source)
      || OVERDONE_SOURCE_KEYS.has(source)
      || RESONANCE_SOURCE_KEYS.has(source)
}

function defaultPresetForSource(source) {
  if (LIMITER_SOURCE_KEYS.has(source)) {
    return LIMITER_SOURCE_DEFAULT_PRESET[source] || 'limiterRealtime'
  }
  if (TRANSIENT_SOURCE_KEYS.has(source)) {
    return TRANSIENT_SOURCE_DEFAULT_PRESET[source] || 'transientShaper'
  }
  if (OVERDONE_SOURCE_KEYS.has(source)) {
    return MULTIBAND_SOURCE_DEFAULT_PRESET[source] || 'overdoneMultiband'
  }
  if (RESONANCE_SOURCE_KEYS.has(source)) {
    return RESONANCE_SOURCE_DEFAULT_PRESET[source] || 'resonanceCombined'
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
      || unavailableReason === 'unsupported-type:limiter'
      || unavailableReason === 'unsupported-type:transient'
      || unavailableReason === 'unsupported-type:multiband'
      || unavailableReason === 'unsupported-type:resonance') {
    return <Placeholder inlineStyle={inlineStyle} nodeId={node.id} />
  }

  const effectivePreset = preset || defaultPresetForSource(source)
  const OverlayComponent = props.overlay && OVERLAY_RENDERERS[props.overlay]
    ? OVERLAY_RENDERERS[props.overlay]
    : null

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
      {OverlayComponent && <OverlayComponent />}
    </div>
  )
}
