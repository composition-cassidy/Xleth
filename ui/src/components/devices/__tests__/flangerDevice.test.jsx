/**
 * @vitest-environment jsdom
 */
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import useEffectChainStore from '../../../stores/effectChainStore.js'
import useFlangerStore from '../../../stores/flangerStore.js'
import useMixerStore from '../../../stores/mixerStore.js'
import FlangerPanel from '../../mixer/FlangerPanel.jsx'
import DeviceChain from '../DeviceChain.jsx'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const CHAIN = [{ nodeId: 7, pluginId: 'flanger', position: 0, bypassed: false }]
const params = (over = {}) => JSON.stringify(Object.entries({
  rate: 0.5, depth: 70, delay: 1.5, feedback: 50, width: 50, mix: 50, ...over,
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
  useFlangerStore.setState({ target: null })
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

describe('Flanger device in the chain', () => {
  it('hydrates from the engine; delay prints in ms with two decimals, feedback is signed', async () => {
    engineParams = params({ feedback: -40 })
    act(() => root.render(<DeviceChain />))
    await flush()
    await flush()
    expect(audio.getEffectParameters).toHaveBeenCalledWith(3, 7)
    expect(aria('Rate')).toBe('Rate, 0.50 Hz')
    expect(aria('Delay')).toBe('Delay, 1.50 ms')
    expect(aria('Feedback')).toBe('Feedback, −40 %')
    expect(aria('Mix')).toBe('Mix, 50 %')
  })

  it('sections run in signal order: Modulation, Delay, Feedback, Output', async () => {
    act(() => root.render(<DeviceChain />))
    await flush()
    const titles = Array.from(container.querySelectorAll('[role="heading"][aria-level="3"]')).map((h) => h.textContent)
    const order = ['Modulation', 'Delay', 'Feedback', 'Output'].map((t) => titles.indexOf(t))
    expect(order.every((i) => i >= 0)).toBe(true)
    expect([...order].sort((a, b) => a - b)).toEqual(order)
  })

  it('Invert flips the feedback sign through setEffectParameter and is off at 0', async () => {
    act(() => root.render(<DeviceChain />))
    await flush()
    await flush()
    const invert = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === 'Invert')
    expect(invert.getAttribute('aria-pressed')).toBe('false')
    act(() => invert.click())
    expect(audio.setEffectParameter).toHaveBeenCalledWith(3, 7, 'feedback', -50)
  })

  it('a rate nudge writes the engine', async () => {
    act(() => root.render(<DeviceChain />))
    await flush()
    await flush()
    act(() => { q('[role="slider"][aria-label="Rate"]').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true })) })
    const calls = audio.setEffectParameter.mock.calls.filter((c) => c[2] === 'rate')
    expect(calls.length).toBeGreaterThan(0)
    expect(calls[calls.length - 1][3]).toBeGreaterThan(0.5)
  })

  it('the display switches in place between the sweep and the LFO', async () => {
    act(() => root.render(<DeviceChain />))
    await flush()
    expect(q('[data-view="sweep"] canvas.flanger-stage-canvas')).not.toBeNull()
    const lfo = Array.from(container.querySelectorAll('[role="radio"]')).find((b) => b.textContent === 'LFO')
    act(() => lfo.click())
    expect(q('[data-view="lfo"] canvas.flanger-lfo-canvas')).not.toBeNull()
  })

  it('pop-out opens the floating window and the docked slot becomes a strip', async () => {
    act(() => root.render(<><DeviceChain /><FlangerPanel /></>))
    await flush()
    act(() => q('button[aria-label="Open Flanger in a window"]').click())
    await flush()
    expect(useFlangerStore.getState().target).toEqual({ trackId: 3, nodeId: 7, storeKey: '3' })
    expect(q('[data-testid="flanger-window"] section').getAttribute('data-presentation')).toBe('floating')
    act(() => q('button[aria-label="Close Flanger"]').click())
    expect(useFlangerStore.getState().target).toBeNull()
  })
})

describe('FlangerPanel (floating)', () => {
  it('opened from the FX Graph (no chain entry): activator shows state, disabled', async () => {
    useFlangerStore.setState({ target: { trackId: 3, nodeId: 99, storeKey: '3' } })
    act(() => root.render(<FlangerPanel />))
    await flush()
    expect(q('button[aria-label="Flanger on"]').disabled).toBe(true)
  })

  it('no longer carries the legacy panel or its CSS', () => {
    const src = readFileSync(path.resolve(__dirname, '../../mixer/FlangerPanel.jsx'), 'utf8')
    expect(src).not.toMatch(/flanger-panel-header|FlangerMixSlider|PluginUIKitKnob|EffectPresetBar/)
    const css = readFileSync(path.resolve(__dirname, '../../../styles/app.css'), 'utf8')
    expect(css).not.toMatch(/\.flanger-panel|\.flanger-strip|\.flanger-mix|\.flanger-knob-cell|\.flanger-stage/)
  })
})
