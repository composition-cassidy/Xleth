/**
 * @vitest-environment jsdom
 */
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { SHIPPED_LAYOUTS } from '../../../plugin-ui/layouts/index.js'
import { COMPONENT_REGISTRY } from '../../../plugin-ui/runtime/registry.js'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import useEffectChainStore from '../../../stores/effectChainStore.js'
import useMixerStore from '../../../stores/mixerStore.js'
import useOverdoneStore from '../../../stores/overdoneStore.js'
import OTTPanel from '../../mixer/OTTPanel.jsx'
import DeviceChain from '../DeviceChain.jsx'
import { bandMotion } from '../OverdoneCrossoverCanvas.jsx'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

// engine XlethOTTEffect::createLayout(): [id, min, max, default]
const ENGINE = [
  ['depth', 0, 100, 70], ['time', 0, 100, 50], ['xover_low', 40, 400, 88], ['xover_high', 1000, 8000, 2500],
  ['gain_low', -12, 12, 0], ['gain_mid', -12, 12, 0], ['gain_high', -12, 12, 0],
  ['inputGain', -24, 24, 0], ['outputGain', -24, 24, 0],
]
const PARAMS = { depth: 55, time: 30, xover_low: 120, xover_high: 3000, gain_low: 2, gain_mid: -1.5, gain_high: 0, inputGain: -3, outputGain: 1 }

let container
let root
let audio
let chain
let engineParams

const flush = async () => { await act(async () => { await new Promise((r) => setTimeout(r, 0)) }) }
const q = (sel) => container.querySelector(sel)
const slider = (label) => q(`[role="slider"][aria-label="${label}"]`)
const aria = (label) => slider(label)?.getAttribute('aria-valuetext')
const sent = (id) => audio.setEffectParameter.mock.calls.filter((c) => c[2] === id)
const titles = () => Array.from(container.querySelectorAll('[role="heading"][aria-level="3"]')).map((h) => h.textContent)

beforeEach(() => {
  chain = [{ nodeId: 7, pluginId: 'overdone', position: 0, bypassed: false }]
  engineParams = JSON.stringify(Object.entries(PARAMS).map(([id, value]) => ({ id, value })))
  audio = {
    getEffectChain: vi.fn(async () => JSON.stringify(chain)),
    getEffectParameters: vi.fn(async () => engineParams),
    setEffectParameter: vi.fn(),
    getEffectMeter: vi.fn(async () => []),
    setEffectBypass: vi.fn(async () => true),
  }
  window.xleth = { audio, timeline: { getTracks: async () => [] } }
  useEffectChainStore.setState({ chains: {}, fxModes: {} })
  useMixerStore.setState({ selectedChainKey: '3', tracks: { 3: { id: 3, name: 'Bus' } } })
  useOverdoneStore.setState({ target: null })
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

describe('Overdone device in the chain', () => {
  it('mirrors the engine layout: ranges and defaults (Ctrl+click targets)', async () => {
    await mount()
    const labels = {
      depth: 'Depth', time: 'Time', xover_low: 'Low split', xover_high: 'High split',
      gain_low: 'Low', gain_mid: 'Mid', gain_high: 'High', inputGain: 'Input', outputGain: 'Output',
    }
    for (const [id, min, max] of ENGINE) {
      const el = slider(labels[id])
      expect(el, id).not.toBeNull()
      expect([Number(el.getAttribute('aria-valuemin')), Number(el.getAttribute('aria-valuemax'))], id).toEqual([min, max])
    }
  })

  it('hydrates from the engine; values print through formatValue', async () => {
    await mount()
    expect(audio.getEffectParameters).toHaveBeenCalledWith(3, 7)
    expect(aria('Depth')).toBe('Depth, 55 %')
    expect(aria('Low')).toBe('Low, +2.0 dB')
    expect(aria('Mid')).toBe('Mid, −1.5 dB')
    expect(aria('Low split')).toBe('Low split, 120 Hz')
    expect(aria('High split')).toBe('High split, 3.00 kHz')
    expect(aria('Input')).toBe('Input, −3.0 dB')
  })

  it('the crossover display is the hero; sections run in signal order; bands wear the band palette', async () => {
    await mount()
    expect(q('[role="group"][aria-label="Overdone display"] canvas[aria-label^="Crossover display"]')).not.toBeNull()
    expect(titles()).toEqual(['Input', 'Bands', 'Dynamics', 'Output'])
    const bandOf = (id) => q(`[data-param="${id}"]`).closest('[data-band]').getAttribute('data-band')
    expect(['gain_low', 'gain_mid', 'gain_high', 'xover_low', 'xover_high'].map(bandOf)).toEqual(['0', '1', '2', '0', '2'])
  })

  it('a knob nudge commits one write; knobs opt into automation', async () => {
    await mount()
    act(() => { slider('Depth').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true })) })
    expect(sent('depth')).toHaveLength(1)
    expect(sent('depth')[0][3]).toBeGreaterThan(55)
    for (const [id] of ENGINE) expect(q(`[data-automation-param="${id}"]`), id).not.toBeNull()
  })

  it('dragging a crossover line previews per frame and commits once on release', async () => {
    const frames = []
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => { frames.push(cb); return frames.length })
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {})
    await mount()
    const canvas = q('canvas[aria-label^="Crossover display"]')
    canvas.getBoundingClientRect = () => ({ left: 0, top: 0, width: 600, height: 200, right: 600, bottom: 200 })
    const xOf = (hz) => (Math.log(hz / 20) / Math.log(1000)) * 600
    const fire = (type, x) => {
      const e = new MouseEvent(type, { bubbles: true, clientX: x, clientY: 50 })
      Object.defineProperty(e, 'pointerId', { value: 1 })
      act(() => { canvas.dispatchEvent(e) })
    }
    fire('pointerdown', xOf(120))
    fire('pointermove', xOf(200))
    fire('pointermove', xOf(250))
    expect(sent('xover_low')).toHaveLength(0) // previews wait for the frame
    act(() => { frames.splice(0).forEach((cb) => cb(16)) })
    expect(sent('xover_low').length).toBeLessThanOrEqual(1)
    fire('pointerup', xOf(250))
    const last = sent('xover_low').at(-1)
    expect(last[3]).toBeCloseTo(250, 0)
  })

  it('up / down per band come from the multiband bucket: down = GR, up = out - in - band gain + down', () => {
    const bucket = {
      lowInputDb: -20, lowOutputDb: -14, lowGainReductionDb: 0,
      midInputDb: -10, midOutputDb: -14, midGainReductionDb: 4,
      highInputDb: -120, highOutputDb: -120, highGainReductionDb: 0,
    }
    const [low, mid, high] = bandMotion(bucket, [2, 0, 0])
    expect(low).toEqual({ up: 4, down: 0 })
    expect(mid).toEqual({ up: 0, down: 4 })
    expect(high).toEqual({ up: 0, down: 0 })
  })

  it('pop-out opens the same device in a window; the legacy panel, its layout, its runtime nodes and its CSS are gone', async () => {
    await mount(<OTTPanel />)
    act(() => q('button[aria-label="Open Overdone in a window"]').click())
    await flush()
    expect(useOverdoneStore.getState().target).toEqual({ trackId: 3, nodeId: 7, storeKey: '3' })
    expect(q('[data-testid="overdone-window"] section').getAttribute('data-presentation')).toBe('floating')
    act(() => q('button[aria-label="Close Overdone"]').click())
    expect(useOverdoneStore.getState().target).toBeNull()
    const src = readFileSync(path.resolve(__dirname, '../../mixer/OTTPanel.jsx'), 'utf8')
    expect(src).not.toMatch(/StockPluginRuntimeRenderer|PluginUIDesigner|ott-/)
    expect(readFileSync(path.resolve(__dirname, '../../../styles/app.css'), 'utf8')).not.toMatch(/\.ott-|pluginui-overdone/)
    expect(SHIPPED_LAYOUTS.overdone).toBeUndefined()
    expect(existsSync(path.resolve(__dirname, '../../../plugin-ui/layouts/overdone.json'))).toBe(false)
    expect(COMPONENT_REGISTRY.overdoneBandStack).toBeUndefined()
    expect(COMPONENT_REGISTRY.overdoneCrossovers).toBeUndefined()
  })
})
