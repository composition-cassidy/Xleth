// A Clone's row (docs/XLETH_CLONE_SPEC.md): a track row whose band IS a read-only
// Reel lane. It keeps its track index (so visibleTracks and trackTop line up), but
// resolves to no track for tools and drops, and the Reel hit-test finds it.
import { describe, expect, it } from 'vitest'
import { buildTrackLayout } from './timelineRowLayout.js'
import { cloneLaneHeight, reelLaneHeight } from './reelLaneModel.js'
import { TRACK_HEIGHT } from '../../constants/timeline.js'

const tracks = [
  { id: 1, name: 'Lead', type: 'Pattern', order: 0, cloneOf: -1 },
  { id: 2, name: 'Lead · Clone 1', type: 'Pattern', order: 1, cloneOf: 1, clone: { kind: 'Voice' } },
  { id: 3, name: 'Lead · Trail 1', type: 'Pattern', order: 2, cloneOf: 1, clone: { kind: 'Trail', delayTicks: 480 } },
  { id: 4, name: 'Bass', type: 'Clip', order: 3, cloneOf: -1 },
]

describe('Clone rows', () => {
  it('sit in track order as track rows marked laneKind "clone", after the source and its Reel lane', () => {
    const layout = buildTrackLayout({ tracks, reelLanes: { 1: { subRows: 2 }, 2: { subRows: 1 }, 3: { subRows: 2 } } })
    expect(layout.rows.map((r) => `${r.rowType}:${r.laneKind}`)).toEqual([
      'track:track', 'reel:reel', 'track:clone', 'track:clone', 'track:track',
    ])
    const [, , c1, c2] = layout.rows
    expect(c1).toMatchObject({ trackId: 2, trackIndex: 1, cloneKind: 'Voice', sourceTrackId: 1, reelTrackId: 2, subRows: 1 })
    expect(c2).toMatchObject({ trackId: 3, trackIndex: 2, cloneKind: 'Trail', sourceTrackId: 1, reelTrackId: 3, subRows: 2 })
    expect(c1.height).toBe(cloneLaneHeight({ subRows: 1, trackHeight: TRACK_HEIGHT }))
    expect(c2.height).toBe(Math.max(TRACK_HEIGHT, reelLaneHeight({ subRows: 2 })))
    expect(layout.cloneRows).toEqual([c1, c2])
    // A Clone gets no Reel row of its own: its row is the lane.
    expect(layout.getReelRows().map((r) => r.parentTrackId)).toEqual([1])
    expect(layout.getReelLaneRows().map((r) => r.id)).toEqual(['reel:1', 'track:2', 'track:3'])
  })

  it('keep their track index and top, and the stack stays gap-free', () => {
    const layout = buildTrackLayout({ tracks, reelLanes: { 1: { subRows: 1 }, 3: { subRows: 3 } } })
    for (let i = 1; i < layout.rows.length; i++) {
      expect(layout.rows[i].y).toBe(layout.rows[i - 1].y + layout.rows[i - 1].height)
    }
    const c2 = layout.cloneRows[1]
    expect(layout.trackTop(2)).toBe(c2.y)
    expect(layout.trackTop(3)).toBe(c2.y + c2.height)
  })

  it('resolve to no track index (read-only: no draw, drop or paste onto a Clone)', () => {
    const layout = buildTrackLayout({ tracks })
    const [c1, c2] = layout.cloneRows
    expect(layout.trackIndexAtY(c1.y + 2)).toBe(-1)
    expect(layout.trackIndexAtY(c2.y + c2.height - 1)).toBe(-1)
    expect(layout.trackIndexAtY(c2.y + c2.height + 2)).toBe(3)
    expect(layout.trackIndexAtY(2)).toBe(0)
  })

  it('are found by the Reel hit-test row lookup', () => {
    const layout = buildTrackLayout({ tracks, reelLanes: { 1: { subRows: 1 } } })
    const [c1] = layout.cloneRows
    expect(layout.reelRowAtY(c1.y + 3)).toBe(c1)
    const reel = layout.getReelRows()[0]
    expect(layout.reelRowAtY(reel.y + 1)).toBe(reel)
  })

  it('collapse to the 24px strip with their entry (the source group state)', () => {
    const layout = buildTrackLayout({ tracks, reelLanes: { 1: { collapsed: true, subRows: 1 }, 2: { collapsed: true, subRows: 2 }, 3: { collapsed: true, subRows: 1 } } })
    expect(layout.cloneRows.map((r) => [r.collapsed, r.height])).toEqual([[true, 24], [true, 24]])
  })

  it('without a lane entry (the source has no video) are still read-only rows, one track tall', () => {
    const layout = buildTrackLayout({ tracks })
    expect(layout.cloneRows.map((r) => r.height)).toEqual([TRACK_HEIGHT, TRACK_HEIGHT])
    expect(layout.cloneRows.every((r) => r.collapsed === false && r.subRows === 1)).toBe(true)
  })

  it('a project with no Clones lays out exactly as before', () => {
    const plain = tracks.filter((t) => t.cloneOf < 0)
    const layout = buildTrackLayout({ tracks: plain, reelLanes: { 1: { subRows: 1 } } })
    expect(layout.cloneRows).toEqual([])
    expect(layout.rows.map((r) => r.rowType)).toEqual(['track', 'reel', 'track'])
  })
})
