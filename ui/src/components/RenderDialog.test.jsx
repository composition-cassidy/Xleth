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

function buttonByText(text) {
  return Array.from(container.querySelectorAll('button'))
    .find((button) => button.textContent.trim() === text)
}

function destCard(name) {
  return Array.from(container.querySelectorAll('.dest-card'))
    .find((el) => el.querySelector('.dc-name')?.textContent.trim() === name)
}

function rowControl(labelText) {
  const row = Array.from(container.querySelectorAll('.export-row'))
    .find((el) => el.querySelector('label')?.textContent.trim().startsWith(labelText))
  return row?.querySelector('select, input')
}

async function click(el) {
  await act(async () => { el.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
  await flush()
}

function renderRangeHeader() {
  return Array.from(container.querySelectorAll('.render-range-header'))[0]
}

async function changeSelect(select, value) {
  await act(async () => {
    select.value = value
    select.dispatchEvent(new Event('change', { bubbles: true }))
  })
  await flush()
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
    const html = container.innerHTML
    expect(html).toContain('Render')
    expect(destCard('Audio')).toBeTruthy()
    expect(destCard('YouTube')).toBeTruthy()
    expect(destCard('Discord')).toBeTruthy()
    expect(destCard('Custom')).toBeTruthy()
  })

  it('opens on the Audio destination when steered by destinationHint="audio"', async () => {
    await renderDialog({ destinationHint: 'audio', requestNonce: 1 })
    expect(destCard('Audio').className).toContain('on')
    expect(rowControl('Format')).toBeTruthy()
  })

  it('opens on a video destination (defaulting to YouTube) when steered by destinationHint="video"', async () => {
    await renderDialog({ destinationHint: 'video', requestNonce: 1 })
    expect(destCard('YouTube').className).toContain('on')
  })

  it('starts an audio render through window.xleth.audio.exportStart', async () => {
    await renderDialog({ destinationHint: 'audio', requestNonce: 1 })
    await click(buttonByText('Browse…'))
    await click(buttonByText('Render'))

    expect(audioExportStart).toHaveBeenCalledTimes(1)
    expect(exportStart).not.toHaveBeenCalled()
    const cfg = audioExportStart.mock.calls[0][0]
    expect(cfg.format).toBe('wav')
    expect(cfg.outputPath).toBe('C:\\exports\\clip.wav')
  })

  it('renders cleaned shared render-range copy without debug range fields, collapsed by default', async () => {
    await renderDialog()
    const html = container.innerHTML

    expect(html).not.toContain('Start Bar (debug)')
    expect(html).not.toContain('End Bar (debug)')
    expect(html).toContain('Render range')
    expect(html).not.toContain('End Behavior')
    expect(html).not.toContain('Start Processing From')

    await click(renderRangeHeader())
    const expandedHtml = container.innerHTML
    expect(expandedHtml).toContain('End Behavior')
    expect(expandedHtml).toContain('Start Processing From')
    // The coarse Auto/Software/Hardware toggle only lives in the Custom tab.
    expect(expandedHtml).not.toContain('Hardware Encoder Only')
  })

  it('shows the Custom caption and Encoder Mode override', async () => {
    await renderDialog()
    await click(destCard('Custom'))

    const html = container.innerHTML
    expect(html).toContain('Custom export settings for codec, resolution, frame rate, quality, and audio.')
    expect(html).toContain('Encoder Mode')
    expect(html).toContain('Software Encoder')
    expect(html).toContain('Hardware Encoder Only')
  })

  it.each([
    ['auto', 'auto'],
    ['software', 'software'],
    ['hardware', 'hardware'],
  ])('keeps export payload videoMode value "%s" compatible', async (selectValue, expectedMode) => {
    await renderDialog()
    await click(destCard('Custom'))
    await click(buttonByText('Browse…'))
    await changeSelect(rowControl('Encoder Mode'), selectValue)
    await click(buttonByText('Render'))

    expect(exportStart).toHaveBeenCalledTimes(1)
    const cfg = exportStart.mock.calls[0][0]
    expect(cfg.videoMode).toBe(expectedMode)
    expect(cfg).not.toHaveProperty('startBeat')
    expect(cfg).not.toHaveProperty('endBeat')
  })

  it('clears a stale output path when hopping between the audio and video categories', async () => {
    await renderDialog({ destinationHint: 'audio', requestNonce: 1 })
    await click(buttonByText('Browse…'))
    expect(rowControl('Output File').value).toBe('C:\\exports\\clip.wav')

    await click(destCard('YouTube'))
    expect(rowControl('Output File').value).toBe('')
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
    await click(buttonByText('Render'))

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

    await changeSelect(rowControl('Resolution'), '1920x1080')

    expect(buttonByText('Crop to fill')).toBeTruthy()
    expect(buttonByText('Render').disabled).toBe(true)

    await click(buttonByText('Crop to fill'))
    expect(buttonByText('Render').disabled).toBe(false)

    await click(buttonByText('Render'))
    const cfg = exportStart.mock.calls[0][0]
    expect(cfg.width).toBe(1920)
    expect(cfg.height).toBe(1080)
    expect(cfg.fitMode).toBe('crop')
  })

  it('YouTube preset inherits the project frame rate and gets bars on aspect mismatch', async () => {
    await renderDialog()
    await click(buttonByText('Browse…'))
    await click(buttonByText('Render'))

    const cfg = exportStart.mock.calls[0][0]
    expect(cfg.fpsNum).toBe(24)
    expect(cfg.fitMode).toBe('bars')
  })
})
