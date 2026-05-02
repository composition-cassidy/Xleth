import { styleToCSS } from '../styleToCSS.js'

export default function Row({ node, renderChildren }) {
  const { props = {}, style = {} } = node
  const inlineStyle = styleToCSS(style)

  const cls = [
    'pluginui-row',
    props.variant === 'borderTop'    && 'pluginui-row--border-top',
    props.variant === 'borderBottom' && 'pluginui-row--border-bottom',
    props.variant === 'segmented'    && 'pluginui-row--segmented',
    props.variant === 'header'       && 'pluginui-row--header',
    props.variant === 'section'      && 'pluginui-row--section',
  ].filter(Boolean).join(' ')

  return (
    <div className={cls} style={inlineStyle} data-pluginui-id={node.id}>
      {renderChildren()}
    </div>
  )
}
