/**
 * @vitest-environment jsdom
 *
 * Input contract for the Sample Selection window.
 *
 * Three rules, all of them regressions that cost real marking time:
 *
 *  1. SPACE IS PREVIEW, ALWAYS. The picker used to skip its own Space handler
 *     whenever the event target was a <button>, so the moment focus landed on
 *     Set In / Set Out / Add Sample (i.e. right after clicking any of them)
 *     Space silently became "re-activate that button" instead of play/pause.
 *     The only exemption is real text entry.
 *  2. DOUBLE-CLICK DOES NOT RESET THE ZOOM. Double-clicking the waveform while
 *     placing points is routine; throwing the zoom away each time is not.
 *     Reset now lives on the scrollbar, which only exists while zoomed.
 *  3. MIDDLE-DRAG SWEEPS A REGION. Press the middle button, drag, release:
 *     in/out land on the swept span and the parent is told to open the label
 *     list. A middle-CLICK with no drag must leave the existing points alone.
 */
import React, { act, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import SamplePicker from './SamplePicker.jsx'
import WaveformScrubber from './WaveformScrubber.jsx'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const W = 1000          // canvas width in px
const DURATION = 10     // seconds, so 1 px == 0.01 s at full view

const gradient = { addColorStop: () => {} }
function stubCtx() {
  return new Proxy({}, {
    get: (_t, prop) => {
      if (prop === 'canvas') return { width: W, height: 132 }
      if (prop === 'measureText') return () => ({ width: 0 })
      return () => gradient
    },
    set: () => true,
  })
}

let container = null
let root = null

beforeEach(() => {
  globalThis.HTMLCanvasElement.prototype.getContext = stubCtx
  globalThis.HTMLCanvasElement.prototype.getBoundingClientRect = () => ({
    left: 0, top: 0, right: W, bottom: 132, width: W, height: 132, x: 0, y: 0,
  })
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  container = null
  root = null
  delete globalThis.window.xleth
  vi.restoreAllMocks()
})

function mouse(type, init) {
  return new globalThis.MouseEvent(type, { bubbles: true, cancelable: true, ...init })
}

// ── 1. Space ────────────────────────────────────────────────────────────────

function stubBridge() {
  const audio = {
    loadSource:        vi.fn(() => Promise.resolve({ success: true, duration: DURATION })),
    unloadSource:      vi.fn(() => Promise.resolve()),
    stopSource:        vi.fn(() => Promise.resolve()),
    playSource:        vi.fn(() => Promise.resolve()),
    pauseSource:       vi.fn(() => Promise.resolve()),
    seekSource:        vi.fn(() => Promise.resolve()),
    getSourcePosition: vi.fn(() => Promise.resolve(0)),
    isSourcePlaying:   vi.fn(() => Promise.resolve(true)),
  }
  globalThis.window.xleth = {
    audio,
    waveform: { getFilePeaks: vi.fn(() => Promise.resolve(null)) },
    timeline: { getRegions: vi.fn(() => Promise.resolve([])) },
  }
  return audio
}

async function mountPicker() {
  const audio = stubBridge()
  await act(async () => {
    root.render(
      <SamplePicker
        source={{ id: 's1', name: 'clip.wav', filePath: 'C:/clip.wav', duration: DURATION, hasVideo: false }}
        onClose={() => {}}
      />
    )
  })
  return audio
}

function pressSpace(target, init = {}) {
  const ev = new globalThis.KeyboardEvent('keydown', {
    key: ' ', code: 'Space', bubbles: true, cancelable: true, ...init,
  })
  act(() => { target.dispatchEvent(ev) })
  return ev
}

describe('SamplePicker — Space is preview, always', () => {
  it('previews from a focused button instead of re-activating it', async () => {
    const audio = await mountPicker()
    const setIn = [...container.querySelectorAll('button')]
      .find(b => b.textContent.includes('Set In'))
    expect(setIn).toBeTruthy()
    setIn.focus()

    const ev = pressSpace(setIn)

    expect(audio.playSource).toHaveBeenCalledTimes(1)
    // preventDefault is what stops the browser activating the focused button.
    expect(ev.defaultPrevented).toBe(true)
  })

  it('previews from the waveform / bare panel background too', async () => {
    const audio = await mountPicker()
    pressSpace(container.querySelector('.waveform-scrubber'))
    expect(audio.playSource).toHaveBeenCalledTimes(1)
  })

  it('leaves Space alone inside the sample-name field', async () => {
    const audio = await mountPicker()
    const nameInput = container.querySelector('.picker-name-input')
    expect(nameInput).toBeTruthy()
    nameInput.focus()

    const ev = pressSpace(nameInput)

    expect(audio.playSource).not.toHaveBeenCalled()
    expect(ev.defaultPrevented).toBe(false)
  })

  it('does not machine-gun the toggle while Space is held', async () => {
    const audio = await mountPicker()
    const scrubber = container.querySelector('.waveform-scrubber')
    pressSpace(scrubber)
    pressSpace(scrubber, { repeat: true })
    pressSpace(scrubber, { repeat: true })
    expect(audio.playSource).toHaveBeenCalledTimes(1)
    expect(audio.pauseSource).not.toHaveBeenCalled()
  })
})

// ── 2 & 3. Waveform gestures ────────────────────────────────────────────────

function Harness({ onRegionDragEnd, initialIn = null, initialOut = null }) {
  const [inPoint, setInPoint]   = useState(initialIn)
  const [outPoint, setOutPoint] = useState(initialOut)
  return (
    <WaveformScrubber
      filePath={null}
      waveformData={null}
      waveformError={false}
      duration={DURATION}
      currentTime={0}
      inPoint={inPoint}
      outPoint={outPoint}
      onSeek={() => {}}
      onInChange={setInPoint}
      onOutChange={setOutPoint}
      onRegionDragEnd={onRegionDragEnd}
    />
  )
}

function mountScrubber(props = {}) {
  act(() => { root.render(<Harness {...props} />) })
  return {
    scrubber: container.querySelector('.waveform-scrubber'),
    canvas:   container.querySelector('.waveform-canvas'),
  }
}

function zoomIn(scrubber) {
  act(() => {
    scrubber.dispatchEvent(new globalThis.WheelEvent('wheel', {
      bubbles: true, cancelable: true, deltaY: -100, clientX: W / 2,
    }))
  })
}

describe('WaveformScrubber — zoom is not thrown away by a double-click', () => {
  it('keeps the zoom when the waveform is double-clicked', () => {
    const { scrubber, canvas } = mountScrubber()
    zoomIn(scrubber)
    expect(container.querySelector('.waveform-scrollbar')).toBeTruthy()

    act(() => { canvas.dispatchEvent(mouse('dblclick', { clientX: 400 })) })

    expect(container.querySelector('.waveform-scrollbar')).toBeTruthy()
  })

  it('still resets from a double-click on the scrollbar', () => {
    const { scrubber } = mountScrubber()
    zoomIn(scrubber)
    const scrollbar = container.querySelector('.waveform-scrollbar')
    expect(scrollbar).toBeTruthy()

    act(() => { scrollbar.dispatchEvent(mouse('dblclick', { clientX: 400 })) })

    expect(container.querySelector('.waveform-scrollbar')).toBeNull()
  })
})

describe('WaveformScrubber — middle-drag sweeps an in/out region', () => {
  function middleDrag(canvas, fromX, toX) {
    act(() => { canvas.dispatchEvent(mouse('mousedown', { button: 1, buttons: 4, clientX: fromX })) })
    act(() => { document.dispatchEvent(mouse('mousemove', { buttons: 4, clientX: toX })) })
    act(() => { document.dispatchEvent(mouse('mouseup', { button: 1, clientX: toX })) })
  }

  it('sets in/out to the swept span and asks the parent to open the label list', () => {
    const onRegionDragEnd = vi.fn()
    const { canvas } = mountScrubber({ onRegionDragEnd })

    middleDrag(canvas, 200, 600)   // 2.0 s to 6.0 s at full view

    expect(onRegionDragEnd).toHaveBeenCalledTimes(1)
    const { start, end } = onRegionDragEnd.mock.calls[0][0]
    expect(start).toBeCloseTo(2, 5)
    expect(end).toBeCloseTo(6, 5)
  })

  it('normalizes a right-to-left sweep', () => {
    const onRegionDragEnd = vi.fn()
    const { canvas } = mountScrubber({ onRegionDragEnd })

    middleDrag(canvas, 700, 300)

    const { start, end } = onRegionDragEnd.mock.calls[0][0]
    expect(start).toBeCloseTo(3, 5)
    expect(end).toBeCloseTo(7, 5)
  })

  it('preventDefaults the middle press so Chrome does not start autoscroll', () => {
    const { canvas } = mountScrubber({ onRegionDragEnd: vi.fn() })
    const down = mouse('mousedown', { button: 1, buttons: 4, clientX: 200 })
    act(() => { canvas.dispatchEvent(down) })
    expect(down.defaultPrevented).toBe(true)
    act(() => { document.dispatchEvent(mouse('mouseup', { button: 1, clientX: 200 })) })
  })

  it('ignores a middle-click with no drag', () => {
    const onRegionDragEnd = vi.fn()
    const { canvas } = mountScrubber({ onRegionDragEnd, initialIn: 1, initialOut: 4 })

    middleDrag(canvas, 800, 800)

    expect(onRegionDragEnd).not.toHaveBeenCalled()

    // …and the gesture is still live afterwards.
    middleDrag(canvas, 100, 500)
    expect(onRegionDragEnd).toHaveBeenCalledTimes(1)
  })
})
