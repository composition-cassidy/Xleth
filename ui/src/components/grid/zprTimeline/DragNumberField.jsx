import { useCallback, useRef, useState } from 'react'

// Drag-scrub numeric field for the ZPR keyframe inspector — NOT a slider.
// Horizontal drag scrubs the value, a plain click (no meaningful pointer
// travel) focuses the field for typed entry, Shift = fine, Alt/Ctrl = coarse.
//
// Deliberately its own small drag handler rather than reusing
// controls/dragLaw.js: that hook's Ctrl/Cmd+click means "reset to default",
// which collides with the Alt/Ctrl-as-coarse contract this field needs.
//
// Props:
//   value            current numeric value
//   onLiveChange(v)  every frame during a drag — local preview only
//   onCommit(v)      once, on drag release or on typed-entry confirm
//   step             value change per pixel of drag at normal sensitivity
//   precision        decimals shown when not editing
//   suffix           e.g. '°', 'x'
//   min, max         optional clamp
//   readOnly         true for the derived Zoom readout (no drag, no type)
const CLICK_DRAG_THRESHOLD_PX = 3

export default function DragNumberField({
  value,
  onLiveChange,
  onCommit,
  step = 1,
  precision = 2,
  suffix = '',
  min = -Infinity,
  max = Infinity,
  label,
  readOnly = false,
  className = '',
}) {
  const [editing, setEditing] = useState(false)
  const [editText, setEditText] = useState('')
  const dragRef = useRef(null) // { startX, startValue, moved }
  const inputRef = useRef(null)

  const clamp = useCallback((v) => Math.max(min, Math.min(max, v)), [min, max])

  const handlePointerDown = useCallback((e) => {
    if (readOnly || e.button !== 0) return
    e.preventDefault()
    try { e.currentTarget.setPointerCapture(e.pointerId) } catch (_) {}
    dragRef.current = { startX: e.clientX, startValue: value, moved: false }
  }, [readOnly, value])

  const handlePointerMove = useCallback((e) => {
    const d = dragRef.current
    if (!d) return
    const dx = e.clientX - d.startX
    if (Math.abs(dx) > CLICK_DRAG_THRESHOLD_PX) d.moved = true
    if (!d.moved) return

    let sensitivity = step
    if (e.shiftKey) sensitivity = step / 8
    else if (e.altKey || e.ctrlKey || e.metaKey) sensitivity = step * 8

    const next = clamp(d.startValue + dx * sensitivity)
    onLiveChange?.(next)
  }, [step, clamp, onLiveChange])

  // `value` here is always the latest committed-or-live prop (the parent
  // re-renders on every onLiveChange during the drag), so reading it at
  // release time is correct without a separate live-value ref.
  const commitDrag = useCallback((e) => {
    const d = dragRef.current
    if (!d) return
    dragRef.current = null
    try { e.currentTarget.releasePointerCapture(e.pointerId) } catch (_) {}
    if (!d.moved) {
      setEditing(true)
      setEditText(formatValue(value, precision))
      requestAnimationFrame(() => inputRef.current?.select())
      return
    }
    onCommit?.(value)
  }, [value, precision, onCommit])

  const commitEdit = useCallback(() => {
    const n = Number(editText)
    if (Number.isFinite(n)) onCommit?.(clamp(n))
    setEditing(false)
  }, [editText, clamp, onCommit])

  return (
    <div className={`zpr-drag-field ${readOnly ? 'zpr-drag-field--readonly' : ''} ${className}`.trim()}>
      {label && <span className="zpr-drag-field-label">{label}</span>}
      {editing ? (
        <input
          ref={inputRef}
          type="text"
          className="zpr-drag-field-input"
          value={editText}
          onChange={(e) => setEditText(e.target.value)}
          onBlur={commitEdit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commitEdit()
            else if (e.key === 'Escape') setEditing(false)
          }}
          autoFocus
        />
      ) : (
        <div
          className="zpr-drag-field-value"
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={commitDrag}
          onPointerCancel={commitDrag}
          title={readOnly ? undefined : 'Drag to scrub · click to type · Shift = fine · Alt/Ctrl = coarse'}
          style={{ cursor: readOnly ? 'default' : 'ew-resize' }}
        >
          {formatValue(value, precision)}{suffix}
        </div>
      )}
    </div>
  )
}

function formatValue(v, precision) {
  if (!Number.isFinite(v)) return '—'
  return v.toFixed(precision)
}
