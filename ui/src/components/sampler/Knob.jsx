import { useRef, useEffect, useState, useCallback } from 'react'

// Circular knob — FL-style vertical drag.
// Drag up = increase, drag down = decrease. Double-click to type a value.
// Shift = fine adjust (10x slower). Ctrl/Cmd+click = reset to defaultValue.
//
// Props:
//   value            current value (required)
//   min, max         numeric bounds (required)
//   defaultValue     ctrl+click reset target (default: min)
//   label            text below the knob (e.g. "SMP Start")
//   formatValue      optional (v) => string for center readout
//   onLiveChange     (v) => void  — called continuously during drag
//   onCommit         (v) => void  — called on drag-end / blur of text input
//   size             pixel diameter (default 52)
//   dragRange        pixels of vertical travel = full min→max sweep (default 180)

const KNOB_COLOR = '#33CED6'
const TRACK_COLOR = 'rgba(255,255,255,0.08)'
const BG_COLOR = '#1A1A24'
const BORDER_COLOR = '#2A2A38'

export default function Knob({
  value,
  min,
  max,
  defaultValue,
  label,
  formatValue,
  onLiveChange,
  onCommit,
  size = 52,
  dragRange = 180,
}) {
  const canvasRef = useRef(null)
  const dragRef = useRef(null) // { startY, startValue, fine }
  const liveValueRef = useRef(value)
  const [editing, setEditing] = useState(false)
  const [editText, setEditText] = useState('')

  const clamp = useCallback((v) => Math.max(min, Math.min(max, v)), [min, max])

  const fraction = (max - min) > 0 ? (clamp(value) - min) / (max - min) : 0

  // Draw the knob
  useEffect(() => {
    const c = canvasRef.current
    if (!c) return
    const dpr = window.devicePixelRatio || 1
    c.width = size * dpr
    c.height = size * dpr
    c.style.width = `${size}px`
    c.style.height = `${size}px`
    const ctx = c.getContext('2d')
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, size, size)

    const cx = size / 2
    const cy = size / 2
    const outerR = size / 2 - 2
    const trackR = outerR - 3
    const knobR  = outerR - 7

    // FL-style arc sweeps from bottom-left to bottom-right.
    const startAngle = Math.PI * 0.75   // 135° (bottom-left)
    const endAngle   = Math.PI * 2.25   // 405° / 45° (bottom-right), going clockwise
    const totalSweep = endAngle - startAngle

    // Background disc
    ctx.fillStyle = BG_COLOR
    ctx.beginPath()
    ctx.arc(cx, cy, outerR, 0, Math.PI * 2)
    ctx.fill()
    ctx.strokeStyle = BORDER_COLOR
    ctx.lineWidth = 1
    ctx.stroke()

    // Track (full arc)
    ctx.strokeStyle = TRACK_COLOR
    ctx.lineWidth = 2.5
    ctx.beginPath()
    ctx.arc(cx, cy, trackR, startAngle, endAngle)
    ctx.stroke()

    // Value arc
    const valueAngle = startAngle + totalSweep * fraction
    ctx.strokeStyle = KNOB_COLOR
    ctx.lineWidth = 2.5
    ctx.beginPath()
    ctx.arc(cx, cy, trackR, startAngle, valueAngle)
    ctx.stroke()

    // Pointer line from centre toward current angle
    const px = cx + Math.cos(valueAngle) * knobR
    const py = cy + Math.sin(valueAngle) * knobR
    ctx.strokeStyle = KNOB_COLOR
    ctx.lineWidth = 2
    ctx.lineCap = 'round'
    ctx.beginPath()
    ctx.moveTo(cx, cy)
    ctx.lineTo(px, py)
    ctx.stroke()
    ctx.lineCap = 'butt'
  }, [size, fraction])

  // Drag handling
  const handleMouseDown = useCallback((e) => {
    // Ctrl/Cmd + click → reset
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault()
      const resetTo = defaultValue != null ? defaultValue : min
      onLiveChange?.(resetTo)
      onCommit?.(resetTo)
      return
    }
    e.preventDefault()
    dragRef.current = {
      startY: e.clientY,
      startValue: clamp(value),
      fine: e.shiftKey,
    }
    document.body.style.cursor = 'ns-resize'
  }, [value, clamp, defaultValue, min, onLiveChange, onCommit])

  useEffect(() => {
    const onMove = (e) => {
      const d = dragRef.current
      if (!d) return
      const dy = d.startY - e.clientY
      const range = max - min
      const sensitivity = (e.shiftKey || d.fine) ? 10 : 1
      const delta = (dy / dragRange) * range / sensitivity
      const next = clamp(d.startValue + delta)
      liveValueRef.current = next
      onLiveChange?.(next)
    }
    const onUp = () => {
      if (!dragRef.current) return
      dragRef.current = null
      document.body.style.cursor = ''
      onCommit?.(liveValueRef.current)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
  }, [max, min, dragRange, clamp, onLiveChange, onCommit])

  // Keep liveValueRef in sync when value changes externally (e.g. after fetchAll)
  useEffect(() => { liveValueRef.current = value }, [value])

  // Scroll wheel
  const handleWheel = useCallback((e) => {
    e.preventDefault()
    const range = max - min
    const sensitivity = e.shiftKey ? 500 : 100
    const delta = -(e.deltaY / sensitivity) * range / 20
    const next = clamp(value + delta)
    onLiveChange?.(next)
    onCommit?.(next)
  }, [value, clamp, max, min, onLiveChange, onCommit])

  // Double-click to edit
  const handleDoubleClick = useCallback(() => {
    setEditing(true)
    setEditText(String(Math.round(value)))
  }, [value])

  const commitEdit = useCallback(() => {
    const n = Number(editText)
    if (!Number.isNaN(n)) {
      const c = clamp(n)
      onLiveChange?.(c)
      onCommit?.(c)
    }
    setEditing(false)
  }, [editText, clamp, onLiveChange, onCommit])

  const display = formatValue ? formatValue(value) : String(Math.round(value))

  return (
    <div style={{
      display: 'flex', flexDirection: 'column', alignItems: 'center',
      gap: 2, userSelect: 'none',
    }}>
      <div style={{ position: 'relative', width: size, height: size }}>
        <canvas
          ref={canvasRef}
          onMouseDown={handleMouseDown}
          onWheel={handleWheel}
          onDoubleClick={handleDoubleClick}
          style={{ cursor: 'ns-resize', display: 'block' }}
        />
      </div>
      {editing ? (
        <input
          autoFocus
          type="number"
          value={editText}
          onChange={(e) => setEditText(e.target.value)}
          onBlur={commitEdit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commitEdit()
            else if (e.key === 'Escape') setEditing(false)
          }}
          style={{
            width: size, fontSize: 10, textAlign: 'center',
            background: '#0a0a10', color: '#E8E8ED',
            border: `1px solid ${KNOB_COLOR}`, borderRadius: 3,
            padding: '1px 2px',
          }}
        />
      ) : (
        <div
          onDoubleClick={handleDoubleClick}
          title="Double-click to edit · Drag vertical · Shift = fine · Ctrl+click = reset"
          style={{
            fontSize: 10, color: '#BBBBCC', minHeight: 12,
            fontVariantNumeric: 'tabular-nums', cursor: 'text',
          }}
        >
          {display}
        </div>
      )}
      {label && (
        <div style={{
          fontSize: 9, color: '#8888A0', textTransform: 'uppercase',
          letterSpacing: 0.5, fontWeight: 500,
        }}>
          {label}
        </div>
      )}
    </div>
  )
}
