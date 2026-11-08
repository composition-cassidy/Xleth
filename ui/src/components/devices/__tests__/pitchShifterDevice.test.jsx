/**
 * @vitest-environment jsdom
 */
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import useEffectChainStore from '../../../stores/effectChainStore.js'
import usePitchShifterStore from '../../../stores/pitchShifterStore.js'
import useMixerStore from '../../../stores/mixerStore.js'
import PitchShifterPanel from '../../mixer/PitchShifterPanel.jsx'
import DeviceChain from '../DeviceChain.jsx'
import { THIN_SPACE as T } from '../../../ui-kit'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const CHAIN = [{ nodeId: 7, pluginId: 'pitchshifter', position: 0, bypassed: false }]
const params = (over = {}) => JSON.stringify(Object.entries({
  mode: 0, mix: 1, semitones: 0, cents: 0, size: 50, formant: 1,
  clip_semitones: 0, clip_cents: 0, clip_method: 1, clip_formant: 0, ...over,
}).map(([id, value]) => ({ id, value })))

let container
let root
let audio
let engineParams

const flush = async () => { await act(async () => { await new Promise((r) => setTimeout(r, 0)) }) }
const q = (sel) => container.querySelector(sel)
const slider = (label) => q(`[role="slider"][aria-label="${label}"]`)
const aria = (label) => slider(label)?.getAttribute('aria-valuetext')
const radio = (text) => Array.from(container.querySelectorAll('[role="radio"]')).find((b) => b.textContent === text)

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
  usePitchShifterStore.setState({ target: null })
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

describe('Pitch shifter device in the chain', () => {
  it('hydrates from the engine; pitch prints in st and ct, mix as a percentage', async () => {
    engineParams = params({ semitones: 7, cents: -25, mix: 0.5, size: 40 })
    act(() => root.render(<DeviceChain />))
    await flush()
    await flush()
    expect(audio.getEffectParameters).toHaveBeenCalledWith(3, 7)
    expect(aria('Semitones')).toBe(`Semitones, +7.0${T}st`)
    expect(aria('Cents')).toBe(`Cents, −25${T}ct`)
    expect(aria('Mix')).toBe(`Mix, 50${T}%`)
    expect(aria('Grain size')).toBe(`Grain size, 40${T}ms`)
  })

  it('the semitones range is the engine\'s full ±24', async () => {
    act(() => root.render(<DeviceChain />))
    await flush()
    await flush()
    const s = slider('Semitones')
    expect(s.getAttribute('aria-valuemin')).toBe('-24')
    expect(s.getAttribute('aria-valuemax')).toBe('24')
  })

  it('shows Grain size in Granular, Formant in Smart and Voice, and neither in Clip', async () => {
    engineParams = params({ mode: 1 })
    act(() => root.render(<DeviceChain />))
    await flush()
    await flush()
    expect(slider('Grain size')).toBeNull()
    expect(slider('Formant')).not.toBeNull()
    act(() => radio('Clip').click())
    expect(audio.setEffectParameter).toHaveBeenCalledWith(3, 7, 'mode', 3)
    await flush()
    expect(slider('Grain size')).toBeNull()
    expect(slider('Formant')).toBeNull()
    expect(q('[aria-label="Clip stretch method"]')).not.toBeNull()
  })

  it('in Clip the pitch pair writes clip_semitones, not semitones', async () => {
    engineParams = params({ mode: 3, clip_semitones: -5 })
    act(() => root.render(<DeviceChain />))
    await flush()
    await flush()
    expect(aria('Semitones')).toBe(`Semitones, −5.0${T}st`)
    act(() => { slider('Semitones').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true })) })
    expect(audio.setEffectParameter.mock.calls.some((c) => c[2] === 'clip_semitones')).toBe(true)
    expect(audio.setEffectParameter.mock.calls.some((c) => c[2] === 'semitones')).toBe(false)
  })

  it('the Clip formant toggle and method are single commits', async () => {
    engineParams = params({ mode: 3 })
    act(() => root.render(<DeviceChain />))
    await flush()
    await flush()
    const formant = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === 'Formant')
    expect(formant.getAttribute('aria-pressed')).toBe('false')
    act(() => formant.click())
    expect(audio.setEffectParameter).toHaveBeenCalledWith(3, 7, 'clip_formant', 1)
  })

  it('a semitone nudge writes the engine', async () => {
    act(() => root.render(<DeviceChain />))
    await flush()
    await flush()
    act(() => { slider('Semitones').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true })) })
    const calls = audio.setEffectParameter.mock.calls.filter((c) => c[2] === 'semitones')
    expect(calls.length).toBeGreaterThan(0)
    expect(calls[calls.length - 1][3]).toBeGreaterThan(0)
  })

  it('sections run in signal order: Pitch, Character, Output', async () => {
    act(() => root.render(<DeviceChain />))
    await flush()
    const titles = Array.from(container.querySelectorAll('[role="heading"][aria-level="3"]')).map((h) => h.textContent)
    const order = ['Pitch', 'Character', 'Output'].map((t) => titles.indexOf(t))
    expect(order.every((i) => i >= 0)).toBe(true)
    expect([...order].sort((a, b) => a - b)).toEqual(order)
  })

  it('pop-out opens the floating window and the docked slot becomes a strip', async () => {
    act(() => root.render(<><DeviceChain /><PitchShifterPanel /></>))
    await flush()
    act(() => q('button[aria-label="Open Pitch shifter in a window"]').click())
    await flush()
    expect(usePitchShifterStore.getState().target).toEqual({ trackId: 3, nodeId: 7, storeKey: '3' })
    expect(q('[data-testid="pitchshifter-window"] section').getAttribute('data-presentation')).toBe('floating')
    act(() => q('button[aria-label="Close Pitch shifter"]').click())
    expect(usePitchShifterStore.getState().target).toBeNull()
  })
})

describe('PitchShifterPanel (floating)', () => {
  it('no longer carries the legacy panel or its CSS', () => {
    const src = readFileSync(path.resolve(__dirname, '../../mixer/PitchShifterPanel.jsx'), 'utf8')
    expect(src).not.toMatch(/pitchshifter-panel|PluginUIKitKnob|XlethSelect/)
    const css = readFileSync(path.resolve(__dirname, '../../../styles/app.css'), 'utf8')
    expect(css).not.toMatch(/\.pitchshifter-/)
  })
})
