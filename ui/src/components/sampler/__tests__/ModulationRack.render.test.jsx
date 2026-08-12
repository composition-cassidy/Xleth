/**
 * @vitest-environment jsdom
 *
 * Modulation rack — mounts the REAL ModulationRack against a stubbed
 * window.xleth and drives the card rack + editors, so the whole chain is
 * exercised: engine config -> store -> rendered rack -> editor -> IPC commit.
 *
 * The renderer reaches the bridge through optional chaining
 * (window.xleth?.timeline?.foo?.()), which turns a broken call into a silent
 * no-op. So the commit assertions read the captured setSamplerModulation
 * payload rather than trusting a handler fired.
 */
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import ModulationRack from '../modulation/ModulationRack.jsx'
import useSamplerModulationStore from '../../../stores/samplerModulationStore.js'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

// jsdom has no canvas backend; the editors paint shapes on mount.
const gradient = { addColorStop: () => {} }
const noopCtx = () => new Proxy({}, {
  get: (_t, prop) => {
    if (prop === 'canvas') return { width: 0, height: 0 }
    if (prop === 'measureText') return () => ({ width: 0 })
    return () => gradient
  },
})

const REGION_ID = 11

let container = null
let root = null
let lastSet = null

function installXleth() {
  lastSet = null
  // A minimal in-memory engine: getSamplerModulation returns the current
  // config; set applies the patch (full-config or per-field) and records it.
  let cfg = {
    envs: Array.from({ length: 6 }, () => ({})),
    lfos: Array.from({ length: 6 }, () => ({})),
    velo: { points: [], outputAmount: 1 },
    note: { points: [], outputAmount: 1 },
    routes: [],
  }
  globalThis.window.xleth = {
    timeline: {
      getBPM: async () => 120,
      getSamplerModulation: async () => JSON.parse(JSON.stringify(cfg)),
      setSamplerModulation: async (_id, patch) => {
        lastSet = patch
        cfg = { ...cfg, ...patch }
        return { routeCount: (patch.routes || cfg.routes || []).length, rejectedRoutes: 0 }
      },
    },
  }
}

beforeEach(() => {
  installXleth()
  globalThis.HTMLCanvasElement.prototype.getContext = noopCtx
  // Reset the module-singleton store between tests.
  useSamplerModulationStore.setState({ regionId: null, config: null, selectedCard: 'lfo0', loading: false, lastCommit: null })
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  container = null
  root = null
})

async function mount() {
  await act(async () => { root.render(<ModulationRack regionId={REGION_ID} bpm={120} />) })
  // let the async load() resolve
  await act(async () => { await Promise.resolve(); await Promise.resolve() })
}

describe('ModulationRack', () => {
  it('renders all 14 source cards', async () => {
    await mount()
    const cards = container.querySelectorAll('.sampler-mod-card')
    expect(cards).toHaveLength(14)
    const labels = Array.from(cards).map((c) => c.textContent.trim())
    expect(labels.slice(0, 6)).toEqual(['ENV 1', 'ENV 2', 'ENV 3', 'ENV 4', 'ENV 5', 'ENV 6'])
    expect(labels.slice(6, 12)).toEqual(['LFO 1', 'LFO 2', 'LFO 3', 'LFO 4', 'LFO 5', 'LFO 6'])
    expect(labels.slice(12)).toEqual(['VELO', 'NOTE'])
  })

  it('opens the LFO editor and a preset commits two STEP points', async () => {
    await mount()
    // LFO 1 is the default selection; the shape toolbar + canvas should render.
    expect(container.querySelector('.sampler-mod-toolbar')).toBeTruthy()
    expect(container.querySelector('canvas')).toBeTruthy()

    // Click the "square" preset (4th shape icon button: sine, triangle, saw, square).
    const iconBtns = container.querySelectorAll('.sampler-mod-tool-group .sampler-mod-icon-btn')
    expect(iconBtns.length).toBeGreaterThanOrEqual(5)
    await act(async () => { iconBtns[3].dispatchEvent(new MouseEvent('click', { bubbles: true })) })

    expect(lastSet).toBeTruthy()
    expect(lastSet.lfos[0].points).toHaveLength(2)
    expect(lastSet.lfos[0].points[0].seg).toBe(0) // STEP
    expect(lastSet.lfos[0].points[1].seg).toBe(0)
  })

  it('switches an LFO to BPM rate and commits tempoSync', async () => {
    await mount()
    // Find the Rate Hz/BPM toggle — a .sampler-seg inside the rate head.
    const rateHead = container.querySelector('.sampler-mod-rate-head')
    expect(rateHead).toBeTruthy()
    const bpmBtn = Array.from(rateHead.querySelectorAll('.sampler-seg-option')).find((b) => b.textContent.trim() === 'BPM')
    expect(bpmBtn).toBeTruthy()
    await act(async () => { bpmBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    expect(lastSet.lfos[0].tempoSync).toBe(true)
    // The BPM note-value select should now be present.
    expect(container.querySelector('.sampler-mod-rate-sync')).toBeTruthy()
  })

  it('opens the VELO editor and Invert commits two endpoints', async () => {
    await mount()
    const veloCard = Array.from(container.querySelectorAll('.sampler-mod-card')).find((c) => c.textContent.trim() === 'VELO')
    await act(async () => { veloCard.dispatchEvent(new MouseEvent('click', { bubbles: true })) })

    const invertBtn = Array.from(container.querySelectorAll('.sampler-mod-text-btn')).find((b) => b.textContent.trim() === 'Invert')
    expect(invertBtn).toBeTruthy()
    await act(async () => { invertBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    expect(lastSet.velo.points).toHaveLength(2)
    expect(lastSet.velo.points[0].y).toBe(1)
    expect(lastSet.velo.points[1].y).toBe(0)
  })
})
