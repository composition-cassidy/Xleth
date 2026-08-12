import { beforeEach, describe, expect, it, vi } from 'vitest'
import useFilterStore, {
  typeUsesGain, typeUsesMorph, typeUsesSlope,
  typeGainLabel, typeGainRange, typeMorphLabel,
  SLOT_TYPES, VOWELS, MOD_DESTS, LFO_SHAPES, LFO_SYNC_DIVISIONS,
  MOD_KINDS, MOD_KIND_OFF, MOD_KIND_LFO, MOD_KIND_ENV, MOD_KIND_DYN,
  MAX_MODS_PER_SLOT, activeMods, laneParam, modKindLabel,
} from './filterStore.js'

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
  it('the character types have a fixed topology, so no slope control', () => {
    expect([9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19].some(typeUsesSlope)).toBe(false)
  })
  it('tilt reuses gain, and combs/formant reuse morph', () => {
    expect(typeUsesGain(19)).toBe(true)
    expect([16, 17, 18].every(typeUsesMorph)).toBe(true)
    // ...and the ladders/Sallen-Key/Steiner use neither.
    expect([9, 10, 11, 12, 13, 14, 15].some(typeUsesGain)).toBe(false)
    expect([9, 10, 11, 12, 13, 14, 15].some(typeUsesMorph)).toBe(false)
  })
  it('the reused knobs are captioned and ranged for what they actually do', () => {
    expect(typeGainLabel(19)).toBe('TILT')
    expect(typeGainRange(19)).toEqual({ min: -12, max: 12 })
    expect(typeGainLabel(5)).toBe('GAIN')
    expect(typeGainRange(5)).toEqual({ min: -24, max: 24 })
    expect(typeMorphLabel(16)).toBe('DAMP')
    expect(typeMorphLabel(17)).toBe('DAMP')
    expect(typeMorphLabel(18)).toBe('VOWEL')
    expect(typeMorphLabel(8)).toBe('MORPH')
  })
})

describe('filterStore slot-type enum (wire contract with the engine)', () => {
  // The value IS what the engine serializes into the project, so this pins the
  // order: appending is fine, reordering silently rewrites saved filters.
  it('slot types are a dense 0..19 list in engine order', () => {
    expect(SLOT_TYPES.map(t => t.value)).toEqual(
      [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19])
  })
  it('the original nine types keep their original ids', () => {
    expect(SLOT_TYPES.slice(0, 9).map(t => t.id)).toEqual([
      'lp12', 'hp12', 'bp', 'notch', 'allpass', 'peak', 'lowshelf',
      'highshelf', 'morph',
    ])
  })
  it('the character types are appended in XlethFilterEffect::SlotType order', () => {
    expect(SLOT_TYPES.slice(9).map(t => t.id)).toEqual([
      'moog24', 'acid303', 'sk12', 'sk24', 'steinerLP', 'steinerBP',
      'steinerHP', 'combFF', 'combFB', 'formant', 'tilt',
    ])
  })
  it('vowels match xleth_filter::Vowel order', () => {
    expect(VOWELS.map(v => v.value)).toEqual([0, 1, 2, 3])
    expect(VOWELS.map(v => v.label)).toEqual(['ee', 'ah', 'oh', 'oo'])
  })
})

describe('filterStore modulator enums (wire contract with the engine)', () => {
  it('mod destinations match XlethFilterEffect::ModDest order', () => {
    expect(MOD_DESTS.map(d => d.value)).toEqual([0, 1, 2, 3, 4, 5])
    expect(MOD_DESTS.map(d => d.label)).toEqual(['Cutoff', 'Q', 'Gain', 'Morph', 'Drive', 'Mix'])
  })
  it('LFO shapes match XlethFilterEffect::LfoWave order', () => {
    expect(LFO_SHAPES.map(s => s.value)).toEqual([0, 1, 2, 3, 4, 5])
  })
  it('sync divisions mirror the FX-graph LFO set', () => {
    expect(LFO_SYNC_DIVISIONS.map(d => d.value)).toEqual([0.125, 0.25, 0.5, 1, 2, 4, 8, 16, 32, 64])
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

  it('lane params round-trip through setModParam under their m{j}_ name', async () => {
    const { calls } = installBridge([{ mods: emptyMods() }])
    seedSlot({ mods: emptyMods() })
    await useFilterStore.getState().setModParam(0, 2, 'depth', 0.25)
    await useFilterStore.getState().setModParam(0, 2, 'dest', 4)
    const mod = useFilterStore.getState().slots[0].mods[2]
    expect(mod.depth).toBe(0.25)
    expect(mod.dest).toBe(4)
    expect(calls.some(c => c[0] === 'setParam' && c[2] === 'm2_depth' && c[3] === 0.25)).toBe(true)
    expect(calls.some(c => c[0] === 'setParam' && c[2] === 'm2_dest' && c[3] === 4)).toBe(true)
  })
})

// ─── Modulator lanes ─────────────────────────────────────────────────────────

// A slot's `mods` array always has MAX_MODS_PER_SLOT entries; empty lanes read
// kind = 0. `kinds` fills the leading lanes.
function emptyMods(...kinds) {
  return Array.from({ length: MAX_MODS_PER_SLOT }, (_, i) => ({
    index: i,
    kind: kinds[i] ?? MOD_KIND_OFF,
    dest: 0, depth: 0.5,
    shape: 0, rate_mode: 1, rate_ms: 500, sync: 4, phase: 0,
    attack: 5, hold: 0, decay: 120, sustain: 0.7, release: 200, slides: false,
    dyn_attack: 10, dyn_release: 100, cut_min: 20, cut_max: 20000,
  }))
}

function seedSlot(extra) {
  useFilterStore.setState({
    target: { trackId: 1, nodeId: 2, storeKey: '1' },
    slots: [{ index: 0, type: 0, cutoff: 1000, ...extra }],
    selectedSlotIndex: 0,
  })
}

describe('filterStore modulator lanes', () => {
  beforeEach(() => { useFilterStore.setState({ target: null, slots: [], selectedSlotIndex: -1 }) })

  it('activeMods hides the empty lanes and keeps lane order', () => {
    const mods = emptyMods(MOD_KIND_DYN, MOD_KIND_OFF, MOD_KIND_LFO)
    const active = activeMods({ mods })
    expect(active.map(m => m.index)).toEqual([0, 2])
    expect(active.map(m => m.kind)).toEqual([MOD_KIND_DYN, MOD_KIND_LFO])
  })

  it('addModulator writes the kind of the FIRST free lane', async () => {
    const { calls } = installBridge([{ mods: emptyMods(MOD_KIND_LFO) }])
    seedSlot({ mods: emptyMods(MOD_KIND_LFO) })
    const lane = await useFilterStore.getState().addModulator(0, MOD_KIND_ENV)
    expect(lane).toBe(1)
    expect(calls.some(c => c[0] === 'setParam' && c[2] === 'm1_kind' && c[3] === MOD_KIND_ENV)).toBe(true)
  })

  it('addModulator reuses a HOLE left by a removal rather than appending', async () => {
    const { calls } = installBridge([{ mods: emptyMods(MOD_KIND_LFO, MOD_KIND_OFF, MOD_KIND_ENV) }])
    seedSlot({ mods: emptyMods(MOD_KIND_LFO, MOD_KIND_OFF, MOD_KIND_ENV) })
    const lane = await useFilterStore.getState().addModulator(0, MOD_KIND_DYN)
    expect(lane).toBe(1)
    expect(calls.some(c => c[0] === 'setParam' && c[2] === 'm1_kind' && c[3] === MOD_KIND_DYN)).toBe(true)
  })

  // Regression: a slot payload with NO `mods` key at all (an engine that has not
  // been rebuilt) used to make the first free lane come back as -1, so every
  // "Add modulator" click was a silent no-op.
  it('addModulator still targets lane 0 when the payload has no mods array', async () => {
    const { calls } = installBridge([{ type: 0, cutoff: 1000 }])
    seedSlot({})
    const lane = await useFilterStore.getState().addModulator(0, MOD_KIND_LFO)
    expect(lane).toBe(0)
    expect(calls.some(c => c[0] === 'setParam' && c[2] === 'm0_kind' && c[3] === MOD_KIND_LFO)).toBe(true)
  })

  it('addModulator refuses once every lane is taken', async () => {
    const full = emptyMods(...Array(MAX_MODS_PER_SLOT).fill(MOD_KIND_LFO))
    const { calls } = installBridge([{ mods: full }])
    seedSlot({ mods: full })
    const lane = await useFilterStore.getState().addModulator(0, MOD_KIND_LFO)
    expect(lane).toBe(-1)
    expect(calls.some(c => c[0] === 'setParam')).toBe(false)
  })

  it('removeModulator clears only that lane, leaving its neighbours numbered', async () => {
    const { calls } = installBridge([{ mods: emptyMods(MOD_KIND_LFO, MOD_KIND_ENV, MOD_KIND_DYN) }])
    seedSlot({ mods: emptyMods(MOD_KIND_LFO, MOD_KIND_ENV, MOD_KIND_DYN) })
    await useFilterStore.getState().removeModulator(0, 1)
    expect(calls.some(c => c[0] === 'setParam' && c[2] === 'm1_kind' && c[3] === MOD_KIND_OFF)).toBe(true)
    const mods = useFilterStore.getState().slots[0].mods
    expect(mods[0].kind).toBe(MOD_KIND_LFO)
    expect(mods[1].kind).toBe(MOD_KIND_OFF)
    // Lane 2 keeps its index — removal must never renumber a lane underneath
    // the user, which is why holes are left rather than compacted.
    expect(mods[2].kind).toBe(MOD_KIND_DYN)
    expect(mods[2].index).toBe(2)
  })

  it('cut_min is clamped below that lane\'s cut_max before writing', async () => {
    const mods = emptyMods(MOD_KIND_DYN)
    mods[0].cut_min = 200; mods[0].cut_max = 2000
    const { calls } = installBridge([{ mods }])
    seedSlot({ mods })
    // Try to shove cut_min past cut_max — it must land strictly below.
    await useFilterStore.getState().setCutMin(0, 0, 5000)
    const written = calls.find(c => c[0] === 'setParam' && c[2] === 'm0_cut_min')
    expect(written[3]).toBeLessThan(2000)
    expect(useFilterStore.getState().slots[0].mods[0].cut_min).toBeLessThan(2000)
  })

  it('cut_max is clamped above that lane\'s cut_min before writing', async () => {
    const mods = emptyMods(MOD_KIND_DYN)
    mods[0].cut_min = 200; mods[0].cut_max = 2000
    const { calls } = installBridge([{ mods }])
    seedSlot({ mods })
    await useFilterStore.getState().setCutMax(0, 0, 50)
    const written = calls.find(c => c[0] === 'setParam' && c[2] === 'm0_cut_max')
    expect(written[3]).toBeGreaterThan(200)
  })

  it('each lane clamps against ITS OWN window, not a shared one', async () => {
    const mods = emptyMods(MOD_KIND_DYN, MOD_KIND_DYN)
    mods[0].cut_min = 200;  mods[0].cut_max = 400
    mods[1].cut_min = 3000; mods[1].cut_max = 9000
    const { calls } = installBridge([{ mods }])
    seedSlot({ mods })
    await useFilterStore.getState().setCutMin(0, 1, 8000)
    const written = calls.find(c => c[0] === 'setParam' && c[2] === 'm1_cut_min')
    // Clamped against lane 1's 9000, so it stays well above lane 0's window.
    expect(written[3]).toBeGreaterThan(400)
    expect(written[3]).toBeLessThan(9000)
  })
})
