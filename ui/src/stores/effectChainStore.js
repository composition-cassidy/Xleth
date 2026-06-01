import { create } from 'zustand'
import useEqStore from './eqStore.js'
import useCompressorStore from './compressorStore.js'
import useDistortionStore from './distortionStore.js'
import useWaveshaperStore from './waveshaperStore.js'
import useDelayStore from './delayStore.js'
import useChorusStore from './chorusStore.js'
import { createGraphStateFromChain } from '../fxgraph/chainToGraphState.js'
import { buildLinearGraphTopologyPayload } from '../fxgraph/linearGraphTopology.js'
import {
  loadGraphState,
  validateGraphState,
  addGraphEffectNode,
  removeGraphNode,
  connectGraphNodes,
  disconnectGraphEdge,
  toggleExposedParameterPort,
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

function cloneJson(value) {
  if (value == null) return value
  return JSON.parse(JSON.stringify(value))
}

// FXG.4-a: clamp a renderer-supplied normalized parameter value into [0, 1].
// Returns null for non-finite input so callers can reject before hitting IPC.
function clampNormalizedValue(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  return Math.min(1, Math.max(0, value))
}

// FXG.4-a: the engine returns graph parameter descriptors as a JSON string
// ({ ok, ... } / reason). Normalize the bridge response into a plain object the
// store/UI can consume without re-parsing or crashing on malformed payloads.
function normalizeGraphParameterResult(raw) {
  let parsed = raw
  if (typeof raw === 'string') {
    try {
      parsed = JSON.parse(raw)
    } catch {
      return { ok: false, reason: 'invalid_engine_response' }
    }
  }
  if (!parsed || typeof parsed !== 'object') {
    return { ok: false, reason: 'invalid_engine_response' }
  }
  if (parsed.ok === true) {
    return { ...parsed, ok: true }
  }
  return {
    ...parsed,
    ok: false,
    reason: typeof parsed.reason === 'string' && parsed.reason.length > 0
      ? parsed.reason
      : 'engine_error',
  }
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

function defaultAudioApi() {
  return globalThis.window?.xleth?.audio ?? {}
}

// A graph effect node is engine-backed only when it carries a real pluginId.
// Placeholder/data-only nodes (pluginId === 'placeholder') stay renderer-only
// and must never trigger engine instantiation.
function isInstantiablePluginId(pluginId) {
  return typeof pluginId === 'string' && pluginId.length > 0 && pluginId !== 'placeholder'
}

// Engine APG uids are non-negative integers. Anything else (null, -1, NaN,
// failure sentinels) means "no engine node".
function normalizeEngineNodeId(value) {
  return Number.isInteger(value) && value >= 0 ? value : null
}

export function buildGraphEffectNodeHydrationPayload(graphState) {
  if (!graphState || !Array.isArray(graphState.nodes)) return []

  return graphState.nodes.reduce((payload, node) => {
    if (!node || node.type !== 'effect') return payload

    const data = node.data ?? {}
    const effectInstanceId =
      typeof data.effectInstanceId === 'string' && data.effectInstanceId.length > 0
        ? data.effectInstanceId
        : ''
    const pluginId =
      typeof data.pluginId === 'string' && data.pluginId.length > 0
        ? data.pluginId
        : ''

    if (!effectInstanceId || !isInstantiablePluginId(pluginId) || data.missing === true) {
      return payload
    }

    const entry = {
      effectInstanceId,
      pluginId,
      graphNodeId: typeof node.id === 'string' ? node.id : '',
    }
    if (typeof data.displayName === 'string' && data.displayName.length > 0) {
      entry.displayName = data.displayName
    }
    payload.push(entry)
    return payload
  }, [])
}

function normalizeGraphHydrationMapping(mapping) {
  if (!mapping || typeof mapping !== 'object') return {}
  return Object.entries(mapping).reduce((next, [effectInstanceId, engineNodeId]) => {
    if (typeof effectInstanceId !== 'string' || effectInstanceId.length === 0) return next
    const normalized = normalizeEngineNodeId(engineNodeId)
    if (normalized != null) next[effectInstanceId] = normalized
    return next
  }, {})
}

function normalizeGraphHydrationResult(result) {
  const mapping = normalizeGraphHydrationMapping(result?.mapping)
  return {
    ok: result?.ok !== false,
    reason: result?.reason,
    mapping,
    skipped: Array.isArray(result?.skipped) ? result.skipped : [],
    failures: Array.isArray(result?.failures) ? result.failures : [],
  }
}

// ── Session-only effectInstanceId → engineNodeId cache (FXG.3-b) ───────────
// graphEngineNodeIds mirrors the engine's transient map for the current
// session. It is NOT persisted (engine uids are reassigned each session) and
// is wiped on project load. The bridge remains the authoritative resolver via
// getGraphEffectEngineNodeId; this cache only records what we instantiated so
// removeGraphNodeForTrack knows which nodes are engine-backed.
function normalizeGraphRuntimeSyncResult(result) {
  return {
    ok: result?.ok === true,
    reason: typeof result?.reason === 'string' && result.reason.length > 0
      ? result.reason
      : (result?.ok === true ? 'graph_routing_active' : 'engine_sync_failed'),
    // FXG.3-d: 'linear' | 'parallel' | 'passthrough' | 'disconnected' | 'none'.
    mode: typeof result?.mode === 'string' ? result.mode : undefined,
    phase: typeof result?.phase === 'string' ? result.phase : 'FXG.3-d',
    fallback: typeof result?.fallback === 'string' ? result.fallback : undefined,
    fallbackApplied: result?.fallbackApplied === true,
    pathEffectCount: Number.isInteger(result?.pathEffectCount) ? result.pathEffectCount : 0,
    appliedConnectionCount: Number.isInteger(result?.appliedConnectionCount)
      ? result.appliedConnectionCount
      : 0,
    updatedAt: Date.now(),
  }
}

function getSessionEngineNodeId(state, key, effectInstanceId) {
  if (typeof effectInstanceId !== 'string' || effectInstanceId.length === 0) return null
  return normalizeEngineNodeId(state.graphEngineNodeIds?.[key]?.[effectInstanceId])
}

function setSessionEngineNodeId(set, key, effectInstanceId, engineNodeId) {
  set((state) => ({
    graphEngineNodeIds: {
      ...state.graphEngineNodeIds,
      [key]: { ...(state.graphEngineNodeIds[key] ?? {}), [effectInstanceId]: engineNodeId },
    },
  }))
}

function mergeSessionEngineNodeIds(set, key, mapping) {
  const normalized = normalizeGraphHydrationMapping(mapping)
  if (Object.keys(normalized).length === 0) return normalized

  set((state) => ({
    graphEngineNodeIds: {
      ...state.graphEngineNodeIds,
      [key]: { ...(state.graphEngineNodeIds[key] ?? {}), ...normalized },
    },
  }))
  return normalized
}

function clearSessionEngineNodeId(set, key, effectInstanceId) {
  set((state) => {
    const trackMap = state.graphEngineNodeIds[key]
    if (!trackMap || !(effectInstanceId in trackMap)) return {}
    const nextTrackMap = { ...trackMap }
    delete nextTrackMap[effectInstanceId]
    return { graphEngineNodeIds: { ...state.graphEngineNodeIds, [key]: nextTrackMap } }
  })
}

function setGraphRuntimeStatus(set, key, result) {
  const status = normalizeGraphRuntimeSyncResult(result)
  set((state) => ({
    graphRuntimeStatuses: {
      ...state.graphRuntimeStatuses,
      [key]: status,
    },
  }))
  return status
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
// Mutations commit graphState first; FXG.3-c-b then syncs only supported
// linear graph-mode routing to the engine.

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

async function syncGraphRuntimeForTrack(set, key, graphState, options = {}) {
  const warn = options.warn ?? console.warn
  const audio = defaultAudioApi()
  // FXG.3-d: prefer the general graph sync (linear + parallel). Fall back to the
  // legacy linear symbol so older injected APIs / addons keep working.
  const syncGraphTopology =
    options.syncGraphTopology ?? options.syncLinearGraphTopology ??
    audio.syncGraphTopology ?? audio.syncLinearGraphTopology

  if (typeof syncGraphTopology !== 'function') {
    return setGraphRuntimeStatus(set, key, {
      ok: false,
      reason: 'engine_unavailable',
      phase: 'FXG.3-d',
      fallback: 'none',
      fallbackApplied: false,
    })
  }

  const payload = buildLinearGraphTopologyPayload(graphState)
  try {
    const result = await syncGraphTopology(Number(key), payload)
    return setGraphRuntimeStatus(set, key, result)
  } catch (e) {
    warn?.('[FXG] graph routing sync failed', {
      trackId: key,
      error: e?.message ?? e,
    })
    return setGraphRuntimeStatus(set, key, {
      ok: false,
      reason: 'engine_sync_failed',
      phase: 'FXG.3-d',
      fallback: 'unknown',
      fallbackApplied: false,
    })
  }
}

// FXG.3-d: when a Mixer Chain is converted to a graph, the converted effect
// nodes already correspond to live engine processors (the chain slots). Build a
// { effectInstanceId, engineNodeId } adoption mapping so graph mode can take
// ownership of those processors WITHOUT re-instantiating them — preserving each
// effect's parameter state. `sourceChainSlotIndex` (set by createGraphStateFromChain)
// indexes back into the original chain slot array, whose slots carry the engine nodeId.
function buildChainAdoptionMapping(graphState, chainSlots) {
  const slots = Array.isArray(chainSlots) ? chainSlots : []
  const nodes = Array.isArray(graphState?.nodes) ? graphState.nodes : []
  const mapping = []
  for (const node of nodes) {
    if (node?.type !== 'effect') continue
    const data = node.data ?? {}
    const effectInstanceId = data.effectInstanceId
    if (typeof effectInstanceId !== 'string' || effectInstanceId.length === 0) continue
    if (data.pluginId === 'placeholder') continue
    if (!Number.isInteger(data.sourceChainSlotIndex)) continue
    const engineNodeId = normalizeEngineNodeId(slots[data.sourceChainSlotIndex]?.nodeId)
    if (engineNodeId == null) continue
    mapping.push({ effectInstanceId, engineNodeId })
  }
  return mapping
}

async function commitValidatedGraphState(set, key, validation, options = {}) {
  const warn = options.warn ?? console.warn
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

  const runtimeSync = options.syncRuntime === false
    ? undefined
    : await syncGraphRuntimeForTrack(set, key, validation.graphState, options)

  return { ok: true, graphState: validation.graphState, status: validation, runtimeSync }
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

  return commitValidatedGraphState(set, key, validation, options)
}

const GRAPH_HISTORY_STACK_LIMIT = 100

function graphRuntimeTopologyChanged(beforeGraphState, afterGraphState) {
  const runtimeRelevantNodeData = (data) => {
    if (!data || typeof data !== 'object') return null
    const { exposedParameterPorts, ...rest } = data
    return rest
  }
  const structuralSnapshot = (graphState) => ({
    nodes: Array.isArray(graphState?.nodes)
      ? graphState.nodes.map((node) => ({
        id: node?.id,
        type: node?.type,
        data: runtimeRelevantNodeData(node?.data),
      }))
      : [],
    edges: Array.isArray(graphState?.edges) ? graphState.edges : [],
  })
  return JSON.stringify(structuralSnapshot(beforeGraphState)) !==
    JSON.stringify(structuralSnapshot(afterGraphState))
}

function normalizeGraphHistory(history) {
  return {
    undoStack: Array.isArray(history?.undoStack) ? history.undoStack : [],
    redoStack: Array.isArray(history?.redoStack) ? history.redoStack : [],
  }
}

function capGraphHistoryStack(stack) {
  return stack.length > GRAPH_HISTORY_STACK_LIMIT
    ? stack.slice(stack.length - GRAPH_HISTORY_STACK_LIMIT)
    : stack
}

function createGraphEditTransaction(type, key, beforeGraphState, afterGraphState) {
  return {
    type,
    label: type,
    trackId: key,
    beforeGraphState: cloneJson(beforeGraphState),
    afterGraphState: cloneJson(afterGraphState),
  }
}

function recordGraphEditTransaction(set, key, type, beforeGraphState, afterGraphState) {
  if (!beforeGraphState || !afterGraphState) return
  if (JSON.stringify(beforeGraphState) === JSON.stringify(afterGraphState)) return

  const transaction = createGraphEditTransaction(type, key, beforeGraphState, afterGraphState)
  set((state) => {
    const history = normalizeGraphHistory(state.graphHistories?.[key])
    return {
      graphHistories: {
        ...state.graphHistories,
        [key]: {
          undoStack: capGraphHistoryStack([...history.undoStack, transaction]),
          redoStack: [],
        },
      },
    }
  })
}

function clearGraphHistoryForTrack(set, key) {
  set((state) => {
    if (!state.graphHistories?.[key]) return {}
    const nextHistories = { ...state.graphHistories }
    delete nextHistories[key]
    return { graphHistories: nextHistories }
  })
}

function collectInstantiableGraphEffectNodes(graphState) {
  const nodes = Array.isArray(graphState?.nodes) ? graphState.nodes : []
  return nodes.reduce((map, node) => {
    if (node?.type !== 'effect') return map
    const data = node.data ?? {}
    const effectInstanceId =
      typeof data.effectInstanceId === 'string' && data.effectInstanceId.length > 0
        ? data.effectInstanceId
        : ''
    const pluginId =
      typeof data.pluginId === 'string' && data.pluginId.length > 0
        ? data.pluginId
        : ''
    if (!effectInstanceId || !isInstantiablePluginId(pluginId) || data.missing === true) {
      return map
    }
    if (!map.has(effectInstanceId)) {
      map.set(effectInstanceId, {
        effectInstanceId,
        pluginId,
        graphNodeId: typeof node.id === 'string' ? node.id : '',
      })
    }
    return map
  }, new Map())
}

async function rollbackCreatedGraphEffects(key, effectInstanceIds, options = {}) {
  if (effectInstanceIds.length === 0) return
  const removeNode = options.removeGraphEngineNode ?? defaultAudioApi().removeGraphEffectNode
  if (typeof removeNode !== 'function') return
  const warn = options.warn ?? console.warn
  for (const effectInstanceId of effectInstanceIds) {
    try {
      await removeNode(Number(key), effectInstanceId)
    } catch (e) {
      warn?.('[FXG] graph history processor rollback failed', {
        trackId: key,
        effectInstanceId,
        error: e?.message ?? e,
      })
    }
  }
}

async function instantiateGraphEffectForHistory(key, entry, options = {}) {
  const instantiate = options.instantiateGraphEngineNode ?? defaultAudioApi().addGraphEffectNode
  if (typeof instantiate !== 'function') return { ok: false, reason: 'engine_unavailable' }
  try {
    const engineNodeId = normalizeEngineNodeId(
      await instantiate(Number(key), entry.effectInstanceId, entry.pluginId),
    )
    if (engineNodeId == null) return { ok: false, reason: 'engine_instantiation_failed' }
    return { ok: true, engineNodeId }
  } catch (e) {
    ;(options.warn ?? console.warn)?.('[FXG] graph history engine instantiation failed', {
      trackId: key,
      effectInstanceId: entry.effectInstanceId,
      error: e?.message ?? e,
    })
    return { ok: false, reason: 'engine_instantiation_failed' }
  }
}

async function removeGraphEffectForHistory(key, effectInstanceId, options = {}) {
  const removeNode = options.removeGraphEngineNode ?? defaultAudioApi().removeGraphEffectNode
  if (typeof removeNode !== 'function') return { ok: false, reason: 'engine_unavailable' }
  try {
    const removedOk = (await removeNode(Number(key), effectInstanceId)) !== false
    return removedOk
      ? { ok: true }
      : { ok: false, reason: 'engine_removal_failed' }
  } catch (e) {
    ;(options.warn ?? console.warn)?.('[FXG] graph history engine removal failed', {
      trackId: key,
      effectInstanceId,
      error: e?.message ?? e,
    })
    return { ok: false, reason: 'engine_removal_failed' }
  }
}

async function reconcileGraphEngineNodesForHistory(set, get, key, currentGraphState, targetGraphState, options = {}) {
  const currentEffects = collectInstantiableGraphEffectNodes(currentGraphState)
  const targetEffects = collectInstantiableGraphEffectNodes(targetGraphState)
  const createdMappings = {}
  const createdEffectInstanceIds = []
  const removedEffectInstanceIds = []

  for (const entry of targetEffects.values()) {
    if (currentEffects.has(entry.effectInstanceId)) continue
    if (getSessionEngineNodeId(get(), key, entry.effectInstanceId) != null) continue

    const result = await instantiateGraphEffectForHistory(key, entry, options)
    if (!result.ok) {
      await rollbackCreatedGraphEffects(key, createdEffectInstanceIds, options)
      return result
    }
    createdMappings[entry.effectInstanceId] = result.engineNodeId
    createdEffectInstanceIds.push(entry.effectInstanceId)
  }

  for (const entry of currentEffects.values()) {
    if (targetEffects.has(entry.effectInstanceId)) continue
    if (getSessionEngineNodeId(get(), key, entry.effectInstanceId) == null) continue

    const result = await removeGraphEffectForHistory(key, entry.effectInstanceId, options)
    if (!result.ok) {
      await rollbackCreatedGraphEffects(key, createdEffectInstanceIds, options)
      return result
    }
    removedEffectInstanceIds.push(entry.effectInstanceId)
  }

  return { ok: true, createdMappings, removedEffectInstanceIds }
}

async function applyGraphHistoryTransition(set, get, key, targetGraphState, options = {}) {
  const access = readGraphStateForMutation(get(), key)
  if (!access.ok) return access

  const validate = options.validateGraphState ?? validateGraphState
  const warn = options.warn ?? console.warn
  const validation = validate(targetGraphState, key)
  if (validation.status !== 'valid') {
    warn?.('[FXG] graph history target rejected by validation', {
      trackId: key,
      reason: validation.reason ?? validation.status,
      warnings: validation.warnings,
    })
    return { ok: false, reason: 'invalid_graph_state', status: validation }
  }

  const lifecycle = await reconcileGraphEngineNodesForHistory(
    set,
    get,
    key,
    access.graphState,
    validation.graphState,
    options,
  )
  if (!lifecycle.ok) return lifecycle

  const shouldSyncRuntime = graphRuntimeTopologyChanged(access.graphState, validation.graphState)
  const applied = await commitValidatedGraphState(set, key, validation, {
    ...options,
    syncRuntime: false,
  })

  if (Object.keys(lifecycle.createdMappings).length > 0) {
    mergeSessionEngineNodeIds(set, key, lifecycle.createdMappings)
  }
  for (const effectInstanceId of lifecycle.removedEffectInstanceIds) {
    clearSessionEngineNodeId(set, key, effectInstanceId)
  }

  const runtimeSync = shouldSyncRuntime
    ? await syncGraphRuntimeForTrack(set, key, validation.graphState, options)
    : undefined

  return {
    ...applied,
    runtimeSync,
    lifecycle,
  }
}

async function hydrateGraphEngineNodesForTrack(key, graphState, options = {}) {
  const warn = options.warn ?? console.warn
  const payload = buildGraphEffectNodeHydrationPayload(graphState)
  if (payload.length === 0) {
    return { ok: true, mapping: {}, skipped: [], failures: [] }
  }

  const audio = defaultAudioApi()
  const hydrate = options.hydrateGraphEngineNodes ?? audio.hydrateGraphEffectNodes
  if (typeof hydrate === 'function') {
    try {
      return normalizeGraphHydrationResult(await hydrate(Number(key), payload))
    } catch (e) {
      warn?.('[FXG] graph-owned engine hydration failed', {
        trackId: key,
        error: e?.message ?? e,
      })
      return {
        ok: false,
        reason: 'engine_hydration_failed',
        mapping: {},
        skipped: [],
        failures: payload.map((node) => ({ ...node, reason: 'engine_hydration_failed' })),
      }
    }
  }

  const instantiate = options.instantiateGraphEngineNode ?? audio.addGraphEffectNode
  if (typeof instantiate !== 'function') {
    return {
      ok: false,
      reason: 'engine_unavailable',
      mapping: {},
      skipped: [],
      failures: payload.map((node) => ({ ...node, reason: 'engine_unavailable' })),
    }
  }

  const mapping = {}
  const failures = []
  for (const node of payload) {
    try {
      const engineNodeId = normalizeEngineNodeId(
        await instantiate(Number(key), node.effectInstanceId, node.pluginId),
      )
      if (engineNodeId == null) {
        failures.push({ ...node, reason: 'engine_instantiation_failed' })
      } else {
        mapping[node.effectInstanceId] = engineNodeId
      }
    } catch (e) {
      failures.push({
        ...node,
        reason: 'engine_instantiation_failed',
        error: e?.message ?? e,
      })
    }
  }

  return { ok: failures.length === 0, mapping, skipped: [], failures }
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
  // { [key: String(trackId)]: { [effectInstanceId]: engineNodeId } }
  // Session-only graph-owned engine node cache (FXG.3-b). Never persisted.
  graphEngineNodeIds: {},
  // { [key: String(trackId)]: { ok, reason, updatedAt } }
  // Session-only FXG.3-c-b runtime routing sync status. Never persisted.
  graphRuntimeStatuses: {},
  // { [key: String(trackId)]: { undoStack, redoStack } }
  // Session-only FX Graph edit history. Never persisted and never shared with
  // Mixer Chain / native undo history.
  graphHistories: {},

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
      // Engine uids are session-transient; FXG.3-c-a repopulates this via
      // hydrateGraphEffectInstancesForLoadedProject after graphState loads.
      graphEngineNodeIds: {},
      graphRuntimeStatuses: {},
      graphHistories: {},
    })
  },

  hydrateGraphEffectInstancesForLoadedProject: async (options = {}) => {
    const state = get()
    const warn = options.warn ?? console.warn
    const results = {}

    for (const [key, graphState] of Object.entries(state.graphStates)) {
      if (key === 'master') continue
      if (resolveFxMode(state.fxModes, key) !== 'graph') continue
      if (!graphState || !Array.isArray(graphState.nodes) || !Array.isArray(graphState.edges)) continue

      const result = await hydrateGraphEngineNodesForTrack(key, graphState, options)
      results[key] = result
      const mapping = mergeSessionEngineNodeIds(set, key, result.mapping)
      const runtimeSync = await syncGraphRuntimeForTrack(set, key, graphState, options)
      results[key] = { ...result, runtimeSync }

      if (!result.ok || result.failures.length > 0) {
        warn?.('[FXG] graph-owned effect hydration incomplete', {
          trackId: key,
          reason: result.reason,
          mapped: Object.keys(mapping).length,
          failures: result.failures,
        })
      }
    }

    const ok = Object.values(results).every((result) => result.ok !== false)
    return { ok, results }
  },

  setFxMode: (key, mode) => {
    // FX ownership transfer undo/redo is intentionally deferred to FXG.2.
    const nextMode = key !== 'master' && mode === 'graph' ? 'graph' : DEFAULT_FX_MODE
    set((state) => {
      const nextHistories = { ...state.graphHistories }
      delete nextHistories[key]
      return {
        fxModes: { ...state.fxModes, [key]: nextMode },
        graphHistories: nextHistories,
      }
    })
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
      graphHistories: { ...currentState.graphHistories, [key]: { undoStack: [], redoStack: [] } },
    }))

    // FXG.3-d ownership transfer: adopt the existing chain processors as
    // graph-owned (preserving their settings), then sync the runtime so graph
    // mode owns routing and the old chain route stops feeding Track Output.
    const audio = defaultAudioApi()
    const adoptGraphEffectNodes = options.adoptGraphEffectNodes ?? audio.adoptGraphEffectNodes
    const adoptionMapping = buildChainAdoptionMapping(validation.graphState, chain)
    if (adoptionMapping.length > 0 && typeof adoptGraphEffectNodes === 'function') {
      try {
        const adoptResult = await adoptGraphEffectNodes(Number(key), adoptionMapping)
        if (adoptResult?.adopted && typeof adoptResult.adopted === 'object') {
          mergeSessionEngineNodeIds(set, key, adoptResult.adopted)
        }
      } catch (e) {
        // Do not abort: the entry sync below still clears any stale chain route
        // (fail-closed silence), so graph mode never leaks the old route.
        warnFxgConversion(warn, key, 'graph_adoption_failed', { error: e?.message ?? e })
      }
    }

    const runtimeSync = await syncGraphRuntimeForTrack(set, key, validation.graphState, options)

    return {
      ok: true,
      graphState: validation.graphState,
      status: validation,
      runtimeSync,
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
    if (typeof persistGraphState !== 'function') {
      recordGraphEditTransaction(set, key, 'move_graph_node', graphState, validation.graphState)
      return true
    }

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

    recordGraphEditTransaction(set, key, 'move_graph_node', graphState, validation.graphState)
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

  canUndoGraphEdit: (trackId) => {
    const key = normalizeNormalTrackKey(trackId)
    if (key == null) return false
    const state = get()
    if (resolveFxMode(state.fxModes, key) !== 'graph') return false
    return normalizeGraphHistory(state.graphHistories?.[key]).undoStack.length > 0
  },

  canRedoGraphEdit: (trackId) => {
    const key = normalizeNormalTrackKey(trackId)
    if (key == null) return false
    const state = get()
    if (resolveFxMode(state.fxModes, key) !== 'graph') return false
    return normalizeGraphHistory(state.graphHistories?.[key]).redoStack.length > 0
  },

  undoGraphEditForTrack: async (trackId, options = {}) => {
    const access = readGraphStateForMutation(get(), trackId)
    if (!access.ok) return access

    const history = normalizeGraphHistory(get().graphHistories?.[access.key])
    const transaction = history.undoStack[history.undoStack.length - 1]
    if (!transaction) return { ok: false, reason: 'nothing_to_undo' }

    const applied = await applyGraphHistoryTransition(
      set,
      get,
      access.key,
      transaction.beforeGraphState,
      options,
    )
    if (!applied.ok) return applied

    set((state) => {
      const currentHistory = normalizeGraphHistory(state.graphHistories?.[access.key])
      const undoStack = [...currentHistory.undoStack]
      const popped = undoStack.pop()
      return {
        graphHistories: {
          ...state.graphHistories,
          [access.key]: {
            undoStack,
            redoStack: capGraphHistoryStack([
              ...currentHistory.redoStack,
              popped ?? transaction,
            ]),
          },
        },
      }
    })

    return { ...applied, transaction }
  },

  redoGraphEditForTrack: async (trackId, options = {}) => {
    const access = readGraphStateForMutation(get(), trackId)
    if (!access.ok) return access

    const history = normalizeGraphHistory(get().graphHistories?.[access.key])
    const transaction = history.redoStack[history.redoStack.length - 1]
    if (!transaction) return { ok: false, reason: 'nothing_to_redo' }

    const applied = await applyGraphHistoryTransition(
      set,
      get,
      access.key,
      transaction.afterGraphState,
      options,
    )
    if (!applied.ok) return applied

    set((state) => {
      const currentHistory = normalizeGraphHistory(state.graphHistories?.[access.key])
      const redoStack = [...currentHistory.redoStack]
      const popped = redoStack.pop()
      return {
        graphHistories: {
          ...state.graphHistories,
          [access.key]: {
            undoStack: capGraphHistoryStack([
              ...currentHistory.undoStack,
              popped ?? transaction,
            ]),
            redoStack,
          },
        },
      }
    })

    return { ...applied, transaction }
  },

  // FXG.3-c-b graphState mutation actions. Graph effect lifecycle owns separate
  // graph-owned engine processors (never effectChains). Each requires a normal
  // track owned by graph mode. Routing edits sync supported linear topology.
  addGraphEffectNodeForTrack: async (trackId, nodeDraft = {}, options = {}) => {
    const access = readGraphStateForMutation(get(), trackId)
    if (!access.ok) return access

    const draft = buildGraphEffectNodeDraft(access.graphState, nodeDraft, options)
    const mutation = addGraphEffectNode(access.graphState, draft, { idFactory: options.idFactory })
    if (!mutation.ok) return mutation

    // Real pluginId → instantiate a graph-owned engine processor BEFORE
    // committing graphState (fail-fast: never persist a node we could not back).
    // Placeholder/data-only nodes stay renderer-only with no engine processor.
    let engineNodeId = null
    if (isInstantiablePluginId(draft.pluginId)) {
      const instantiate = options.instantiateGraphEngineNode ?? defaultAudioApi().addGraphEffectNode
      if (typeof instantiate !== 'function') {
        return { ok: false, reason: 'engine_unavailable' }
      }
      try {
        engineNodeId = normalizeEngineNodeId(
          await instantiate(Number(access.key), draft.effectInstanceId, draft.pluginId),
        )
      } catch (e) {
        ;(options.warn ?? console.warn)?.('[FXG] graph-owned engine instantiation failed', {
          trackId: access.key,
          effectInstanceId: draft.effectInstanceId,
          error: e?.message ?? e,
        })
        return { ok: false, reason: 'engine_instantiation_failed' }
      }
      if (engineNodeId == null) {
        return { ok: false, reason: 'engine_instantiation_failed' }
      }
    }

    const applied = await applyGraphStateMutation(set, access.key, mutation.graphState, options)
    if (!applied.ok) {
      // Roll back the processor we just created so the engine does not leak a
      // node that never made it into the persisted graphState.
      if (engineNodeId != null) {
        const removeNode = options.removeGraphEngineNode ?? defaultAudioApi().removeGraphEffectNode
        try { await removeNode?.(Number(access.key), draft.effectInstanceId) } catch { /* best effort */ }
      }
      return applied
    }

    if (engineNodeId != null) {
      setSessionEngineNodeId(set, access.key, draft.effectInstanceId, engineNodeId)
    }
    recordGraphEditTransaction(
      set,
      access.key,
      'add_graph_effect_node',
      access.graphState,
      applied.graphState,
    )
    return { ...applied, effectInstanceId: draft.effectInstanceId, engineNodeId }
  },

  removeGraphNodeForTrack: async (trackId, nodeId, options = {}) => {
    const access = readGraphStateForMutation(get(), trackId)
    if (!access.ok) return access

    const mutation = removeGraphNode(access.graphState, nodeId)
    if (!mutation.ok) return mutation

    // Engine-backed nodes (real pluginId we instantiated this session) must have
    // their graph-owned processor destroyed BEFORE the graphState removal is
    // committed. Fail-fast on engine removal failure so the renderer and engine
    // never diverge. Placeholder/uninstantiated nodes skip the engine entirely.
    const removedNode = access.graphState.nodes.find((n) => n.id === nodeId)
    const effectInstanceId = removedNode?.data?.effectInstanceId
    const engineNodeId = getSessionEngineNodeId(get(), access.key, effectInstanceId)
    const isEngineBacked = engineNodeId != null

    if (isEngineBacked) {
      const removeNode = options.removeGraphEngineNode ?? defaultAudioApi().removeGraphEffectNode
      if (typeof removeNode !== 'function') {
        return { ok: false, reason: 'engine_unavailable' }
      }
      let removedOk = false
      try {
        removedOk = (await removeNode(Number(access.key), effectInstanceId)) !== false
      } catch (e) {
        ;(options.warn ?? console.warn)?.('[FXG] graph-owned engine removal failed', {
          trackId: access.key,
          effectInstanceId,
          error: e?.message ?? e,
        })
        return { ok: false, reason: 'engine_removal_failed' }
      }
      if (!removedOk) return { ok: false, reason: 'engine_removal_failed' }
    }

    const applied = await applyGraphStateMutation(set, access.key, mutation.graphState, options)
    if (applied.ok && isEngineBacked) {
      clearSessionEngineNodeId(set, access.key, effectInstanceId)
    }
    if (applied.ok) {
      recordGraphEditTransaction(
        set,
        access.key,
        'remove_graph_node',
        access.graphState,
        applied.graphState,
      )
    }
    return applied
  },

  connectGraphNodesForTrack: async (trackId, connectionDraft, options = {}) => {
    const access = readGraphStateForMutation(get(), trackId)
    if (!access.ok) return access

    const mutation = connectGraphNodes(access.graphState, connectionDraft, { idFactory: options.idFactory })
    if (!mutation.ok) return mutation

    const applied = await applyGraphStateMutation(set, access.key, mutation.graphState, options)
    if (applied.ok) {
      recordGraphEditTransaction(
        set,
        access.key,
        'connect_graph_nodes',
        access.graphState,
        applied.graphState,
      )
    }
    return applied
  },

  disconnectGraphEdgeForTrack: async (trackId, edgeId, options = {}) => {
    const access = readGraphStateForMutation(get(), trackId)
    if (!access.ok) return access

    const mutation = disconnectGraphEdge(access.graphState, edgeId)
    if (!mutation.ok) return mutation

    const applied = await applyGraphStateMutation(set, access.key, mutation.graphState, options)
    if (applied.ok) {
      recordGraphEditTransaction(
        set,
        access.key,
        'disconnect_graph_edge',
        access.graphState,
        applied.graphState,
      )
    }
    return applied
  },

  // ── FXG.4-a graph-owned effect parameter descriptors ──────────────────────
  // Read/write normalized [0,1] parameters for a graph-owned effect node. These
  // are gated by fxMode === 'graph', address the engine by the stable
  // effectInstanceId (NEVER by graphState node id and NEVER by engine node id),
  // and never mutate effectChains or graphState. They are pure engine queries —
  // the renderer holds the descriptor list in local UI state, nothing persists.
  // FXG.4-b persists only exposed parameter port choices. It skips runtime sync
  // because no modulation, automation, or macro execution exists in this phase.
  toggleGraphNodeParameterPortForTrack: async (trackId, nodeId, parameterDescriptor, options = {}) => {
    const access = readGraphStateForMutation(get(), trackId)
    if (!access.ok) return access

    const mutation = toggleExposedParameterPort(access.graphState, nodeId, parameterDescriptor)
    if (!mutation.ok) return mutation

    const applied = await applyGraphStateMutation(
      set,
      access.key,
      mutation.graphState,
      { ...options, syncRuntime: false },
    )
    if (applied.ok) {
      recordGraphEditTransaction(
        set,
        access.key,
        mutation.exposed ? 'expose_parameter_port' : 'unexpose_parameter_port',
        access.graphState,
        applied.graphState,
      )
    }
    return {
      ...applied,
      exposed: mutation.exposed,
      parameterPort: mutation.parameterPort,
    }
  },

  // FXG.4-a live descriptor read/write APIs remain pure engine queries.
  fetchGraphEffectParameters: async (trackId, effectInstanceId, options = {}) => {
    const key = normalizeNormalTrackKey(trackId)
    if (key == null) {
      return { ok: false, reason: trackId === 'master' ? 'master_track' : 'no_track' }
    }
    if (resolveFxMode(get().fxModes, key) !== 'graph') {
      return { ok: false, reason: 'not_graph_mode' }
    }
    if (typeof effectInstanceId !== 'string' || effectInstanceId.length === 0) {
      return { ok: false, reason: 'missing_effect_instance_id' }
    }

    const audio = defaultAudioApi()
    const getParameters = options.getGraphEffectParameters ?? audio.getGraphEffectParameters
    if (typeof getParameters !== 'function') {
      return { ok: false, reason: 'engine_unavailable' }
    }

    try {
      const raw = await getParameters(Number(key), effectInstanceId)
      const result = normalizeGraphParameterResult(raw)
      if (typeof options.graphNodeId === 'string' && options.graphNodeId.length > 0) {
        result.graphNodeId = options.graphNodeId
      }
      return result
    } catch (e) {
      ;(options.warn ?? console.warn)?.('[FXG] graph effect parameter fetch failed', {
        trackId: key,
        effectInstanceId,
        error: e?.message ?? e,
      })
      return { ok: false, reason: 'engine_error' }
    }
  },

  getGraphEffectParameterValue: async (trackId, effectInstanceId, parameterId, options = {}) => {
    const key = normalizeNormalTrackKey(trackId)
    if (key == null) {
      return { ok: false, reason: trackId === 'master' ? 'master_track' : 'no_track' }
    }
    if (resolveFxMode(get().fxModes, key) !== 'graph') {
      return { ok: false, reason: 'not_graph_mode' }
    }
    if (typeof effectInstanceId !== 'string' || effectInstanceId.length === 0) {
      return { ok: false, reason: 'missing_effect_instance_id' }
    }
    if (typeof parameterId !== 'string' || parameterId.length === 0) {
      return { ok: false, reason: 'missing_parameter_id' }
    }

    const audio = defaultAudioApi()
    const getValue = options.getGraphEffectParameterValue ?? audio.getGraphEffectParameterValue
    if (typeof getValue !== 'function') {
      return { ok: false, reason: 'engine_unavailable' }
    }

    try {
      const raw = await getValue(Number(key), effectInstanceId, parameterId)
      return normalizeGraphParameterResult(raw)
    } catch (e) {
      ;(options.warn ?? console.warn)?.('[FXG] graph effect parameter value fetch failed', {
        trackId: key,
        effectInstanceId,
        parameterId,
        error: e?.message ?? e,
      })
      return { ok: false, reason: 'engine_error' }
    }
  },

  setGraphEffectParameterNormalized: async (
    trackId,
    effectInstanceId,
    parameterId,
    normalizedValue,
    options = {},
  ) => {
    const key = normalizeNormalTrackKey(trackId)
    if (key == null) {
      return { ok: false, reason: trackId === 'master' ? 'master_track' : 'no_track' }
    }
    if (resolveFxMode(get().fxModes, key) !== 'graph') {
      return { ok: false, reason: 'not_graph_mode' }
    }
    if (typeof effectInstanceId !== 'string' || effectInstanceId.length === 0) {
      return { ok: false, reason: 'missing_effect_instance_id' }
    }
    if (typeof parameterId !== 'string' || parameterId.length === 0) {
      return { ok: false, reason: 'missing_parameter_id' }
    }
    const clamped = clampNormalizedValue(normalizedValue)
    if (clamped == null) {
      return { ok: false, reason: 'invalid_value' }
    }

    const audio = defaultAudioApi()
    const setParameter =
      options.setGraphEffectParameterNormalized ?? audio.setGraphEffectParameterNormalized
    if (typeof setParameter !== 'function') {
      return { ok: false, reason: 'engine_unavailable' }
    }

    try {
      const raw = await setParameter(Number(key), effectInstanceId, parameterId, clamped)
      return normalizeGraphParameterResult(raw)
    } catch (e) {
      ;(options.warn ?? console.warn)?.('[FXG] graph effect parameter set failed', {
        trackId: key,
        effectInstanceId,
        parameterId,
        error: e?.message ?? e,
      })
      return { ok: false, reason: 'engine_error' }
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
    graphEngineNodeIds: {},
    graphRuntimeStatuses: {},
    graphHistories: {},
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
    ?.then?.(async (tracks) => {
      useEffectChainStore.getState().hydrateFxModesFromTracks(tracks)
      await useEffectChainStore.getState().hydrateGraphEffectInstancesForLoadedProject()
    })
    ?.catch?.((e) => {
      console.warn('[effectChainStore] fxMode hydration failed:', e?.message)
    })
})

export default useEffectChainStore
