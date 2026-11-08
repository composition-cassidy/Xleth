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
import useApexStore from '../../../stores/apexStore.js'
import ApexPanel from '../../mixer/ApexPanel.jsx'
import GlossPanel from '../../mixer/GlossPanel.jsx'
import DeviceChain from '../DeviceChain.jsx'
import { bandToken } from '../bandPalette.js'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

let container
let root
let audio
let chain
let engineParams

const PARAMS = {
  lowcut: 0, split_lo: 250, split_hi: 4000, slope_lo: 1, slope_hi: 0, lookahead: 3, bandmix: 80,
  lo_pre: 2.5, lo_post: -1, lo_att: 5, lo_rel: 100, lo_sus: 0, lo_satth: 20, lo_satcl: -6, lo_sep: 0,
  lo_state: 0, lo_det: 1, lo_solo: 0,
  md_pre: 0, md_state: 2, md_det: 0, md_solo: 0,
  hi_pre: -4, hi_state: 0, hi_det: 0, hi_solo: 0,
  ms_pre: 1, ms_state: 0, ms_det: 0,
}
const LOW_CURVE = { band: 0, nodes: [{ in: -96, out: -96 }, { in: -12, out: -12 }, { in: 12, out: -3 }], tensions: [0, 0.5] }

const flush = async () => { await act(async () => { await new Promise((r) => setTimeout(r, 0)) }) }
const q = (sel) => container.querySelector(sel)
const qa = (sel) => Array.from(container.querySelectorAll(sel))
const aria = (label, scope = container) => scope.querySelector(`[role="slider"][aria-label="${label}"]`)?.getAttribute('aria-valuetext')
const group = (label, scope = container) => scope.querySelector(`[role="radiogroup"][aria-label="${label}"]`)
const radios = (label, scope) => Array.from(group(label, scope)?.querySelectorAll('[role="radio"]') ?? [])
const checked = (label, scope) => radios(label, scope).findIndex((b) => b.getAttribute('aria-checked') === 'true')
const sent = (id) => audio.setEffectParameter.mock.calls.filter((c) => c[2] === id)
const titles = () => qa('[role="heading"][aria-level="3"]').map((h) => h.textContent)
const button = (label) => q(`button[aria-label="${label}"]`)

function setup(nodes = [7]) {
  chain = nodes.map((nodeId, position) => ({ nodeId, pluginId: 'apex', position, bypassed: false }))
  engineParams = JSON.stringify(Object.entries(PARAMS).map(([id, value]) => ({ id, value })))
  audio.getEffectChain = vi.fn(async () => JSON.stringify(chain))
}

beforeEach(() => {
  audio = {
    getEffectChain: vi.fn(async () => '[]'),
    getEffectParameters: vi.fn(async () => engineParams),
    setEffectParameter: vi.fn(),
    apexGetCurves: vi.fn(async () => JSON.stringify({ bands: [LOW_CURVE] })),
    apexSetBandCurve: vi.fn(),
    getEffectLatency: vi.fn(async () => JSON.stringify({ ok: true, latencyMs: 4.2, latencySamples: 202 })),
    getEffectMeter: vi.fn(async () => []),
    setEffectBypass: vi.fn(async () => true),
  }
  window.xleth = { audio, timeline: { getTracks: async () => [] } }
  useEffectChainStore.setState({ chains: {}, fxModes: {} })
  useMixerStore.setState({ selectedChainKey: '3', tracks: { 3: { id: 3, name: 'Bus' } } })
  useApexStore.setState({ target: null })
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

async function mountChain(extra = null) {
  act(() => root.render(<><DeviceChain />{extra}</>))
  await flush()
  await flush()
}

describe('APEX device in the chain', () => {
  it('hydrates params, curves and latency from the engine; every value prints through formatValue', async () => {
    setup()
    await mountChain()
    expect(audio.getEffectParameters).toHaveBeenCalledWith(3, 7)
    expect(audio.apexGetCurves).toHaveBeenCalledWith(3, 7)
    expect(aria('Pre gain')).toBe('Pre gain, +2.5 dB')
    expect(aria('Post gain')).toBe('Post gain, −1.0 dB')
    expect(aria('Sat thresh')).toBe('Sat thresh, +20 %')
    expect(aria('Low cut')).toBe('Low cut, Off')
    expect(aria('Low split')).toBe('Low split, 250 Hz')
    expect(aria('High split')).toBe('High split, 4.00 kHz')
    expect(aria('Band mix')).toBe('Band mix, 80 %')
    expect(checked('Low split slope')).toBe(1)
    expect(checked('High split slope')).toBe(0)
    expect(checked('Low detection')).toBe(1)
    expect(q('[data-hint^="Reported latency"]').textContent).toBe('4.2 ms latency')
  })

  it('the hero hosts the curve editor and the analysis in one well; sections run in signal order', async () => {
    setup()
    await mountChain()
    const well = q('[role="group"][aria-label="APEX display"]')
    expect(well.querySelectorAll('canvas')).toHaveLength(2)
    expect(titles()).toEqual(['Input', 'Crossover', 'Band', 'Low band', 'Mix'])
  })

  it('the band selector swaps one fixed block of knobs; the device never grows', async () => {
    setup()
    await mountChain()
    const knobCount = qa('[role="slider"]').length
    act(() => radios('Band')[2].click())
    expect(titles()).toContain('High band')
    expect(aria('Pre gain')).toBe('Pre gain, −4.0 dB')
    expect(qa('[role="slider"]').length).toBe(knobCount)
    expect(q('[data-param="hi_pre"]')).not.toBeNull()
    act(() => radios('Band')[3].click())
    expect(titles()).toContain('Master band')
    expect(aria('Pre gain')).toBe('Pre gain, +1.0 dB')
    const solo = qa('button[aria-pressed]').find((b) => b.textContent === 'Solo')
    expect(solo.disabled).toBe(true)
  })

  it('switches commit one engine write each; Solo is exclusive through the store', async () => {
    setup()
    await mountChain()
    act(() => radios('Low state')[2].click())
    act(() => radios('Low detection')[0].click())
    act(() => radios('Low split slope')[0].click())
    expect(sent('lo_state')).toEqual([[3, 7, 'lo_state', 2]])
    expect(sent('lo_det')).toEqual([[3, 7, 'lo_det', 0]])
    expect(sent('slope_lo')).toEqual([[3, 7, 'slope_lo', 0]])
    act(() => qa('button[aria-pressed]').find((b) => b.textContent === 'Solo').click())
    expect(sent('lo_solo')).toEqual([[3, 7, 'lo_solo', 1]])
    expect(sent('md_solo')).toEqual([])
  })

  it('a knob nudge commits through the store; the knobs opt into automation', async () => {
    setup()
    await mountChain()
    act(() => { q('[role="slider"][aria-label="Pre gain"]').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true })) })
    const calls = sent('lo_pre')
    expect(calls.length).toBe(1)
    expect(calls[0][3]).toBeGreaterThan(2.5)
    for (const id of ['lo_pre', 'lo_satcl', 'split_lo', 'lookahead', 'bandmix', 'lowcut']) {
      expect(q(`[data-automation-param="${id}"]`), id).not.toBeNull()
    }
  })

  it('band colours come from the band palette: Low, Mid, High take slots 1, 2, 4; a muted band\'s swatch is hollow', async () => {
    setup()
    await mountChain()
    expect([0, 1, 2].map((i) => bandToken(i))).toEqual(['--ui-band-1', '--ui-band-2', '--ui-band-4'])
    expect(q('[data-param="lo_pre"]').closest('[data-band]').getAttribute('data-band')).toBe('0')
    const swatches = radios('Band').map((r) => r.querySelector('[data-band]'))
    expect(swatches.map((s) => s.hasAttribute('data-silenced'))).toEqual([false, true, false, false])
  })

  it('curve reset, undo and redo go through apexSetBandCurve; Ctrl+Z works inside the device', async () => {
    setup()
    await mountChain()
    expect(button('Undo curve edit').disabled).toBe(true)
    act(() => button('Reset low curve').click())
    expect(audio.apexSetBandCurve).toHaveBeenCalledTimes(1)
    expect(audio.apexSetBandCurve.mock.calls[0].slice(0, 3)).toEqual([3, 7, 0])
    expect(JSON.parse(audio.apexSetBandCurve.mock.calls[0][3]).nodes).toHaveLength(2)
    expect(button('Undo curve edit').disabled).toBe(false)

    const outer = vi.fn()
    document.addEventListener('keydown', outer)
    act(() => { button('Undo curve edit').dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true })) })
    document.removeEventListener('keydown', outer)
    expect(outer).not.toHaveBeenCalled()
    expect(audio.apexSetBandCurve).toHaveBeenCalledTimes(2)
    expect(JSON.parse(audio.apexSetBandCurve.mock.calls[1][3]).nodes).toHaveLength(3)
    act(() => button('Redo curve edit').click())
    expect(audio.apexSetBandCurve).toHaveBeenCalledTimes(3)
  })

  it('two APEX devices keep their own band selection (one private store each)', async () => {
    setup([7, 8])
    await mountChain()
    const devices = qa('[data-device-plugin="apex"]')
    expect(devices).toHaveLength(2)
    act(() => radios('Band', devices[0])[2].click())
    expect(checked('Band', devices[0])).toBe(2)
    expect(checked('Band', devices[1])).toBe(0)
  })

  it('pop-out opens the same device through the global APEX store; GLOSS never paints it', async () => {
    setup()
    await mountChain(<><ApexPanel /><GlossPanel /></>)
    expect(q('[data-testid="apex-window"]')).toBeNull()
    act(() => button('Open APEX in a window').click())
    await flush()
    expect(useApexStore.getState().target).toEqual({ trackId: 3, nodeId: 7, storeKey: '3', skin: 'apex' })
    expect(q('[data-testid="apex-window"] section').getAttribute('data-presentation')).toBe('floating')
    expect(q('[data-testid="gloss-window"]')).toBeNull()
    act(() => button('Close APEX').click())
    expect(useApexStore.getState().target).toBeNull()
    act(() => { useApexStore.setState({ target: { trackId: 3, nodeId: 7, storeKey: '3', skin: 'gloss' } }) })
    await flush()
    expect(q('[data-testid="apex-window"]')).toBeNull()
  })

  it('the legacy editor, its band colours and its CSS are gone', () => {
    const src = readFileSync(path.resolve(__dirname, '../../mixer/ApexPanel.jsx'), 'utf8')
    expect(src).not.toMatch(/PluginUIKitKnob|EffectPresetBar|className="apex-/)
    expect(existsSync(path.resolve(__dirname, '../../mixer/apexBandColors.js'))).toBe(false)
    const css = readFileSync(path.resolve(__dirname, '../../../styles/app.css'), 'utf8')
    expect(css).not.toMatch(/\.apex-/)
  })
})
