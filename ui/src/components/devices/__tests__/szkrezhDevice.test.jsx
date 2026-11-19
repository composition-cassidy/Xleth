/**
 * @vitest-environment jsdom
 */
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import useEffectChainStore from '../../../stores/effectChainStore.js'
import useSzkrezhStore from '../../../stores/szkrezhStore.js'
import useMixerStore from '../../../stores/mixerStore.js'
import SzkrezhPanel from '../../mixer/SzkrezhPanel.jsx'
import DeviceChain from '../DeviceChain.jsx'
import { THIN_SPACE as T } from '../../../ui-kit'
import { DIVISIONS, SCALES, intervalLabel, noteCodec, divisionCodec, staircase, dynAmountFormat } from '../szkrezhModel.js'
import { getPresetAdapter } from '../../../fx-presets/effectPresetAdapters.js'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const ENGINE = path.resolve(__dirname, '../../../../../engine/src')
const CHAIN = [{ nodeId: 7, pluginId: 'szkrezh', position: 0, bypassed: false }]
const ENGINE_DEFAULTS = {
  pitch_src: 0, pitch: 1200, pitch_offset: 0, harmony: 2, key: 0, scale: 0, root: 60, midi_track: 0,
  sync: 1, splice: 500, splice_div: 10, smoothing: 20, delay: 0, delay_div: 0,
  splice_offset: 0, delay_offset: 0, reverse: 1, recycle: 35, fb_mode: 0, low_cut: 80, high_cut: 20000, freeze: 0,
  dyn_amount: 0, dyn_threshold: -24, dyn_attack: 5, dyn_release: 250, dyn_target: 0,
  quality: 0, input: 0, output: 0, mix: 50,
}
const params = (over = {}) => JSON.stringify(Object.entries({ ...ENGINE_DEFAULTS, ...over }).map(([id, value]) => ({ id, value })))

let container
let root
let audio
let engineParams

const flush = async () => { await act(async () => { await new Promise((r) => setTimeout(r, 0)) }) }
const q = (sel) => container.querySelector(sel)
const slider = (label) => q(`[role="slider"][aria-label="${label}"]`)
const aria = (label) => slider(label)?.getAttribute('aria-valuetext')
const radio = (text) => Array.from(container.querySelectorAll('[role="radio"]')).find((b) => b.textContent === text)
const render = async (over) => {
  engineParams = params(over)
  act(() => root.render(<DeviceChain />))
  await flush()
  await flush()
}

beforeEach(() => {
  HTMLCanvasElement.prototype.getContext = () => null
  engineParams = params()
  audio = {
    getEffectChain: vi.fn(async () => JSON.stringify(CHAIN)),
    getEffectParameters: vi.fn(async () => engineParams),
    setEffectParameter: vi.fn(),
    getEffectMeter: vi.fn(async () => [0, 0, 1, 1200, 1200, 0, -1, -1]),
    setEffectBypass: vi.fn(async () => true),
  }
  window.xleth = { audio, timeline: { getTracks: async () => [] } }
  useEffectChainStore.setState({ chains: {}, fxModes: {} })
  useMixerStore.setState({
    selectedChainKey: '3',
    tracks: { 3: { id: 3, name: 'Pitch sample' }, 5: { id: 5, name: 'Harmony keys' }, 9: { id: 9, name: 'Drums' } },
    trackOrder: [3, 5, 9],
  })
  useSzkrezhStore.setState({ target: null })
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

describe('Szkrezh device in the chain', () => {
  it('hydrates from the engine; pitch prints in semitones', async () => {
    await render({ pitch: 700, recycle: 60, mix: 100 })
    expect(audio.getEffectParameters).toHaveBeenCalledWith(3, 7)
    expect(aria('Pitch')).toBe(`Pitch, +7.00${T}st`)
    expect(aria('Recycle')).toBe(`Recycle, 60${T}%`)
    expect(aria('Mix')).toBe(`Mix, 100${T}%`)
  })

  it('the pitch range is the full ±36 st of the engine', async () => {
    await render()
    const s = slider('Pitch')
    expect(s.getAttribute('aria-valuemin')).toBe('-3600')
    expect(s.getAttribute('aria-valuemax')).toBe('3600')
  })

  it('Pitch source swaps the controls: Knob, Harmony (interval, key, scale), Keys (track, root)', async () => {
    await render()
    expect(slider('Pitch')).not.toBeNull()
    expect(slider('Interval')).toBeNull()
    act(() => radio('Harmony').click())
    expect(audio.setEffectParameter).toHaveBeenCalledWith(3, 7, 'pitch_src', 1)
    await flush()
    expect(slider('Pitch')).toBeNull()
    expect(aria('Interval')).toBe('Interval, +3rd')
    expect(q('[aria-label="Key"]')).not.toBeNull()
    expect(q('[aria-label="Scale"]')).not.toBeNull()
    act(() => radio('Keys').click())
    await flush()
    expect(q('[aria-label="Keys track"]')).not.toBeNull()
    expect(aria('Root')).toBe('Root, C4')
    expect(slider('Offset')).not.toBeNull()
  })

  it('Sync shows note values with their length; Free shows milliseconds', async () => {
    await render({ sync: 1, splice_div: 7 })
    expect(aria('Splice')).toBe('Splice, 1/8')
    expect(container.textContent).toMatch(/≈ \d+/)
    act(() => radio('Free').click())
    expect(audio.setEffectParameter).toHaveBeenCalledWith(3, 7, 'sync', 0)
    await flush()
    expect(aria('Splice')).toBe(`Splice, 500${T}ms`)
  })

  it('Direction and Quality are single commits', async () => {
    await render()
    act(() => radio('Forward').click())
    expect(audio.setEffectParameter).toHaveBeenCalledWith(3, 7, 'reverse', 0)
    act(() => radio('Clean').click())
    expect(audio.setEffectParameter).toHaveBeenCalledWith(3, 7, 'quality', 1)
  })

  it('sections run in signal order: Pitch, Splice, Recycle, Dynamics, Stereo, Output', async () => {
    await render()
    const titles = Array.from(container.querySelectorAll('[role="heading"][aria-level="3"]')).map((h) => h.textContent)
    const order = ['Pitch', 'Splice', 'Recycle', 'Dynamics', 'Stereo', 'Output'].map((t) => titles.indexOf(t))
    expect(order.every((i) => i >= 0)).toBe(true)
    expect([...order].sort((a, b) => a - b)).toEqual(order)
  })

  it('pop-out opens the floating window', async () => {
    act(() => root.render(<><DeviceChain /><SzkrezhPanel /></>))
    await flush()
    act(() => q('button[aria-label="Open Szkrezh in a window"]').click())
    await flush()
    expect(useSzkrezhStore.getState().target).toEqual({ trackId: 3, nodeId: 7, storeKey: '3' })
    expect(q('[data-testid="szkrezh-window"] section').getAttribute('data-presentation')).toBe('floating')
  })
})

describe('Szkrezh model', () => {
  it('interval labels follow the scale', () => {
    expect(intervalLabel(2, 0)).toBe('+3rd')
    expect(intervalLabel(-4, 1)).toBe('−5th')
    expect(intervalLabel(7, 0)).toBe('+octave')
    expect(intervalLabel(0, 0)).toBe('Unison')
    expect(intervalLabel(2, 6)).toBe('+2 steps')
    expect(intervalLabel(5, 8)).toBe(`+5${T}st`)
  })

  it('note and division codecs type in', () => {
    expect(noteCodec.parse('C4')).toBe(60)
    expect(noteCodec.parse('a#3')).toBe(58)
    expect(noteCodec.parse('64')).toBe(64)
    expect(noteCodec.format(67)).toBe('G4')
    const splice = divisionCodec(1)
    expect(splice.parse('1/8d')).toBe(9)
    expect(splice.parse('1/8 dotted')).toBe(9)
    expect(splice.parse('1/16t')).toBe(3)
    expect(splice.parse('0')).toBeNull()
    expect(divisionCodec(0).parse('0')).toBe(0)
    expect(divisionCodec(0).parse('off')).toBe(0)
    expect(divisionCodec(0).format(0)).toBe('Off')
    expect(splice.format(7)).toBe('1/8')
  })

  it('gate / duck reads as one bipolar control', () => {
    expect(dynAmountFormat.format(0)).toBe('Off')
    expect(dynAmountFormat.format(-40)).toBe(`Gate 40${T}%`)
    expect(dynAmountFormat.format(25)).toBe(`Duck 25${T}%`)
    expect(dynAmountFormat.parse('gate 30')).toBe(-30)
  })

  it('the staircase climbs by the shift and fades by the recycle', () => {
    const s = staircase(12, 50, 6)
    expect(s[0]).toEqual({ k: 1, semitones: 12, level: 1 })
    expect(s[1].semitones).toBe(24)
    expect(s[1].level).toBeCloseTo(0.49, 6)
    expect(staircase(12, 0, 6)).toHaveLength(1)
  })
})

describe('Szkrezh mirrors the engine', () => {
  const core = readFileSync(path.join(ENGINE, 'dsp/szkrezh/SzkrezhCore.cpp'), 'utf8')
  const effect = readFileSync(path.join(ENGINE, 'audio/XlethSzkrezhEffect.h'), 'utf8')

  it('division labels and scales match SzkrezhCore.cpp', () => {
    const labels = [...core.matchAll(/\{\s*[0-9./ ]+,\s*"([^"]+)"\s*\}/g)].map((m) => m[1])
    expect(labels).toEqual(DIVISIONS.map((d) => d.label))
    const scales = [...core.matchAll(/\{\s*"([A-Za-z ]+)",\s*\d+,\s*\{/g)].map((m) => m[1])
    expect(scales).toEqual(SCALES)
  })

  it('every parameter id and default the device uses is the engine\'s', () => {
    const rows = [...effect.matchAll(/(?:f|fixed)\("([a-z_]+)",\s*"[^"]+",\s*Nar\{[^}]*\},\s*([^,]+),/g)]
    const engine = Object.fromEntries(rows.map((m) => [m[1], m[2].trim()]))
    expect(Object.keys(engine).sort()).toEqual(Object.keys(ENGINE_DEFAULTS).sort())
    for (const [id, v] of Object.entries(ENGINE_DEFAULTS)) {
      if (id === 'splice_div') continue   // written as kDefaultSpliceDivision (10)
      expect(Number.parseFloat(engine[id]), id).toBe(v)
    }
  })
})

describe('Szkrezh presets', () => {
  const dir = path.resolve(__dirname, '../../../fx-presets/factory/szkrezh')
  const files = readdirSync(dir).filter((f) => f.endsWith('.json'))

  it('ships factory presets that only use engine ids and never a track id', () => {
    expect(files.length).toBeGreaterThanOrEqual(5)
    for (const f of files) {
      const doc = JSON.parse(readFileSync(path.join(dir, f), 'utf8'))
      expect(doc.effectType).toBe('szkrezh')
      expect(doc.xlethFxPreset).toBe(1)
      const ids = Object.keys(doc.state.params)
      expect(ids.every((id) => id in ENGINE_DEFAULTS), f).toBe(true)
      expect(ids).not.toContain('midi_track')
    }
  })

  it('the preset adapter never captures or applies the Keys track', async () => {
    engineParams = params({ midi_track: 5, pitch: 300 })
    const adapter = getPresetAdapter('szkrezh')
    const state = await adapter.captureState({ trackId: 3, nodeId: 7 })
    expect(state.params).not.toHaveProperty('midi_track')
    expect(state.params.pitch).toBe(300)
    await adapter.applyState({ trackId: 3, nodeId: 7 }, { params: { midi_track: 9, pitch: 500 } })
    expect(audio.setEffectParameter.mock.calls.some((c) => c[2] === 'midi_track')).toBe(false)
  })
})
