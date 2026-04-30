import React from 'react'
import { resolveTokenCssVar } from '../../appearance/tokenSlots.js'

const THICKNESS_PX = { hair: 1, thin: 2, medium: 3, thick: 4 }

export default function DecorLineNode({ node }) {
  const { props = {} } = node
  const {
    orientation = 'horizontal',
    thickness   = 'hair',
    lineStyle   = 'solid',
    strokeToken,
  } = props

  const thickPx = THICKNESS_PX[thickness] ?? 1
  const cssVar  = resolveTokenCssVar(strokeToken, 'text.subtle')
  const color   = cssVar ? `var(${cssVar})` : 'currentColor'
  const border  = `${thickPx}px ${lineStyle} ${color}`

  const style = { display: 'block', width: '100%', height: '100%' }
  if (orientation === 'horizontal') {
    style.borderTop    = border
    style.borderRight  = 'none'
    style.borderBottom = 'none'
    style.borderLeft   = 'none'
  } else {
    style.borderTop    = 'none'
    style.borderRight  = 'none'
    style.borderBottom = 'none'
    style.borderLeft   = border
  }

  return (
    <div
      className={`pluginui-decor-line pluginui-decor-line--${orientation}`}
      style={style}
      aria-hidden="true"
      data-pluginui-id={node.id}
    />
  )
}
