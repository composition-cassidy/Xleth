import { create } from 'zustand'
import { timelineEvents } from '../timelineEvents.js'
import {
  NUM_ENVS, NUM_LFOS, NOTEVAL_OFF, BEHAVIOR_FREE,
} from '../components/sampler/modulation/modConstants.js'

// ── Sampler modulation store ─────────────────────────────────────────────────
// Holds ONE region's modulation config (6 ENV + 6 LFO + VELO + NOTE + routes)
// and which source card is open. The contract with the engine:
//
//   window.xleth.timeline.getSamplerModulation(regionId) → full config
//   window.xleth.timeline.setSamplerModulation(regionId, patch) → {routeCount, rejectedRoutes}
//
// Both cross the bridge through optional chaining, which SILENTLY returns
// undefined if the export is missing. load() therefore guards the result and
// falls back to an empty config rather than leaving the rack in a broken state.
//
// Edit model (the whole point of the store): a drag calls a preview* mutator,
// which changes the in-memory config and triggers a re-render but sends NOTHING
// over IPC. The single commit() on mouseup is the only call that reaches the
// engine. Discrete controls (toggles, selects, preset buttons) use the set*
// convenience wrappers, which preview then commit in one step.

const defaultTime = (noteValue = NOTEVAL_OFF) => ({ ms: 0, noteValue, triplet: false, dotted: false })

function defaultEnv() {
  return {
    tempoSync: false,
    delay: defaultTime(), attack: defaultTime(), hold: defaultTime(),
    decay: defaultTime(), release: defaultTime(),
    sustainPct: 100,
    attackTension: 0, decayTension: 0, releaseTension: 0,
    outputAmount: 1,
  }
}

function defaultLfo() {
  return {
    points: [
      { t: 0, v: -1, seg: 1, tension: 0 },
      { t: 0.5, v: 1, seg: 1, tension: 0 },
    ],
    tempoSync: false,
    rateHz: 1,
    syncRate: defaultTime(8),   // 1/4 note
    rise: defaultTime(),
    delay: defaultTime(),
    smooth: 0,
    phase: 0,
    behavior: BEHAVIOR_FREE,
    mono: false,
    outputAmount: 1,
  }
}

function defaultCurve() {
  return { points: [], outputAmount: 1 }
}

// Fill any missing pieces so the editors can always read a complete object,
// even if the bridge ever returns a partial payload.
function normalizeConfig(cfg) {
  const c = cfg && typeof cfg === 'object' ? cfg : {}
  const envs = []
  for (let i = 0; i < NUM_ENVS; i++) envs.push({ ...defaultEnv(), ...(c.envs?.[i] || {}) })
  const lfos = []
  for (let i = 0; i < NUM_LFOS; i++) {
    const l = { ...defaultLfo(), ...(c.lfos?.[i] || {}) }
    if (!Array.isArray(l.points)) l.points = defaultLfo().points
    lfos.push(l)
  }
  return {
    envs,
    lfos,
    velo: { ...defaultCurve(), ...(c.velo || {}) },
    note: { ...defaultCurve(), ...(c.note || {}) },
    routes: Array.isArray(c.routes) ? c.routes : [],
  }
}

const useSamplerModulationStore = create((set, get) => ({
  regionId: null,
  config: null,
  selectedCard: 'lfo0',
  loading: false,
  lastCommit: null,

  load: async (regionId) => {
    set({ regionId, loading: true })
    try {
      const cfg = await window.xleth?.timeline?.getSamplerModulation?.(regionId)
      if (get().regionId !== regionId) return   // a newer load() superseded this one
      set({ config: normalizeConfig(cfg), loading: false })
    } catch (e) {
      console.warn('[samplerMod] getSamplerModulation failed:', e?.message)
      if (get().regionId === regionId) set({ config: normalizeConfig(null), loading: false })
    }
  },

  selectCard: (id) => set({ selectedCard: id }),

  // ── Local preview mutators (NO IPC) ────────────────────────────────────────
  // Callers pass COMPLETE nested objects (e.g. the whole `attack` time), so a
  // shallow spread is enough and there is no deep-merge ambiguity.
  previewEnv: (idx, patch) => set((s) => {
    if (!s.config) return s
    const envs = s.config.envs.slice()
    envs[idx] = { ...envs[idx], ...patch }
    return { config: { ...s.config, envs } }
  }),
  previewLfo: (idx, patch) => set((s) => {
    if (!s.config) return s
    const lfos = s.config.lfos.slice()
    lfos[idx] = { ...lfos[idx], ...patch }
    return { config: { ...s.config, lfos } }
  }),
  previewCurve: (which, patch) => set((s) => {
    if (!s.config) return s
    return { config: { ...s.config, [which]: { ...s.config[which], ...patch } } }
  }),

  // ── Commit (IPC) — call on mouseup / discrete change only ───────────────────
  commit: async () => {
    const { regionId, config } = get()
    if (regionId == null || !config) return
    try {
      // Send the full config. `envs`/`lfos` patch by position and `routes`
      // replaces the list; since we hold the engine's own loaded routes and
      // full arrays, the round trip is lossless and never drops a route.
      const res = await window.xleth?.timeline?.setSamplerModulation?.(regionId, config)
      set({ lastCommit: res || null })
      timelineEvents.dispatchEvent(new CustomEvent('timeline-sampler-changed', { detail: { regionId } }))
    } catch (e) {
      console.warn('[samplerMod] setSamplerModulation failed:', e?.message)
    }
  },

  // ── Convenience: preview + commit for discrete controls ─────────────────────
  setEnv: (idx, patch) => { get().previewEnv(idx, patch); return get().commit() },
  setLfo: (idx, patch) => { get().previewLfo(idx, patch); return get().commit() },
  setCurve: (which, patch) => { get().previewCurve(which, patch); return get().commit() },
}))

export default useSamplerModulationStore
