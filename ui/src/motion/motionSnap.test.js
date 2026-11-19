// Motion view snapping (docs/XLETH_MOTION_VIEW_DESIGN.md 5.4): candidates, priority,
// the grid fallback, Alt, and note-relative musical steps.
import { describe, expect, it } from 'vitest'
import {
  BODY_STEPS, SNAP_PX, buildSnapIndex, gridStepTicks, nearestCandidate, snapMotionTick, snapNotePos,
} from './motionSnap.js'
import { noteSpan } from '../lensRoam/lensKeyModel.js'
import { buildMotionRows } from './rowRegistry.js'
import { fixtureData, fixtureTracks } from './providers/__tests__/fixtures.js'

const ZONES = { headTicks: 120, tailTicks: 240, shortNote: 'Squash' }

describe('candidate index', () => {
  const data = fixtureData()

  it('collects the note-ons and offs of a Pattern track, sorted, with their kinds', () => {
    const idx = buildSnapIndex({ data, trackIds: [1] })
    // Lead plays two notes: 0..960 and 1920..2880.
    expect([...idx.ticks]).toEqual([0, 960, 1920, 2880])
    expect([...idx.kinds]).toEqual([0, 1, 0, 1])
  })

  it('collects the clip edges of a Clip track', () => {
    const idx = buildSnapIndex({ data, trackIds: [2] })
    expect([...idx.ticks]).toEqual([0, 3840, 3840, 7680])
    expect(new Set(idx.kinds)).toEqual(new Set([2]))
  })

  it('adds the keys of the visible rows, but never the keys being dragged', () => {
    const layout = buildMotionRows({ tracks: fixtureTracks(), data, expanded: new Set(['t:1', 't:1/roam']), trackRowHeight: 28 })
    const all = buildSnapIndex({ data, trackIds: [], layout, scrollTop: 0, height: 2000 })
    expect([...all.ticks]).toEqual([0, 3840])
    const without = buildSnapIndex({ data, trackIds: [], layout, scrollTop: 0, height: 2000, excludeIds: new Set(['r:1:offsetX:0']) })
    expect([...without.ticks]).toEqual([3840])
    // Off-screen rows do not count.
    const none = buildSnapIndex({ data, trackIds: [], layout, scrollTop: 5000, height: 100 })
    expect(none.count).toBe(0)
  })
})

describe('snapMotionTick', () => {
  const tpp = 24   // ticks per px (40 px per beat)

  it('takes the nearest candidate within 8 px, else the grid', () => {
    const idx = { ticks: Float64Array.from([960, 1100]), kinds: Uint8Array.from([0, 3]), count: 2 }
    expect(snapMotionTick(1000, { candidates: idx, ticksPerPx: tpp })).toEqual({ tick: 960, kind: 'noteOn' })
    expect(snapMotionTick(1090, { candidates: idx, ticksPerPx: tpp })).toEqual({ tick: 1100, kind: 'key' })
    // 8 px = 192 ticks: 1500 is out of reach of both, so the 1/16 grid (240) decides.
    expect(SNAP_PX * tpp).toBe(192)
    expect(snapMotionTick(1500, { candidates: idx, ticksPerPx: tpp, granularity: '1/16' })).toEqual({ tick: 1440, kind: 'grid' })
  })

  it('a tie goes to the stronger kind: note-on, note-off, clip edge, key', () => {
    const idx = { ticks: Float64Array.from([900, 1100]), kinds: Uint8Array.from([3, 1]), count: 2 }
    expect(snapMotionTick(1000, { candidates: idx, ticksPerPx: tpp })).toEqual({ tick: 1100, kind: 'noteOff' })
    const same = { ticks: Float64Array.from([1000, 1000]), kinds: Uint8Array.from([2, 0]), count: 2 }
    expect(nearestCandidate(same, 1000, 10).kind).toBe('noteOn')
  })

  it('Alt is free; nothing goes below 0; plain tick lists still work', () => {
    expect(snapMotionTick(1003.4, { modifiers: { alt: true } })).toEqual({ tick: 1003, kind: 'free' })
    expect(snapMotionTick(-50, { granularity: 'Beat' }).tick).toBe(0)
    expect(snapMotionTick(1000, { candidates: [990], ticksPerPx: tpp })).toEqual({ tick: 990, kind: 'candidate' })
  })

  it('the grid step follows the toolbar granularity', () => {
    expect(gridStepTicks('1/16')).toBe(240)
    expect(gridStepTicks('Beat')).toBe(960)
    expect(gridStepTicks('Bar')).toBe(3840)
    expect(gridStepTicks('nonsense')).toBe(240)
  })
})

describe('note-relative snapping (5.4)', () => {
  const span = noteSpan(960, ZONES)   // Head 0..120, Body 120..720, Tail 720..960

  it('Head counts whole steps from the note-on, clamped into the zone', () => {
    expect(snapNotePos(span, 'Head', 50, { step: 60 })).toBe(60)
    expect(snapNotePos(span, 'Head', 20, { step: 60 })).toBe(0)
    expect(snapNotePos(span, 'Head', 500, { step: 60 })).toBe(120)
    expect(snapNotePos(span, 'Head', 50, { step: 60, alt: true })).toBe(50)
  })

  it('Tail counts whole steps back from the note end', () => {
    expect(snapNotePos(span, 'Tail', 800, { step: 240 })).toBe(240)   // 160 before the end -> one step
    expect(snapNotePos(span, 'Tail', 900, { step: 240 })).toBe(0)     // 60 before the end -> at the end
    expect(snapNotePos(span, 'Tail', 900, { step: 240, alt: true })).toBe(60)
  })

  it('Body snaps to 0, 0.25, 0.5, 0.75, 1', () => {
    expect(BODY_STEPS).toEqual([0, 0.25, 0.5, 0.75, 1])
    expect(snapNotePos(span, 'Body', 400)).toBe(0.5)      // 0.467 of the Body
    expect(snapNotePos(span, 'Body', 140)).toBe(0)
    expect(snapNotePos(span, 'Body', 700)).toBe(1)
    expect(snapNotePos(span, 'Body', 400, { alt: true })).toBeCloseTo(0.4667, 4)
  })
})
