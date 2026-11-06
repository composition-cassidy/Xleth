// @vitest-environment jsdom
//
// The Preview's Edit Grid row took over the Video tab's grid controls in
// Phase 3. The grid-resize regressions (ported from VideoOverviewTab's
// conversion test) still apply: a shrink never silently deletes a placement,
// it asks first, and it keeps out-of-bounds slots when confirmed.
import React, { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRoot } from 'react-dom/client'
import GridEditToolbar from './GridEditToolbar.jsx'
import useGridEditStore from '../../stores/useGridEditStore.js'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

// trackId 346 sits at gridX=16,spanX=8 (reaches x=24, the max for 3 columns),
// so a column shrink pushes it out of bounds — the slot that used to vanish.
const REAL_LAYOUT = {
  columns: 3, rows: 3, previewFps: 30, gapScale: 0,
  canvasWidth: 1024, canvasHeight: 768, canvasAspectRatio: '4:3',
  fullscreenLayers: [{ trackId: 700, placement: 'behind', opacity: 1 }],
  slots: [
    { gridX: 8,  gridY: 8, opacity: 1, spanX: 8, spanY: 8, trackId: 106, zOrder: 0 },
    { gridX: 0,  gridY: 8, opacity: 1, spanX: 8, spanY: 8, trackId: 195, zOrder: 1 },
    { gridX: 16, gridY: 8, opacity: 1, spanX: 8, spanY: 8, trackId: 346, zOrder: 2 },
    { gridX: 4,  gridY: 4, opacity: 1, spanX: 4, spanY: 4, trackId: 668, zOrder: 3 },
    { gridX: 12, gridY: 4, opacity: 1, spanX: 4, spanY: 4, trackId: 972, zOrder: 4 },
  ],
}

let container, root, timeline

async function flush() { await act(async () => { await Promise.resolve(); await Promise.resolve() }) }

async function render(layout) {
  timeline.getGridLayout.mockResolvedValue(layout)
  await act(async () => { root.render(<GridEditToolbar />) })
  await flush()
}

const slider = (label) => container.querySelector(`[role="slider"][aria-label="${label}"]`)
async function key(el, k) {
  await act(async () => { el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true })) })
  await flush()
}
const lastGridLayout = () => timeline.setGridLayout.mock.calls.at(-1)?.[0]
const ids = (slots) => (slots ?? []).map(s => s.trackId).sort((a, b) => a - b)

describe('GridEditToolbar — grid size never loses placements', () => {
  beforeEach(() => {
    container = document.createElement('div'); document.body.appendChild(container)
    root = createRoot(container)
    timeline = {
      getGridLayout: vi.fn(),
      setGridLayout: vi.fn().mockResolvedValue(true),
      listSnapshots: vi.fn().mockResolvedValue([{ id: 's1', name: 'Main', active: true }]),
    }
    window.xleth = { timeline }
    useGridEditStore.setState({ snapEnabled: true })
  })
  afterEach(() => { act(() => root.unmount()); container.remove(); vi.restoreAllMocks(); delete window.xleth })

  it('shows the grid size, gap and canvas from the engine layout', async () => {
    await render(REAL_LAYOUT)
    expect(slider('Grid columns').getAttribute('aria-valuetext')).toBe('Grid columns, 3')
    expect(slider('Grid rows').getAttribute('aria-valuetext')).toBe('Grid rows, 3')
    expect(container.textContent).toContain('1024×768')
  })

  it('column reduction 3 -> 2 keeps ALL slots (out-of-bounds preserved) when confirmed', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    await render(REAL_LAYOUT)
    await key(slider('Grid columns'), 'ArrowDown')
    const p = lastGridLayout()
    expect(p.columns).toBe(2)
    expect(ids(p.slots)).toEqual([106, 195, 346, 668, 972])
  })

  it('a reduction that would orphan a placement asks first and aborts on cancel', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false)
    await render(REAL_LAYOUT)
    await key(slider('Grid columns'), 'PageDown')
    expect(confirmSpy).toHaveBeenCalledTimes(1)
    expect(timeline.setGridLayout).not.toHaveBeenCalled()
  })

  it('a column INCREASE never prompts', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true)
    await render(REAL_LAYOUT)
    await key(slider('Grid columns'), 'ArrowUp')
    expect(confirmSpy).not.toHaveBeenCalled()
    expect(lastGridLayout().columns).toBe(4)
    expect(ids(lastGridLayout().slots)).toEqual([106, 195, 346, 668, 972])
  })

  it('gap commits as a 0..0.5 scale', async () => {
    await render(REAL_LAYOUT)
    await key(slider('Grid gap'), 'ArrowUp')
    expect(lastGridLayout().gapScale).toBeCloseTo(0.01)
  })

  it('Snap is a toggle in the row, backed by the grid-edit store', async () => {
    await render(REAL_LAYOUT)
    const snap = Array.from(container.querySelectorAll('button[aria-pressed]')).find(b => b.textContent.includes('Snap'))
    expect(snap.getAttribute('aria-pressed')).toBe('true')
    await act(async () => { snap.click() })
    expect(useGridEditStore.getState().snapEnabled).toBe(false)
  })
})
