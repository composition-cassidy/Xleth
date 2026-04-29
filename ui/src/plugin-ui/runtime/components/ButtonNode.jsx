import { useCallback } from 'react'
import { usePluginUI } from '../PluginUIContext.js'
import { resolveAction, isKnownAction } from '../actions.js'
import { styleToCSS } from '../styleToCSS.js'

export default function ButtonNode({ node }) {
  const ctx = usePluginUI()
  const { props = {}, style = {} } = node
  const { action, label } = props

  const known = isKnownAction(action)

  const handleClick = useCallback(() => {
    const fn = resolveAction(action)
    if (fn) fn({ close: ctx.onClose, target: ctx.target, manifest: ctx.manifest })
  }, [action, ctx])

  const inlineStyle = styleToCSS(style)

  return (
    <button
      className="pluginui-button"
      style={inlineStyle}
      onClick={handleClick}
      disabled={!known}
      title={!known ? `Unknown action: ${action}` : undefined}
      data-pluginui-id={node.id}
    >
      {label}
    </button>
  )
}
