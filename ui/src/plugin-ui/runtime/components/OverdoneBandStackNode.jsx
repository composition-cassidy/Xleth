import React, { useCallback, useState } from 'react'
import { usePluginUI } from '../PluginUIContext.js'
import { resolveFormat } from '../formats.js'
import { styleToCSS } from '../styleToCSS.js'
import PluginUIKitKnob from './PluginUIKitKnob.jsx'
import DynamicsVisualizerCanvas from '../visualizers/DynamicsVisualizerCanvas.jsx'
import { MULTIBAND_DISPLAY } from '../visualizers/multibandPainter.js'

// Overdone middle section: the three stacked band lanes (LOW / MID / HIGH)
// with a per-band gain knob sitting beside its lane on the left, under a
// shared GAIN label. Each gain knob is tinted with its band's identity color
// (the same values the multiband painter uses for the lanes).
//
// Layout props:
//   heightPx  — canvas height; the gain-knob cells stretch over the same
//               height so each knob stays vertically centered on its lane.
//   lowParam / midParam / highParam — optional param bindings
//               (default gain_low / gain_mid / gain_high).

const BANDS = Object.freeze([
  Object.freeze({ key: 'low',  prop: 'lowParam',  fallbackParam: 'gain_low',  color: MULTIBAND_DISPLAY.bandColors.low }),
  Object.freeze({ key: 'mid',  prop: 'midParam',  fallbackParam: 'gain_mid',  color: MULTIBAND_DISPLAY.bandColors.mid }),
  Object.freeze({ key: 'high', prop: 'highParam', fallbackParam: 'gain_high', color: MULTIBAND_DISPLAY.bandColors.high }),
])

const KNOB_APPEARANCE = Object.freeze({ preset: 'mixer-ring', sizePreset: 'inherit' })

function Placeholder({ inlineStyle, nodeId, label }) {
  return (
    <div className="pluginui-visualizer-placeholder" style={inlineStyle} data-pluginui-id={nodeId}>
      <span className="pluginui-visualizer-placeholder-text">
        {label || 'Visualization unavailable'}
      </span>
    </div>
  )
}

export default function OverdoneBandStackNode({ node }) {
  const { props = {}, style = {} } = node
  const ctx = usePluginUI()
  const [unavailableReason, setUnavailableReason] = useState(null)

  const heightPx = Number.isFinite(props.heightPx) ? props.heightPx : 168
  const inlineStyle = styleToCSS(style)

  const handleUnavailable = useCallback((reason) => setUnavailableReason(reason), [])

  if (!ctx?.target || !ctx?.manifest) {
    return <Placeholder inlineStyle={inlineStyle} nodeId={node.id} />
  }

  const apiAvailable =
    typeof window?.xleth?.audio?.setEffectVisualizationEnabled === 'function' &&
    typeof window?.xleth?.audio?.drainEffectVizFrames === 'function'
  if (!apiAvailable) {
    return <Placeholder inlineStyle={inlineStyle} nodeId={node.id} />
  }

  if (unavailableReason && unavailableReason.startsWith('schema-mismatch')) {
    return <Placeholder inlineStyle={inlineStyle} nodeId={node.id} />
  }
  if (unavailableReason === 'no-engine-api' || unavailableReason === 'unsupported-type:multiband') {
    return <Placeholder inlineStyle={inlineStyle} nodeId={node.id} />
  }

  const { manifest, params, setParam, target } = ctx

  return (
    <div className="pluginui-overdone-bandstack" style={inlineStyle} data-pluginui-id={node.id}>
      <div className="pluginui-overdone-bandstack-gains">
        <div className="pluginui-overdone-bandstack-label">GAIN</div>
        <div className="pluginui-overdone-bandstack-gain-cells" style={{ height: `${heightPx}px` }}>
          {BANDS.map((band) => {
            const paramId = props[band.prop] || band.fallbackParam
            const meta = manifest.params?.[paramId]
            if (!meta) return null
            const value = params[paramId] ?? meta.defaultValue
            const formatFn = resolveFormat(props.format || meta.format)
            return (
              <div className="pluginui-overdone-bandstack-gain-cell" key={band.key}>
                <PluginUIKitKnob
                  value={value}
                  min={meta.min}
                  max={meta.max}
                  defaultValue={meta.defaultValue}
                  formatValue={formatFn}
                  onLiveChange={(v) => setParam(paramId, v)}
                  onCommit={(v) => setParam(paramId, v)}
                  size={props.knobSize ?? 40}
                  dragRange={props.dragRange ?? 150}
                  appearance={KNOB_APPEARANCE}
                  accentColor={band.color}
                />
              </div>
            )
          })}
        </div>
      </div>
      <div className="pluginui-overdone-bandstack-viz">
        <div className="pluginui-overdone-bandstack-label" aria-hidden="true" />
        <DynamicsVisualizerCanvas
          trackId={target.trackId}
          nodeId={target.nodeId}
          sourceKey="overdone.bands"
          preset="overdoneBands"
          heightPx={heightPx}
          params={params}
          onUnavailable={handleUnavailable}
        />
      </div>
    </div>
  )
}
