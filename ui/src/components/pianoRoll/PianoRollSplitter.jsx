import { useCallback, useRef, useState } from 'react'
import styles from './PianoRoll.module.css'

// Splitter between the note grid and the event lane. Drag moves the lane edge
// 1:1 (live: it only resizes two canvases, nothing crosses IPC); Arrow keys
// nudge 8px (Shift 32px), Home/End jump to the limits. The height is renderer
// UI state, persisted per machine like other dock sizes.

export const LANE_MIN = 48
export const LANE_MAX = 240
export const LANE_DEFAULT = 80
const STORAGE_KEY = 'xleth.pianoRoll.laneHeight'

export function clampLaneHeight(h) {
  if (!Number.isFinite(h)) return LANE_DEFAULT
  return Math.max(LANE_MIN, Math.min(LANE_MAX, Math.round(h)))
}

export function readStoredLaneHeight() {
  try {
    const raw = window.localStorage?.getItem(STORAGE_KEY)
    if (raw == null) return LANE_DEFAULT
    return clampLaneHeight(Number(raw))
  } catch {
    return LANE_DEFAULT
  }
}

function storeLaneHeight(h) {
  try { window.localStorage?.setItem(STORAGE_KEY, String(h)) } catch { /* private window / blocked storage */ }
}

// Collapsed, the lane keeps one header row (the Velocity toggle) so it can always be opened again;
// the grid takes the rest. Same height as the ruler, so the two bands match.
export const LANE_COLLAPSED = 24
const OPEN_KEY = 'xleth.pianoRoll.laneOpen'

export function readStoredLaneOpen() {
  try { return window.localStorage?.getItem(OPEN_KEY) !== '0' } catch { return true }
}

export function storeLaneOpen(open) {
  try { window.localStorage?.setItem(OPEN_KEY, open ? '1' : '0') } catch { /* private window / blocked storage */ }
}

export default function PianoRollSplitter({ laneHeight, onLaneHeightChange, disabled = false }) {
  const [dragging, setDragging] = useState(false)
  const dragRef = useRef(null)

  const commit = useCallback((h) => {
    const next = clampLaneHeight(h)
    onLaneHeightChange(next)
    storeLaneHeight(next)
  }, [onLaneHeightChange])

  const onPointerDown = useCallback((e) => {
    if (e.button !== 0 || disabled) return
    e.preventDefault()
    try { e.currentTarget.setPointerCapture(e.pointerId) } catch { /* jsdom */ }
    dragRef.current = { startY: e.clientY, startH: laneHeight }
    setDragging(true)
  }, [laneHeight, disabled])

  const onPointerMove = useCallback((e) => {
    const d = dragRef.current
    if (!d) return
    // Dragging the splitter UP grows the lane below it.
    onLaneHeightChange(clampLaneHeight(d.startH - (e.clientY - d.startY)))
  }, [onLaneHeightChange])

  const onPointerUp = useCallback((e) => {
    const d = dragRef.current
    if (!d) return
    dragRef.current = null
    setDragging(false)
    try { e.currentTarget.releasePointerCapture(e.pointerId) } catch { /* jsdom */ }
    commit(d.startH - (e.clientY - d.startY))
  }, [commit])

  const onKeyDown = useCallback((e) => {
    if (disabled) return
    const step = e.shiftKey ? 32 : 8
    if (e.key === 'ArrowUp') { e.preventDefault(); commit(laneHeight + step) }
    else if (e.key === 'ArrowDown') { e.preventDefault(); commit(laneHeight - step) }
    else if (e.key === 'Home') { e.preventDefault(); commit(LANE_MAX) }
    else if (e.key === 'End') { e.preventDefault(); commit(LANE_MIN) }
  }, [commit, laneHeight, disabled])

  return (
    <div
      className={styles.splitter}
      role="separator"
      aria-orientation="horizontal"
      aria-label="Event lane height"
      aria-valuemin={LANE_MIN}
      aria-valuemax={LANE_MAX}
      aria-valuenow={laneHeight}
      aria-disabled={disabled || undefined}
      tabIndex={disabled ? -1 : 0}
      data-dragging={dragging ? 'true' : undefined}
      data-hint="Event lane height"
      data-hint-mods="Drag: resize · Arrows: nudge (Shift ×4) · Double-click: reset"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onDoubleClick={() => { if (!disabled) commit(LANE_DEFAULT) }}
      onKeyDown={onKeyDown}
    />
  )
}
