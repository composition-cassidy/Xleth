import { useCallback, useEffect, useRef, useState } from 'react'

export const CARDINAL_SWEEP_ANGLES = [0, 90, 180, 270]
export const CARDINAL_SWEEP_SNAP_DEGREES = 5

export function normalizeLineSweepAngle(value) {
  const numeric = Number(value)
  if (!Number.isFinite(numeric)) return 0
  return ((Math.round(numeric) % 360) + 360) % 360
}

function angularDistance(a, b) {
  return Math.abs(((a - b + 540) % 360) - 180)
}

export function snapLineSweepAngle(value, bypassSnap = false) {
  const normalized = normalizeLineSweepAngle(value)
  if (bypassSnap) return normalized
  return CARDINAL_SWEEP_ANGLES.find((cardinal) => (
    angularDistance(normalized, cardinal) <= CARDINAL_SWEEP_SNAP_DEGREES
  )) ?? normalized
}

export function snapCardinalTransitionAngle(value) {
  const normalized = normalizeLineSweepAngle(value)
  return (Math.round(normalized / 90) * 90) % 360
}

export function lineSweepAngleFromPoint(clientX, clientY, rect, bypassSnap = false) {
  const x = clientX - rect.left - rect.width / 2
  const y = clientY - rect.top - rect.height / 2
  if (x === 0 && y === 0) return null
  return snapLineSweepAngle(Math.atan2(y, x) * 180 / Math.PI, bypassSnap)
}

export function lineSweepDirectionLabel(angle) {
  switch (normalizeLineSweepAngle(angle)) {
    case 0: return 'From left'
    case 90: return 'From top'
    case 180: return 'From right'
    case 270: return 'From bottom'
    default: return 'Custom direction'
  }
}

function pointOnCompass(angle, radius) {
  const radians = angle * Math.PI / 180
  return {
    x: 50 + Math.cos(radians) * radius,
    y: 50 + Math.sin(radians) * radius,
  }
}

export default function LineSweepDirectionControl({
  value = 0, onCommit, cardinalOnly = false, ariaLabel = 'Line sweep direction',
}) {
  const normalizeForMode = useCallback((angle) => (
    cardinalOnly ? snapCardinalTransitionAngle(angle) : normalizeLineSweepAngle(angle)
  ), [cardinalOnly])
  const compassRef = useRef(null)
  const draggingRef = useRef(false)
  const draftAngleRef = useRef(normalizeForMode(value))
  const [draftAngle, setDraftAngle] = useState(draftAngleRef.current)
  const direction = lineSweepDirectionLabel(draftAngle)
  const handle = pointOnCompass(draftAngle, 34)

  useEffect(() => {
    if (draggingRef.current) return
    const next = normalizeForMode(value)
    draftAngleRef.current = next
    setDraftAngle(next)
  }, [normalizeForMode, value])

  const updateFromPointer = useCallback((event) => {
    const rect = compassRef.current?.getBoundingClientRect()
    if (!rect) return
    const pointed = lineSweepAngleFromPoint(
      event.clientX, event.clientY, rect, cardinalOnly ? true : event.ctrlKey,
    )
    const next = pointed === null ? null : normalizeForMode(pointed)
    if (next === null) return
    draftAngleRef.current = next
    setDraftAngle(next)
  }, [cardinalOnly, normalizeForMode])

  const handlePointerDown = useCallback((event) => {
    if (event.button !== 0) return
    event.preventDefault()
    draggingRef.current = true
    event.currentTarget.setPointerCapture?.(event.pointerId)
    updateFromPointer(event)
  }, [updateFromPointer])

  const handlePointerMove = useCallback((event) => {
    if (!draggingRef.current) return
    updateFromPointer(event)
  }, [updateFromPointer])

  const commitPointer = useCallback(() => {
    if (!draggingRef.current) return
    draggingRef.current = false
    onCommit?.(draftAngleRef.current)
  }, [onCommit])

  const handleKeyDown = useCallback((event) => {
    let delta = 0
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') delta = cardinalOnly ? 90 : (event.shiftKey ? 10 : 1)
    if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') delta = cardinalOnly ? -90 : (event.shiftKey ? -10 : -1)
    if (delta === 0) return
    event.preventDefault()
    const next = cardinalOnly
      ? snapCardinalTransitionAngle(draftAngleRef.current + delta)
      : snapLineSweepAngle(draftAngleRef.current + delta, event.ctrlKey)
    draftAngleRef.current = next
    setDraftAngle(next)
    onCommit?.(next)
  }, [cardinalOnly, onCommit])

  return (
    <div className="vmt-line-sweep-direction">
      <div className="vmt-line-sweep-direction-heading">
        <span>Direction</span>
        <span className="vmt-line-sweep-direction-readout">{draftAngle}°</span>
      </div>
      <svg
        ref={compassRef}
        className="vmt-line-sweep-compass"
        viewBox="0 0 100 100"
        role="slider"
        tabIndex={0}
        aria-label={ariaLabel}
        aria-valuemin={0}
        aria-valuemax={359}
        aria-valuenow={draftAngle}
        aria-valuetext={`${direction}, ${draftAngle} degrees`}
        title={cardinalOnly
          ? 'Choose the cardinal direction where the incoming snapshot enters.'
          : 'Drag to set where the incoming snapshot enters. Snaps to cardinal directions; hold Ctrl for a precise angle.'}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={commitPointer}
        onPointerCancel={commitPointer}
        onKeyDown={handleKeyDown}
      >
        <circle className="vmt-line-sweep-compass-ring" cx="50" cy="50" r="38" />
        <path className="vmt-line-sweep-compass-axis" d="M 12 50 H 88 M 50 12 V 88" />
        {CARDINAL_SWEEP_ANGLES.map((angle) => {
          const tick = pointOnCompass(angle, 38)
          return <circle key={angle} className="vmt-line-sweep-compass-tick" cx={tick.x} cy={tick.y} r="2" />
        })}
        <line
          className="vmt-line-sweep-compass-needle"
          x1="50"
          y1="50"
          x2={handle.x}
          y2={handle.y}
        />
        <circle className="vmt-line-sweep-compass-handle" cx={handle.x} cy={handle.y} r="5" />
        <circle className="vmt-line-sweep-compass-center" cx="50" cy="50" r="3" />
      </svg>
      <span className="vmt-line-sweep-direction-hint">
        {direction}{cardinalOnly ? ' · Cardinal directions' : ' · Ctrl for precise angle'}
      </span>
    </div>
  )
}
