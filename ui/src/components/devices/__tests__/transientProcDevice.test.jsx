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
import useTransientProcStore from '../../../stores/transientProcStore.js'
import TransientProcPanel from '../../mixer/TransientProcPanel.jsx'
import DeviceChain from '../DeviceChain.jsx'
import { drawTransientEnvelope } from '../../../plugin-ui/runtime/visualizers/transientPainter.js'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

// engine XlethTransientProcEffect::createLayout(): [id, label, min, max]
const ENGINE = [
  ['attack', 'Attack', -100, 100], ['sustain', 'Sustain', -100, 100], ['attack_speed', 'Speed', 0.5, 20],
  ['threshold', 'Threshold', -60, 0], ['mix', 'Mix', 0, 100],
]

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

function setup(params) {
  engineParams = JSON.stringify(Object.entries(params).map(([id, value]) => ({ id, value })))
}

beforeEach(() => {
  setup({ attack: 40, sustain: -25, attack_speed: 8, threshold: -30, mix: 90, midi_detect: 0 })
  audio = {
    getEffectChain: vi.fn(async () => JSON.stringify([{ nodeId: 7, pluginId: 'transientproc', position: 0, bypassed: false }])),
    getEffectParameters: vi.fn(async () => engineParams),
    setEffectParameter: vi.fn(),
    getEffectMeter: vi.fn(async () => []),
    setEffectBypass: vi.fn(async () => true),
  }
  window.xleth = { audio, timeline: { getTracks: async () => [] } }
  useEffectChainStore.setState({ chains: {}, fxModes: {} })
  useMixerStore.setState({ selectedChainKey: '3', tracks: { 3: { id: 3, name: 'Bus' } } })
  useTransientProcStore.setState({ target: null })
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

describe('Transient processor device in the chain', () => {
  it('mirrors the engine ranges and hydrates; values print through formatValue', async () => {
    await mount()
    for (const [id, label, min, max] of ENGINE) {
      const el = slider(label)
      expect(el, id).not.toBeNull()
      expect([Number(el.getAttribute('aria-valuemin')), Number(el.getAttribute('aria-valuemax'))], id).toEqual([min, max])
    }
    expect(aria('Attack')).toBe('Attack, +40 %')
    expect(aria('Sustain')).toBe('Sustain, −25 %')
    expect(aria('Speed')).toBe('Speed, 8.0 ms')
    expect(aria('Threshold')).toBe('Threshold, −30.0 dB')
    expect(radios('Detection mode').map((r) => r.getAttribute('aria-checked'))).toEqual(['true', 'false'])
  })

  it('the transient display is the hero (input against output by default); sections run in signal order', async () => {
    await mount()
    expect(q('[role="group"][aria-label="Transient display"] canvas')).not.toBeNull()
    expect(radios('Transient display view').map((r) => r.textContent)).toEqual(['Envelope', 'Gain'])
    expect(titles()).toEqual(['Detection', 'Shape', 'Output'])
  })

  it('the mode switch is one commit; MIDI mode disables Threshold and Sustain', async () => {
    await mount()
    act(() => radios('Detection mode')[1].click())
    expect(sent('midi_detect')).toEqual([[3, 7, 'midi_detect', 1]])
    expect(slider('Threshold').getAttribute('aria-disabled')).toBe('true')
    expect(slider('Sustain').getAttribute('aria-disabled')).toBe('true')
    expect(slider('Attack').getAttribute('aria-disabled')).not.toBe('true')
  })

  it('a knob nudge commits one write; knobs opt into automation', async () => {
    await mount()
    act(() => { slider('Attack').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true })) })
    expect(sent('attack')).toHaveLength(1)
    for (const [id] of ENGINE) expect(q(`[data-automation-param="${id}"]`), id).not.toBeNull()
  })

  it('with no signal the display says so instead of standing empty', () => {
    const texts = []
    const ctx = new Proxy({ fillText: (t) => texts.push(t), measureText: () => ({ width: 10 }) }, {
      get: (o, k) => (k in o ? o[k] : () => {}),
      set: () => true,
    })
    drawTransientEnvelope(ctx, 300, 200, null, {})
    expect(texts).toContain('Play to see transients')
  })

  it('pop-out opens the same device in a window; the legacy panel and its CSS are gone', async () => {
    await mount(<TransientProcPanel />)
    act(() => q('button[aria-label="Open Transient processor in a window"]').click())
    await flush()
    expect(useTransientProcStore.getState().target).toEqual({ trackId: 3, nodeId: 7, storeKey: '3' })
    expect(q('[data-testid="transientproc-window"] section').getAttribute('data-presentation')).toBe('floating')
    const src = readFileSync(path.resolve(__dirname, '../../mixer/TransientProcPanel.jsx'), 'utf8')
    expect(src).not.toMatch(/StockPluginRuntimeRenderer|PluginUIDesigner|transientproc-panel/)
    expect(readFileSync(path.resolve(__dirname, '../../../styles/app.css'), 'utf8')).not.toMatch(/\.transientproc-/)
  })
})
