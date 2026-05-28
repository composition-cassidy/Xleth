import { create } from 'zustand'
import useEqStore from './eqStore.js'
import useCompressorStore from './compressorStore.js'
import useDistortionStore from './distortionStore.js'
import useWaveshaperStore from './waveshaperStore.js'
import useDelayStore from './delayStore.js'
import useChorusStore from './chorusStore.js'
import { createGraphStateFromChain } from '../fxgraph/chainToGraphState.js'
import {
  loadGraphState,
  validateGraphState,
  addGraphEffectNode,
  removeGraphNode,
  connectGraphNodes,
  disconnectGraphEdge,
} from '../fxgraph/graphState.js'

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

function normalizeGraphNodePosition(position) {
  if (
    position == null ||
    typeof position !== 'object' ||
    !Number.isFinite(position.x) ||
    !Number.isFinite(position.y)
  ) {
    return null
  }

  return {
    x: Math.max(0, position.x),
    y: Math.max(0, position.y),
  }
}

function normalizeGraphStateViewport(viewport, currentViewport = {}) {
  if (
    viewport == null ||
    typeof viewport !== 'object' ||
    !Number.isFinite(viewport.x) ||
    !Number.isFinite(viewport.y)
  ) {
    return null
  }

  const currentZoom = Number.isFinite(currentViewport?.zoom) && currentViewport.zoom > 0
    ? currentViewport.zoom
    : 1
  const requestedZoom = Number.isFinite(viewport.zoom) && viewport.zoom > 0
    ? viewport.zoom
    : currentZoom

  return {
    x: viewport.x,
    y: viewport.y,
    zoom: Math.min(4, Math.max(0.1, requestedZoom)),
  }
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

// FXG.2C-e — fxMode ownership gate for the FXG.2C-d topology guards.
// These store actions are the layer responsible for enforcing fxMode === 'graph'
// before any pure mutation helper runs. The helpers themselves are fxMode-blind.
// Mutations stay renderer-side; engine graph execution is deferred to FXG.3.

const GRAPH_MUTATION_GRID_COLUMNS = 3
const GRAPH_MUTATION_GRID_ORIGIN_X = 80
const GRAPH_MUTATION_GRID_ORIGIN_Y = 132
const GRAPH_MUTATION_GRID_STEP_X = 180
const GRAPH_MUTATION_GRID_STEP_Y = 96

function generateGraphInstanceId(idFactory) {
  if (typeof idFactory === 'function') {
    const id = idFactory()
    if (typeof id === 'string' && id.length > 0) return id
  }
  return globalThis.crypto?.randomUUID?.() ??
    `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
}

// addGraphEffectNode's own fallback stacks new nodes on the trackOutput column,
// so the store supplies an explicit staggered position derived from the current
// effect-node count to avoid overlap.
function computeNextEffectNodePosition(graphState) {
  const effectCount = graphState.nodes.filter((node) => node.type === 'effect').length
  const column = effectCount % GRAPH_MUTATION_GRID_COLUMNS
  const row = Math.floor(effectCount / GRAPH_MUTATION_GRID_COLUMNS)
  return {
    x: GRAPH_MUTATION_GRID_ORIGIN_X + column * GRAPH_MUTATION_GRID_STEP_X,
    y: GRAPH_MUTATION_GRID_ORIGIN_Y + row * GRAPH_MUTATION_GRID_STEP_Y,
  }
}

function buildGraphEffectNodeDraft(graphState, nodeDraft, options = {}) {
  const draft = nodeDraft != null && typeof nodeDraft === 'object' ? nodeDraft : {}
  const effectInstanceId =
    typeof draft.effectInstanceId === 'string' && draft.effectInstanceId.length > 0
      ? draft.effectInstanceId
      : generateGraphInstanceId(options.idFactory)
  const pluginId =
    typeof draft.pluginId === 'string' && draft.pluginId.length > 0
      ? draft.pluginId
      : 'placeholder'
  const displayName =
    typeof draft.displayName === 'string' && draft.displayName.length > 0
      ? draft.displayName
      : 'Effect Node'
  const position = normalizeGraphNodePosition(draft.position) ?? computeNextEffectNodePosition(graphState)

  return {
    effectInstanceId,
    pluginId,
    displayName,
    position,
    bypass: draft.bypass === true,
    missing: draft.missing === true,
    crashed: draft.crashed === true,
  }
}

// Reads graphState for a normal track only when graph mode owns it.
// Reasons: 'master_track' | 'no_track' | 'not_graph_mode' | 'missing_graph_state'.
function readGraphStateForMutation(state, trackId) {
  const key = normalizeNormalTrackKey(trackId)
  if (key == null) {
    return { ok: false, reason: trackId === 'master' ? 'master_track' : 'no_track' }
  }
  if (resolveFxMode(state.fxModes, key) !== 'graph') {
    return { ok: false, reason: 'not_graph_mode' }
  }
  const graphState = state.graphStates[key]
  if (!graphState || !Array.isArray(graphState.nodes) || !Array.isArray(graphState.edges)) {
    return { ok: false, reason: 'missing_graph_state' }
  }
  return { ok: true, key, graphState }
}

// Validates the post-mutation graphState, commits it to the store, and persists
// best-effort. Persistence failures warn but do not fail the renderer-side edit.
async function applyGraphStateMutation(set, key, nextGraphState, options = {}) {
  const validate = options.validateGraphState ?? validateGraphState
  const warn = options.warn ?? console.warn
  const validation = validate(nextGraphState, key)
  if (validation.status !== 'valid') {
    warn?.('[FXG] graphState mutation rejected by validation', {
      trackId: key,
      reason: validation.reason ?? validation.status,
      warnings: validation.warnings,
    })
    return { ok: false, reason: 'invalid_graph_state', status: validation }
  }

  set((currentState) => ({
    graphStates: { ...currentState.graphStates, [key]: validation.graphState },
    graphStateStatuses: { ...currentState.graphStateStatuses, [key]: validation },
  }))

  const timeline = defaultTimelineApi()
  const persistGraphState = options.persistGraphState ?? timeline.setTrackGraphState
  if (typeof persistGraphState === 'function') {
    try {
      const ok = await persistGraphState(Number(key), validation.graphState)
      if (ok === false) {
        warn?.('[FXG] graphState mutation persistence returned false', { trackId: key })
      }
    } catch (e) {
      warn?.('[FXG] graphState mutation persistence failed', {
        trackId: key,
        error: e?.message ?? e,
      })
    }
  }

  return { ok: true, graphState: validation.graphState, status: validation }
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

  setGraphStateNodePosition: async (trackId, nodeId, position, options = {}) => {
    const key = normalizeNormalTrackKey(trackId)
    const nextPosition = normalizeGraphNodePosition(position)
    if (key == null || typeof nodeId !== 'string' || nodeId.length === 0 || nextPosition == null) {
      return false
    }

    const state = get()
    if (resolveFxMode(state.fxModes, key) !== 'graph') return false

    const graphState = state.graphStates[key]
    if (!graphState || !Array.isArray(graphState.nodes)) return false

    let foundNode = false
    let changed = false
    const nextNodes = graphState.nodes.map((node) => {
      if (node.id !== nodeId) return node
      foundNode = true
      if (node.position?.x === nextPosition.x && node.position?.y === nextPosition.y) {
        return node
      }
      changed = true
      return {
        ...node,
        position: nextPosition,
      }
    })

    if (!foundNode) return false
    if (!changed) return true

    const nextGraphState = {
      ...graphState,
      nodes: nextNodes,
    }
    const validate = options.validateGraphState ?? validateGraphState
    const warn = options.warn ?? console.warn
    const validation = validate(nextGraphState, key)
    if (validation.status !== 'valid') {
      warn?.('[FXG] graphState node position update rejected', {
        trackId: key,
        nodeId,
        reason: validation.reason ?? validation.status,
        warnings: validation.warnings,
      })
      return false
    }

    set((currentState) => ({
      graphStates: { ...currentState.graphStates, [key]: validation.graphState },
      graphStateStatuses: { ...currentState.graphStateStatuses, [key]: validation },
    }))

    const timeline = defaultTimelineApi()
    const persistGraphState = options.persistGraphState ?? timeline.setTrackGraphState
    if (typeof persistGraphState !== 'function') return true

    try {
      const ok = await persistGraphState(Number(key), validation.graphState)
      if (ok === false) {
        warn?.('[FXG] graphState node position persistence returned false', {
          trackId: key,
          nodeId,
        })
        return false
      }
    } catch (e) {
      warn?.('[FXG] graphState node position persistence failed', {
        trackId: key,
        nodeId,
        error: e?.message ?? e,
      })
      return false
    }

    return true
  },

  setGraphStateViewport: async (trackId, viewport, options = {}) => {
    const key = normalizeNormalTrackKey(trackId)
    if (key == null) return false

    const state = get()
    if (resolveFxMode(state.fxModes, key) !== 'graph') return false

    const graphState = state.graphStates[key]
    if (!graphState || !Array.isArray(graphState.nodes) || !Array.isArray(graphState.edges)) {
      return false
    }

    const nextViewport = normalizeGraphStateViewport(viewport, graphState.viewport)
    if (nextViewport == null) return false

    const currentViewport = normalizeGraphStateViewport(graphState.viewport ?? {
      x: 0,
      y: 0,
      zoom: 1,
    }, { zoom: 1 }) ?? { x: 0, y: 0, zoom: 1 }

    if (
      currentViewport.x === nextViewport.x &&
      currentViewport.y === nextViewport.y &&
      currentViewport.zoom === nextViewport.zoom
    ) {
      return true
    }

    const nextGraphState = {
      ...graphState,
      viewport: nextViewport,
    }
    const validate = options.validateGraphState ?? validateGraphState
    const warn = options.warn ?? console.warn
    const validation = validate(nextGraphState, key)
    if (validation.status !== 'valid') {
      warn?.('[FXG] graphState viewport update rejected', {
        trackId: key,
        reason: validation.reason ?? validation.status,
        warnings: validation.warnings,
      })
      return false
    }

    set((currentState) => ({
      graphStates: { ...currentState.graphStates, [key]: validation.graphState },
      graphStateStatuses: { ...currentState.graphStateStatuses, [key]: validation },
    }))

    const timeline = defaultTimelineApi()
    const persistGraphState = options.persistGraphState ?? timeline.setTrackGraphState
    if (typeof persistGraphState !== 'function') return true

    try {
      const ok = await persistGraphState(Number(key), validation.graphState)
      if (ok === false) {
        warn?.('[FXG] graphState viewport persistence returned false', {
          trackId: key,
        })
        return false
      }
    } catch (e) {
      warn?.('[FXG] graphState viewport persistence failed', {
        trackId: key,
        error: e?.message ?? e,
      })
      return false
    }

    return true
  },

  // FXG.2C-e graphState mutation actions. Renderer/data-model only.
  // Each requires a normal track owned by graph mode; never touches effectChains.
  addGraphEffectNodeForTrack: async (trackId, nodeDraft = {}, options = {}) => {
    const access = readGraphStateForMutation(get(), trackId)
    if (!access.ok) return access

    const draft = buildGraphEffectNodeDraft(access.graphState, nodeDraft, options)
    const mutation = addGraphEffectNode(access.graphState, draft, { idFactory: options.idFactory })
    if (!mutation.ok) return mutation

    return applyGraphStateMutation(set, access.key, mutation.graphState, options)
  },

  removeGraphNodeForTrack: async (trackId, nodeId, options = {}) => {
    const access = readGraphStateForMutation(get(), trackId)
    if (!access.ok) return access

    const mutation = removeGraphNode(access.graphState, nodeId)
    if (!mutation.ok) return mutation

    return applyGraphStateMutation(set, access.key, mutation.graphState, options)
  },

  connectGraphNodesForTrack: async (trackId, connectionDraft, options = {}) => {
    const access = readGraphStateForMutation(get(), trackId)
    if (!access.ok) return access

    const mutation = connectGraphNodes(access.graphState, connectionDraft, { idFactory: options.idFactory })
    if (!mutation.ok) return mutation

    return applyGraphStateMutation(set, access.key, mutation.graphState, options)
  },

  disconnectGraphEdgeForTrack: async (trackId, edgeId, options = {}) => {
    const access = readGraphStateForMutation(get(), trackId)
    if (!access.ok) return access

    const mutation = disconnectGraphEdge(access.graphState, edgeId)
    if (!mutation.ok) return mutation

    return applyGraphStateMutation(set, access.key, mutation.graphState, options)
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
