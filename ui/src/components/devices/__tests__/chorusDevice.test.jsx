/**
 * @vitest-environment jsdom
 */
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import useEffectChainStore from '../../../stores/effectChainStore.js'
import useChorusStore from '../../../stores/chorusStore.js'
import useMixerStore from '../../../stores/mixerStore.js'
import ChorusPanel from '../../mixer/ChorusPanel.jsx'
import DeviceChain from '../DeviceChain.jsx'
import { THIN_SPACE as T } from '../../../ui-kit'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const CHAIN = [{ nodeId: 7, pluginId: 'chorus', position: 0, bypassed: false }]
const params = (over = {}) => JSON.stringify(Object.entries({
  rate: 0.8, depth: 50, delay: 15, feedback: 0, voices: 2, width: 80, mix: 50, ...over,
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
  useChorusStore.setState({ target: null })
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

describe('Chorus device in the chain', () => {
  it('hydrates from the engine and prints every value with its unit', async () => {
    engineParams = params({ rate: 1.25, delay: 12.5, feedback: 10, voices: 4, width: 60 })
    act(() => root.render(<DeviceChain />))
    await flush()
    await flush()
    expect(audio.getEffectParameters).toHaveBeenCalledWith(3, 7)
    expect(aria('Rate')).toBe(`Rate, 1.25${T}Hz`)
    expect(aria('Delay')).toBe(`Delay, 12.5${T}ms`)
    expect(aria('Feedback')).toBe(`Feedback, 10${T}%`)
    expect(aria('Voices')).toBe('Voices, 4')
    expect(aria('Width')).toBe(`Width, 60${T}%`)
    expect(aria('Mix')).toBe(`Mix, 50${T}%`)
  })

  it('knob ranges are the engine\'s', async () => {
    act(() => root.render(<DeviceChain />))
    await flush()
    await flush()
    const range = (label) => [slider(label).getAttribute('aria-valuemin'), slider(label).getAttribute('aria-valuemax')]
    expect(range('Rate')).toEqual(['0.05', '5'])
    expect(range('Delay')).toEqual(['7', '30'])
    expect(range('Feedback')).toEqual(['0', '25'])
    expect(range('Voices')).toEqual(['1', '10'])
  })

  it('sections run in signal order: Voices, Modulation, Feedback, Output', async () => {
    act(() => root.render(<DeviceChain />))
    await flush()
    const titles = Array.from(container.querySelectorAll('[role="heading"][aria-level="3"]')).map((h) => h.textContent)
    const order = ['Voices', 'Modulation', 'Feedback', 'Output'].map((t) => titles.indexOf(t))
    expect(order.every((i) => i >= 0)).toBe(true)
    expect([...order].sort((a, b) => a - b)).toEqual(order)
  })

  it('voices steps in whole numbers', async () => {
    act(() => root.render(<DeviceChain />))
    await flush()
    await flush()
    act(() => { slider('Voices').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true })) })
    const calls = audio.setEffectParameter.mock.calls.filter((c) => c[2] === 'voices')
    expect(calls.length).toBeGreaterThan(0)
    expect(calls[calls.length - 1][3]).toBe(3)
  })

  it('a rate nudge writes the engine', async () => {
    act(() => root.render(<DeviceChain />))
    await flush()
    await flush()
    act(() => { slider('Rate').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true })) })
    const calls = audio.setEffectParameter.mock.calls.filter((c) => c[2] === 'rate')
    expect(calls.length).toBeGreaterThan(0)
    expect(calls[calls.length - 1][3]).toBeGreaterThan(0.8)
  })

  it('the display is the orbit canvas', async () => {
    act(() => root.render(<DeviceChain />))
    await flush()
    expect(q('canvas.chorus-orbit-canvas')).not.toBeNull()
  })

  it('pop-out opens the floating window and the docked slot becomes a strip', async () => {
    act(() => root.render(<><DeviceChain /><ChorusPanel /></>))
    await flush()
    act(() => q('button[aria-label="Open Chorus in a window"]').click())
    await flush()
    expect(useChorusStore.getState().target).toEqual({ trackId: 3, nodeId: 7, storeKey: '3' })
    expect(q('[data-testid="chorus-window"] section').getAttribute('data-presentation')).toBe('floating')
    act(() => q('button[aria-label="Close Chorus"]').click())
    expect(useChorusStore.getState().target).toBeNull()
  })
})

describe('ChorusPanel (floating)', () => {
  it('no longer carries the legacy panel or its CSS', () => {
    const src = readFileSync(path.resolve(__dirname, '../../mixer/ChorusPanel.jsx'), 'utf8')
    expect(src).not.toMatch(/chorus-panel|ChorusMixSlider|PluginUIKitKnob|EffectPresetBar/)
    const css = readFileSync(path.resolve(__dirname, '../../../styles/app.css'), 'utf8')
    expect(css).not.toMatch(/\.chorus-/)
  })
})
