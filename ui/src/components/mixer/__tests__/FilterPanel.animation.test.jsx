/**
 * @vitest-environment jsdom
 */
// The XLETH Filter panel animating under its OWN modulators.
//
// What this pins is the loop, not the drawing: the panel must poll
// audio_filterGetLiveState while a modulator exists, must NOT poll when the
// filter is only knobs, must stop the moment it unmounts, and must push each
// frame into the DOM without re-rendering through React state. The response
// curve itself is a canvas and is verified by the engine test that owns the
// payload (engine/test/test_xlethfilter_mod.cpp, case m).
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import FilterPanel from '../FilterPanel.jsx'
import useFilterStore, {
  MAX_MODS_PER_SLOT, MOD_KIND_OFF, MOD_KIND_LFO,
  LIVE_HEADER_FLOATS, LIVE_LANE_OFFSET, LIVE_SLOT_STRIDE, LIVE_STATE_FLOATS,
} from '../../../stores/filterStore.js'

// jsdom has no canvas backend; the well simply does not paint, which is fine —
// nothing here asserts on pixels.
function stubCanvas() {
  const noop = () => {}
  const ctx = new Proxy({}, {
    get: (target, prop) => {
      if (prop in target) return target[prop]
      if (prop === 'measureText') return () => ({ width: 0 })
      if (prop === 'createLinearGradient' || prop === 'createRadialGradient') {
        return () => ({ addColorStop: noop })
      }
      return noop
    },
    set: (target, prop, value) => { target[prop] = value; return true },
  })
  HTMLCanvasElement.prototype.getContext = () => ctx
}

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
  const b = LIVE_HEADER_FLOATS + 0 * LIVE_SLOT_STRIDE
  buf[b + 0] = cutoff
  buf[b + 1] = 0.7071
  buf[b + 5] = 1              // mix
  buf[b + 6] = 1              // valid
  buf[b + LIVE_LANE_OFFSET + 0] = src
  return buf
}

// A manual rAF clock: frames only advance when the test says so, so nothing
// here depends on wall time.
function installFrameClock() {
  const queued = []
  let now = 0
  globalThis.requestAnimationFrame = (cb) => { queued.push(cb); return queued.length }
  globalThis.cancelAnimationFrame = () => {}
  return {
    // One rAF turn. The panel throttles to ~33 ms, so the clock steps past it.
    async step(ms = 40) {
      now += ms
      const due = queued.splice(0, queued.length)
      await act(async () => {
        due.forEach(cb => cb(now))
        // Let the awaited fetchLiveState settle inside the same act().
        await Promise.resolve()
        await Promise.resolve()
      })
    },
    get pending() { return queued.length },
  }
}

let container
let root
let getLiveState

function installBridge(payload = livePayload()) {
  getLiveState = vi.fn(async () => payload)
  globalThis.window.xleth = {
    audio: {
      filterGetSlots: vi.fn(async () => '[]'),
      filterGetResponseCurve: vi.fn(async () => new Float32Array(512)),
      filterGetLiveState: getLiveState,
      filterSetSlotParam: vi.fn(async () => true),
    },
  }
}

async function mount(slots) {
  useFilterStore.setState({
    target: { trackId: 1, nodeId: 2, storeKey: '1' },
    slots,
    selectedSlotIndex: 0,
  })
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => { root.render(<FilterPanel />) })
}

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  stubCanvas()
  installBridge()
  document.body.innerHTML = ''
})

afterEach(async () => {
  if (root) await act(async () => { root.unmount() })
  root = null
  container = null
  useFilterStore.setState({ target: null, slots: [], selectedSlotIndex: -1 })
  vi.restoreAllMocks()
})

describe('FilterPanel — animating under its own modulators', () => {
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
    await clock.step()

    const fill = container.querySelector('.filter-mod-live-fill')
    const readout = container.querySelector('.filter-mod-live-readout')
    expect(fill).not.toBeNull()
    // An LFO is bipolar: +1 fills the right half, starting at the centre rule.
    expect(parseFloat(fill.style.left)).toBeCloseTo(50, 1)
    expect(parseFloat(fill.style.width)).toBeCloseTo(50, 1)
    expect(readout.textContent).toBe('+1.00')

    // The CUTOFF cell prints where the modulator has actually put the knob.
    const live = [...container.querySelectorAll('.filter-knob-live')]
      .map(el => el.textContent).filter(Boolean)
    expect(live).toContain('8 kHz')

    // Now swing the other way; the same nodes are rewritten in place.
    installBridge(livePayload({ cutoff: 125, src: -1 }))
    await clock.step()
    expect(parseFloat(fill.style.left)).toBeCloseTo(0, 1)
    expect(readout.textContent).toBe('-1.00')
  })

  it('leaves a knob nothing is moving with a blank live readout', async () => {
    const clock = installFrameClock()
    await mount([slot({ mods: mods(MOD_KIND_LFO) })])
    // Cutoff exactly where the knob is parked.
    installBridge(livePayload({ cutoff: 1000, src: 0.4 }))
    await clock.step()

    const cells = [...container.querySelectorAll('.filter-knob-live')]
    expect(cells.length).toBeGreaterThan(0)
    expect(cells.every(el => el.textContent === '')).toBe(true)
  })

  it('only reserves a live row under the knobs a lane is actually aimed at', async () => {
    const clock = installFrameClock()
    // One LFO, pointed at Q (dest 1) — so Q gets the row and CUTOFF does not.
    const lanes = mods(MOD_KIND_LFO)
    lanes[0].dest = 1
    await mount([slot({ type: 5, mods: lanes })])   // Peak, so GAIN is on screen too
    await clock.step()

    const rows = [...container.querySelectorAll('.filter-knob-cell')]
      .filter(cell => cell.querySelector('.filter-knob-live'))
      .map(cell => cell.querySelector('.pluginui-knob')?.textContent ?? '')
    expect(rows.length).toBe(1)

    // ...and a slot with no modulator at all renders no live rows anywhere,
    // exactly as the panel did before any of this existed.
    await act(async () => { root.unmount() })
    root = null
    await mount([slot()])
    await clock.step()
    expect(container.querySelectorAll('.filter-knob-live').length).toBe(0)
  })

  it('stops polling when the panel closes', async () => {
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
