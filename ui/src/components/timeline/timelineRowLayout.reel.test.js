import { describe, expect, it } from 'vitest'
import { buildTrackLayout } from './timelineRowLayout.js'
import { reelLaneHeight } from './reelLaneModel.js'
import { TRACK_HEIGHT } from '../../constants/timeline.js'

const tracks = [
  { id: 1, name: 'Lead', type: 'Pattern' },
  { id: 2, name: 'Drums', type: 'Pattern' },
]

describe('Reel lane row', () => {
  it('sits directly under its track and pushes later tracks down', () => {
    const layout = buildTrackLayout({ tracks, reelLanes: { 1: { collapsed: false, subRows: 2 } } })
    expect(layout.rows.map((r) => r.rowType)).toEqual(['track', 'reel', 'track'])
    const [t1, reel, t2] = layout.rows
    expect(reel.y).toBe(t1.y + TRACK_HEIGHT)
    expect(reel.height).toBe(reelLaneHeight({ subRows: 2 }))
    expect(reel.parentTrackId).toBe(1)
    expect(t2.y).toBe(reel.y + reel.height)
    expect(layout.totalHeight).toBe(t2.y + TRACK_HEIGHT)
  })

  it('a track without a lane is unchanged', () => {
    const plain = buildTrackLayout({ tracks })
    const same = buildTrackLayout({ tracks, reelLanes: {} })
    expect(same.rows.map((r) => r.y)).toEqual(plain.rows.map((r) => r.y))
    expect(plain.getReelRows()).toEqual([])
  })

  it('collapsed it is the 24px strip', () => {
    const layout = buildTrackLayout({ tracks, reelLanes: { 2: { collapsed: true, subRows: 3 } } })
    expect(layout.getReelRows()[0]).toMatchObject({ parentTrackId: 2, collapsed: true, height: 24 })
  })

  it('a collapsed track hides its lane with it', () => {
    const layout = buildTrackLayout({ tracks, collapsed: new Set([1]), reelLanes: { 1: { subRows: 1 } } })
    expect(layout.getReelRows()).toEqual([])
  })

  it('lane Y resolves to no track (read-only: no tool may act on the parent through it)', () => {
    const layout = buildTrackLayout({ tracks, reelLanes: { 1: { collapsed: false, subRows: 1 } } })
    const reel = layout.getReelRows()[0]
    expect(layout.trackIndexAtY(reel.y + 2)).toBe(-1)
    expect(layout.reelRowAtY(reel.y + 2)).toBe(reel)
    expect(layout.reelRowAtY(reel.y - 1)).toBeNull()
    expect(layout.trackIndexAtY(reel.y + reel.height + 1)).toBe(1)
  })

  it('exposes track height so the painter and the hit test share geometry', () => {
    const layout = buildTrackLayout({ tracks, trackHeight: 60, reelLanes: { 1: { subRows: 1 } } })
    expect(layout.getReelRows()[0].trackHeight).toBe(60)
    expect(layout.getReelRows()[0].height).toBe(reelLaneHeight({ subRows: 1, trackHeight: 60 }))
  })
})
