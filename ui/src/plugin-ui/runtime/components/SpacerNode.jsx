import { styleToCSS } from '../styleToCSS.js'

export default function SpacerNode({ node }) {
  const inlineStyle = { flex: 1, ...styleToCSS(node.style) }
  return <div className="pluginui-spacer" style={inlineStyle} aria-hidden="true" data-pluginui-id={node.id} />
}
