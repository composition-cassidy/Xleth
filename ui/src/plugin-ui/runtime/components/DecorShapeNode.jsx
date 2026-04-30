import React from 'react'
import { resolveTokenCssVar } from '../../appearance/tokenSlots.js'

export default function DecorShapeNode({ node }) {
  const { props = {} } = node
  const {
    shape        = 'rect',
    cornerRadius = 0,
    fillToken,
    strokeToken,
    strokeWidth  = 0,
    opacity      = 100,
  } = props

  const fillCssVar   = fillToken   && fillToken   !== 'fill.none'   ? resolveTokenCssVar(fillToken)   : null
  const strokeCssVar = strokeToken && strokeToken !== 'stroke.none' ? resolveTokenCssVar(strokeToken) : null

  const style = {
    display:    'block',
    width:      '100%',
    height:     '100%',
    opacity:    opacity / 100,
    boxSizing:  'border-box',
  }

  if (fillCssVar) {
    style.backgroundColor = `var(${fillCssVar})`
  }

  if (strokeCssVar && strokeWidth > 0) {
    style.border = `${strokeWidth}px solid var(${strokeCssVar})`
  }

  if (shape === 'circle') {
    style.borderRadius = '50%'
  } else if (shape === 'pill') {
    style.borderRadius = '9999px'
  } else if (shape === 'roundedRect') {
    style.borderRadius = `${cornerRadius}px`
  }
  // 'rect' gets no border-radius

  return (
    <div
      className={`pluginui-decor-shape pluginui-decor-shape--${shape}`}
      style={style}
      aria-hidden="true"
      data-pluginui-id={node.id}
    />
  )
}
