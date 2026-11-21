// @vitest-environment jsdom
import React, { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRoot } from 'react-dom/client'
import RenderDialog from './RenderDialog.jsx'
import useLoopRegionStore, { DEFAULT_LOOP_REGION } from '../stores/loopRegionStore.js'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

vi.mock('./Toast.jsx', () => ({
  useToast: () => ({ showToast: () => {}, dismiss: () => {} }),
}))

vi.mock('./exportPresets/ProgressPanel.jsx', () => ({ default: () => null }))

let container
let root
let exportStart
let audioExportStart

async function flush() {
  await act(async () => { await Promise.resolve() })
}

async function renderDialog(props = {}) {
  await act(async () => {
    root.render(<RenderDialog isOpen onClose={() => {}} {...props} />)
  })
  await flush()
}

// The dialog is a kit Dialog in a portal, so everything is looked up on the document.
function buttonByText(text) {
  return Array.from(document.body.querySelectorAll('button'))
    .find((button) => button.textContent.trim() === text)
}

// The destinations are the dialog's tabs.
function destCard(name) {
  return Array.from(document.body.querySelectorAll('[role="tab"]'))
    .find((el) => el.textContent.trim() === name)
}

// A label / control row: the control is the row's text field or its Select trigger.
function rowControl(labelText) {
  const row = Array.from(document.body.querySelectorAll('[data-export-row]'))
    .find((el) => el.querySelector('[data-export-label]')?.textContent.trim().startsWith(labelText))
  return row?.querySelector('input, [aria-haspopup="listbox"]')
}

async function click(el) {
  await act(async () => { el.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
  await flush()
}

function renderRangeHeader() {
  return document.body.querySelector('[data-render-range-header]')
}

// Open a kit Select and choose the option with this label.
async function changeSelect(trigger, optionLabel) {
  await click(trigger)
  const option = Array.from(document.body.querySelectorAll('[role="option"]'))
    .find((o) => o.textContent.trim() === optionLabel)
  await click(option)
}

describe('RenderDialog', () => {
  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    exportStart = vi.fn().mockResolvedValue(true)
    audioExportStart = vi.fn().mockResolvedValue(true)
    useLoopRegionStore.getState().setLoopRegionLocal({ ...DEFAULT_LOOP_REGION })

    window.xleth = {
      settings: { get: vi.fn().mockResolvedValue('auto') },
      audio: {
        onExportProgress: vi.fn(() => () => {}),
        exportSaveAsDialog: vi.fn().mockResolvedValue('C:\\exports\\clip.wav'),
        exportStart: audioExportStart,
        exportCancel: vi.fn().mockResolvedValue(true),
      },
      videoExport: {
        getExportPresets: vi.fn().mockResolvedValue({}),
        saveExportPresets: vi.fn(),
        onExportProgress: vi.fn(() => () => {}),
        exportSaveAsDialog: vi.fn().mockResolvedValue('C:\\exports\\clip.mp4'),
        exportStart,
        exportCancel: vi.fn().mockResolvedValue(true),
        computeDurationSeconds: vi.fn().mockResolvedValue(12),
        getAvailableEncoders: vi.fn().mockResolvedValue([]),
        getDefaultEncoder: vi.fn().mockResolvedValue(''),
      },
      timeline: {
        getGridLayout: vi.fn().mockResolvedValue(null),
        getLoopRegion: vi.fn().mockResolvedValue({ ...DEFAULT_LOOP_REGION }),
        setLoopRegion: vi.fn().mockResolvedValue(true),
      },
      shell: { openPath: vi.fn(), showItemInFolder: vi.fn() },
    }
  })

  afterEach(() => {
    act(() => { root.unmount() })
    container.remove()
    vi.clearAllMocks()
  })

  it('renders the unified header and all four destination cards', async () => {
    await renderDialog()
    const html = document.body.innerHTML
    expect(html).toContain('Render')
    expect(destCard('Audio')).toBeTruthy()
    expect(destCard('YouTube')).toBeTruthy()
    expect(destCard('Discord')).toBeTruthy()
    expect(destCard('Custom')).toBeTruthy()
  })

  it('opens on the Audio destination when steered by destinationHint="audio"', async () => {
    await renderDialog({ destinationHint: 'audio', requestNonce: 1 })
    expect(destCard('Audio').getAttribute('aria-selected')).toBe('true')
    expect(rowControl('Format')).toBeTruthy()
  })

  it('opens on a video destination (defaulting to YouTube) when steered by destinationHint="video"', async () => {
    await renderDialog({ destinationHint: 'video', requestNonce: 1 })
    expect(destCard('YouTube').getAttribute('aria-selected')).toBe('true')
  })

  it('starts an audio render through window.xleth.audio.exportStart', async () => {
    await renderDialog({ destinationHint: 'audio', requestNonce: 1 })
    await click(buttonByText('Browse…'))
    await click(buttonByText('Export audio'))

    expect(audioExportStart).toHaveBeenCalledTimes(1)
    expect(exportStart).not.toHaveBeenCalled()
    const cfg = audioExportStart.mock.calls[0][0]
    expect(cfg.format).toBe('wav')
    expect(cfg.outputPath).toBe('C:\\exports\\clip.wav')
  })

  it('renders cleaned shared render-range copy without debug range fields, collapsed by default', async () => {
    await renderDialog()
    const html = document.body.innerHTML

    expect(html).not.toContain('Start Bar (debug)')
    expect(html).not.toContain('End Bar (debug)')
    expect(html).toContain('Render range and tails')
    expect(html).not.toContain('End behavior')
    expect(html).not.toContain('Start processing from')

    await click(renderRangeHeader())
    const expandedHtml = document.body.innerHTML
    expect(expandedHtml).toContain('End behavior')
    expect(expandedHtml).toContain('Start processing from')
    // The coarse Auto/Software/Hardware toggle only lives in the Custom tab.
    expect(expandedHtml).not.toContain('Encoder mode')
  })

  it('shows the Custom caption and Encoder Mode override', async () => {
    await renderDialog()
    await click(destCard('Custom'))

    const html = document.body.innerHTML
    expect(html).toContain('Custom export settings for codec, resolution, frame rate, quality, and audio.')
    expect(html).toContain('Encoder mode')
    await click(rowControl('Encoder mode'))
    const labels = Array.from(document.body.querySelectorAll('[role="option"]')).map((o) => o.textContent.trim())
    expect(labels).toEqual(['Auto', 'Software encoder', 'Hardware encoder only'])
  })

  it.each([
    ['Auto', 'auto'],
    ['Software encoder', 'software'],
    ['Hardware encoder only', 'hardware'],
  ])('keeps export payload videoMode "%s" compatible', async (selectValue, expectedMode) => {
    await renderDialog()
    await click(destCard('Custom'))
    await click(buttonByText('Browse…'))
    await changeSelect(rowControl('Encoder mode'), selectValue)
    await click(buttonByText('Export video'))

    expect(exportStart).toHaveBeenCalledTimes(1)
    const cfg = exportStart.mock.calls[0][0]
    expect(cfg.videoMode).toBe(expectedMode)
    expect(cfg).not.toHaveProperty('startBeat')
    expect(cfg).not.toHaveProperty('endBeat')
  })

  it('clears a stale output path when hopping between the audio and video categories', async () => {
    await renderDialog({ destinationHint: 'audio', requestNonce: 1 })
    await click(buttonByText('Browse…'))
    expect(rowControl('Output file').value).toBe('C:\\exports\\clip.wav')

    await click(destCard('YouTube'))
    expect(rowControl('Output file').value).toBe('')
  })
})

describe('RenderDialog — project canvas inheritance + fit', () => {
  const VERTICAL_CANVAS = {
    columns: 3, rows: 3, slots: [], fullscreenLayers: [],
    previewFps: 24, gapScale: 0,
    canvasWidth: 1080, canvasHeight: 1920, canvasAspectRatio: '9:16',
  }

  let getGridLayout

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    exportStart = vi.fn().mockResolvedValue(true)
    getGridLayout = vi.fn().mockResolvedValue(VERTICAL_CANVAS)
    useLoopRegionStore.getState().setLoopRegionLocal({ ...DEFAULT_LOOP_REGION })

    window.xleth = {
      settings: { get: vi.fn().mockResolvedValue('auto') },
      audio: {
        onExportProgress: vi.fn(() => () => {}),
        exportSaveAsDialog: vi.fn().mockResolvedValue('C:\\exports\\clip.wav'),
        exportStart: vi.fn().mockResolvedValue(true),
        exportCancel: vi.fn().mockResolvedValue(true),
      },
      videoExport: {
        getExportPresets: vi.fn().mockResolvedValue({}),
        saveExportPresets: vi.fn(),
        onExportProgress: vi.fn(() => () => {}),
        exportSaveAsDialog: vi.fn().mockResolvedValue('C:\\exports\\clip.mp4'),
        exportStart,
        exportCancel: vi.fn().mockResolvedValue(true),
        computeDurationSeconds: vi.fn().mockResolvedValue(12),
        getAvailableEncoders: vi.fn().mockResolvedValue([]),
        getDefaultEncoder: vi.fn().mockResolvedValue(''),
      },
      timeline: {
        getGridLayout,
        getLoopRegion: vi.fn().mockResolvedValue({ ...DEFAULT_LOOP_REGION }),
        setLoopRegion: vi.fn().mockResolvedValue(true),
      },
      shell: { openPath: vi.fn(), showItemInFolder: vi.fn() },
    }
  })

  afterEach(() => {
    act(() => { root.unmount() })
    container.remove()
    vi.clearAllMocks()
  })

  it('reads the project canvas on open', async () => {
    await renderDialog()
    expect(getGridLayout).toHaveBeenCalled()
  })

  it('Custom export defaults to the project canvas (matching aspect → stretch payload)', async () => {
    await renderDialog()
    await click(destCard('Custom'))
    await click(buttonByText('Browse…'))
    await click(buttonByText('Export video'))

    expect(exportStart).toHaveBeenCalledTimes(1)
    const cfg = exportStart.mock.calls[0][0]
    expect(cfg.width).toBe(1080)
    expect(cfg.height).toBe(1920)
    expect(cfg.fpsNum).toBe(24)
    expect(cfg.fitMode).toBe('stretch')
  })

  it('overriding the Custom aspect requires a fit mode, then encodes it', async () => {
    await renderDialog()
    await click(destCard('Custom'))
    await click(buttonByText('Browse…'))

    await changeSelect(rowControl('Resolution'), '1920 × 1080')

    expect(buttonByText('Crop to fill')).toBeTruthy()
    expect(buttonByText('Export video').disabled).toBe(true)

    await click(buttonByText('Crop to fill'))
    expect(buttonByText('Export video').disabled).toBe(false)

    await click(buttonByText('Export video'))
    const cfg = exportStart.mock.calls[0][0]
    expect(cfg.width).toBe(1920)
    expect(cfg.height).toBe(1080)
    expect(cfg.fitMode).toBe('crop')
  })

  it('YouTube preset inherits the project frame rate and gets bars on aspect mismatch', async () => {
    await renderDialog()
    await click(buttonByText('Browse…'))
    await click(buttonByText('Export video'))

    const cfg = exportStart.mock.calls[0][0]
    expect(cfg.fpsNum).toBe(24)
    expect(cfg.fitMode).toBe('bars')
  })
})
