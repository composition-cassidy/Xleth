/**
 * @vitest-environment jsdom
 *
 * Per-note effects (MANGLE): mounts the REAL SamplerPanelContent against a stubbed
 * window.xleth, opens the Playback view and drives the kit controls, so the whole
 * chain is exercised: engine slot payload -> panel state -> rendered controls ->
 * IPC commit. Commit assertions read the captured IPC payload rather than trusting
 * that a handler fired (window.xleth?.timeline?.foo?.() turns a broken call into a
 * silent no-op).
 */
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import useSamplerModulationStore from '../../../stores/samplerModulationStore.js'
import {
  TARGET_SLOT_MANGLE_AMOUNT, TARGET_SLOT_MANGLE_MIX, TARGET_SLOT_SEM,
} from '../modulation/modTargets.js'
import { REGION_ID, createHarness, makeSlot, stubCanvas } from './samplerHarness.jsx'

const h = createHarness()

// One MANGLE instance, shaped like the engine's slotToJs() chain entry.
function inst(mode, amount = 0, mix = 1, bypass = false) {
  return { mode, amount, mix, bypass }
}

beforeEach(() => {
  stubCanvas()
  vi.stubGlobal('requestAnimationFrame', () => 0)
  vi.stubGlobal('cancelAnimationFrame', () => {})
})
afterEach(async () => { await h.unmount(); vi.unstubAllGlobals() })

async function mount(slots = [makeSlot()]) {
  await h.mount(slots)
  await h.view('Playback')
  return h.container
}

const section = () => h.container.querySelector('[data-section="mangle"]')
const rows = () => [...section().querySelectorAll('[data-mangle-row]')]
const ctl = (row, name) => rows()[row].querySelector(`[data-mangle="${name}"]`)
const addButton = () => section().querySelector('[data-mangle="add"]')
const isActive = () => section().getAttribute('data-active') === 'true'

async function pickMode(row, value) {
  const trigger = rows()[row].querySelector('button[aria-haspopup="listbox"]')
  await act(async () => { trigger.click() })
  const option = document.querySelector(`[role="listbox"] [role="option"][data-value="${value}"]`)
  await act(async () => { option.click() })
  await h.settle()
}

describe('Per-note effects (MANGLE)', () => {
  it('mounts in the Playback view, named and tagged with the slot', async () => {
    await mount()
    expect(section()).toBeTruthy()
    expect(section().textContent).toContain('Per-note effects')
    expect(section().textContent).toContain('Mangle · slot 1')
  })

  it('offers every mode, grouped into the four families, Off first and outside them', async () => {
    await mount()
    const trigger = rows()[0].querySelector('button[aria-haspopup="listbox"]')
    await act(async () => { trigger.click() })
    const list = document.querySelector('[role="listbox"]')
    const groups = [...list.querySelectorAll('[role="presentation"]')].map((g) => g.textContent)
    expect(groups).toEqual(['Alt', 'Filter', 'Distortion', 'Modulation'])
    const options = [...list.querySelectorAll('[role="option"]')]
    expect(options).toHaveLength(36) // 35 playable modes + Off
    expect(options[0].getAttribute('data-value')).toBe('0')
    expect(options[0].textContent).toBe('Off')
    const values = options.map((o) => Number(o.getAttribute('data-value'))).sort((a, b) => a - b)
    expect(values).toEqual(Array.from({ length: 36 }, (_, i) => i))
    await act(async () => { trigger.click() })
  })

  it('renders Amount and Mix value fields with units alongside the mode', async () => {
    await mount()
    expect(ctl(0, 'amount').getAttribute('aria-valuetext')).toBe('Amount, 0 %')
    expect(ctl(0, 'mix').getAttribute('aria-valuetext')).toBe('Mix, 100 %')
  })

  it('starts bypassed for a default slot', async () => {
    await mount()
    expect(isActive()).toBe(false)
    expect(section().textContent).toContain('Bypassed')
    expect(section().textContent).not.toContain('per note')
  })

  it('reads the chain off the slot, not the region', async () => {
    // 18 = Tube. If the panel read the region instead of the slot this would fall back to Off.
    await mount([makeSlot({ mangleChain: [inst(18, 0.5, 0.75)] })])
    expect(rows()[0].getAttribute('data-mode')).toBe('18')
    expect(isActive()).toBe(true)
    expect(section().textContent).toContain('per note')
  })

  it('goes quiet when an instance mixes 0, matching the engine gate', async () => {
    await mount([makeSlot({ mangleChain: [inst(18, 1, 0)] })])
    expect(rows()[0].getAttribute('data-mode')).toBe('18')
    expect(isActive()).toBe(false)
  })

  it('goes quiet when the only instance is bypassed', async () => {
    await mount([makeSlot({ mangleChain: [inst(18, 1, 1, true)] })])
    expect(isActive()).toBe(false)
  })

  it('follows the selected slot', async () => {
    await mount([makeSlot(), makeSlot({ name: 'Layer 2', mangleChain: [inst(14)] })])
    expect(rows()[0].getAttribute('data-mode')).toBe('0')
    const tab = h.container.querySelector('[role="tab"][aria-label^="Slot 2"]')
    await act(async () => { tab.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true })) })
    await h.settle()
    expect(rows()[0].getAttribute('data-mode')).toBe('14')
    expect(section().textContent).toContain('Mangle · slot 2')
  })

  it('commits a mode change as the full chain array with the slot index attached', async () => {
    await mount()
    await pickMode(0, 20) // Hard Clip
    const write = h.lastCommit('mangleChain')
    expect(write, 'a mangleChain commit should have reached IPC').toBeTruthy()
    expect(write.regionId).toBe(REGION_ID)
    expect(write.payload.mangleChain).toHaveLength(1)
    expect(write.payload.mangleChain[0].mode).toBe(20)
    expect(write.payload.slotIndex).toBe(0)
  })

  it('becomes active immediately after a mode is picked', async () => {
    await mount()
    await pickMode(0, 18)
    expect(isActive()).toBe(true)
    expect(section().textContent).not.toContain('Bypassed')
  })

  it('shows the per-mode hint for a single-instance chain', async () => {
    await mount([makeSlot({ mangleChain: [inst(1)] })]) // Sync
    expect(section().textContent).toContain('hard sync')
  })

  it('an amount nudge commits the chain once', async () => {
    await mount([makeSlot({ mangleChain: [inst(18, 0.5, 1)] })])
    await h.key(ctl(0, 'amount'), 'ArrowUp')
    const write = h.lastCommit('mangleChain')
    expect(write.payload.mangleChain[0].amount).toBeCloseTo(0.51)
    expect(write.payload.mangleChain[0].mode).toBe(18)
  })

  it('adds an instance via the + control, up to the cap', async () => {
    await mount([makeSlot({ mangleChain: [inst(18)] })])
    expect(rows()).toHaveLength(1)
    await h.click(addButton())
    expect(rows()).toHaveLength(2)
    const write = h.lastCommit('mangleChain')
    expect(write.payload.mangleChain).toHaveLength(2)
    expect(write.payload.mangleChain[0].mode).toBe(18)
    expect(write.payload.mangleChain[1].mode).toBe(0)
    await h.click(addButton())
    await h.click(addButton())
    expect(rows()).toHaveLength(4)
    expect(addButton().disabled).toBe(true)
  })

  it('bypasses one instance without disturbing the others', async () => {
    await mount([makeSlot({ mangleChain: [inst(18, 0.5, 0.75), inst(14, 0.3, 1)] })])
    const on = ctl(0, 'on')
    expect(on.getAttribute('aria-pressed')).toBe('true')
    await h.click(on)
    const write = h.lastCommit('mangleChain')
    expect(write.payload.mangleChain[0].bypass).toBe(true)
    expect(write.payload.mangleChain[0].mode).toBe(18)
    expect(write.payload.mangleChain[1].bypass).toBe(false)
  })

  it('removes an instance', async () => {
    await mount([makeSlot({ mangleChain: [inst(18), inst(14)] })])
    await h.click(ctl(0, 'remove'))
    expect(rows()).toHaveLength(1)
    const write = h.lastCommit('mangleChain')
    expect(write.payload.mangleChain).toHaveLength(1)
    expect(write.payload.mangleChain[0].mode).toBe(14)
  })

  it('reorders instances, which the engine renders in order', async () => {
    await mount([makeSlot({ mangleChain: [inst(20, 0.7, 1), inst(14, 0.5, 1)] })])
    expect(ctl(0, 'up').disabled).toBe(true)
    expect(ctl(0, 'down').disabled).toBe(false)
    await h.click(ctl(0, 'down'))
    expect(h.lastCommit('mangleChain').payload.mangleChain.map((m) => m.mode)).toEqual([14, 20])
  })

  // A MANGLE route addresses its control by chain POSITION ({target, slot, stage}),
  // so a chain edit that left the routes alone would re-point them at whatever mode
  // moved into that position. Seed through the store's own load().
  async function seedRoutes(routes) {
    h.modRoutes = routes
    await act(async () => { await useSamplerModulationStore.getState().load(REGION_ID) })
  }
  const storedRoutes = () => useSamplerModulationStore.getState().config.routes

  it('carries a MANGLE route with its instance across a reorder', async () => {
    await mount([makeSlot({ mangleChain: [inst(1, 0.5, 1), inst(7, 1, 1)] })])
    await seedRoutes([
      { source: 0, target: TARGET_SLOT_MANGLE_AMOUNT, index: 0, stage: 0, amount: 0.5, bipolar: false },
      { source: 0, target: TARGET_SLOT_SEM, index: 0, stage: 0, amount: 0.5, bipolar: false },
    ])
    await h.click(ctl(0, 'down'))
    expect(h.lastCommit('mangleChain').payload.mangleChain.map((m) => m.mode)).toEqual([7, 1])
    expect(storedRoutes()[0].stage).toBe(1)
    expect(storedRoutes()[1].target).toBe(TARGET_SLOT_SEM)
    expect(storedRoutes()[1].stage).toBe(0)
  })

  it('drops the routes of a deleted instance and shifts the later ones down', async () => {
    await mount([makeSlot({ mangleChain: [inst(1, 0.5, 1), inst(7, 1, 1)] })])
    await seedRoutes([
      { source: 0, target: TARGET_SLOT_MANGLE_AMOUNT, index: 0, stage: 0, amount: 0.5, bipolar: false },
      { source: 1, target: TARGET_SLOT_MANGLE_MIX, index: 0, stage: 1, amount: 0.5, bipolar: false },
    ])
    await h.click(ctl(0, 'remove'))
    expect(storedRoutes()).toHaveLength(1)
    expect(storedRoutes()[0].target).toBe(TARGET_SLOT_MANGLE_MIX)
    expect(storedRoutes()[0].stage).toBe(0)
  })

  it('a routed Amount shows its modulation band and is a drop target', async () => {
    await mount([makeSlot({ mangleChain: [inst(18, 0.5, 1)] })])
    await seedRoutes([
      { source: 6, target: TARGET_SLOT_MANGLE_AMOUNT, index: 0, stage: 0, amount: 0.25, bipolar: true },
    ])
    await h.settle()
    const amount = ctl(0, 'amount')
    expect(amount.getAttribute('data-mod-target')).toBe(`${TARGET_SLOT_MANGLE_AMOUNT}:0:0`)
    expect(amount.querySelector('[data-mod-ring]')).not.toBeNull()
  })

  it('shows the ordered chain summary for multiple active instances', async () => {
    await mount([makeSlot({ mangleChain: [inst(18, 0.8, 1), inst(14, 0.4, 1)] })])
    expect(section().textContent).toContain('Tube → LPF')
  })
})

describe('Playback strips', () => {
  it('lay out in signal order: Voice, Glide, Arpeggiator, Per-note effects', async () => {
    await mount()
    const order = [...h.container.querySelectorAll('[data-section]')].map((e) => e.getAttribute('data-section'))
    expect(order).toEqual(['voice', 'glide', 'arp', 'mangle'])
  })

  it('voicing, glide and arpeggiator controls commit their region fields', async () => {
    await mount()
    const mono = [...h.container.querySelectorAll('[data-field="monoEnabled"] button')].find((b) => b.textContent.trim() === 'Mono')
    await h.click(mono)
    expect(h.lastCommit('monoEnabled').payload.monoEnabled).toBe(true)
    await h.click(h.container.querySelector('[data-field="legatoEnabled"]'))
    expect(h.lastCommit('legatoEnabled').payload.legatoEnabled).toBe(true)
    await h.key(h.slider('Time'), 'ArrowUp')
    expect(h.lastCommit('portamentoTimeMs').payload).toMatchObject({ portamentoEnabled: true })
    await h.click(h.container.querySelector('[data-field="arpEnabled"]'))
    expect(h.lastCommit('arpEnabled').payload.arpEnabled).toBe(true)
    const down = h.container.querySelector('[data-field="arpDirection"] button[aria-label="Down"]')
    await h.click(down)
    expect(h.lastCommit('arpDirection').payload.arpDirection).toBe(1)
    await h.key(h.slider('Gate'), 'ArrowDown')
    expect(h.lastCommit('arpGate').payload.arpGate).toBeCloseTo(0.79)
  })

  it('voices commit 1..32 in poly', async () => {
    await mount()
    await h.key(h.slider('Voices'), 'ArrowDown')
    expect(h.lastCommit('voiceCount').payload.voiceCount).toBe(31)
  })

  it('switching arp sync off reveals the millisecond rate', async () => {
    await mount()
    expect(h.slider('Rate')).toBeNull()
    await h.click(h.container.querySelector('[data-field="arpTempoSync"]'))
    expect(h.lastCommit('arpTempoSync').payload.arpTempoSync).toBe(false)
    expect(h.slider('Rate').getAttribute('aria-valuetext')).toBe('Rate, 125 ms')
  })
})
