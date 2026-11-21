/**
 * @vitest-environment jsdom
 *
 * Input contract for the sample editor.
 *
 * Every rule here is a regression that cost real marking time:
 *
 *  1. SPACE IS PREVIEW, ALWAYS. Not "re-activate the button I clicked last",
 *     and not "play the timeline": the editor owns the keyboard for as long as
 *     the user is working in it, including when focus has fallen to <body>
 *     because the focused control went away (Add sample disables itself, a
 *     marked row's remove button unmounts with its row). The only exemption is
 *     real text entry. A click out in the arrangement hands Space back.
 *  2. LETTER KEYS DO NOT DIE BEHIND A FOCUSED BUTTON. I and O used to be ignored
 *     whenever a button had focus, i.e. right after clicking any of them.
 *  3. DOUBLE-CLICK DOES NOT RESET THE ZOOM. Double-clicking the waveform while
 *     placing points is routine. Reset lives on the overview strip.
 *  4. A SWEEP MARKS A REGION. Middle-drag, or Shift+left-drag: in/out land on
 *     the swept span and the parent is told to open the label list. A click
 *     with no drag must leave the existing points alone.
 *  5. LEFT-DRAG STILL SCRUBS, and still moves an In / Out line when it starts on one.
 */
import React, { act, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import SamplePicker from './SamplePicker.jsx'
import PickerWaveform from './PickerWaveform.jsx'
import { isSamplePickerActive, isSamplePickerKeyTarget } from '../../stores/samplePickerGate.js'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const W = 1000          // canvas width in px
const H = 132
const DURATION = 10     // seconds, so 1 px == 0.01 s at full view
const BODY_Y = 80       // inside the waveform (below the overview and the ruler)
const OVERVIEW_Y = 8

const gradient = { addColorStop: () => {} }
function stubCtx() {
  return new Proxy({}, {
    get: (_t, prop) => {
      if (prop === 'canvas') return { width: W, height: H }
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
    left: 0, top: 0, right: W, bottom: H, width: W, height: H, x: 0, y: 0,
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
  return new globalThis.MouseEvent(type, { bubbles: true, cancelable: true, clientY: BODY_Y, ...init })
}

// ── 1 & 2. Keys ─────────────────────────────────────────────────────────────

function stubBridge(regions = []) {
  const audio = {
    loadSource:        vi.fn(() => Promise.resolve({ success: true, duration: DURATION })),
    unloadSource:      vi.fn(() => Promise.resolve()),
    stopSource:        vi.fn(() => Promise.resolve()),
    playSource:        vi.fn(() => Promise.resolve()),
    pauseSource:       vi.fn(() => Promise.resolve()),
    seekSource:        vi.fn(() => Promise.resolve()),
    getSourcePosition: vi.fn(() => Promise.resolve(0)),
    isSourcePlaying:   vi.fn(() => Promise.resolve(true)),
    loadSourceRegion:  vi.fn(() => Promise.resolve(3)),
    mapRegionToSample: vi.fn(() => Promise.resolve()),
  }
  const timeline = {
    getRegions:   vi.fn(() => Promise.resolve(regions)),
    addRegion:    vi.fn(() => Promise.resolve(41)),
    removeRegion: vi.fn(() => Promise.resolve()),
  }
  globalThis.window.xleth = {
    audio,
    timeline,
    waveform: { getFilePeaks: vi.fn(() => Promise.resolve(null)) },
  }
  return { audio, timeline }
}

const SOURCE = { id: 's1', name: 'clip.wav', filePath: 'C:/clip.wav', duration: DURATION, hasVideo: false }

async function mountPicker({ regions = [], bridge } = {}) {
  const api = bridge || stubBridge(regions)
  await act(async () => {
    root.render(
      <>
        <SamplePicker source={SOURCE} onClose={() => {}} />
        <button id="arrangement" type="button">arrangement</button>
      </>
    )
  })
  return api
}

function press(target, key, init = {}) {
  const ev = new globalThis.KeyboardEvent('keydown', {
    key, code: key === ' ' ? 'Space' : undefined, bubbles: true, cancelable: true, ...init,
  })
  act(() => { target.dispatchEvent(ev) })
  return ev
}
const pressSpace = (target, init) => press(target, ' ', init)
const byTestId = (id) => container.querySelector(`[data-testid="${id}"]`)
const waveform = () => byTestId('picker-waveform')

describe('SamplePicker: Space is preview, always', () => {
  it('previews from a focused button instead of re-activating it', async () => {
    const { audio } = await mountPicker()
    const setIn = byTestId('picker-set-in')
    expect(setIn).toBeTruthy()
    setIn.focus()

    const ev = pressSpace(setIn)

    expect(audio.playSource).toHaveBeenCalledTimes(1)
    // preventDefault is what stops the browser activating the focused button.
    expect(ev.defaultPrevented).toBe(true)

    // ...and the keyup half, which is what actually clicks a <button>.
    const up = new globalThis.KeyboardEvent('keyup', { key: ' ', code: 'Space', bubbles: true, cancelable: true })
    act(() => { setIn.dispatchEvent(up) })
    expect(up.defaultPrevented).toBe(true)
  })

  it('previews from the waveform too', async () => {
    const { audio } = await mountPicker()
    pressSpace(waveform())
    expect(audio.playSource).toHaveBeenCalledTimes(1)
  })

  it('previews when focus has fallen to <body>, and never plays the timeline', async () => {
    const { audio } = await mountPicker()
    expect(isSamplePickerActive()).toBe(true)

    // What the transport asks before it handles Space (TransportBar.jsx).
    const ev = pressSpace(document.body)

    expect(isSamplePickerKeyTarget({ target: document.body })).toBe(true)
    expect(audio.playSource).toHaveBeenCalledTimes(1)
    expect(ev.defaultPrevented).toBe(true)
  })

  it('still previews after Add sample has disabled itself and dropped focus', async () => {
    const { audio, timeline } = await mountPicker()
    act(() => { press(waveform(), 'i') })
    act(() => { waveform().dispatchEvent(mouse('mousedown', { button: 0, clientX: 300 })) })
    act(() => { document.dispatchEvent(mouse('mouseup', { button: 0, clientX: 300 })) })
    act(() => { press(waveform(), 'o') })

    const add = byTestId('picker-add')
    expect(add.disabled).toBe(false)
    add.focus()
    await act(async () => { add.click() })
    expect(timeline.addRegion).toHaveBeenCalledWith({
      sourceId: 's1', startTime: 0, endTime: 3, label: 'Kick', name: 'Kick 1',
    })
    expect(byTestId('picker-add').disabled).toBe(true)
    // Focus was handed to the waveform, not left to fall to <body>.
    expect(document.activeElement).toBe(waveform())

    pressSpace(document.body)
    expect(audio.playSource).toHaveBeenCalledTimes(1)
  })

  it('hands Space back once the user clicks out in the arrangement', async () => {
    const { audio } = await mountPicker()
    const outside = container.querySelector('#arrangement')

    act(() => { outside.dispatchEvent(mouse('mousedown', { button: 0 })) })
    expect(isSamplePickerActive()).toBe(false)
    expect(byTestId('picker-keys').textContent).toBe('Space plays the timeline')

    const onBody = pressSpace(document.body)
    const onButton = pressSpace(outside)
    expect(audio.playSource).not.toHaveBeenCalled()
    expect(onBody.defaultPrevented).toBe(false)
    expect(onButton.defaultPrevented).toBe(false)
    expect(isSamplePickerKeyTarget({ target: document.body })).toBe(false)

    // A click back in the editor takes it again.
    act(() => { waveform().dispatchEvent(mouse('mousedown', { button: 0, clientX: 100 })) })
    act(() => { document.dispatchEvent(mouse('mouseup', { button: 0, clientX: 100 })) })
    expect(isSamplePickerActive()).toBe(true)
    expect(byTestId('picker-keys').textContent).toBe('Space previews this source')
    pressSpace(document.body)
    expect(audio.playSource).toHaveBeenCalledTimes(1)
  })

  it('leaves Space alone inside the sample-name field', async () => {
    const { audio } = await mountPicker()
    const nameInput = byTestId('picker-name')
    expect(nameInput).toBeTruthy()
    nameInput.focus()

    const ev = pressSpace(nameInput)

    expect(audio.playSource).not.toHaveBeenCalled()
    expect(ev.defaultPrevented).toBe(false)
  })

  it('does not machine-gun the toggle while Space is held', async () => {
    const { audio } = await mountPicker()
    pressSpace(waveform())
    pressSpace(waveform(), { repeat: true })
    pressSpace(waveform(), { repeat: true })
    expect(audio.playSource).toHaveBeenCalledTimes(1)
    expect(audio.pauseSource).not.toHaveBeenCalled()
  })

  it('plays a selection as a bounded pass the engine stops itself, when the addon has one', async () => {
    const bridge = stubBridge()
    bridge.audio.playRegionPreview = vi.fn(() => Promise.resolve({ started: true }))
    await mountPicker({ bridge })
    act(() => { waveform().dispatchEvent(mouse('mousedown', { button: 1, buttons: 4, clientX: 200 })) })
    act(() => { document.dispatchEvent(mouse('mousemove', { buttons: 4, clientX: 600 })) })
    act(() => { document.dispatchEvent(mouse('mouseup', { button: 1, clientX: 600 })) })

    // The sweep popped the label list open and focused it. Space still
    // previews: hearing the span comes before naming it.
    const label = byTestId('picker-label')
    expect(label.getAttribute('aria-expanded')).toBe('true')
    expect(document.activeElement).toBe(label)
    pressSpace(label)
    expect(label.getAttribute('aria-expanded')).toBe('true')

    expect(bridge.audio.playRegionPreview).toHaveBeenCalledTimes(1)
    const [start, end] = bridge.audio.playRegionPreview.mock.calls[0]
    expect(start).toBeCloseTo(2, 5)
    expect(end).toBeCloseTo(6, 5)
    expect(bridge.audio.playSource).not.toHaveBeenCalled()
  })
})

describe('SamplePicker: keys work wherever focus is in the editor', () => {
  it('I and O set the points while a button has focus', async () => {
    await mountPicker()
    const play = byTestId('picker-play')
    play.focus()

    press(play, 'i')
    expect(byTestId('picker-in').textContent).toContain('0:00.000')
    expect(byTestId('picker-out').textContent).toContain('—')

    press(play, 'O')
    expect(byTestId('picker-out').textContent).toContain('0:00.000')
  })

  it('does not take I, O or digits from a text field', async () => {
    await mountPicker()
    const nameInput = byTestId('picker-name')
    nameInput.focus()
    const ev = press(nameInput, 'i')
    press(nameInput, '2')
    expect(ev.defaultPrevented).toBe(false)
    expect(byTestId('picker-in').textContent).toContain('—')
    expect(byTestId('picker-label').textContent).toContain('Kick')
  })

  it('digits pick the label, and L toggles loop', async () => {
    await mountPicker()
    press(waveform(), '2')
    expect(byTestId('picker-label').textContent).toContain('Snare')
    expect(byTestId('picker-name').value).toBe('Snare 1')

    expect(byTestId('picker-loop').getAttribute('aria-pressed')).toBe('false')
    press(waveform(), 'l')
    expect(byTestId('picker-loop').getAttribute('aria-pressed')).toBe('true')
  })

  it('arrow keys nudge the playhead; Shift nudges ten times as far', async () => {
    const { audio } = await mountPicker()
    press(waveform(), 'ArrowRight')
    expect(audio.seekSource).toHaveBeenLastCalledWith(expect.closeTo(0.01, 6))
    press(waveform(), 'ArrowRight', { shiftKey: true })
    expect(audio.seekSource).toHaveBeenLastCalledWith(expect.closeTo(0.11, 6))
    press(waveform(), 'End')
    expect(audio.seekSource).toHaveBeenLastCalledWith(DURATION)
  })

  it('leaves app shortcuts with a modifier alone, and swallows stray letters', async () => {
    await mountPicker()
    const save = press(waveform(), 's', { ctrlKey: true })
    expect(save.defaultPrevented).toBe(false)

    const seen = vi.fn()
    window.addEventListener('keydown', seen)
    press(waveform(), 'm')          // the transport's "toggle mixer"
    press(waveform(), 's', { ctrlKey: true })
    window.removeEventListener('keydown', seen)
    expect(seen).toHaveBeenCalledTimes(1)
    expect(seen.mock.calls[0][0].key).toBe('s')
  })

  it('Enter adds the sample from the waveform but never steals a button\'s own Enter', async () => {
    const { timeline } = await mountPicker()
    const clickAt = (x) => {
      act(() => { waveform().dispatchEvent(mouse('mousedown', { button: 0, clientX: x })) })
      act(() => { document.dispatchEvent(mouse('mouseup', { button: 0, clientX: x })) })
    }
    clickAt(100); press(waveform(), 'i')
    clickAt(300); press(waveform(), 'o')

    const play = byTestId('picker-play')
    play.focus()
    const onButton = press(play, 'Enter')
    expect(onButton.defaultPrevented).toBe(false)
    expect(timeline.addRegion).not.toHaveBeenCalled()

    await act(async () => { press(waveform(), 'Enter') })
    expect(timeline.addRegion).toHaveBeenCalledTimes(1)
    const def = timeline.addRegion.mock.calls[0][0]
    expect(def.startTime).toBeCloseTo(1, 5)
    expect(def.endTime).toBeCloseTo(3, 5)
  })
})

describe('SamplePicker: marked samples', () => {
  const REGIONS = [
    { id: 7, sourceId: 's1', startTime: 1, endTime: 2.5, label: 'Quote', name: 'Quote 1' },
    { id: 8, sourceId: 'other', startTime: 0, endTime: 1, label: 'Kick', name: 'Kick 9' },
  ]

  it('lists this source\'s regions, loads one on click and removes one, keeping the keyboard', async () => {
    const { audio, timeline } = await mountPicker({ regions: REGIONS })
    const rows = container.querySelectorAll('[data-testid="picker-marked-row"]')
    expect(rows).toHaveLength(1)

    act(() => { rows[0].click() })
    expect(byTestId('picker-in').textContent).toContain('0:01.000')
    expect(byTestId('picker-out').textContent).toContain('0:02.500')
    expect(audio.seekSource).toHaveBeenLastCalledWith(1)

    const remove = byTestId('picker-marked-remove')
    remove.focus()
    await act(async () => { remove.click() })
    expect(timeline.removeRegion).toHaveBeenCalledWith(7)
    expect(container.querySelectorAll('[data-testid="picker-marked-row"]')).toHaveLength(0)

    pressSpace(document.body)
    expect(audio.playSource).toHaveBeenCalledTimes(1)
  })
})

// ── 3, 4 & 5. Waveform gestures ─────────────────────────────────────────────

function Harness({ onRegionDragEnd, onSeek = () => {}, onPoints, initialIn = null, initialOut = null, ...rest }) {
  const [inPoint, setInPoint]   = useState(initialIn)
  const [outPoint, setOutPoint] = useState(initialOut)
  onPoints?.(inPoint, outPoint)
  return (
    <PickerWaveform
      filePath={null}
      waveformData={null}
      waveformError={false}
      duration={DURATION}
      currentTime={0}
      inPoint={inPoint}
      outPoint={outPoint}
      onSeek={onSeek}
      onInChange={setInPoint}
      onOutChange={setOutPoint}
      onRegionDragEnd={onRegionDragEnd}
      {...rest}
    />
  )
}

function mountWaveform(props = {}) {
  const points = { in: null, out: null }
  act(() => { root.render(<Harness {...props} onPoints={(a, b) => { points.in = a; points.out = b }} />) })
  return { wave: waveform(), points }
}

function zoomIn(wave) {
  act(() => {
    wave.dispatchEvent(new globalThis.WheelEvent('wheel', {
      bubbles: true, cancelable: true, deltaY: -100, clientX: W / 2, clientY: BODY_Y,
    }))
  })
}

describe('PickerWaveform: zoom is not thrown away by a double-click', () => {
  it('keeps the zoom when the waveform is double-clicked', () => {
    const { wave } = mountWaveform()
    expect(wave.getAttribute('data-zoomed')).toBe('false')
    zoomIn(wave)
    expect(wave.getAttribute('data-zoomed')).toBe('true')

    act(() => { wave.dispatchEvent(mouse('dblclick', { clientX: 400 })) })

    expect(wave.getAttribute('data-zoomed')).toBe('true')
  })

  it('fits the whole source from a double-click on the overview', () => {
    const { wave } = mountWaveform()
    zoomIn(wave)
    expect(wave.getAttribute('data-zoomed')).toBe('true')

    act(() => { wave.dispatchEvent(mouse('dblclick', { clientX: 400, clientY: OVERVIEW_Y })) })

    expect(wave.getAttribute('data-zoomed')).toBe('false')
  })
})

describe('PickerWaveform: a sweep marks an in/out region', () => {
  function sweep(wave, fromX, toX, down) {
    act(() => { wave.dispatchEvent(mouse('mousedown', { clientX: fromX, ...down })) })
    act(() => { document.dispatchEvent(mouse('mousemove', { clientX: toX })) })
    act(() => { document.dispatchEvent(mouse('mouseup', { clientX: toX, button: down.button })) })
  }
  const MIDDLE = { button: 1, buttons: 4 }
  const SHIFT_LEFT = { button: 0, buttons: 1, shiftKey: true }

  it.each([['middle-drag', MIDDLE], ['Shift+left-drag', SHIFT_LEFT]])(
    '%s sets in/out to the swept span and asks the parent to open the label list',
    (_name, down) => {
      const onRegionDragEnd = vi.fn()
      const { wave, points } = mountWaveform({ onRegionDragEnd })

      sweep(wave, 200, 600, down)   // 2.0 s to 6.0 s at full view

      expect(onRegionDragEnd).toHaveBeenCalledTimes(1)
      const { start, end } = onRegionDragEnd.mock.calls[0][0]
      expect(start).toBeCloseTo(2, 5)
      expect(end).toBeCloseTo(6, 5)
      expect(points.in).toBeCloseTo(2, 5)
      expect(points.out).toBeCloseTo(6, 5)
    },
  )

  it('normalizes a right-to-left sweep', () => {
    const onRegionDragEnd = vi.fn()
    const { wave } = mountWaveform({ onRegionDragEnd })

    sweep(wave, 700, 300, MIDDLE)

    const { start, end } = onRegionDragEnd.mock.calls[0][0]
    expect(start).toBeCloseTo(3, 5)
    expect(end).toBeCloseTo(7, 5)
  })

  it('preventDefaults the middle press so Chrome does not start autoscroll', () => {
    const { wave } = mountWaveform({ onRegionDragEnd: vi.fn() })
    const down = mouse('mousedown', { button: 1, buttons: 4, clientX: 200 })
    act(() => { wave.dispatchEvent(down) })
    expect(down.defaultPrevented).toBe(true)
    act(() => { document.dispatchEvent(mouse('mouseup', { button: 1, clientX: 200 })) })
  })

  it('ignores a click with no drag and puts the old points back', () => {
    const onRegionDragEnd = vi.fn()
    const { wave, points } = mountWaveform({ onRegionDragEnd, initialIn: 1, initialOut: 4 })

    sweep(wave, 800, 800, MIDDLE)

    expect(onRegionDragEnd).not.toHaveBeenCalled()
    expect(points.in).toBe(1)
    expect(points.out).toBe(4)

    // …and the gesture is still live afterwards.
    sweep(wave, 100, 500, MIDDLE)
    expect(onRegionDragEnd).toHaveBeenCalledTimes(1)
  })
})

describe('PickerWaveform: left-drag scrubs, and moves a line it starts on', () => {
  it('scrubs the playhead and leaves the selection alone', () => {
    const onSeek = vi.fn()
    const { wave, points } = mountWaveform({ onSeek, initialIn: 1, initialOut: 4 })

    act(() => { wave.dispatchEvent(mouse('mousedown', { button: 0, clientX: 250 })) })
    act(() => { document.dispatchEvent(mouse('mousemove', { clientX: 620 })) })
    act(() => { document.dispatchEvent(mouse('mouseup', { button: 0, clientX: 620 })) })

    expect(onSeek).toHaveBeenCalledTimes(2)
    expect(onSeek.mock.calls[0][0]).toBeCloseTo(2.5, 5)
    expect(onSeek.mock.calls[1][0]).toBeCloseTo(6.2, 5)
    expect(points.in).toBe(1)
    expect(points.out).toBe(4)
  })

  it('keeps scrubbing after the pointer leaves the canvas', () => {
    const onSeek = vi.fn()
    const { wave } = mountWaveform({ onSeek })

    act(() => { wave.dispatchEvent(mouse('mousedown', { button: 0, clientX: 250 })) })
    act(() => { wave.dispatchEvent(mouse('mouseout', { clientX: 250, clientY: 400 })) })
    act(() => { document.dispatchEvent(mouse('mousemove', { clientX: 500, clientY: 400 })) })
    act(() => { document.dispatchEvent(mouse('mouseup', { button: 0, clientX: 500, clientY: 400 })) })

    expect(onSeek.mock.calls.at(-1)[0]).toBeCloseTo(5, 5)
  })

  it('drags the Out line when the press lands on it', () => {
    const onSeek = vi.fn()
    const { wave, points } = mountWaveform({ onSeek, initialIn: 1, initialOut: 4 })

    act(() => { wave.dispatchEvent(mouse('mousedown', { button: 0, clientX: 402 })) })   // 2 px off the Out line
    act(() => { document.dispatchEvent(mouse('mousemove', { clientX: 550 })) })
    act(() => { document.dispatchEvent(mouse('mouseup', { button: 0, clientX: 550 })) })

    expect(onSeek).not.toHaveBeenCalled()
    expect(points.in).toBe(1)
    expect(points.out).toBeCloseTo(5.5, 5)
  })

  it('a click on a marked sample\'s bar loads that sample', () => {
    const onSelectSample = vi.fn()
    const samples = [{ id: 7, startTime: 2, endTime: 3, label: 'Kick', name: 'Kick 1' }]
    const { wave } = mountWaveform({ samples, showMarks: true, onSelectSample })

    // The lane sits under the overview (16) and the ruler (18): y 34 to 48.
    act(() => { wave.dispatchEvent(mouse('mousedown', { button: 0, clientX: 250, clientY: 40 })) })
    act(() => { document.dispatchEvent(mouse('mouseup', { button: 0, clientX: 250, clientY: 40 })) })

    expect(onSelectSample).toHaveBeenCalledWith(samples[0])
  })
})
