import { describe, expect, it } from 'vitest'
import * as E from '../pianoRollEdits.js'

const n = (id, positionTicks, durationTicks, pitch = 60, velocity = 0.8) => ({ id, positionTicks, durationTicks, pitch, velocity })
const ids = (...xs) => new Set(xs)
const byId = (notes) => Object.fromEntries(notes.filter((x) => x.id).map((x) => [x.id, x]))

describe('legatoResize (Shift + drag a right edge)', () => {
  // The user's reference: three notes end exactly where three notes of OTHER
  // pitches begin. Dragging the left group's edge moves the boundary — the
  // right group's starts follow, their ends stay put, nothing overlaps.
  const left = [n(1, 0, 960, 67), n(2, 0, 960, 65), n(3, 0, 960, 62)]
  const right = [n(4, 960, 1200, 69), n(5, 960, 1200, 66), n(6, 960, 1200, 63)]
  const notes = [...left, ...right]

  it('moves the boundary between touching notes of different pitches', () => {
    const { notes: out, delta } = E.legatoResize(notes, ids(1, 2, 3), 1, 480)
    expect(delta).toBe(480)
    const m = byId(out)
    for (const id of [1, 2, 3]) expect(m[id].durationTicks).toBe(1440)
    for (const id of [4, 5, 6]) {
      expect(m[id].positionTicks).toBe(1440)
      expect(m[id].positionTicks + m[id].durationTicks).toBe(2160) // end held
    }
  })

  it('keeps touching notes touching when the edge is pulled back', () => {
    const { notes: out } = E.legatoResize(notes, ids(1, 2, 3), 1, -480)
    const m = byId(out)
    expect(m[1].durationTicks).toBe(480)
    expect(m[4].positionTicks).toBe(480)
    expect(m[4].positionTicks + m[4].durationTicks).toBe(2160)
  })

  it('trims a later note the extension would run into instead of overlapping it', () => {
    // Regular drag overlaps D5 onto D#5; Shift-drag pushes D#5's start instead.
    const { notes: out } = E.legatoResize([n(1, 0, 480, 62), n(2, 960, 960, 63)], ids(1), 1, 960)
    const m = byId(out)
    expect(m[1].positionTicks + m[1].durationTicks).toBe(1440)
    expect(m[2].positionTicks).toBe(1440)
    expect(m[2].durationTicks).toBe(480)
  })

  it('never squeezes a follower below the minimum length', () => {
    const { notes: out, delta } = E.legatoResize([n(1, 0, 480), n(2, 480, 240, 64)], ids(1), 1, 5000)
    expect(delta).toBe(240 - E.MIN_NOTE_TICKS)
    expect(byId(out)[2].durationTicks).toBe(E.MIN_NOTE_TICKS)
  })

  it('treats a selected note that starts at the boundary as a follower, not a resized note', () => {
    const { notes: out } = E.legatoResize(notes, ids(1, 2, 3, 4, 5, 6), 1, 240)
    const m = byId(out)
    expect(m[1].durationTicks).toBe(1200)
    expect(m[4].positionTicks).toBe(1200)
    expect(m[4].positionTicks + m[4].durationTicks).toBe(2160)
  })
})

describe('slicing', () => {
  it('slices a vertical line through every row it spans, at one tick', () => {
    const out = E.sliceAlongLine([n(1, 0, 960, 60), n(2, 0, 960, 64), n(3, 0, 960, 72)],
      { tick0: 480, pitch0: 59, tick1: 480, pitch1: 65 })
    expect(out).toHaveLength(5)
    expect(out.filter((x) => x.pitch === 72)).toHaveLength(1)
    expect(out.filter((x) => x.pitch === 60).map((x) => x.durationTicks)).toEqual([480, 480])
  })

  it('Right-Shift + right-click keeps the larger part only', () => {
    const out = E.sliceAt([n(1, 0, 960)], ids(1), 240, { deleteSmallest: true })
    expect(out).toEqual([{ ...n(1, 240, 720) }])
  })
})

describe('time-based edits', () => {
  const notes = [n(1, 0, 240), n(2, 960, 240, 62), n(3, 1920, 240, 64)]

  it('Ctrl+B duplicates the selection right after itself, copies selected', () => {
    const { notes: out, range } = E.duplicateRight(notes, ids(1, 2), null, 240)
    expect(out).toHaveLength(5)
    const copies = out.filter((x) => x._select)
    expect(copies.map((x) => x.positionTicks)).toEqual([1200, 2160])
    expect(copies.every((x) => x.id === undefined)).toBe(true)
    expect(range).toEqual({ start: 1200, end: 2400 })
  })

  it('Ctrl+B with nothing selected duplicates everything', () => {
    expect(E.duplicateRight(notes, new Set(), null, 240).notes).toHaveLength(6)
  })

  it('Ctrl+Ins pushes later notes right by the range; Ctrl+Alt+Ins slices first', () => {
    const range = { start: 960, end: 1440 }
    expect(E.insertSpace(notes, range).map((x) => x.positionTicks)).toEqual([0, 1440, 2400])
    const long = [n(1, 0, 1920)]
    const sliced = E.insertSpace(long, range, { slice: true })
    expect(sliced.map((x) => [x.positionTicks, x.durationTicks])).toEqual([[0, 960], [1440, 960]])
  })

  it('Ctrl+Del removes what starts in the range and closes the gap', () => {
    const out = E.deleteSpace(notes, { start: 960, end: 1920 })
    expect(out.map((x) => [x.id, x.positionTicks])).toEqual([[1, 0], [3, 960]])
  })

  it('Ctrl+Left / Right step a range by its own length, never before 0', () => {
    expect(E.shiftRange({ start: 960, end: 1920 }, 1)).toEqual({ start: 1920, end: 2880 })
    expect(E.shiftRange({ start: 480, end: 1440 }, -1)).toEqual({ start: 0, end: 960 })
  })

  it('rotate wraps inside the bars the notes occupy', () => {
    const out = E.rotate([n(1, 0, 240), n(2, 3600, 240)], ids(1, 2), 240)
    expect(out.map((x) => x.positionTicks)).toEqual([240, 0])
  })

  it('moveBy clamps the group at tick 0', () => {
    expect(E.moveBy(notes, ids(2, 3), -5000).map((x) => x.positionTicks)).toEqual([0, 0, 960])
  })
})

describe('selection helpers', () => {
  const notes = [n(1, 0, 240), n(2, 250, 240), n(3, 480, 240)]
  it('Shift+I inverts, Shift+O finds off-grid starts', () => {
    expect([...E.invertSelection(notes, ids(1))]).toEqual([2, 3])
    expect([...E.offGridSelection(notes, 240)]).toEqual([2])
  })
  it('Shift+R picks from the selection, never nothing', () => {
    expect(E.randomSelection(notes, ids(1, 2), () => 0.9).size).toBe(1)
    expect([...E.randomSelection(notes, ids(1, 2), () => 0.1)]).toEqual([1, 2])
  })
  it('Ctrl+Enter spans the selection on the grid', () => {
    expect(E.spanOf(notes, ids(2), 240)).toEqual({ start: 240, end: 720 })
  })
})

describe('transpose', () => {
  const notes = [n(1, 0, 240, 60), n(2, 0, 240, 126)]
  it('keeps intervals when an octave jump hits the top of the keyboard', () => {
    const out = E.transpose(notes, ids(1, 2), { semitones: 12 })
    expect(out.map((x) => x.pitch)).toEqual([65, 131])
  })
  it('steps through a scale with stepPitch', () => {
    const out = E.transpose(notes, ids(1), { dir: 1, stepPitch: (p) => p + 2 })
    expect(out[0].pitch).toBe(62)
  })
})

describe('paint', () => {
  const tpl = { velocity: 0.7 }
  it('lays one note per crossed slot, skipping notes already there', () => {
    const out = E.paintNotes([n(9, 240, 240, 60)],
      [{ slot: 0, pitch: 60 }, { slot: 1, pitch: 60 }, { slot: 2, pitch: 61 }],
      { originTicks: 0, slotTicks: 240, template: tpl })
    expect(out.map((x) => [x.positionTicks, x.pitch])).toEqual([[0, 60], [480, 61]])
    expect(out.every((x) => x._select && x.velocity === 0.7)).toBe(true)
  })
  it('monophonic keeps the last pitch per slot', () => {
    const out = E.paintNotes([], [{ slot: 0, pitch: 60 }, { slot: 0, pitch: 64 }],
      { originTicks: 0, slotTicks: 240, template: tpl, mono: true })
    expect(out.map((x) => x.pitch)).toEqual([64])
  })
})

describe('commit plumbing', () => {
  it('diffs a compound edit into per-note operations for the fallback path', () => {
    const before = [n(1, 0, 240), n(2, 240, 240), n(3, 480, 240)]
    const after = [{ ...before[0], positionTicks: 120 }, { ...before[2], durationTicks: 480, velocity: 0.5 }, n(undefined, 960, 240)]
    const d = E.diffNotes(before, after)
    expect(d.removes).toEqual([2])
    expect(d.moves).toEqual([{ noteId: 1, positionTicks: 120, pitch: 60 }])
    expect(d.resizes).toEqual([{ noteId: 3, durationTicks: 480 }])
    expect(d.velocities).toEqual([{ noteId: 3, velocity: 0.5 }])
    expect(d.adds.map((a) => a.index)).toEqual([2])
  })
  it('strips editor flags before the engine sees a note', () => {
    expect(E.toEngineNote({ ...n(4, 10, 20), _select: true })).toEqual({
      id: 4, positionTicks: 10, durationTicks: 20, pitch: 60, velocity: 0.8,
    })
  })
})
