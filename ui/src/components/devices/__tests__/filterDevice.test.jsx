/**
 * @vitest-environment jsdom
 */
// The Xleth Filter as a device.
//
// Pins: hydration from the filter RPCs, the sections in signal order, every value
// printed through formatValue, the full 0..19 type range (the editor clamped to 0..8),
// writes to the exact slot RPCs, the live animation loop (polls only while a
// modulator exists, pushes frames into the DOM without React state, stops on
// unmount), the per-device private store, and that the response canvas drag edits
// cutoff and resonance and commits once on release.
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import FilterDevice from '../FilterDevice.jsx'
import { deviceBodyFor } from '../deviceRegistry.js'
import {
  MAX_MODS_PER_SLOT, MOD_KIND_OFF, MOD_KIND_LFO,
  LIVE_HEADER_FLOATS, LIVE_LANE_OFFSET, LIVE_SLOT_STRIDE, LIVE_STATE_FLOATS,
} from '../../../stores/filterStore.js'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const TARGET = { trackId: 1, nodeId: 2, storeKey: '1' }

function mods(...kinds) {
  return Array.from({ length: MAX_MODS_PER_SLOT }, (_, i) => ({
    index: i,
    kind: kinds[i] ?? MOD_KIND_OFF,
    dest: 0, depth: 1,
    shape: 0, rate_mode: 0, rate_ms: 500, sync: 4, phase: 0,
    attack: 5, hold: 0, decay: 120, sustain: 0.7, release: 200, slides: false,
    dyn_attack: 10, dyn_release: 100, cut_min: 20, cut_max: 20000,
  }))
}

function slot(extra = {}) {
  return {
    index: 0, enabled: true, type: 0, cutoff: 1000, q: 0.7071, gain: 0,
    morph: 0, slope: 1, drive: 0, mix: 1, vowel_a: 0, vowel_b: 1, head: 1,
    mods: mods(), ...extra,
  }
}

// One live payload with slot 0 valid at `cutoff` and lane 0 sitting at `src`.
function livePayload({ cutoff = 1000, src = 0 } = {}) {
  const buf = new Float32Array(LIVE_STATE_FLOATS)
  buf[0] = 1
  buf[1] = 1
  buf[2] = 48000
  const b = LIVE_HEADER_FLOATS
  buf[b + 0] = cutoff
  buf[b + 1] = 0.7071
  buf[b + 5] = 1              // mix
  buf[b + 6] = 1              // valid
  buf[b + LIVE_LANE_OFFSET + 0] = src
  return buf
}

// A manual rAF clock: frames only advance when the test says so.
function installFrameClock() {
  const queued = []
  let now = 0
  globalThis.requestAnimationFrame = (cb) => { queued.push(cb); return queued.length }
  globalThis.cancelAnimationFrame = () => {}
  return {
    async step(ms = 40) {
      now += ms
      const due = queued.splice(0, queued.length)
      await act(async () => {
        due.forEach((cb) => cb(now))
        await Promise.resolve()
        await Promise.resolve()
      })
    },
  }
}

let container
let root
let audio
let served
let getLiveState

function installBridge(payload = livePayload()) {
  getLiveState = vi.fn(async () => payload)
  audio = {
    filterGetSlots: vi.fn(async () => JSON.stringify(served)),
    filterGetResponseCurve: vi.fn(async () => new Float32Array(512)),
    filterGetLiveState: getLiveState,
    filterSetSlotParam: vi.fn(async () => true),
    filterAddSlot: vi.fn(async () => 0),
    filterRemoveSlot: vi.fn(async () => true),
  }
  window.xleth = { audio }
}

const flush = async () => { await act(async () => { await new Promise((r) => setTimeout(r, 0)) }) }
const q = (sel) => container.querySelector(sel)
const aria = (label) => q(`[role="slider"][aria-label="${label}"]`)?.getAttribute('aria-valuetext')
const titles = () => Array.from(container.querySelectorAll('[role="heading"][aria-level="3"]')).map((h) => h.textContent)

async function mount(slots) {
  served = slots
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => { root.render(<FilterDevice target={TARGET} registerApplied={() => {}} />) })
  await flush()
}

beforeEach(() => {
  HTMLCanvasElement.prototype.getContext = () => null
  installBridge()
  document.body.innerHTML = ''
})

afterEach(async () => {
  if (root) await act(async () => { root.unmount() })
  root = null
  container = null
  delete window.xleth
  vi.restoreAllMocks()
})

describe('Xleth Filter device', () => {
  it('is registered for the xlethfilter plugin id', () => {
    expect(deviceBodyFor('xlethfilter')?.Body).toBe(FilterDevice)
  })

  it('hydrates the slots and prints every value through formatValue', async () => {
    await mount([slot({ cutoff: 455, q: 2, drive: 6, mix: 0.5 })])
    expect(audio.filterGetSlots).toHaveBeenCalledWith(1, 2)
    expect(aria('Cutoff')).toBe('Cutoff, 455 Hz')
    expect(aria('Resonance')).toBe('Resonance, 2.00')
    expect(aria('Drive')).toBe('Drive, 6.0 dB')
    expect(aria('Mix')).toBe('Mix, 50 %')
  })

  it('sections run in signal order: Slots, Filter, Tone, Shape, Modulators', async () => {
    await mount([slot()])
    const t = titles()
    const order = ['Slots', 'Filter', 'Tone', 'Shape', 'Modulators'].map((n) => t.indexOf(n))
    expect(order.every((i) => i >= 0)).toBe(true)
    expect([...order].sort((a, b) => a - b)).toEqual(order)
  })

  it('uses the whole type range: a Moog slot is a Moog slot, not Morph', async () => {
    await mount([slot({ type: 9 })])
    expect(q('[aria-label="Filter type"]').textContent).toContain('Moog Ladder')
    expect(container.textContent).toContain('Moog')
  })

  it('shows the type-dependent knob: gain for a peak, morph label for a comb', async () => {
    await mount([slot({ type: 5, gain: 3 })])
    expect(aria('Gain')).toBe('Gain, +3.0 dB')
    await act(async () => { root.unmount() })
    root = null
    await mount([slot({ type: 16 })])
    expect(q('[role="slider"][aria-label="Damp"]')).not.toBeNull()
    expect(q('[role="slider"][aria-label="Gain"]')).toBeNull()
  })

  it('writes a knob nudge to the slot RPC with the slot-relative parameter name', async () => {
    await mount([slot({ cutoff: 1000 })])
    const knob = q('[role="slider"][aria-label="Cutoff"]')
    await act(async () => {
      knob.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }))
    })
    const calls = audio.filterSetSlotParam.mock.calls.filter((c) => c[3] === 'cutoff')
    expect(calls.length).toBeGreaterThan(0)
    expect(calls[calls.length - 1].slice(0, 3)).toEqual([1, 2, 0])
    expect(calls[calls.length - 1][4]).toBeGreaterThan(1000)
  })

  it('has no letter-spaced uppercase labels', async () => {
    await mount([slot({ mods: mods(MOD_KIND_LFO) })])
    const leaves = [...container.querySelectorAll('*')].filter((el) => !el.children.length).map((el) => el.textContent)
    expect(leaves.filter((t) => /[A-Z]{4,}/.test(t))).toEqual([])
  })

  it('keeps one private store per device', async () => {
    served = [slot()]
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    await act(async () => {
      root.render(
        <>
          <FilterDevice target={TARGET} registerApplied={() => {}} />
          <FilterDevice target={{ trackId: 5, nodeId: 9, storeKey: '5' }} registerApplied={() => {}} />
        </>,
      )
    })
    await flush()
    expect(audio.filterGetSlots).toHaveBeenCalledWith(1, 2)
    expect(audio.filterGetSlots).toHaveBeenCalledWith(5, 9)
  })
})

describe('Xleth Filter device: the response display', () => {
  // A painted canvas: a Proxy context and a measured box, so the nodes exist.
  function paintableCanvas() {
    const noop = () => {}
    const ctx = new Proxy({}, {
      get: (t, p) => (p in t ? t[p] : (p === 'measureText' ? () => ({ width: 0 }) : noop)),
      set: (t, p, v) => { t[p] = v; return true },
    })
    HTMLCanvasElement.prototype.getContext = () => ctx
    Object.defineProperty(HTMLCanvasElement.prototype, 'clientWidth', { configurable: true, get: () => 420 })
    Object.defineProperty(HTMLCanvasElement.prototype, 'clientHeight', { configurable: true, get: () => 204 })
    HTMLCanvasElement.prototype.getBoundingClientRect = () => ({ left: 0, top: 0, width: 420, height: 204, right: 420, bottom: 204 })
  }

  afterEach(() => {
    delete HTMLCanvasElement.prototype.clientWidth
    delete HTMLCanvasElement.prototype.clientHeight
  })

  const fire = (el, type, x, y) => {
    el.dispatchEvent(new MouseEvent(type, { bubbles: true, clientX: x, clientY: y, button: 0 }))
  }

  it('dragging a node edits the cutoff and the resonance, and commits on release', async () => {
    paintableCanvas()
    await mount([slot({ cutoff: 1000, q: 0.7071 })])
    const canvas = q('canvas[role="application"]')
    expect(canvas).not.toBeNull()
    // The node of a 12 dB low pass sits near (246, 109) in this 420x204 well.
    await act(async () => { fire(canvas, 'pointerdown', 246, 109) })
    await act(async () => { fire(canvas, 'pointerup', 330, 40) })
    const cutoff = audio.filterSetSlotParam.mock.calls.filter((c) => c[3] === 'cutoff')
    const q2 = audio.filterSetSlotParam.mock.calls.filter((c) => c[3] === 'q')
    expect(cutoff.length).toBe(1)
    expect(cutoff[0][4]).toBeGreaterThan(1000)
    expect(q2.length).toBe(1)
    expect(q2[0][4]).toBeGreaterThan(0.7071)
  })

  it('a click away from every node changes nothing', async () => {
    paintableCanvas()
    await mount([slot()])
    const canvas = q('canvas[role="application"]')
    await act(async () => { fire(canvas, 'pointerdown', 40, 190) })
    await act(async () => { fire(canvas, 'pointerup', 60, 190) })
    expect(audio.filterSetSlotParam).not.toHaveBeenCalled()
  })
})

describe('Xleth Filter device: animating under its own modulators', () => {
  it('does not poll the engine when the filter has no modulator', async () => {
    const clock = installFrameClock()
    await mount([slot()])
    await clock.step()
    await clock.step()
    expect(getLiveState).not.toHaveBeenCalled()
  })

  it('polls once a modulator lane exists', async () => {
    const clock = installFrameClock()
    await mount([slot({ mods: mods(MOD_KIND_LFO) })])
    await clock.step()
    expect(getLiveState).toHaveBeenCalledWith(1, 2)
  })

  it('drives the lane meter and the live knob readout from each frame', async () => {
    const clock = installFrameClock()
    await mount([slot({ mods: mods(MOD_KIND_LFO) })])

    // Lane at full positive swing, cutoff pushed well above the parked 1000 Hz.
    installBridge(livePayload({ cutoff: 8000, src: 1 }))
    served = [slot({ mods: mods(MOD_KIND_LFO) })]
    await clock.step()

    const fill = q('[data-filter-lane-fill]')
    const readout = q('[data-filter-lane-readout]')
    expect(fill).not.toBeNull()
    // An LFO is bipolar: +1 fills the right half, starting at the centre rule.
    expect(parseFloat(fill.style.left)).toBeCloseTo(50, 1)
    expect(parseFloat(fill.style.width)).toBeCloseTo(50, 1)
    expect(readout.textContent).toBe('+1.00')

    // The Cutoff cell prints where the modulator has actually put the knob.
    const live = [...container.querySelectorAll('[data-filter-live-value]')].map((el) => el.textContent).filter(Boolean)
    expect(live).toContain('8.00 kHz')

    installBridge(livePayload({ cutoff: 125, src: -1 }))
    await clock.step()
    expect(parseFloat(fill.style.left)).toBeCloseTo(0, 1)
    expect(readout.textContent).toBe('−1.00')
  })

  it('leaves a knob nothing is moving with a blank live readout', async () => {
    const clock = installFrameClock()
    await mount([slot({ mods: mods(MOD_KIND_LFO) })])
    installBridge(livePayload({ cutoff: 1000, src: 0.4 }))
    await clock.step()
    const cells = [...container.querySelectorAll('[data-filter-live-value]')]
    expect(cells.length).toBeGreaterThan(0)
    expect(cells.every((el) => el.textContent === '')).toBe(true)
  })

  it('only reserves a live row under the knobs a lane is actually aimed at', async () => {
    const clock = installFrameClock()
    // One LFO aimed at Q (dest 1): Q gets the row, Cutoff and Gain do not.
    const lanes = mods(MOD_KIND_LFO)
    lanes[0].dest = 1
    await mount([slot({ type: 5, mods: lanes })])
    await clock.step()
    expect(container.querySelectorAll('[data-filter-live-value]').length).toBe(1)

    await act(async () => { root.unmount() })
    root = null
    await mount([slot()])
    await clock.step()
    expect(container.querySelectorAll('[data-filter-live-value]').length).toBe(0)
  })

  it('stops polling when the device unmounts', async () => {
    const clock = installFrameClock()
    await mount([slot({ mods: mods(MOD_KIND_LFO) })])
    await clock.step()
    const afterFirst = getLiveState.mock.calls.length
    expect(afterFirst).toBeGreaterThan(0)
    await act(async () => { root.unmount() })
    root = null
    await clock.step()
    await clock.step()
    expect(getLiveState.mock.calls.length).toBe(afterFirst)
  })
})
