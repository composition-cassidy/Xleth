/**
 * @vitest-environment jsdom
 */
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import useEffectChainStore from '../../../stores/effectChainStore.js'
import useSmartBalanceStore from '../../../stores/smartBalanceStore.js'
import useMixerStore from '../../../stores/mixerStore.js'
import SmartBalancePanel from '../../mixer/SmartBalancePanel.jsx'
import DeviceChain from '../DeviceChain.jsx'
import { THIN_SPACE as T } from '../../../ui-kit'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const CHAIN = [{ nodeId: 7, pluginId: 'smartbalance', position: 0, bypassed: false }]
const BASE = {
  amount: 70, preserve: 40, response: 150, mix: 100, mode: 0,
  target_sub: 0, bandamt_sub: 100, floor_sub: -60,
  target_lomid: 2, bandamt_lomid: 80, floor_lomid: -50,
  target_upmid: 0, bandamt_upmid: 100, floor_upmid: -60,
  target_air: -3, bandamt_air: 60, floor_air: -72,
}
const params = (over = {}) => JSON.stringify(Object.entries({ ...BASE, ...over }).map(([id, value]) => ({ id, value })))

let container
let root
let audio
let engineParams

const flush = async () => { await act(async () => { await new Promise((r) => setTimeout(r, 0)) }) }
const q = (sel) => container.querySelector(sel)
const slider = (label) => q(`[role="slider"][aria-label="${label}"]`)
const aria = (label) => slider(label)?.getAttribute('aria-valuetext')
const radio = (group, text) => Array.from(q(`[role="radiogroup"][aria-label="${group}"]`).querySelectorAll('[role="radio"]'))
  .find((b) => b.textContent === text)

beforeEach(() => {
  HTMLCanvasElement.prototype.getContext = () => null
  engineParams = params()
  audio = {
    getEffectChain: vi.fn(async () => JSON.stringify(CHAIN)),
    getEffectParameters: vi.fn(async () => engineParams),
    setEffectParameter: vi.fn(),
    getEffectMeter: vi.fn(async () => [-20, -22, -25, -30, 1, 0, -1, 0]),
    smartBalanceGetDebug: vi.fn(async () => ({ dryRms: [-20, -22, -25, -30], dynDelta: [0, 0, 0, 0], transient: [0, 0, 0, 0], overallRms: -18 })),
    setEffectBypass: vi.fn(async () => true),
  }
  window.xleth = { audio, timeline: { getTracks: async () => [] } }
  useEffectChainStore.setState({ chains: {}, fxModes: {} })
  useMixerStore.setState({ selectedChainKey: '3', tracks: { 3: { id: 3, name: 'Bus' } } })
  useSmartBalanceStore.setState({ target: null })
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

describe('Smart Balance device in the chain', () => {
  it('hydrates from the engine; the global knobs print their units', async () => {
    await mount()
    expect(audio.getEffectParameters).toHaveBeenCalledWith(3, 7)
    expect(aria('Amount')).toBeDefined()
    expect(q('[role="slider"][aria-label="Response"]').getAttribute('aria-valuetext')).toBe(`Response, 150${T}ms`)
    expect(aria('Preserve')).toBe(`Preserve, 40${T}%`)
    expect(aria('Mix')).toBe(`Mix, 100${T}%`)
  })

  it('sections run in signal order: Measure, Band, Correct, Output', async () => {
    await mount()
    const titles = Array.from(container.querySelectorAll('[role="heading"][aria-level="3"]')).map((h) => h.textContent)
    const order = ['Measure', 'Band', 'Correct', 'Output'].map((t) => titles.indexOf(t))
    expect(order.every((i) => i >= 0)).toBe(true)
    expect([...order].sort((a, b) => a - b)).toEqual(order)
  })

  it('the Band block follows the selector: one block of three knobs for four bands', async () => {
    await mount()
    expect(q('[data-band="sub"]')).not.toBeNull()
    expect(aria('Offset')).toBe(`Offset, 0.0${T}dB`)
    act(() => radio('Band', 'Low-mid').click())
    await flush()
    expect(q('[data-band="lomid"]')).not.toBeNull()
    expect(aria('Offset')).toBe(`Offset, +2.0${T}dB`)
    expect(aria('Floor')).toBe(`Floor, −50${T}dB`)
    expect(q('[data-band="lomid"]').getAttribute('style')).toContain('--ui-band-2')
    act(() => { slider('Offset').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true })) })
    expect(audio.setEffectParameter.mock.calls.some((c) => c[2] === 'target_lomid')).toBe(true)
    expect(audio.setEffectParameter.mock.calls.some((c) => c[2] === 'target_sub')).toBe(false)
  })

  it('Relative labels the knob Offset; Absolute labels it Target and writes mode once', async () => {
    await mount()
    expect(slider('Offset')).not.toBeNull()
    act(() => radio('Mode', 'Absolute').click())
    expect(audio.setEffectParameter).toHaveBeenCalledWith(3, 7, 'mode', 1)
    await flush()
    expect(slider('Target')).not.toBeNull()
    expect(slider('Offset')).toBeNull()
  })

  it('ranges are the engine\'s', async () => {
    await mount()
    const range = (label) => [slider(label).getAttribute('aria-valuemin'), slider(label).getAttribute('aria-valuemax')]
    expect(range('Offset')).toEqual(['-40', '12'])
    expect(range('Floor')).toEqual(['-96', '-20'])
    expect(range('Response')).toEqual(['10', '500'])
  })

  it('the display polls the engine\'s meters and debug atomics', async () => {
    const raf = vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => setTimeout(() => cb(performance.now()), 0))
    HTMLCanvasElement.prototype.getContext = () => new Proxy({}, { get: () => () => {}, set: () => true })
    await mount()
    await flush()
    await flush()
    expect(audio.getEffectMeter).toHaveBeenCalledWith(3, 7)
    expect(audio.smartBalanceGetDebug).toHaveBeenCalledWith(3, 7)
    raf.mockRestore()
  })

  it('the display switches in place between Levels and Details', async () => {
    await mount()
    expect(q('[role="group"][aria-label="Smart Balance display"] canvas')).not.toBeNull()
    expect(radio('Smart Balance display view', 'Levels').getAttribute('aria-checked')).toBe('true')
    act(() => radio('Smart Balance display view', 'Details').click())
    expect(radio('Smart Balance display view', 'Details').getAttribute('aria-checked')).toBe('true')
  })

  it('pop-out opens the floating window and the docked slot becomes a strip', async () => {
    act(() => root.render(<><DeviceChain /><SmartBalancePanel /></>))
    await flush()
    act(() => q('button[aria-label="Open Smart balance in a window"]').click())
    await flush()
    expect(useSmartBalanceStore.getState().target).toEqual({ trackId: 3, nodeId: 7, storeKey: '3' })
    expect(q('[data-testid="smartbalance-window"] section').getAttribute('data-presentation')).toBe('floating')
    act(() => q('button[aria-label="Close Smart balance"]').click())
    expect(useSmartBalanceStore.getState().target).toBeNull()
  })
})

describe('SmartBalancePanel (floating)', () => {
  it('no longer carries the legacy panel, its inline styles or its CSS', () => {
    const src = readFileSync(path.resolve(__dirname, '../../mixer/SmartBalancePanel.jsx'), 'utf8')
    expect(src).not.toMatch(/sb-panel|sampler\/Knob|EffectPresetBar|style=\{\{/)
    const css = readFileSync(path.resolve(__dirname, '../../../styles/app.css'), 'utf8')
    expect(css).not.toMatch(/\.sb-/)
    expect(css).not.toMatch(/theme-smartbalance-band/)
  })
})
