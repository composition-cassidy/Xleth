/**
 * @vitest-environment jsdom
 */
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import useEffectChainStore from '../../../stores/effectChainStore.js'
import useEqStore from '../../../stores/eqStore.js'
import useMixerStore from '../../../stores/mixerStore.js'
import EqPanel from '../../mixer/EqPanel.jsx'
import DeviceChain from '../DeviceChain.jsx'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const CHAIN = [{ nodeId: 7, pluginId: 'xletheq', position: 0, bypassed: false }]
const BANDS = [
  { index: 0, freq: 100, gain: 3, q: 0.707, type: 0, enabled: true, mode: 0, channel: 0 },
  {
    index: 1, freq: 2500, gain: -4.5, q: 1.2, type: 0, enabled: true, mode: 1, channel: 3,
    dyn_thresh: -20, dyn_ratio: 4, dyn_attack: 10, dyn_release: 100, dyn_range: 12,
  },
]

let container
let root
let audio

const flush = async () => { await act(async () => { await new Promise((r) => setTimeout(r, 0)) }) }
const q = (sel) => container.querySelector(sel)
const aria = (label) => q(`[role="slider"][aria-label="${label}"]`)?.getAttribute('aria-valuetext')

beforeEach(() => {
  HTMLCanvasElement.prototype.getContext = () => null
  audio = {
    getEffectChain: vi.fn(async () => JSON.stringify(CHAIN)),
    getEffectParameters: vi.fn(async () => '[]'),
    eqGetBands: vi.fn(async () => JSON.stringify(BANDS)),
    eqGetGlobalParams: vi.fn(async () => JSON.stringify({ linphase: 0, oversample: 0 })),
    eqGetSampleRate: vi.fn(async () => 48000),
    eqSetBandParam: vi.fn(async () => true),
    eqAddBand: vi.fn(async () => true),
    eqRemoveBand: vi.fn(async () => true),
    getEffectMeter: vi.fn(async () => [0, 0, 0]),
    setEffectBypass: vi.fn(async () => true),
  }
  window.xleth = { audio, timeline: { getTracks: async () => [] } }
  useEffectChainStore.setState({ chains: {}, fxModes: {} })
  useMixerStore.setState({ selectedChainKey: '3', tracks: { 3: { id: 3, name: 'Bus' } } })
  useEqStore.setState({ target: null })
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

// A click without movement selects the band (mousedown on the token, mouseup anywhere).
const select = (index) => {
  const token = q(`g[data-band="${index}"]`)
  act(() => { token.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0, clientX: 10, clientY: 10 })) })
  act(() => { document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true })) })
}

describe('Parametric EQ device in the chain', () => {
  it('shows one numbered token per band, from the engine', async () => {
    act(() => root.render(<DeviceChain />))
    await flush()
    await flush()
    expect(audio.eqGetBands).toHaveBeenCalledWith(3, 7)
    const tokens = container.querySelectorAll('g[data-band]')
    expect(tokens.length).toBe(2)
    expect(tokens[0].textContent).toContain('1')
    expect(tokens[1].textContent).toContain('2')
    expect(tokens[1].textContent).toContain('M')
  })

  it('the ruler speaks Hz with note names, and band names, on a log axis', async () => {
    act(() => root.render(<DeviceChain />))
    await flush()
    const svg = q('svg[aria-label^="EQ curve"]').textContent
    expect(svg).toContain('100 G2')
    expect(svg).toContain('1k B5')
    for (const name of ['SUB', 'BASS', 'LOW MID', 'MID', 'HI MID', 'PRS', 'TREBLE']) expect(svg).toContain(name)
  })

  it('draws no spectrum until the engine delivers one', async () => {
    act(() => root.render(<DeviceChain />))
    await flush()
    await flush()
    expect(container.querySelectorAll('svg path[class*="spec"]').length).toBe(0)
  })

  it('selecting a band shows frequency, gain and Q large with units', async () => {
    act(() => root.render(<DeviceChain />))
    await flush()
    await flush()
    expect(container.textContent).toContain('Click the curve to add a band')
    select(0)
    expect(aria('Frequency')).toBe('Frequency, 100 Hz')
    expect(aria('Gain')).toBe('Gain, +3.0 dB')
    expect(aria('Q')).toBe('Q, 0.71')
    select(1)
    expect(aria('Frequency')).toBe('Frequency, 2.50 kHz')
  })

  it('sections run in signal order: Band, Dynamics', async () => {
    act(() => root.render(<DeviceChain />))
    await flush()
    await flush()
    select(0)
    const titles = Array.from(container.querySelectorAll('[role="heading"][aria-level="3"]')).map((h) => h.textContent)
    expect(titles.indexOf('Band 1')).toBeGreaterThanOrEqual(0)
    expect(titles.indexOf('Dynamics')).toBeGreaterThan(titles.indexOf('Band 1'))
  })

  it('a frequency nudge writes the band through eqSetBandParam', async () => {
    act(() => root.render(<DeviceChain />))
    await flush()
    await flush()
    select(0)
    act(() => { q('[role="slider"][aria-label="Frequency"]').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true })) })
    const calls = audio.eqSetBandParam.mock.calls.filter((c) => c[3] === 'freq')
    expect(calls.length).toBeGreaterThan(0)
    expect(calls[calls.length - 1].slice(0, 3)).toEqual([3, 7, 0])
    expect(calls[calls.length - 1][4]).toBeGreaterThan(100)
  })

  it('right-click on a token opens the band type menu; choosing writes type', async () => {
    act(() => root.render(<DeviceChain />))
    await flush()
    await flush()
    act(() => { q('g[data-band="0"]').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 50, clientY: 50 })) })
    const menu = document.querySelector('[role="menu"]')
    expect(menu).not.toBeNull()
    const items = Array.from(menu.querySelectorAll('[role="menuitemradio"]'))
    expect(items.map((b) => b.textContent)).toEqual(['Bell', 'Low Shelf', 'High Shelf', 'Low Pass', 'High Pass', 'Notch', 'Tilt'])
    expect(menu.querySelector('[aria-checked="true"]').textContent).toBe('Bell')
    act(() => items.find((b) => b.textContent === 'High Shelf').click())
    expect(audio.eqSetBandParam).toHaveBeenCalledWith(3, 7, 0, 'type', 2)
    expect(document.querySelector('[role="menu"]')).toBeNull()
  })

  it('two EQ devices keep separate bands (private stores)', async () => {
    audio.getEffectChain = vi.fn(async () => JSON.stringify([
      { nodeId: 7, pluginId: 'xletheq', position: 0, bypassed: false },
      { nodeId: 8, pluginId: 'xletheq', position: 1, bypassed: false },
    ]))
    act(() => root.render(<DeviceChain />))
    await flush()
    await flush()
    expect(audio.eqGetBands).toHaveBeenCalledWith(3, 7)
    expect(audio.eqGetBands).toHaveBeenCalledWith(3, 8)
  })

  it('pop-out opens the floating window and the docked slot becomes a strip', async () => {
    act(() => root.render(<><DeviceChain /><EqPanel /></>))
    await flush()
    act(() => q('button[aria-label="Open Parametric EQ in a window"]').click())
    await flush()
    expect(useEqStore.getState().target).toEqual({ trackId: 3, nodeId: 7, storeKey: '3' })
    expect(q('[data-testid="eq-window"] section').getAttribute('data-presentation')).toBe('floating')
    act(() => q('button[aria-label="Close Parametric EQ"]').click())
    expect(useEqStore.getState().target).toBeNull()
  })
})

describe('EqPanel (floating)', () => {
  it('opened from the FX Graph (no chain entry): activator shows state, disabled', async () => {
    useEqStore.setState({ target: { trackId: 3, nodeId: 99, storeKey: '3' } })
    act(() => root.render(<EqPanel />))
    await flush()
    expect(q('button[aria-label="Parametric EQ on"]').disabled).toBe(true)
  })

  it('no longer carries the legacy panel, the band popup host or their CSS', () => {
    const src = readFileSync(path.resolve(__dirname, '../../mixer/EqPanel.jsx'), 'utf8')
    expect(src).not.toMatch(/eq-panel-header|EqBandPanel|EffectPresetBar|handleSvgMouseDown/)
    const css = readFileSync(path.resolve(__dirname, '../../../styles/app.css'), 'utf8')
    expect(css).not.toMatch(/\.eq-panel|\.eqc-|\.eqbp|\.eq-graph-row/)
  })
})
