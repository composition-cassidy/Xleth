// @vitest-environment jsdom
import React, { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRoot } from 'react-dom/client'
import VideoExportDialog from './VideoExportDialog.jsx'
import useLoopRegionStore, { DEFAULT_LOOP_REGION } from '../stores/loopRegionStore.js'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

vi.mock('./Toast.jsx', () => ({
  useToast: () => ({ showToast: () => {}, dismiss: () => {} }),
}))
vi.mock('./exportPresets/ProgressPanel.jsx', () => ({ default: () => null }))

let container, root, exportStart, getGridLayout

// Project canvas is vertical 9:16 @ 24 fps — deliberately non-default so we can
// see the export inherit it and detect a mismatch when overridden to 16:9.
const VERTICAL_CANVAS = {
  columns: 3, rows: 3, slots: [], fullscreenLayers: [],
  previewFps: 24, gapScale: 0,
  canvasWidth: 1080, canvasHeight: 1920, canvasAspectRatio: '9:16',
}

async function flush() { await act(async () => { await Promise.resolve() }) }

async function renderDialog() {
  await act(async () => { root.render(<VideoExportDialog isOpen onClose={() => {}} />) })
  await flush()
}

function buttonByText(text) {
  return Array.from(container.querySelectorAll('button')).find(b => b.textContent.trim() === text)
}
function rowControl(labelText) {
  const row = Array.from(container.querySelectorAll('.export-row'))
    .find(el => el.querySelector('label')?.textContent.trim() === labelText)
  return row?.querySelector('select, input')
}
async function click(el) {
  await act(async () => { el.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
  await flush()
}
async function changeSelect(select, value) {
  await act(async () => {
    select.value = value
    select.dispatchEvent(new Event('change', { bubbles: true }))
  })
  await flush()
}

describe('VideoExportDialog — project canvas inheritance + fit', () => {
  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    exportStart = vi.fn().mockResolvedValue(true)
    getGridLayout = vi.fn().mockResolvedValue(VERTICAL_CANVAS)
    useLoopRegionStore.getState().setLoopRegionLocal({ ...DEFAULT_LOOP_REGION })

    window.xleth = {
      settings: { get: vi.fn().mockResolvedValue('auto') },
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
    await click(buttonByText('Custom'))
    await click(buttonByText('Browse…'))
    await click(buttonByText('Export'))

    expect(exportStart).toHaveBeenCalledTimes(1)
    const cfg = exportStart.mock.calls[0][0]
    expect(cfg.width).toBe(1080)     // inherited from the project canvas
    expect(cfg.height).toBe(1920)
    expect(cfg.fpsNum).toBe(24)      // inherited project frame rate
    expect(cfg.fitMode).toBe('stretch') // aspects match → identity
  })

  it('overriding the Custom aspect requires a fit mode, then encodes it', async () => {
    await renderDialog()
    await click(buttonByText('Custom'))
    await click(buttonByText('Browse…'))

    // Override 9:16 project → 16:9 output. Now aspect mismatches.
    await changeSelect(rowControl('Resolution'), '1920x1080')

    // Fit-mode UI appears and Export is blocked until a mode is chosen.
    expect(buttonByText('Crop to fill')).toBeTruthy()
    expect(buttonByText('Export').disabled).toBe(true)

    await click(buttonByText('Crop to fill'))
    expect(buttonByText('Export').disabled).toBe(false)

    await click(buttonByText('Export'))
    const cfg = exportStart.mock.calls[0][0]
    expect(cfg.width).toBe(1920)
    expect(cfg.height).toBe(1080)
    expect(cfg.fitMode).toBe('crop')
  })

  it('YouTube preset inherits the project frame rate and gets bars on aspect mismatch', async () => {
    await renderDialog()
    // Default tab is YouTube. Project is vertical, YouTube outputs 16:9 → bars.
    await click(buttonByText('Browse…'))
    await click(buttonByText('Export'))

    const cfg = exportStart.mock.calls[0][0]
    expect(cfg.fpsNum).toBe(24)      // inherited project frame rate
    expect(cfg.fitMode).toBe('bars') // preset never distorts on mismatch
  })
})
