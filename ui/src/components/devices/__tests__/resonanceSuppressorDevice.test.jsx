/**
 * @vitest-environment jsdom
 */
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import useEffectChainStore from '../../../stores/effectChainStore.js'
import useMixerStore from '../../../stores/mixerStore.js'
import useResonanceSuppressorStore from '../../../stores/resonanceSuppressorStore.js'
import ResonanceSuppressorPanel from '../../mixer/ResonanceSuppressorPanel.jsx'
import DeviceChain from '../DeviceChain.jsx'
import { SHIPPED_LAYOUTS } from '../../../plugin-ui/layouts/index.js'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

// engine XlethResonanceSuppressorEffect::createLayout(): [id, label, min, max]
const ENGINE = [
  ['depth', 'Depth', 0, 100], ['sharpness', 'Sharpness', 0, 100], ['selectivity', 'Selectivity', 0, 100],
  ['attack', 'Attack', 1, 200], ['release', 'Release', 10, 2000], ['mix', 'Mix', 0, 100],
  ['trim', 'Trim', -12, 12], ['stereo_link', 'Link', 0, 100],
]
const PARAMS = {
  depth: 60, sharpness: 40, selectivity: 55, attack: 12, release: 300, mix: 100, trim: -1.5, stereo_link: 80,
  delta: 0, processing_mode: 0, hq_engine: 0, quality: 1, stereo_mode: 0, mode: 0, wc_hp: 80, wc_lp: 16000,
  wc_b1_active: 1, wc_b1_freq: 250, wc_b1_gain: 0, wc_b1_type: 0, wc_b1_q: 1,
  wc_b2_active: 1, wc_b2_freq: 800, wc_b2_gain: 3, wc_b2_type: 0, wc_b2_q: 1.5,
  wc_b3_active: 0, wc_b4_active: 0, wc_b5_active: 0, wc_b6_active: 0, wc_b7_active: 0, wc_b8_active: 0,
}

let container
let root
let audio
let engineParams

const flush = async () => { await act(async () => { await new Promise((r) => setTimeout(r, 0)) }) }
const q = (sel) => container.querySelector(sel)
const slider = (label) => q(`[role="slider"][aria-label="${label}"]`)
const aria = (label) => slider(label)?.getAttribute('aria-valuetext')
const radios = (label) => Array.from(q(`[role="radiogroup"][aria-label="${label}"]`)?.querySelectorAll('[role="radio"]') ?? [])
const sent = (id) => audio.setEffectParameter.mock.calls.filter((c) => c[2] === id)
const titles = () => Array.from(container.querySelectorAll('[role="heading"][aria-level="3"]')).map((h) => h.textContent)
const button = (label) => q(`button[aria-label="${label}"]`)
const nudge = (el) => act(() => { el.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true })) })

function setup(overrides = {}) {
  engineParams = JSON.stringify(Object.entries({ ...PARAMS, ...overrides }).map(([id, value]) => ({ id, value })))
}

beforeEach(() => {
  setup()
  audio = {
    getEffectChain: vi.fn(async () => JSON.stringify([{ nodeId: 7, pluginId: 'resonancesuppressor', position: 0, bypassed: false }])),
    getEffectParameters: vi.fn(async () => engineParams),
    setEffectParameter: vi.fn(),
    getEffectMeter: vi.fn(async () => []),
    getEffectLatency: vi.fn(async () => JSON.stringify({ ok: true, latencySamples: 0, latencyMs: 0 })),
    setEffectBypass: vi.fn(async () => true),
    getAudioPerformanceTelemetry: vi.fn(async () => ({ realtimeRsHqRiskLevel: 'warning' })),
  }
  window.xleth = { audio, timeline: { getTracks: async () => [] } }
  useEffectChainStore.setState({ chains: {}, fxModes: {} })
  useMixerStore.setState({ selectedChainKey: '3', tracks: { 3: { id: 3, name: 'Bus' } } })
  useResonanceSuppressorStore.setState({ target: null })
  HTMLCanvasElement.prototype.getContext = () => null
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  vi.restoreAllMocks()
  container.remove()
  document.body.innerHTML = ''
  delete window.xleth
})

async function mount(extra = null) {
  act(() => root.render(<><DeviceChain />{extra}</>))
  await flush()
  await flush()
}

function selectBand(n) {
  const hit = q(`[data-handle="band-${n}"]`)
  act(() => { hit.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0 })) })
  act(() => { window.dispatchEvent(new MouseEvent('pointerup')) })
}

describe('Resonance suppressor device in the chain', () => {
  it('mirrors the engine ranges and hydrates; values print through formatValue', async () => {
    await mount()
    for (const [id, label, min, max] of ENGINE) {
      const el = slider(label)
      expect(el, id).not.toBeNull()
      expect([Number(el.getAttribute('aria-valuemin')), Number(el.getAttribute('aria-valuemax'))], id).toEqual([min, max])
    }
    expect(aria('Depth')).toBe('Depth, 60 %')
    expect(aria('Release')).toBe('Release, 300 ms')
    expect(aria('Trim')).toBe('Trim, −1.5 dB')
    expect(radios('Quality').map((r) => r.getAttribute('aria-checked'))).toEqual(['false', 'true', 'false'])
  })

  it('the hero is the spectrum with the focus-curve handles on top; sections run in signal order', async () => {
    await mount()
    const well = q('[role="group"][aria-label="Resonance display"]')
    expect(well.querySelector('canvas')).not.toBeNull()
    expect(well.querySelector('[aria-label="Focus curve editor"] [data-handle="hp"]')).not.toBeNull()
    expect(well.querySelector('[data-handle="band-2"]')).not.toBeNull()
    expect(well.querySelector('[data-handle="band-3"]')).toBeNull()
    expect(titles()).toEqual(['Detection', 'Time', 'Focus', 'Stereo', 'Output', 'Processing'])
  })

  it('switches and Delta commit one engine write each', async () => {
    await mount()
    act(() => radios('Suppression mode')[1].click())
    act(() => radios('Stereo mode')[2].click())
    act(() => radios('Latency mode')[1].click())
    act(() => radios('Quality')[0].click())
    act(() => Array.from(container.querySelectorAll('button[aria-pressed]')).find((b) => b.textContent === 'Delta').click())
    expect(sent('mode')).toEqual([[3, 7, 'mode', 1]])
    expect(sent('stereo_mode')).toEqual([[3, 7, 'stereo_mode', 2]])
    expect(sent('processing_mode')).toEqual([[3, 7, 'processing_mode', 1]])
    expect(sent('quality')).toEqual([[3, 7, 'quality', 0]])
    expect(sent('delta')).toEqual([[3, 7, 'delta', 1]])
  })

  it('the Focus section edits the band selected in the display, through the overlay\'s actions', async () => {
    await mount()
    expect(slider('Focus').getAttribute('aria-disabled')).toBe('true')
    selectBand(2)
    expect(slider('Focus').getAttribute('aria-disabled')).not.toBe('true')
    expect(aria('Sens')).toBe('Sens, +3.0 dB')
    nudge(slider('Sens'))
    expect(sent('wc_b2_gain').at(-1)[3]).toBeGreaterThan(3)
    nudge(slider('Width'))
    expect(sent('wc_b2_q').at(-1)[3]).toBeGreaterThan(1.5)
  })

  it('add and remove a focus band commit once each and follow the selection', async () => {
    await mount()
    act(() => button('Add focus band').click())
    expect(sent('wc_b3_active')).toEqual([[3, 7, 'wc_b3_active', 1]])
    act(() => button('Remove band 3').click())
    expect(sent('wc_b3_active').at(-1)).toEqual([3, 7, 'wc_b3_active', 0])
  })

  it('Delete on the window never removes a selected focus band (keys stay inside the display)', async () => {
    await mount()
    selectBand(2)
    act(() => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true })) })
    expect(sent('wc_b2_active')).toEqual([])
  })

  it('polls the high-quality risk only in high quality, and says so when it is at risk', async () => {
    await mount()
    expect(audio.getAudioPerformanceTelemetry).not.toHaveBeenCalled()
    expect(q('[data-device-plugin] p[role="alert"]')).toBeNull()
    act(() => radios('Latency mode')[1].click())
    await flush()
    expect(audio.getAudioPerformanceTelemetry).toHaveBeenCalled()
    expect(q('[data-device-plugin] p[role="alert"]').textContent).toMatch(/high quality can overrun/i)
  })

  it('the engine selector shows only in high quality, defaults to Classic, and one pick is one engine write', async () => {
    await mount()
    expect(radios('Engine')).toHaveLength(0)
    act(() => root.unmount())
    root = createRoot(container)
    setup({ processing_mode: 1 })
    await mount()
    const engine = radios('Engine')
    expect(engine.map((r) => r.textContent)).toEqual(['Classic', 'New'])
    expect(engine.map((r) => r.getAttribute('aria-checked'))).toEqual(['true', 'false'])
    act(() => engine[1].click())
    expect(sent('hq_engine')).toEqual([[3, 7, 'hq_engine', 1]])
    expect(radios('Engine').map((r) => r.getAttribute('aria-checked'))).toEqual(['false', 'true'])
    expect(q('[role="radiogroup"][aria-label="Engine"]').getAttribute('data-hint')).toMatch(/Presets do not sound identical across engines/)
  })

  it('the latency label is what the engine reports, read again when the engine or the quality changes', async () => {
    const reported = { ok: true, latencySamples: 1024, latencyMs: 21.333 }
    audio.getEffectLatency.mockImplementation(async () => JSON.stringify(reported))
    setup({ processing_mode: 1 })
    await mount()
    expect(audio.getEffectLatency).toHaveBeenCalledWith(3, 7)
    const label = () => q('[data-hint^="Latency this instance adds"]')?.textContent
    expect(label()).toMatch(/^21[.,]3.*ms.*latency$/)
    const before = audio.getEffectLatency.mock.calls.length
    Object.assign(reported, { latencySamples: 2048, latencyMs: 42.667 })
    act(() => radios('Engine')[1].click())
    await flush()
    expect(audio.getEffectLatency.mock.calls.length).toBeGreaterThan(before)
    expect(label()).toMatch(/^42[.,]7.*ms.*latency$/)
    const afterEngine = audio.getEffectLatency.mock.calls.length
    Object.assign(reported, { latencySamples: 512, latencyMs: 10.667 })
    act(() => radios('Quality')[0].click())
    await flush()
    expect(audio.getEffectLatency.mock.calls.length).toBeGreaterThan(afterEngine)
    expect(label()).toMatch(/^10[.,]7.*ms.*latency$/)
    Object.assign(reported, { latencySamples: 0, latencyMs: 0 })
    act(() => radios('Latency mode')[0].click())
    await flush()
    expect(label()).toBe('No latency')
  })

  it('Sharpness and Selectivity tooltips follow the engine; Classic keeps its text', async () => {
    const hint = (label) => slider(label).closest('[data-hint]').getAttribute('data-hint')
    setup({ processing_mode: 1, hq_engine: 0 })
    await mount()
    expect(hint('Sharpness')).toBe('How narrow a peak must be to count as a resonance')
    expect(hint('Selectivity')).toBe('How far a peak must stand out from its neighbours')
    act(() => radios('Engine')[1].click())
    expect(hint('Sharpness')).toBe('Narrows the cut around each resonance')
    expect(hint('Selectivity')).toBe("How far a peak must stand above the spectrum's baseline to be cut. Higher = fewer, more targeted cuts")
    act(() => radios('Latency mode')[0].click())
    expect(hint('Sharpness')).toBe('How narrow a peak must be to count as a resonance')
  })

  it('the reduction readout reads meter slot 3 (largest cut, dB) with the New engine and slot 2 (x 24 dB) with Classic', async () => {
    audio.getEffectMeter.mockImplementation(async () => JSON.stringify([0.1, 0.1, 0.25, 7.5, 0, 0, 0, 0]))
    const readout = () => q('[data-hint="Average of the largest cuts"], [data-hint="Largest cut"]')
    const settle = async () => { await act(async () => { await new Promise((r) => setTimeout(r, 150)) }) }
    setup({ processing_mode: 1, hq_engine: 0 })
    await mount()
    await settle()
    expect(readout().getAttribute('data-hint')).toBe('Average of the largest cuts')
    expect(readout().textContent).toMatch(/^Reduction −6[.,]0.*dB$/)
    act(() => radios('Engine')[1].click())
    await settle()
    expect(readout().getAttribute('data-hint')).toBe('Largest cut')
    expect(readout().textContent).toMatch(/^Reduction −7[.,]5.*dB$/)
  })

  it('pop-out opens the same device in a window; the legacy panel, its layout and its CSS are gone', async () => {
    await mount(<ResonanceSuppressorPanel />)
    act(() => button('Open Resonance suppressor in a window').click())
    await flush()
    expect(useResonanceSuppressorStore.getState().target).toEqual({ trackId: 3, nodeId: 7, storeKey: '3' })
    expect(q('[data-testid="resonancesuppressor-window"] section').getAttribute('data-presentation')).toBe('floating')
    const src = readFileSync(path.resolve(__dirname, '../../mixer/ResonanceSuppressorPanel.jsx'), 'utf8')
    expect(src).not.toMatch(/StockPluginRuntimeRenderer|PluginUIDesigner|resonancesuppressor-panel/)
    expect(SHIPPED_LAYOUTS.resonancesuppressor).toBeUndefined()
    expect(existsSync(path.resolve(__dirname, '../../../plugin-ui/layouts/resonancesuppressor.json'))).toBe(false)
    expect(readFileSync(path.resolve(__dirname, '../../../styles/app.css'), 'utf8')).not.toMatch(/resonance/)
  })
})
