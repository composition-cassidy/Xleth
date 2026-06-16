import React, { forwardRef, useCallback, useRef } from 'react'

function clamp(value, min, max) {
  const n = Number(value)
  if (!Number.isFinite(n)) return min
  return Math.min(max, Math.max(min, n))
}

function polar(cx, cy, radius, deg) {
  const rad = (deg * Math.PI) / 180
  return [cx + radius * Math.cos(rad), cy + radius * Math.sin(rad)]
}

function arcPath(cx, cy, radius, startDeg, endDeg) {
  const [sx, sy] = polar(cx, cy, radius, startDeg)
  const [ex, ey] = polar(cx, cy, radius, endDeg)
  const delta = ((endDeg - startDeg) + 360) % 360
  const large = delta > 180 ? 1 : 0
  return `M ${sx.toFixed(2)},${sy.toFixed(2)} A ${radius},${radius} 0 ${large},1 ${ex.toFixed(2)},${ey.toFixed(2)}`
}

export default forwardRef(function XlethKnob({
  value = 0,
  min = 0,
  max = 1,
  label,
  className = '',
  onChange,
  onCommit,
  'aria-label': ariaLabel,
}, ref) {
  const svgRef = useRef(null)
  const dragRef = useRef(null)
  const current = clamp(value, min, max)
  const range = Math.max(Number.EPSILON, max - min)
  const normalized = (current - min) / range
  const cx = 50
  const cy = 50
  const radius = 34
  const startDeg = 225
  const sweepDeg = 270
  const valueAngle = startDeg + normalized * sweepDeg
  const bgPath = arcPath(cx, cy, radius, startDeg, startDeg + sweepDeg - 0.01)
  const valPath = normalized > 0.01 ? arcPath(cx, cy, radius, startDeg, valueAngle) : null
  const [dotX, dotY] = polar(cx, cy, radius, valueAngle)

  const assignRef = (node) => {
    svgRef.current = node
    if (typeof ref === 'function') ref(node)
    else if (ref) ref.current = node
  }

  const handlePointerDown = useCallback((event) => {
    event.preventDefault()
    event.currentTarget.setPointerCapture(event.pointerId)
    dragRef.current = {
      startY: event.clientY,
      startValue: current,
      currentValue: current,
    }
  }, [current])

  const handlePointerMove = useCallback((event) => {
    if (!dragRef.current) return
    const dy = dragRef.current.startY - event.clientY
    const next = clamp(dragRef.current.startValue + dy * range * 0.008, min, max)
    dragRef.current.currentValue = next
    onChange?.(next)
  }, [max, min, onChange, range])

  const commitDrag = useCallback(() => {
    if (!dragRef.current) return
    onCommit?.(dragRef.current.currentValue)
    dragRef.current = null
  }, [onCommit])

  return (
    <div className={`xleth-knob ${className}`.trim()}>
      <svg
        ref={assignRef}
        className="xleth-knob__dial"
        viewBox="0 0 100 100"
        role="slider"
        aria-label={ariaLabel || label || 'Knob'}
        aria-valuemin={min}
        aria-valuemax={max}
        aria-valuenow={current}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={commitDrag}
        onPointerCancel={commitDrag}
      >
        <path className="xleth-knob__track" d={bgPath} />
        {valPath && <path className="xleth-knob__value" d={valPath} />}
        <circle className="xleth-knob__cap" cx={cx} cy={cy} r="22" />
        <circle className="xleth-knob__dot" cx={dotX.toFixed(2)} cy={dotY.toFixed(2)} r="4" />
      </svg>
      {label && <span className="xleth-knob__label">{label}</span>}
    </div>
  )
})
