import { useRef, useEffect, useCallback, useState } from 'react'

// ── Log taper mapping ───────────────────────────────────────────────────────
// Fader position p ∈ [0,1] → dB → linear gain
// p=0 → -inf, p≈0.05 → -96dB, p=0.75 → 0dB, p=1.0 → +12dB

function posToDB(p) {
  if (p <= 0) return -Infinity
  if (p >= 1) return 12
  if (p <= 0.75) {
    const t = p / 0.75                    // t ∈ [0, 1]
    return -96 * Math.pow(1 - t, 3)       // cubic: fine near 0dB, accelerates toward -96
  }
  return ((p - 0.75) / 0.25) * 12         // linear: 0dB → +12dB
}

function dbToLinear(db) {
  if (db <= -96) return 0
  return Math.pow(10, db / 20)
}

function linearToDB(gain) {
  if (gain <= 0) return -Infinity
  return 20 * Math.log10(gain)
}

function linearToPos(gain) {
  const db = linearToDB(gain)
  if (db <= -96) return 0
  if (db >= 12) return 1
  if (db >= 0) return 0.75 + (db / 12) * 0.25
  return 0.75 * (1 - Math.pow(-db / 96, 1/3))   // inverse cubic
}

function formatDB(gain) {
  if (gain <= 0) return '-∞'
  const db = linearToDB(gain)
  if (db <= -96) return '-∞'
  return db.toFixed(1)
}

const THUMB_H = 28

export default function VolumeFader({ value, onChange }) {
  const containerRef = useRef(null)
  const dragRef = useRef(null)
  const liveRef = useRef(value)

  useEffect(() => { liveRef.current = value }, [value])

  const getGrooveHeight = useCallback(() => {
    const el = containerRef.current
    return el ? el.clientHeight - THUMB_H : 160
  }, [])

  const posToY = useCallback((pos) => {
    const gh = getGrooveHeight()
    return (1 - pos) * gh
  }, [getGrooveHeight])

  const yToPos = useCallback((y) => {
    const gh = getGrooveHeight()
    return Math.max(0, Math.min(1, 1 - y / gh))
  }, [getGrooveHeight])

  const handleMouseDown = useCallback((e) => {
    // Ctrl/Cmd + click → reset to 0dB (gain 1.0)
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault()
      onChange?.(1.0)
      return
    }
    e.preventDefault()
    const rect = containerRef.current.getBoundingClientRect()
    dragRef.current = {
      startY: e.clientY,
      startPos: linearToPos(value),
      fine: e.shiftKey,
    }
    document.body.style.cursor = 'ns-resize'
  }, [value, onChange])

  useEffect(() => {
    const onMove = (e) => {
      const d = dragRef.current
      if (!d) return
      const gh = getGrooveHeight()
      const dy = d.startY - e.clientY
      const sensitivity = (e.shiftKey || d.fine) ? 10 : 1
      const delta = (dy / gh) / sensitivity
      const pos = Math.max(0, Math.min(1, d.startPos + delta))
      const db = posToDB(pos)
      const gain = db <= -96 ? 0 : dbToLinear(db)
      liveRef.current = gain
      onChange?.(gain)
    }
    const onUp = () => {
      if (!dragRef.current) return
      dragRef.current = null
      document.body.style.cursor = ''
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
  }, [getGrooveHeight, onChange])

  const handleWheel = useCallback((e) => {
    e.preventDefault()
    const pos = linearToPos(value)
    const sensitivity = e.shiftKey ? 500 : 100
    const delta = -(e.deltaY / sensitivity) / 20
    const next = Math.max(0, Math.min(1, pos + delta))
    const db = posToDB(next)
    const gain = db <= -96 ? 0 : dbToLinear(db)
    onChange?.(gain)
  }, [value, onChange])

  const pos = linearToPos(value)
  const thumbY = posToY(pos)

  return (
    <div
      ref={containerRef}
      className="mixer-fader"
      onMouseDown={handleMouseDown}
      onWheel={handleWheel}
    >
      {/* Groove */}
      <div className="mixer-fader-groove" style={{ top: THUMB_H / 2, bottom: THUMB_H / 2 }}>
        {/* Lit fill — everything below the thumb glows */}
        <div className="mixer-fader-fill" style={{ height: `${pos * 100}%` }} />
        {/* Unity line at 0dB */}
        <div
          className="mixer-fader-unity"
          style={{ bottom: `${linearToPos(1.0) * 100}%` }}
        />
      </div>

      {/* Thumb — centred on the value position (== top of the lit fill) */}
      <div
        className={`mixer-fader-thumb ${dragRef.current ? 'active' : ''}`}
        style={{ top: thumbY + THUMB_H / 2 }}
      >
        <span className="mixer-fader-thumb-line" />
      </div>
    </div>
  )
}

// dB readout — lifted out of the fader body so it sits above the meter/fader
// pair and is never occluded by the thumb at full travel.  Owns its own
// double-click-to-type editing, reusing the same taper helpers as the fader.
export function FaderReadout({ value, onChange }) {
  const [editing, setEditing] = useState(false)
  const [editText, setEditText] = useState('')

  const handleDoubleClick = useCallback(() => {
    setEditing(true)
    setEditText(formatDB(value))
  }, [value])

  const commitEdit = useCallback(() => {
    const n = parseFloat(editText)
    if (!isNaN(n)) {
      const clamped = Math.max(-96, Math.min(12, n))
      const gain = clamped <= -96 ? 0 : dbToLinear(clamped)
      onChange?.(gain)
    }
    setEditing(false)
  }, [editText, onChange])

  return (
    <div className="mixer-fader-readout">
      {editing ? (
        <input
          autoFocus
          type="text"
          className="mixer-fader-readout-input"
          value={editText}
          onChange={e => setEditText(e.target.value)}
          onBlur={commitEdit}
          onKeyDown={e => {
            if (e.key === 'Enter') commitEdit()
            else if (e.key === 'Escape') setEditing(false)
          }}
          onMouseDown={e => e.stopPropagation()}
        />
      ) : (
        <span
          className="mixer-fader-readout-text"
          onDoubleClick={handleDoubleClick}
          title="Double-click to type dB · Drag the fader · Shift = fine · Ctrl+click = 0dB"
        >
          {formatDB(value)}<span className="mixer-fader-readout-unit">db</span>
        </span>
      )}
    </div>
  )
}
