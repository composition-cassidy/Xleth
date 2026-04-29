import { useCallback } from 'react'
import { usePluginUI } from '../PluginUIContext.js'
import { styleToCSS } from '../styleToCSS.js'

export default function ToggleNode({ node }) {
  const { params, setParam } = usePluginUI()
  const { props = {}, style = {} } = node
  const { param: paramId, mode, valueWhenOn, label } = props

  const rawValue = params[paramId] ?? 0

  let isActive = false
  if (mode === 'boolParam') {
    isActive = rawValue >= 0.5
  } else if (mode === 'discreteValue') {
    isActive = Math.round(rawValue) === valueWhenOn
  }

  const handleClick = useCallback(() => {
    if (mode === 'boolParam') {
      setParam(paramId, isActive ? 0 : 1)
    } else if (mode === 'discreteValue') {
      setParam(paramId, valueWhenOn)
    }
  }, [mode, paramId, isActive, valueWhenOn, setParam])

  const inlineStyle = styleToCSS(style)

  return (
    <button
      className={`pluginui-toggle-btn${isActive ? ' active' : ''}`}
      style={inlineStyle}
      onClick={handleClick}
      data-pluginui-id={node.id}
    >
      {label}
    </button>
  )
}
