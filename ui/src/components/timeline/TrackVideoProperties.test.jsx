// @vitest-environment jsdom
//
// Focused test for the Track Detail view's Behind/Front placement toggle
// (added alongside the placement-menu rework). Only covers what's new here:
// the toggle's visibility and that it edits ONLY `placement`, never zOrder.
// Flip/Corner-Radius/Gap/Visual-FX/Slide-Note behavior is unchanged and out
// of scope.
import React, { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRoot } from 'react-dom/client'
import TrackVideoProperties from './TrackVideoProperties.jsx'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const TRACK_GRID = { id: 1, name: 'T1', type: 'Clip' }
const TRACK_FS   = { id: 3, name: 'T3', type: 'Clip' }

const LAYOUT = {
  columns: 2, rows: 2, gapScale: 0,
  slots: [
    { trackId: 1, gridX: 0, gridY: 0, spanX: 8, spanY: 8, opacity: 1, zOrder: 0 },
  ],
  fullscreenLayers: [
    { trackId: 3, placement: 'behind', opacity: 1, zOrder: -1 },
  ],
}

let container, root, timeline

async function flush() { await act(async () => { await Promise.resolve(); await Promise.resolve() }) }

async function render(trackId) {
  await act(async () => { root.render(<TrackVideoProperties trackId={trackId} onBack={() => {}} />) })
  await flush()
}

describe('TrackVideoProperties — Behind/Front placement toggle', () => {
  beforeEach(() => {
    container = document.createElement('div'); document.body.appendChild(container)
    root = createRoot(container)
    timeline = {
      getTracks: vi.fn().mockResolvedValue([TRACK_GRID, TRACK_FS]),
      getGridLayout: vi.fn().mockResolvedValue(LAYOUT),
      setFullscreenLayers: vi.fn().mockResolvedValue(true),
    }
    window.xleth = { timeline }
  })
  afterEach(() => { act(() => root.unmount()); container.remove(); vi.restoreAllMocks(); delete window.xleth })

  it('is hidden for a grid-slotted track', async () => {
    await render(1)
    expect(container.querySelector('.tvp-placement-toggle')).toBeNull()
  })

  it('is shown for a fullscreen track, with the current mode active', async () => {
    await render(3)
    const toggle = container.querySelector('.tvp-placement-toggle')
    expect(toggle).toBeTruthy()
    const behindBtn = Array.from(toggle.querySelectorAll('button')).find(b => b.textContent === 'Behind')
    expect(behindBtn.className).toContain('active')
  })

  it('clicking Front commits placement=front via setFullscreenLayers, zOrder untouched', async () => {
    await render(3)
    const toggle = container.querySelector('.tvp-placement-toggle')
    const frontBtn = Array.from(toggle.querySelectorAll('button')).find(b => b.textContent === 'Front')
    await act(async () => { frontBtn.click() })
    await flush()
    const layers = timeline.setFullscreenLayers.mock.calls.at(-1)[0]
    expect(layers.find(l => l.trackId === 3)).toMatchObject({ placement: 'front', zOrder: -1 })
  })
})
