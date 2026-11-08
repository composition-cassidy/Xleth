/**
 * @vitest-environment jsdom
 */
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import useMixerStore from '../../../stores/mixerStore.js'
import VideoDeviceChain, { buildVideoPickerItems, chainIndexForPointer } from '../video/VideoDeviceChain.jsx'
import useVideoDeviceStore from '../video/videoDeviceStore.js'
import { CHAIN_PARAMS, FX, commitValue } from '../video/videoFxCatalog.js'
import ChainHead from '../ChainHead.jsx'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const CHAIN = [
  { type: FX.DESATURATION, bypassed: false, params: [0.4] },
  { type: FX.BRIGHTNESS_CONTRAST, bypassed: true, params: [0.1, -0.2] },
  { type: FX.OUTLINE, bypassed: false, params: [1, 1, 1, 3, 0, 1, 0.95] },
]

let container
let root
let timeline

const flush = async () => { await act(async () => { await new Promise((r) => setTimeout(r, 0)) }) }
const devices = () => Array.from(container.querySelectorAll('section[aria-label]')).map((s) => s.getAttribute('aria-label'))
const slider = (name, scope = container) => Array.from(scope.querySelectorAll('[role="slider"]'))
  .find((el) => (el.getAttribute('aria-label') ?? '').startsWith(name))

beforeEach(() => {
  HTMLCanvasElement.prototype.getContext = () => null
  timeline = {
    getTracks: vi.fn(async () => [{ id: 3, name: 'Pitch', type: 'Clip', visualEffectChain: CHAIN }]),
    addVisualEffect: vi.fn(async () => true),
    removeVisualEffect: vi.fn(async () => true),
    setVisualEffectBypassed: vi.fn(async () => true),
    setTrackVisualEffectChainOrder: vi.fn(async () => true),
    setVisualEffectParam: vi.fn(async () => true),
  }
  window.xleth = { timeline, audio: { getEffectChain: async () => '[]' } }
  useMixerStore.setState({ selectedChainKey: '3', tracks: { 3: { id: 3, name: 'Pitch' } } })
  useVideoDeviceStore.setState({ view: 'video', shown: {}, window: null })
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  document.body.innerHTML = ''
  delete window.xleth
})

describe('catalog', () => {
  it('commit applies the legacy slider step and snap', () => {
    const amount = CHAIN_PARAMS[FX.DESATURATION][0]
    expect(commitValue(amount, 0.0137)).toBe(0) // snapToZero within 0.025
    expect(commitValue(amount, 0.4449)).toBeCloseTo(0.44, 10)
    const zoom = CHAIN_PARAMS[FX.ZOOM_PAN_ROT][0]
    expect(commitValue(zoom, 1.02)).toBe(1) // snapToOne
    expect(commitValue(zoom, 9)).toBe(4) // clamped to the slider range
  })

  it('every chain table matches the engine param layout indices', () => {
    expect(CHAIN_PARAMS[FX.CHROMA_KEY].map((r) => r.pi)).toEqual([3, 4, 5, 6, 7])
    expect(CHAIN_PARAMS[FX.DROP_SHADOW].map((r) => r.pi)).toEqual([3, 4, 5, 6, 7, 9])
    expect(CHAIN_PARAMS[FX.VISUAL_ECHO].map((r) => r.pi)).toEqual([0, 1, 3, 5])
    expect(CHAIN_PARAMS[FX.TV_SIMULATOR].map((r) => [r.pi, r.def])).toEqual([[0, 0.5], [1, 1], [2, 0.3], [3, 0.003], [4, 0], [5, 2], [6, 0]])
  })

  it('reorder index counts the other devices whose centre is left of the pointer', () => {
    const rects = [0, 200, 400].map((left) => ({ left, width: 180 }))
    expect(chainIndexForPointer(10, rects, 2)).toBe(0)
    expect(chainIndexForPointer(600, rects, 0)).toBe(2)
  })

  it('the picker uses the audio menu grammar and checks the types present', () => {
    const items = buildVideoPickerItems({ track: { id: 3, type: 'Clip' }, chain: CHAIN, shownIds: [], onAddNote: () => {}, onAddChain: () => {} })
    expect(items.map((i) => i.label)).toEqual(['Per note (3)', 'Chain (9)'])
    const chainItems = items[1].submenu
    expect(chainItems.find((i) => i.label === 'Outline').checked).toBe(true)
    expect(chainItems.find((i) => i.label === 'Tint').checked).toBe(false)
    const pattern = buildVideoPickerItems({ track: { id: 3, type: 'Pattern' }, chain: [], shownIds: [], onAddNote: () => {}, onAddChain: () => {} })
    expect(pattern[0].submenu.map((i) => i.label)).toEqual(['Ping-pong loop', 'Zoom/pan/rot', 'Bounce', 'Note fade', 'Slide note effect'])
  })
})

describe('VideoDeviceChain', () => {
  it('shows the track chain as devices in evaluation order, bypass printed', async () => {
    act(() => root.render(<VideoDeviceChain />))
    await flush()
    expect(devices()).toEqual(['Desaturation device', 'Brightness and contrast device, off', 'Outline device'])
    expect(container.querySelector('[role="list"]').getAttribute('aria-label')).toBe('Pitch video devices')
    const buttons = container.querySelectorAll('button')
    expect(buttons[buttons.length - 1].textContent).toBe('Drop video effects here')
    expect(container.textContent).toContain('Runs after the rest of the chain')
  })

  it('Master has no picture', async () => {
    useMixerStore.setState({ selectedChainKey: null })
    act(() => root.render(<VideoDeviceChain />))
    await flush()
    expect(container.textContent).toContain('Master has no picture')
    expect(container.querySelector('section')).toBeNull()
  })

  it('the activator writes setVisualEffectBypassed for that index', async () => {
    act(() => root.render(<VideoDeviceChain />))
    await flush()
    act(() => container.querySelector('button[aria-label="Desaturation on"]').click())
    await flush()
    expect(timeline.setVisualEffectBypassed).toHaveBeenCalledWith(3, 0, true)
  })

  it('a knob nudge commits ONE setVisualEffectParam with the snapped value', async () => {
    act(() => root.render(<VideoDeviceChain />))
    await flush()
    const amount = slider('Amount')
    expect(amount.getAttribute('aria-valuetext')).toContain('40')
    act(() => { amount.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true })) })
    await flush()
    expect(timeline.setVisualEffectParam).toHaveBeenCalledTimes(1)
    const [trackId, index, pi, v] = timeline.setVisualEffectParam.mock.calls[0]
    expect([trackId, index, pi]).toEqual([3, 0, 0])
    expect(v).toBeCloseTo(0.41, 6)
  })

  it('no native range inputs and no mono number fields in any device', async () => {
    act(() => root.render(<VideoDeviceChain />))
    await flush()
    expect(container.querySelector('input[type="range"]')).toBeNull()
    expect(container.querySelector('input[type="number"]')).toBeNull()
  })

  it('dragging a device by its name previews locally and commits ONE chain order', async () => {
    act(() => root.render(<VideoDeviceChain />))
    await flush()
    const slots = container.querySelectorAll('[data-video-chain-index]')
    slots.forEach((el, i) => {
      el.getBoundingClientRect = () => ({ left: i * 200, width: 180, top: 0, height: 256, right: i * 200 + 180, bottom: 256 })
    })
    const handle = slots[0].querySelector('[data-draggable="true"]')
    const pe = (type, x) => new MouseEvent(type, { bubbles: true, clientX: x, button: 0 })
    act(() => { handle.dispatchEvent(pe('pointerdown', 50)) })
    act(() => { document.dispatchEvent(pe('pointermove', 120)) })
    act(() => { document.dispatchEvent(pe('pointermove', 600)) })
    expect(devices()[2]).toBe('Desaturation device')
    expect(timeline.setTrackVisualEffectChainOrder).not.toHaveBeenCalled()
    act(() => { document.dispatchEvent(pe('pointerup', 600)) })
    await flush()
    expect(timeline.setTrackVisualEffectChainOrder).toHaveBeenCalledTimes(1)
    expect(timeline.setTrackVisualEffectChainOrder).toHaveBeenCalledWith(3, [1, 2, 0])
  })

  it('remove is in the more menu and removes by index', async () => {
    act(() => root.render(<VideoDeviceChain />))
    await flush()
    act(() => container.querySelector('button[aria-label="More for Outline"]').click())
    const remove = Array.from(document.querySelectorAll('[role="menuitem"]')).find((el) => el.textContent.includes('Remove Outline'))
    act(() => remove.click())
    await flush()
    expect(timeline.removeVisualEffect).toHaveBeenCalledWith(3, 2)
  })
})

describe('ChainHead', () => {
  it('switches the Devices tab between the audio and the video chain', () => {
    useVideoDeviceStore.setState({ view: 'audio' })
    act(() => root.render(<ChainHead name="Pitch" identityColor="#ff0000" />))
    const video = container.querySelector('[data-chain-view="video"]')
    expect(video.getAttribute('aria-pressed')).toBe('false')
    act(() => video.click())
    expect(useVideoDeviceStore.getState().view).toBe('video')
  })
})
