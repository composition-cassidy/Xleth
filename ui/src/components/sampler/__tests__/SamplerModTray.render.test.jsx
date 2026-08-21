/**
 * @vitest-environment jsdom
 *
 * Modulation tray — mounts the REAL SamplerModTray against a stubbed
 * window.xleth. Because the tray portals to <body> and glues itself to the
 * sampler panel's rect, the test first plants a [data-panel-id="sampler"]
 * element so the rect resolves (jsdom returns zeros, which is a non-null rect —
 * enough for the tray to render).
 *
 * Asserts the dynamic-source contract on the TAB strips: ENV 1's tab has no
 * remove control, VELO/NOTE are fixed tabs, the ENV/LFO "+" adds a tab (and
 * disables at six), and removing a tab commits through the store.
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

const tabLabels = () =>
  Array.from(document.querySelectorAll('.sampler-mod-tab-label')).map((s) => s.textContent.trim())

const tabByLabel = (label) =>
  Array.from(document.querySelectorAll('.sampler-mod-tab'))
    .find((t) => t.querySelector('.sampler-mod-tab-label')?.textContent.trim() === label)

describe('SamplerModTray', () => {
  it('renders an ENV 1 tab (no remove), plus VELO and NOTE tabs', async () => {
    installXleth(baseConfig([true, false, false, false, false, false],
                            [false, false, false, false, false, false]))
    await mount()

    const labels = tabLabels()
    expect(labels).toContain('ENV 1')
    expect(labels).toContain('VELO')
    expect(labels).toContain('NOTE')
    expect(labels).not.toContain('ENV 2')
    expect(labels).not.toContain('LFO 1')

    // ENV 1's tab carries no remove control (it is the permanent amp envelope).
    expect(tabByLabel('ENV 1').querySelector('.sampler-mod-tab-x')).toBeNull()
  })

  it('the ENV "+" adds an envelope tab and commits presence', async () => {
    installXleth(baseConfig([true, false, false, false, false, false],
                            [false, false, false, false, false, false]))
    await mount()

    // First section is ENV; its "+" adds ENV 2.
    const addBtn = document.querySelector('.sampler-mod-section .sampler-mod-add-src')
    await act(async () => { addBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await Promise.resolve(); await Promise.resolve() })

    expect(lastSet).toBeTruthy()
    expect(lastSet.envPresent[1]).toBe(true)
    expect(tabLabels()).toContain('ENV 2')
    // The newly added ENV 2 tab DOES carry a remove control.
    expect(tabByLabel('ENV 2').querySelector('.sampler-mod-tab-x')).toBeTruthy()
  })

  it('disables the ENV "+" when all six envelopes are present', async () => {
    installXleth(baseConfig([true, true, true, true, true, true],
                            [false, false, false, false, false, false]))
    await mount()
    const addBtn = document.querySelector('.sampler-mod-section .sampler-mod-add-src')
    expect(addBtn.disabled).toBe(true)
  })

  it('removing an LFO tab commits its removal', async () => {
    installXleth(baseConfig([true, false, false, false, false, false],
                            [true, false, false, false, false, false]))
    await mount()

    const removeBtn = tabByLabel('LFO 1').querySelector('.sampler-mod-tab-x')
    expect(removeBtn).toBeTruthy()
    await act(async () => { removeBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await Promise.resolve(); await Promise.resolve() })

    expect(lastSet.lfoPresent[0]).toBe(false)
    expect(tabLabels()).not.toContain('LFO 1')
  })
})
