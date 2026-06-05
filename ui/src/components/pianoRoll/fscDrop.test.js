import { describe, it, expect, vi } from 'vitest'
import { extractFscFile, handleFscDropEvent } from './PianoRollCanvas.jsx'
import { mapFscNotesToPatternNotes, importFscScore } from './PianoRoll.jsx'

// Minimal stand-ins for the browser drop event / File — the canvas only reads
// `name` off the File and `files`/`types` off the dataTransfer.
const fakeFile = (name) => ({ name })
const dropEvent = (files) => ({
  preventDefault: vi.fn(),
  dataTransfer: { files },
})

describe('PianoRollCanvas FSC drop detection', () => {
  it('ignores a drop with no .fsc file', () => {
    const onDropFsc = vi.fn()
    const e = dropEvent([fakeFile('song.mid'), fakeFile('clip.wav')])
    handleFscDropEvent(e, onDropFsc)
    expect(e.preventDefault).toHaveBeenCalledTimes(1)
    expect(onDropFsc).not.toHaveBeenCalled()
  })

  it('passes the File up via onDropFsc when an .fsc is dropped', () => {
    const onDropFsc = vi.fn()
    const fsc = fakeFile('FL STUDIO SCORE TEST.FSC') // case-insensitive match
    handleFscDropEvent(dropEvent([fakeFile('song.mid'), fsc]), onDropFsc)
    expect(onDropFsc).toHaveBeenCalledTimes(1)
    expect(onDropFsc).toHaveBeenCalledWith(fsc)
  })

  it('extractFscFile returns null when nothing matches', () => {
    expect(extractFscFile({ files: [fakeFile('a.txt')] })).toBeNull()
    expect(extractFscFile({})).toBeNull()
  })
})

describe('mapFscNotesToPatternNotes', () => {
  it('maps engine note fields onto the PatternNote shape', () => {
    const mapped = mapFscNotesToPatternNotes([
      { positionTicks: 0, lengthTicks: 240, pitch: 60, velocity: 0.8, isSlide: false, markerByte: 0 },
    ])
    expect(mapped).toEqual([
      { positionTicks: 0, durationTicks: 240, pitch: 60, velocity: 0.8, isSlide: false },
    ])
  })

  it('passes isSlide through unchanged', () => {
    const mapped = mapFscNotesToPatternNotes([
      { positionTicks: 0, lengthTicks: 240, pitch: 60, velocity: 1, isSlide: true, markerByte: 0 },
    ])
    expect(mapped[0].isSlide).toBe(true)
  })

  it('marker byte 16 produces no extra field and no portamento behavior', () => {
    const mapped = mapFscNotesToPatternNotes([
      { positionTicks: 480, lengthTicks: 120, pitch: 64, velocity: 0.5, isSlide: false, markerByte: 16 },
    ])
    expect(Object.keys(mapped[0]).sort()).toEqual(
      ['durationTicks', 'isSlide', 'pitch', 'positionTicks', 'velocity']
    )
    expect(mapped[0].isSlide).toBe(false)
    expect('markerByte' in mapped[0]).toBe(false)
  })
})

describe('importFscScore', () => {
  const makeXleth = (overrides = {}) => ({
    getDroppedFilePath: vi.fn(() => 'C:/scores/test.fsc'),
    fsc: {
      parse: vi.fn(async () => ({
        ok: true,
        droppedCount: 0,
        notes: [
          { positionTicks: 0, lengthTicks: 240, pitch: 60, velocity: 0.8, isSlide: false, markerByte: 0 },
          { positionTicks: 240, lengthTicks: 240, pitch: 62, velocity: 0.9, isSlide: true, markerByte: 16 },
        ],
      })),
    },
    timeline: { addNotesBatch: vi.fn(async () => undefined) },
    ...overrides,
  })

  it('inserts the whole score in a single addNotesBatch call', async () => {
    const xleth = makeXleth()
    const notify = vi.fn()
    const res = await importFscScore({ file: fakeFile('test.fsc'), patternId: 7, xleth, notify })

    expect(res.status).toBe('ok')
    expect(xleth.timeline.addNotesBatch).toHaveBeenCalledTimes(1)
    const [patternId, notes] = xleth.timeline.addNotesBatch.mock.calls[0]
    expect(patternId).toBe(7)
    expect(notes).toHaveLength(2)
    expect(notes[1].isSlide).toBe(true) // slide note preserved
    expect('markerByte' in notes[1]).toBe(false) // marker 16 not carried across
    expect(notify).toHaveBeenCalledTimes(1)
  })

  it('does nothing and warns when there is no active pattern', async () => {
    const xleth = makeXleth()
    const showToast = vi.fn()
    const res = await importFscScore({ file: fakeFile('test.fsc'), patternId: null, xleth, showToast })

    expect(res.status).toBe('no-pattern')
    expect(xleth.timeline.addNotesBatch).not.toHaveBeenCalled()
    expect(showToast).toHaveBeenCalled()
  })

  it('does not mutate when parse fails', async () => {
    const xleth = makeXleth({
      fsc: { parse: vi.fn(async () => ({ ok: false, error: 'bad magic' })) },
    })
    const res = await importFscScore({ file: fakeFile('test.fsc'), patternId: 1, xleth })

    expect(res.status).toBe('parse-failed')
    expect(xleth.timeline.addNotesBatch).not.toHaveBeenCalled()
  })

  it('does not mutate when the score has zero notes', async () => {
    const xleth = makeXleth({
      fsc: { parse: vi.fn(async () => ({ ok: true, droppedCount: 3, notes: [] })) },
    })
    const res = await importFscScore({ file: fakeFile('test.fsc'), patternId: 1, xleth })

    expect(res.status).toBe('no-notes')
    expect(xleth.timeline.addNotesBatch).not.toHaveBeenCalled()
  })
})
