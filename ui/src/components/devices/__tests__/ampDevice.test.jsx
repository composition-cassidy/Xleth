/**
 * @vitest-environment jsdom
 *
 * Amp Stack device contract tests (ported from the old AmpPanel test).
 *
 *  1. The parameter surface IS spec 7: the exact APVTS ids XlethAmpEffect::createLayout()
 *     declares, with the ranges and defaults the engine reports (bridge/test_amp_bridge.js
 *     asserts the same table from the engine side).
 *  2. The drag discipline: a knob drag previews locally, coalesces the engine write to one
 *     per frame, and the release is a single authoritative write. A choice (Model, Cab) is
 *     one click and one write, so switching the model while playing is one write.
 *  3. Automation: every continuous knob opts in with paramId + target; Model and Cab are
 *     not knobs at all, so they are structurally excluded.
 *  4. One look: no skins, no skin chip, no screws, no VU needle, no amp CSS.
 */
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import useEffectChainStore from '../../../stores/effectChainStore.js'
import useAmpStore from '../../../stores/ampStore.js'
import useMixerStore from '../../../stores/mixerStore.js'
import AmpPanel from '../../mixer/AmpPanel.jsx'
import DeviceChain from '../DeviceChain.jsx'
import { deviceBodyFor } from '../deviceRegistry.js'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

// Spec 7, mirrored from XlethAmpEffect::createLayout(). [id, min, max, default]
const SPEC_PARAMS = [
  ['drive', 0, 10, 5], ['bass', 0, 10, 5], ['mid', 0, 10, 5], ['treble', 0, 10, 5],
  ['sag', 0, 10, 5], ['tighten', 0, 10, 5], ['gate', 0, 10, 0], ['presence', 0, 10, 5],
  ['mix', 0, 100, 100], ['output', -24, 12, 0],
]
const CHAIN = [{ nodeId: 7, pluginId: 'amp', position: 0, bypassed: false }]
const params = (over = {}) => JSON.stringify(Object.entries({
  model: 4, cab: 3, drive: 8.5, bass: 3.25, mid: 7.5, treble: 2, sag: 9, tighten: 1.5,
  gate: 4, presence: 6.5, mix: 62, output: -7.5, ...over,
}).map(([id, value]) => ({ id, value })))

let container
let root
let audio
let engineParams

const flush = async () => { await act(async () => { await new Promise((r) => setTimeout(r, 0)) }) }
const q = (sel) => container.querySelector(sel)
const slider = (label) => q(`[role="slider"][aria-label="${label}"]`)
const aria = (label) => slider(label)?.getAttribute('aria-valuetext')
const sent = (id) => audio.setEffectParameter.mock.calls.filter((c) => c[2] === id)
const titles = () => Array.from(container.querySelectorAll('[role="heading"][aria-level="3"]')).map((h) => h.textContent)
const modelSelect = () => q('button[aria-haspopup="listbox"][aria-label="Amp model"]')

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
  useAmpStore.setState({ target: null })
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

async function mountChain() {
  act(() => root.render(<DeviceChain />))
  await flush()
  await flush()
}

describe('Amp Stack device in the chain', () => {
  it('is registered', () => {
    expect(deviceBodyFor('amp')).not.toBeNull()
  })

  it('exposes exactly the spec 7 parameter surface: ten knobs, a model switch and a cab select', async () => {
    await mountChain()
    const sliders = Array.from(container.querySelectorAll('[role="slider"][data-param]'))
    expect(sliders.map((s) => s.getAttribute('data-param')).sort()).toEqual(SPEC_PARAMS.map(([id]) => id).sort())
    for (const [id, min, max] of SPEC_PARAMS) {
      const s = q(`[role="slider"][data-param="${id}"]`)
      expect(Number(s.getAttribute('aria-valuemin')), `"${id}".min`).toBe(min)
      expect(Number(s.getAttribute('aria-valuemax')), `"${id}".max`).toBe(max)
    }
    act(() => modelSelect().click())
    expect(document.querySelectorAll('[role="option"]').length).toBe(6)
    act(() => modelSelect().click())
    expect(q('[aria-label="Cabinet"]')).not.toBeNull()
  })

  it('knob defaults are the engine defaults (Ctrl+click resets to them)', async () => {
    await mountChain()
    for (const [id, , , def] of SPEC_PARAMS) {
      audio.setEffectParameter.mockClear()
      const s = q(`[role="slider"][data-param="${id}"]`)
      act(() => { s.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, ctrlKey: true, button: 0 })) })
      const writes = sent(id)
      expect(writes.length, `"${id}" reset wrote`).toBe(1)
      expect(writes[0][3], `"${id}" reset value`).toBe(def)
    }
  })

  it('hydrates every control from the engine; every value prints through formatValue', async () => {
    await mountChain()
    expect(audio.getEffectParameters).toHaveBeenCalledWith(3, 7)
    expect(aria('Drive')).toBe('Drive, 8.5')
    expect(aria('Bass')).toBe('Bass, 3.3')
    expect(aria('Gate')).toBe('Gate, 4.0')
    expect(aria('Mix')).toBe('Mix, 62 %')
    expect(aria('Output')).toBe('Output, −7.5 dB')
    // Model 4 = Rectifier, Cab 3 = Greenback 4x12.
    expect(modelSelect().textContent).toBe('Rectifier')
    expect(q('[aria-label="Cabinet"]').textContent).toContain('Greenback 4x12')
  })

  it('sections run in signal order: Input, Tone, Power, Cabinet, Output', async () => {
    await mountChain()
    const t = titles()
    const order = ['Input', 'Tone', 'Power', 'Cabinet', 'Output'].map((n) => t.indexOf(n))
    expect(order.every((i) => i >= 0)).toBe(true)
    expect([...order].sort((a, b) => a - b)).toEqual(order)
  })

  it('a knob drag previews at most once per frame and commits once on release', async () => {
    const queue = []
    globalThis.requestAnimationFrame = (cb) => { queue.push(cb); return queue.length }
    globalThis.cancelAnimationFrame = () => {}
    const runFrame = async () => {
      // The kit coalesces onChange to one per frame, the device hook coalesces the write.
      for (let pass = 0; pass < 2; pass += 1) {
        const pending = queue.splice(0, queue.length)
        await act(async () => { pending.forEach((cb) => cb(0)) })
      }
    }
    await mountChain()
    audio.setEffectParameter.mockClear()
    const drive = slider('Drive')
    const at = (type, y) => drive.dispatchEvent(new MouseEvent(type, { bubbles: true, button: 0, clientY: y }))

    act(() => at('pointerdown', 200))
    for (const y of [190, 180, 170, 160, 150, 140, 130, 120]) act(() => at('pointermove', y))
    expect(audio.setEffectParameter).not.toHaveBeenCalled() // nothing before the frame runs

    await runFrame()
    expect(sent('drive').length).toBe(1) // one write for eight moves
    const live = sent('drive')[0][3]
    expect(live).toBeGreaterThan(8.5)

    audio.setEffectParameter.mockClear()
    act(() => drive.dispatchEvent(new MouseEvent('pointerup', { bubbles: true, button: 0, clientY: 120 })))
    await runFrame()
    expect(sent('drive').length).toBe(1) // exactly one authoritative write on release
    expect(sent('drive')[0][3]).toBeCloseTo(live, 5)
  })

  it('switching the model is one click and one write; so is the cab', async () => {
    await mountChain()
    audio.setEffectParameter.mockClear()
    act(() => modelSelect().click())
    act(() => Array.from(document.querySelectorAll('[role="option"]')).find((o) => o.textContent.trim() === 'Tweed').click())
    expect(audio.setEffectParameter).toHaveBeenCalledTimes(1)
    expect(audio.setEffectParameter).toHaveBeenCalledWith(3, 7, 'model', 1)

    audio.setEffectParameter.mockClear()
    act(() => q('[aria-label="Cabinet"]').click())
    const options = Array.from(document.querySelectorAll('[role="option"]'))
    expect(options.map((o) => o.textContent)).toEqual(['Auto', 'Open-back 1x12', 'Alnico 2x12', 'Greenback 4x12', 'V30 4x12'])
    act(() => options[2].click())
    expect(audio.setEffectParameter).toHaveBeenCalledTimes(1)
    expect(audio.setEffectParameter).toHaveBeenCalledWith(3, 7, 'cab', 2)
  })

  it('every knob, and the Model and Cab dropdowns, is automatable', async () => {
    await mountChain()
    const automatable = Array.from(container.querySelectorAll('[data-automation-param]')).map((e) => e.getAttribute('data-automation-param'))
    expect(automatable.sort()).toEqual([...SPEC_PARAMS.map(([id]) => id), 'model', 'cab'].sort())
    expect(slider('Model')).toBeNull()
    expect(slider('Cab')).toBeNull()
  })

  it('has an output peak meter with a numeric readout and no display well', async () => {
    await mountChain()
    expect(q('[aria-label="Amp output peak meter"]')).not.toBeNull()
    expect(container.textContent).toContain('Peak')
    expect(q('[role="group"][aria-label$="display"]')).toBeNull()
  })

  it('has one look: no skin chip, screws, VU face or branding', async () => {
    await mountChain()
    expect(container.textContent).not.toMatch(/ANALOG|MODERN|TUBE VOICING|XLETH STOCK EFFECT|OUTPUT . VU/)
    expect(container.querySelector('[class*="screw"], [class*="skin"], [class*="vu-"]')).toBeNull()
  })

  it('pop-out opens the floating window and the docked slot becomes a strip', async () => {
    act(() => root.render(<><DeviceChain /><AmpPanel /></>))
    await flush()
    act(() => q('button[aria-label="Open Amp Stack in a window"]').click())
    await flush()
    expect(useAmpStore.getState().target).toEqual({ trackId: 3, nodeId: 7, storeKey: '3' })
    expect(q('[data-testid="amp-window"] section').getAttribute('data-presentation')).toBe('floating')
    act(() => q('button[aria-label="Close Amp Stack"]').click())
    expect(useAmpStore.getState().target).toBeNull()
  })
})

describe('Amp Stack: the two-skin panel is gone', () => {
  it('thin wrapper, no skin state in the store, no amp CSS', () => {
    const src = readFileSync(path.resolve(__dirname, '../../mixer/AmpPanel.jsx'), 'utf8')
    expect(src).not.toMatch(/skinOverride|amp-screw|surfaceIsDark|AMP_ANALOG|PluginUIKitKnob/)
    expect(useAmpStore.getState()).not.toHaveProperty('skinOverride')
    expect(useAmpStore.getState()).not.toHaveProperty('setSkinOverride')
    const css = readFileSync(path.resolve(__dirname, '../../../styles/app.css'), 'utf8')
    expect(css).not.toMatch(/\.amp-|--amp-/)
    expect(existsSync(path.resolve(__dirname, '../../mixer/__tests__/AmpPanel.test.jsx'))).toBe(false)
  })
})
