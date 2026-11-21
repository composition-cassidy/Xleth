/**
 * @vitest-environment jsdom
 */
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import useEffectChainStore from '../../../stores/effectChainStore.js'
import useMixerStore from '../../../stores/mixerStore.js'
import DeviceChain, { moveInOrder, reorderIndexForPointer } from '../DeviceChain.jsx'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const TRACK_CHAIN = [
  { nodeId: 11, pluginId: 'delay', position: 0, bypassed: false },
  { nodeId: 12, pluginId: 'reverb', position: 1, bypassed: true },
]
const MASTER_CHAIN = [{ nodeId: 21, pluginId: 'limiter', position: 0, bypassed: false }]

let container
let root
let audio

const flush = async () => { await act(async () => { await new Promise((r) => setTimeout(r, 0)) }) }

beforeEach(() => {
  HTMLCanvasElement.prototype.getContext = () => null
  audio = {
    getEffectChain: vi.fn(async () => JSON.stringify(TRACK_CHAIN)),
    getMasterEffectChain: vi.fn(async () => JSON.stringify(MASTER_CHAIN)),
    setEffectBypass: vi.fn(async () => true),
    moveEffect: vi.fn(async () => true),
  }
  window.xleth = { audio, timeline: { getTracks: async () => [{ id: 3, name: 'Kick' }] } }
  useEffectChainStore.setState({ chains: {}, fxModes: {} })
  useMixerStore.setState({ selectedChainKey: '3', tracks: { 3: { id: 3, name: 'Kick' } } })
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

describe('reorder maths', () => {
  const rects = [0, 200, 400].map((left) => ({ left, width: 180 }))
  it('index = number of other devices whose centre is left of the pointer', () => {
    expect(reorderIndexForPointer(10, rects, 2)).toBe(0)
    expect(reorderIndexForPointer(300, rects, 0)).toBe(1)
    expect(reorderIndexForPointer(600, rects, 0)).toBe(2)
  })
  it('moveInOrder moves by nodeId', () => {
    const order = [{ nodeId: 1 }, { nodeId: 2 }, { nodeId: 3 }]
    expect(moveInOrder(order, 1, 2).map((x) => x.nodeId)).toEqual([2, 3, 1])
  })
})

describe('DeviceChain', () => {
  it('shows the selected track chain left to right, then the drop zone', async () => {
    act(() => root.render(<DeviceChain />))
    await flush()
    const devices = Array.from(container.querySelectorAll('section[aria-label]')).map((s) => s.getAttribute('aria-label'))
    expect(devices).toEqual(['Delay device', 'Reverb device, off'])
    expect(container.querySelector('[role="list"]').getAttribute('aria-label')).toBe('Kick devices')
    const items = Array.from(container.querySelectorAll('[role="listitem"], button'))
    expect(items[items.length - 1].textContent).toBe('Drop effects here')
  })

  it('no track selected shows the master chain', async () => {
    useMixerStore.setState({ selectedChainKey: null })
    act(() => root.render(<DeviceChain />))
    await flush()
    expect(container.querySelector('section').getAttribute('aria-label')).toBe('Limiter device')
    expect(audio.getMasterEffectChain).toHaveBeenCalled()
  })

  it('the activator bypasses through the existing chain store', async () => {
    act(() => root.render(<DeviceChain />))
    await flush()
    act(() => container.querySelector('button[aria-label="Delay on"]').click())
    await flush()
    expect(audio.setEffectBypass).toHaveBeenCalledWith(3, 11, true)
  })

  it('dragging a device by its name previews locally and commits ONE moveEffect on drop', async () => {
    act(() => root.render(<DeviceChain />))
    await flush()
    const slots = container.querySelectorAll('[role="listitem"][data-device-index]')
    slots.forEach((el, i) => {
      el.getBoundingClientRect = () => ({ left: i * 200, width: 180, top: 0, height: 256, right: i * 200 + 180, bottom: 256 })
    })
    const handle = slots[0].querySelector('[data-draggable="true"]')
    const pe = (type, x) => new MouseEvent(type, { bubbles: true, clientX: x, button: 0 })
    act(() => { handle.dispatchEvent(pe('pointerdown', 50)) })
    act(() => { document.dispatchEvent(pe('pointermove', 120)) })
    act(() => { document.dispatchEvent(pe('pointermove', 330)) })
    const preview = Array.from(container.querySelectorAll('section[aria-label]')).map((s) => s.getAttribute('aria-label'))
    expect(preview).toEqual(['Reverb device, off', 'Delay device'])
    expect(audio.moveEffect).not.toHaveBeenCalled()
    act(() => { document.dispatchEvent(pe('pointerup', 330)) })
    await flush()
    expect(audio.moveEffect).toHaveBeenCalledTimes(1)
    expect(audio.moveEffect).toHaveBeenCalledWith(3, 11, 1)
  })

  it('the order strip lists the chain, and dragging a chip commits ONE moveEffect', async () => {
    act(() => root.render(<DeviceChain />))
    await flush()
    const strip = container.querySelector('[role="toolbar"]')
    const chips = strip.querySelectorAll('[data-device-index]')
    expect(Array.from(chips).map((c) => c.textContent)).toEqual(['1Delay', '2Reverb'])
    chips.forEach((el, i) => {
      el.getBoundingClientRect = () => ({ left: i * 100, width: 80, top: 0, height: 22, right: i * 100 + 80, bottom: 22 })
    })
    const pe = (type, x) => new MouseEvent(type, { bubbles: true, clientX: x, button: 0 })
    act(() => { chips[0].dispatchEvent(pe('pointerdown', 40)) })
    act(() => { document.dispatchEvent(pe('pointermove', 60)) })
    act(() => { document.dispatchEvent(pe('pointermove', 180)) })
    act(() => { document.dispatchEvent(pe('pointerup', 180)) })
    await flush()
    expect(audio.moveEffect).toHaveBeenCalledTimes(1)
    expect(audio.moveEffect).toHaveBeenCalledWith(3, 11, 1)
  })

  it('Alt+ArrowRight moves the focused device one place; Alt+ArrowLeft at the start does nothing', async () => {
    act(() => root.render(<DeviceChain />))
    await flush()
    const chip = container.querySelector('[role="toolbar"] [data-device-index="0"]')
    const key = (k, init = {}) => new KeyboardEvent('keydown', { key: k, altKey: true, bubbles: true, cancelable: true, ...init })
    act(() => { chip.dispatchEvent(key('ArrowLeft')) })
    act(() => { chip.dispatchEvent(key('ArrowRight', { shiftKey: true })) })
    await flush()
    expect(audio.moveEffect).not.toHaveBeenCalled()
    act(() => { chip.dispatchEvent(key('ArrowRight')) })
    await flush()
    expect(audio.moveEffect).toHaveBeenCalledWith(3, 11, 1)
  })

  it('a single device shows no order strip', async () => {
    useMixerStore.setState({ selectedChainKey: null })
    act(() => root.render(<DeviceChain />))
    await flush()
    expect(container.querySelector('[role="toolbar"]')).toBeNull()
  })

  it('a track owned by the FX Graph says so instead of drawing a chain', async () => {
    useEffectChainStore.setState({ fxModes: { 3: 'graph' } })
    act(() => root.render(<DeviceChain />))
    await flush()
    expect(container.textContent).toContain('routes its effects in the FX Graph')
    expect(container.querySelector('section')).toBeNull()
  })
})
