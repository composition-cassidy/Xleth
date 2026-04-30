import React from 'react'
import { applyFrameStyle } from '../freeformGeometry.js'
import { resolveFreeformChildComponent } from '../freeformChildRegistry.js'

export default function FreeformLayerNode({ node }) {
  const { style = {}, props = {} } = node
  const children = Array.isArray(node.children) ? node.children : []

  const containerStyle = {
    position: 'relative',
    overflow: props.clip === 'visible' ? 'visible' : 'hidden',
  }
  if (typeof style.widthPx  === 'number') containerStyle.width  = `${style.widthPx}px`
  if (typeof style.heightPx === 'number') containerStyle.height = `${style.heightPx}px`

  return (
    <div className="pluginui-freeform" style={containerStyle} data-pluginui-id={node.id}>
      {children.map(child => {
        if (!child) return null
        if (child._invalid) {
          return (
            <div
              key={child.id ?? `_ff_invalid_${Math.random()}`}
              className="pluginui-freeform-invalid-child"
              aria-hidden="true"
            />
          )
        }
        const Component = resolveFreeformChildComponent(child.type)
        if (!Component) return null
        const frameStyle = applyFrameStyle(child.props?.frame)
        return (
          // data-pluginui-id on the frame wrapper lets SelectionOverlay position
          // the outline at the frame boundary rather than the component's inner div.
          <div
            key={child.id}
            style={frameStyle}
            data-pluginui-frame-id={child.id}
            data-pluginui-id={child.id}
          >
            <Component node={child} renderChildren={() => []} />
          </div>
        )
      })}
    </div>
  )
}
