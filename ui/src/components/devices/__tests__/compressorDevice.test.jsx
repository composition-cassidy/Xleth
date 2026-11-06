/**
 * @vitest-environment jsdom
 */
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import useEffectChainStore from '../../../stores/effectChainStore.js'
import useCompressorStore from '../../../stores/compressorStore.js'
import useMixerStore from '../../../stores/mixerStore.js'
import CompressorPanel from '../../mixer/CompressorPanel.jsx'
import DeviceChain from '../DeviceChain.jsx'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const CHAIN = [{ nodeId: 7, pluginId: 'compressor', position: 0, bypassed: false }]
const ENGINE_PARAMS = [
  { id: 'threshold', value: -18 }, { id: 'ratio', value: 4 }, { id: 'attack', value: 10 },
  { id: 'release', value: 100 }, { id: 'knee', value: 6 }, { id: 'makeup', value: 2 },
  { id: 'mix', value: 100 }, { id: 'lookahead', value: 0 }, { id: 'detect_mode', value: 0 },
]

let container
let root
let audio

const flush = async () => { await act(async () => { await new Promise((r) => setTimeout(r, 0)) }) }
const q = (sel) => container.querySelector(sel)

beforeEach(() => {
  HTMLCanvasElement.prototype.getContext = () => null
  audio = {
    getEffectChain: vi.fn(async () => JSON.stringify(CHAIN)),
    getEffectParameters: vi.fn(async () => JSON.stringify(ENGINE_PARAMS)),
    setEffectParameter: vi.fn(),
    getEffectMeter: vi.fn(async () => [0, 0, 0]),
    setEffectBypass: vi.fn(async () => true),
  }
  window.xleth = { audio, timeline: { getTracks: async () => [] } }
  useEffectChainStore.setState({ chains: {}, fxModes: {} })
  useMixerStore.setState({ selectedChainKey: '3', tracks: { 3: { id: 3, name: 'Bus' } } })
  useCompressorStore.setState({ target: null })
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

describe('Compressor device in the chain', () => {
  it('hydrates from the engine and prints every value through formatValue', async () => {
    act(() => root.render(<DeviceChain />))
    await flush()
    await flush()
    expect(audio.getEffectParameters).toHaveBeenCalledWith(3, 7)
    const text = (label) => q(`[role="slider"][aria-label="${label}"]`)?.getAttribute('aria-valuetext')
    expect(text('Threshold')).toBe('Threshold, −18.0 dB')
    expect(text('Ratio')).toBe('Ratio, 4.0 : 1')
    expect(text('Attack')).toBe('Attack, 10.0 ms')
    expect(text('Release')).toBe('Release, 100 ms')
    expect(text('Mix')).toBe('Mix, 100 %')
    for (const label of ['Knee', 'Makeup', 'Lookahead']) expect(text(label)).toBeTruthy()
  })

  it('a knob nudge writes the engine through setEffectParameter, as the runtime did', async () => {
    act(() => root.render(<DeviceChain />))
    await flush()
    await flush()
    const ratio = q('[role="slider"][aria-label="Ratio"]')
    act(() => { ratio.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true })) })
    const calls = audio.setEffectParameter.mock.calls.filter((c) => c[2] === 'ratio')
    expect(calls.length).toBeGreaterThan(0)
    expect(calls[calls.length - 1][0]).toBe(3)
    expect(calls[calls.length - 1][1]).toBe(7)
    expect(calls[calls.length - 1][3]).toBeGreaterThan(4)
  })

  it('Peak / RMS is a segmented control writing detect_mode', async () => {
    act(() => root.render(<DeviceChain />))
    await flush()
    const rms = Array.from(container.querySelectorAll('[role="radio"]')).find((b) => b.textContent === 'RMS')
    act(() => rms.click())
    expect(audio.setEffectParameter).toHaveBeenCalledWith(3, 7, 'detect_mode', 1)
  })

  it('the display switches in place between activity and the existing curve editor', async () => {
    act(() => root.render(<DeviceChain />))
    await flush()
    expect(q('[data-view="activity"]')).not.toBeNull()
    const curve = Array.from(container.querySelectorAll('[role="radio"]')).find((b) => b.textContent === 'Curve')
    act(() => curve.click())
    expect(q('[data-view="curve"] .pluginui-compressor-curve-canvas')).not.toBeNull()
  })

  it('has a gain-reduction meter with a numeric dB readout', async () => {
    act(() => root.render(<DeviceChain />))
    await flush()
    expect(q('[aria-label="Compressor gain reduction meter"]')).not.toBeNull()
    expect(container.textContent).toContain('0.0 dB')
  })

  it('pop-out opens the floating window and the docked slot becomes a strip', async () => {
    act(() => root.render(<><DeviceChain /><CompressorPanel /></>))
    await flush()
    act(() => q('button[aria-label="Open Compressor in a window"]').click())
    await flush()
    expect(useCompressorStore.getState().target).toEqual({ trackId: 3, nodeId: 7, storeKey: '3' })
    const floating = q('[data-testid="compressor-window"] section')
    expect(floating.getAttribute('data-presentation')).toBe('floating')
    expect(container.textContent).toContain('In window')
    act(() => q('button[aria-label="Close Compressor"]').click())
    expect(useCompressorStore.getState().target).toBeNull()
  })
})

describe('CompressorPanel (floating)', () => {
  it('opened from the FX Graph (no chain entry): activator shows state, disabled', async () => {
    useCompressorStore.setState({ target: { trackId: 3, nodeId: 99, storeKey: '3' } })
    act(() => root.render(<CompressorPanel />))
    await flush()
    expect(q('button[aria-label="Compressor on"]').disabled).toBe(true)
  })

  it('no longer carries the legacy body, the Designer column or its own header', () => {
    const src = readFileSync(path.resolve(__dirname, '../../mixer/CompressorPanel.jsx'), 'utf8')
    expect(src).not.toMatch(/LegacyCompressorBody|PluginUIDesigner|compressor-panel-header|StockPluginRuntimeRenderer/)
    const css = readFileSync(path.resolve(__dirname, '../../../styles/app.css'), 'utf8')
    expect(css).not.toMatch(/\.compressor-panel|\.compressor-knob-grid|\.compressor-detect-btn|\.compressor-gr-bar/)
  })
})
