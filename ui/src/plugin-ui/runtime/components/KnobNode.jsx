import React, { useCallback } from 'react'
import { usePluginUI } from '../PluginUIContext.js'
import { resolveFormat } from '../formats.js'
import { styleToCSS } from '../styleToCSS.js'
import PluginUIKitKnob from './PluginUIKitKnob.jsx'

export default function KnobNode({ node }) {
  const { target, manifest, params, setParam } = usePluginUI()
  const { props = {}, style = {} } = node
  const paramId = props.param

  const meta = manifest?.params?.[paramId]
  if (!meta) return null   // validator should have caught this; guard anyway

  const value        = params[paramId] ?? meta.defaultValue
  const formatFn     = resolveFormat(props.format || meta.format)
  const inlineStyle  = styleToCSS(style)

  // Optional mode-gated dimming: the schema has no visibility-expression
  // support (checked before adding this — see distortion.json), so a knob
  // that only applies to some discrete-param values dims itself instead of
  // disappearing. Plugins that don't set props.enabledWhen are unaffected.
  const gate = props.enabledWhen
  let gateActive = true
  if (gate && Array.isArray(gate.in)) {
    const gateMeta  = manifest?.params?.[gate.param]
    const gateValue = params[gate.param] ?? gateMeta?.defaultValue ?? 0
    gateActive = gate.in.includes(Math.round(gateValue))
  }

  const handleLiveChange = useCallback(v => setParam(paramId, v), [paramId, setParam])
  const handleCommit     = useCallback(v => setParam(paramId, v), [paramId, setParam])

  const cellClassName = `pluginui-knob-cell${gateActive ? '' : ' pluginui-knob-cell--dimmed'}`

  return (
    <div className={cellClassName} style={inlineStyle} data-pluginui-id={node.id} aria-disabled={gateActive ? undefined : 'true'}>
      <PluginUIKitKnob
        value={value}
        min={meta.min}
        max={meta.max}
        defaultValue={meta.defaultValue}
        label={props.label ?? meta.label}
        formatValue={formatFn}
        onLiveChange={handleLiveChange}
        onCommit={handleCommit}
        size={props.size ?? 52}
        dragRange={props.dragRange ?? 150}
        appearance={props.appearance}
      />
    </div>
  )
}
