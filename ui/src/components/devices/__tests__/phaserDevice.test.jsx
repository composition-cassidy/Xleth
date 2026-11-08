/**
 * @vitest-environment jsdom
 */
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import useEffectChainStore from '../../../stores/effectChainStore.js'
import usePhaserStore from '../../../stores/phaserStore.js'
import useMixerStore from '../../../stores/mixerStore.js'
import PhaserPanel from '../../mixer/PhaserPanel.jsx'
import DeviceChain from '../DeviceChain.jsx'
import { THIN_SPACE as T } from '../../../ui-kit'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const CHAIN = [{ nodeId: 7, pluginId: 'phaser', position: 0, bypassed: false }]
const params = (over = {}) => JSON.stringify(Object.entries({
  rate: 0.5, depth: 80, stages: 4, feedback: 40, resonance: 1, width: 50, mix: 100,
  freq_low: 100, freq_high: 4000, spread: 30, ...over,
}).map(([id, value]) => ({ id, value })))

let container
let root
let audio
let engineParams

const flush = async () => { await act(async () => { await new Promise((r) => setTimeout(r, 0)) }) }
const q = (sel) => container.querySelector(sel)
const slider = (label) => q(`[role="slider"][aria-label="${label}"]`)
const aria = (label) => slider(label)?.getAttribute('aria-valuetext')

beforeEach(() => {
  HTMLCanvasElement.prototype.getContext = () => null
  engineParams = params()
  audio = {
    getEffectChain: vi.fn(async () => JSON.stringify(CHAIN)),
    getEffectParameters: vi.fn(async () => engineParams),
    setEffectParameter: vi.fn(),
    getEffectMeter: vi.fn(async () => [0, 0, 0]),
    setEffectBypass: vi.fn(async () => true),
  }
  window.xleth = { audio, timeline: { getTracks: async () => [] } }
  useEffectChainStore.setState({ chains: {}, fxModes: {} })
  useMixerStore.setState({ selectedChainKey: '3', tracks: { 3: { id: 3, name: 'Bus' } } })
  usePhaserStore.setState({ target: null })
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

describe('Phaser device in the chain', () => {
  it('hydrates from the engine and prints every value with its unit', async () => {
    engineParams = params({ rate: 1.25, feedback: -40, freq_high: 5490, resonance: 2.5, spread: 10 })
    act(() => root.render(<DeviceChain />))
    await flush()
    await flush()
    expect(audio.getEffectParameters).toHaveBeenCalledWith(3, 7)
    expect(aria('Rate')).toBe(`Rate, 1.25${T}Hz`)
    expect(aria('Feedback')).toBe(`Feedback, −40${T}%`)
    expect(aria('Low')).toBe(`Low, 100${T}Hz`)
    expect(aria('High')).toBe(`High, 5.49${T}kHz`)
    expect(aria('Resonance')).toBe('Resonance, 2.50')
    expect(aria('Spread')).toBe(`Spread, 10${T}%`)
    expect(aria('Mix')).toBe(`Mix, 100${T}%`)
  })

  it('ranges are the engine\'s, including the new Resonance and Spread', async () => {
    act(() => root.render(<DeviceChain />))
    await flush()
    await flush()
    const range = (label) => ['aria-valuemin', 'aria-valuemax'].map((a) => String(Number(Number(slider(label).getAttribute(a)).toPrecision(6))))
    expect(range('Rate')).toEqual(['0.05', '5'])
    expect(range('Feedback')).toEqual(['-95', '95'])
    expect(range('Low')).toEqual(['20', '2000'])
    expect(range('High')).toEqual(['200', '16000'])
    expect(range('Resonance')).toEqual(['0.3', '5'])
    expect(range('Spread')).toEqual(['0', '100'])
  })

  it('sections run in signal order: Sweep, Modulation, Notches, Output', async () => {
    act(() => root.render(<DeviceChain />))
    await flush()
    const titles = Array.from(container.querySelectorAll('[role="heading"][aria-level="3"]')).map((h) => h.textContent)
    const order = ['Sweep', 'Modulation', 'Notches', 'Output'].map((t) => titles.indexOf(t))
    expect(order.every((i) => i >= 0)).toBe(true)
    expect([...order].sort((a, b) => a - b)).toEqual(order)
  })

  it('stages is a one-click choice of 1 to 6 and commits once', async () => {
    act(() => root.render(<DeviceChain />))
    await flush()
    await flush()
    const group = q('[role="radiogroup"][aria-label="Stages"]')
    const radios = Array.from(group.querySelectorAll('[role="radio"]'))
    expect(radios.map((r) => r.textContent)).toEqual(['1', '2', '3', '4', '5', '6'])
    expect(radios[3].getAttribute('aria-checked')).toBe('true')
    act(() => radios[5].click())
    expect(audio.setEffectParameter).toHaveBeenCalledWith(3, 7, 'stages', 6)
  })

  it('a low-edge nudge writes freq_low', async () => {
    act(() => root.render(<DeviceChain />))
    await flush()
    await flush()
    act(() => { slider('Low').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true })) })
    const calls = audio.setEffectParameter.mock.calls.filter((c) => c[2] === 'freq_low')
    expect(calls.length).toBeGreaterThan(0)
    expect(calls[calls.length - 1][3]).toBeGreaterThan(100)
  })

  it('the display is the sweep canvas', async () => {
    act(() => root.render(<DeviceChain />))
    await flush()
    expect(q('canvas.phaser-sweep-canvas')).not.toBeNull()
  })

  it('pop-out opens the floating window and the docked slot becomes a strip', async () => {
    act(() => root.render(<><DeviceChain /><PhaserPanel /></>))
    await flush()
    act(() => q('button[aria-label="Open Phaser in a window"]').click())
    await flush()
    expect(usePhaserStore.getState().target).toEqual({ trackId: 3, nodeId: 7, storeKey: '3' })
    expect(q('[data-testid="phaser-window"] section').getAttribute('data-presentation')).toBe('floating')
    act(() => q('button[aria-label="Close Phaser"]').click())
    expect(usePhaserStore.getState().target).toBeNull()
  })
})

describe('PhaserPanel (floating)', () => {
  it('no longer carries the legacy panel or its CSS', () => {
    const src = readFileSync(path.resolve(__dirname, '../../mixer/PhaserPanel.jsx'), 'utf8')
    expect(src).not.toMatch(/phaser-panel|PhaserMixSlider|PluginUIKitKnob|XlethSelect/)
    const css = readFileSync(path.resolve(__dirname, '../../../styles/app.css'), 'utf8')
    expect(css).not.toMatch(/\.phaser-/)
  })
})
