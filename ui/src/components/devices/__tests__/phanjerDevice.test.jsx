/**
 * @vitest-environment jsdom
 */
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import useEffectChainStore from '../../../stores/effectChainStore.js'
import usePhanjerStore from '../../../stores/phanjerStore.js'
import useMixerStore from '../../../stores/mixerStore.js'
import PhanjerPanel from '../../mixer/PhanjerPanel.jsx'
import DeviceChain from '../DeviceChain.jsx'
import { THIN_SPACE as T } from '../../../ui-kit'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const CHAIN = [{ nodeId: 7, pluginId: 'phanjer', position: 0, bypassed: false }]
const DEFAULTS = {
  mode: 0,
  f_mix: 75, f_rate: 0.5, f_depth: 70, f_feedback: 40,
  f_delay_min: 1.0, f_delay_max: 5.0, f_sync: 0, f_sync_div: 2, f_sync_feel: 0,
  p_mix: 75, p_rate: 0.35, p_depth: 80, p_feedback: 40,
  p_stages: 6, p_freq_min: 100, p_freq_max: 4000, p_sync: 0, p_sync_div: 2, p_sync_feel: 0,
  global_mix: 50, lfo_shape: 0, chaos: 0,
}
const params = (over = {}) => JSON.stringify(Object.entries({ ...DEFAULTS, ...over }).map(([id, value]) => ({ id, value })))

let container
let root
let audio
let engineParams

const flush = async () => { await act(async () => { await new Promise((r) => setTimeout(r, 0)) }) }
const q = (sel) => container.querySelector(sel)
const sides = () => ({ flanger: q('[data-side="flanger"]'), phaser: q('[data-side="phaser"]') })
const slider = (scope, label) => scope.querySelector(`[role="slider"][aria-label="${label}"]`)
const radio = (group, text) => Array.from(q(`[role="radiogroup"][aria-label="${group}"]`).querySelectorAll('[role="radio"]'))
  .find((b) => b.textContent === text || b.getAttribute('aria-label') === text)

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
  usePhanjerStore.setState({ target: null })
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

const mount = async () => {
  act(() => root.render(<DeviceChain />))
  await flush()
  await flush()
}

describe('Phanjer device in the chain', () => {
  it('hydrates all of it from the engine, each side printing its own values', async () => {
    engineParams = params({ f_rate: 2, p_feedback: -30, f_delay_max: 12, p_freq_max: 5490, global_mix: 62 })
    await mount()
    const { flanger, phaser } = sides()
    expect(audio.getEffectParameters).toHaveBeenCalledWith(3, 7)
    expect(slider(flanger, 'Rate').getAttribute('aria-valuetext')).toBe(`Rate, 2.00${T}Hz`)
    expect(slider(phaser, 'Feedback').getAttribute('aria-valuetext')).toBe(`Feedback, −30${T}%`)
    expect(slider(flanger, 'Delay max').getAttribute('aria-valuetext')).toBe(`Delay max, 12.00${T}ms`)
    expect(slider(phaser, 'Freq max').getAttribute('aria-valuetext')).toBe(`Freq max, 5.49${T}kHz`)
    expect(slider(container, 'Global mix').getAttribute('aria-valuetext')).toBe(`Global mix, 62${T}%`)
  })

  it('the two sides wear two band-palette hues, not the old module colours', async () => {
    await mount()
    const { flanger, phaser } = sides()
    expect(flanger.style.getPropertyValue('--ui-value')).toBe('var(--ui-band-1)')
    expect(phaser.style.getPropertyValue('--ui-value')).toBe('var(--ui-band-3)')
    const src = readFileSync(path.resolve(__dirname, '../PhanjerResponseCanvas.jsx'), 'utf8')
    expect(src).not.toMatch(/theme-mod-phanjer/)
  })

  it('sections run left to right: Flanger, Global, Phaser', async () => {
    await mount()
    const titles = Array.from(container.querySelectorAll('[role="heading"][aria-level="3"]')).map((h) => h.textContent)
    const order = ['Flanger', 'Global', 'Phaser'].map((t) => titles.indexOf(t))
    expect(order.every((i) => i >= 0)).toBe(true)
    expect([...order].sort((a, b) => a - b)).toEqual(order)
  })

  it('mode is a segmented choice written as its index', async () => {
    await mount()
    expect(radio('Mode', 'Linked').getAttribute('aria-checked')).toBe('true')
    act(() => radio('Mode', 'Wild').click())
    expect(audio.setEffectParameter).toHaveBeenCalledWith(3, 7, 'mode', 2)
  })

  it('Linked disables the phaser rate and sync row; Smart enables them', async () => {
    await mount()
    const { phaser } = sides()
    expect(slider(phaser, 'Rate').getAttribute('aria-disabled')).toBe('true')
    expect(phaser.querySelector('[aria-label="Phaser tempo sync"]').disabled).toBe(true)
    act(() => radio('Mode', 'Smart').click())
    await flush()
    expect(slider(sides().phaser, 'Rate').getAttribute('aria-disabled')).not.toBe('true')
    expect(sides().phaser.querySelector('[aria-label="Phaser tempo sync"]').disabled).toBe(false)
  })

  it('flanger sync switches its Rate off and writes the toggle once', async () => {
    await mount()
    const toggle = q('[aria-label="Flanger tempo sync"]')
    expect(toggle.getAttribute('aria-pressed')).toBe('false')
    act(() => toggle.click())
    expect(audio.setEffectParameter).toHaveBeenCalledWith(3, 7, 'f_sync', 1)
    await flush()
    expect(slider(sides().flanger, 'Rate').getAttribute('aria-disabled')).toBe('true')
  })

  it('Chaos works only with the Random shape', async () => {
    await mount()
    expect(slider(container, 'Chaos').getAttribute('aria-disabled')).toBe('true')
    act(() => radio('LFO shape', 'Random').click())
    expect(audio.setEffectParameter).toHaveBeenCalledWith(3, 7, 'lfo_shape', 4)
    await flush()
    expect(slider(container, 'Chaos').getAttribute('aria-disabled')).not.toBe('true')
  })

  it('stages is a one-click choice of 1 to 6', async () => {
    await mount()
    act(() => radio('Stages', '3').click())
    expect(audio.setEffectParameter).toHaveBeenCalledWith(3, 7, 'p_stages', 3)
  })

  it('a flanger rate nudge writes f_rate and not p_rate', async () => {
    await mount()
    act(() => { slider(sides().flanger, 'Rate').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true })) })
    expect(audio.setEffectParameter.mock.calls.some((c) => c[2] === 'f_rate')).toBe(true)
    expect(audio.setEffectParameter.mock.calls.some((c) => c[2] === 'p_rate')).toBe(false)
  })

  it('the display is the response canvas', async () => {
    await mount()
    expect(q('canvas.phanjer-response-canvas')).not.toBeNull()
  })

  it('pop-out opens the floating window and the docked slot becomes a strip', async () => {
    act(() => root.render(<><DeviceChain /><PhanjerPanel /></>))
    await flush()
    act(() => q('button[aria-label="Open Phanjer in a window"]').click())
    await flush()
    expect(usePhanjerStore.getState().target).toEqual({ trackId: 3, nodeId: 7, storeKey: '3' })
    expect(q('[data-testid="phanjer-window"] section').getAttribute('data-presentation')).toBe('floating')
    act(() => q('button[aria-label="Close Phanjer"]').click())
    expect(usePhanjerStore.getState().target).toBeNull()
  })
})

describe('PhanjerPanel (floating)', () => {
  it('no longer carries the legacy panel or its CSS', () => {
    const src = readFileSync(path.resolve(__dirname, '../../mixer/PhanjerPanel.jsx'), 'utf8')
    expect(src).not.toMatch(/phanjer-panel|PhanjerHSlider|PluginUIKitKnob|XlethSelect|HELP_ENTRIES/)
    const css = readFileSync(path.resolve(__dirname, '../../../styles/app.css'), 'utf8')
    expect(css).not.toMatch(/\.phanjer-/)
  })
})
