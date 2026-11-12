import { describe, expect, it } from 'vitest'
import { TRACK_HEIGHT, CLIP_MIN_WIDTH_PX, beatsToTicks } from '../../constants/timeline.js'
import {
  BLOCK_EDGE_HIT_W, BLOCK_PAD, TITLE_STRIP_H,
  blockEdgeAt, blockEdgeHitWidth, blockInnerLayout, blockRect, blockShowsHandles,
  blockWantsTitleStrip, blocksInPixelRect, buildTrackIdToIndex, findBlockAtTick,
  getClipRect, hitTestBlockAt, trackIndexAtY, trackTopOf,
} from './blockGeometry.js'

const block = (id, trackId, positionBeats, durationBeats) => ({
  id, trackId, positionTicks: beatsToTicks(positionBeats), durationTicks: beatsToTicks(durationBeats),
})
const view = (ppb, scrollOffset = 0, trackIdToIndex = { a: 0, b: 1 }) => ({ ppb, scrollOffset, trackIdToIndex })

describe('blockRect', () => {
  it('snaps both edges to whole pixels at any scroll offset', () => {
    for (const scroll of [0, 0.137, 3.3333, 11.5001]) {
      for (const ppb of [8, 23.7, 137.3]) {
        const r = blockRect(block(1, 'a', 4, 2.5), 0, scroll, ppb)
        expect(Number.isInteger(r.x)).toBe(true)
        expect(Number.isInteger(r.w)).toBe(true)
      }
    }
  })

  it('makes blocks that share a tick boundary share a pixel boundary', () => {
    // The right edge of one block and the left edge of the next round the same
    // number, so butted clips never show a gap or overlap, whatever the view.
    const a = block(1, 'a', 4, 1.25)
    const b = block(2, 'a', 5.25, 3)
    for (const scroll of [0, 0.41, 2.7183, 9.99]) {
      for (const ppb of [8, 19.3, 40, 137.3, 811]) {
        const ra = blockRect(a, 0, scroll, ppb)
        const rb = blockRect(b, 0, scroll, ppb)
        expect(ra.x + ra.w).toBe(rb.x)
      }
    }
  })

  it('never paints a block narrower than the minimum width', () => {
    const r = blockRect({ positionTicks: 0, durationTicks: 1 }, 0, 0, 8)
    expect(r.w).toBe(CLIP_MIN_WIDTH_PX)
  })

  it('keeps the exact time mapping alongside the snapped rectangle', () => {
    const r = blockRect(block(1, 'a', 4, 2), 0, 0.137, 23.7)
    expect(r.timeX).toBeCloseTo((4 - 0.137) * 23.7, 9)
    expect(r.timeW).toBeCloseTo(2 * 23.7, 9)
    expect(Math.abs(r.x - r.timeX)).toBeLessThanOrEqual(0.5)
  })

  it('sits inside its track row, through the row layout when there is one', () => {
    const plain = blockRect(block(1, 'a', 0, 1), 2, 0, 40)
    expect(plain.y).toBe(2 * TRACK_HEIGHT + BLOCK_PAD)
    expect(plain.h).toBe(TRACK_HEIGHT - BLOCK_PAD * 2)

    const layout = { trackTop: (i) => i * TRACK_HEIGHT + 50, trackIndexAtY: () => 7 }
    expect(blockRect(block(1, 'a', 0, 1), 2, 0, 40, layout).y).toBe(2 * TRACK_HEIGHT + 50 + BLOCK_PAD)
    expect(trackTopOf(2, layout)).toBe(2 * TRACK_HEIGHT + 50)
    expect(trackIndexAtY(123, layout)).toBe(7)
    expect(trackIndexAtY(TRACK_HEIGHT * 2 + 1)).toBe(2)
  })

  it('reuses the caller-supplied object', () => {
    const scratch = {}
    expect(blockRect(block(1, 'a', 0, 1), 0, 0, 40, null, scratch)).toBe(scratch)
  })

  it('getClipRect is the same rectangle, or null for an unknown track', () => {
    const clip = block(1, 'b', 3, 2)
    expect(getClipRect(clip, { a: 0, b: 1 }, 0.3, 40)).toEqual(blockRect(clip, 1, 0.3, 40))
    expect(getClipRect(clip, { a: 0 }, 0.3, 40)).toBeNull()
    expect(getClipRect(null, { a: 0 }, 0, 40)).toBeNull()
  })
})

describe('hitTestBlockAt', () => {
  it('hits a block everywhere it is painted, including the minimum-width part', () => {
    // 1 tick long: about 0.008px of real time at this zoom, painted 4px wide.
    const tiny = { id: 't', trackId: 'a', positionTicks: beatsToTicks(10), durationTicks: 1 }
    const v = view(8)
    const r = blockRect(tiny, 0, v.scrollOffset, v.ppb)
    for (let x = r.x; x < r.x + r.w; x++) {
      expect(hitTestBlockAt([tiny], x + 0.5, 0, v)).toBe(tiny)
    }
    expect(hitTestBlockAt([tiny], r.x - 0.5, 0, v)).toBeNull()
    expect(hitTestBlockAt([tiny], r.x + r.w + 0.5, 0, v)).toBeNull()
  })

  it('returns the block painted on top where two overlap', () => {
    // Blocks paint in array order, so the later one covers the earlier one.
    const under = block('under', 'a', 0, 4)
    const over = block('over', 'a', 2, 4)
    const v = view(40)
    expect(hitTestBlockAt([under, over], 3 * 40, 0, v)).toBe(over)
    expect(hitTestBlockAt([over, under], 3 * 40, 0, v)).toBe(under)
    expect(hitTestBlockAt([under, over], 1 * 40, 0, v)).toBe(under)
  })

  it('only considers blocks on the requested track', () => {
    const a = block('a1', 'a', 0, 4)
    const b = block('b1', 'b', 0, 4)
    const v = view(40)
    expect(hitTestBlockAt([a, b], 20, 0, v)).toBe(a)
    expect(hitTestBlockAt([a, b], 20, 1, v)).toBe(b)
    expect(hitTestBlockAt([a, b], 20, 2, v)).toBeNull()
    expect(hitTestBlockAt([a, b], 20, -1, v)).toBeNull()
    expect(hitTestBlockAt(null, 20, 0, v)).toBeNull()
  })

  it('follows the scroll offset', () => {
    const a = block('a1', 'a', 10, 2)
    expect(hitTestBlockAt([a], 5, 0, view(40, 10))).toBe(a)
    expect(hitTestBlockAt([a], 5, 0, view(40, 0))).toBeNull()
  })
})

describe('findBlockAtTick', () => {
  it('uses the time span, half-open, topmost first', () => {
    const a = block('a1', 'a', 0, 1)
    const b = block('a2', 'a', 1, 1)
    const idx = { a: 0 }
    expect(findBlockAtTick([a, b], 0, 0, idx)).toBe(a)
    expect(findBlockAtTick([a, b], beatsToTicks(1) - 1, 0, idx)).toBe(a)
    expect(findBlockAtTick([a, b], beatsToTicks(1), 0, idx)).toBe(b)
    expect(findBlockAtTick([a, b], beatsToTicks(2), 0, idx)).toBeNull()
    const over = block('over', 'a', 0, 2)
    expect(findBlockAtTick([a, b, over], beatsToTicks(1), 0, idx)).toBe(over)
  })
})

describe('resize edges', () => {
  it('uses the full hit width on a wide block', () => {
    const r = { x: 100, y: 0, w: 200, h: 32 }
    expect(blockEdgeHitWidth(r.w)).toBe(BLOCK_EDGE_HIT_W)
    expect(blockEdgeAt(r, 100)).toBe('left')
    expect(blockEdgeAt(r, 100 + BLOCK_EDGE_HIT_W - 0.5)).toBe('left')
    expect(blockEdgeAt(r, 100 + BLOCK_EDGE_HIT_W)).toBeNull()
    expect(blockEdgeAt(r, 200)).toBeNull()
    expect(blockEdgeAt(r, 300 - BLOCK_EDGE_HIT_W)).toBe('right')
    expect(blockEdgeAt(r, 299.5)).toBe('right')
  })

  it('always leaves a middle that moves the block, however narrow it is', () => {
    for (let w = CLIP_MIN_WIDTH_PX; w <= 40; w++) {
      const r = { x: 50, y: 0, w, h: 32 }
      let body = 0, left = 0, right = 0
      for (let px = 0; px < w; px++) {
        const edge = blockEdgeAt(r, 50 + px + 0.5)
        if (edge === 'left') left++
        else if (edge === 'right') right++
        else body++
      }
      expect(body).toBeGreaterThan(0)
      expect(left).toBeGreaterThan(0)
      expect(right).toBeGreaterThan(0)
      expect(left).toBe(right)
    }
  })

  it('shows handles only when they fit', () => {
    expect(blockShowsHandles({ w: 12 })).toBe(false)
    expect(blockShowsHandles({ w: 13 })).toBe(true)
  })
})

describe('blocksInPixelRect', () => {
  const items = [block('a1', 'a', 0, 2), block('a2', 'a', 4, 2), block('b1', 'b', 1, 2)]
  const v = view(40)

  it('returns every block the rectangle touches, in any corner order', () => {
    const ids = (list) => list.map((b) => b.id).sort()
    const rowB = TRACK_HEIGHT + BLOCK_PAD + 5
    expect(ids(blocksInPixelRect(items, 10, 5, 50, rowB, v))).toEqual(['a1', 'b1'])
    expect(ids(blocksInPixelRect(items, 50, rowB, 10, 5, v))).toEqual(['a1', 'b1'])
    expect(ids(blocksInPixelRect(items, 0, 5, 400, 6, v))).toEqual(['a1', 'a2'])
    expect(blocksInPixelRect(items, 90, 5, 150, 6, v)).toEqual([])
    expect(blocksInPixelRect(null, 0, 0, 1, 1, v)).toEqual([])
  })

  it('does not reach across the gap between two rows', () => {
    // The band sits in the padding between row 0 and row 1 and touches neither.
    const y = TRACK_HEIGHT - 1
    expect(blocksInPixelRect(items, 0, y, 400, y + 1.5, v)).toEqual([])
  })

  it('lets the caller veto blocks', () => {
    const onlyTrackB = (_item, trackIndex) => trackIndex === 1
    const rowB = TRACK_HEIGHT + BLOCK_PAD + 5
    expect(blocksInPixelRect(items, 0, 0, 400, rowB, v, onlyTrackB).map((b) => b.id)).toEqual(['b1'])
  })
})

describe('blockInnerLayout', () => {
  it('reserves a title strip above the content when there is room', () => {
    const r = { x: 10, y: 2, w: 200, h: 32 }
    const layout = blockInnerLayout(r, true)
    expect(layout.useStrip).toBe(true)
    expect(layout.titleY).toBe(2)
    expect(layout.titleH).toBe(TITLE_STRIP_H)
    expect(layout.contentY).toBeGreaterThan(layout.titleY + layout.titleH)
    expect(layout.contentY + layout.contentH).toBe(r.y + r.h)
  })

  it('gives the whole block to the content on a short lane', () => {
    const r = { x: 10, y: 2, w: 200, h: 20 }
    const layout = blockInnerLayout(r, true)
    expect(layout.useStrip).toBe(false)
    expect(layout.contentY).toBe(r.y)
    expect(layout.contentH).toBe(r.h)
  })

  it('wants no title strip on a tiny block or when names are off', () => {
    expect(blockWantsTitleStrip({ w: 24 }, 'auto')).toBe(false)
    expect(blockWantsTitleStrip({ w: 25 }, 'auto')).toBe(true)
    expect(blockWantsTitleStrip({ w: 200 }, 'never')).toBe(false)
  })
})

describe('buildTrackIdToIndex', () => {
  it('maps ids to positions and tolerates no tracks', () => {
    expect(buildTrackIdToIndex([{ id: 'x' }, { id: 7 }])).toEqual({ x: 0, 7: 1 })
    expect(buildTrackIdToIndex(null)).toEqual({})
  })
})
