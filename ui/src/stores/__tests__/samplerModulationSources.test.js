/**
 * @vitest-environment jsdom
 *
 * Dynamic modulation sources — the store's addEnv/addLfo/removeEnv/removeLfo
 * against a minimal in-memory engine (the same stub shape the ModulationRack
 * test uses). These assert the two invariants that make the tray safe:
 *   1. ENV 1 (index 0) can never be removed.
 *   2. Removing a source prunes every route that references it — as its origin
 *      OR (cross-mod) as the target source — and does so in ONE commit, so a
 *      single engine undo restores both the source and its routes.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import useSamplerModulationStore from '../samplerModulationStore.js'
import {
  ENV_SOURCE_0, LFO_SOURCE_0, VELO_SOURCE,
} from '../../components/sampler/modulation/modConstants.js'

const REGION_ID = 5

let cfg = null
let commits = []

function installXleth(initial) {
  cfg = initial
  commits = []
  globalThis.window.xleth = {
    timeline: {
      getSamplerModulation: async () => JSON.parse(JSON.stringify(cfg)),
      setSamplerModulation: async (_id, patch) => {
        commits.push(JSON.parse(JSON.stringify(patch)))
        cfg = JSON.parse(JSON.stringify(patch))
        return { routeCount: (patch.routes || []).length, rejectedRoutes: 0 }
      },
    },
  }
}

// A config with ENV 1 + ENV 2 + LFO 1 present, and three routes: one from ENV 2,
// one from LFO 1, and one cross-mod route TARGETING LFO 1 (index === LFO 1).
function seedConfig() {
  return {
    envs: Array.from({ length: 6 }, () => ({})),
    lfos: Array.from({ length: 6 }, () => ({})),
    velo: { points: [], outputAmount: 1 },
    note: { points: [], outputAmount: 1 },
    envPresent: [true, true, false, false, false, false],
    lfoPresent: [true, false, false, false, false, false],
    routes: [
      { source: ENV_SOURCE_0 + 1, target: 3, index: 0, stage: 0, amount: 0.5, bipolar: false },   // from ENV 2
      { source: LFO_SOURCE_0 + 0, target: 8, index: 0, stage: 0, amount: 0.4, bipolar: true },     // from LFO 1
      { source: VELO_SOURCE, target: 15, index: LFO_SOURCE_0 + 0, stage: 0, amount: 0.3, bipolar: false }, // SrcAmount → LFO 1
    ],
  }
}

async function loadStore() {
  await useSamplerModulationStore.getState().load(REGION_ID)
}

beforeEach(() => {
  useSamplerModulationStore.setState({
    regionId: null, config: null, selectedCard: 'lfo0', loading: false, lastCommit: null,
  })
})

afterEach(() => { delete globalThis.window.xleth })

describe('sampler modulation — dynamic sources', () => {
  it('addEnv turns on the first free envelope and commits once', async () => {
    installXleth(seedConfig())
    await loadStore()
    await useSamplerModulationStore.getState().addEnv()

    const cfgNow = useSamplerModulationStore.getState().config
    expect(cfgNow.envPresent).toEqual([true, true, true, false, false, false])
    expect(commits).toHaveLength(1)
    expect(commits[0].envPresent[2]).toBe(true)
  })

  it('addLfo fills the first free LFO slot', async () => {
    installXleth(seedConfig())
    await loadStore()
    await useSamplerModulationStore.getState().addLfo()
    expect(useSamplerModulationStore.getState().config.lfoPresent).toEqual(
      [true, true, false, false, false, false])
  })

  it('removeEnv(0) is rejected — ENV 1 is permanent', async () => {
    installXleth(seedConfig())
    await loadStore()
    await useSamplerModulationStore.getState().removeEnv(0)

    expect(useSamplerModulationStore.getState().config.envPresent[0]).toBe(true)
    expect(commits).toHaveLength(0)   // nothing committed
  })

  it('removeEnv(1) drops the source and its route in one commit', async () => {
    installXleth(seedConfig())
    await loadStore()
    await useSamplerModulationStore.getState().removeEnv(1)

    const cfgNow = useSamplerModulationStore.getState().config
    expect(cfgNow.envPresent[1]).toBe(false)
    // ENV 2's route is gone; the LFO 1 routes remain.
    expect(cfgNow.routes.some((r) => r.source === ENV_SOURCE_0 + 1)).toBe(false)
    expect(cfgNow.routes).toHaveLength(2)
    expect(commits).toHaveLength(1)   // single undoable step
  })

  it('removeLfo(0) prunes BOTH its origin route and the cross-mod route aimed at it', async () => {
    installXleth(seedConfig())
    await loadStore()
    await useSamplerModulationStore.getState().removeLfo(0)

    const cfgNow = useSamplerModulationStore.getState().config
    expect(cfgNow.lfoPresent[0]).toBe(false)
    // Only ENV 2's route survives — the LFO-origin route and the SrcAmount route
    // that targeted LFO 1 (index === LFO 1) are both gone.
    expect(cfgNow.routes).toHaveLength(1)
    expect(cfgNow.routes[0].source).toBe(ENV_SOURCE_0 + 1)
    expect(commits).toHaveLength(1)
  })

  it('a legacy config with no presence keys normalizes to ENV 1 only', async () => {
    installXleth({
      envs: Array.from({ length: 6 }, () => ({})),
      lfos: Array.from({ length: 6 }, () => ({})),
      velo: {}, note: {}, routes: [],
    })
    await loadStore()
    const cfgNow = useSamplerModulationStore.getState().config
    expect(cfgNow.envPresent).toEqual([true, false, false, false, false, false])
    expect(cfgNow.lfoPresent).toEqual([false, false, false, false, false, false])
  })
})
