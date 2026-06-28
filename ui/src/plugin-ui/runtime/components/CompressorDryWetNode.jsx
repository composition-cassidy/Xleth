import { useCallback, useMemo, useRef } from 'react'
import { usePluginUI } from '../PluginUIContext.js'
import { resolveFormat } from '../formats.js'
import { styleToCSS } from '../styleToCSS.js'

function clamp(value, min = 0, max = 100) {
  return Math.min(max, Math.max(min, value))
}

function percentFromPointer(event, element) {
  const rect = element.getBoundingClientRect()
  const y = clamp(event.clientY - rect.top, 0, Math.max(1, rect.height))
  return clamp((1 - y / Math.max(1, rect.height)) * 100)
}

function DryWetRail({
  label,
  value,
  linked,
  onChange,
}) {
  const draggingRef = useRef(false)
  const formatPct = useMemo(() => resolveFormat('pct0'), [])

  const commitFromPointer = useCallback((event) => {
    onChange(percentFromPointer(event, event.currentTarget))
  }, [onChange])

  const handlePointerDown = useCallback((event) => {
    draggingRef.current = true
    event.currentTarget.setPointerCapture?.(event.pointerId)
    commitFromPointer(event)
    event.preventDefault()
  }, [commitFromPointer])

  const handlePointerMove = useCallback((event) => {
    if (!draggingRef.current) return
    commitFromPointer(event)
    event.preventDefault()
  }, [commitFromPointer])

  const handlePointerUp = useCallback((event) => {
    draggingRef.current = false
    event.currentTarget.releasePointerCapture?.(event.pointerId)
  }, [])

  const handleKeyDown = useCallback((event) => {
    let next = value
    const step = event.shiftKey ? 5 : 1
    if (event.key === 'ArrowUp' || event.key === 'ArrowRight') next += step
    else if (event.key === 'ArrowDown' || event.key === 'ArrowLeft') next -= step
    else if (event.key === 'Home') next = 0
    else if (event.key === 'End') next = 100
    else return
    onChange(clamp(next))
    event.preventDefault()
  }, [onChange, value])

  return (
    <div
      className="pluginui-compressor-drywet-rail"
      title={`${label}: ${formatPct(value)}`}
    >
      <div
        className="pluginui-compressor-slider-track"
        role="slider"
        tabIndex={0}
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(value)}
        aria-valuetext={formatPct(value)}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
        onKeyDown={handleKeyDown}
      >
        <div className="pluginui-compressor-slider-fill" style={{ height: `${clamp(value)}%` }} />
      </div>
      <div className="pluginui-compressor-slider-label">{label}</div>
    </div>
  )
}

export default function CompressorDryWetNode({ node }) {
  const { manifest, params, setParam } = usePluginUI()
  const { props = {}, style = {} } = node

  const mixParam = props.mixParam || 'mix'
  const dryParam = props.dryParam || 'dry'
  const wetParam = props.wetParam || 'wet'
  const linkParam = props.linkParam || 'mix_linked'

  if (!manifest?.params?.[mixParam] || !manifest?.params?.[dryParam]
      || !manifest?.params?.[wetParam] || !manifest?.params?.[linkParam]) {
    return null
  }

  const mix = clamp(params[mixParam] ?? manifest.params[mixParam].defaultValue)
  const linked = (params[linkParam] ?? manifest.params[linkParam].defaultValue) >= 0.5
  const dry = linked
    ? 100 - mix
    : clamp(params[dryParam] ?? manifest.params[dryParam].defaultValue)
  const wet = linked
    ? mix
    : clamp(params[wetParam] ?? manifest.params[wetParam].defaultValue)

  const setLinkedWet = useCallback((nextWet) => {
    const wetValue = clamp(nextWet)
    setParam(wetParam, wetValue)
    setParam(dryParam, 100 - wetValue)
    setParam(mixParam, wetValue)
  }, [dryParam, mixParam, setParam, wetParam])

  const setLinkedDry = useCallback((nextDry) => {
    const dryValue = clamp(nextDry)
    setParam(dryParam, dryValue)
    setParam(wetParam, 100 - dryValue)
    setParam(mixParam, 100 - dryValue)
  }, [dryParam, mixParam, setParam, wetParam])

  const setDry = useCallback((nextDry) => {
    if (linked) setLinkedDry(nextDry)
    else setParam(dryParam, clamp(nextDry))
  }, [dryParam, linked, setLinkedDry, setParam])

  const setWet = useCallback((nextWet) => {
    if (linked) setLinkedWet(nextWet)
    else setParam(wetParam, clamp(nextWet))
  }, [linked, setLinkedWet, setParam, wetParam])

  const toggleLinked = useCallback(() => {
    if (linked) {
      setParam(dryParam, 100 - mix)
      setParam(wetParam, mix)
      setParam(linkParam, 0)
      return
    }
    const nextWet = clamp(wet)
    setParam(wetParam, nextWet)
    setParam(dryParam, 100 - nextWet)
    setParam(mixParam, nextWet)
    setParam(linkParam, 1)
  }, [dryParam, linkParam, linked, mix, mixParam, setParam, wet, wetParam])

  return (
    <div
      className={`pluginui-compressor-drywet${linked ? ' pluginui-compressor-drywet--linked' : ''}`}
      style={styleToCSS(style)}
      data-pluginui-id={node.id}
    >
      <div className="pluginui-compressor-drywet-rails">
        <DryWetRail label="DRY" value={dry} linked={linked} onChange={setDry} />
        <button
          type="button"
          className={`pluginui-compressor-link-btn${linked ? ' active' : ''}`}
          onClick={toggleLinked}
          aria-pressed={linked}
        >
          LINK
        </button>
        <DryWetRail label="WET" value={wet} linked={linked} onChange={setWet} />
      </div>
    </div>
  )
}
