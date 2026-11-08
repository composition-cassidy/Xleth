/**
 * @vitest-environment jsdom
 */
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import useEffectChainStore from '../../../stores/effectChainStore.js'
import useMixerStore from '../../../stores/mixerStore.js'
import useGlueCompStore from '../../../stores/glueCompStore.js'
import useOptoCompStore from '../../../stores/optoCompStore.js'
import useFetCompStore from '../../../stores/fetCompStore.js'
import GlueCompPanel from '../../mixer/GlueCompPanel.jsx'
import OptoCompPanel from '../../mixer/OptoCompPanel.jsx'
import FetCompPanel from '../../mixer/FetCompPanel.jsx'
import DeviceChain from '../DeviceChain.jsx'
import { MODELS, fetAttackSeconds, fetReleaseSeconds, formatDuration } from '../compressorFamilyModels.js'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

// The engine's createLayout() for each model: [id, min, max, default]. The
// device config must mirror it exactly (the legacy panels' own contract test).
const ENGINE = {
  glue: [
    ['threshold', -40, 0, -10], ['makeup', -10, 20, 0], ['sc_hpf_freq', 20, 500, 100],
  ],
  opto: [['peak_reduction', 0, 40, 20], ['gain', 0, 40, 0]],
  fet: [['input', -24, 36, 0], ['output', -24, 24, 0], ['attack', 1, 7, 3], ['release', 1, 7, 5]],
  varimu: [['input', -24, 36, 0], ['output', -24, 24, 0]],
}
const ENGINE_STEPPED = {
  glue: { ratio: [3, 1], attack: [6, 4], release: [5, 4], topology: [2, 0], sc_hpf_on: [2, 0], color: [2, 1] },
  opto: { mode: [2, 0] },
  fet: { ratio: [5, 0] },
  varimu: { time_constant: [6, 2], mode: [2, 0] },
}

let container
let root
let audio
let engineParams
let chain

const flush = async () => { await act(async () => { await new Promise((r) => setTimeout(r, 0)) }) }
const q = (sel) => container.querySelector(sel)
const aria = (label) => q(`[role="slider"][aria-label="${label}"]`)?.getAttribute('aria-valuetext')
const group = (label) => q(`[role="radiogroup"][aria-label="${label}"]`)
const radios = (label) => Array.from(group(label)?.querySelectorAll('[role="radio"]') ?? [])
const texts = (label) => radios(label).map((b) => b.textContent)
const checked = (label) => radios(label).findIndex((b) => b.getAttribute('aria-checked') === 'true')
const sent = (id) => audio.setEffectParameter.mock.calls.filter((c) => c[2] === id)
const asList = (obj) => JSON.stringify(Object.entries(obj).map(([id, value]) => ({ id, value })))

function setup(pluginId, params) {
  chain = [{ nodeId: 7, pluginId, position: 0, bypassed: false }]
  engineParams = asList(params)
  audio.getEffectChain = vi.fn(async () => JSON.stringify(chain))
}

beforeEach(() => {
  audio = {
    getEffectChain: vi.fn(async () => '[]'),
    getEffectParameters: vi.fn(async () => engineParams),
    setEffectParameter: vi.fn(),
    getEffectMeter: vi.fn(async () => [0.5, 0.25, 3, 1, 2, 7]),
    setEffectBypass: vi.fn(async () => true),
  }
  window.xleth = { audio, timeline: { getTracks: async () => [] } }
  useEffectChainStore.setState({ chains: {}, fxModes: {} })
  useMixerStore.setState({ selectedChainKey: '3', tracks: { 3: { id: 3, name: 'Bus' } } })
  useGlueCompStore.setState({ target: null })
  useOptoCompStore.setState({ target: null })
  useFetCompStore.setState({ target: null })
  HTMLCanvasElement.prototype.getContext = () => null
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

const realRaf = { raf: globalThis.requestAnimationFrame, caf: globalThis.cancelAnimationFrame }

afterEach(() => {
  act(() => root.unmount())
  vi.restoreAllMocks()
  window.requestAnimationFrame = realRaf.raf
  window.cancelAnimationFrame = realRaf.caf
  globalThis.requestAnimationFrame = realRaf.raf
  globalThis.cancelAnimationFrame = realRaf.caf
  container.remove()
  document.body.innerHTML = ''
  delete window.xleth
})

async function mountChain() {
  act(() => root.render(<DeviceChain />))
  await flush()
  await flush()
}

// Runs the meter poll loop by hand: rAF is a queue, performance.now jumps past the
// 33 ms gate, and each queued frame is flushed with the engine meter promise.
function installManualFrames() {
  const queue = []
  let now = 1000
  vi.spyOn(performance, 'now').mockImplementation(() => now)
  window.requestAnimationFrame = (cb) => { queue.push(cb); return queue.length }
  window.cancelAnimationFrame = () => {}
  globalThis.requestAnimationFrame = window.requestAnimationFrame
  globalThis.cancelAnimationFrame = window.cancelAnimationFrame
  return async () => {
    now += 100
    await act(async () => { queue.splice(0).forEach((cb) => cb(now)); await Promise.resolve() })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
  }
}
const grText = () => q('[role="group"][aria-label="Gain reduction"]').textContent

describe('the model configs mirror the engine layouts', () => {
  it.each(Object.keys(ENGINE))('%s: continuous params, steps and defaults', (id) => {
    const items = MODELS[id].sections.flatMap((s) => s.items)
    const byId = new Map(items.map((i) => [i.id, i]))
    for (const [pid, min, max, def] of ENGINE[id]) {
      const item = byId.get(pid)
      expect(item, pid).toBeTruthy()
      expect([item.min, item.max, item.def], pid).toEqual([min, max, def])
    }
    for (const [pid, [count, def]] of Object.entries(ENGINE_STEPPED[id])) {
      const item = byId.get(pid)
      expect(item, pid).toBeTruthy()
      expect(item.def, `${pid} default`).toBe(def)
      if (item.type === 'seg') expect(item.options.length, `${pid} steps`).toBe(count)
    }
    // Nothing the engine does not have.
    expect(items.length).toBe(ENGINE[id].length + Object.keys(ENGINE_STEPPED[id]).length)
  })
})

describe('Glue comp device in the chain', () => {
  const GLUE = {
    threshold: -22.5, makeup: 3, ratio: 2.0000001, attack: 1, release: 3, topology: 1, sc_hpf_on: 1, sc_hpf_freq: 200, color: 0,
  }

  it('hydrates from the engine (rounding index params); every value prints through formatValue', async () => {
    setup('glue', GLUE)
    await mountChain()
    expect(audio.getEffectParameters).toHaveBeenCalledWith(3, 7)
    expect(aria('Threshold')).toBe('Threshold, −22.5 dB')
    expect(aria('Makeup')).toBe('Makeup, +3.0 dB')
    expect(aria('Freq')).toBe('Freq, 200 Hz')
    expect(texts('Ratio')).toEqual(['2', '4', '10'])
    expect(checked('Ratio')).toBe(2)
    expect(texts('Attack')).toEqual(['0.1', '0.3', '1', '3', '10', '30'])
    expect(checked('Attack')).toBe(1)
    expect(texts('Release')).toEqual(['0.1', '0.3', '0.6', '1.2', 'Auto'])
    expect(checked('Release')).toBe(3)
    expect(texts('Topology')).toEqual(['Classic', 'FF'])
    expect(checked('Topology')).toBe(1)
    const color = Array.from(container.querySelectorAll('button[aria-pressed]')).find((b) => b.textContent === 'Color')
    const hpf = Array.from(container.querySelectorAll('button[aria-pressed]')).find((b) => b.textContent === 'High-pass')
    expect(color.getAttribute('aria-pressed')).toBe('false')
    expect(hpf.getAttribute('aria-pressed')).toBe('true')
  })

  it('sections run in signal order after the gain-reduction well', async () => {
    setup('glue', GLUE)
    await mountChain()
    const titles = Array.from(container.querySelectorAll('[role="heading"][aria-level="3"]')).map((h) => h.textContent)
    const order = ['Input', 'Character', 'Time', 'Sidechain', 'Output'].map((t) => titles.indexOf(t))
    expect(order.every((i) => i >= 0)).toBe(true)
    expect([...order].sort((a, b) => a - b)).toEqual(order)
    expect(q('[role="group"][aria-label="Gain reduction"]')).not.toBeNull()
    expect(q('[aria-label="Gain reduction meter"]')).not.toBeNull()
    expect(q('[aria-label="Gain reduction"] canvas, [aria-label="Gain reduction meter"]')).not.toBeNull()
  })

  it('stepped switches and toggles commit engine indices, one write each', async () => {
    setup('glue', GLUE)
    await mountChain()
    act(() => radios('Ratio')[0].click())
    act(() => radios('Attack')[0].click())
    act(() => radios('Release')[4].click())
    act(() => radios('Topology')[0].click())
    act(() => Array.from(container.querySelectorAll('button[aria-pressed]')).find((b) => b.textContent === 'Color').click())
    expect(sent('ratio')).toEqual([[3, 7, 'ratio', 0]])
    expect(sent('attack')).toEqual([[3, 7, 'attack', 0]])
    expect(sent('release')).toEqual([[3, 7, 'release', 4]])
    expect(sent('topology')).toEqual([[3, 7, 'topology', 0]])
    expect(sent('color')).toEqual([[3, 7, 'color', 1]])
    expect(checked('Ratio')).toBe(0)
  })

  it('a threshold nudge writes the engine; knobs opt into automation', async () => {
    setup('glue', GLUE)
    await mountChain()
    act(() => { q('[role="slider"][aria-label="Threshold"]').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true })) })
    const calls = sent('threshold')
    expect(calls.length).toBeGreaterThan(0)
    expect(calls[calls.length - 1].slice(0, 2)).toEqual([3, 7])
    expect(calls[calls.length - 1][3]).toBeGreaterThan(-22.5)
    for (const id of ['threshold', 'makeup', 'sc_hpf_freq']) {
      expect(q(`[data-automation-param="${id}"]`), id).not.toBeNull()
    }
  })

  it('shows the gain reduction as a meter with a numeric dB readout', async () => {
    setup('glue', GLUE)
    await mountChain()
    // A readout in dB (0.0 until the first poll lands, then the slot's reduction).
    expect(q('[data-hint^="Gain reduction, dB"]').textContent).toMatch(/[−0-9.]+ dB/)
  })

  it('pop-out opens the floating window and the docked slot becomes a strip', async () => {
    setup('glue', GLUE)
    act(() => root.render(<><DeviceChain /><GlueCompPanel /></>))
    await flush()
    await flush()
    act(() => q('button[aria-label="Open Glue comp in a window"]').click())
    await flush()
    expect(useGlueCompStore.getState().target).toEqual({ trackId: 3, nodeId: 7, storeKey: '3' })
    expect(q('[data-testid="glue-window"] section').getAttribute('data-presentation')).toBe('floating')
    act(() => q('button[aria-label="Close Glue comp"]').click())
    expect(useGlueCompStore.getState().target).toBeNull()
  })

  it('no longer carries the legacy panel or its CSS', () => {
    const src = readFileSync(path.resolve(__dirname, '../../mixer/GlueCompPanel.jsx'), 'utf8')
    expect(src).not.toMatch(/PluginUIKitKnob|gluecomp-/)
    const css = readFileSync(path.resolve(__dirname, '../../../styles/app.css'), 'utf8')
    expect(css).not.toMatch(/\.gluecomp-/)
  })
})

describe('Opto comp device in the chain', () => {
  const OPTO = { peak_reduction: 12, gain: 5.5, mode: 0.9999999 }

  it('hydrates from the engine, rounding the mode; no Time section (the cell sets attack and release)', async () => {
    setup('opto', OPTO)
    await mountChain()
    expect(aria('Peak reduction')).toBe('Peak reduction, 12.0 dB')
    expect(aria('Gain')).toBe('Gain, 5.5 dB')
    expect(texts('Mode')).toEqual(['Compress', 'Limit'])
    expect(checked('Mode')).toBe(1)
    const titles = Array.from(container.querySelectorAll('[role="heading"][aria-level="3"]')).map((h) => h.textContent)
    expect(titles).toEqual(['Input', 'Character', 'Output'])
  })

  it('the Compress / Limit switch commits the engine index; knobs opt into automation', async () => {
    setup('opto', OPTO)
    await mountChain()
    act(() => radios('Mode')[0].click())
    expect(sent('mode')).toEqual([[3, 7, 'mode', 0]])
    expect(checked('Mode')).toBe(0)
    for (const id of ['peak_reduction', 'gain']) expect(q(`[data-automation-param="${id}"]`), id).not.toBeNull()
    expect(q('[data-param="mode"]')).not.toBeNull()
    expect(q('[data-automation-param="mode"]')).toBeNull()
  })

  it('the gain-reduction readout follows meter slot 2', async () => {
    setup('opto', OPTO)
    const frame = installManualFrames()
    await mountChain()
    await frame()
    await frame()
    expect(grText()).toMatch(/−3\.0 dB/)
  })

  it('pop-out opens the floating window; the legacy panel and CSS are gone', async () => {
    setup('opto', OPTO)
    act(() => root.render(<><DeviceChain /><OptoCompPanel /></>))
    await flush()
    await flush()
    act(() => q('button[aria-label="Open Opto comp in a window"]').click())
    await flush()
    expect(useOptoCompStore.getState().target).toEqual({ trackId: 3, nodeId: 7, storeKey: '3' })
    expect(q('[data-testid="opto-window"] section').getAttribute('data-presentation')).toBe('floating')
    act(() => q('button[aria-label="Close Opto comp"]').click())
    expect(useOptoCompStore.getState().target).toBeNull()
    expect(readFileSync(path.resolve(__dirname, '../../mixer/OptoCompPanel.jsx'), 'utf8')).not.toMatch(/PluginUIKitKnob|optocomp-/)
    expect(readFileSync(path.resolve(__dirname, '../../../styles/app.css'), 'utf8')).not.toMatch(/\.optocomp-/)
  })
})

describe('FET comp device in the chain', () => {
  const FET = { input: 21, output: -6.5, attack: 6.2, release: 2, ratio: 3.9999999 }

  it('hydrates from the engine, rounding the ratio; there is no threshold', async () => {
    setup('fet', FET)
    await mountChain()
    expect(aria('Input')).toBe('Input, +21.0 dB')
    expect(aria('Output')).toBe('Output, −6.5 dB')
    expect(aria('Attack')).toBe('Attack, 6.2')
    expect(aria('Release')).toBe('Release, 2.0')
    expect(texts('Ratio')).toEqual(['4', '8', '12', '20', 'All'])
    expect(checked('Ratio')).toBe(4)
    expect(aria('Threshold')).toBeUndefined()
    const titles = Array.from(container.querySelectorAll('[role="heading"][aria-level="3"]')).map((h) => h.textContent)
    expect(titles).toEqual(['Input', 'Character', 'Time', 'Output'])
  })

  it('attack and release keep the hardware numbering (7 is fastest) and print the time they mean', async () => {
    expect(fetAttackSeconds(7)).toBeCloseTo(20e-6, 12)
    expect(fetAttackSeconds(1)).toBeCloseTo(800e-6, 12)
    expect(fetReleaseSeconds(7)).toBeCloseTo(0.05, 12)
    expect(fetReleaseSeconds(1)).toBeCloseTo(1.1, 12)
    expect(fetAttackSeconds(5)).toBeLessThan(fetAttackSeconds(4))
    expect(fetReleaseSeconds(5)).toBeLessThan(fetReleaseSeconds(4))
    expect(formatDuration(fetAttackSeconds(7) * 1000)).toBe('20 µs')
    expect(formatDuration(fetAttackSeconds(1) * 1000)).toBe('0.8 ms')
    expect(formatDuration(fetReleaseSeconds(7) * 1000)).toBe('50.0 ms')
    expect(formatDuration(fetReleaseSeconds(1) * 1000)).toBe('1.1 s')
    setup('fet', { ...FET, attack: 7, release: 1 })
    await mountChain()
    expect(container.textContent).toContain('20 µs')
    expect(container.textContent).toContain('1.1 s')
  })

  it('the ratio buttons commit the engine index; All is index 4 and is not automatable', async () => {
    setup('fet', { ...FET, ratio: 0 })
    await mountChain()
    expect(checked('Ratio')).toBe(0)
    act(() => radios('Ratio')[3].click())
    expect(sent('ratio')).toEqual([[3, 7, 'ratio', 3]])
    act(() => radios('Ratio')[4].click())
    expect(sent('ratio').at(-1)).toEqual([3, 7, 'ratio', 4])
    expect(radios('Ratio').filter((b) => b.getAttribute('aria-checked') === 'true').map((b) => b.textContent)).toEqual(['All'])
    expect(q('[data-automation-param="ratio"]')).toBeNull()
    for (const id of ['input', 'output', 'attack', 'release']) expect(q(`[data-automation-param="${id}"]`), id).not.toBeNull()
  })

  it('the gain-reduction readout follows meter slot 2', async () => {
    setup('fet', FET)
    const frame = installManualFrames()
    await mountChain()
    await frame()
    await frame()
    expect(grText()).toMatch(/−3\.0 dB/)
  })

  it('pop-out opens the floating window; the legacy panel and CSS are gone', async () => {
    setup('fet', FET)
    act(() => root.render(<><DeviceChain /><FetCompPanel /></>))
    await flush()
    await flush()
    act(() => q('button[aria-label="Open FET comp in a window"]').click())
    await flush()
    expect(useFetCompStore.getState().target).toEqual({ trackId: 3, nodeId: 7, storeKey: '3' })
    expect(q('[data-testid="fet-window"] section').getAttribute('data-presentation')).toBe('floating')
    act(() => q('button[aria-label="Close FET comp"]').click())
    expect(useFetCompStore.getState().target).toBeNull()
    expect(readFileSync(path.resolve(__dirname, '../../mixer/FetCompPanel.jsx'), 'utf8')).not.toMatch(/PluginUIKitKnob|fetcomp-/)
    expect(readFileSync(path.resolve(__dirname, '../../../styles/app.css'), 'utf8')).not.toMatch(/\.fetcomp-/)
  })
})
