// @vitest-environment jsdom
//
// Unit tests for the shared video-placement module: pure helpers (placement
// read / sort / next-free-cell / reorder-zorder math) and the IPC actions
// (assign / make-fullscreen / unplace / reorder). The load-bearing guarantee:
// these write ONLY placement zOrder / grid / fullscreen state and NEVER call
// setTrackOrder (the Audio/mixer arrangement order).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  getTrackPlacement,
  partitionAndSortTracks,
  nextFreeCell,
  computeReorderCommits,
  assignTrackToGrid,
  makeTrackFullscreen,
  setFullscreenPlacementMode,
  convertToFullscreen,
  convertToGridCell,
  unplaceTrack,
  commitReorder,
  buildPlacementMenuItems,
  SUB_UNITS_PER_COLUMN,
  SUB_UNITS_PER_ROW,
} from './trackPlacement.js'

// A 2×2 grid: two grid slots (z 0 and 10), one fullscreen-behind layer (z -1),
// one fullscreen-front layer (z 11). Track 5 has no placement.
const LAYOUT = {
  columns: 2, rows: 2,
  slots: [
    { trackId: 1, gridX: 0, gridY: 0, spanX: 8, spanY: 8, opacity: 1, zOrder: 0 },
    { trackId: 2, gridX: 8, gridY: 8, spanX: 8, spanY: 8, opacity: 1, zOrder: 10 },
  ],
  fullscreenLayers: [
    { trackId: 3, placement: 'behind', opacity: 1,   zOrder: -1 },
    { trackId: 4, placement: 'front',  opacity: 0.7, zOrder: 11 },
  ],
}
const TRACKS = [1, 2, 3, 4, 5].map(id => ({ id, name: `T${id}` }))

describe('trackPlacement — pure helpers', () => {
  it('getTrackPlacement reads grid / fullscreen / unplaced', () => {
    expect(getTrackPlacement(1, LAYOUT)).toMatchObject({ kind: 'grid', zOrder: 0, cell: { col: 0, row: 0 } })
    expect(getTrackPlacement(2, LAYOUT)).toMatchObject({ kind: 'grid', zOrder: 10, cell: { col: 1, row: 1 } })
    expect(getTrackPlacement(3, LAYOUT)).toMatchObject({ kind: 'behind', zOrder: -1 })
    expect(getTrackPlacement(4, LAYOUT)).toMatchObject({ kind: 'front', zOrder: 11 })
    expect(getTrackPlacement(5, LAYOUT)).toMatchObject({ kind: 'unplaced', zOrder: null })
  })

  it('partitionAndSortTracks orders placed by zOrder DESC (frontmost first) and separates unplaced', () => {
    const { placed, unplaced } = partitionAndSortTracks(TRACKS, LAYOUT)
    expect(placed.map(e => e.track.id)).toEqual([4, 2, 1, 3]) // z 11, 10, 0, -1
    expect(unplaced.map(t => t.id)).toEqual([5])
  })

  it('nextFreeCell walks row-major and returns fine-grid coords', () => {
    // (0,0) and (1,1) are occupied → first free is (1,0).
    const cell = nextFreeCell(LAYOUT)
    expect(cell).toMatchObject({
      col: 1, row: 0,
      gridX: 1 * SUB_UNITS_PER_COLUMN, gridY: 0,
      spanX: SUB_UNITS_PER_COLUMN, spanY: SUB_UNITS_PER_ROW,
    })
  })

  it('computeReorderCommits assigns descending integers, only for changed tracks', () => {
    // New top→bottom order: [4, 3, 2, 1] → z should become [3, 2, 1, 0].
    // Track 4: 11→3 (changed), 3: -1→2 (changed), 2: 10→1 (changed), 1: 0→0 (unchanged).
    const commits = computeReorderCommits([4, 3, 2, 1], LAYOUT)
    expect(commits).toEqual([
      { trackId: 4, zOrder: 3 },
      { trackId: 3, zOrder: 2 },
      { trackId: 2, zOrder: 1 },
    ])
  })

  it('buildPlacementMenuItems: unplaced → assign/single make-fullscreen', () => {
    const unplacedItems = buildPlacementMenuItems({ id: 5 }, LAYOUT).map(i => i.label)
    expect(unplacedItems).toEqual(['Assign to Grid Cell', 'Make Fullscreen'])
  })

  it('buildPlacementMenuItems: grid-slotted track → Convert to Fullscreen + Unplace', () => {
    const items = buildPlacementMenuItems({ id: 1 }, LAYOUT).map(i => i.label)
    expect(items).toEqual(['Convert to Fullscreen', 'Remove from Video (Unplace)'])
  })

  it('buildPlacementMenuItems: fullscreen track (behind or front) → Convert to Grid Cell + Unplace', () => {
    expect(buildPlacementMenuItems({ id: 3 }, LAYOUT).map(i => i.label))
      .toEqual(['Convert to Grid Cell', 'Remove from Video (Unplace)'])
    expect(buildPlacementMenuItems({ id: 4 }, LAYOUT).map(i => i.label))
      .toEqual(['Convert to Grid Cell', 'Remove from Video (Unplace)'])
  })
})

describe('trackPlacement — IPC actions never touch setTrackOrder', () => {
  let timeline
  beforeEach(() => {
    timeline = {
      assignTrackToGridWithZOrder: vi.fn().mockResolvedValue(true),
      setFullscreenLayers: vi.fn().mockResolvedValue(true),
      removeTrackFromGrid: vi.fn().mockResolvedValue(true),
      setPlacementZOrder: vi.fn().mockResolvedValue(true),
      setTrackOrder: vi.fn().mockResolvedValue(true),
    }
    window.xleth = { timeline }
  })
  afterEach(() => { vi.restoreAllMocks(); delete window.xleth })

  it('assignTrackToGrid → next free cell + zOrder = maxGrid+1', async () => {
    await assignTrackToGrid({ id: 5 }, LAYOUT)
    expect(timeline.assignTrackToGridWithZOrder).toHaveBeenCalledWith(5, 8, 0, 8, 8, 11) // maxGrid(10)+1
    expect(timeline.setTrackOrder).not.toHaveBeenCalled()
  })

  it('makeTrackFullscreen always defaults to behind, zOrder = maxGrid+1', async () => {
    await makeTrackFullscreen({ id: 5 }, LAYOUT)
    const layers = timeline.setFullscreenLayers.mock.calls.at(-1)[0]
    const added = layers.find(l => l.trackId === 5)
    expect(added).toMatchObject({ trackId: 5, placement: 'behind', zOrder: 11 }) // maxGrid(10)+1
    expect(timeline.setTrackOrder).not.toHaveBeenCalled()
  })

  it('setFullscreenPlacementMode flips placement only, zOrder untouched', async () => {
    await setFullscreenPlacementMode({ id: 3 }, LAYOUT, 'front')
    const layers = timeline.setFullscreenLayers.mock.calls.at(-1)[0]
    expect(layers.find(l => l.trackId === 3)).toMatchObject({ placement: 'front', zOrder: -1 })
    expect(layers.find(l => l.trackId === 4)).toMatchObject({ placement: 'front', zOrder: 11 }) // untouched
    expect(timeline.setTrackOrder).not.toHaveBeenCalled()
  })

  it('convertToFullscreen removes the grid slot and re-adds as fullscreen with the SAME zOrder', async () => {
    await convertToFullscreen({ id: 2 }, LAYOUT) // grid slot, zOrder 10
    expect(timeline.removeTrackFromGrid).toHaveBeenCalledWith(2)
    const layers = timeline.setFullscreenLayers.mock.calls.at(-1)[0]
    expect(layers.find(l => l.trackId === 2)).toMatchObject({ placement: 'behind', zOrder: 10 })
    expect(timeline.setTrackOrder).not.toHaveBeenCalled()
  })

  it('convertToGridCell removes the fullscreen layer and re-assigns to the next free cell with the SAME zOrder', async () => {
    await convertToGridCell({ id: 4 }, LAYOUT) // fullscreen-front, zOrder 11
    const layers = timeline.setFullscreenLayers.mock.calls.at(-1)[0]
    expect(layers.find(l => l.trackId === 4)).toBeUndefined()
    // (1,1) and (0,0) occupied by slots 1 and 2 → next free is (1,0).
    expect(timeline.assignTrackToGridWithZOrder).toHaveBeenCalledWith(
      4, SUB_UNITS_PER_COLUMN, 0, SUB_UNITS_PER_COLUMN, SUB_UNITS_PER_ROW, 11)
    expect(timeline.setTrackOrder).not.toHaveBeenCalled()
  })

  it('unplaceTrack removes a grid slot via removeTrackFromGrid', async () => {
    await unplaceTrack({ id: 1 }, LAYOUT)
    expect(timeline.removeTrackFromGrid).toHaveBeenCalledWith(1)
    expect(timeline.setFullscreenLayers).not.toHaveBeenCalled()
    expect(timeline.setTrackOrder).not.toHaveBeenCalled()
  })

  it('unplaceTrack removes a fullscreen layer via setFullscreenLayers filter', async () => {
    await unplaceTrack({ id: 3 }, LAYOUT)
    const layers = timeline.setFullscreenLayers.mock.calls.at(-1)[0]
    expect(layers.find(l => l.trackId === 3)).toBeUndefined()
    expect(layers.find(l => l.trackId === 4)).toBeTruthy() // other layer preserved
    expect(timeline.setTrackOrder).not.toHaveBeenCalled()
  })

  it('commitReorder writes setPlacementZOrder once per changed track, never setTrackOrder', async () => {
    // Interleave the fullscreen-front track (4) BETWEEN two grid tracks:
    // new order top→bottom [2, 4, 1, 3] → z [3, 2, 1, 0].
    await commitReorder([2, 4, 1, 3], LAYOUT)
    const calls = timeline.setPlacementZOrder.mock.calls
    expect(calls).toEqual([
      [2, 3], // grid track top
      [4, 2], // fullscreen-front now interleaved between grid cells
      [1, 1], // grid track
      [3, 0], // fullscreen-behind bottom
    ])
    expect(timeline.setTrackOrder).not.toHaveBeenCalled()
  })

  it('commitReorder skips writes when nothing changed', async () => {
    // Current order is z 11,10,-1,0 → top→bottom [4,2,3,1]. Reindex → 3,2,1,0.
    // 1 is already 0 (unchanged); the rest change. Feed the SAME dense order back
    // so all match → no writes.
    const dense = { ...LAYOUT,
      slots: [{ ...LAYOUT.slots[0], zOrder: 0 }, { ...LAYOUT.slots[1], zOrder: 1 }],
      fullscreenLayers: [
        { ...LAYOUT.fullscreenLayers[0], zOrder: 3 }, // track 3 top
        { ...LAYOUT.fullscreenLayers[1], zOrder: 2 }, // track 4
      ],
    }
    // order top→bottom [3,4,2,1] → z 3,2,1,0 which already matches dense.
    await commitReorder([3, 4, 2, 1], dense)
    expect(timeline.setPlacementZOrder).not.toHaveBeenCalled()
  })
})
