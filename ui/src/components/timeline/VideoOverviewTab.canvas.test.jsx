// @vitest-environment jsdom
//
// Ported from the deleted components/grid/GridSettingsPanel.canvas.test.jsx.
// Phase 3 removed the standalone Grid Settings panel. Its canvas controls
// (Aspect / Size / FPS) now live in VideoCanvasSettingsPopover, and its live
// grid preview renders inline in VideoOverviewTab. The DOM class names
// (gsp-canvas-select / gsp-preview-svg / gsp-preview-frame / gsp-dim-input) are
// unchanged, so the same assertions apply. Canvas-control tests render the
// popover directly (it is normally opened from VideoOverviewTab's header
// button); preview tests render VideoOverviewTab.
import React, { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRoot } from 'react-dom/client'
import VideoOverviewTab from './VideoOverviewTab.jsx'
import VideoCanvasSettingsPopover from './VideoCanvasSettingsPopover.jsx'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

let container, root, setGridLayout, getGridLayout, getTracks, setPreviewFps, setFullscreenLayers

const BASE_LAYOUT = {
  columns: 3, rows: 3, slots: [], fullscreenLayers: [],
  previewFps: 30, gapScale: 0,
  canvasWidth: 1920, canvasHeight: 1080, canvasAspectRatio: '16:9',
}

async function flush() { await act(async () => { await Promise.resolve() }) }

function installEngineMock() {
  setGridLayout       = vi.fn().mockResolvedValue(true)
  setPreviewFps       = vi.fn().mockResolvedValue(true)
  setFullscreenLayers = vi.fn().mockResolvedValue(true)
  getTracks           = vi.fn().mockResolvedValue([])
  getGridLayout       = vi.fn()
  window.xleth = { timeline: { setGridLayout, setPreviewFps, setFullscreenLayers, getTracks, getGridLayout } }
}

// ── VideoOverviewTab renders the inline grid preview; it fetches the layout
//    from the engine on mount, so the preview reflects getGridLayout. ─────────
async function renderTab(layout = BASE_LAYOUT) {
  getGridLayout.mockResolvedValue(layout)
  await act(async () => { root.render(<VideoOverviewTab />) })
  await flush()
  await flush()
}

// ── VideoCanvasSettingsPopover hosts the Aspect/Size/FPS controls. Render it
//    directly (persistCanvas re-reads getGridLayout as its base). ─────────────
async function renderPopover(layout = BASE_LAYOUT) {
  getGridLayout.mockResolvedValue(layout)
  const setLayout = vi.fn()
  await act(async () => {
    root.render(
      <VideoCanvasSettingsPopover
        layout={layout}
        setLayout={setLayout}
        onClose={() => {}}
        triggerRef={{ current: null }}
      />
    )
  })
  await flush()
}

function canvasSelects() {
  // XlethSelect renders a <button class="xleth-select-trigger gsp-canvas-select">
  return Array.from(container.querySelectorAll('.gsp-canvas-select'))
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
  await act(async () => {
    setter.call(input, String(value))
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await flush()
}

describe('VideoCanvasSettingsPopover — dropdown controls use XlethSelect', () => {
  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    installEngineMock()
  })

  afterEach(() => {
    act(() => { root.unmount() })
    container.remove()
    vi.clearAllMocks()
  })

  it('Aspect control is an XlethSelect button (not a native select)', async () => {
    await renderPopover()
    const [aspectTrigger] = canvasSelects()
    expect(aspectTrigger.tagName).toBe('BUTTON')
    expect(aspectTrigger.getAttribute('aria-haspopup')).toBe('listbox')
  })

  it('Size control is an XlethSelect button (not a native select)', async () => {
    await renderPopover()
    const [, sizeTrigger] = canvasSelects()
    expect(sizeTrigger.tagName).toBe('BUTTON')
    expect(sizeTrigger.getAttribute('aria-haspopup')).toBe('listbox')
  })
})

describe('VideoOverviewTab — live grid mini-preview', () => {
  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    installEngineMock()
  })

  afterEach(() => {
    act(() => { root.unmount() })
    container.remove()
    vi.clearAllMocks()
  })

  it('mini-preview SVG viewBox matches 4:3 canvas (160×120)', async () => {
    await renderTab({ ...BASE_LAYOUT, canvasWidth: 1024, canvasHeight: 768, canvasAspectRatio: '4:3' })
    const svg = container.querySelector('.gsp-preview-svg')
    expect(svg?.getAttribute('viewBox')).toBe('0 0 160 120')
  })

  it('mini-preview SVG viewBox matches 9:16 canvas (portrait)', async () => {
    await renderTab({ ...BASE_LAYOUT, canvasWidth: 720, canvasHeight: 1280, canvasAspectRatio: '9:16' })
    const svg = container.querySelector('.gsp-preview-svg')
    expect(svg?.getAttribute('viewBox')).toBe('0 0 160 284')
  })

  it('mini-preview SVG viewBox is 160×90 for default 16:9 canvas', async () => {
    await renderTab()
    const svg = container.querySelector('.gsp-preview-svg')
    expect(svg?.getAttribute('viewBox')).toBe('0 0 160 90')
  })

  it('mini-preview frame inline style reflects project canvas aspect ratio', async () => {
    await renderTab({ ...BASE_LAYOUT, canvasWidth: 1024, canvasHeight: 768, canvasAspectRatio: '4:3' })
    const frame = container.querySelector('.gsp-preview-frame')
    expect(frame?.style.aspectRatio).toBe('1024 / 768')
  })
})

describe('VideoCanvasSettingsPopover — project canvas controls', () => {
  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    installEngineMock()
  })

  afterEach(() => {
    act(() => { root.unmount() })
    container.remove()
    vi.clearAllMocks()
  })

  it('writes the chosen aspect ratio + snapped resolution to the project gridLayout', async () => {
    await renderPopover()
    const [aspect] = canvasSelects()
    await changeSelect(aspect, '9:16')

    const patch = setGridLayout.mock.calls.at(-1)[0]
    expect(patch.canvasAspectRatio).toBe('9:16')
    // 9:16 default resolution snaps to the ~1080-class entry (1080×1920).
    expect(patch.canvasWidth).toBe(1080)
    expect(patch.canvasHeight).toBe(1920)
  })

  it('writes the chosen resolution preset to the project gridLayout', async () => {
    await renderPopover()
    const [, size] = canvasSelects()
    await changeSelect(size, '3840x2160')

    const patch = setGridLayout.mock.calls.at(-1)[0]
    expect(patch.canvasWidth).toBe(3840)
    expect(patch.canvasHeight).toBe(2160)
  })

  it('locked custom width keeps the aspect ratio (height follows)', async () => {
    // Start at a custom size so the W×H inputs render with the lock on.
    await renderPopover({ ...BASE_LAYOUT, canvasWidth: 1600, canvasHeight: 900, canvasAspectRatio: '16:9' })
    const widthInput = container.querySelector('.gsp-canvas-size .gsp-dim-input')
    expect(widthInput).toBeTruthy()
    await changeInput(widthInput, '1280')

    const patch = setGridLayout.mock.calls.at(-1)[0]
    expect(patch.canvasWidth).toBe(1280)
    expect(patch.canvasHeight).toBe(720) // 16:9 preserved
  })
})
