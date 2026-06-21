import { useEffect, useRef, useCallback, useState } from 'react'
import { PPQ } from '../../constants/timeline.js'

// Flat redesign palette (matches PianoRollCanvas MOCK).
const VEL_BG = '#181818'
const ACCENT_RGB = '0, 184, 150'
const STEM_W = 2
const HEAD_R = 3
const HEAD_HIT = 8 // px hit-window around each stem for velocity drag

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

    // Flat background — no zero line, no level guides (mockup keeps it clean).
    ctx.fillStyle = VEL_BG
    ctx.fillRect(0, 0, width, height)

    // Velocity stems: a thin teal line per note, opacity scaling with velocity,
    // topped by a solid round head. Range leaves ~6px floor so quiet notes stay
    // visible and the head never clips the top edge.
    const floor = HEAD_R + 2
    const span = Math.max(0, height - floor - HEAD_R - 1)
    const drag = dragRef.current
    for (let i = 0; i < notes.length; i++) {
      const note = notes[i]
      const beat = note.positionTicks / PPQ
      const x = Math.round(beat * pixelsPerBeat - scrollX)
      if (x + STEM_W < 0 || x > width) continue
      const effectiveVel = (drag && drag.noteId === note.id)
        ? drag.previewVelocity
        : (note.velocity ?? 1.0)
      const v = Math.max(0, Math.min(1, effectiveVel))
      const selected = selectedNoteIds?.has(note.id)
      const topY = height - floor - v * span
      const stemAlpha = selected ? 0.95 : (0.35 + v * 0.45)

      ctx.fillStyle = `rgba(${ACCENT_RGB}, ${stemAlpha.toFixed(3)})`
      ctx.fillRect(x, topY, STEM_W, height - topY)

      ctx.fillStyle = `rgba(${ACCENT_RGB}, 1)`
      ctx.beginPath()
      ctx.arc(x + STEM_W / 2, topY, HEAD_R, 0, Math.PI * 2)
      ctx.fill()
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
      if (localX >= x - HEAD_HIT / 2 && localX < x + STEM_W + HEAD_HIT / 2) return notes[i]
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
        background: VEL_BG,
        borderTop: '1px solid #222',
        cursor: 'ns-resize',
        flexShrink: 0,
      }}
      onMouseDown={handleMouseDown}
    >
      <canvas ref={canvasRef} />
    </div>
  )
}
