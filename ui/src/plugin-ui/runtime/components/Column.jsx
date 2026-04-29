import { styleToCSS } from '../styleToCSS.js'

export default function Column({ node, renderChildren }) {
  const inlineStyle = styleToCSS(node.style)
  return (
    <div className="pluginui-column" style={inlineStyle} data-pluginui-id={node.id}>
      {renderChildren()}
    </div>
  )
}
