// @vitest-environment jsdom
//
// Component tests for the Video-tab flat track list: it renders every track
// sorted by real compositing zOrder (frontmost at top), separates unplaced
// tracks, and its right-click menu exposes the shared placement-mode actions.
// The reorder-commit math is unit-tested in trackPlacement.test.js; here we
// verify the list wiring + the context-menu actions fire the right IPC and
// NEVER call setTrackOrder.
import React, { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRoot } from 'react-dom/client'
import VideoTrackList from './VideoTrackList.jsx'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

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

let container, root, timeline

async function flush() { await act(async () => { await Promise.resolve() }) }

async function render(tracks = TRACKS, layout = LAYOUT) {
  await act(async () => { root.render(<VideoTrackList tracks={tracks} layout={layout} />) })
  await flush()
}

function rows(scope = container) {
  return Array.from(scope.querySelectorAll('.vtl-row'))
}

function menuItemByLabel(label) {
  return Array.from(document.querySelectorAll('.track-context-menu .context-menu-item'))
    .find(b => b.textContent.includes(label))
}

describe('VideoTrackList', () => {
  beforeEach(() => {
    container = document.createElement('div'); document.body.appendChild(container)
    root = createRoot(container)
    timeline = {
      assignTrackToGridWithZOrder: vi.fn().mockResolvedValue(true),
      setFullscreenLayers: vi.fn().mockResolvedValue(true),
      removeTrackFromGrid: vi.fn().mockResolvedValue(true),
      setPlacementZOrder: vi.fn().mockResolvedValue(true),
      setVideoHoldLastFrame: vi.fn().mockResolvedValue(true),
      removeTrack: vi.fn().mockResolvedValue(true),
      setTrackOrder: vi.fn().mockResolvedValue(true),
    }
    window.xleth = { timeline }
  })
  afterEach(() => { act(() => root.unmount()); container.remove(); vi.restoreAllMocks(); delete window.xleth })

  it('renders placed tracks sorted by zOrder DESC and an Unplaced section', async () => {
    await render()
    const placedList = container.querySelector('.vtl-list:not(.vtl-list--unplaced)')
    const names = rows(placedList).map(r => r.querySelector('.vtl-row-name').textContent)
    expect(names).toEqual(['T4', 'T2', 'T1', 'T3']) // z 11, 10, 0, -1

    const unplacedList = container.querySelector('.vtl-list--unplaced')
    expect(rows(unplacedList).map(r => r.querySelector('.vtl-row-name').textContent)).toEqual(['T5'])
  })

  it('shows placement badges (grid cell / fullscreen behind|front / unplaced)', async () => {
    await render()
    const badgeFor = (name) => rows().find(r => r.querySelector('.vtl-row-name').textContent === name)
      ?.querySelector('.vtl-row-badge')?.textContent
    expect(badgeFor('T1')).toBe('Grid 0,0')
    expect(badgeFor('T2')).toBe('Grid 1,1')
    expect(badgeFor('T3')).toBe('Fullscreen')
    expect(badgeFor('T4')).toBe('Fullscreen')
    expect(badgeFor('T5')).toBe('Unplaced')
  })

  it('right-click a placed track → Unplace fires removeTrackFromGrid, not setTrackOrder', async () => {
    await render()
    const row1 = rows().find(r => r.querySelector('.vtl-row-name').textContent === 'T1')
    await act(async () => {
      row1.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 20, clientY: 20 }))
    })
    await flush()
    const unplace = menuItemByLabel('Remove from Video (Unplace)')
    expect(unplace).toBeTruthy()
    await act(async () => { unplace.click() })
    await flush()
    expect(timeline.removeTrackFromGrid).toHaveBeenCalledWith(1)
    expect(timeline.setTrackOrder).not.toHaveBeenCalled()
  })

  it('right-click an unplaced track → single Make Fullscreen item fires setFullscreenLayers (behind, zOrder=maxGrid+1)', async () => {
    await render()
    const row5 = rows().find(r => r.querySelector('.vtl-row-name').textContent === 'T5')
    await act(async () => {
      row5.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 20, clientY: 20 }))
    })
    await flush()
    expect(menuItemByLabel('Make Fullscreen — Behind Everything')).toBeFalsy()
    expect(menuItemByLabel('Make Fullscreen — In Front of Everything')).toBeFalsy()
    const makeFullscreen = menuItemByLabel('Make Fullscreen')
    expect(makeFullscreen).toBeTruthy()
    await act(async () => { makeFullscreen.click() })
    await flush()
    const layers = timeline.setFullscreenLayers.mock.calls.at(-1)[0]
    expect(layers.find(l => l.trackId === 5)).toMatchObject({ placement: 'behind', zOrder: 11 }) // maxGrid(10)+1
    expect(timeline.setTrackOrder).not.toHaveBeenCalled()
  })

  it('right-click a grid-slotted track → Convert to Fullscreen preserves zOrder', async () => {
    await render()
    const row1 = rows().find(r => r.querySelector('.vtl-row-name').textContent === 'T1') // grid, zOrder 0
    await act(async () => {
      row1.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 20, clientY: 20 }))
    })
    await flush()
    const convert = menuItemByLabel('Convert to Fullscreen')
    expect(convert).toBeTruthy()
    await act(async () => { convert.click() })
    await flush()
    expect(timeline.removeTrackFromGrid).toHaveBeenCalledWith(1)
    const layers = timeline.setFullscreenLayers.mock.calls.at(-1)[0]
    expect(layers.find(l => l.trackId === 1)).toMatchObject({ placement: 'behind', zOrder: 0 })
    expect(timeline.setTrackOrder).not.toHaveBeenCalled()
  })

  it('right-click a fullscreen track → Convert to Grid Cell preserves zOrder', async () => {
    await render()
    const row3 = rows().find(r => r.querySelector('.vtl-row-name').textContent === 'T3') // fullscreen-behind, zOrder -1
    await act(async () => {
      row3.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 20, clientY: 20 }))
    })
    await flush()
    const convert = menuItemByLabel('Convert to Grid Cell')
    expect(convert).toBeTruthy()
    await act(async () => { convert.click() })
    await flush()
    const layers = timeline.setFullscreenLayers.mock.calls.at(-1)[0]
    expect(layers.find(l => l.trackId === 3)).toBeUndefined()
    // (0,0) and (1,1) occupied by slots 1/2 → next free cell is (1,0).
    expect(timeline.assignTrackToGridWithZOrder).toHaveBeenCalledWith(3, 8, 0, 8, 8, -1)
    expect(timeline.setTrackOrder).not.toHaveBeenCalled()
  })

  it('drag row 0 down past two rows reorders the DOM and commits new zOrders via setPlacementZOrder (no setTrackOrder)', async () => {
    await render()
    const placedSel = () => container.querySelector('.vtl-list:not(.vtl-list--unplaced)')
    const placedNames = () => rows(placedSel()).map(r => r.querySelector('.vtl-row-name').textContent)
    const placedRows = rows(placedSel()) // [T4, T2, T1, T3]
    const handle = placedRows[0].querySelector('.vtl-row-handle')

    // Start dragging T4 (top), hover over the 3rd row (T1, index 2), then release.
    await act(async () => { handle.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })) })
    await flush()
    await act(async () => {
      // React derives onMouseEnter from a bubbling 'mouseover' whose relatedTarget
      // lies outside the entered element.
      placedRows[2].dispatchEvent(new MouseEvent('mouseover', { bubbles: true, relatedTarget: document.body }))
    })
    await flush()

    // Mid-drag: the local preview must have moved T4 into the 3rd slot.
    expect(placedNames()).toEqual(['T2', 'T1', 'T4', 'T3'])

    await act(async () => { document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true })) })
    await flush()

    // New top→bottom order [T2, T1, T4, T3] → dense z [3, 2, 1, 0].
    expect(timeline.setTrackOrder).not.toHaveBeenCalled()
    const seen = Object.fromEntries(timeline.setPlacementZOrder.mock.calls.map(([id, z]) => [id, z]))
    expect(seen[2]).toBe(3)
    expect(seen[1]).toBe(2)
    expect(seen[4]).toBe(1) // fullscreen-front track interleaved between grid cells
    expect(seen[3]).toBe(0)
  })
})
