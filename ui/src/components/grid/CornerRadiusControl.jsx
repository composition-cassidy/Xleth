import { useState, useRef, useCallback, useEffect } from 'react'

const WIDGET_SIZE = 42
const DOT_SIZE    = 7
const MAX_OFFSET  = WIDGET_SIZE - DOT_SIZE

export default function CornerRadiusControl({ track, fetchTracks, applyCornerRadiusToAll }) {
  const [radius, setRadius] = useState(track.cornerRadius ?? 0)
  const dragging   = useRef(false)
  const startT     = useRef(0)
  const startMouse = useRef({ x: 0, y: 0 })

  useEffect(() => {
    setRadius(track.cornerRadius ?? 0)
  }, [track.cornerRadius])

  const t    = Math.min(1, Math.max(0, radius * 2))
  const dotX = t * MAX_OFFSET
  const dotY = t * MAX_OFFSET

  const commit = useCallback(async (v) => {
    await window.xleth?.timeline?.setTrackCornerRadius(track.id, v)
    fetchTracks()
  }, [track.id, fetchTracks])

  const onDotPointerDown = useCallback((e) => {
    e.preventDefault()
    dragging.current   = true
    startT.current     = radius * 2
    startMouse.current = { x: e.clientX, y: e.clientY }
    e.currentTarget.setPointerCapture(e.pointerId)
  }, [radius])

  const onPointerMove = useCallback((e) => {
    if (!dragging.current) return
    const dx   = e.clientX - startMouse.current.x
    const dy   = e.clientY - startMouse.current.y
    const newT = Math.min(1, Math.max(0, startT.current + (dx + dy) / (2 * WIDGET_SIZE)))
    const newR = newT * 0.5
    setRadius(newR)
    commit(newR)
  }, [commit])

  const onPointerUp = useCallback(() => {
    dragging.current = false
  }, [])

  const onWheel = useCallback((e) => {
    e.preventDefault()
    const delta = e.deltaY > 0 ? -0.01 : 0.01
    const newR  = Math.min(0.5, Math.max(0, radius + delta))
    setRadius(newR)
    commit(newR)
  }, [radius, commit])

  const onKeyDown = useCallback((e) => {
    let delta = 0
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown')  delta =  (e.shiftKey ? 0.05 : 0.01)
    if (e.key === 'ArrowLeft'  || e.key === 'ArrowUp')    delta = -(e.shiftKey ? 0.05 : 0.01)
    if (delta === 0) return
    e.preventDefault()
    const newR = Math.min(0.5, Math.max(0, radius + delta))
    setRadius(newR)
    commit(newR)
  }, [radius, commit])

  const onDotDoubleClick = useCallback(() => {
    setRadius(0)
    commit(0)
  }, [commit])

  const previewInset   = 6
  const previewSize    = WIDGET_SIZE - previewInset * 2
  const previewBR      = `${Math.round(radius * previewSize)}px`

  return (
    <div className="grid-tab-corner-radius-row">
      <div
        className="grid-tab-corner-radius-widget"
        tabIndex={0}
        onWheel={onWheel}
        onKeyDown={onKeyDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      >
        <div
          className="grid-tab-corner-radius-preview"
          style={{ borderRadius: previewBR }}
        />
        <div
          className="grid-tab-corner-radius-dot"
          style={{ left: dotX, top: dotY }}
          onPointerDown={onDotPointerDown}
          onDoubleClick={onDotDoubleClick}
        />
      </div>
      <div className="grid-tab-corner-radius-info">
        <span className="grid-tab-corner-radius-readout">
          {Math.round(radius * 200)}%
        </span>
        <button
          className="grid-tab-mini-btn"
          title="Copy this corner radius to every track"
          onClick={() => applyCornerRadiusToAll(radius)}
        >→All</button>
      </div>
    </div>
  )
}
