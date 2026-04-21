import { useEffect, useRef, useCallback, useState } from 'react'
import { PPQ } from '../../constants/timeline.js'
import { tokenValue } from '../../theming/tokenValue.ts'

const BAR_WIDTH = 8

export default function VelocityLane({
  notes, selectedNoteIds,
  pixelsPerBeat, scrollX,
  width, height,
  onSetVelocity,
}) {
  const canvasRef = useRef(null)
  const containerRef = useRef(null)
  const dragRef = useRef(null)
  const notesRef = useRef(notes)
  notesRef.current = notes
  const [dragTick, setDragTick] = useState(0)

  useEffect(() => {
    const c = canvasRef.current
    if (!c) return
    const dpr = window.devicePixelRatio || 1
    c.width = width * dpr
    c.height = height * dpr
    c.style.width = `${width}px`
    c.style.height = `${height}px`
    const ctx = c.getContext('2d')
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)

    // Background
    ctx.fillStyle = tokenValue('--theme-pianoroll-key-black-bg')
    ctx.fillRect(0, 0, width, height)

    // Zero line
    ctx.strokeStyle = tokenValue('--theme-pianoroll-bar-line')
    ctx.lineWidth = 1
    ctx.beginPath()
    ctx.moveTo(0, height - 0.5)
    ctx.lineTo(width, height - 0.5)
    ctx.stroke()

    // Bars
    const drag = dragRef.current
    for (let i = 0; i < notes.length; i++) {
      const note = notes[i]
      const beat = note.positionTicks / PPQ
      const x = beat * pixelsPerBeat - scrollX
      if (x + BAR_WIDTH < 0 || x > width) continue
      const effectiveVel = (drag && drag.noteId === note.id)
        ? drag.previewVelocity
        : (note.velocity ?? 1.0)
      const barH = Math.max(2, effectiveVel * (height - 4))
      const selected = selectedNoteIds?.has(note.id)
      ctx.fillStyle = selected ? tokenValue('--theme-pianoroll-velocity-bar-fill') : tokenValue('--theme-label-pitch')
      ctx.fillRect(x, height - barH, BAR_WIDTH, barH)
    }
  }, [notes, selectedNoteIds, pixelsPerBeat, scrollX, width, height, dragTick])

  const getLocalXY = useCallback((e) => {
    const rect = containerRef.current?.getBoundingClientRect()
    if (!rect) return null
    return { localX: e.clientX - rect.left, localY: e.clientY - rect.top }
  }, [])

  const findNoteAt = useCallback((localX) => {
    const notes = notesRef.current
    for (let i = 0; i < notes.length; i++) {
      const beat = notes[i].positionTicks / PPQ
      const x = beat * pixelsPerBeat - scrollX
      if (localX >= x && localX < x + BAR_WIDTH) return notes[i]
    }
    return null
  }, [pixelsPerBeat, scrollX])

  const handleMouseDown = useCallback((e) => {
    if (e.button !== 0) return
    const pos = getLocalXY(e)
    if (!pos) return
    const note = findNoteAt(pos.localX)
    if (!note) return
    const vel = Math.max(0, Math.min(1, 1 - pos.localY / height))
    dragRef.current = {
      noteId: note.id,
      origVelocity: note.velocity ?? 1.0,
      previewVelocity: vel,
    }
    setDragTick((t) => t + 1)
  }, [findNoteAt, getLocalXY, height])

  useEffect(() => {
    const onMove = (e) => {
      const d = dragRef.current
      if (!d) return
      const rect = containerRef.current?.getBoundingClientRect()
      if (!rect) return
      const localY = e.clientY - rect.top
      const vel = Math.max(0, Math.min(1, 1 - localY / height))
      if (vel !== d.previewVelocity) {
        d.previewVelocity = vel
        setDragTick((t) => t + 1)
      }
    }
    const onUp = () => {
      const d = dragRef.current
      if (!d) return
      if (d.previewVelocity !== d.origVelocity) {
        onSetVelocity?.(d.noteId, d.previewVelocity)
      }
      dragRef.current = null
      setDragTick((t) => t + 1)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
  }, [height, onSetVelocity])

  return (
    <div
      ref={containerRef}
      className="piano-roll-velocity-lane"
      style={{
        position: 'relative',
        width,
        height,
        background: 'var(--theme-pianoroll-key-black-bg)',
        borderTop: '1px solid var(--theme-border-subtle)',
        cursor: 'ns-resize',
        flexShrink: 0,
      }}
      onMouseDown={handleMouseDown}
    >
      <canvas ref={canvasRef} />
    </div>
  )
}
