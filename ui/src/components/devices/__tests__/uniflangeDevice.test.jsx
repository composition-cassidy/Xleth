/**
 * @vitest-environment jsdom
 */
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import useEffectChainStore from '../../../stores/effectChainStore.js'
import useUniFlangeStore from '../../../stores/uniFlangeStore.js'
import useMixerStore from '../../../stores/mixerStore.js'
import UniFlangePanel from '../../mixer/UniFlangePanel.jsx'
import DeviceChain from '../DeviceChain.jsx'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const CHAIN = [{ nodeId: 7, pluginId: 'uniflange', position: 0, bypassed: false }]
const params = (over = {}) => JSON.stringify(Object.entries({
  order: 4, depth: 50, speed: 50, delay: 0, spread: 100, cross: 0, dry: 0, wet: 100, ...over,
}).map(([id, value]) => ({ id, value })))

let container
let root
let audio
let engineParams

const flush = async () => { await act(async () => { await new Promise((r) => setTimeout(r, 0)) }) }
const q = (sel) => container.querySelector(sel)
const aria = (label) => q(`[role="slider"][aria-label="${label}"]`)?.getAttribute('aria-valuetext')

beforeEach(() => {
  HTMLCanvasElement.prototype.getContext = () => null
  engineParams = params()
  audio = {
    getEffectChain: vi.fn(async () => JSON.stringify(CHAIN)),
    getEffectParameters: vi.fn(async () => engineParams),
    setEffectParameter: vi.fn(),
    getEffectMeter: vi.fn(async () => [0, 0, 0]),
    setEffectBypass: vi.fn(async () => true),
  }
  window.xleth = { audio, timeline: { getTracks: async () => [] } }
  useEffectChainStore.setState({ chains: {}, fxModes: {} })
  useMixerStore.setState({ selectedChainKey: '3', tracks: { 3: { id: 3, name: 'Bus' } } })
  useUniFlangeStore.setState({ target: null })
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

describe('UniFlange device in the chain', () => {
  it('hydrates from the engine; every value prints through formatValue', async () => {
    engineParams = params({ order: 6, cross: -25, wet: 80 })
    act(() => root.render(<DeviceChain />))
    await flush()
    await flush()
    expect(audio.getEffectParameters).toHaveBeenCalledWith(3, 7)
    expect(aria('Order')).toBe('Order, 6')
    expect(aria('Depth')).toBe('Depth, 50 %')
    expect(aria('Cross')).toBe('Cross, −25 %')
    expect(aria('Wet')).toBe('Wet, +80 %')
  })

  it('sections run in signal order: Voices, Modulation, Stereo, Output', async () => {
    act(() => root.render(<DeviceChain />))
    await flush()
    const titles = Array.from(container.querySelectorAll('[role="heading"][aria-level="3"]')).map((h) => h.textContent)
    const order = ['Voices', 'Modulation', 'Stereo', 'Output'].map((t) => titles.indexOf(t))
    expect(order.every((i) => i >= 0)).toBe(true)
    expect([...order].sort((a, b) => a - b)).toEqual(order)
  })

  it('draws NO placeholder waveform before live data arrives', async () => {
    act(() => root.render(<DeviceChain />))
    await flush()
    expect(q('[data-lane="dry"]')).not.toBeNull()
    expect(q('[data-lane="wet"]')).not.toBeNull()
    expect(container.querySelectorAll('[data-lane] path').length).toBe(0)
  })

  it('the display switches in place between both lanes, dry and wet', async () => {
    act(() => root.render(<DeviceChain />))
    await flush()
    const pick = (name) => Array.from(container.querySelectorAll('[role="radio"]')).find((b) => b.textContent === name)
    act(() => pick('Dry').click())
    expect(q('[data-lane="wet"]')).toBeNull()
    act(() => pick('Wet').click())
    expect(q('[data-lane="dry"]')).toBeNull()
    expect(q('[data-lane="wet"]')).not.toBeNull()
  })

  it('an Order nudge writes a whole-number voice count to the engine', async () => {
    act(() => root.render(<DeviceChain />))
    await flush()
    await flush()
    act(() => { q('[role="slider"][aria-label="Order"]').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true })) })
    const calls = audio.setEffectParameter.mock.calls.filter((c) => c[2] === 'order')
    expect(calls.length).toBeGreaterThan(0)
    expect(Number.isInteger(calls[calls.length - 1][3])).toBe(true)
    expect(calls[calls.length - 1][3]).toBe(5)
  })

  it('pop-out opens the floating window and the docked slot becomes a strip', async () => {
    act(() => root.render(<><DeviceChain /><UniFlangePanel /></>))
    await flush()
    act(() => q('button[aria-label="Open UniFlange in a window"]').click())
    await flush()
    expect(useUniFlangeStore.getState().target).toEqual({ trackId: 3, nodeId: 7, storeKey: '3' })
    expect(q('[data-testid="uniflange-window"] section').getAttribute('data-presentation')).toBe('floating')
    act(() => q('button[aria-label="Close UniFlange"]').click())
    expect(useUniFlangeStore.getState().target).toBeNull()
  })
})

describe('UniFlangePanel (floating)', () => {
  it('opened from the FX Graph (no chain entry): activator shows state, disabled', async () => {
    useUniFlangeStore.setState({ target: { trackId: 3, nodeId: 99, storeKey: '3' } })
    act(() => root.render(<UniFlangePanel />))
    await flush()
    expect(q('button[aria-label="UniFlange on"]').disabled).toBe(true)
  })

  it('no longer carries the legacy panel or its CSS', () => {
    const src = readFileSync(path.resolve(__dirname, '../../mixer/UniFlangePanel.jsx'), 'utf8')
    expect(src).not.toMatch(/uniflange-panel-header|UniFlangeFader|PluginUIKitKnob|EffectPresetBar/)
    const css = readFileSync(path.resolve(__dirname, '../../../styles/app.css'), 'utf8')
    expect(css).not.toMatch(/\.flanger-panel|\.flanger-strip|\.flanger-mix|\.flanger-knob-cell|\.flanger-stage/)
  })
})
