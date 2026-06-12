// @vitest-environment jsdom
import React, { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRoot } from 'react-dom/client'
import VideoExportDialog from './VideoExportDialog.jsx'
import useLoopRegionStore, { DEFAULT_LOOP_REGION } from '../stores/loopRegionStore.js'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

vi.mock('./Toast.jsx', () => ({
  useToast: () => ({
    showToast: () => {},
    dismiss: () => {},
  }),
}))

vi.mock('./exportPresets/ProgressPanel.jsx', () => ({
  default: () => null,
}))

let container
let root
let exportStart

async function flush() {
  await act(async () => {
    await Promise.resolve()
  })
}

async function renderDialog() {
  await act(async () => {
    root.render(<VideoExportDialog isOpen onClose={() => {}} />)
  })
  await flush()
}

function buttonByText(text) {
  return Array.from(container.querySelectorAll('button'))
    .find((button) => button.textContent.trim() === text)
}

function rowControl(labelText) {
  const row = Array.from(container.querySelectorAll('.export-row'))
    .find((el) => el.querySelector('label')?.textContent.trim() === labelText)
  return row?.querySelector('select, input')
}

async function click(el) {
  await act(async () => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
  await flush()
}

async function changeSelect(select, value) {
  await act(async () => {
    select.value = value
    select.dispatchEvent(new Event('change', { bubbles: true }))
  })
  await flush()
}

describe('VideoExportDialog UI copy', () => {
  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    exportStart = vi.fn().mockResolvedValue(true)
    useLoopRegionStore.getState().setLoopRegionLocal({ ...DEFAULT_LOOP_REGION })

    window.xleth = {
      settings: {
        get: vi.fn().mockResolvedValue('auto'),
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
        getLoopRegion: vi.fn().mockResolvedValue({ ...DEFAULT_LOOP_REGION }),
        setLoopRegion: vi.fn().mockResolvedValue(true),
      },
      shell: {
        openPath: vi.fn(),
        showItemInFolder: vi.fn(),
      },
    }
  })

  afterEach(() => {
    act(() => { root.unmount() })
    container.remove()
    vi.clearAllMocks()
  })

  it('renders cleaned shared export settings copy without debug range fields', async () => {
    await renderDialog()
    const html = container.innerHTML

    expect(html).toContain('Export Video')
    expect(html).not.toContain('Start Bar (debug)')
    expect(html).not.toContain('End Bar (debug)')
    expect(html).toContain('Encoder')
    expect(html).not.toContain('Video mode')
    expect(html).toContain('Auto')
    expect(html).toContain('Software Encoder')
    expect(html).toContain('Hardware Encoder Only')
    expect(html).toContain('End Behavior')
    expect(html).not.toContain('Tail mode')
    expect(html).toContain('Start Processing From')
    expect(html).not.toContain('Render origin')
  })

  it('shows the new Custom caption without backend muxer terminology', async () => {
    await renderDialog()
    await click(buttonByText('Custom'))

    const html = container.innerHTML
    expect(html).toContain('Custom export settings for codec, resolution, frame rate, quality, and audio.')
    expect(html).not.toContain('Full control')
    expect(html).not.toContain('muxer')
  })

  it.each([
    ['auto', 'auto'],
    ['software', 'software'],
    ['hardware', 'hardware'],
  ])('keeps export payload videoMode value "%s" compatible', async (selectValue, expectedMode) => {
    await renderDialog()
    await click(buttonByText('Browse…'))
    await changeSelect(rowControl('Encoder'), selectValue)
    await click(buttonByText('Export'))

    expect(exportStart).toHaveBeenCalledTimes(1)
    const cfg = exportStart.mock.calls[0][0]
    expect(cfg.videoMode).toBe(expectedMode)
    expect(cfg).not.toHaveProperty('startBeat')
    expect(cfg).not.toHaveProperty('endBeat')
  })
})
