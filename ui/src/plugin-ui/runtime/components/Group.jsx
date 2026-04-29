import { styleToCSS } from '../styleToCSS.js'

export default function Group({ node, renderChildren }) {
  const { props = {}, style = {} } = node
  const inlineStyle = styleToCSS(style)

  if (props.columns && props.columns > 0) {
    inlineStyle.display              = 'grid'
    inlineStyle.gridTemplateColumns  = `repeat(${props.columns}, 1fr)`
  }

  return (
    <div className="pluginui-group" style={inlineStyle} data-pluginui-id={node.id}>
      {props.title != null && (
        <div className="pluginui-group-title">{props.title}</div>
      )}
      {renderChildren()}
    </div>
  )
}
