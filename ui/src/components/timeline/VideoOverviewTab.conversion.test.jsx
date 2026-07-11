// @vitest-environment jsdom
//
// Ported from the deleted components/grid/GridSettingsPanel.conversion.test.jsx.
//
// Regression: canvas aspect/resolution/FPS changes and grid resize must never
// silently lose user-authored grid placements or fullscreen layers.
//
// Phase 3 relocated these controls: canvas (aspect/resolution/FPS) now lives in
// VideoCanvasSettingsPopover; grid size lives inline in VideoOverviewTab. The
// slot-preservation logic (confirmGridResize keeps out-of-bounds placements;
// persistCanvas re-reads the engine layout as its base) moved verbatim, so the
// same regression assertions apply.
import React, { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRoot } from 'react-dom/client'
import VideoOverviewTab from './VideoOverviewTab.jsx'
import VideoCanvasSettingsPopover from './VideoCanvasSettingsPopover.jsx'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

// Mirrors the real project's destructive structure: trackId 346 sits at
// gridX=16,spanX=8 (reaches x=24, the max for 3 columns) so a column shrink
// would push it out of bounds — the exact slot that used to vanish.
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

const SIXTEEN_NINE = {
  columns: 3, rows: 3, previewFps: 30, gapScale: 0,
  canvasWidth: 1920, canvasHeight: 1080, canvasAspectRatio: '16:9',
  fullscreenLayers: [{ trackId: 700, placement: 'behind', opacity: 0.7 }],
  slots: [
    { gridX: 0,  gridY: 0, opacity: 1, spanX: 8, spanY: 8, trackId: 10, zOrder: 0 },
    { gridX: 16, gridY: 8, opacity: 1, spanX: 8, spanY: 8, trackId: 11, zOrder: 1 },
  ],
}

const trackList = (layout) => [
  ...(layout.slots ?? []).map(s => ({ id: s.trackId, name: 'T' + s.trackId })),
  ...(layout.fullscreenLayers ?? []).map(l => ({ id: l.trackId, name: 'FS' + l.trackId })),
]

let container, root, setGridLayout, setFullscreenLayers, setPreviewFps, getGridLayout, getTracks

async function flush() { await act(async () => { await Promise.resolve() }) }

// VideoOverviewTab hosts the inline grid-size inputs. It fetches the layout from
// the engine on mount, so seed getGridLayout with the layout under test.
async function renderTab(layout) {
  getGridLayout.mockResolvedValue(layout)
  getTracks.mockResolvedValue(trackList(layout))
  await act(async () => { root.render(<VideoOverviewTab />) })
  await flush()
  await flush()
}

// VideoCanvasSettingsPopover hosts aspect/resolution/FPS. persistCanvas re-reads
// getGridLayout() as its base — the engine layout, not the React prop.
async function renderPopover(propLayout, engineLayout = propLayout) {
  getGridLayout.mockResolvedValue(engineLayout)
  const setLayout = vi.fn()
  await act(async () => {
    root.render(
      <VideoCanvasSettingsPopover
        layout={propLayout}
        setLayout={setLayout}
        onClose={() => {}}
        triggerRef={{ current: null }}
      />
    )
  })
  await flush()
}

async function changeSelect(trigger, value) {
  await act(async () => { trigger.click() })
  await flush()
  const option = Array.from(document.querySelectorAll('[data-value]'))
    .find(el => el.dataset.value === String(value))
  if (!option) throw new Error(`XlethSelect option with data-value="${value}" not found`)
  await act(async () => { option.click() })
  await flush()
}

async function changeInput(input, value) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
  await act(async () => { setter.call(input, String(value)); input.dispatchEvent(new Event('input', { bubbles: true })) })
  await flush()
}

const lastGridLayout = () => setGridLayout.mock.calls.at(-1)?.[0]
const ids = (slots) => (slots ?? []).map(s => s.trackId).sort((a, b) => a - b)
const canvasSelects = () => Array.from(container.querySelectorAll('.gsp-canvas-select'))

describe('Video tab — canvas conversion never loses placements', () => {
  beforeEach(() => {
    container = document.createElement('div'); document.body.appendChild(container)
    root = createRoot(container)
    setGridLayout = vi.fn().mockResolvedValue(true)
    setFullscreenLayers = vi.fn().mockResolvedValue(true)
    setPreviewFps = vi.fn().mockResolvedValue(true)
    getGridLayout = vi.fn()
    getTracks = vi.fn().mockResolvedValue([])
    window.xleth = { timeline: { setGridLayout, setFullscreenLayers, setPreviewFps, getGridLayout, getTracks } }
  })
  afterEach(() => { act(() => root.unmount()); container.remove(); vi.restoreAllMocks() })

  // ── The reported regression ────────────────────────────────────────────────
  it('aspect 16:9 -> 9:16 preserves every slot (count, IDs, geometry) and fullscreen layers', async () => {
    await renderPopover(SIXTEEN_NINE)
    await changeSelect(canvasSelects()[0], '9:16')

    const p = lastGridLayout()
    expect(p.canvasAspectRatio).toBe('9:16')
    expect(p.slots).toHaveLength(2)
    expect(ids(p.slots)).toEqual([10, 11])
    // Geometry (fine-grid coords) is canvas-independent: identical before/after.
    expect(p.slots).toEqual(SIXTEEN_NINE.slots)
    expect(p.fullscreenLayers).toEqual(SIXTEEN_NINE.fullscreenLayers)
  })

  it('aspect 4:3 -> 9:16 on the real-project layout keeps all 5 slots + media refs (trackIds)', async () => {
    await renderPopover(REAL_LAYOUT)
    await changeSelect(canvasSelects()[0], '9:16')

    const p = lastGridLayout()
    expect(p.slots).toHaveLength(5)
    expect(ids(p.slots)).toEqual([106, 195, 346, 668, 972])
    expect(p.fullscreenLayers).toHaveLength(1)
    expect(p.columns).toBe(3)
    expect(p.rows).toBe(3)
  })

  // ── Partial / stale React state can't clobber engine truth ──────────────────
  it('canvas change uses the engine layout as base — slots survive even if the React layout prop is partial', async () => {
    // The React prop arrives WITHOUT slots/fullscreen (simulating a stale/partial
    // render), but the engine still holds the real placements.
    const partial = { columns: 3, rows: 3, previewFps: 30, gapScale: 0,
      canvasWidth: 1024, canvasHeight: 768, canvasAspectRatio: '4:3' }
    await renderPopover(partial, REAL_LAYOUT)
    await changeSelect(canvasSelects()[0], '16:9')

    const p = lastGridLayout()
    expect(p.canvasAspectRatio).toBe('16:9')
    expect(p.slots).toHaveLength(5)            // from the engine, not the partial prop
    expect(p.fullscreenLayers).toHaveLength(1)
  })

  // ── Resolution-only (same aspect) is non-geometric ──────────────────────────
  it('resolution-only change (same aspect) leaves slot geometry untouched', async () => {
    await renderPopover(REAL_LAYOUT)
    await changeSelect(canvasSelects()[1], '2048x1536') // 4:3 -> 4:3, just bigger

    const p = lastGridLayout()
    expect(p.canvasWidth).toBe(2048)
    expect(p.canvasHeight).toBe(1536)
    expect(p.canvasAspectRatio).toBe('4:3')
    expect(p.slots).toEqual(REAL_LAYOUT.slots) // geometry identical
  })

  // ── FPS is timing-only ──────────────────────────────────────────────────────
  it('FPS change never touches geometry (no setGridLayout, only setPreviewFps)', async () => {
    await renderPopover(REAL_LAYOUT)
    await changeSelect(canvasSelects()[2], '60')

    expect(setPreviewFps).toHaveBeenCalledWith(60)
    expect(setGridLayout).not.toHaveBeenCalled()
  })

  // ── Grid shrink: no silent deletion ─────────────────────────────────────────
  it('column reduction 3 -> 2 keeps ALL slots (out-of-bounds preserved, not deleted) when confirmed', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    await renderTab(REAL_LAYOUT)
    await changeInput(container.querySelector('.gsp-dim-input'), '2')

    const p = lastGridLayout()
    expect(p.columns).toBe(2)
    // trackId 346 (gridX=16,spanX=8 -> out of bounds at 2 cols) MUST still be here.
    expect(ids(p.slots)).toEqual([106, 195, 346, 668, 972])
  })

  it('column reduction that would orphan a placement asks for confirmation and aborts on cancel', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false)
    await renderTab(REAL_LAYOUT)
    await changeInput(container.querySelector('.gsp-dim-input'), '1')

    expect(confirmSpy).toHaveBeenCalledTimes(1)
    expect(setGridLayout).not.toHaveBeenCalled() // cancelled → nothing persisted
  })

  it('column INCREASE never prompts (no placement can be orphaned)', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true)
    await renderTab(REAL_LAYOUT)
    await changeInput(container.querySelector('.gsp-dim-input'), '5')

    expect(confirmSpy).not.toHaveBeenCalled()
    const p = lastGridLayout()
    expect(p.columns).toBe(5)
    expect(ids(p.slots)).toEqual([106, 195, 346, 668, 972])
  })
})
