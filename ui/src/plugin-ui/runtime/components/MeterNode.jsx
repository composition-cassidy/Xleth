import { useRef, useEffect, useCallback } from 'react'
import { usePluginUI } from '../PluginUIContext.js'
import { resolveFormat } from '../formats.js'
import { styleToCSS } from '../styleToCSS.js'

// Vertical/horizontal meter backed by the meterBus.
// DOM updates bypass React state — the update callback writes directly to refs
// exactly as the legacy Compressor/Limiter/OTT panels do.
export default function MeterNode({ node }) {
  const { meterBus } = usePluginUI()
  const { props = {}, style = {} } = node

  const { source, label, unit, range = { min: 0, max: 1 }, orientation = 'vertical', format } = props
  const slotName = source?.slot
  const formatFn = resolveFormat(format)

  const fillRef  = useRef(null)
  const valueRef = useRef(null)

  const update = useCallback((raw) => {
    const span    = (range.max - range.min) || 1
    const clamped = Math.max(range.min, Math.min(range.max, Math.abs(raw)))
    const pct     = (clamped - range.min) / span * 100

    if (orientation === 'vertical') {
      if (fillRef.current)  fillRef.current.style.height = `${Math.min(pct, 100)}%`
    } else {
      if (fillRef.current)  fillRef.current.style.width  = `${Math.min(pct, 100)}%`
    }
    if (valueRef.current) valueRef.current.textContent = formatFn(clamped)
  }, [range, orientation, formatFn])

  useEffect(() => {
    if (!slotName) return
    meterBus.register(node.id, slotName, update)
    return () => meterBus.unregister(node.id)
  }, [node.id, slotName, meterBus, update])

  const inlineStyle = styleToCSS(style)
  const isVertical  = orientation !== 'horizontal'

  return (
    <div
      className={`pluginui-meter pluginui-meter--${isVertical ? 'vertical' : 'horizontal'}`}
      style={inlineStyle}
      data-pluginui-id={node.id}
    >
      <div className="pluginui-meter-track">
        <div className="pluginui-meter-fill" ref={fillRef} />
      </div>
      <div className="pluginui-meter-label">
        {label && <>{label} </>}
        <span ref={valueRef}>0.0</span>
        {unit && <> {unit}</>}
      </div>
    </div>
  )
}
