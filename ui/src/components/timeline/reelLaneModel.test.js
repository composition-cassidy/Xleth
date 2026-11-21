import { describe, expect, it } from 'vitest'
import {
  REEL_MAX_SUB_ROWS,
  buildReelModel, forEachReelClipInRange, reelClipAt, reelLaneHeight, reelSubRowSpan,
} from './reelLaneModel.js'

const tracks = [{ id: 1, type: 'Pattern' }, { id: 2, type: 'Audio' }, { id: 3, type: 'Pattern' }]
const sources = { 10: { id: 10, hasVideo: true, filePath: 'a.mp4', duration: 4 }, 11: { id: 11, hasVideo: false } }
const regions = { 100: { id: 100, sourceId: 10, startTime: 1 }, 101: { id: 101, sourceId: 11, startTime: 0 } }

const note = (id, positionTicks, durationTicks, extra = {}) => ({ id, positionTicks, durationTicks, pitch: 60, velocity: 1, ...extra })
const pattern = (id, regionId, lengthTicks, notes) => ({ id, regionId, lengthTicks, notes })
const block = (id, trackId, patternId, positionTicks, durationTicks, extra = {}) =>
  ({ id, trackId, patternId, positionTicks, durationTicks, offsetTicks: 0, loopEnabled: true, ...extra })

function build(patternBlocks, patterns, over = {}) {
  return buildReelModel({ tracks, patternBlocks, patterns, regions, sources, ...over })
}

describe('buildReelModel: which tracks get a lane', () => {
  it('only Pattern tracks whose pattern region has a video source', () => {
    const { byTrack } = build(
      [block(1, 1, 1, 0, 960), block(2, 3, 2, 0, 960), block(3, 2, 1, 0, 960)],
      { 1: pattern(1, 100, 960, [note(1, 0, 240)]), 2: pattern(2, 101, 960, [note(1, 0, 240)]) },
    )
    expect([...byTrack.keys()]).toEqual([1]) // track 3: audio-only region; track 2: not a Pattern track
  })

  it('a video track with no notes still has a (empty) lane', () => {
    const { byTrack } = build([block(1, 1, 1, 0, 960)], { 1: pattern(1, 100, 960, []) })
    expect(byTrack.get(1).count).toBe(0)
  })

  it('a track with no blocks has none', () => {
    expect(build([], {}).byTrack.size).toBe(0)
  })

  it('records one still per region, at the same frame the Samples grid shows', () => {
    const { stillByRegion } = build([block(1, 1, 1, 0, 960)], { 1: pattern(1, 100, 960, [note(1, 0, 240)]) })
    expect(stillByRegion.get(100)).toMatchObject({ sourceId: 10, filePath: 'a.mp4', duration: 4 })
    expect(stillByRegion.get(100).timeSeconds).toBeCloseTo(1.04, 6)
  })
})

describe('buildReelModel: clips mirror the engine event builder', () => {
  it('position and length come straight from the note, shifted to the block', () => {
    const { byTrack } = build([block(1, 1, 1, 1920, 960)], { 1: pattern(1, 100, 960, [note(7, 480, 240)]) })
    const t = byTrack.get(1)
    expect(t.count).toBe(1)
    expect([t.starts[0], t.ends[0], t.noteIds[0], t.patternIds[0]]).toEqual([2400, 2640, 7, 1])
  })

  it('follows an edit immediately: a new model from the new notes moves the clip', () => {
    const blocks = [block(1, 1, 1, 0, 960)]
    const before = build(blocks, { 1: pattern(1, 100, 960, [note(1, 0, 240)]) }).byTrack.get(1)
    const after = build(blocks, { 1: pattern(1, 100, 960, [note(1, 120, 480)]) }).byTrack.get(1)
    expect([before.starts[0], before.ends[0]]).toEqual([0, 240])
    expect([after.starts[0], after.ends[0]]).toEqual([120, 600])
  })

  it('repeats the pattern for each loop iteration and honours the block offset', () => {
    const t = build([block(1, 1, 1, 0, 1920)], { 1: pattern(1, 100, 960, [note(1, 0, 240)]) }).byTrack.get(1)
    expect(Array.from(t.starts)).toEqual([0, 960])
    const trimmed = build([block(1, 1, 1, 0, 960, { offsetTicks: 480 })], { 1: pattern(1, 100, 960, [note(1, 0, 240), note(2, 600, 240)]) }).byTrack.get(1)
    // window [480, 1440): note 2 (tape 600) is in; note 1 only at tape 960 (start 480)
    expect(Array.from(trimmed.starts)).toEqual([120, 480])
    expect(Array.from(trimmed.noteIds)).toEqual([2, 1])
  })

  it('with block looping off only the first iteration exists', () => {
    const t = build([block(1, 1, 1, 0, 1920, { loopEnabled: false })], { 1: pattern(1, 100, 960, [note(1, 0, 240)]) }).byTrack.get(1)
    expect(t.count).toBe(1)
  })

  it('clamps the note end to the block end (the video stops when the sound does)', () => {
    const t = build([block(1, 1, 1, 0, 960)], { 1: pattern(1, 100, 4000, [note(1, 800, 960)]) }).byTrack.get(1)
    expect(t.ends[0]).toBe(960)
  })

  it('slide notes spawn no clip', () => {
    const t = build([block(1, 1, 1, 0, 960)], { 1: pattern(1, 100, 960, [note(1, 0, 240), note(2, 240, 240, { isSlide: true })]) }).byTrack.get(1)
    expect(Array.from(t.noteIds)).toEqual([1])
  })

  it('a shared pattern lights up one clip per placement with the same note id', () => {
    const t = build([block(1, 1, 1, 0, 960), block(2, 1, 1, 3840, 960)], { 1: pattern(1, 100, 960, [note(5, 0, 240)]) }).byTrack.get(1)
    expect(Array.from(t.noteIds)).toEqual([5, 5])
    expect(Array.from(t.starts)).toEqual([0, 3840])
  })
})

describe('sub-rows', () => {
  const notesOverlapping = [note(1, 0, 480), note(2, 240, 480), note(3, 480, 240), note(4, 960, 240)]
  const t = () => build([block(1, 1, 1, 0, 1920)], { 1: pattern(1, 100, 1920, notesOverlapping) }).byTrack.get(1)

  it('stacks overlapping notes and lets butted notes share a row', () => {
    const m = t()
    expect(m.subRows).toBe(2)
    expect(Array.from(m.rows)).toEqual([0, 1, 0, 0]) // note 3 starts exactly where note 1 ends
  })

  it('a lane with no overlap is one row', () => {
    const m = build([block(1, 1, 1, 0, 960)], { 1: pattern(1, 100, 960, [note(1, 0, 240), note(2, 240, 240)]) }).byTrack.get(1)
    expect(m.subRows).toBe(1)
  })

  it('the lane grows up to three rows, then compresses to the same height', () => {
    const h = (subRows) => reelLaneHeight({ subRows })
    expect(h(2)).toBeGreaterThan(h(1))
    expect(h(3)).toBeGreaterThan(h(2))
    expect(h(4)).toBe(h(3))
    expect(h(40)).toBe(h(REEL_MAX_SUB_ROWS))
  })

  it('collapsed it is a 24px strip', () => {
    expect(reelLaneHeight({ subRows: 3, collapsed: true })).toBe(24)
  })

  it('compressed sub-rows tile the lane without gaps or overlap', () => {
    const lane = { y: 100, height: reelLaneHeight({ subRows: 8 }) }
    let prev = null
    for (let r = 0; r < 8; r++) {
      const { y0, y1 } = reelSubRowSpan(lane.y, lane.height, 8, r)
      expect(y1).toBeGreaterThanOrEqual(y0)
      if (prev !== null) expect(y0).toBe(prev)
      prev = y1
    }
  })
})

describe('queries', () => {
  const model = build([block(1, 1, 1, 0, 3840)], {
    1: pattern(1, 100, 3840, [note(1, 0, 960), note(2, 480, 960), note(3, 2400, 240)]),
  }).byTrack.get(1)

  it('forEachReelClipInRange visits exactly the clips touching the range', () => {
    const seen = []
    forEachReelClipInRange(model, 1000, 2000, (i) => seen.push(model.noteIds[i]))
    expect(seen).toEqual([2]) // note 1 ended at 960, note 3 starts at 2400
    seen.length = 0
    forEachReelClipInRange(model, 900, 1000, (i) => seen.push(model.noteIds[i]))
    expect(seen).toEqual([1, 2])
  })

  it('reelClipAt finds the clip in the right sub-row only', () => {
    expect(model.noteIds[reelClipAt(model, 600, 0)]).toBe(1)
    expect(model.noteIds[reelClipAt(model, 600, 1)]).toBe(2)
    expect(reelClipAt(model, 600, 2)).toBe(-1)
    expect(reelClipAt(model, 1800, 0)).toBe(-1)
  })

  it('slack makes a sub-pixel clip clickable', () => {
    expect(reelClipAt(model, 2395 - 10, 0)).toBe(-1)
    expect(model.noteIds[reelClipAt(model, 2395, 0, 10)]).toBe(3)
  })
})

describe('2,000-note pattern', () => {
  const notes = []
  for (let i = 0; i < 2000; i++) notes.push(note(i + 1, i * 120, 90 + (i % 7) * 60, { pitch: 40 + (i % 30) }))
  const patterns = { 1: pattern(1, 100, 2000 * 120, notes) }
  const blocks = [block(1, 1, 1, 0, 2000 * 120)]

  it('builds, sorts and stacks them quickly and keeps every note', () => {
    const t0 = performance.now()
    const m = build(blocks, patterns).byTrack.get(1)
    const ms = performance.now() - t0
    expect(m.count).toBe(2000)
    expect(m.subRows).toBeGreaterThan(1)
    // The sub-row assignment is a valid colouring: no two clips in one row overlap.
    const lastEnd = new Float64Array(m.subRows).fill(-1)
    for (let i = 0; i < m.count; i++) {
      expect(m.starts[i]).toBeGreaterThanOrEqual(lastEnd[m.rows[i]])
      lastEnd[m.rows[i]] = m.ends[i]
    }
    expect(ms).toBeLessThan(250)
  })

  it('a viewport query touches only the visible handful', () => {
    const m = build(blocks, patterns).byTrack.get(1)
    let visits = 0
    forEachReelClipInRange(m, 120000, 124000, () => { visits++ })
    expect(visits).toBeGreaterThan(0)
    expect(visits).toBeLessThan(60)
  })
})

describe('buildReelModel: per-note Lens state (P8)', () => {
  it('carries each clip’s Follow / Nudge / Own from the note’s lensOverride', async () => {
    const { reelClipMode, REEL_MODE_FOLLOW, REEL_MODE_NUDGE, REEL_MODE_OWN } = await import('./reelLaneModel.js')
    const notes = [
      note(1, 0, 240),
      note(2, 480, 240, { lensOverride: { mode: 'Nudge', keys: [] } }),
      note(3, 960, 240, { lensOverride: { mode: 'Own', keys: [{ channel: 'zoom', anchor: 'Head', pos: 0, value: 2 }] } }),
      note(4, 1440, 240, { lensOverride: null }),
    ]
    const m = build([block(1, 1, 1, 0, 1920)], { 1: pattern(1, 100, 1920, notes) })
    const t = m.byTrack.get(1)
    const byNote = {}
    for (let i = 0; i < t.count; i++) byNote[t.noteIds[i]] = reelClipMode(t, i)
    expect(byNote).toEqual({ 1: REEL_MODE_FOLLOW, 2: REEL_MODE_NUDGE, 3: REEL_MODE_OWN, 4: REEL_MODE_FOLLOW })
  })

  it('one override lights up every placement and loop pass of its note', async () => {
    const { reelClipMode, REEL_MODE_OWN } = await import('./reelLaneModel.js')
    const notes = [note(1, 0, 240, { lensOverride: { mode: 'Own', keys: [] } }), note(2, 480, 240)]
    // A looping block 3 pattern-lengths long, plus a second block of the same pattern.
    const m = build([block(1, 1, 1, 0, 2880), block(2, 1, 1, 3840, 960)], { 1: pattern(1, 100, 960, notes) })
    const t = m.byTrack.get(1)
    let own = 0
    for (let i = 0; i < t.count; i++) if (t.noteIds[i] === 1) { expect(reelClipMode(t, i)).toBe(REEL_MODE_OWN); own++ }
    expect(own).toBe(4)
  })

  it('an empty track reads as Follow', async () => {
    const { reelClipMode, REEL_MODE_FOLLOW, emptyReelTrack } = await import('./reelLaneModel.js')
    expect(reelClipMode(emptyReelTrack(), 0)).toBe(REEL_MODE_FOLLOW)
  })
})
