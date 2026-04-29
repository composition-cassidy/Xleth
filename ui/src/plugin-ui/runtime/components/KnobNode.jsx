import { useCallback } from 'react'
import { usePluginUI } from '../PluginUIContext.js'
import { resolveFormat } from '../formats.js'
import { styleToCSS } from '../styleToCSS.js'
import BaseKnob from '../../../components/sampler/Knob.jsx'

export default function KnobNode({ node }) {
  const { target, manifest, params, setParam } = usePluginUI()
  const { props = {}, style = {} } = node
  const paramId = props.param

  const meta = manifest?.params?.[paramId]
  if (!meta) return null   // validator should have caught this; guard anyway

  const value        = params[paramId] ?? meta.defaultValue
  const formatFn     = resolveFormat(props.format || meta.format)
  const inlineStyle  = styleToCSS(style)

  const handleLiveChange = useCallback(v => setParam(paramId, v), [paramId, setParam])
  const handleCommit     = useCallback(v => setParam(paramId, v), [paramId, setParam])

  return (
    <div className="pluginui-knob-cell" style={inlineStyle} data-pluginui-id={node.id}>
      <BaseKnob
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
        color={props.color}
      />
    </div>
  )
}
