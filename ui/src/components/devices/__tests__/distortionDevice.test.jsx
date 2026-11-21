/**
 * @vitest-environment jsdom
 */
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { readFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import useEffectChainStore from '../../../stores/effectChainStore.js'
import useDistortionStore from '../../../stores/distortionStore.js'
import useMixerStore from '../../../stores/mixerStore.js'
import { SHIPPED_LAYOUTS } from '../../../plugin-ui/layouts/index.js'
import { COMPONENT_REGISTRY } from '../../../plugin-ui/runtime/registry.js'
import DistortionPanel from '../../mixer/DistortionPanel.jsx'
import DeviceChain from '../DeviceChain.jsx'
import { deviceBodyFor } from '../deviceRegistry.js'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

// engine XlethDistortionEffect::createLayout(): [id, min, max, default]
const ENGINE = [
  ['mode', 0, 6, 0], ['drive', 0, 48, 12], ['tone', 20, 20000, 8000], ['filter_pos', 0, 1, 1],
  ['mix', 0, 100, 100], ['symmetry', 0, 100, 100], ['bits', 2, 16, 16], ['downsample', 1, 40, 1],
]
const CHAIN = [{ nodeId: 7, pluginId: 'distortion', position: 0, bypassed: false }]
const params = (over = {}) => JSON.stringify(Object.entries({
  mode: 3, drive: 18, tone: 6400, filter_pos: 1, mix: 80, symmetry: 70, bits: 8, downsample: 4, ...over,
}).map(([id, value]) => ({ id, value })))

let container
let root
let audio
let engineParams

const flush = async () => { await act(async () => { await new Promise((r) => setTimeout(r, 0)) }) }
const q = (sel) => container.querySelector(sel)
// A Select: open the trigger, then click the option in the portalled listbox.
const trigger = (label) => q(`button[aria-haspopup="listbox"][aria-label="${label}"]`)
const pick = (label, optionLabel) => {
  expect(trigger(label), `select "${label}"`).toBeTruthy()
  act(() => trigger(label).click())
  const option = Array.from(document.querySelectorAll('[role="option"]')).find((o) => o.textContent.trim() === optionLabel)
  expect(option, `option "${optionLabel}"`).toBeTruthy()
  act(() => option.click())
}
const slider = (label) => q(`[role="slider"][aria-label="${label}"]`)
const aria = (label) => slider(label)?.getAttribute('aria-valuetext')
const sent = (id) => audio.setEffectParameter.mock.calls.filter((c) => c[2] === id)
const titles = () => Array.from(container.querySelectorAll('[role="heading"][aria-level="3"]')).map((h) => h.textContent)

beforeEach(() => {
  HTMLCanvasElement.prototype.getContext = () => null
  engineParams = params()
  audio = {
    getEffectChain: vi.fn(async () => JSON.stringify(CHAIN)),
    getEffectParameters: vi.fn(async () => engineParams),
    setEffectParameter: vi.fn(),
    getEffectMeter: vi.fn(async () => [0.5, 0.25]),
    setEffectBypass: vi.fn(async () => true),
  }
  window.xleth = { audio, timeline: { getTracks: async () => [] } }
  useEffectChainStore.setState({ chains: {}, fxModes: {} })
  useMixerStore.setState({ selectedChainKey: '3', tracks: { 3: { id: 3, name: 'Bus' } } })
  useDistortionStore.setState({ target: null })
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

describe('Distortion device in the chain', () => {
  it('is registered and its parameter surface is the engine table', async () => {
    expect(deviceBodyFor('distortion')).not.toBeNull()
    const { DISTORTION_MANIFEST } = await import('../../../plugin-ui/manifests/distortion.js')
    for (const [id, min, max, def] of ENGINE) {
      expect(DISTORTION_MANIFEST.params[id]).toMatchObject({ min, max, defaultValue: def })
    }
  })

  it('hydrates from the engine; every value prints through formatValue', async () => {
    act(() => root.render(<DeviceChain />))
    await flush()
    await flush()
    expect(audio.getEffectParameters).toHaveBeenCalledWith(3, 7)
    expect(aria('Drive')).toBe('Drive, 18.0 dB')
    expect(aria('Tone')).toBe('Tone, 6.40 kHz')
    expect(aria('Mix')).toBe('Mix, 80 %')
    expect(aria('Symmetry')).toBe('Symmetry, 70 %')
    expect(aria('Bits')).toBe('Bits, 8')
    expect(aria('Downsample')).toBe('Downsample, ×4')
  })

  it('sections run in signal order: Mode, Drive, Tone, Output', async () => {
    act(() => root.render(<DeviceChain />))
    await flush()
    const t = titles()
    const order = ['Mode', 'Drive', 'Tone', 'Output'].map((n) => t.indexOf(n))
    expect(order.every((i) => i >= 0)).toBe(true)
    expect([...order].sort((a, b) => a - b)).toEqual(order)
  })

  it('offers all seven modes and the selected one is the engine mode', async () => {
    act(() => root.render(<DeviceChain />))
    await flush()
    await flush()
    expect(trigger('Distortion mode').textContent).toBe('Analog')
    act(() => trigger('Distortion mode').click())
    const labels = Array.from(document.querySelectorAll('[role="option"]')).map((o) => o.textContent.trim())
    expect(labels).toEqual(['Tube', 'Soft clip', 'Hard clip', 'Analog', 'Crush', 'Fuzz', 'Sine'])
    act(() => Array.from(document.querySelectorAll('[role="option"]')).find((o) => o.textContent.trim() === 'Fuzz').click())
    expect(sent('mode')[sent('mode').length - 1].slice(2)).toEqual(['mode', 5])
  })

  it('the mode-specific knobs are enabled only in their mode (dimmed, never hidden)', async () => {
    act(() => root.render(<DeviceChain />))
    await flush()
    await flush()
    expect(slider('Symmetry').getAttribute('aria-disabled')).toBeNull()
    expect(slider('Bits').getAttribute('aria-disabled')).toBe('true')
    expect(slider('Downsample').getAttribute('aria-disabled')).toBe('true')
    pick('Distortion mode', 'Crush')
    expect(slider('Symmetry').getAttribute('aria-disabled')).toBe('true')
    expect(slider('Bits').getAttribute('aria-disabled')).toBeNull()
  })

  it('Pre / Post writes filter_pos; a drive nudge writes the engine', async () => {
    act(() => root.render(<DeviceChain />))
    await flush()
    await flush()
    act(() => Array.from(container.querySelectorAll('[role="radio"]')).find((b) => b.textContent === 'Pre').click())
    expect(sent('filter_pos')[0].slice(2)).toEqual(['filter_pos', 0])
    act(() => { slider('Drive').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true })) })
    const drive = sent('drive')
    expect(drive.length).toBeGreaterThan(0)
    expect(drive[drive.length - 1].slice(0, 2)).toEqual([3, 7])
    expect(drive[drive.length - 1][3]).toBeGreaterThan(18)
  })

  it('has the transfer-curve well and an output peak meter, and no Output level knob', async () => {
    act(() => root.render(<DeviceChain />))
    await flush()
    expect(q('[aria-label="Distortion transfer curve, output against input"]')).not.toBeNull()
    expect(q('[aria-label="Distortion output peak meter"]')).not.toBeNull()
    expect(slider('Output')).toBeNull()
  })

  it('pop-out opens the floating window and the docked slot becomes a strip', async () => {
    act(() => root.render(<><DeviceChain /><DistortionPanel /></>))
    await flush()
    act(() => q('button[aria-label="Open Distortion in a window"]').click())
    await flush()
    expect(useDistortionStore.getState().target).toEqual({ trackId: 3, nodeId: 7, storeKey: '3' })
    expect(q('[data-testid="distortion-window"] section').getAttribute('data-presentation')).toBe('floating')
    act(() => q('button[aria-label="Close Distortion"]').click())
    expect(useDistortionStore.getState().target).toBeNull()
  })
})

describe('Distortion: the plugin-ui layout is retired', () => {
  it('no shipped layout, no distortionCurve node, no legacy panel or CSS', () => {
    expect(SHIPPED_LAYOUTS.distortion).toBeUndefined()
    expect(COMPONENT_REGISTRY.distortionCurve).toBeUndefined()
    expect(existsSync(path.resolve(__dirname, '../../../plugin-ui/layouts/distortion.json'))).toBe(false)
    const src = readFileSync(path.resolve(__dirname, '../../mixer/DistortionPanel.jsx'), 'utf8')
    expect(src).not.toMatch(/LegacyDistortionBody|PluginUIDesigner|StockPluginRuntimeRenderer|distortion-panel-header/)
    const css = readFileSync(path.resolve(__dirname, '../../../styles/app.css'), 'utf8')
    expect(css).not.toMatch(/\.distortion-|pluginui-distortion|distortion-root/)
  })
})
