// @vitest-environment jsdom
// Lens + Roam P5: the per-note Lens override must survive every piano-roll path
// that rebuilds the note list (editPatternNotes REPLACES the list), on the right
// note only. A fake engine stands in for the bridge with the real command's
// semantics: ids kept, id-less notes get fresh ids, every call is JSON across
// the wire, one undo entry per call.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as Edits from '../components/pianoRoll/pianoRollEdits.js'
import {
  getNoteLensOverride,
  installNoteLensDevHook,
  setNoteLensOverride,
  withNoteLensOverride,
} from './noteLensOverride.js'

const DUMMY = {
  mode: 'Own',
  keys: [
    { channel: 'zoom', anchor: 'Head', pos: 0, value: 1.35, p1x: 0.33, p1y: 0.33, p2x: 0.66, p2y: 0.66 },
    { channel: 'zoom', anchor: 'Tail', pos: 240, value: 1, p1x: 0.33, p1y: 0.33, p2x: 0.66, p2y: 0.66 },
  ],
}

const wire = (v) => JSON.parse(JSON.stringify(v))

function fakeEngine() {
  const patterns = new Map()
  const undo = []
  const redo = []
  const put = (id, notes) => patterns.set(id, { ...patterns.get(id), notes })
  const timeline = {
    patterns,
    addPattern: vi.fn(async ({ name }) => {
      const id = patterns.size + 1
      patterns.set(id, { id, name, nextNoteId: 1, notes: [] })
      return id
    }),
    getPattern: vi.fn(async (id) => (patterns.has(id) ? wire(patterns.get(id)) : null)),
    editPatternNotes: vi.fn(async (id, sent) => {
      const p = patterns.get(id)
      const before = p.notes
      let next = p.nextNoteId
      for (const n of sent) if (n.id > 0 && n.id >= next) next = n.id + 1
      const after = wire(sent).map((n) => (n.id > 0 ? n : { ...n, id: next++ }))
      p.nextNoteId = next
      put(id, after)
      undo.push({ id, before, after }); redo.length = 0
      return wire(after)
    }),
    addNotesBatch: vi.fn(async (id, sent) => {
      const p = patterns.get(id)
      const added = wire(sent).map((n) => ({ ...n, id: p.nextNoteId++ }))
      const before = p.notes
      put(id, [...before, ...added])
      undo.push({ id, before, after: patterns.get(id).notes }); redo.length = 0
      return added.map((n) => n.id)
    }),
  }
  const history = {
    undo: () => { const e = undo.pop(); put(e.id, e.before); redo.push(e) },
    redo: () => { const e = redo.pop(); put(e.id, e.after); undo.push(e) },
  }
  return { timeline, history }
}

// What PianoRoll.commitNotes does with a pure edit's result.
async function commit(tl, patternId, nextNotes) {
  return tl.editPatternNotes(patternId, nextNotes.map(Edits.toEngineNote))
}

let engine
const A = 1
const B = 2

beforeEach(async () => {
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  engine = fakeEngine()
  window.xleth = { timeline: engine.timeline }
  // Two patterns with the SAME note ids (ids are unique only inside a pattern).
  for (const name of ['A', 'B']) {
    const pid = await engine.timeline.addPattern({ name })
    await engine.timeline.addNotesBatch(pid, [0, 1, 2].map((i) => ({
      positionTicks: 960 * i + 13, durationTicks: 240, pitch: 60 + i, velocity: 1,
    })))
  }
})

afterEach(() => {
  delete window.xleth
  vi.restoreAllMocks()
})

const notesOf = async (pid) => (await engine.timeline.getPattern(pid)).notes
const withOverride = async (pid) => (await notesOf(pid)).filter((n) => n.lensOverride).map((n) => n.id)

// P8: the same survival run with REAL overrides, in the exact shape the engine
// emits (patternNoteToJs -> lensNoteOverrideToJson): Nudge and Own, keys with
// `interp`, every anchor. The P5 dummy (P1-era bezier handles) stays as a case.
const REAL_NUDGE = {
  mode: 'Nudge',
  keys: [
    { channel: 'centerX', anchor: 'Head', pos: 0, value: 0.05, interp: 'Linear' },
    { channel: 'centerX', anchor: 'Head', pos: 120, value: 0, interp: 'Linear' },
    { channel: 'rotationDeg', anchor: 'Body', pos: 0.5, value: 10, interp: 'Hold' },
    { channel: 'zoom', anchor: 'Tail', pos: 240, value: 1.1, interp: 'Linear' },
    { channel: 'zoom', anchor: 'Tail', pos: 0, value: 1, interp: 'Linear' },
  ],
}
const REAL_OWN = {
  mode: 'Own',
  keys: [
    { channel: 'zoom', anchor: 'Head', pos: 0, value: 2, interp: 'EaseOut' },
    { channel: 'zoom', anchor: 'Head', pos: 120, value: 1.5, interp: 'Linear' },
  ],
}

describe.each([
  ['P5 dummy', DUMMY],
  ['P8 real Nudge', REAL_NUDGE],
  ['P8 real Own', REAL_OWN],
])('per-note Lens override plumbing (%s)', (_label, OV) => {
  it('withNoteLensOverride sets/clears one note and leaves the rest identical', () => {
    const notes = [{ id: 1 }, { id: 2 }]
    const set = withNoteLensOverride(notes, 2, OV)
    expect(set[0]).toBe(notes[0])
    expect(set[1].lensOverride).toBe(OV)
    expect(withNoteLensOverride(set, 2, null)[1]).not.toHaveProperty('lensOverride')
    expect(withNoteLensOverride(notes, 9, OV)).toBeNull()
  })

  it('toEngineNote carries it; an absent one stays absent', () => {
    expect(Edits.toEngineNote({ id: 4, positionTicks: 0, durationTicks: 1, pitch: 60, lensOverride: OV }).lensOverride).toBe(OV)
    expect(Edits.toEngineNote({ id: 4, positionTicks: 0, durationTicks: 1, pitch: 60 })).not.toHaveProperty('lensOverride')
  })

  it('sameNotes sees an override-only change as a change', () => {
    const a = [{ id: 1, positionTicks: 0, durationTicks: 1, pitch: 60 }]
    expect(Edits.sameNotes(a, withNoteLensOverride(a, 1, OV))).toBe(false)
    const b = withNoteLensOverride(a, 1, OV)
    expect(Edits.sameNotes(b, Edits.moveBy(b, new Set([1]), 0))).toBe(true)
  })

  it('survives move, quantize, editing another note, undo/redo, paste, duplicate, delete', async () => {
    const tl = engine.timeline
    // Dev hook: one engine call, one undo entry.
    const post = await setNoteLensOverride(A, 2, OV)
    expect(post.lensOverride).toEqual(OV)
    expect(await getNoteLensOverride(A, 2)).toEqual(OV)
    expect(await withOverride(A)).toEqual([2])
    expect(await withOverride(B)).toEqual([])

    // Move (Edits.moveBy is the arrow-key / burst path), quantize.
    await commit(tl, A, Edits.moveBy(await notesOf(A), new Set([2]), 1000))
    await commit(tl, A, Edits.quantizeStarts(await notesOf(A), new Set([1, 2, 3]), 240))
    let n2 = (await notesOf(A)).find((n) => n.id === 2)
    expect(n2.positionTicks).toBe(1920)
    expect(n2.lensOverride).toEqual(OV)

    // Edit a DIFFERENT note: the whole list goes back, note 2 untouched.
    await commit(tl, A, Edits.setVelocity(await notesOf(A), new Set([1]), 0.25))
    expect((await notesOf(A)).find((n) => n.id === 1).velocity).toBe(0.25)
    expect(await withOverride(A)).toEqual([2])

    // Undo back past the set, then redo.
    for (let i = 0; i < 4; i++) engine.history.undo()
    expect(await withOverride(A)).toEqual([])
    for (let i = 0; i < 4; i++) engine.history.redo()
    expect(await withOverride(A)).toEqual([2])

    // Duplicate (Ctrl+B) and shift-drag-style copies get new ids and keep it.
    const dup = Edits.duplicateRight(await notesOf(A), new Set([2]), null, 240)
    const afterDup = await commit(tl, A, dup.notes)
    const copy = afterDup[afterDup.length - 1]
    expect(copy.id).toBeGreaterThan(3)
    expect(copy.lensOverride).toEqual(OV)
    expect(await withOverride(A)).toEqual([2, copy.id])

    // Delete drops it with the note.
    await commit(tl, A, Edits.deleteNotes(await notesOf(A), new Set([copy.id])))
    expect(await withOverride(A)).toEqual([2])
    expect(await withOverride(B)).toEqual([])
  })

  it('Make Unique Copy copies every override to the matching new ids', async () => {
    await setNoteLensOverride(A, 2, OV)
    const orig = await engine.timeline.getPattern(A)
    const pid = await engine.timeline.addPattern({ name: 'A (copy)' })
    const ids = await engine.timeline.addNotesBatch(pid, orig.notes.map(Edits.toNewNoteCopy))
    const copied = await notesOf(pid)
    expect(copied.map((n) => n.positionTicks)).toEqual(orig.notes.map((n) => n.positionTicks))
    expect(orig.notes.map(Edits.toNewNoteCopy).every((n) => !('id' in n))).toBe(true)
    // Second source note (id 2) -> second new id.
    expect(copied.filter((n) => n.lensOverride).map((n) => n.id)).toEqual([ids[1]])
    expect(copied[1].lensOverride).toEqual(OV)
  })

  it('installs and removes window.__xlethLensDev', () => {
    const win = {}
    const off = installNoteLensDevHook(win)
    expect(typeof win.__xlethLensDev.setNoteLensOverride).toBe('function')
    off()
    expect(win.__xlethLensDev).toBeUndefined()
  })
})
