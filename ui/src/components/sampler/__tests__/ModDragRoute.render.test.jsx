/**
 * @vitest-environment jsdom
 *
 * Drag-to-route and the route list, driven through the REAL tray against a
 * stubbed bridge.
 *
 * The drop hit-test is document.elementFromPoint + [data-mod-target]; jsdom has
 * no layout, so the test stubs elementFromPoint to return a planted target and
 * asserts the rest of the chain for real — tab pointerdown, a move PAST the
 * drag threshold that arms the drag, window pointermove hover, window pointerup,
 * key parse, route commit. A press with no travel is a tab select, not a drag.
 */
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import SamplerModTray from '../modulation/SamplerModTray.jsx'
import useSamplerModulationStore from '../../../stores/samplerModulationStore.js'
import useSamplerModDragStore from '../../../stores/samplerModDragStore.js'
import { targetKey, TARGET_SLOT_SEM } from '../modulation/modTargets.js'
import { LFO_SOURCE_0 } from '../modulation/modConstants.js'

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
const SEM_KEY = targetKey(TARGET_SLOT_SEM, 1, 0)

let container = null
let root = null
let frameEl = null
let dropEl = null
let lastSet = null
let cfg = null

function installXleth(routes = []) {
  lastSet = null
  cfg = {
    envs: Array.from({ length: 6 }, () => ({})),
    lfos: Array.from({ length: 6 }, () => ({})),
    velo: { points: [], outputAmount: 1 },
    note: { points: [], outputAmount: 1 },
    envPresent: [true, false, false, false, false, false],
    lfoPresent: [true, false, false, false, false, false],
    routes,
  }
  globalThis.window.xleth = {
    timeline: {
      getSamplerModulation: async () => JSON.parse(JSON.stringify(cfg)),
      setSamplerModulation: async (_id, patch) => {
        lastSet = JSON.parse(JSON.stringify(patch))
        cfg = JSON.parse(JSON.stringify(patch))
        return { routeCount: (patch.routes || []).length, rejectedRoutes: 0 }
      },
    },
  }
}

beforeEach(() => {
  globalThis.HTMLCanvasElement.prototype.getContext = noopCtx
  useSamplerModulationStore.setState({
    regionId: null, config: null, selectedCard: 'lfo0', loading: false, lastCommit: null,
  })
  useSamplerModDragStore.setState({ source: null, label: '', x: 0, y: 0, hoverKey: null })

  frameEl = document.createElement('div')
  frameEl.setAttribute('data-panel-id', 'sampler')
  document.body.appendChild(frameEl)

  // Stands in for a registered knob elsewhere in the panel.
  dropEl = document.createElement('div')
  dropEl.setAttribute('data-mod-target', SEM_KEY)
  document.body.appendChild(dropEl)

  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  frameEl.remove()
  dropEl.remove()
  document.elementFromPoint = undefined
  container = null
  root = null
})

async function mount() {
  await act(async () => { root.render(<SamplerModTray regionId={REGION_ID} bpm={120} />) })
  await act(async () => { await Promise.resolve(); await Promise.resolve() })
}

const tabFor = (label) => Array.from(document.querySelectorAll('.sampler-mod-tab'))
  .find((t) => t.querySelector('.sampler-mod-tab-label')?.textContent.trim() === label)

function mouse(type, init = {}) {
  const ev = new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, clientX: 10, clientY: 10, ...init })
  Object.defineProperty(ev, 'pointerId', { value: 1 })
  return ev
}

// `over` decides what the pointer is currently on: the planted target or nothing.
function aimAt(el) {
  document.elementFromPoint = () => el
}

describe('drag-to-route', () => {
  it('creates a route when a source tab is dragged onto a registered control', async () => {
    installXleth()
    await mount()

    const tab = tabFor('LFO 1')
    expect(tab).toBeTruthy()

    aimAt(null)
    // Press alone does not arm the drag — that is a tab select.
    await act(async () => { tab.dispatchEvent(mouse('pointerdown', { clientX: 10, clientY: 10 })) })
    expect(useSamplerModDragStore.getState().source).toBeNull()

    // A move past the threshold arms it and, landing on the target, hovers it.
    aimAt(dropEl)
    await act(async () => { window.dispatchEvent(mouse('pointermove', { clientX: 40, clientY: 40 })) })
    expect(useSamplerModDragStore.getState().source).toBe(LFO_SOURCE_0)
    expect(useSamplerModDragStore.getState().hoverKey).toBe(SEM_KEY)

    await act(async () => { window.dispatchEvent(mouse('pointerup', { clientX: 40, clientY: 40 })) })
    await act(async () => { await Promise.resolve(); await Promise.resolve() })

    expect(useSamplerModDragStore.getState().source).toBeNull()
    expect(lastSet.routes).toHaveLength(1)
    expect(lastSet.routes[0]).toMatchObject({
      source: LFO_SOURCE_0, target: TARGET_SLOT_SEM, index: 1, stage: 0, bipolar: true,
    })
  })

  it('creates nothing when the drag is released over empty space', async () => {
    installXleth()
    await mount()

    aimAt(null)
    await act(async () => { tabFor('LFO 1').dispatchEvent(mouse('pointerdown', { clientX: 10, clientY: 10 })) })
    await act(async () => { window.dispatchEvent(mouse('pointermove', { clientX: 40, clientY: 40 })) })
    await act(async () => { window.dispatchEvent(mouse('pointerup', { clientX: 40, clientY: 40 })) })
    await act(async () => { await Promise.resolve() })

    expect(lastSet).toBeNull()
    expect(useSamplerModDragStore.getState().source).toBeNull()
  })

  it('a press with no travel selects the tab and starts no drag', async () => {
    installXleth()
    await mount()

    aimAt(null)
    await act(async () => { tabFor('LFO 1').dispatchEvent(mouse('pointerdown', { clientX: 10, clientY: 10 })) })
    await act(async () => { window.dispatchEvent(mouse('pointerup', { clientX: 10, clientY: 10 })) })
    await act(async () => { await Promise.resolve() })

    expect(document.querySelector('.sampler-mod-drag-ghost')).toBeNull()
    expect(useSamplerModDragStore.getState().source).toBeNull()
    expect(lastSet).toBeNull()
  })

  it('shows the dragged source as a ghost once the drag is armed', async () => {
    installXleth()
    await mount()

    expect(document.querySelector('.sampler-mod-drag-ghost')).toBeNull()
    aimAt(null)
    await act(async () => { tabFor('ENV 1').dispatchEvent(mouse('pointerdown', { clientX: 10, clientY: 10 })) })
    // No ghost until travel arms the drag.
    expect(document.querySelector('.sampler-mod-drag-ghost')).toBeNull()
    await act(async () => { window.dispatchEvent(mouse('pointermove', { clientX: 40, clientY: 40 })) })
    const ghost = document.querySelector('.sampler-mod-drag-ghost')
    expect(ghost).toBeTruthy()
    expect(ghost.textContent).toBe('ENV 1')

    await act(async () => { window.dispatchEvent(mouse('pointerup', { clientX: 40, clientY: 40 })) })
    expect(document.querySelector('.sampler-mod-drag-ghost')).toBeNull()
  })

  it('gives VELO and NOTE tabs too', async () => {
    installXleth()
    await mount()
    expect(tabFor('VELO')).toBeTruthy()
    expect(tabFor('NOTE')).toBeTruthy()
  })
})

describe('route list', () => {
  const route = {
    source: LFO_SOURCE_0, target: TARGET_SLOT_SEM, index: 1, stage: 0, amount: 7 / 48, bipolar: true,
  }

  it('lists every route with its source, target and depth', async () => {
    installXleth([route])
    await mount()

    const rows = document.querySelectorAll('.sampler-mod-route')
    expect(rows).toHaveLength(1)
    expect(rows[0].querySelector('.sampler-mod-route-src').textContent).toBe('LFO 1')
    expect(rows[0].querySelector('.sampler-mod-route-dst').textContent).toBe('Slot 2 SEM')
    expect(rows[0].querySelector('.sampler-mod-route-amount').textContent).toBe('±7.0 st')
  })

  it('toggles polarity from the list', async () => {
    installXleth([route])
    await mount()

    const pol = document.querySelector('.sampler-mod-route-pol')
    expect(pol.textContent).toBe('±')
    await act(async () => { pol.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await Promise.resolve() })

    expect(lastSet.routes[0].bipolar).toBe(false)
    expect(document.querySelector('.sampler-mod-route-pol').textContent).toBe('+')
  })

  it('deletes a route from the list', async () => {
    installXleth([route])
    await mount()

    await act(async () => {
      document.querySelector('.sampler-mod-route-del').dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    await act(async () => { await Promise.resolve() })

    expect(lastSet.routes).toHaveLength(0)
    expect(document.querySelectorAll('.sampler-mod-route')).toHaveLength(0)
  })

  it('explains itself when there are no routes', async () => {
    installXleth()
    await mount()
    expect(document.querySelector('.sampler-mod-routes').textContent).toContain('Drag a source tab')
  })
})
