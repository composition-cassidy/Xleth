// Shared jsdom harness for sampler render tests: mounts the REAL SamplerPanelContent
// against a stubbed window.xleth that APPLIES writes (a stub that swallowed them would
// let every post-commit assertion test nothing, because each commit re-fetches).
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { vi } from 'vitest'
import SamplerPanelContent from '../SamplerPanelContent.jsx'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

export const REGION_ID = 7

const gradient = { addColorStop: () => {} }
export const noopCtx = () => new Proxy({}, {
  get: (_t, prop) => {
    if (prop === 'canvas') return { width: 0, height: 0 }
    if (prop === 'measureText') return () => ({ width: 0 })
    if (prop === 'getImageData') return () => ({ data: new Uint8ClampedArray(4) })
    return () => gradient
  },
})

export function makeSlot(overrides = {}) {
  return {
    audioFilePath: 'C:/x.wav', name: 'Layer 1', rootNote: 60,
    octave: 0, semitone: 0, fine: 0, coarse: 0,
    volume: 1, pan: 0, mute: false, solo: false,
    smpStart: 0, smpLength: 0, declickMs: 1.5, fadeInMs: 0, fadeOutMs: 0,
    loopEnabled: false, loopStart: 0, loopEnd: 0, crossfadeSamples: 0,
    loopMode: 0, exitLoopOnRelease: false,
    mangleChain: [],
    prepAlgorithm: 2, prepStretch: 1, prepShiftCents: 0,
    dcOffsetRemoved: false, normalized: false, polarityReversed: false, reversed: false,
    ...overrides,
  }
}

export function createHarness() {
  const h = { container: null, root: null, commits: [], modRoutes: [], modSets: [], calls: [], modBase: {} }

  h.install = (initialSlots, region = {}, modBase = {}) => {
    h.commits = []
    h.modRoutes = []
    h.modSets = []
    h.modBase = { ...modBase }
    h.calls = []
    let slots = initialSlots.map((s) => ({ ...s }))
    let regionFlat = { crossfadeEnabled: true, ...region }
    const log = (name) => (...args) => { h.calls.push({ name, args }); return Promise.resolve(undefined) }
    globalThis.window.xleth = {
      timeline: {
        getRegions: async () => ([{ id: REGION_ID, name: 'R', slots: slots.map((s) => ({ ...s })), ...regionFlat }]),
        getRegionAudioInfo: async () => ({
          numSamples: 48000, originalSampleRate: 48000, duration: 1, audioFilePath: 'C:/x.wav',
        }),
        updateSamplerSettings: async (regionId, payload) => {
          h.commits.push({ regionId, payload })
          if (Array.isArray(payload.slots)) {
            slots = payload.slots.map((s) => ({ ...s }))
          } else {
            const { slotIndex = 0, ...flat } = payload
            const slotKeys = Object.keys(makeSlot())
            const perSlot = {}
            for (const [k, v] of Object.entries(flat)) {
              if (slotKeys.includes(k)) perSlot[k] = v
              else regionFlat = { ...regionFlat, [k]: v }
            }
            if (slots[slotIndex]) slots[slotIndex] = { ...slots[slotIndex], ...perSlot }
          }
          return true
        },
        getSamplerModulation: async () => ({ ...h.modBase, routes: h.modRoutes.map((r) => ({ ...r })) }),
        setSamplerModulation: async (_id, cfg) => {
          h.modSets.push(cfg)
          const { routes: _r, ...rest } = cfg
          h.modBase = { ...h.modBase, ...rest }
          h.modRoutes = (cfg.routes || []).map((r) => ({ ...r }))
          return { routeCount: h.modRoutes.length, rejectedRoutes: 0 }
        },
        autoLoopForSelection: async (...args) => {
          h.calls.push({ name: 'autoLoopForSelection', args })
          return { valid: true, loopStart: 1000, loopEnd: 9000, crossfadeSamples: 400, period: 200, periodMultiple: 40, spansConsidered: 12, spansKept: 3, spanDriftCents: 1.25, sampleDurationSec: 1 }
        },
        getBPM: async () => 140,
        previewNote: log('previewNote'),
        previewNoteOff: log('previewNoteOff'),
        getSamplerPlayPositions: async () => ({ positions: [] }),
        getSlotBakeStatus: async () => ({ pending: [], changed: false }),
        addSampleSlot: log('addSampleSlot'),
        duplicateSampleSlot: log('duplicateSampleSlot'),
        removeSampleSlot: log('removeSampleSlot'),
        setSlotAudio: log('setSlotAudio'),
      },
      audio: { openSwapAudioDialog: async () => null, swapRegionAudio: log('swapRegionAudio') },
      loopTelemetry: { append: log('loopTelemetry.append') },
    }
  }

  h.mount = async (slots = [makeSlot()], region = {}, modBase = {}) => {
    h.install(slots, region, modBase)
    h.container = document.createElement('div')
    document.body.appendChild(h.container)
    h.root = createRoot(h.container)
    await act(async () => {
      h.root.render(<SamplerPanelContent regionId={REGION_ID} onClose={() => {}} />)
    })
    await h.settle()
    return h.container
  }

  h.settle = async () => {
    await act(async () => { for (let i = 0; i < 4; i++) await Promise.resolve() })
  }

  h.unmount = async () => {
    if (h.root) await act(async () => h.root.unmount())
    h.container?.remove()
    h.container = null
    h.root = null
    delete globalThis.window.xleth
  }

  h.tab = (name) => [...h.container.querySelectorAll('[role="tab"]')].find((t) => t.textContent.trim() === name)
  h.view = async (name) => { await act(async () => { h.tab(name).click() }); await h.settle() }
  h.slider = (name) => h.container.querySelector(`[role="slider"][aria-label="${name}"]`)
  h.button = (name) => [...h.container.querySelectorAll('button')].find((b) => b.textContent.trim() === name || b.getAttribute('aria-label') === name)
  h.key = async (el, key, init = {}) => {
    await act(async () => { el.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init })) })
    await h.settle()
  }
  h.click = async (el) => { await act(async () => { el.click() }); await h.settle() }
  // Open a kit Select (by its data-field) and choose the option with this value.
  h.choose = async (field, value) => {
    await act(async () => { h.container.querySelector(`[data-field="${field}"]`).click() })
    const opt = document.querySelector(`[role="listbox"] [role="option"][data-value="${value}"]`)
    await act(async () => { opt.click() })
    await h.settle()
  }
  h.options = async (field) => {
    const trigger = h.container.querySelector(`[data-field="${field}"]`)
    await act(async () => { trigger.click() })
    const labels = [...document.querySelectorAll('[role="listbox"] [role="option"]')].map((o) => o.textContent.trim())
    await act(async () => { trigger.click() })
    return labels
  }
  h.lastCommit = (key) => [...h.commits].reverse().find((c) => key in c.payload)

  return h
}

export function stubCanvas() {
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(noopCtx)
}
