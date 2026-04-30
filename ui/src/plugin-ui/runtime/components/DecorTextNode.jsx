import React from 'react'
import { resolveTokenCssVar } from '../../appearance/tokenSlots.js'

export default function DecorTextNode({ node }) {
  const { props = {} } = node
  const {
    text          = '',
    variant       = 'default',
    align         = 'left',
    letterSpacing = 'normal',
    textToken,
  } = props

  const cls = [
    'pluginui-decor-text',
    variant !== 'default' && `pluginui-decor-text--${variant}`,
    letterSpacing !== 'normal' && `pluginui-decor-text--ls-${letterSpacing}`,
  ].filter(Boolean).join(' ')

  const style = { textAlign: align }
  const cssVar = resolveTokenCssVar(textToken, 'text.primary')
  if (cssVar) style.color = `var(${cssVar})`

  return (
    <span
      className={cls}
      style={style}
      data-pluginui-id={node.id}
    >
      {text}
    </span>
  )
}
