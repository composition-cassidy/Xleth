/**
 * @vitest-environment jsdom
 *
 * Modulation tray — mounts the REAL SamplerModTray against a stubbed
 * window.xleth. Because the tray portals to <body> and glues itself to the
 * sampler panel's rect, the test first plants a [data-panel-id="sampler"]
 * element so the rect resolves (jsdom returns zeros, which is a non-null rect —
 * enough for the tray to render).
 *
 * Asserts the dynamic-source contract: ENV 1 has no remove control, VELO/NOTE
 * are fixed, the ENV/LFO "+" adds a card (and disables at six), and removing a
 * card commits through the store.
 */
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import SamplerModTray from '../modulation/SamplerModTray.jsx'
import useSamplerModulationStore from '../../../stores/samplerModulationStore.js'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const gradient = { addColorStop: () => {} }
const noopCtx = () => new Proxy({}, {
  get: (_t, prop) => {
    if (prop === 'canvas') return { width: 0, height: 0 }
    if (prop === 'measureText') return () => ({ width: 0 })
    return () => gradient
  },
})

const REGION_ID = 3

let container = null
let root = null
let frameEl = null
let lastSet = null
let cfg = null

function installXleth(initial) {
  lastSet = null
  cfg = initial
  globalThis.window.xleth = {
    timeline: {
      getSamplerModulation: async () => JSON.parse(JSON.stringify(cfg)),
      setSamplerModulation: async (_id, patch) => {
        lastSet = patch
        cfg = JSON.parse(JSON.stringify(patch))
        return { routeCount: (patch.routes || []).length, rejectedRoutes: 0 }
      },
    },
  }
}

function baseConfig(envPresent, lfoPresent) {
  return {
    envs: Array.from({ length: 6 }, () => ({})),
    lfos: Array.from({ length: 6 }, () => ({})),
    velo: { points: [], outputAmount: 1 },
    note: { points: [], outputAmount: 1 },
    envPresent,
    lfoPresent,
    routes: [],
  }
}

beforeEach(() => {
  globalThis.HTMLCanvasElement.prototype.getContext = noopCtx
  useSamplerModulationStore.setState({ regionId: null, config: null, selectedCard: 'lfo0', loading: false, lastCommit: null })
  // The panel frame the tray measures.
  frameEl = document.createElement('div')
  frameEl.setAttribute('data-panel-id', 'sampler')
  document.body.appendChild(frameEl)
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  frameEl.remove()
  container = null
  root = null
})

async function mount() {
  await act(async () => { root.render(<SamplerModTray regionId={REGION_ID} bpm={120} />) })
  await act(async () => { await Promise.resolve(); await Promise.resolve() })
}

const cardHeads = () =>
  Array.from(document.querySelectorAll('.sampler-mod-src-head span')).map((s) => s.textContent.trim())

describe('SamplerModTray', () => {
  it('renders ENV 1 (no remove), VELO and NOTE for a fresh config', async () => {
    installXleth(baseConfig([true, false, false, false, false, false],
                            [false, false, false, false, false, false]))
    await mount()

    const heads = cardHeads()
    expect(heads).toContain('ENV 1')
    expect(heads).toContain('VELO')
    expect(heads).toContain('NOTE')
    expect(heads).not.toContain('ENV 2')
    expect(heads).not.toContain('LFO 1')

    // ENV 1's card carries no remove control (it is the permanent amp envelope).
    const env1Card = Array.from(document.querySelectorAll('.sampler-mod-src-card'))
      .find((c) => c.querySelector('.sampler-mod-src-head span')?.textContent.trim() === 'ENV 1')
    expect(env1Card.querySelector('.sampler-mod-remove-src')).toBeNull()
  })

  it('the ENV "+" adds an envelope and commits presence', async () => {
    installXleth(baseConfig([true, false, false, false, false, false],
                            [false, false, false, false, false, false]))
    await mount()

    // First section is ENV; its header "+" adds ENV 2.
    const addBtn = document.querySelector('.sampler-mod-section .sampler-mod-add-src')
    await act(async () => { addBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await Promise.resolve(); await Promise.resolve() })

    expect(lastSet).toBeTruthy()
    expect(lastSet.envPresent[1]).toBe(true)
    expect(cardHeads()).toContain('ENV 2')
    // The newly added ENV 2 card DOES carry a remove control.
    const env2Card = Array.from(document.querySelectorAll('.sampler-mod-src-card'))
      .find((c) => c.querySelector('.sampler-mod-src-head span')?.textContent.trim() === 'ENV 2')
    expect(env2Card.querySelector('.sampler-mod-remove-src')).toBeTruthy()
  })

  it('disables the ENV "+" when all six envelopes are present', async () => {
    installXleth(baseConfig([true, true, true, true, true, true],
                            [false, false, false, false, false, false]))
    await mount()
    const addBtn = document.querySelector('.sampler-mod-section .sampler-mod-add-src')
    expect(addBtn.disabled).toBe(true)
  })

  it('removing an LFO card commits its removal', async () => {
    installXleth(baseConfig([true, false, false, false, false, false],
                            [true, false, false, false, false, false]))
    await mount()

    const lfo1Card = Array.from(document.querySelectorAll('.sampler-mod-src-card'))
      .find((c) => c.querySelector('.sampler-mod-src-head span')?.textContent.trim() === 'LFO 1')
    const removeBtn = lfo1Card.querySelector('.sampler-mod-remove-src')
    expect(removeBtn).toBeTruthy()
    await act(async () => { removeBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await Promise.resolve(); await Promise.resolve() })

    expect(lastSet.lfoPresent[0]).toBe(false)
    expect(cardHeads()).not.toContain('LFO 1')
  })
})
