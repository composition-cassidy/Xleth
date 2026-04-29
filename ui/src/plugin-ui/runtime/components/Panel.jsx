import { styleToCSS } from '../styleToCSS.js'

export default function Panel({ node, renderChildren }) {
  const style = styleToCSS(node.style)
  return (
    <div className="pluginui-panel" style={style} data-pluginui-id={node.id}>
      {renderChildren()}
    </div>
  )
}
