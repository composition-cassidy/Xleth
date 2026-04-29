import { styleToCSS } from '../styleToCSS.js'

export default function LabelNode({ node }) {
  const { props = {}, style = {} } = node
  const { text, variant } = props

  const cls = [
    'pluginui-label',
    variant === 'muted'  && 'pluginui-label--muted',
    variant === 'header' && 'pluginui-label--header',
  ].filter(Boolean).join(' ')

  return (
    <span className={cls} style={styleToCSS(style)} data-pluginui-id={node.id}>
      {text}
    </span>
  )
}
