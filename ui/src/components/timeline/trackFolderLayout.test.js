import { describe, expect, it } from 'vitest'
import {
  flattenTrackIds,
  moveFolderInLayout,
  moveTracksInLayout,
  normalizeTrackLayout,
  rootIndexForSelectedTracks,
  updateTrackSelection,
  visibleTracksForLayout,
} from './trackFolderLayout.js'

const tracks = [
  { id: 1, name: 'One' },
  { id: 2, name: 'Two' },
  { id: 3, name: 'Three' },
  { id: 4, name: 'Four' },
]

const layout = {
  rootOrder: [
    { kind: 'track', id: 1 },
    { kind: 'folder', id: 10 },
    { kind: 'track', id: 4 },
  ],
  folders: [{ id: 10, name: 'Group', collapsed: false, trackIds: [2, 3] }],
}

describe('track folder layout helpers', () => {
  it('flattens canonical order and omits collapsed members from visible tracks', () => {
    expect(flattenTrackIds(layout)).toEqual([1, 2, 3, 4])
    expect(visibleTracksForLayout(layout, tracks).map(track => track.id)).toEqual([1, 2, 3, 4])
    const collapsed = {
      ...layout,
      folders: [{ ...layout.folders[0], collapsed: true }],
    }
    expect(visibleTracksForLayout(collapsed, tracks).map(track => track.id)).toEqual([1, 4])
  })

  it('moves an ordered multi-selection between root and folders atomically', () => {
    const intoFolder = moveTracksInLayout(layout, [1, 4], {
      kind: 'folder', folderId: 10, index: 1,
    })
    expect(intoFolder.rootOrder).toEqual([{ kind: 'folder', id: 10 }])
    expect(intoFolder.folders[0].trackIds).toEqual([2, 1, 4, 3])

    const backToRoot = moveTracksInLayout(intoFolder, [1, 4], { kind: 'root', index: 1 })
    expect(backToRoot.rootOrder).toEqual([
      { kind: 'folder', id: 10 },
      { kind: 'track', id: 1 },
      { kind: 'track', id: 4 },
    ])
    expect(backToRoot.folders[0].trackIds).toEqual([2, 3])
  })

  it('moves folders only at root level and finds the earliest selected root item', () => {
    const moved = moveFolderInLayout(layout, 10, 0)
    expect(moved.rootOrder[0]).toEqual({ kind: 'folder', id: 10 })
    expect(rootIndexForSelectedTracks(layout, new Set([3, 4]))).toBe(1)
  })

  it('falls back flat for duplicates, unknown IDs, missing entities, and malformed metadata', () => {
    const flat = tracks.map(track => ({ kind: 'track', id: track.id }))
    expect(normalizeTrackLayout(null, tracks).rootOrder).toEqual(flat)
    expect(normalizeTrackLayout({
      ...layout,
      folders: [{ ...layout.folders[0], trackIds: [2, 2] }],
    }, tracks).rootOrder).toEqual(flat)
    expect(normalizeTrackLayout({
      ...layout,
      folders: [{ ...layout.folders[0], trackIds: [2, 99] }],
    }, tracks).rootOrder).toEqual(flat)
    expect(normalizeTrackLayout({
      rootOrder: layout.rootOrder.slice(0, 2),
      folders: layout.folders,
    }, tracks).rootOrder).toEqual(flat)
  })

  it('supports click, Ctrl/Cmd toggle, and Shift visible-range selection', () => {
    let state = updateTrackSelection({
      selectedTrackIds: new Set([1, 2]), visibleTrackIds: [1, 2, 3, 4], trackId: 3,
    })
    expect([...state.selectedTrackIds]).toEqual([3])

    state = updateTrackSelection({
      selectedTrackIds: state.selectedTrackIds,
      visibleTrackIds: [1, 2, 3, 4],
      trackId: 1,
      anchorTrackId: state.anchorTrackId,
      toggle: true,
    })
    expect([...state.selectedTrackIds]).toEqual([3, 1])

    state = updateTrackSelection({
      selectedTrackIds: state.selectedTrackIds,
      visibleTrackIds: [1, 2, 3, 4],
      trackId: 4,
      anchorTrackId: state.anchorTrackId,
      range: true,
    })
    expect([...state.selectedTrackIds]).toEqual([1, 2, 3, 4])
  })
})
