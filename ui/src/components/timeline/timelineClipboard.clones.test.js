// A Clone is a Pattern track the engine refuses blocks on (docs/XLETH_CLONE_SPEC.md),
// so a pasted pattern block that would land on one is skipped and counted, like a
// block landing on a Clip track.
import { describe, expect, it } from 'vitest'
import { buildTimelineClipboard, resolveTimelinePaste } from './timelineClipboard.js'

const TRACKS = [
  { id: 1, type: 'Pattern', cloneOf: -1 },
  { id: 2, type: 'Pattern', cloneOf: 1, clone: { kind: 'Voice' } },
  { id: 3, type: 'Pattern', cloneOf: -1 },
]
const block = (over) => ({ id: 100, trackId: 1, patternId: 3, positionTicks: 0, durationTicks: 960, ...over })

describe('pasting onto a Clone', () => {
  it('skips the block instead of sending the engine a write it refuses', () => {
    const cb = buildTimelineClipboard({ patternBlocks: [block()], tracks: TRACKS })
    const onClone = resolveTimelinePaste({ clipboard: cb, baseTicks: 0, targetTrackIndex: 1, tracks: TRACKS })
    expect(onClone.blockPlacements).toEqual([])
    expect(onClone.skipped.typeMismatchBlock).toBe(1)
    const onSource = resolveTimelinePaste({ clipboard: cb, baseTicks: 0, targetTrackIndex: 2, tracks: TRACKS })
    expect(onSource.blockPlacements.map((p) => p.trackId)).toEqual([3])
  })
})
