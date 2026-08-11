import { beforeEach, describe, expect, it, vi } from 'vitest'
import useFilterStore, { typeUsesGain, typeUsesMorph, typeUsesSlope } from './filterStore.js'

// Pins the Xleth Filter store's slot lifecycle against a stubbed bridge: add
// appends and selects, remove is optimistic, param writes are optimistic and
// hit the right RPC, and the cut_min/cut_max pair can never cross. Mirrors the
// apexStore test's stubbed-bridge shape.

function installBridge(initialSlots = []) {
  const calls = []
  const state = { slots: initialSlots.map((s, i) => ({ index: i, ...s })) }
  globalThis.window = {
    innerWidth: 1600,
    innerHeight: 900,
    xleth: {
      audio: {
        filterGetSlots: vi.fn(async () => JSON.stringify(state.slots)),
        filterAddSlot: vi.fn(async () => {
          const idx = state.slots.length
          state.slots.push({ index: idx, enabled: true, type: 0, cutoff: 1000, q: 0.7071, gain: 0, morph: 0, slope: 1, drive: 0, mix: 1, cut_min: 20, cut_max: 20000, dyn_depth: 0, dyn_attack: 10, dyn_release: 100 })
          calls.push(['add'])
          return idx
        }),
        filterRemoveSlot: vi.fn(async (t, n, slotIndex) => {
          state.slots.splice(slotIndex, 1)
          state.slots.forEach((s, i) => { s.index = i })
          calls.push(['remove', slotIndex])
          return true
        }),
        filterSetSlotParam: vi.fn(async (t, n, slotIndex, name, value) => {
          if (state.slots[slotIndex]) state.slots[slotIndex][name] = value
          calls.push(['setParam', slotIndex, name, value])
          return true
        }),
        filterGetResponseCurve: vi.fn(async () => new Float32Array(512)),
      },
    },
  }
  return { calls, state }
}

describe('filterStore type gating helpers', () => {
  it('gain shows only for peak/shelf types', () => {
    expect([0, 1, 2, 3, 4, 8].some(typeUsesGain)).toBe(false)
    expect([5, 6, 7].every(typeUsesGain)).toBe(true)
  })
  it('morph shows only for the morph type', () => {
    expect(typeUsesMorph(8)).toBe(true)
    expect([0, 1, 2, 3, 4, 5, 6, 7].some(typeUsesMorph)).toBe(false)
  })
  it('slope applies to lp/hp/bp/notch/morph only', () => {
    expect([0, 1, 2, 3, 8].every(typeUsesSlope)).toBe(true)
    expect([4, 5, 6, 7].some(typeUsesSlope)).toBe(false)
  })
})

describe('filterStore slot lifecycle', () => {
  beforeEach(() => {
    vi.resetModules()
    useFilterStore.getState().close()
  })

  it('open hydrates slots from the bridge', async () => {
    installBridge([{ enabled: true, type: 2, cutoff: 800 }])
    useFilterStore.getState().open(7, 4, '7')
    // open() kicks off an async fetch; await a microtask flush.
    await Promise.resolve(); await Promise.resolve()
    const st = useFilterStore.getState()
    expect(st.target).toEqual({ trackId: 7, nodeId: 4, storeKey: '7' })
    expect(st.slots).toHaveLength(1)
    expect(st.slots[0].cutoff).toBe(800)
  })

  it('addSlot appends via the bridge and selects the new slot', async () => {
    const { calls } = installBridge([])
    useFilterStore.setState({ target: { trackId: 1, nodeId: 2, storeKey: '1' }, slots: [], selectedSlotIndex: -1 })
    await useFilterStore.getState().addSlot()
    const st = useFilterStore.getState()
    expect(st.slots).toHaveLength(1)
    expect(st.selectedSlotIndex).toBe(0)
    expect(calls.filter(c => c[0] === 'add')).toHaveLength(1)
  })

  it('removeSlot is optimistic and calls the bridge', async () => {
    const { calls } = installBridge([{ type: 0 }, { type: 1 }])
    useFilterStore.setState({ target: { trackId: 1, nodeId: 2, storeKey: '1' }, slots: [{ index: 0, type: 0 }, { index: 1, type: 1 }], selectedSlotIndex: 1 })
    await useFilterStore.getState().removeSlot(0)
    const st = useFilterStore.getState()
    expect(st.slots).toHaveLength(1)
    expect(calls.some(c => c[0] === 'remove' && c[1] === 0)).toBe(true)
  })

  it('setSlotParam updates optimistically and writes the raw value', async () => {
    const { calls } = installBridge([{ type: 0, cutoff: 1000 }])
    useFilterStore.setState({ target: { trackId: 1, nodeId: 2, storeKey: '1' }, slots: [{ index: 0, type: 0, cutoff: 1000 }], selectedSlotIndex: 0 })
    await useFilterStore.getState().setSlotParam(0, 'cutoff', 440)
    expect(useFilterStore.getState().slots[0].cutoff).toBe(440)
    expect(calls.some(c => c[0] === 'setParam' && c[2] === 'cutoff' && c[3] === 440)).toBe(true)
  })

  it('cut_min is clamped below cut_max before writing', async () => {
    const { calls } = installBridge([{ cut_min: 200, cut_max: 2000 }])
    useFilterStore.setState({ target: { trackId: 1, nodeId: 2, storeKey: '1' }, slots: [{ index: 0, cut_min: 200, cut_max: 2000 }], selectedSlotIndex: 0 })
    // Try to shove cut_min past cut_max — it must land strictly below.
    await useFilterStore.getState().setCutMin(0, 5000)
    const written = calls.find(c => c[0] === 'setParam' && c[2] === 'cut_min')
    expect(written[3]).toBeLessThan(2000)
    expect(useFilterStore.getState().slots[0].cut_min).toBeLessThan(2000)
  })

  it('cut_max is clamped above cut_min before writing', async () => {
    const { calls } = installBridge([{ cut_min: 200, cut_max: 2000 }])
    useFilterStore.setState({ target: { trackId: 1, nodeId: 2, storeKey: '1' }, slots: [{ index: 0, cut_min: 200, cut_max: 2000 }], selectedSlotIndex: 0 })
    await useFilterStore.getState().setCutMax(0, 50)
    const written = calls.find(c => c[0] === 'setParam' && c[2] === 'cut_max')
    expect(written[3]).toBeGreaterThan(200)
  })
})
