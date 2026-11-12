import { useEffect, useRef, useCallback, useState, forwardRef, useImperativeHandle } from 'react'
import { ticksToBeats } from '../../constants/timeline.js'
import { useThemeEpoch } from '../../theming/useThemeEpoch.js'
import { readPianoRollPalette, uiFont } from './pianoRollPalette.js'
import styles from './PianoRoll.module.css'

// Event lane, lollipop grammar (round 2, step 12.4): per note a 1px stem from
// the floor to its value with a round head on top, in the owning track's
// identity colour. Notes that start on the same tick (a chord) stack their
// heads on one stem; each stacked head carries a short tail to the right so
// every value stays readable. Selected heads get a --ui-select ring.
//
// Gesture (unchanged): drag a stem to set velocity; a stem that belongs to a
// multi-note selection moves the whole selection by the same delta. Local
// preview while dragging, ONE commit on release. In a stack the head nearest
// the pointer is the one grabbed. The value maps the same way it is drawn, so
// the head lands under the pointer, and the dragged value is printed beside it.

export const HEAD_R = 3
const HEAD_HIT = 8   // px hit window around each stem
const TAIL_PX = 6
const PAD_TOP = HEAD_R + 2
const PAD_BOTTOM = 3
// What Alt+click resets velocity to: the engine's default for a new note.
export const DEFAULT_VELOCITY = 1.0

/** Lane y for a 0..1 value, and back. Shared by drawing and the drag so they agree. */
export function valueToY(v, height) {
  const span = Math.max(1, height - PAD_TOP - PAD_BOTTOM)
  return height - PAD_BOTTOM - Math.max(0, Math.min(1, v)) * span
}
export function yToValue(y, height) {
  const span = Math.max(1, height - PAD_TOP - PAD_BOTTOM)
  return Math.max(0, Math.min(1, (height - PAD_BOTTOM - y) / span))
}

/** Velocity 0..1 as the 1..127 the axis speaks. */
export function velocityToMidi(v) {
  return Math.max(1, Math.round(Math.max(0, Math.min(1, v)) * 127))
}

/** Group visible notes by start tick: one stem per start, heads sorted high to low. */
export function lollipopGroups(notes, pixelsPerBeat, scrollX, width, valueOf) {
  const byTick = new Map()
  for (const note of notes) {
    const x = Math.round(ticksToBeats(note.positionTicks) * pixelsPerBeat - scrollX)
    if (x < -HEAD_HIT || x > width + HEAD_HIT) continue
    let g = byTick.get(note.positionTicks)
    if (!g) { g = { x, notes: [] }; byTick.set(note.positionTicks, g) }
    g.notes.push(note)
  }
  const groups = Array.from(byTick.values())
  for (const g of groups) g.notes.sort((a, b) => valueOf(b) - valueOf(a))
  return groups
}

const VelocityLane = forwardRef(function VelocityLane({
  notes, selectedNoteIds,
  pixelsPerBeatRef, scrollXRef,
  width, height,
  onSetVelocity,
  onSetVelocities,
  noteColor = null,
}, ref) {
  const dprEpoch = useThemeEpoch() // re-size and redraw at a new devicePixelRatio or theme
  const canvasRef = useRef(null)
  const containerRef = useRef(null)
  const dragRef = useRef(null)
  const notesRef = useRef(notes)
  notesRef.current = notes
  const selectedNoteIdsRef = useRef(selectedNoteIds)
  selectedNoteIdsRef.current = selectedNoteIds
  const colorRef = useRef(noteColor)
  colorRef.current = noteColor
  const [dragTick, setDragTick] = useState(0)

  useEffect(() => {
    const c = canvasRef.current
    if (!c) return
    const dpr = window.devicePixelRatio || 1
    c.width = Math.max(1, Math.round(width * dpr))
    c.height = Math.max(1, Math.round(height * dpr))
    const ctx = c.getContext('2d')
    ctx?.setTransform(dpr, 0, 0, dpr, 0, 0)
  }, [width, height, dprEpoch])

  function redraw() {
    const ctx = canvasRef.current?.getContext?.('2d')
    if (!ctx) return
    const dpr = window.devicePixelRatio || 1
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    const palette = readPianoRollPalette()
    const color = colorRef.current || palette.value
    const ppb = pixelsPerBeatRef.current
    const sX = scrollXRef.current
    const drag = dragRef.current
    const selected = selectedNoteIdsRef.current
    const valueOf = (n) => {
      const d = drag?.preview.get(n.id)
      return d != null ? d : (n.velocity ?? 1.0)
    }

    ctx.clearRect(0, 0, width, height)
    ctx.fillStyle = palette.g0
    ctx.fillRect(0, 0, width, height)
    // Guides at 127 and 64, the two values the gutter names.
    ctx.fillStyle = palette.g3
    ctx.fillRect(0, Math.round(valueToY(1, height)), width, 1)
    ctx.fillRect(0, Math.round(valueToY(64 / 127, height)), width, 1)

    for (const g of lollipopGroups(notesRef.current, ppb, sX, width, valueOf)) {
      const top = valueToY(valueOf(g.notes[0]), height)
      const anySelected = g.notes.some((n) => selected?.has(n.id))
      ctx.fillStyle = anySelected ? palette.select : color
      ctx.fillRect(g.x, top, 1, height - PAD_BOTTOM - top)
      const stacked = g.notes.length > 1
      for (const n of g.notes) {
        const y = valueToY(valueOf(n), height)
        if (stacked) {
          ctx.fillStyle = color
          ctx.fillRect(g.x, Math.round(y), TAIL_PX + HEAD_R, 1)
        }
        ctx.beginPath()
        ctx.arc(g.x + 0.5, y, HEAD_R, 0, Math.PI * 2)
        ctx.fillStyle = color
        ctx.fill()
        if (selected?.has(n.id)) {
          ctx.lineWidth = 1.5
          ctx.strokeStyle = palette.select
          ctx.beginPath()
          ctx.arc(g.x + 0.5, y, HEAD_R + 1.5, 0, Math.PI * 2)
          ctx.stroke()
        }
      }
    }

    // The value being dragged, printed beside its head (every control shows its value).
    if (drag) {
      const anchor = notesRef.current.find((n) => n.id === drag.anchorId)
      const v = drag.preview.get(drag.anchorId)
      if (anchor && v != null) {
        const x = Math.round(ticksToBeats(anchor.positionTicks) * ppb - sX)
        const y = valueToY(v, height)
        ctx.font = uiFont(palette, 11, 600)
        ctx.textBaseline = 'middle'
        ctx.textAlign = 'left'
        const text = String(velocityToMidi(v))
        const tx = Math.min(width - 24, x + HEAD_R + 6)
        const ty = Math.max(8, Math.min(height - 8, y))
        ctx.fillStyle = palette.g0
        ctx.fillRect(tx - 2, ty - 7, (ctx.measureText?.(text)?.width ?? 18) + 4, 14)
        ctx.fillStyle = palette.ink
        ctx.fillText(text, tx, ty)
      }
    }
  }

  // ON-SETTLE-ish: redraw when anything OTHER than pixelsPerBeat/scrollX
  // changes — those two are driven imperatively via the exposed redraw()
  // below, once per animator frame, not through props/state.
  useEffect(() => {
    redraw()
  }, [notes, selectedNoteIds, width, height, dragTick, dprEpoch, noteColor])

  useImperativeHandle(ref, () => ({ redraw }), [width, height])

  const getLocalXY = useCallback((e) => {
    const rect = containerRef.current?.getBoundingClientRect()
    if (!rect) return null
    return { localX: e.clientX - rect.left, localY: e.clientY - rect.top }
  }, [])

  // Stem under the pointer; in a stack, the head nearest the pointer.
  const findNoteAt = useCallback((localX, localY) => {
    const ppb = pixelsPerBeatRef.current
    const sX = scrollXRef.current
    let best = null
    let bestDy = Infinity
    for (const n of notesRef.current) {
      const x = Math.round(ticksToBeats(n.positionTicks) * ppb - sX)
      if (localX < x - HEAD_HIT / 2 || localX >= x + 1 + HEAD_HIT / 2) continue
      const dy = Math.abs(valueToY(n.velocity ?? 1, height) - localY)
      if (dy < bestDy) { best = n; bestDy = dy }
    }
    return best
  }, [height, pixelsPerBeatRef, scrollXRef])

  // Grabbing a stem that belongs to a multi-note selection edits the WHOLE
  // selection: the grabbed note tracks the cursor and every other selected note
  // shifts by the same delta, so their relative velocity shape is preserved.
  // Grabbing an unselected stem stays a single-note drag.
  const buildDrag = useCallback((anchor) => {
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

  // Shift-sweep drag: same commit path as a stem drag (targets + preview).
  const buildSweep = useCallback((localX, localY) => {
    const sweep = {
      sweep: true,
      anchorId: null,
      lastX: localX,
      targets: [],
      preview: new Map(),
      value: yToValue(localY, height),
      cross(x0, x1, value) {
        this.value = value
        const ppb = pixelsPerBeatRef.current
        const sX = scrollXRef.current
        const lo = Math.min(x0, x1) - HEAD_HIT / 2
        const hi = Math.max(x0, x1) + HEAD_HIT / 2
        for (const n of notesRef.current) {
          const x = Math.round(ticksToBeats(n.positionTicks) * ppb - sX)
          if (x < lo || x > hi) continue
          if (!this.preview.has(n.id)) {
            this.targets.push({ id: n.id, orig: n.velocity ?? 1.0 })
            if (this.anchorId == null) this.anchorId = n.id
          }
          this.preview.set(n.id, value)
        }
        // Everything already swept follows the pointer's value: all equal.
        for (const t of this.targets) this.preview.set(t.id, value)
        this.lastX = x1
      },
      apply(value, x) { this.cross(this.lastX, x ?? this.lastX, value) },
    }
    sweep.cross(localX, localX, sweep.value)
    return sweep
  }, [height, pixelsPerBeatRef, scrollXRef])

  const handleMouseDown = useCallback((e) => {
    if (e.button !== 0) return
    const pos = getLocalXY(e)
    if (!pos) return
    // Shift+drag: every stem the pointer crosses takes the pointer's value,
    // so the swept notes all end up equal (FL event editor).
    if (e.shiftKey) {
      e.preventDefault()
      dragRef.current = buildSweep(pos.localX, pos.localY)
      setDragTick((t) => t + 1)
      return
    }
    const note = findNoteAt(pos.localX, pos.localY)
    if (!note) return
    // Alt+click: reset to the default velocity (the selection, if the stem
    // belongs to it).
    if (e.altKey) {
      e.preventDefault()
      const sel = selectedNoteIds
      const targets = sel && sel.size > 1 && sel.has(note.id)
        ? [note, ...notesRef.current.filter((n) => sel.has(n.id) && n.id !== note.id)]
        : [note]
      const changed = targets
        .filter((n) => (n.velocity ?? 1) !== DEFAULT_VELOCITY)
        .map((n) => ({ noteId: n.id, velocity: DEFAULT_VELOCITY }))
      if (changed.length > 1 && onSetVelocities) onSetVelocities(changed)
      else if (changed.length === 1) onSetVelocity?.(changed[0].noteId, DEFAULT_VELOCITY)
      return
    }
    const vel = yToValue(pos.localY, height)
    const drag = buildDrag(note)
    drag.apply(vel)
    dragRef.current = drag
    setDragTick((t) => t + 1)
  }, [buildDrag, buildSweep, findNoteAt, getLocalXY, height, onSetVelocity, onSetVelocities, selectedNoteIds])

  useEffect(() => {
    const onMove = (e) => {
      const d = dragRef.current
      if (!d) return
      const rect = containerRef.current?.getBoundingClientRect()
      if (!rect) return
      const vel = yToValue(e.clientY - rect.top, height)
      if (d.sweep) {
        d.apply(vel, e.clientX - rect.left)
        setDragTick((t) => t + 1)
      } else if (vel !== d.preview.get(d.anchorId)) {
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
      className={`${styles.cell} ${styles.lane}`}
      onMouseDown={handleMouseDown}
      data-hint="Velocity"
      data-hint-mods="Drag a stem: set velocity · Selected stems move together · Shift+drag: set every stem crossed to one value · Alt+click: reset · Keys 1–9, 0: set the selection"
    >
      <canvas ref={canvasRef} className={styles.layer} role="img" aria-label="Velocity lane" />
    </div>
  )
})

export default VelocityLane
