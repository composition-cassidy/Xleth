// @vitest-environment jsdom
//
// The project canvas popover (Aspect / Size / FPS). Ported from the deleted
// GridSettingsPanel.canvas.test.jsx; since Phase 3 the popover opens from the
// Preview's Edit Grid row (GridEditToolbar). The Video tab and its inline
// grid mini-preview are gone: the grid is edited on the picture itself.
import React, { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRoot } from 'react-dom/client'
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
  // The kit Select renders a <button class="gsp-canvas-select">
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

// A dimension is a kit NumberBox now: double-click opens its type-in field, Enter commits once.
async function changeInput(box, value) {
  await act(async () => { box.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true })) })
  const input = box.querySelector('input')
  if (!input) throw new Error('the NumberBox did not open its type-in field')
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
  await act(async () => {
    setter.call(input, String(value))
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await act(async () => {
    input.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'Enter' }))
  })
  await flush()
}

describe('VideoCanvasSettingsPopover — dropdown controls use the kit Select', () => {
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
