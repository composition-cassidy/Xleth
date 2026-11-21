// @vitest-environment jsdom
//
// The track rail beside the Preview picture in Edit Grid mode: one row per
// track with its cell, the Place / Layers switch, and the keyboard alternative
// to dragging (Enter places an unplaced track in the next free cell).
import React, { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRoot } from 'react-dom/client'
import GridEditorDock, { placementText } from './GridEditorDock.jsx'
import useGridEditStore from '../stores/useGridEditStore.js'
import { activeDragTrackId } from './gridEditorDragState.js'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const TRACKS = [
  { id: 1, name: 'bass', type: 'Sampler' },
  { id: 2, name: 'pitch', type: 'Pattern' },
  { id: 3, name: 'ch1', type: 'Sampler' },
  { id: 4, name: 'base', type: 'Sampler' },
]
const LAYOUT = {
  columns: 3, rows: 3,
  slots: [
    { trackId: 1, gridX: 0, gridY: 0, spanX: 8, spanY: 8, zOrder: 0 },
    { trackId: 2, gridX: 8, gridY: 0, spanX: 8, spanY: 8, zOrder: 1 },
  ],
  fullscreenLayers: [{ trackId: 4, placement: 'behind', opacity: 1, zOrder: 2 }],
}

let container, root, timeline

async function flush() { await act(async () => { await Promise.resolve(); await Promise.resolve() }) }
async function render() {
  await act(async () => { root.render(<GridEditorDock />) })
  await flush()
}
const rows = () => Array.from(container.querySelectorAll('[data-track-row]'))
const rowOf = (name) => rows().find((r) => r.querySelector('span')?.textContent === name || r.textContent.startsWith(name))

describe('GridEditorDock: the track rail', () => {
  beforeEach(() => {
    container = document.createElement('div'); document.body.appendChild(container)
    root = createRoot(container)
    timeline = {
      getTracks: vi.fn().mockResolvedValue(TRACKS),
      getGridLayout: vi.fn().mockResolvedValue(LAYOUT),
      assignTrackToGridWithZOrder: vi.fn().mockResolvedValue(true),
    }
    window.xleth = { timeline }
    useGridEditStore.setState({ stripView: 'place' })
  })
  afterEach(() => { act(() => root.unmount()); container.remove(); vi.restoreAllMocks(); delete window.xleth })

  it('names where a track sits in the fewest characters', () => {
    expect(placementText({ kind: 'grid', cell: { col: 2, row: 0 } })).toBe('2,0')
    expect(placementText({ kind: 'behind' })).toBe('Behind')
    expect(placementText({ kind: 'front' })).toBe('Front')
    expect(placementText({ kind: 'unplaced' })).toBe('Not placed')
  })

  it('lists every track with its cell, and counts placed grid slots in the filter', async () => {
    await render()
    expect(rows().map((r) => r.textContent)).toEqual(['bass0,0', 'pitch1,0', 'ch1Not placed', 'baseBehind'])
    const filter = container.querySelector('[role="radiogroup"][aria-label="Show tracks"]')
    expect(filter.textContent).toContain('All 4')
    expect(filter.textContent).toContain('Unplaced 2')
    expect(filter.textContent).toContain('Placed 2')
  })

  it('the Unplaced filter keeps only tracks not on the grid', async () => {
    await render()
    const unplaced = Array.from(container.querySelectorAll('[role="radio"]')).find((b) => b.textContent.startsWith('Unplaced'))
    await act(async () => { unplaced.click() })
    expect(rows().map((r) => r.textContent)).toEqual(['ch1Not placed', 'baseBehind'])
  })

  it('every row is draggable and carries its track id for the picture to take', async () => {
    await render()
    const row = rowOf('ch1')
    expect(row.getAttribute('draggable')).toBe('true')
    const dt = { setData: vi.fn(), effectAllowed: '' }
    const ev = new Event('dragstart', { bubbles: true }); ev.dataTransfer = dt
    await act(async () => { row.dispatchEvent(ev) })
    expect(dt.setData).toHaveBeenCalledWith('application/x-xleth-track', '3')
    expect(activeDragTrackId).toBe(3)
  })

  it('Enter on an unplaced row places it in the next free cell (the keyboard alternative to dragging)', async () => {
    await render()
    await act(async () => { rowOf('ch1').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })) })
    await flush()
    // Cells 0,0 and 1,0 are taken: the next free one is column 2, row 0.
    expect(timeline.assignTrackToGridWithZOrder).toHaveBeenCalledWith(3, 16, 0, 8, 8, 2)
  })

  it('Arrow keys move between rows', async () => {
    await render()
    const first = rowOf('bass'); first.focus()
    await act(async () => { first.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })) })
    expect(document.activeElement).toBe(rowOf('pitch'))
  })

  it('Layers shows the compositing stack with short badges', async () => {
    useGridEditStore.setState({ stripView: 'layers' })
    await render()
    expect(container.querySelector('[data-testid="grid-editor-dock"]')).not.toBeNull()
    expect(container.querySelector('.vtl-list')).not.toBeNull()
    expect(container.textContent).toContain('Behind')
    expect(container.textContent).not.toContain('Fullscreen')
  })
})
