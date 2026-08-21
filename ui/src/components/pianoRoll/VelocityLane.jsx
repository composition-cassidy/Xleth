import { useEffect, useRef, useCallback, useState, forwardRef, useImperativeHandle } from 'react'
import { PPQ } from '../../constants/timeline.js'

// Flat redesign palette (matches PianoRollCanvas MOCK).
const VEL_BG = '#181818'
const ACCENT_RGB = '0, 184, 150'
const STEM_W = 2
const HEAD_R = 3
const HEAD_HIT = 8 // px hit-window around each stem for velocity drag

// pixelsPerBeatRef/scrollXRef are REF OBJECTS owned by PianoRoll.jsx, not
// value props — its view animator writes them every frame without a
// re-render (mirrors TimelineCanvas's pixelsPerBeatRef/scrollOffsetRef
// pattern). A value prop would only be as fresh as the last (debounced)
// render, which is stale mid-gesture — see PianoRoll.jsx's onTick.
const VelocityLane = forwardRef(function VelocityLane({
  notes, selectedNoteIds,
  pixelsPerBeatRef, scrollXRef,
  width, height,
  onSetVelocity,
  onSetVelocities,
}, ref) {
  const canvasRef = useRef(null)
  const containerRef = useRef(null)
  const dragRef = useRef(null)
  const notesRef = useRef(notes)
  notesRef.current = notes
  const selectedNoteIdsRef = useRef(selectedNoteIds)
  selectedNoteIdsRef.current = selectedNoteIds
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
  }, [width, height])

  function redraw() {
    const c = canvasRef.current
    if (!c) return
    const ctx = c.getContext('2d')
    const ppb = pixelsPerBeatRef.current
    const sX = scrollXRef.current

    // Flat background — no zero line, no level guides (mockup keeps it clean).
    ctx.fillStyle = VEL_BG
    ctx.fillRect(0, 0, width, height)

    // Velocity stems: a thin teal line per note, opacity scaling with velocity,
    // topped by a solid round head. Range leaves ~6px floor so quiet notes stay
    // visible and the head never clips the top edge.
    const floor = HEAD_R + 2
    const span = Math.max(0, height - floor - HEAD_R - 1)
    const drag = dragRef.current
    const noteList = notesRef.current
    const selected = selectedNoteIdsRef.current
    for (let i = 0; i < noteList.length; i++) {
      const note = noteList[i]
      const beat = note.positionTicks / PPQ
      const x = Math.round(beat * ppb - sX)
      if (x + STEM_W < 0 || x > width) continue
      const dragged = drag?.preview.get(note.id)
      const effectiveVel = dragged != null ? dragged : (note.velocity ?? 1.0)
      const v = Math.max(0, Math.min(1, effectiveVel))
      const isSelected = selected?.has(note.id)
      const topY = height - floor - v * span
      const stemAlpha = isSelected ? 0.95 : (0.35 + v * 0.45)

      ctx.fillStyle = `rgba(${ACCENT_RGB}, ${stemAlpha.toFixed(3)})`
      ctx.fillRect(x, topY, STEM_W, height - topY)

      ctx.fillStyle = `rgba(${ACCENT_RGB}, 1)`
      ctx.beginPath()
      ctx.arc(x + STEM_W / 2, topY, HEAD_R, 0, Math.PI * 2)
      ctx.fill()
    }
  }

  // ON-SETTLE-ish: redraw when anything OTHER than pixelsPerBeat/scrollX
  // changes — those two are driven imperatively via the exposed redraw()
  // below, once per animator frame, not through props/state.
  useEffect(() => {
    redraw()
  }, [notes, selectedNoteIds, width, height, dragTick])

  useImperativeHandle(ref, () => ({ redraw }), [width, height])

  const getLocalXY = useCallback((e) => {
    const rect = containerRef.current?.getBoundingClientRect()
    if (!rect) return null
    return { localX: e.clientX - rect.left, localY: e.clientY - rect.top }
  }, [])

  const findNoteAt = useCallback((localX) => {
    const notes = notesRef.current
    const ppb = pixelsPerBeatRef.current
    const sX = scrollXRef.current
    for (let i = 0; i < notes.length; i++) {
      const beat = notes[i].positionTicks / PPQ
      const x = beat * ppb - sX
      if (localX >= x - HEAD_HIT / 2 && localX < x + STEM_W + HEAD_HIT / 2) return notes[i]
    }
    return null
  }, [])

  // Grabbing a stem that belongs to a multi-note selection edits the WHOLE
  // selection: the grabbed note tracks the cursor and every other selected note
  // shifts by the same delta, so their relative velocity shape is preserved.
  // Grabbing an unselected stem stays a single-note drag.
  const buildDrag = useCallback((anchor, cursorVel) => {
    const sel = selectedNoteIds
    const multi = sel && sel.size > 1 && sel.has(anchor.id)
    // Anchor first: downstream commit handlers treat entry 0 as the note the
    // user actually grabbed (it drives sticky velocity).
    const targets = multi
      ? [anchor, ...notesRef.current.filter((n) => sel.has(n.id) && n.id !== anchor.id)]
      : [anchor]
    return {
      anchorId: anchor.id,
      anchorOrig: anchor.velocity ?? 1.0,
      targets: targets.map((n) => ({ id: n.id, orig: n.velocity ?? 1.0 })),
      preview: new Map(),
      apply(vel) {
        const delta = vel - this.anchorOrig
        this.preview = new Map(
          this.targets.map((t) => [t.id, Math.max(0, Math.min(1, t.orig + delta))]),
        )
      },
    }
  }, [selectedNoteIds])

  const handleMouseDown = useCallback((e) => {
    if (e.button !== 0) return
    const pos = getLocalXY(e)
    if (!pos) return
    const note = findNoteAt(pos.localX)
    if (!note) return
    const vel = Math.max(0, Math.min(1, 1 - pos.localY / height))
    const drag = buildDrag(note, vel)
    drag.apply(vel)
    dragRef.current = drag
    setDragTick((t) => t + 1)
  }, [buildDrag, findNoteAt, getLocalXY, height])

  useEffect(() => {
    const onMove = (e) => {
      const d = dragRef.current
      if (!d) return
      const rect = containerRef.current?.getBoundingClientRect()
      if (!rect) return
      const localY = e.clientY - rect.top
      const vel = Math.max(0, Math.min(1, 1 - localY / height))
      if (vel !== d.preview.get(d.anchorId)) {
        d.apply(vel)
        setDragTick((t) => t + 1)
      }
    }
    const onUp = () => {
      const d = dragRef.current
      if (!d) return
      const changed = d.targets
        .map((t) => ({ noteId: t.id, velocity: d.preview.get(t.id) ?? t.orig }))
        .filter((entry, i) => entry.velocity !== d.targets[i].orig)
      if (changed.length > 1 && onSetVelocities) onSetVelocities(changed)
      else if (changed.length > 0) {
        for (const entry of changed) onSetVelocity?.(entry.noteId, entry.velocity)
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
  }, [height, onSetVelocity, onSetVelocities])

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
})

export default VelocityLane
