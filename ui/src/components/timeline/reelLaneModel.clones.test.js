// Clones in the Reel model (docs/XLETH_CLONE_SPEC.md, "Timeline and Motion view"):
// the source's lane keeps voice 0 (+ overflow, flagged), each Voice clone gets the
// notes it plays, a Trail clone gets voice 0 shifted by its delay. All of it from
// the source's blocks; Clone tracks own none.
import { describe, expect, it } from 'vitest'
import {
  REEL_FLAG_OVERFLOW, buildReelModel, cloneLaneHeight, reelClipOverflows, reelLaneHeight, trailDelayTicks,
} from './reelLaneModel.js'

const sources = { 10: { id: 10, hasVideo: true, filePath: 'a.mp4', duration: 4 }, 11: { id: 11, hasVideo: false } }
const regions = { 100: { id: 100, sourceId: 10, startTime: 0 }, 101: { id: 101, sourceId: 11, startTime: 0 } }

const n = (id, s, e, pitch, extra = {}) => ({ id, positionTicks: s, durationTicks: e - s, pitch, velocity: 1, ...extra })
const block = (id, trackId, patternId, positionTicks, durationTicks, extra = {}) =>
  ({ id, trackId, patternId, positionTicks, durationTicks, offsetTicks: 0, loopEnabled: false, ...extra })

const lead = { id: 1, name: 'Lead', type: 'Pattern', order: 0, cloneOf: -1 }
const voice1 = { id: 2, name: 'Lead · Clone 1', type: 'Pattern', order: 1, cloneOf: 1, clone: { kind: 'Voice', voice: 1 } }
const voice2 = { id: 3, name: 'Lead · Clone 2', type: 'Pattern', order: 2, cloneOf: 1, clone: { kind: 'Voice', voice: 2 } }
const trail = { id: 4, name: 'Lead · Trail 1', type: 'Pattern', order: 3, cloneOf: 1, clone: { kind: 'Trail', voice: 0, delayTicks: 480 } }

// G (67) and a harmony E (64) on the same tick, then C (60) under both: with one
// Voice clone, G stays on the source, E goes to Clone 1 and C overflows.
const chord = [n(1, 0, 960, 67), n(2, 0, 960, 64), n(3, 0, 960, 60), n(4, 1920, 2400, 62)]
const patterns = { 1: { id: 1, regionId: 100, lengthTicks: 3840, notes: chord } }
const blocks = [block(1, 1, 1, 3840, 3840)]

const clipsOf = (lane) => Array.from({ length: lane.count }, (_, i) => ({
  start: lane.starts[i], end: lane.ends[i], noteId: lane.noteIds[i], patternId: lane.patternIds[i],
  overflow: reelClipOverflows(lane, i),
}))

describe('buildReelModel with Clones', () => {
  it('no Clones: the source lane shows every note and flags nothing', () => {
    const { byTrack } = buildReelModel({ tracks: [lead], patternBlocks: blocks, patterns, regions, sources })
    const clips = clipsOf(byTrack.get(1))
    expect(clips.map((c) => c.noteId).sort()).toEqual([1, 2, 3, 4])
    expect(clips.every((c) => !c.overflow)).toBe(true)
  })

  it('one Voice clone: the source keeps voice 0 plus the overflow note, flagged; Clone 1 gets the harmony', () => {
    const { byTrack } = buildReelModel({ tracks: [lead, voice1], patternBlocks: blocks, patterns, regions, sources })
    const src = clipsOf(byTrack.get(1))
    expect(src.map((c) => [c.noteId, c.overflow]).sort()).toEqual([[1, false], [3, true], [4, false]])
    const c1 = clipsOf(byTrack.get(2))
    expect(c1).toEqual([{ start: 3840, end: 4800, noteId: 2, patternId: 1, overflow: false }])
  })

  it('two Voice clones: no overflow, each voice in its own lane', () => {
    const { byTrack } = buildReelModel({ tracks: [lead, voice1, voice2], patternBlocks: blocks, patterns, regions, sources })
    expect(clipsOf(byTrack.get(1)).map((c) => c.noteId).sort()).toEqual([1, 4])
    expect(clipsOf(byTrack.get(2)).map((c) => c.noteId)).toEqual([2])
    expect(clipsOf(byTrack.get(3)).map((c) => c.noteId)).toEqual([3])
    expect(clipsOf(byTrack.get(1)).some((c) => c.overflow)).toBe(false)
  })

  it('Voice clone order is track order, not list order', () => {
    const swapped = [{ ...voice2, order: 1 }, { ...voice1, order: 2 }]
    const { byTrack } = buildReelModel({ tracks: [lead, ...swapped], patternBlocks: blocks, patterns, regions, sources })
    // Clone 2 (id 3) is now first: it plays voice 1 (the E), id 2 plays voice 2 (the C).
    expect(clipsOf(byTrack.get(3)).map((c) => c.noteId)).toEqual([2])
    expect(clipsOf(byTrack.get(2)).map((c) => c.noteId)).toEqual([3])
  })

  it('a pin moves a note to its voice', () => {
    const pinned = { 1: { ...patterns[1], notes: chord.map((x) => (x.id === 1 ? { ...x, voicePin: 1 } : x)) } }
    const { byTrack } = buildReelModel({ tracks: [lead, voice1], patternBlocks: blocks, patterns: pinned, regions, sources })
    expect(clipsOf(byTrack.get(2)).map((c) => c.noteId)).toEqual([1])
  })

  it('a Trail clone: the source cell (voice 0 and overflow) shifted by its delay, nothing flagged', () => {
    const { byTrack } = buildReelModel({ tracks: [lead, voice1, trail], patternBlocks: blocks, patterns, regions, sources })
    const src = clipsOf(byTrack.get(1))
    const tr = clipsOf(byTrack.get(4))
    expect(tr.map((c) => c.noteId)).toEqual(src.map((c) => c.noteId))
    tr.forEach((c, i) => {
      expect(c.start).toBe(src[i].start + 480)
      expect(c.end).toBe(src[i].end + 480)
      expect(c.patternId).toBe(1)
      expect(c.overflow).toBe(false)
    })
  })

  it('Clone lanes follow the source block: loops and offsets come from the same walk', () => {
    const looped = [block(1, 1, 1, 0, 7680, { loopEnabled: true })]
    const { byTrack } = buildReelModel({ tracks: [lead, voice1], patternBlocks: looped, patterns, regions, sources })
    expect(clipsOf(byTrack.get(2)).map((c) => c.start)).toEqual([0, 3840])
  })

  it('a source whose pattern has no video gives its Clones no lane either', () => {
    const audioOnly = { 1: { ...patterns[1], regionId: 101 } }
    const { byTrack } = buildReelModel({ tracks: [lead, voice1, trail], patternBlocks: blocks, patterns: audioOnly, regions, sources })
    expect(byTrack.size).toBe(0)
  })

  it('a Clone never gets a lane of its own from blocks (the engine refuses them)', () => {
    const stray = [...blocks, block(9, 2, 1, 0, 3840)]
    const { byTrack } = buildReelModel({ tracks: [lead, voice1], patternBlocks: stray, patterns, regions, sources })
    expect(clipsOf(byTrack.get(2)).map((c) => c.noteId)).toEqual([2])
  })

  it('sub-rows: the overflow note stacks under voice 0 in the source lane', () => {
    const { byTrack } = buildReelModel({ tracks: [lead, voice1], patternBlocks: blocks, patterns, regions, sources })
    expect(byTrack.get(1).subRows).toBe(2)
    expect(byTrack.get(2).subRows).toBe(1)
  })

  it('exposes the overflow flag bit', () => {
    const { byTrack } = buildReelModel({ tracks: [lead, voice1], patternBlocks: blocks, patterns, regions, sources })
    const lane = byTrack.get(1)
    const i = Array.from(lane.noteIds).indexOf(3)
    expect(lane.flags[i] & REEL_FLAG_OVERFLOW).toBe(REEL_FLAG_OVERFLOW)
  })
})

describe('trailDelayTicks / cloneLaneHeight', () => {
  it('a Trail delay is a whole, non-negative tick count', () => {
    expect(trailDelayTicks(trail)).toBe(480)
    expect(trailDelayTicks({ clone: { delayTicks: -5 } })).toBe(0)
    expect(trailDelayTicks({})).toBe(0)
  })

  it('a Clone row is never shorter than a track row; collapsed it is the 24px strip', () => {
    expect(cloneLaneHeight({ subRows: 1, trackHeight: 36 })).toBe(36)
    expect(cloneLaneHeight({ subRows: 3, trackHeight: 36 })).toBe(reelLaneHeight({ subRows: 3, trackHeight: 36 }))
    expect(cloneLaneHeight({ subRows: 3, collapsed: true, trackHeight: 36 })).toBe(24)
  })
})
