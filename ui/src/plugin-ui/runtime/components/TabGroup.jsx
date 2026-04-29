import { useState } from 'react'
import { styleToCSS } from '../styleToCSS.js'

// TabGroup renders its direct children as tab pages.
// Each child node must declare props.tabLabel for the tab header.
// Only the active tab is mounted (not just hidden) to keep render cost low.
export default function TabGroup({ node, renderChildren }) {
  const children = node.children || []
  const [activeIdx, setActiveIdx] = useState(0)
  const inlineStyle = styleToCSS(node.style)

  if (children.length === 0) return null

  const activeChild = children[Math.min(activeIdx, children.length - 1)]
  const tabLabels   = children.map(c => c.props?.tabLabel || c.id)

  return (
    <div className="pluginui-tabgroup" style={inlineStyle} data-pluginui-id={node.id}>
      <div className="pluginui-tabgroup-headers">
        {tabLabels.map((label, idx) => (
          <button
            key={idx}
            className={`pluginui-tabgroup-tab${idx === activeIdx ? ' active' : ''}`}
            onClick={() => setActiveIdx(idx)}
          >
            {label}
          </button>
        ))}
      </div>
      <div className="pluginui-tabgroup-body">
        {/* renderChildren returns all children; we only want the active one.
            Pass the active child node through the parent renderChildren fn
            by temporarily overriding node.children. */}
        {renderChildren([activeChild])}
      </div>
    </div>
  )
}
