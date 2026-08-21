/**
 * Route mutations on the sampler modulation store.
 *
 * The undo contract lives here rather than in the engine: every route change
 * must reach the bridge as exactly ONE setSamplerModulation call carrying the
 * COMPLETE config, because that is what the engine turns into a single
 * SetSamplerSettingsCommand — one Ctrl+Z per user action. A mutation that
 * committed twice, or that sent a partial payload, would split or corrupt that
 * step, so each test counts calls as well as checking the payload.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import useSamplerModulationStore, { DEFAULT_ROUTE_AMOUNT } from '../samplerModulationStore.js'
import {
  TARGET_SLOT_SEM, TARGET_SLOT_MANGLE_MIX, TARGET_SLOT_MANGLE_AMOUNT,
  TARGET_ENV_STAGE_TIME, TARGET_SRC_RATE,
} from '../../components/sampler/modulation/modTargets.js'
import {
  ENV_SOURCE_0, LFO_SOURCE_0, STAGE_SUSTAIN,
} from '../../components/sampler/modulation/modConstants.js'

const REGION_ID = 7

let sets = []
let stored = null

function baseConfig() {
  return {
    envs: Array.from({ length: 6 }, () => ({})),
    lfos: Array.from({ length: 6 }, () => ({})),
    velo: { points: [], outputAmount: 1 },
    note: { points: [], outputAmount: 1 },
    envPresent: [true, false, false, false, false, false],
    lfoPresent: [true, false, false, false, false, false],
    routes: [],
  }
}

async function loadStore() {
  sets = []
  stored = baseConfig()
  globalThis.window = globalThis.window || {}
  globalThis.window.xleth = {
    timeline: {
      getSamplerModulation: async () => JSON.parse(JSON.stringify(stored)),
      setSamplerModulation: async (_id, patch) => {
        sets.push(JSON.parse(JSON.stringify(patch)))
        stored = JSON.parse(JSON.stringify(patch))
        return { routeCount: (patch.routes || []).length, rejectedRoutes: 0 }
      },
    },
  }
  await useSamplerModulationStore.getState().load(REGION_ID)
}

const routes = () => useSamplerModulationStore.getState().config.routes

beforeEach(async () => {
  useSamplerModulationStore.setState({
    regionId: null, config: null, selectedCard: 'lfo0', loading: false, lastCommit: null,
  })
  await loadStore()
})

describe('addRoute', () => {
  it('creates a route and commits the whole config exactly once', async () => {
    const reg = { target: TARGET_SLOT_SEM, index: 1, stage: 0, scale: 1 }
    await useSamplerModulationStore.getState().addRoute(LFO_SOURCE_0, reg)

    expect(sets).toHaveLength(1)
    const payload = sets[0]
    expect(payload.routes).toEqual([{
      source: LFO_SOURCE_0,
      target: TARGET_SLOT_SEM,
      index: 1,
      stage: 0,
      amount: DEFAULT_ROUTE_AMOUNT,
      bipolar: true,
    }])
    // The full config travels with it, which is what makes the engine's undo
    // step complete rather than route-only.
    expect(payload.envs).toHaveLength(6)
    expect(payload.lfos).toHaveLength(6)
    expect(payload.envPresent).toHaveLength(6)
    expect(payload.velo).toBeTruthy()
  })

  it('defaults an envelope route to unipolar and an LFO route to bipolar', async () => {
    const store = useSamplerModulationStore.getState()
    await store.addRoute(ENV_SOURCE_0, { target: TARGET_SLOT_SEM, index: 0, stage: 0 })
    await store.addRoute(LFO_SOURCE_0, { target: TARGET_SLOT_MANGLE_MIX, index: 0, stage: 1 })

    expect(routes()[0].bipolar).toBe(false)
    expect(routes()[1].bipolar).toBe(true)
  })

  it('carries the MANGLE chain instance in `stage`', async () => {
    await useSamplerModulationStore.getState()
      .addRoute(ENV_SOURCE_0 + 1, { target: TARGET_SLOT_MANGLE_MIX, index: 0, stage: 1 })
    expect(routes()[0]).toMatchObject({ target: TARGET_SLOT_MANGLE_MIX, index: 0, stage: 1 })
  })

  it('is a no-op when that source already drives that control', async () => {
    const reg = { target: TARGET_SLOT_SEM, index: 1, stage: 0 }
    await useSamplerModulationStore.getState().addRoute(LFO_SOURCE_0, reg)
    const again = await useSamplerModulationStore.getState().addRoute(LFO_SOURCE_0, reg)

    expect(again).toBeNull()
    expect(routes()).toHaveLength(1)
    expect(sets).toHaveLength(1)
  })

  it('still allows a SECOND source to drive the same control', async () => {
    const reg = { target: TARGET_SLOT_SEM, index: 1, stage: 0 }
    await useSamplerModulationStore.getState().addRoute(LFO_SOURCE_0, reg)
    await useSamplerModulationStore.getState().addRoute(ENV_SOURCE_0, reg)
    expect(routes()).toHaveLength(2)
    expect(sets).toHaveLength(2)
  })

  it('refuses an invalid route instead of letting the engine drop it silently', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    // Sustain is a level, not a time.
    const bad = await useSamplerModulationStore.getState()
      .addRoute(LFO_SOURCE_0, { target: TARGET_ENV_STAGE_TIME, index: ENV_SOURCE_0, stage: STAGE_SUSTAIN })
    // RATE belongs to LFOs; an ENV index is meaningless.
    const alsoBad = await useSamplerModulationStore.getState()
      .addRoute(LFO_SOURCE_0, { target: TARGET_SRC_RATE, index: ENV_SOURCE_0, stage: 0 })

    expect(bad).toBeNull()
    expect(alsoBad).toBeNull()
    expect(routes()).toHaveLength(0)
    expect(sets).toHaveLength(0)
    warn.mockRestore()
  })
})

describe('ring editing', () => {
  beforeEach(async () => {
    await useSamplerModulationStore.getState()
      .addRoute(LFO_SOURCE_0, { target: TARGET_SLOT_SEM, index: 1, stage: 0 })
    sets = []
  })

  it('previews an amount with NO bridge traffic', () => {
    useSamplerModulationStore.getState().previewRouteAmount(0, 0.4)
    useSamplerModulationStore.getState().previewRouteAmount(0, 0.6)
    expect(routes()[0].amount).toBe(0.6)
    expect(sets).toHaveLength(0)
  })

  it('commits once on release, after any number of preview frames', async () => {
    useSamplerModulationStore.getState().previewRouteAmount(0, 0.4)
    useSamplerModulationStore.getState().previewRouteAmount(0, 0.5)
    await useSamplerModulationStore.getState().setRouteAmount(0, 0.55)

    expect(sets).toHaveLength(1)
    expect(sets[0].routes[0].amount).toBeCloseTo(0.55, 9)
  })

  it('clamps amount to the engine’s -1..+1 window', () => {
    useSamplerModulationStore.getState().previewRouteAmount(0, 4)
    expect(routes()[0].amount).toBe(1)
    useSamplerModulationStore.getState().previewRouteAmount(0, -4)
    expect(routes()[0].amount).toBe(-1)
  })

  it('toggles bipolar in one commit', async () => {
    await useSamplerModulationStore.getState().toggleRouteBipolar(0)
    expect(routes()[0].bipolar).toBe(false)
    await useSamplerModulationStore.getState().toggleRouteBipolar(0)
    expect(routes()[0].bipolar).toBe(true)
    expect(sets).toHaveLength(2)
  })
})

describe('removeRoute', () => {
  it('drops one route and commits once', async () => {
    const store = () => useSamplerModulationStore.getState()
    await store().addRoute(LFO_SOURCE_0, { target: TARGET_SLOT_SEM, index: 1, stage: 0 })
    await store().addRoute(ENV_SOURCE_0, { target: TARGET_SLOT_MANGLE_MIX, index: 0, stage: 0 })
    sets = []

    await store().removeRoute(0)

    expect(routes()).toHaveLength(1)
    expect(routes()[0].source).toBe(ENV_SOURCE_0)
    expect(sets).toHaveLength(1)
    expect(sets[0].routes).toHaveLength(1)
  })

  it('ignores an index that is not there', async () => {
    await useSamplerModulationStore.getState().removeRoute(3)
    expect(sets).toHaveLength(0)
  })

  it('restores the previous route list when the engine replays the old config', async () => {
    // Stand-in for undo: the engine's SetSamplerSettingsCommand restores the
    // config it captured, and the tray reloads it. Two routes in, one deleted,
    // the pre-delete config reloaded — both are back, which is the shape an undo
    // has to leave the store in.
    const store = () => useSamplerModulationStore.getState()
    await store().addRoute(LFO_SOURCE_0, { target: TARGET_SLOT_SEM, index: 1, stage: 0 })
    await store().addRoute(ENV_SOURCE_0, { target: TARGET_SLOT_MANGLE_MIX, index: 0, stage: 0 })
    const before = JSON.parse(JSON.stringify(stored))

    await store().removeRoute(0)
    expect(routes()).toHaveLength(1)

    stored = before
    await store().load(REGION_ID)
    expect(routes()).toHaveLength(2)
  })
})

describe('remapMangleStages', () => {
  // A MANGLE route names its knob by chain POSITION, not by effect, so a chain
  // reorder that does not move the routes hands one instance's modulators to
  // whatever mode slid into its slot — the reported "Asym − steals the envelope
  // from Sync" bug.
  const store = () => useSamplerModulationStore.getState()

  async function seed() {
    await store().addRoute(ENV_SOURCE_0, { target: TARGET_SLOT_MANGLE_AMOUNT, index: 0, stage: 0 })
    await store().addRoute(LFO_SOURCE_0, { target: TARGET_SLOT_MANGLE_AMOUNT, index: 0, stage: 1 })
    await store().addRoute(ENV_SOURCE_0, { target: TARGET_SLOT_SEM,           index: 0, stage: 0 })
    sets = []
  }

  const stageOf = (source, target) =>
    routes().find((r) => r.source === source && r.target === target)?.stage

  it('follows a swap of the two instances, and commits once', async () => {
    await seed()

    // The chain editor swapped instances 0 and 1.
    await store().remapMangleStages(0, (s) => (s === 0 ? 1 : (s === 1 ? 0 : s)))

    expect(stageOf(ENV_SOURCE_0, TARGET_SLOT_MANGLE_AMOUNT)).toBe(1)
    expect(stageOf(LFO_SOURCE_0, TARGET_SLOT_MANGLE_AMOUNT)).toBe(0)
    expect(sets).toHaveLength(1)
    expect(sets[0].routes).toHaveLength(3)
  })

  it('drops the routes of a deleted instance and shifts the ones after it down', async () => {
    await seed()

    await store().remapMangleStages(0, (s) => (s === 0 ? -1 : s - 1))

    const mangle = routes().filter((r) => r.target === TARGET_SLOT_MANGLE_AMOUNT)
    expect(mangle).toHaveLength(1)
    expect(mangle[0].source).toBe(LFO_SOURCE_0)
    expect(mangle[0].stage).toBe(0)
    expect(sets).toHaveLength(1)
  })

  it('leaves non-MANGLE routes and other slots alone', async () => {
    await seed()

    await store().remapMangleStages(0, (s) => (s === 0 ? 1 : (s === 1 ? 0 : s)))

    // The SEM route on the same slot keeps its stage — stage means nothing to it.
    expect(stageOf(ENV_SOURCE_0, TARGET_SLOT_SEM)).toBe(0)

    // A remap on a DIFFERENT slot must not touch slot 0's routes at all.
    sets = []
    await store().remapMangleStages(3, () => 0)
    expect(sets).toHaveLength(0)
  })

  it('does not commit when the permutation changes nothing', async () => {
    await seed()
    await store().remapMangleStages(0, (s) => s)
    expect(sets).toHaveLength(0)
  })
})
