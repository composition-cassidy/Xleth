/**
 * @vitest-environment jsdom
 */
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import useEffectChainStore from '../../../stores/effectChainStore.js'
import useFeddaStore from '../../../stores/feddaStore.js'
import useMixerStore from '../../../stores/mixerStore.js'
import FeddaPanel from '../../mixer/FeddaPanel.jsx'
import DeviceChain from '../DeviceChain.jsx'
import { EFFECT_CATEGORIES } from '../../mixer/effectCatalog.js'
import { PLUGIN_NAMES } from '../../mixer/effectEditorOpeners.js'
import { STOCK_EFFECT_LABELS } from '../../../fxgraph/chainToGraphState.js'
import { getPresetAdapter } from '../../../fx-presets/effectPresetAdapters.js'
import { THIN_SPACE as T } from '../../../ui-kit'
import { fieldEllipse, targetCorrelationForWidth, targetEllipse } from '../feddaGeometry.js'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const CHAIN = [{ nodeId: 7, pluginId: 'fedda', position: 0, bypassed: false }]
const params = (over = {}) => JSON.stringify(Object.entries({
  width: 50, character: 1, size: 8, low_bypass: 150, low_slope: 0, hf_damp: 20000,
  guard: 0, variation: 417, loudness_match: 0, mono_check: 0, compare: 0, ...over,
}).map(([id, value]) => ({ id, value })))

let container
let root
let audio
let engineParams

const flush = async () => { await act(async () => { await new Promise((r) => setTimeout(r, 0)) }) }
const q = (sel) => container.querySelector(sel)
const slider = (label) => q(`[role="slider"][aria-label="${label}"]`)
const aria = (label) => slider(label)?.getAttribute('aria-valuetext')
const button = (text) => Array.from(container.querySelectorAll('button')).find((b) => b.textContent.trim() === text)
const writes = (id) => audio.setEffectParameter.mock.calls.filter((c) => c[2] === id)

beforeEach(() => {
  HTMLCanvasElement.prototype.getContext = () => null
  engineParams = params()
  audio = {
    getEffectChain: vi.fn(async () => JSON.stringify(CHAIN)),
    getEffectParameters: vi.fn(async () => engineParams),
    setEffectParameter: vi.fn(),
    getEffectMeter: vi.fn(async () => [0, -20, -23, 0, 0, 0.6, 0, 0]),
    setEffectBypass: vi.fn(async () => true),
  }
  window.xleth = { audio, timeline: { getTracks: async () => [] } }
  useEffectChainStore.setState({ chains: {}, fxModes: {} })
  useMixerStore.setState({ selectedChainKey: '3', tracks: { 3: { id: 3, name: 'Bus' } } })
  useFeddaStore.setState({ target: null })
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

const mount = async (node = <DeviceChain />) => {
  act(() => root.render(node))
  await flush()
  await flush()
}

describe('Fedda device in the chain', () => {
  it('hydrates from the engine and prints every value with its unit', async () => {
    engineParams = params({ width: 137, size: 12.5, low_bypass: 300 })
    await mount()
    expect(audio.getEffectParameters).toHaveBeenCalledWith(3, 7)
    expect(aria('Width')).toBe(`Width, 137${T}%`)
    expect(aria('Size')).toBe(`Size, 12.5${T}ms`)
    expect(aria('Low bypass')).toBe(`Low bypass, 300${T}Hz`)
  })

  it('width 100 reads as full stereo', async () => {
    engineParams = params({ width: 100 })
    await mount()
    expect(aria('Width')).toBe(`Width, 100${T}% full`)
  })

  it('knob ranges are the engine\'s', async () => {
    await mount()
    // Log-scale bounds come back through exp(log(x)), so compare as numbers.
    const range = (label) => [Number(slider(label).getAttribute('aria-valuemin')), Number(slider(label).getAttribute('aria-valuemax'))]
    const expectRange = (label, lo, hi) => {
      const [a, b] = range(label)
      expect(a).toBeCloseTo(lo, 6)
      expect(b).toBeCloseTo(hi, 6)
    }
    expectRange('Width', 0, 200)
    expectRange('Size', 0.5, 30)
    expectRange('Low bypass', 20, 2000)
  })

  it('sections run in signal order and Advanced starts folded', async () => {
    await mount()
    const titles = Array.from(container.querySelectorAll('[role="heading"][aria-level="3"]')).map((h) => h.textContent)
    const order = ['Decorrelator', 'Lows', 'Width', 'Advanced', 'Monitor'].map((t) => titles.indexOf(t))
    expect(order.every((i) => i >= 0)).toBe(true)
    expect([...order].sort((a, b) => a - b)).toEqual(order)
    expect(slider('HF damp')).toBeNull()
  })

  it('the character switch writes one value', async () => {
    await mount()
    const velvet = Array.from(container.querySelectorAll('[role="radio"]')).find((r) => r.textContent === 'Velvet')
    act(() => velvet.click())
    expect(writes('character').at(-1)[3]).toBe(2)
  })

  it('a width nudge writes the engine', async () => {
    await mount()
    act(() => { slider('Width').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true })) })
    expect(writes('width').length).toBeGreaterThan(0)
    expect(writes('width').at(-1)[3]).toBeGreaterThan(50)
  })

  it('Advanced unfolds to HF damp (Off at 20 kHz), Guard, the seed and Loudness match', async () => {
    await mount()
    act(() => q('button[aria-label="Show Advanced"]').click())
    await flush()
    expect(aria('HF damp')).toBe('HF damp, Off')
    expect(aria('Guard')).toBe(`Guard, 0${T}%`)
    expect(q('[aria-label="Variation"]')).not.toBeNull()
    act(() => button('New seed').click())
    const seed = writes('variation').at(-1)[3]
    expect(Number.isInteger(seed) && seed >= 0 && seed <= 999).toBe(true)
    act(() => button('Loudness match').click())
    expect(writes('loudness_match').at(-1)[3]).toBe(1)
  })

  it('the monitor switches write the engine and say they are not rendered', async () => {
    await mount()
    act(() => button('Mono').click())
    expect(writes('mono_check').at(-1)[3]).toBe(1)
    expect(button('Mono').getAttribute('aria-pressed')).toBe('true')
    act(() => button('Dry A/B').click())
    expect(writes('compare').at(-1)[3]).toBe(1)
    expect(container.textContent).toContain('Not rendered')
  })

  it('the display is the live field canvas', async () => {
    await mount()
    expect(q('canvas.fedda-field-canvas')).not.toBeNull()
  })

  it('pop-out opens the floating window and the docked slot becomes a strip', async () => {
    await mount(<><DeviceChain /><FeddaPanel /></>)
    act(() => q('button[aria-label="Open Fedda in a window"]').click())
    await flush()
    expect(useFeddaStore.getState().target).toEqual({ trackId: 3, nodeId: 7, storeKey: '3' })
    expect(q('[data-testid="fedda-window"] section').getAttribute('data-presentation')).toBe('floating')
    act(() => q('button[aria-label="Close Fedda"]').click())
    expect(useFeddaStore.getState().target).toBeNull()
  })
})

describe('Fedda registration', () => {
  it('is in the add menu, the chain names and the FX Graph labels', () => {
    const ids = EFFECT_CATEGORIES.flatMap((c) => c.submenu.map((e) => e.id))
    expect(ids).toContain('fedda')
    expect(PLUGIN_NAMES.fedda).toBe('Fedda')
    expect(STOCK_EFFECT_LABELS.fedda).toBe('Fedda')
  })
})

describe('Fedda presets', () => {
  it('never capture or apply the seed or the monitor switches', async () => {
    const adapter = getPresetAdapter('fedda')
    const state = await adapter.captureState({ trackId: 3, nodeId: 7 })
    expect(state.params.width).toBe(50)
    expect('variation' in state.params).toBe(false)
    expect('mono_check' in state.params).toBe(false)
    expect('compare' in state.params).toBe(false)

    await adapter.applyState({ trackId: 3, nodeId: 7 }, { params: { width: 120, variation: 5, mono_check: 1, compare: 1 } })
    const ids = audio.setEffectParameter.mock.calls.map((c) => c[2])
    expect(ids).toEqual(['width'])
  })
})

describe('Fedda display geometry', () => {
  it('target correlation follows (1 - g^2) / (1 + g^2)', () => {
    expect(targetCorrelationForWidth(0)).toBe(1)
    expect(targetCorrelationForWidth(100)).toBe(0)
    expect(targetCorrelationForWidth(200)).toBeCloseTo(-0.6, 6)
  })

  it('target shape: a line at mono, a circle at full, flat past the speakers', () => {
    expect(targetEllipse(1, 50)).toEqual({ rx: 0, ry: 50 })
    const full = targetEllipse(0, 50)
    expect(full.rx).toBeCloseTo(50, 6)
    expect(full.ry).toBeCloseTo(50, 6)
    const wide = targetEllipse(-0.6, 50)
    expect(wide.rx).toBe(50)
    expect(wide.ry).toBeCloseTo(25, 6)
  })

  it('measured field: mono is vertical, equal mid and side is a circle, L-only leans up-left', () => {
    const mono = fieldEllipse(-20, -140, 0, 50)
    expect(mono.rx).toBeCloseTo(50, 6)
    expect(mono.ry).toBeCloseTo(0, 3)
    expect(Math.abs(Math.abs(mono.rotation) - Math.PI / 2)).toBeLessThan(1e-6)
    const circle = fieldEllipse(-20, -20, 0, 50)
    expect(circle.rx).toBeCloseTo(50, 6)
    expect(circle.ry).toBeCloseTo(50, 6)
    // L only: mid = side, fully correlated. In goniometer axes (x = R - L) the major axis points
    // up-left, i.e. 135 degrees counter-clockwise, which is a canvas rotation of -135 or +45.
    const left = fieldEllipse(-20, -20, 1, 50)
    expect(left.ry).toBeCloseTo(0, 3)
    const deg = ((left.rotation * 180) / Math.PI + 360) % 180
    expect(deg).toBeCloseTo(45, 3)
  })
})
