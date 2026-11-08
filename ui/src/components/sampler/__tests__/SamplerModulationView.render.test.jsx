/**
 * @vitest-environment jsdom
 *
 * The Modulation view (it replaced the pull-out tray, whose handle sat off-screen
 * in the docked shell): sources, add / remove, drag-to-route (including holding a
 * drag over another view's tab), the route list and the keyboard "Add route".
 * Mounted for real; writes are read from the stubbed bridge.
 */
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import useSamplerModDragStore from '../../../stores/samplerModDragStore.js'
import useSamplerModulationStore from '../../../stores/samplerModulationStore.js'
import { LFO_SOURCE_0 } from '../modulation/modConstants.js'
import { TARGET_SLOT_SEM, TARGET_SRC_AMOUNT } from '../modulation/modTargets.js'
import { createHarness, makeSlot, stubCanvas } from './samplerHarness.jsx'

const h = createHarness()
const LFO1 = { lfoPresent: [true, false, false, false, false, false] }

beforeEach(() => {
  stubCanvas()
  vi.stubGlobal('requestAnimationFrame', () => 0)
  vi.stubGlobal('cancelAnimationFrame', () => {})
  useSamplerModulationStore.setState({ regionId: null, config: null, loading: false, lastCommit: null })
  useSamplerModDragStore.setState({ source: null, label: '', x: 0, y: 0, hoverKey: null })
})
afterEach(async () => {
  await h.unmount()
  document.elementFromPoint = undefined
  vi.unstubAllGlobals()
})

async function mount(modBase = LFO1, slots = [makeSlot()]) {
  await h.mount(slots, {}, modBase)
  await h.view('Modulation')
}

const sourceTab = (label) => [...h.container.querySelectorAll('[role="tablist"][aria-label="Modulation sources"] [role="tab"]')]
  .find((t) => t.firstChild?.textContent?.trim() === label || t.textContent.trim().replace(/\d+$/, '') === label)
const lastSet = () => h.modSets[h.modSets.length - 1] || null
function mouse(type, init = {}) {
  const ev = new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, clientX: 10, clientY: 10, ...init })
  Object.defineProperty(ev, 'pointerId', { value: 1 })
  return ev
}
const aimAt = (el) => { document.elementFromPoint = () => el }
const ghost = () => [...document.body.querySelectorAll('div[aria-hidden="true"]')].find((d) => d.style.left && d.style.top && d.className)

describe('sources', () => {
  it('shows Env 1 (permanent), the present LFOs, Velocity and Note, in sentence case', async () => {
    await mount()
    for (const label of ['Env 1', 'LFO 1', 'Velocity', 'Note']) expect(sourceTab(label), label).toBeTruthy()
    expect(h.container.querySelector('[aria-label="Remove Env 1 and its routes"]')).toBeNull()
    expect(h.container.querySelector('[aria-label="Remove LFO 1 and its routes"]')).toBeTruthy()
    // Env 1 opens first, on the kit editor.
    expect(h.container.querySelector('[data-editor="env"]')).toBeTruthy()
  })

  it('Add an envelope commits its presence and opens it', async () => {
    await mount()
    await h.click(h.container.querySelector('[aria-label="Add an envelope"]'))
    expect(lastSet().envPresent.slice(0, 2)).toEqual([true, true])
    expect(sourceTab('Env 2').getAttribute('aria-selected')).toBe('true')
  })

  it('disables Add an envelope when all six are present', async () => {
    await mount({ envPresent: [true, true, true, true, true, true] })
    expect(h.container.querySelector('[aria-label="Add an envelope"]').disabled).toBe(true)
  })

  it('removing an LFO commits its removal', async () => {
    await mount()
    await h.click(h.container.querySelector('[aria-label="Remove LFO 1 and its routes"]'))
    expect(lastSet().lfoPresent[0]).toBe(false)
  })

  it('opens the LFO editor (drawable canvas) and the response editors', async () => {
    await mount()
    await act(async () => { sourceTab('LFO 1').dispatchEvent(mouse('pointerdown')) })
    await act(async () => { window.dispatchEvent(mouse('pointerup')) })
    await h.settle()
    const lfo = h.container.querySelector('[data-editor="lfo"]')
    expect(lfo).toBeTruthy()
    expect(lfo.querySelector('canvas')).toBeTruthy()
    await act(async () => { sourceTab('Velocity').dispatchEvent(mouse('pointerdown')) })
    await act(async () => { window.dispatchEvent(mouse('pointerup')) })
    await h.settle()
    expect(h.container.querySelector('[data-editor="curve"]')).toBeTruthy()
  })

  it('an editor knob previews locally and commits the config once', async () => {
    await mount()
    const before = h.modSets.length
    await h.key(h.slider('Attack'), 'ArrowUp')
    expect(h.modSets.length).toBe(before + 1)
    expect(lastSet().envs[0].attack.ms).toBeGreaterThan(0)
  })
})

describe('drag-to-route', () => {
  it('a press with no travel selects the tab and starts no drag', async () => {
    await mount()
    aimAt(null)
    await act(async () => { sourceTab('LFO 1').dispatchEvent(mouse('pointerdown')) })
    await act(async () => { window.dispatchEvent(mouse('pointerup')) })
    await h.settle()
    expect(useSamplerModDragStore.getState().source).toBeNull()
    expect(sourceTab('LFO 1').getAttribute('aria-selected')).toBe('true')
  })

  it('drops a source on a registered control in this view', async () => {
    await mount()
    const out = h.container.querySelector('[data-env-field="outputAmount"]')
    expect(out.getAttribute('data-mod-target')).toBe(`${TARGET_SRC_AMOUNT}:0:0`)
    aimAt(null)
    await act(async () => { sourceTab('LFO 1').dispatchEvent(mouse('pointerdown')) })
    aimAt(out)
    await act(async () => { window.dispatchEvent(mouse('pointermove', { clientX: 40, clientY: 40 })) })
    expect(useSamplerModDragStore.getState().source).toBe(LFO_SOURCE_0)
    expect(ghost()?.textContent).toBe('LFO 1')
    await act(async () => { window.dispatchEvent(mouse('pointerup', { clientX: 40, clientY: 40 })) })
    await h.settle()
    expect(lastSet().routes).toHaveLength(1)
    expect(lastSet().routes[0]).toMatchObject({ source: LFO_SOURCE_0, target: TARGET_SRC_AMOUNT, index: 0, bipolar: true })
  })

  it('holding a drag over the Main tab opens Main, where the source can be dropped', async () => {
    await mount()
    aimAt(null)
    await act(async () => { sourceTab('LFO 1').dispatchEvent(mouse('pointerdown')) })
    aimAt(h.tab('Main'))
    await act(async () => { window.dispatchEvent(mouse('pointermove', { clientX: 60, clientY: 5 })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 450)) })
    await h.settle()
    const semi = h.slider('Semi')
    expect(semi, 'Main view should have opened').toBeTruthy()
    aimAt(semi)
    await act(async () => { window.dispatchEvent(mouse('pointermove', { clientX: 61, clientY: 6 })) })
    await act(async () => { window.dispatchEvent(mouse('pointerup', { clientX: 61, clientY: 6 })) })
    await h.settle()
    expect(lastSet().routes[0]).toMatchObject({ source: LFO_SOURCE_0, target: TARGET_SLOT_SEM, index: 0 })
    // The routed box now draws its modulated range.
    expect(h.slider('Semi').querySelector('[data-mod-ring]')).not.toBeNull()
  })

  it('creates nothing when released over empty space', async () => {
    await mount()
    aimAt(null)
    await act(async () => { sourceTab('LFO 1').dispatchEvent(mouse('pointerdown')) })
    await act(async () => { window.dispatchEvent(mouse('pointermove', { clientX: 40, clientY: 40 })) })
    await act(async () => { window.dispatchEvent(mouse('pointerup', { clientX: 40, clientY: 40 })) })
    await h.settle()
    expect(lastSet()).toBeNull()
  })
})

describe('route list', () => {
  const route = { source: LFO_SOURCE_0, target: TARGET_SLOT_SEM, index: 0, stage: 0, amount: 0.25, bipolar: false }

  it('lists each route with sentence-case names and its depth in the target unit', async () => {
    h.modRoutes = []
    await mount({ ...LFO1 })
    h.modRoutes = [route]
    await act(async () => { await useSamplerModulationStore.getState().load(7) })
    const row = h.container.querySelector('[data-route="0"]')
    expect(row.textContent).toContain('LFO 1 → Slot 1 semitones')
    expect(row.querySelector('[data-route-field="amount"]').getAttribute('aria-valuetext')).toContain('+12.0 st')
  })

  it('toggles polarity, nudges depth and deletes, each one commit', async () => {
    await mount({ ...LFO1 })
    h.modRoutes = [route]
    await act(async () => { await useSamplerModulationStore.getState().load(7) })
    await h.click(h.container.querySelector('[data-route="0"] [data-route-field="bipolar"]'))
    expect(lastSet().routes[0].bipolar).toBe(true)
    await h.key(h.container.querySelector('[data-route="0"] [data-route-field="amount"]'), 'ArrowUp')
    expect(lastSet().routes[0].amount).toBeCloseTo(0.26)
    await h.click(h.container.querySelector('[data-route="0"] [data-route-field="delete"]'))
    expect(lastSet().routes).toHaveLength(0)
  })

  it('explains itself when there are no routes', async () => {
    await mount()
    expect(h.container.querySelector('[data-section="routes"]').textContent).toContain('No routes')
  })

  it('Add route makes a route from the keyboard, the same as a drop', async () => {
    await mount()
    // Defaults: the first source (Env 1) and the first target (Slot 1 semitones).
    await h.click(h.container.querySelector('[data-route-field="add"]'))
    expect(lastSet().routes[0]).toMatchObject({ source: 0, target: TARGET_SLOT_SEM, index: 0, stage: 0 })
  })
})
