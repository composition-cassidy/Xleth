import { describe, expect, it } from 'vitest'
import {
  buildTimelineClipboard,
  clipPayloadFromSnapshot,
  itemsCoveredByPlacements,
  normalizeTimelineClipboardPayloads,
  placementsEndTick,
  resolveOverwritePlan,
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

describe('buildTimelineClipboard — automation clips', () => {
  const automationClip = (over) => ({
    id: 500, laneId: 3, positionTicks: 0, durationTicks: 1920,
    offsetTicks: 0, envelopeId: 42, ...over,
  })

  it('anchors an automation-only selection to its own earliest clip', () => {
    const cb = buildTimelineClipboard({
      automationClips: [automationClip({ positionTicks: 480 })],
      tracks: TRACKS,
    })
    expect(cb.clips).toBeNull()
    expect(cb.patternBlocks).toBeNull()
    expect(cb.automationClips).toHaveLength(1)
    expect(cb.automationClips[0].relativePosition).toBe(0)
    expect(cb.automationClips[0].laneId).toBe(3)
    expect(cb.automationClips[0].envelopeId).toBe(42)
    expect(cb.automationClips[0].offsetTicks).toBe(0)
  })

  it('shares ONE anchor across clips, blocks, and automation clips together', () => {
    const cb = buildTimelineClipboard({
      clips: [clip({ positionTicks: 960 })],
      automationClips: [automationClip({ positionTicks: 1920 })],
      tracks: TRACKS,
    })
    // Automation clip starts 960t after the clip — anchoring separately
    // would zero both relativePositions and lose that gap.
    expect(cb.clips[0].relativePosition).toBe(0)
    expect(cb.automationClips[0].relativePosition).toBe(960)
  })

  it('does not require a track anchor when only automation clips are selected', () => {
    // anchorTrackIndex must not be Infinity (Math.min over an empty array)
    // when there are no clips/blocks to derive a track anchor from.
    const cb = buildTimelineClipboard({
      automationClips: [automationClip()],
      tracks: TRACKS,
    })
    expect(cb.anchorTrackIndex).toBe(0)
  })

  it('carries envelopeId and offsetTicks through untouched (copies share the envelope)', () => {
    const cb = buildTimelineClipboard({
      automationClips: [automationClip({ envelopeId: 7, offsetTicks: 240 })],
      tracks: TRACKS,
    })
    expect(cb.automationClips[0]).toMatchObject({ envelopeId: 7, offsetTicks: 240 })
  })

  it('returns null automationClips when none are selected', () => {
    const cb = buildTimelineClipboard({
      clips: [clip()],
      tracks: TRACKS,
    })
    expect(cb.automationClips).toBeNull()
  })
})

describe('resolveTimelinePaste — automation clips', () => {
  const automationClip = (over) => ({
    id: 500, laneId: 3, positionTicks: 480, durationTicks: 1920,
    offsetTicks: 0, envelopeId: 42, ...over,
  })

  it('re-anchors at baseTicks, staying on the SAME lane (no cross-lane retargeting)', () => {
    const cb = buildTimelineClipboard({
      automationClips: [automationClip({ positionTicks: 480 })],
      tracks: TRACKS,
    })
    const { automationPlacements } = resolveTimelinePaste({
      clipboard: cb, baseTicks: 3840, targetTrackIndex: 0, tracks: TRACKS,
    })
    expect(automationPlacements).toHaveLength(1)
    expect(automationPlacements[0].positionTicks).toBe(3840)
    expect(automationPlacements[0].laneId).toBe(3)
    expect(automationPlacements[0].item.envelopeId).toBe(42)
  })

  it('preserves internal spacing between two automation clips on paste', () => {
    const cb = buildTimelineClipboard({
      automationClips: [
        automationClip({ id: 1, laneId: 3, positionTicks: 0 }),
        automationClip({ id: 2, laneId: 3, positionTicks: 960 }),
      ],
      tracks: TRACKS,
    })
    const { automationPlacements } = resolveTimelinePaste({
      clipboard: cb, baseTicks: 5000, targetTrackIndex: 0, tracks: TRACKS,
    })
    expect(automationPlacements.map(p => p.positionTicks)).toEqual([5000, 5960])
  })

  it('is empty when the clipboard has no automation clips', () => {
    const cb = buildTimelineClipboard({ clips: [clip()], tracks: TRACKS })
    const { automationPlacements } = resolveTimelinePaste({
      clipboard: cb, baseTicks: 0, targetTrackIndex: 0, tracks: TRACKS,
    })
    expect(automationPlacements).toEqual([])
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

describe('itemsCoveredByPlacements — gesture members', () => {
  const existing = [
    clip({ id: 1, trackId: 10, positionTicks: 0,   durationTicks: 480 }),
    clip({ id: 2, trackId: 10, positionTicks: 480, durationTicks: 480 }),
  ]

  it('never reports an item the gesture is itself moving', () => {
    // Clip 1 nudged +240 still covers its own old span. Without the exclusion a
    // move would delete the very clip it is moving.
    const placements = [{ trackId: 10, positionTicks: 240, durationTicks: 480 }]
    expect(itemsCoveredByPlacements(existing, placements, new Set([1]))).toEqual([2])
  })

  it('never reports a sibling that is vacating its slot in the same gesture', () => {
    // 1 and 2 swap-shift right by one slot together: 2 lands where nothing will
    // remain, because 1 and 2 are both moving. Neither is doomed.
    const placements = [
      { trackId: 10, positionTicks: 480, durationTicks: 480 },
      { trackId: 10, positionTicks: 960, durationTicks: 480 },
    ]
    expect(itemsCoveredByPlacements(existing, placements, new Set([1, 2]))).toEqual([])
  })

  it('still reports untouched items when an exclusion set is given', () => {
    const placements = [{ trackId: 10, positionTicks: 500, durationTicks: 100 }]
    expect(itemsCoveredByPlacements(existing, placements, new Set([1]))).toEqual([2])
  })
})

describe('resolveOverwritePlan', () => {
  it('resolves clips and pattern blocks in one call, each against its own list', () => {
    const plan = resolveOverwritePlan({
      existingClips: [clip({ id: 1, trackId: 10, positionTicks: 0, durationTicks: 480 })],
      existingBlocks: [block({ id: 100, trackId: 12, positionTicks: 0, durationTicks: 960 })],
      clipPlacements: [{ trackId: 10, positionTicks: 240, durationTicks: 480 }],
      blockPlacements: [{ trackId: 12, positionTicks: 480, durationTicks: 960 }],
    })
    expect(plan).toEqual({ doomedClipIds: [1], doomedBlockIds: [100] })
  })

  it('excludes each kind with its OWN moving set', () => {
    const plan = resolveOverwritePlan({
      existingClips: [clip({ id: 1, trackId: 10, positionTicks: 0, durationTicks: 480 })],
      existingBlocks: [block({ id: 100, trackId: 12, positionTicks: 0, durationTicks: 960 })],
      clipPlacements: [{ trackId: 10, positionTicks: 240, durationTicks: 480 }],
      blockPlacements: [{ trackId: 12, positionTicks: 480, durationTicks: 960 }],
      movingClipIds: new Set([1]),
      movingBlockIds: new Set([100]),
    })
    expect(plan).toEqual({ doomedClipIds: [], doomedBlockIds: [] })
  })

  it('is empty for a gesture with no placements', () => {
    expect(resolveOverwritePlan()).toEqual({ doomedClipIds: [], doomedBlockIds: [] })
  })
})
