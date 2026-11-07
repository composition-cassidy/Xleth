/**
 * @vitest-environment jsdom
 */
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import useEffectChainStore from '../../../stores/effectChainStore.js'
import useDelayStore from '../../../stores/delayStore.js'
import useMixerStore from '../../../stores/mixerStore.js'
import DelayPanel from '../../mixer/DelayPanel.jsx'
import DeviceChain from '../DeviceChain.jsx'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const CHAIN = [{ nodeId: 7, pluginId: 'delay', position: 0, bypassed: false }]
const params = (over = {}) => JSON.stringify(Object.entries({
  time_l: 250, time_r: 375, sync: 0, sync_div_l: 7, sync_div_r: 9, stereo_mode: 1,
  feedback: 40, stereo_width: 60, mod_rate: 0.3, mod_depth: 15, duck_amount: 0,
  filter_lo: 80, filter_hi: 12000, mix: 30, ...over,
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
  useDelayStore.setState({ target: null })
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

describe('Delay device in the chain', () => {
  it('hydrates from the engine and prints every value through formatValue', async () => {
    act(() => root.render(<DeviceChain />))
    await flush()
    await flush()
    expect(audio.getEffectParameters).toHaveBeenCalledWith(3, 7)
    expect(aria('L time')).toBe('L time, 250 ms')
    expect(aria('R time')).toBe('R time, 375 ms')
    expect(aria('Feedback')).toBe('Feedback, 40 %')
    expect(aria('Mix')).toBe('Mix, 30 %')
    expect(aria('Mod rate')).toBe('Mod rate, 0.30 Hz')
  })

  it('sections run in signal order: Time, Model, Feedback, Output', async () => {
    act(() => root.render(<DeviceChain />))
    await flush()
    const titles = Array.from(container.querySelectorAll('[role="heading"][aria-level="3"]'))
      .map((h) => h.textContent)
    const order = ['Time', 'Model', 'Feedback', 'Output'].map((t) => titles.indexOf(t))
    expect(order.every((i) => i >= 0)).toBe(true)
    expect([...order].sort((a, b) => a - b)).toEqual(order)
  })

  it('tempo sync prints note values (1/8D, 1/16) on the division knobs', async () => {
    engineParams = params({ sync: 1, sync_div_l: 7, sync_div_r: 9 })
    act(() => root.render(<DeviceChain />))
    await flush()
    await flush()
    expect(aria('L division')).toBe('L division, 1/8D')
    expect(aria('R division')).toBe('R division, 1/16')
  })

  it('a feedback nudge writes the engine through setEffectParameter', async () => {
    act(() => root.render(<DeviceChain />))
    await flush()
    await flush()
    const fb = q('[role="slider"][aria-label="Feedback"]')
    act(() => { fb.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true })) })
    const calls = audio.setEffectParameter.mock.calls.filter((c) => c[2] === 'feedback')
    expect(calls.length).toBeGreaterThan(0)
    expect(calls[calls.length - 1].slice(0, 2)).toEqual([3, 7])
    expect(calls[calls.length - 1][3]).toBeGreaterThan(40)
  })

  it('Single stereo mode locks the R tap to L', async () => {
    engineParams = params({ stereo_mode: 0 })
    act(() => root.render(<DeviceChain />))
    await flush()
    await flush()
    expect(q('[role="slider"][aria-label="R time"]').getAttribute('aria-disabled')).toBe('true')
    expect(aria('R time')).toBe('R time, 250 ms')
    expect(q('[role="slider"][aria-label="Spread"]')).not.toBeNull()
  })

  it('pop-out opens the floating window and the docked slot becomes a strip', async () => {
    act(() => root.render(<><DeviceChain /><DelayPanel /></>))
    await flush()
    act(() => q('button[aria-label="Open Delay in a window"]').click())
    await flush()
    expect(useDelayStore.getState().target).toEqual({ trackId: 3, nodeId: 7, storeKey: '3' })
    expect(q('[data-testid="delay-window"] section').getAttribute('data-presentation')).toBe('floating')
    expect(container.textContent).toContain('In window')
    act(() => q('button[aria-label="Close Delay"]').click())
    expect(useDelayStore.getState().target).toBeNull()
  })
})

describe('DelayPanel (floating)', () => {
  it('opened from the FX Graph (no chain entry): activator shows state, disabled', async () => {
    useDelayStore.setState({ target: { trackId: 3, nodeId: 99, storeKey: '3' } })
    act(() => root.render(<DelayPanel />))
    await flush()
    expect(q('button[aria-label="Delay on"]').disabled).toBe(true)
  })

  it('no longer carries the legacy panel or its CSS', () => {
    const src = readFileSync(path.resolve(__dirname, '../../mixer/DelayPanel.jsx'), 'utf8')
    expect(src).not.toMatch(/delay-panel-header|DelayMixSlider|PluginUIKitKnob|EffectPresetBar/)
    const css = readFileSync(path.resolve(__dirname, '../../../styles/app.css'), 'utf8')
    expect(css).not.toMatch(/\.delay-panel|\.delay-strip|\.delay-mix|\.delay-time-cell|\.delay-knob-cell/)
  })
})
