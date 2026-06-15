/**
 * @vitest-environment jsdom
 */
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import SyllableSplitter from './SyllableSplitter.jsx'

function deferred() {
  let resolve
  let reject
  const promise = new Promise((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function installCanvasStub() {
  Object.defineProperty(window.HTMLCanvasElement.prototype, 'clientWidth', {
    configurable: true,
    get: () => 320,
  })
  Object.defineProperty(window.HTMLCanvasElement.prototype, 'clientHeight', {
    configurable: true,
    get: () => 90,
  })
  window.HTMLCanvasElement.prototype.getContext = vi.fn(() => ({
    beginPath: vi.fn(),
    clearRect: vi.fn(),
    closePath: vi.fn(),
    fill: vi.fn(),
    fillRect: vi.fn(),
    fillText: vi.fn(),
    lineTo: vi.fn(),
    moveTo: vi.fn(),
    scale: vi.fn(),
    setTransform: vi.fn(),
    stroke: vi.fn(),
  }))
  window.HTMLCanvasElement.prototype.getBoundingClientRect = vi.fn(() => ({
    left: 0,
    top: 0,
    right: 320,
    bottom: 90,
    width: 320,
    height: 90,
  }))
}

async function renderSplitter(props = {}) {
  const { region: regionOverride, ...rest } = props
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  await act(async () => {
    root.render(
      <SyllableSplitter
        region={{
          id: 7,
          startTime: 10,
          endTime: 11,
          syllables: [],
          ...regionOverride,
        }}
        sourceFilePath="C:\\media\\quote.mp4"
        regionWaveform={{ peaks: [0, 0.5, 0.2, -0.4, 0.4, 0.2], duration: 1, stride: 3 }}
        onSave={() => {}}
        {...rest}
      />,
    )
  })
  return { container, root }
}

async function flush() {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

describe('SyllableSplitter preview playback', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    installCanvasStub()
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    window.xleth = {
      audio: {
        loadSource: vi.fn(async () => ({ success: true })),
        pauseSource: vi.fn(async () => {}),
        playRegionPreview: vi.fn(async () => ({ started: true, seq: 1 })),
        playSource: vi.fn(async () => {}),
      },
      waveform: {
        getRegionPeaks: vi.fn(async () => null),
        getFilePeaks: vi.fn(async () => null),
      },
    }
  })

  afterEach(() => {
    vi.useRealTimers()
    document.body.innerHTML = ''
    delete window.xleth
    delete globalThis.IS_REACT_ACT_ENVIRONMENT
    vi.restoreAllMocks()
  })

  it('disables preview buttons until the source preload finishes', async () => {
    const load = deferred()
    window.xleth.audio.loadSource.mockReturnValueOnce(load.promise)

    const { container, root } = await renderSplitter()
    const playButton = container.querySelector('.syllable-section-play')

    expect(playButton.disabled).toBe(true)
    expect(window.xleth.audio.loadSource).toHaveBeenCalledTimes(1)

    await act(async () => {
      load.resolve({ success: true })
      await load.promise
    })
    await flush()

    expect(playButton.disabled).toBe(false)

    await act(async () => {
      playButton.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    await flush()

    expect(window.xleth.audio.loadSource).toHaveBeenCalledTimes(1)
    expect(window.xleth.audio.playRegionPreview).toHaveBeenCalledWith(10, 11)

    await act(async () => { root.unmount() })
  })

  it('plays the selected syllable with the native preview when Space is pressed', async () => {
    const { container, root } = await renderSplitter()
    await flush()

    const splitter = container.querySelector('.syllable-splitter')

    await act(async () => {
      splitter.dispatchEvent(new KeyboardEvent('keydown', {
        bubbles: true,
        code: 'Space',
        key: ' ',
      }))
    })
    await flush()

    expect(window.xleth.audio.playRegionPreview).toHaveBeenCalledWith(10, 11)

    await act(async () => { root.unmount() })
  })

  it('selects the syllable after a marker when grabbing that marker', async () => {
    const { container, root } = await renderSplitter({
      region: {
        syllables: [
          { startTime: 0.25, endTime: 0.5, text: 'one' },
          { startTime: 0.5, endTime: 0.8, text: 'two' },
          { startTime: 0.8, endTime: 1, text: 'three' },
        ],
      },
    })
    await flush()

    const canvas = container.querySelector('canvas')
    const splitter = container.querySelector('.syllable-splitter')

    await act(async () => {
      canvas.dispatchEvent(new MouseEvent('mousedown', {
        bubbles: true,
        button: 0,
        clientX: 160,
      }))
    })
    await flush()

    await act(async () => {
      splitter.dispatchEvent(new KeyboardEvent('keydown', {
        bubbles: true,
        code: 'Space',
        key: ' ',
      }))
    })
    await flush()

    expect(window.xleth.audio.playRegionPreview).toHaveBeenCalledWith(10.5, 10.8)

    await act(async () => { root.unmount() })
  })

  it('clears stale preview timers before starting a newer syllable preview', async () => {
    const { container, root } = await renderSplitter({
      region: {
        syllables: [
          { startTime: 0, endTime: 0.1, text: 'a' },
          { startTime: 0.1, endTime: 1, text: 'b' },
        ],
      },
    })
    await flush()
    window.xleth.audio.loadSource.mockClear()
    window.xleth.audio.pauseSource.mockClear()

    const [firstButton, secondButton] = container.querySelectorAll('.syllable-section-play')

    await act(async () => {
      firstButton.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    await flush()
    expect(container.querySelectorAll('.syllable-section-card')[0].className).toContain('playing')

    await act(async () => {
      secondButton.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    await flush()
    expect(container.querySelectorAll('.syllable-section-card')[1].className).toContain('playing')

    await act(async () => {
      vi.advanceTimersByTime(100)
    })

    expect(container.querySelectorAll('.syllable-section-card')[1].className).toContain('playing')
    expect(window.xleth.audio.loadSource).not.toHaveBeenCalled()

    await act(async () => { root.unmount() })
  })
})
