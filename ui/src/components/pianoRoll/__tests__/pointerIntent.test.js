import { describe, it, expect } from 'vitest'
import { resolvePointerIntent, cursorForIntent } from '../PianoRollCanvas.jsx'
import { beatsToTicks, ticksToBeats } from '../../../constants/timeline.js'

const PPB = 80   // pixels per beat
const PPS = 14   // pixels per semitone

function noteAt({ id, positionBeats, durationBeats, pitch = 60 }) {
  return {
    id,
    positionTicks: beatsToTicks(positionBeats),
    durationTicks: beatsToTicks(durationBeats),
    pitch,
  }
}

// pitch 60 renders at y=0 given PITCH_MAX=131 in PianoRollKeyboard — easier to
// just probe relative to a note's own known screen rect instead of guessing y.
function noteScreenRect(note, scrollX = 0, scrollY = 0) {
  const beat = ticksToBeats(note.positionTicks)
  const durBeats = ticksToBeats(note.durationTicks)
  const x = beat * PPB - scrollX
  const w = Math.max(2, durBeats * PPB)
  // PITCH_MAX is 131 (see PianoRollKeyboard.jsx)
  const y = (131 - note.pitch) * PPS - scrollY
  return { x, y, w, h: PPS }
}

describe('resolvePointerIntent', () => {
  it('resolves empty space to draw for the pencil tool', () => {
    const notes = []
    const { intent, note } = resolvePointerIntent({
      localX: 100, localY: 100, notes, activeTool: 'pencil',
      pixelsPerBeat: PPB, pixelsPerSemitone: PPS, scrollX: 0, scrollY: 0,
    })
    expect(intent).toBe('draw')
    expect(note).toBeNull()
  })

  it('resolves empty space to lasso for the select tool', () => {
    const { intent } = resolvePointerIntent({
      localX: 100, localY: 100, notes: [], activeTool: 'select',
      pixelsPerBeat: PPB, pixelsPerSemitone: PPS, scrollX: 0, scrollY: 0,
    })
    expect(intent).toBe('lasso')
  })

  it('resolves the note body to move', () => {
    const n = noteAt({ id: 1, positionBeats: 2, durationBeats: 2 })
    const rect = noteScreenRect(n)
    const { intent, note } = resolvePointerIntent({
      localX: rect.x + rect.w / 2, localY: rect.y + rect.h / 2,
      notes: [n], activeTool: 'select',
      pixelsPerBeat: PPB, pixelsPerSemitone: PPS, scrollX: 0, scrollY: 0,
    })
    expect(intent).toBe('move')
    expect(note.id).toBe(1)
  })

  it('resolves the rightmost 6px of a note to resize-right', () => {
    const n = noteAt({ id: 1, positionBeats: 2, durationBeats: 2 })
    const rect = noteScreenRect(n)
    const { intent, note } = resolvePointerIntent({
      localX: rect.x + rect.w - 2, localY: rect.y + rect.h / 2,
      notes: [n], activeTool: 'select',
      pixelsPerBeat: PPB, pixelsPerSemitone: PPS, scrollX: 0, scrollY: 0,
    })
    expect(intent).toBe('resize-right')
    expect(note.id).toBe(1)
  })

  it('keeps a minimum 6px hitbox for a zoomed-out sliver', () => {
    // A 1-tick note renders far thinner than 6px at this zoom.
    const n = noteAt({ id: 1, positionBeats: 4, durationBeats: 1 / 960 })
    const rect = noteScreenRect(n)
    // rendered width floors at 2px (see resolveNoteHit) — probe just outside
    // the rendered rect but still within the expanded 6px-minimum hitbox.
    const { intent, note } = resolvePointerIntent({
      localX: rect.x + rect.w + 1, localY: rect.y + rect.h / 2,
      notes: [n], activeTool: 'select',
      pixelsPerBeat: PPB, pixelsPerSemitone: PPS, scrollX: 0, scrollY: 0,
    })
    expect(intent).not.toBe('lasso')
    expect(note?.id).toBe(1)
  })

  it('prioritizes the topmost note when two overlap', () => {
    const bottom = noteAt({ id: 1, positionBeats: 2, durationBeats: 2 })
    const top = noteAt({ id: 2, positionBeats: 2, durationBeats: 2 })
    const rect = noteScreenRect(top)
    const { note } = resolvePointerIntent({
      localX: rect.x + rect.w / 2, localY: rect.y + rect.h / 2,
      notes: [bottom, top], activeTool: 'select',
      pixelsPerBeat: PPB, pixelsPerSemitone: PPS, scrollX: 0, scrollY: 0,
    })
    expect(note.id).toBe(2)
  })

  it('resolves delete-tool hover to delete only over a note, else none', () => {
    const n = noteAt({ id: 1, positionBeats: 2, durationBeats: 2 })
    const rect = noteScreenRect(n)
    const onNote = resolvePointerIntent({
      localX: rect.x + rect.w / 2, localY: rect.y + rect.h / 2,
      notes: [n], activeTool: 'delete',
      pixelsPerBeat: PPB, pixelsPerSemitone: PPS, scrollX: 0, scrollY: 0,
    })
    expect(onNote.intent).toBe('delete')
    const empty = resolvePointerIntent({
      localX: 1, localY: 1, notes: [n], activeTool: 'delete',
      pixelsPerBeat: PPB, pixelsPerSemitone: PPS, scrollX: 0, scrollY: 0,
    })
    expect(empty.intent).toBe('none')
  })
})

describe('cursorForIntent', () => {
  it('maps each canonical intent to a distinct cursor', () => {
    expect(cursorForIntent('resize-right', 'select')).toBe('ew-resize')
    expect(cursorForIntent('move', 'select')).toBe('grab')
    expect(cursorForIntent('delete', 'delete')).toBe('not-allowed')
    expect(cursorForIntent('draw', 'pencil')).toBe('crosshair')
  })

  it('falls back to the tool baseline for none/lasso, matching pre-rebuild defaults', () => {
    expect(cursorForIntent('none', 'delete')).toBe('not-allowed')
    expect(cursorForIntent('none', 'split')).toBe('col-resize')
    expect(cursorForIntent('lasso', 'select')).toBe('default')
    expect(cursorForIntent('draw', 'pencil')).toBe('crosshair')
  })
})
