/**
 * @vitest-environment jsdom
 */
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import useEffectChainStore from '../../../stores/effectChainStore.js'
import useReverbStore from '../../../stores/reverbStore.js'
import useMixerStore from '../../../stores/mixerStore.js'
import ReverbPanel from '../../mixer/ReverbPanel.jsx'
import DeviceChain from '../DeviceChain.jsx'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const CHAIN = [{ nodeId: 7, pluginId: 'reverb', position: 0, bypassed: false }]
const params = (over = {}) => JSON.stringify(Object.entries({
  decay: 2.5, size: 50, damping: 50, predelay: 10, er_level: 50, er_late: 50,
  smoothness: 0, mod_rate: 30, mod_depth: 20, hicut: 12000, locut: 80, mix: 30, style: 0, ...over,
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
  useReverbStore.setState({ target: null })
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

describe('Reverb device in the chain', () => {
  it('hydrates from the engine; every value prints with its unit', async () => {
    act(() => root.render(<DeviceChain />))
    await flush()
    await flush()
    expect(audio.getEffectParameters).toHaveBeenCalledWith(3, 7)
    expect(aria('Decay')).toBe('Decay, 2.5 s')
    expect(aria('Pre-delay')).toBe('Pre-delay, 10.0 ms')
    expect(aria('Size')).toBe('Size, 50 %')
    expect(aria('Mix')).toBe('Mix, 30 %')
  })

  it('sections run in signal order and there is no Width the engine does not have', async () => {
    act(() => root.render(<DeviceChain />))
    await flush()
    const titles = Array.from(container.querySelectorAll('[role="heading"][aria-level="3"]')).map((h) => h.textContent)
    const order = ['Space', 'Decay', 'Reflections', 'Filter', 'Output'].map((t) => titles.indexOf(t))
    expect(order.every((i) => i >= 0)).toBe(true)
    expect([...order].sort((a, b) => a - b)).toEqual(order)
    expect(q('[role="slider"][aria-label="Width"]')).toBeNull()
  })

  it('Plate relabels the reflection knobs (Bloom, Tank level)', async () => {
    engineParams = params({ style: 2 })
    act(() => root.render(<DeviceChain />))
    await flush()
    await flush()
    expect(q('[role="slider"][aria-label="Bloom"]')).not.toBeNull()
    expect(q('[role="slider"][aria-label="Tank level"]')).not.toBeNull()
    expect(q('[role="slider"][aria-label="ER level"]')).toBeNull()
  })

  it('a decay nudge writes the engine; a typed value parses as seconds', async () => {
    act(() => root.render(<DeviceChain />))
    await flush()
    await flush()
    act(() => { q('[role="slider"][aria-label="Decay"]').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true })) })
    const calls = audio.setEffectParameter.mock.calls.filter((c) => c[2] === 'decay')
    expect(calls.length).toBeGreaterThan(0)
    expect(calls[calls.length - 1][3]).toBeGreaterThan(2.5)
  })

  it('pop-out opens the floating window and the docked slot becomes a strip', async () => {
    act(() => root.render(<><DeviceChain /><ReverbPanel /></>))
    await flush()
    act(() => q('button[aria-label="Open Reverb in a window"]').click())
    await flush()
    expect(useReverbStore.getState().target).toEqual({ trackId: 3, nodeId: 7, storeKey: '3' })
    expect(q('[data-testid="reverb-window"] section').getAttribute('data-presentation')).toBe('floating')
    act(() => q('button[aria-label="Close Reverb"]').click())
    expect(useReverbStore.getState().target).toBeNull()
  })
})

describe('ReverbPanel (floating)', () => {
  it('opened from the FX Graph (no chain entry): activator shows state, disabled', async () => {
    useReverbStore.setState({ target: { trackId: 3, nodeId: 99, storeKey: '3' } })
    act(() => root.render(<ReverbPanel />))
    await flush()
    expect(q('button[aria-label="Reverb on"]').disabled).toBe(true)
  })

  it('no longer carries the legacy panel or its CSS', () => {
    const src = readFileSync(path.resolve(__dirname, '../../mixer/ReverbPanel.jsx'), 'utf8')
    expect(src).not.toMatch(/flanger-panel-header|ReverbMixSlider|PluginUIKitKnob|EffectPresetBar/)
    const css = readFileSync(path.resolve(__dirname, '../../../styles/app.css'), 'utf8')
    expect(css).not.toMatch(/\.reverb-panel|\.reverb-strip|\.reverb-mix|\.reverb-knob-cell|\.reverb-stage/)
  })
})
