import { describe, expect, it } from 'vitest'
import {
  buildTimelineClipboard,
  clipPayloadFromSnapshot,
  itemsCoveredByPlacements,
  normalizeTimelineClipboardPayloads,
  placementsEndTick,
  resolveTimelinePaste,
} from './timelineClipboard.js'

const TRACKS = [
  { id: 10, type: 'Clip' },
  { id: 11, type: 'Clip' },
  { id: 12, type: 'Pattern' },
  { id: 13, type: 'Clip' },
]

const clip = (over) => ({
  id: 1, trackId: 10, regionId: 7, positionTicks: 0, durationTicks: 480, ...over,
})
const block = (over) => ({
  id: 100, trackId: 12, patternId: 3, positionTicks: 0, durationTicks: 960, ...over,
})

describe('normalizeTimelineClipboardPayloads', () => {
  it('preserves both payloads for a mixed clip and pattern-block selection', () => {
    const clips = [{ regionId: 7 }]
    const patternBlocks = [{ patternId: 12 }]

    expect(normalizeTimelineClipboardPayloads(clips, patternBlocks)).toEqual({
      clips,
      patternBlocks,
    })
  })

  it('clears stale payloads when the new selection has no matching items', () => {
    expect(normalizeTimelineClipboardPayloads([], null)).toEqual({
      clips: null,
      patternBlocks: null,
    })
  })
})

describe('buildTimelineClipboard', () => {
  it('anchors clips and pattern blocks to ONE shared origin', () => {
    // The block starts 4 beats after the clip. Anchoring each kind separately
    // would zero both relativePositions and lose that gap.
    const cb = buildTimelineClipboard({
      clips: [clip({ positionTicks: 960 })],
      patternBlocks: [block({ positionTicks: 1920 })],
      tracks: TRACKS,
    })
    expect(cb.clips[0].relativePosition).toBe(0)
    expect(cb.patternBlocks[0].relativePosition).toBe(960)
  })

  it('stores track offsets relative to the topmost selected track', () => {
    const cb = buildTimelineClipboard({
      clips: [clip({ id: 1, trackId: 11 }), clip({ id: 2, trackId: 13 })],
      tracks: TRACKS,
    })
    expect(cb.anchorTrackIndex).toBe(1)
    expect(cb.clips.map(c => c.trackOffset)).toEqual([0, 2])
  })

  it('carries every playback modifier, not just position and duration', () => {
    const cb = buildTimelineClipboard({
      clips: [clip({
        stretchRatio: 2.5, pitchOffsetCents: -37, reversed: true,
        formantPreserve: true, fadeInPercent: 12,
        modulation: { vibratoDepth: 0.4 },
      })],
      tracks: TRACKS,
    })
    expect(cb.clips[0]).toMatchObject({
      stretchRatio: 2.5, pitchOffsetCents: -37, reversed: true,
      formantPreserve: true, fadeInPercent: 12,
      modulation: { vibratoDepth: 0.4 },
    })
  })

  it('drops items whose track no longer exists', () => {
    const cb = buildTimelineClipboard({
      clips: [clip({ trackId: 999 })],
      tracks: TRACKS,
    })
    expect(cb.clips).toBeNull()
  })
})

describe('resolveTimelinePaste', () => {
  it('re-anchors the group at the focused track without deforming it', () => {
    const cb = buildTimelineClipboard({
      clips: [
        clip({ id: 1, trackId: 10, positionTicks: 480 }),
        clip({ id: 2, trackId: 11, positionTicks: 1440 }),
      ],
      tracks: TRACKS,
    })
    const { clipPlacements } = resolveTimelinePaste({
      clipboard: cb, baseTicks: 3840, targetTrackIndex: 0, tracks: TRACKS,
    })
    // Gap between the two clips (960t) and their 1-track separation survive.
    expect(clipPlacements.map(p => p.positionTicks)).toEqual([3840, 4800])
    expect(clipPlacements.map(p => p.trackId)).toEqual([10, 11])
  })

  it('skips a clip whose destination offset lands on a Pattern track', () => {
    const cb = buildTimelineClipboard({
      clips: [clip({ trackId: 10 })],
      tracks: TRACKS,
    })
    const res = resolveTimelinePaste({
      clipboard: cb, baseTicks: 0, targetTrackIndex: 2, tracks: TRACKS,
    })
    expect(res.clipPlacements).toHaveLength(0)
    expect(res.skipped.typeMismatchClip).toBe(1)
  })

  it('clamps offsets that would run off the end of the track list', () => {
    const cb = buildTimelineClipboard({
      clips: [clip({ id: 1, trackId: 10 }), clip({ id: 2, trackId: 11 })],
      tracks: TRACKS,
    })
    const { clipPlacements } = resolveTimelinePaste({
      clipboard: cb, baseTicks: 0, targetTrackIndex: 3, tracks: TRACKS,
    })
    // Both land on the last track (13); neither escapes the list.
    expect(clipPlacements.map(p => p.trackId)).toEqual([13, 13])
  })
})

describe('itemsCoveredByPlacements', () => {
  const existing = [
    { id: 1, trackId: 10, positionTicks: 0,   durationTicks: 480 },
    { id: 2, trackId: 10, positionTicks: 480, durationTicks: 480 },
    { id: 3, trackId: 11, positionTicks: 0,   durationTicks: 480 },
  ]

  it('reports only items the incoming group actually overlaps', () => {
    const placements = [{ trackId: 10, positionTicks: 240, durationTicks: 120 }]
    expect(itemsCoveredByPlacements(existing, placements)).toEqual([1])
  })

  it('treats a butted edge as no overlap', () => {
    // Placement starts exactly where clip 1 ends — half-open intervals.
    const placements = [{ trackId: 10, positionTicks: 480, durationTicks: 10 }]
    expect(itemsCoveredByPlacements(existing, placements)).toEqual([2])
  })

  it('never reports an item on a different track', () => {
    const placements = [{ trackId: 11, positionTicks: 0, durationTicks: 4800 }]
    expect(itemsCoveredByPlacements(existing, placements)).toEqual([3])
  })
})

describe('clipPayloadFromSnapshot', () => {
  it('fills engine defaults for fields the snapshot omitted', () => {
    const payload = clipPayloadFromSnapshot({ regionId: 7, durationTicks: 480 }, 10, 960)
    expect(payload).toMatchObject({
      trackId: 10, positionTicks: 960, regionId: 7, durationTicks: 480,
      stretchRatio: 1.0, velocity: 1.0, syllableIndex: -1, reversed: false,
      fadeInX2: 1, fadeOutY2: 1,
    })
    expect(payload).not.toHaveProperty('modulation')
  })
})

describe('placementsEndTick', () => {
  it('returns the furthest end across every list', () => {
    expect(placementsEndTick(
      100,
      [{ positionTicks: 100, durationTicks: 480 }],
      [{ positionTicks: 200, durationTicks: 960 }],
    )).toBe(1160)
  })

  it('falls back to the base tick for an empty paste', () => {
    expect(placementsEndTick(4800, [], [])).toBe(4800)
  })
})
