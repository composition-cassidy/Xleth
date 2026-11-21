import { describe, expect, it } from 'vitest'
import { noteModeOf, notePlacements, noteTimeAtPlayhead, selectedNotesForRegion, summarizeMode } from './lensNoteTarget.js'

const note = (id, positionTicks, durationTicks, extra = {}) => ({ id, positionTicks, durationTicks, ...extra })

describe('selectedNotesForRegion', () => {
  const patterns = new Map([
    [1, { id: 1, regionId: 10, notes: [note(2, 480, 120), note(1, 0, 240), note(3, 960, 120, { isSlide: true })] }],
    [2, { id: 2, regionId: 11, notes: [note(1, 0, 240)] }],
  ])

  it('keeps only the selected notes of patterns that play this region, in pattern then time order', () => {
    const sel = { 1: new Set([1, 2, 3]), 2: new Set([1]) }
    const out = selectedNotesForRegion(sel, patterns, 10)
    expect(out.map((e) => `${e.patternId}:${e.noteId}`)).toEqual(['1:1', '1:2'])   // slide skipped, other region skipped
  })

  it('nothing selected is nothing', () => {
    expect(selectedNotesForRegion({}, patterns, 10)).toEqual([])
  })
})

describe('mode summary', () => {
  it('reads the override (absent = Follow) and says Mixed when they differ', () => {
    expect(noteModeOf(note(1, 0, 1))).toBe('Follow')
    expect(noteModeOf({ lensOverride: { mode: 'Own', keys: [] } })).toBe('Own')
    expect(summarizeMode([{ lensOverride: { mode: 'Nudge' } }, { lensOverride: { mode: 'Nudge' } }])).toBe('Nudge')
    expect(summarizeMode([{}, { lensOverride: { mode: 'Own' } }])).toBe('Mixed')
  })
})

describe('notePlacements and the playhead', () => {
  const pattern = { id: 5, lengthTicks: 960 }
  const block = { id: 1, patternId: 5, positionTicks: 1920, durationTicks: 1920, offsetTicks: 0, loopEnabled: true }

  it('one placement per loop pass, the end clamped to the block', () => {
    const p = notePlacements(pattern, note(1, 0, 480), [block])
    expect(p).toEqual([{ start: 1920, end: 2400 }, { start: 2880, end: 3360 }])
    const clamped = notePlacements(pattern, note(1, 800, 480), [block])
    expect(clamped[1]).toEqual({ start: 1920 + 960 + 800, end: 3840 })   // the video stops at the block end
  })

  it('a block with looping off plays the pattern once', () => {
    expect(notePlacements(pattern, note(1, 0, 480), [{ ...block, loopEnabled: false }])).toHaveLength(1)
  })

  it('blocks of other patterns are ignored', () => {
    expect(notePlacements(pattern, note(1, 0, 480), [{ ...block, patternId: 9 }])).toEqual([])
  })

  it('inside a placement the time is exact; outside it clamps to the first placement and says which end', () => {
    const p = [{ start: 1920, end: 2400 }, { start: 2880, end: 3360 }]
    expect(noteTimeAtPlayhead(p, 2000)).toEqual({ t: 80, len: 480, inside: true, edge: null })
    expect(noteTimeAtPlayhead(p, 2900)).toMatchObject({ t: 20, inside: true })
    expect(noteTimeAtPlayhead(p, 100)).toEqual({ t: 0, len: 480, inside: false, edge: 'start' })
    expect(noteTimeAtPlayhead(p, 2500)).toEqual({ t: 480, len: 480, inside: false, edge: 'end' })
    expect(noteTimeAtPlayhead([], 5)).toBeNull()
  })
})
