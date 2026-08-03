import { describe, expect, it } from 'vitest'
import { normalizeTimelineClipboardPayloads } from './timelineClipboard.js'

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
