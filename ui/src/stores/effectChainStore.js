import { create } from 'zustand'
import useEqStore from './eqStore.js'
import useCompressorStore from './compressorStore.js'
import useDistortionStore from './distortionStore.js'
import useWaveshaperStore from './waveshaperStore.js'
import useDelayStore from './delayStore.js'
import useChorusStore from './chorusStore.js'
import { createGraphStateFromChain } from '../fxgraph/chainToGraphState.js'
import { loadGraphState, validateGraphState } from '../fxgraph/graphState.js'

export const DEFAULT_FX_MODE = 'chain'
export const DEFAULT_FX_PANEL_VIEW = 'chain'

// Dispatch IPC to the correct track vs. master variant.
// key === 'master' -> masterFn(...args)
// key === String(trackId) -> trackFn(Number(key), ...args)
function ipc(key, trackFn, masterFn, ...args) {
  const xleth = globalThis.window?.xleth
  if (key === 'master') return xleth?.audio?.[masterFn]?.(...args)
  return xleth?.audio?.[trackFn]?.(Number(key), ...args)
}

function parseChain(raw) {
  if (!raw) return []
  if (typeof raw === 'string') {
    try { return JSON.parse(raw) } catch { return [] }
  }
  return Array.isArray(raw) ? raw : []
}

export function resolveFxMode(fxModes = {}, key) {
  if (key === 'master') return DEFAULT_FX_MODE
  return fxModes?.[key] === 'graph' ? 'graph' : DEFAULT_FX_MODE
}

export function buildFxModesFromTracks(tracks = []) {
  if (!Array.isArray(tracks)) return {}
  return tracks.reduce((nextFxModes, track) => {
    if (track?.id == null) return nextFxModes
    const key = String(track.id)
    nextFxModes[key] = track.fxMode === 'graph' ? 'graph' : DEFAULT_FX_MODE
    return nextFxModes
  }, {})
}

export function buildGraphStateHydrationFromTracks(tracks = [], options = {}) {
  const graphStates = {}
  const graphStateStatuses = {}
  if (!Array.isArray(tracks)) return { graphStates, graphStateStatuses }

  const logger = options.logger ?? console.warn
  const logWarnings = options.logWarnings ?? true

  for (const track of tracks) {
    if (track?.id == null) continue
    const key = String(track.id)
    if (key === 'master') continue

    const fxMode = track.fxMode === 'graph' ? 'graph' : DEFAULT_FX_MODE
    const rawGraphState = Object.prototype.hasOwnProperty.call(track, 'graphState')
      ? track.graphState
      : undefined
    const result = loadGraphState(rawGraphState, key, { fxMode, logger, logWarnings })

    graphStates[key] = result.status === 'valid' ? result.graphState : null
    graphStateStatuses[key] = result
  }

  return { graphStates, graphStateStatuses }
}

export function resolveFxPanelView(fxPanelViews = {}, key) {
  return fxPanelViews?.[key] === 'graphShell' ? 'graphShell' : DEFAULT_FX_PANEL_VIEW
}

function buildFxStateDefaults(fxModes, fxPanelViews, key) {
  const nextState = {}
  const nextMode = resolveFxMode(fxModes, key)
  const nextPanelView = resolveFxPanelView(fxPanelViews, key)

  if (fxModes?.[key] !== nextMode) {
    nextState.fxModes = { ...(fxModes ?? {}), [key]: nextMode }
  }

  if (fxPanelViews?.[key] !== nextPanelView) {
    nextState.fxPanelViews = { ...(fxPanelViews ?? {}), [key]: nextPanelView }
  }

  return nextState
}

function isChainFxMode(state, key) {
  return resolveFxMode(state.fxModes, key) === DEFAULT_FX_MODE
}

function normalizeNormalTrackKey(trackId) {
  if (trackId === 'master') return null
  if (typeof trackId === 'number' && Number.isFinite(trackId)) return String(trackId)
  if (typeof trackId === 'string' && trackId.trim() !== '' && trackId !== 'master') {
    const numericTrackId = Number(trackId)
    if (Number.isFinite(numericTrackId)) return String(trackId)
  }
  return null
}

function defaultTimelineApi() {
  return globalThis.window?.xleth?.timeline ?? {}
}

function warnFxgConversion(warn, trackId, reason, details = {}) {
  warn?.(`[FXG] chain-to-graph conversion failed for track ${trackId}: ${reason}`, {
    trackId: String(trackId),
    reason,
    ...details,
  })
}

const useEffectChainStore = create((set, get) => ({
  // { [key: "master" | String(trackId)]: [{nodeId, pluginId, position, bypassed}] }
  chains: {},
  // { [key: "master" | String(trackId)]: "chain" | "graph" }
  fxModes: {},
  // { [key: "master" | String(trackId)]: "chain" | "graphShell" }
  fxPanelViews: {},
  // { [key: String(trackId)]: GraphState | null }
  graphStates: {},
  // { [key: String(trackId)]: loadGraphState result }
  graphStateStatuses: {},

  ensureFxState: (key) => {
    const { fxModes, fxPanelViews } = get()
    const nextState = buildFxStateDefaults(fxModes, fxPanelViews, key)
    if (Object.keys(nextState).length > 0) {
      set(nextState)
    }
  },

  hydrateFxModesFromTracks: (tracks) => {
    const { graphStates, graphStateStatuses } = buildGraphStateHydrationFromTracks(tracks)
    set({
      fxModes: buildFxModesFromTracks(tracks),
      fxPanelViews: {},
      graphStates,
      graphStateStatuses,
    })
  },

  setFxMode: (key, mode) => {
    // FX ownership transfer undo/redo is intentionally deferred to FXG.2.
    const nextMode = key !== 'master' && mode === 'graph' ? 'graph' : DEFAULT_FX_MODE
    set((state) => ({ fxModes: { ...state.fxModes, [key]: nextMode } }))
  },

  setFxPanelView: (key, view) => {
    const nextView = view === 'graphShell' ? 'graphShell' : DEFAULT_FX_PANEL_VIEW
    set((state) => ({ fxPanelViews: { ...state.fxPanelViews, [key]: nextView } }))
  },

  convertChainToGraphMode: async (trackId, options = {}) => {
    const key = normalizeNormalTrackKey(trackId)
    if (key == null) {
      return { ok: false, reason: trackId === 'master' ? 'master_track' : 'no_track' }
    }

    const state = get()
    const currentFxMode = resolveFxMode(state.fxModes, key)
    if (currentFxMode === 'graph') {
      return { ok: false, reason: 'already_graph' }
    }

    const warn = options.warn ?? console.warn
    const createGraphState = options.createGraphState ?? createGraphStateFromChain
    const validate = options.validateGraphState ?? validateGraphState
    const timeline = defaultTimelineApi()
    const persistGraphState = options.persistGraphState ?? timeline.setTrackGraphState
    const persistFxMode = options.persistFxMode ?? timeline.setTrackFxMode
    const previousGraphState = state.graphStates[key] ?? null
    const previousGraphStateStatus = state.graphStateStatuses[key] ??
      loadGraphState(previousGraphState, key, { logWarnings: false })
    const chain = state.chains[key] ?? []

    const rawGraphState = createGraphState({
      trackId: key,
      effects: chain,
      idFactory: options.idFactory,
      vstPlugins: options.vstPlugins,
    })
    const validation = validate(rawGraphState, key)

    if (validation.status !== 'valid') {
      warnFxgConversion(warn, key, validation.reason ?? validation.status, {
        warnings: validation.warnings,
      })
      return {
        ok: false,
        reason: validation.reason ?? 'invalid_graph_state',
        status: validation,
      }
    }

    let graphStatePersisted = false
    try {
      if (typeof persistGraphState !== 'function') {
        throw new Error('timeline.setTrackGraphState unavailable')
      }
      const graphOk = await persistGraphState(Number(key), validation.graphState)
      if (graphOk === false) {
        throw new Error('timeline.setTrackGraphState returned false')
      }
      graphStatePersisted = true

      if (typeof persistFxMode !== 'function') {
        throw new Error('timeline.setTrackFxMode unavailable')
      }
      const modeOk = await persistFxMode(Number(key), 'graph')
      if (modeOk === false) {
        throw new Error('timeline.setTrackFxMode returned false')
      }
    } catch (e) {
      if (graphStatePersisted && typeof persistGraphState === 'function') {
        try {
          await persistGraphState(Number(key), previousGraphState)
        } catch (rollbackError) {
          warnFxgConversion(warn, key, 'graphState rollback failed', {
            error: rollbackError?.message ?? rollbackError,
          })
        }
      }

      warnFxgConversion(warn, key, 'persistence_failed', {
        error: e?.message ?? e,
      })
      return {
        ok: false,
        reason: 'persistence_failed',
        error: e,
      }
    }

    set((currentState) => ({
      fxModes: { ...currentState.fxModes, [key]: 'graph' },
      graphStates: { ...currentState.graphStates, [key]: validation.graphState },
      graphStateStatuses: { ...currentState.graphStateStatuses, [key]: validation },
    }))

    return {
      ok: true,
      graphState: validation.graphState,
      status: validation,
      previousGraphState,
      previousGraphStateStatus,
    }
  },

  fetchChain: async (key) => {
    get().ensureFxState(key)

    try {
      const raw = await ipc(key, 'getEffectChain', 'getMasterEffectChain')
      const chain = parseChain(raw)
      set((state) => ({
        ...buildFxStateDefaults(state.fxModes, state.fxPanelViews, key),
        chains: { ...state.chains, [key]: chain },
      }))
    } catch (e) {
      console.warn('[effectChainStore] fetchChain failed:', e?.message)
    }
  },

  addEffect: async (key, pluginId) => {
    const state = get()
    if (!isChainFxMode(state, key)) return false

    const chain = state.chains[key] ?? []
    if (chain.length >= 100) return false

    // Optimistic: append placeholder so UI responds immediately
    const placeholder = { nodeId: -1, pluginId, position: chain.length, bypassed: false }
    set((currentState) => ({
      chains: { ...currentState.chains, [key]: [...(currentState.chains[key] ?? []), placeholder] },
    }))

    try {
      await ipc(key, 'addEffect', 'addMasterEffect', pluginId, chain.length)
    } catch (e) {
      console.warn('[effectChainStore] addEffect failed:', e?.message)
    }
    await get().fetchChain(key)
    return true
  },

  removeEffect: async (key, nodeId) => {
    if (!isChainFxMode(get(), key)) return false

    // Optimistic: filter out immediately
    set((state) => ({
      chains: { ...state.chains, [key]: (state.chains[key] ?? []).filter((fx) => fx.nodeId !== nodeId) },
    }))

    try {
      const ok = await ipc(key, 'removeEffect', 'removeMasterEffect', nodeId)
      if (ok === false) {
        console.warn('[effectChainStore] removeEffect failed (stale nodeId?), re-fetching chain')
      }
    } catch (e) {
      console.warn('[effectChainStore] removeEffect failed:', e?.message)
    }
    await get().fetchChain(key)
    return true
  },

  moveEffect: async (key, nodeId, newPos) => {
    if (!isChainFxMode(get(), key)) return false

    // Optimistic: reorder locally
    set((state) => {
      const arr = [...(state.chains[key] ?? [])]
      const srcIdx = arr.findIndex((fx) => fx.nodeId === nodeId)
      if (srcIdx === -1) return state
      const [item] = arr.splice(srcIdx, 1)
      arr.splice(newPos, 0, item)
      return { chains: { ...state.chains, [key]: arr } }
    })

    try {
      const ok = await ipc(key, 'moveEffect', 'moveMasterEffect', nodeId, newPos)
      if (ok === false) {
        console.warn('[effectChainStore] moveEffect failed (stale nodeId?), re-fetching chain')
      }
    } catch (e) {
      console.warn('[effectChainStore] moveEffect failed:', e?.message)
    }
    await get().fetchChain(key)
    return true
  },

  setBypass: async (key, nodeId, bypassed) => {
    if (!isChainFxMode(get(), key)) return false

    // Optimistic: flip bypass flag
    set((state) => ({
      chains: {
        ...state.chains,
        [key]: (state.chains[key] ?? []).map((fx) =>
          fx.nodeId === nodeId ? { ...fx, bypassed } : fx
        ),
      },
    }))

    try {
      const ok = await ipc(key, 'setEffectBypass', 'setMasterEffectBypass', nodeId, bypassed)
      if (ok === false) {
        console.warn('[effectChainStore] setBypass failed (stale nodeId?), re-fetching chain')
      }
    } catch (e) {
      console.warn('[effectChainStore] setBypass failed:', e?.message)
    }
    await get().fetchChain(key)
    return true
  },
}))

// Re-fetch chain when any window mutates the graph
globalThis.window?.xleth?.onGraphChanged?.((key) => {
  useEffectChainStore.getState().fetchChain(key)
})

// On project load, all AudioGraph nodeIds have been reassigned by fromJSON.
// Close every open effect editor panel (they hold stale nodeIds in target)
// and re-fetch every cached chain so the store has the new nodeIds.
globalThis.window?.xleth?.onProjectLoaded?.(() => {
  console.log('[effectChainStore] project-loaded - closing panels, refreshing all chains')

  useEffectChainStore.setState({
    fxModes: {},
    fxPanelViews: {},
    graphStates: {},
    graphStateStatuses: {},
  })

  // Close all open effect editor panels
  useEqStore.getState().close()
  useCompressorStore.getState().close()
  useDistortionStore.getState().close()
  useWaveshaperStore.getState().close()
  useDelayStore.getState().close()
  useChorusStore.getState().close()

  // Re-fetch every chain that was cached
  const { chains, fetchChain } = useEffectChainStore.getState()
  for (const key of Object.keys(chains)) {
    fetchChain(key)
  }

  globalThis.window?.xleth?.timeline?.getTracks?.()
    ?.then?.((tracks) => {
      useEffectChainStore.getState().hydrateFxModesFromTracks(tracks)
    })
    ?.catch?.((e) => {
      console.warn('[effectChainStore] fxMode hydration failed:', e?.message)
    })
})

export default useEffectChainStore
