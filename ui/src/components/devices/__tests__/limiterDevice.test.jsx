/**
 * @vitest-environment jsdom
 */
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import useEffectChainStore from '../../../stores/effectChainStore.js'
import useLimiterStore from '../../../stores/limiterStore.js'
import useMixerStore from '../../../stores/mixerStore.js'
import LimiterPanel from '../../mixer/LimiterPanel.jsx'
import DeviceChain from '../DeviceChain.jsx'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const CHAIN = [{ nodeId: 7, pluginId: 'limiter', position: 0, bypassed: false }]
const params = (over = {}) => JSON.stringify(Object.entries({
  gain: 6, ceiling: -1, release: 120, style: 1, ...over,
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
    getEffectMeter: vi.fn(async () => [0.5, 0.25, 3, -14, -16]),
    setEffectBypass: vi.fn(async () => true),
  }
  window.xleth = { audio, timeline: { getTracks: async () => [] } }
  useEffectChainStore.setState({ chains: {}, fxModes: {} })
  useMixerStore.setState({ selectedChainKey: '3', tracks: { 3: { id: 3, name: 'Bus' } } })
  useLimiterStore.setState({ target: null })
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

describe('Limiter device in the chain', () => {
  it('hydrates from the engine; every value prints through formatValue', async () => {
    act(() => root.render(<DeviceChain />))
    await flush()
    await flush()
    expect(audio.getEffectParameters).toHaveBeenCalledWith(3, 7)
    expect(aria('Gain')).toBe('Gain, 6.0 dB')
    expect(aria('Ceiling')).toBe('Ceiling, −1.0 dB')
    expect(aria('Release')).toBe('Release, 120 ms')
  })

  it('sections run in signal order: Gain, Ceiling, Character, GR, Output', async () => {
    act(() => root.render(<DeviceChain />))
    await flush()
    const titles = Array.from(container.querySelectorAll('[role="heading"][aria-level="3"]')).map((h) => h.textContent)
    const order = ['Gain', 'Ceiling', 'Character', 'GR', 'Output'].map((t) => titles.indexOf(t))
    expect(order.every((i) => i >= 0)).toBe(true)
    expect([...order].sort((a, b) => a - b)).toEqual(order)
  })

  it('has a GR meter and an output peak meter with numeric readouts, and no true-peak toggle', async () => {
    act(() => root.render(<DeviceChain />))
    await flush()
    expect(q('[aria-label="Limiter gain reduction meter"]')).not.toBeNull()
    expect(q('[aria-label="Limiter output peak meter"]')).not.toBeNull()
    expect(container.textContent).toContain('Momentary LUFS')
    expect(container.textContent).not.toMatch(/true.?peak/i)
  })

  it('the display switches in place between the waveform and the GR history', async () => {
    act(() => root.render(<DeviceChain />))
    await flush()
    expect(q('[data-view="waveform"]')).not.toBeNull()
    const gr = Array.from(container.querySelectorAll('[role="radio"]')).find((b) => b.textContent === 'GR')
    act(() => gr.click())
    expect(q('[data-view="gr"]')).not.toBeNull()
  })

  it('a ceiling nudge writes the engine; the style select writes style', async () => {
    act(() => root.render(<DeviceChain />))
    await flush()
    await flush()
    act(() => { q('[role="slider"][aria-label="Ceiling"]').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true })) })
    const calls = audio.setEffectParameter.mock.calls.filter((c) => c[2] === 'ceiling')
    expect(calls.length).toBeGreaterThan(0)
    expect(calls[calls.length - 1].slice(0, 2)).toEqual([3, 7])
    expect(calls[calls.length - 1][3]).toBeGreaterThan(-1)
  })

  it('pop-out opens the floating window and the docked slot becomes a strip', async () => {
    act(() => root.render(<><DeviceChain /><LimiterPanel /></>))
    await flush()
    act(() => q('button[aria-label="Open Limiter in a window"]').click())
    await flush()
    expect(useLimiterStore.getState().target).toEqual({ trackId: 3, nodeId: 7, storeKey: '3' })
    expect(q('[data-testid="limiter-window"] section').getAttribute('data-presentation')).toBe('floating')
    act(() => q('button[aria-label="Close Limiter"]').click())
    expect(useLimiterStore.getState().target).toBeNull()
  })
})

describe('LimiterPanel (floating)', () => {
  it('opened from the FX Graph (no chain entry): activator shows state, disabled', async () => {
    useLimiterStore.setState({ target: { trackId: 3, nodeId: 99, storeKey: '3' } })
    act(() => root.render(<LimiterPanel />))
    await flush()
    expect(q('button[aria-label="Limiter on"]').disabled).toBe(true)
  })

  it('no longer carries the legacy panel or its CSS', () => {
    const src = readFileSync(path.resolve(__dirname, '../../mixer/LimiterPanel.jsx'), 'utf8')
    expect(src).not.toMatch(/LegacyLimiterBody|PluginUIDesigner|limiter-panel-header|StockPluginRuntimeRenderer/)
    const css = readFileSync(path.resolve(__dirname, '../../../styles/app.css'), 'utf8')
    expect(css).not.toMatch(/\.limiter-panel|\.limiter-knob|\.limiter-style|\.limiter-gr-|\.limiter-lufs/)
  })
})
