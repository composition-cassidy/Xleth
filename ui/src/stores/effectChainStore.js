import { create } from 'zustand'
import useEqStore from './eqStore.js'
import useCompressorStore from './compressorStore.js'
import useDistortionStore from './distortionStore.js'
import useWaveshaperStore from './waveshaperStore.js'
import useDelayStore from './delayStore.js'
import useChorusStore from './chorusStore.js'
// FXG-SC.6C — reuse the proven mixer-chain sidechain transport helpers so graph
// route reconciliation drives the SAME native SidechainRoute system, never a second
// engine. normalizeSidechainRoutesFromRoutingSnapshot parses timeline.getRouting();
// COMPRESSOR_EXTERNAL_SIDECHAIN_PARAM_ID is the stock compressor's external-key flag.
import useMixerStore, {
  normalizeSidechainRoutesFromRoutingSnapshot,
  COMPRESSOR_EXTERNAL_SIDECHAIN_PARAM_ID,
} from './mixerStore.js'
import { createGraphStateFromChain } from '../fxgraph/chainToGraphState.js'
import { buildLinearGraphTopologyPayload } from '../fxgraph/linearGraphTopology.js'
import {
  loadGraphState,
  validateGraphState,
  addGraphEffectNode,
  addGraphMacroNode,
  addGraphEnvelopeNode,
  updateGraphEnvelopeNodeData,
  removeGraphNode,
  connectGraphNodes,
  connectMacroToParameter,
  connectEnvelopeToParameter,
  disconnectGraphEdge,
  collectMacroParameterWrites,
  collectEnvelopeParameterWrites,
  isParameterEdge,
  updateGraphMacroValue,
  renameGraphMacroNode,
  toggleExposedParameterPort,
  updateParameterEdgeMapping,
  // FXG-SC.6B — Sidechain Input node + sidechain edge mutations
  addSidechainInputNode,
  setSidechainInputSource,
  connectSidechainNodes,
  disconnectSidechainEdge,
  isSidechainEdge,
  // FXG-SC.6C — pure derivation of desired sidechain route intent from graphState
  deriveGraphSidechainIntent,
} from '../fxgraph/graphState.js'
import {
  showMacroAutomationLane,
  hideMacroAutomationLane,
  removeMacroAutomationLane,
  createMacroAutomationClip,
  moveMacroAutomationClip,
  resizeMacroAutomationClip,
  toggleMacroAutomationClipLoop,
  deleteMacroAutomationClip,
  pasteMacroAutomationClip,
  buildMacroAutomationClipCopyPayload,
  addMacroAutomationPoint,
  moveMacroAutomationPoint,
  deleteMacroAutomationPoint,
  setMacroAutomationPointCurve,
  evaluateMacroAutomationForMacro,
} from '../fxgraph/macroAutomation.js'
import {
  normalizeEnvelopeRuntimeSettings,
  evaluateEnvelopeOutput,
} from '../fxgraph/envelopeModulation.js'

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

function stripRuntimeGraphStateMetadata(graphState) {
  const copy = cloneJson(graphState)
  if (!Array.isArray(copy?.nodes)) return copy
  copy.nodes = copy.nodes.map((node) => {
    if (node?.type !== 'effect' || node?.data?.sidechain == null) return node
    const data = { ...node.data }
    delete data.sidechain
    return { ...node, data }
  })
  return copy
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

function computeNextMacroNodePosition(graphState) {
  const macroCount = graphState.nodes.filter((node) => node.type === 'macro').length
  const column = macroCount % GRAPH_MUTATION_GRID_COLUMNS
  const row = Math.floor(macroCount / GRAPH_MUTATION_GRID_COLUMNS)
  return {
    x: GRAPH_MUTATION_GRID_ORIGIN_X + column * GRAPH_MUTATION_GRID_STEP_X,
    y: GRAPH_MUTATION_GRID_ORIGIN_Y + (row + 1) * GRAPH_MUTATION_GRID_STEP_Y,
  }
}

// EVC.2 — stagger envelope nodes on their own grid row below the macro row so a
// freshly added envelope node never overlaps existing nodes.
function computeNextEnvelopeNodePosition(graphState) {
  const envelopeCount = graphState.nodes.filter((node) => node.type === 'envelope').length
  const column = envelopeCount % GRAPH_MUTATION_GRID_COLUMNS
  const row = Math.floor(envelopeCount / GRAPH_MUTATION_GRID_COLUMNS)
  return {
    x: GRAPH_MUTATION_GRID_ORIGIN_X + column * GRAPH_MUTATION_GRID_STEP_X,
    y: GRAPH_MUTATION_GRID_ORIGIN_Y + (row + 2) * GRAPH_MUTATION_GRID_STEP_Y,
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

function buildGraphMacroNodeDraft(graphState, nodeDraft = {}) {
  const draft = nodeDraft != null && typeof nodeDraft === 'object' ? nodeDraft : {}
  const position = normalizeGraphNodePosition(draft.position) ?? computeNextMacroNodePosition(graphState)
  return {
    label: draft.label,
    normalizedValue: draft.normalizedValue,
    position,
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
      const ok = await persistGraphState(Number(key), stripRuntimeGraphStateMetadata(validation.graphState))
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
  // EVC.2 / FXG-SC.6B — macro and envelope are control nodes and sidechainInput is a
  // silent key source; none has audio topology impact, so all are excluded from the
  // structural snapshot used to decide whether a runtime audio sync is needed.
  const isNonAudioNodeType = (type) =>
    type === 'macro' || type === 'envelope' || type === 'sidechainInput'
  const structuralSnapshot = (graphState) => ({
    nodes: Array.isArray(graphState?.nodes)
      ? graphState.nodes.filter((node) => !isNonAudioNodeType(node?.type)).map((node) => ({
        id: node?.id,
        type: node?.type,
        data: runtimeRelevantNodeData(node?.data),
      }))
      : [],
    edges: Array.isArray(graphState?.edges)
      ? graphState.edges.filter((edge) => {
        // Sidechain edges never affect audio topology regardless of endpoints.
        if (edge?.type === 'sidechain') return false
        const source = graphState.nodes?.find((node) => node?.id === edge?.sourceNodeId)
        const target = graphState.nodes?.find((node) => node?.id === edge?.targetNodeId)
        return !isNonAudioNodeType(source?.type) && !isNonAudioNodeType(target?.type)
      })
      : [],
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

// FXG.4-h — shared wrapper for macro automation lane/clip/point mutations. Gates on
// graph mode, runs the pure macroAutomation helper, commits + persists graphState
// without any audio runtime sync, and records a graph-owned undo transaction. The
// returned object carries through the helper's laneId/clipId for the caller.
async function runMacroAutomationMutation(set, get, trackId, label, options, mutationFn) {
  const access = readGraphStateForMutation(get(), trackId)
  if (!access.ok) return access

  const mutation = mutationFn(access.graphState)
  if (!mutation.ok) return mutation

  const applied = await applyGraphStateMutation(
    set,
    access.key,
    mutation.graphState,
    { ...options, syncRuntime: false },
  )
  if (!applied.ok) return applied

  recordGraphEditTransaction(set, access.key, label, access.graphState, applied.graphState)
  return { ...applied, laneId: mutation.laneId, clipId: mutation.clipId }
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

// FXG.4-f default runtime drive. After a macro value changes (or a link is
// created/hydrated), evaluate the macro's enabled outgoing parameter edges and
// push each mapped normalized value through the FXG.4-a
// setGraphEffectParameterNormalized store action (engine-addressed by stable
// effectInstanceId). This is control-rate, renderer-side drive only — no audio
// topology change, no effectChains mutation, no engine node ids. One failed write
// never aborts the others, and writes for audio-only edges never happen because
// collectMacroParameterWrites only walks parameter edges sourced by the macro.
async function driveMacroParameterEdges(get, key, graphState, macroNodeId, value, options = {}) {
  const { writes, skipped } = collectMacroParameterWrites(graphState, macroNodeId, value)
  if (writes.length === 0) return { ok: true, writes: [], skipped, results: [] }

  const setParameter = options.driveSetGraphEffectParameterNormalized
    ?? get().setGraphEffectParameterNormalized
  const warn = options.warn ?? console.warn
  const results = []
  for (const write of writes) {
    try {
      const result = await setParameter(
        Number(key),
        write.effectInstanceId,
        write.parameterId,
        write.value,
        options,
      )
      results.push({ ...write, result })
    } catch (e) {
      warn?.('[FXG] macro parameter drive write failed', {
        trackId: key,
        effectInstanceId: write.effectInstanceId,
        parameterId: write.parameterId,
        error: e?.message ?? e,
      })
      results.push({ ...write, result: { ok: false, reason: 'engine_error' } })
    }
  }
  return { ok: true, writes, skipped, results }
}

// FXG.4-f — after project-load hydration, apply each macro's current value to its
// connected parameters so a freshly loaded graph reflects saved macro positions.
// Runs only after graph-owned effect processors are instantiated; unavailable
// targets fail safely without corrupting graphState.
async function driveAllMacroParameterEdges(get, key, graphState, options = {}) {
  const macroNodes = Array.isArray(graphState?.nodes)
    ? graphState.nodes.filter((node) => node?.type === 'macro')
    : []
  const drives = []
  for (const macro of macroNodes) {
    const value = Number.isFinite(macro.data?.normalizedValue) ? macro.data.normalizedValue : 0
    drives.push(await driveMacroParameterEdges(get, key, graphState, macro.id, value, options))
  }
  return drives
}

// EVC-R2 — Envelope runtime drive. Mirrors driveMacroParameterEdges: given an Envelope
// node id and its evaluated normalized 0..1 output, push each enabled outgoing parameter
// edge's mapped value through the FXG.4-a setGraphEffectParameterNormalized store action.
// Uses collectEnvelopeParameterWrites (envelope-sourced parameter edges only), so audio
// edges and Macro edges are never touched. Control-rate, renderer-side only — no audio
// topology change, no effectChains mutation, no graphState mutation, no engine node ids.
// One failed write never aborts the others; an unavailable target fails safely.
async function driveEnvelopeParameterEdges(get, key, graphState, envelopeNodeId, value, options = {}) {
  const { writes, skipped } = collectEnvelopeParameterWrites(graphState, envelopeNodeId, value)
  if (writes.length === 0) return { ok: true, writes: [], skipped, results: [] }

  const setParameter = options.driveSetGraphEffectParameterNormalized
    ?? get().setGraphEffectParameterNormalized
  const warn = options.warn ?? console.warn
  const results = []
  for (const write of writes) {
    try {
      const result = await setParameter(
        Number(key),
        write.effectInstanceId,
        write.parameterId,
        write.value,
        options,
      )
      results.push({ ...write, result })
    } catch (e) {
      warn?.('[FXG] envelope parameter drive write failed', {
        trackId: key,
        effectInstanceId: write.effectInstanceId,
        parameterId: write.parameterId,
        error: e?.message ?? e,
      })
      results.push({ ...write, result: { ok: false, reason: 'engine_error' } })
    }
  }
  return { ok: true, writes, skipped, results }
}

// EVC-R2-r1 — session-only, NON-REACTIVE last-applied Envelope output cache. Keyed by
// `${trackKey}::${envelopeNodeId}` -> last driven normalized value. Used purely to suppress
// redundant control-rate envelope writes. It is deliberately module-level (not Zustand state)
// because the EVC-R2-r1 drive runs at 60 Hz off PlayheadClock.onFrame: storing it in the store
// would notify every subscriber on every frame and churn the main thread. It is never persisted
// and never read by React; tests assert behavior through the engine writes, not this holder.
const envelopeRuntimeLastValues = new Map()
const envelopeRuntimeKey = (trackKey, nodeId) => `${trackKey}::${nodeId}`
function clearEnvelopeRuntimeCache() {
  envelopeRuntimeLastValues.clear()
}

// ── FXG-SC.6C FX Graph Sidechain Input → Timeline SidechainRoute reconciliation ──
//
// The single bridge between graphState sidechain INTENT (a Sidechain Input node
// with a selected source + sidechain edges to graph-owned sidechain-capable effects) and the
// proven native sidechain TRANSPORT (Timeline SidechainRoute → MixEngine
// SidechainPlan → AudioGraph SidechainSourceProcessor → stock compressor bus 1).
//
// graphState is the user-facing source of truth. Native routes are derived,
// reconciled transport — never authored directly for graph-owned sidechain, and
// never persisted back into graphState (no route ids, no APG node ids). The native
// resolver already resolves graph-owned effect instances by stable effectInstanceId
// (EffectChainManager::getNodeIdForEffectInstance walks graph nodes too), so no new
// engine boundary is needed: this reconciler only diffs desired-vs-existing routes
// and toggles the stock compressor's external-key flag when the target is the stock compressor.

// A source track can drive a graph compressor only when it is a real, non-visual
// mixer track distinct from the graph track. mixerStore is the only place with that
// metadata; tests inject options.isSourceTrackValid instead.
function defaultIsSourceTrackValid(sourceTrackId, owningTrackId) {
  if (!Number.isFinite(sourceTrackId)) return false
  if (sourceTrackId === owningTrackId) return false
  const tracks = useMixerStore.getState().tracks
  const track = tracks?.[sourceTrackId]
  return Boolean(track) && track.visualOnly !== true
}

// Cheap structural test: did the sidechain ROUTE intent (source + capable targets)
// change between two graphStates? Used to gate undo/redo route reconciliation so an
// unrelated macro/audio/position undo never touches native sidechain routes.
function graphSidechainIntentChanged(beforeGraphState, afterGraphState) {
  const fingerprint = (graphState) => {
    const intent = deriveGraphSidechainIntent(graphState)
    return JSON.stringify({
      source: intent.sourceTrackId,
      targets: [...intent.edgeTargets.map((t) => t.effectInstanceId)].sort(),
      desired: [...intent.desiredTargets.map((t) => t.effectInstanceId)].sort(),
    })
  }
  return fingerprint(beforeGraphState) !== fingerprint(afterGraphState)
}

function setGraphSidechainStatus(set, key, status) {
  set((state) => ({
    graphSidechainStatuses: {
      ...state.graphSidechainStatuses,
      [key]: { ...status, updatedAt: Date.now() },
    },
  }))
}

// Reconcile native SidechainRoute records to match the graph's sidechain intent for
// one graph-mode track. Idempotent and tuple-based: it only ever touches routes that
// target THIS graph track's own effect instances, so unrelated Mixer Chain / other-
// track sidechain routes are left untouched. Best-effort — a failed native call is
// surfaced in graphSidechainStatuses but never throws or rolls back graphState.
//
// options.removedEffectInstanceIds lets a graph-effect removal hand in instance ids
// that just left the graph so their orphaned routes are still torn down.
async function reconcileGraphSidechainRoutes(set, get, key, options = {}) {
  const warn = options.warn ?? console.warn
  const state = get()
  if (resolveFxMode(state.fxModes, key) !== 'graph') {
    return { ok: false, reason: 'not_graph_mode' }
  }
  const graphState = state.graphStates[key]
  if (!graphState || !Array.isArray(graphState.nodes) || !Array.isArray(graphState.edges)) {
    return { ok: false, reason: 'missing_graph_state' }
  }

  const intent = deriveGraphSidechainIntent(graphState)
  const owningTrackId = intent.owningTrackId ?? Number(key)
  const pluginIdByInstanceId = new Map()
  for (const node of graphState.nodes) {
    if (node?.type !== 'effect') continue
    const effectInstanceId = node?.data?.effectInstanceId
    const pluginId = node?.data?.pluginId
    if (typeof effectInstanceId === 'string' && typeof pluginId === 'string') {
      pluginIdByInstanceId.set(effectInstanceId, pluginId)
    }
  }
  const requiresStockExternalParam = (effectInstanceId) =>
    pluginIdByInstanceId.get(effectInstanceId) === 'compressor'

  const timeline = defaultTimelineApi()
  const getRouting = options.getRouting ?? timeline.getRouting
  const addRoute = options.addSidechainRoute ?? timeline.addSidechainRoute
  const removeRoute = options.removeSidechainRoute ?? timeline.removeSidechainRoute
  if (typeof getRouting !== 'function') {
    return { ok: false, reason: 'routing_unavailable' }
  }
  const isSourceValid = options.isSourceTrackValid ?? defaultIsSourceTrackValid
  const setExternal = options.setGraphEffectParameterNormalized ?? get().setGraphEffectParameterNormalized

  // Desired routes: every capable sidechain target with a sidechain edge, but only once the
  // selected source is finite AND exists/eligible. A finite-but-stale source yields no
  // route (and a source_missing status) rather than a route the engine would reject.
  const sourceTrackId = intent.sourceTrackId
  const sourceValid = sourceTrackId != null && isSourceValid(sourceTrackId, owningTrackId)
  const desiredByInstance = new Map()
  if (sourceValid) {
    for (const target of intent.edgeTargets) {
      desiredByInstance.set(target.effectInstanceId, {
        sourceTrackId,
        targetTrackId: owningTrackId,
        targetEffectInstanceId: target.effectInstanceId,
      })
    }
  }

  let snapshot
  try {
    snapshot = await getRouting()
  } catch (e) {
    warn?.('[FXG-SC] getRouting failed during reconcile', { trackId: key, error: e?.message ?? e })
    return { ok: false, reason: 'routing_unavailable' }
  }
  const existingRoutes = normalizeSidechainRoutesFromRoutingSnapshot(snapshot)

  // Ownership scope: only routes that target THIS graph track's own effect instances
  // (or an instance that was just removed from the graph) are graph-sidechain owned.
  const ownedInstanceIds = new Set(intent.effectInstanceIds)
  for (const id of options.removedEffectInstanceIds ?? []) {
    if (typeof id === 'string' && id.length > 0) ownedInstanceIds.add(id)
  }
  const ownedRoutes = existingRoutes.filter(
    (r) => Number(r.targetTrackId) === owningTrackId &&
      ownedInstanceIds.has(r.targetEffectInstanceId),
  )
  const ownedRouteInstanceIds = new Set(ownedRoutes.map((r) => r.targetEffectInstanceId))

  // An enabled route already matching a desired tuple (same source+target+instance)
  // must not be recreated — dedup against the original snapshot.
  const existingDesiredMatch = (route) =>
    existingRoutes.some((r) =>
      r.enabled !== false &&
      Number(r.targetTrackId) === Number(route.targetTrackId) &&
      Number(r.sourceTrackId) === Number(route.sourceTrackId) &&
      r.targetEffectInstanceId === route.targetEffectInstanceId)

  const targets = {}
  const issues = []
  let routesCreated = 0
  let routesRemoved = 0

  const markTarget = (effectInstanceId, status) => {
    targets[effectInstanceId] = { status, sourceTrackId: status === 'ok' ? sourceTrackId : null }
  }

  // 1) Tear down owned routes that are no longer desired (source cleared/stale, edge
  //    removed, compressor removed) or whose source changed (remove → re-add below).
  for (const route of ownedRoutes) {
    const desired = desiredByInstance.get(route.targetEffectInstanceId)
    const keep = desired && Number(desired.sourceTrackId) === Number(route.sourceTrackId)
    if (keep) continue
    if (typeof removeRoute !== 'function') {
      issues.push({ effectInstanceId: route.targetEffectInstanceId, kind: 'route_remove_failed' })
      continue
    }
    try {
      const res = await removeRoute(route.sourceTrackId, route.routeId)
      if (res === false || res?.ok === false) {
        issues.push({ effectInstanceId: route.targetEffectInstanceId, kind: 'route_remove_failed' })
      } else {
        routesRemoved++
      }
    } catch (e) {
      warn?.('[FXG-SC] removeSidechainRoute failed', { trackId: key, error: e?.message ?? e })
      issues.push({ effectInstanceId: route.targetEffectInstanceId, kind: 'route_remove_failed' })
    }
  }

  // 2) Disable sc_external on compressors the graph owns that are no longer keyed:
  //    a sidechain edge with no valid source, or a route we just removed. The graph
  //    sidechain UI owns the external-key state for graph-owned compressors, so a
  //    removed key returns the compressor to its internal detector (sc_external=0).
  const edgeTargetInstanceIds = new Set(intent.edgeTargets.map((t) => t.effectInstanceId))
  for (const effectInstanceId of intent.sidechainCapableInstanceIds ?? intent.compressorInstanceIds) {
    if (desiredByInstance.has(effectInstanceId)) continue
    if (!edgeTargetInstanceIds.has(effectInstanceId) && !ownedRouteInstanceIds.has(effectInstanceId)) {
      continue
    }
    if (requiresStockExternalParam(effectInstanceId) && typeof setExternal === 'function') {
      try {
        await setExternal(Number(key), effectInstanceId, COMPRESSOR_EXTERNAL_SIDECHAIN_PARAM_ID, 0)
      } catch (e) {
        warn?.('[FXG-SC] sc_external disable failed', { trackId: key, effectInstanceId, error: e?.message ?? e })
      }
    }
    if (edgeTargetInstanceIds.has(effectInstanceId)) {
      // edge present but source unset/stale
      markTarget(effectInstanceId, 'source_missing')
    }
  }

  // 3) For every desired target: enable sc_external (failure is fatal for that target,
  //    consistent with bd7115a — never claim a route is keyed when the flag did not
  //    take), then create the route unless an identical enabled one already exists.
  for (const [effectInstanceId, route] of desiredByInstance) {
    if (requiresStockExternalParam(effectInstanceId) && typeof setExternal === 'function') {
      let externalOk = false
      try {
        const res = await setExternal(Number(key), effectInstanceId, COMPRESSOR_EXTERNAL_SIDECHAIN_PARAM_ID, 1)
        externalOk = res?.ok !== false && res !== false
      } catch (e) {
        warn?.('[FXG-SC] sc_external enable failed', { trackId: key, effectInstanceId, error: e?.message ?? e })
        externalOk = false
      }
      if (!externalOk) {
        issues.push({ effectInstanceId, kind: 'external_failed' })
        markTarget(effectInstanceId, 'external_failed')
        continue
      }
    }

    if (existingDesiredMatch(route)) {
      markTarget(effectInstanceId, 'ok')
      continue
    }
    if (typeof addRoute !== 'function') {
      issues.push({ effectInstanceId, kind: 'route_add_failed' })
      markTarget(effectInstanceId, 'route_failed')
      continue
    }
    try {
      const res = await addRoute(route.sourceTrackId, {
        targetTrackId: route.targetTrackId,
        targetEffectInstanceId: effectInstanceId,
        gain: 1.0,
        preFader: false,
        enabled: true,
      })
      if (res === false || res?.ok === false) {
        issues.push({ effectInstanceId, kind: 'route_add_failed', reason: res?.reason })
        markTarget(effectInstanceId, 'route_failed')
      } else {
        routesCreated++
        markTarget(effectInstanceId, 'ok')
      }
    } catch (e) {
      warn?.('[FXG-SC] addSidechainRoute failed', { trackId: key, effectInstanceId, error: e?.message ?? e })
      issues.push({ effectInstanceId, kind: 'route_add_failed' })
      markTarget(effectInstanceId, 'route_failed')
    }
  }

  // Refresh the mixer routing snapshot so chain-mode UI / status reflects the new
  // native route set after graph-driven changes.
  if ((routesCreated > 0 || routesRemoved > 0) && typeof useMixerStore.getState().refreshRouting === 'function') {
    try { await useMixerStore.getState().refreshRouting() } catch { /* best-effort */ }
  }

  const status = {
    ok: issues.length === 0,
    owningTrackId,
    sourceTrackId,
    sidechainInputNodeId: intent.sidechainInputNodeId,
    sourceMissing: sourceTrackId != null && !sourceValid,
    hasSidechainEdge: intent.edgeTargets.length > 0,
    targets,
    issues,
    routesCreated,
    routesRemoved,
  }
  setGraphSidechainStatus(set, key, status)
  return { ok: issues.length === 0, status }
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
  // { [key: String(trackId)]: { ok, sourceTrackId, sourceMissing, targets, issues, ... } }
  // FXG-SC.6C — session-only status of the last graph sidechain route reconcile for a
  // track (source/edge/route/external-flag health for UI feedback). Never persisted.
  graphSidechainStatuses: {},
  // { [key: String(trackId)]: { undoStack, redoStack } }
  // Session-only FX Graph edit history. Never persisted and never shared with
  // Mixer Chain / native undo history.
  graphHistories: {},
  // FXG.4-h — session-only last-applied macro automation values, keyed by
  // { [key: String(trackId)]: { [macroNodeId]: value } }. Used purely to suppress
  // redundant control-rate drive calls during playback. Never persisted.
  macroAutomationLastValues: {},
  // EVC-R2-r1 — the Envelope last-applied output cache is NOT Zustand state; it lives in the
  // module-level non-reactive `envelopeRuntimeLastValues` Map (see above) so 60 Hz drive does
  // not notify subscribers. Cleared via resetEnvelopeModulationRuntime / project hydration.

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
      graphSidechainStatuses: {},
      graphHistories: {},
      macroAutomationLastValues: {},
    })
    // EVC-R2-r1 — envelope runtime cache is non-reactive module state; clear it on project
    // hydration so a freshly loaded project never reuses a previous session's last values.
    clearEnvelopeRuntimeCache()
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
      // FXG.4-f — apply saved macro values to connected parameters now that the
      // graph-owned effect processors exist. Best-effort; never blocks hydration.
      const macroDrives = await driveAllMacroParameterEdges(get, key, graphState, options)
      // FXG-SC.6C — graph-owned effects are now hydrated, so the native sidechain
      // resolver can resolve them: rebind the derived sidechain route(s) + sc_external
      // from the persisted graph intent. Best-effort; never blocks hydration.
      const sidechainSync = await reconcileGraphSidechainRoutes(set, get, key, options)
      results[key] = { ...result, runtimeSync, macroDrives, sidechainSync: sidechainSync.status }

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
      const graphOk = await persistGraphState(Number(key), stripRuntimeGraphStateMetadata(validation.graphState))
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
          await persistGraphState(Number(key), stripRuntimeGraphStateMetadata(previousGraphState))
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
      const ok = await persistGraphState(Number(key), stripRuntimeGraphStateMetadata(validation.graphState))
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
      const ok = await persistGraphState(Number(key), stripRuntimeGraphStateMetadata(validation.graphState))
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

    // FXG-SC.6C — if the undo changed sidechain route intent (source or sidechain
    // edges), rebind native routes to match the now-current graphState.
    if (graphSidechainIntentChanged(transaction.afterGraphState, transaction.beforeGraphState)) {
      await reconcileGraphSidechainRoutes(set, get, access.key, options)
    }

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

    // FXG-SC.6C — same as undo: rebind native routes if the redo changed intent.
    if (graphSidechainIntentChanged(transaction.beforeGraphState, transaction.afterGraphState)) {
      await reconcileGraphSidechainRoutes(set, get, access.key, options)
    }

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

  addGraphMacroNodeForTrack: async (trackId, nodeDraft = {}, options = {}) => {
    const access = readGraphStateForMutation(get(), trackId)
    if (!access.ok) return access

    const draft = buildGraphMacroNodeDraft(access.graphState, nodeDraft)
    const mutation = addGraphMacroNode(access.graphState, draft, { idFactory: options.idFactory })
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
        'add_graph_macro_node',
        access.graphState,
        applied.graphState,
      )
    }
    return applied
  },

  updateGraphMacroValueForTrack: async (trackId, nodeId, value, options = {}) => {
    const access = readGraphStateForMutation(get(), trackId)
    if (!access.ok) return access

    const mutation = updateGraphMacroValue(access.graphState, nodeId, value)
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
        'update_graph_macro_value',
        access.graphState,
        applied.graphState,
      )
      // FXG.4-f — drive connected parameters from the new macro value. Best-effort:
      // failed/unavailable target writes do not roll back the committed graphState.
      const drive = await driveMacroParameterEdges(
        get,
        access.key,
        applied.graphState,
        nodeId,
        value,
        options,
      )
      return { ...applied, drive }
    }
    return applied
  },

  // EVC.2 — adds an inert graph-owned Envelope Controller node. Like the macro
  // actions this is gated on graph mode (master/missing/chain-mode/missing
  // graphState all reject), persists via timeline.setTrackGraphState, and records
  // a graph-owned undo transaction. It performs NO audio runtime sync, NO graph
  // effect hydration, creates/destroys NO graph-owned processors, never calls
  // setGraphEffectParameterNormalized, and never touches effectChains/Mixer Chain.
  // The envelope node does not execute in this phase — it is a persisted definition.
  addGraphEnvelopeNodeForTrack: async (trackId, options = {}) => {
    const access = readGraphStateForMutation(get(), trackId)
    if (!access.ok) return access

    const opts = options != null && typeof options === 'object' ? options : {}
    const position = normalizeGraphNodePosition(opts.position)
      ?? computeNextEnvelopeNodePosition(access.graphState)
    const mutation = addGraphEnvelopeNode(access.graphState, {
      idFactory: opts.idFactory,
      data: opts.data,
      position,
    })
    if (!mutation.ok) return mutation

    const applied = await applyGraphStateMutation(
      set,
      access.key,
      mutation.graphState,
      { ...opts, syncRuntime: false },
    )
    if (applied.ok) {
      recordGraphEditTransaction(
        set,
        access.key,
        'add_graph_envelope_node',
        access.graphState,
        applied.graphState,
      )
    }
    return applied
  },

  // EVC.2 — patches an existing envelope node's inert data. Same graph-mode gate,
  // persistence, and undo recording as the add action; no audio runtime sync and
  // no effectChains/Mixer Chain involvement.
  updateGraphEnvelopeNodeDataForTrack: async (trackId, nodeId, patch, options = {}) => {
    const access = readGraphStateForMutation(get(), trackId)
    if (!access.ok) return access

    const mutation = updateGraphEnvelopeNodeData(access.graphState, nodeId, patch)
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
        'update_graph_envelope_node',
        access.graphState,
        applied.graphState,
      )
    }
    return applied
  },

  renameGraphMacroNodeForTrack: async (trackId, nodeId, label, options = {}) => {
    const access = readGraphStateForMutation(get(), trackId)
    if (!access.ok) return access

    const mutation = renameGraphMacroNode(access.graphState, nodeId, label)
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
        'rename_graph_macro_node',
        access.graphState,
        applied.graphState,
      )
    }
    return applied
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
    const isMacroNode = removedNode?.type === 'macro'

    // FXG-SC.6C — does removing this node tear down sidechain route intent? True when
    // it is the Sidechain Input node, or an effect that a sidechain edge targets. The
    // removed effect's stable id is fed to the reconciler so its now-orphaned route
    // (the instance just left the graph) is still torn down.
    const removedHadSidechainEdge = access.graphState.edges.some(
      (e) => e?.type === 'sidechain' && (e.sourceNodeId === nodeId || e.targetNodeId === nodeId),
    )
    const removesSidechainIntent =
      removedNode?.type === 'sidechainInput' || removedHadSidechainEdge
    const removedEffectInstanceIds =
      typeof effectInstanceId === 'string' && effectInstanceId.length > 0
        ? [effectInstanceId]
        : []

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

    const applied = await applyGraphStateMutation(
      set,
      access.key,
      mutation.graphState,
      isMacroNode ? { ...options, syncRuntime: false } : options,
    )
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
      if (removesSidechainIntent) {
        await reconcileGraphSidechainRoutes(set, get, access.key, {
          ...options,
          removedEffectInstanceIds,
        })
      }
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

    // Parameter edge removal never changes audio routing, so skip the engine
    // topology sync for it. Audio edge removal keeps the default sync.
    const removingParameterEdge = isParameterEdge(access.graphState, edgeId)

    const mutation = disconnectGraphEdge(access.graphState, edgeId)
    if (!mutation.ok) return mutation

    const applied = await applyGraphStateMutation(
      set,
      access.key,
      mutation.graphState,
      removingParameterEdge ? { ...options, syncRuntime: false } : options,
    )
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

  // FXG.4-e/f — link a Macro controlOut to an exposed parameter input port. The
  // parameter edge persists the FXG.4-c GraphParameterTarget + a default linear
  // mapping. It is not an audio edge, so it never syncs audio topology and never
  // touches effectChains. After committing, the new link is immediately driven from
  // the macro's current value so the parameter reflects the link straight away.
  connectMacroToParameterForTrack: async (trackId, connectionDraft, options = {}) => {
    const access = readGraphStateForMutation(get(), trackId)
    if (!access.ok) return access

    const mutation = connectMacroToParameter(access.graphState, connectionDraft, {
      idFactory: options.idFactory,
    })
    if (!mutation.ok) return mutation

    const applied = await applyGraphStateMutation(
      set,
      access.key,
      mutation.graphState,
      { ...options, syncRuntime: false },
    )
    if (!applied.ok) return applied

    recordGraphEditTransaction(
      set,
      access.key,
      'connect_macro_to_parameter',
      access.graphState,
      applied.graphState,
    )

    const macroNode = applied.graphState.nodes.find(
      (node) => node.id === connectionDraft?.sourceNodeId,
    )
    const macroValue = Number.isFinite(macroNode?.data?.normalizedValue)
      ? macroNode.data.normalizedValue
      : 0
    const drive = await driveMacroParameterEdges(
      get,
      access.key,
      applied.graphState,
      connectionDraft?.sourceNodeId,
      macroValue,
      options,
    )

    return { ...applied, edge: mutation.edge, drive }
  },

  // EVC-R1 — link an Envelope controlOut to an exposed parameter input port. The
  // parameter edge persists the GraphParameterTarget + a default linear mapping,
  // exactly like a Macro -> Parameter link. It is NOT an audio edge, so it never
  // syncs audio topology and never touches effectChains. Unlike the Macro action it
  // does NOT drive the parameter after linking: the Envelope has no static output —
  // its value is produced by triggered ADSR runtime which is deferred to EVC-R2.
  // So this action is runtime-inert (no setGraphEffectParameterNormalized call).
  connectEnvelopeToParameterForTrack: async (trackId, connectionDraft, options = {}) => {
    const access = readGraphStateForMutation(get(), trackId)
    if (!access.ok) return access

    const mutation = connectEnvelopeToParameter(access.graphState, connectionDraft, {
      idFactory: options.idFactory,
    })
    if (!mutation.ok) return mutation

    const applied = await applyGraphStateMutation(
      set,
      access.key,
      mutation.graphState,
      { ...options, syncRuntime: false },
    )
    if (!applied.ok) return applied

    recordGraphEditTransaction(
      set,
      access.key,
      'connect_envelope_to_parameter',
      access.graphState,
      applied.graphState,
    )

    return { ...applied, edge: mutation.edge }
  },

  // ── FXG-SC.6B/6C FX Graph Sidechain Input ─────────────────────────────────
  // Renderer/graphState intent. Every action below is graph-mode gated
  // (master/chain-mode/missing graphState reject via readGraphStateForMutation),
  // persists via timeline.setTrackGraphState, records a graph-owned undo
  // transaction, and performs NO audio TOPOLOGY sync (syncRuntime: false — sidechain
  // edges never enter the audio topology payload) and never touch effectChains.
  // 6C adds a dedicated graph-sidechain ROUTE sync: after a source/edge mutation that
  // changes routing intent, reconcileGraphSidechainRoutes derives the desired Timeline
  // SidechainRoute records and toggles the compressor's sc_external flag. That is a
  // separate transport pass, NOT part of the audio topology payload.

  // Adds the single protected Sidechain Input node to a graph track. Rejects a second
  // node with sidechain_input_exists (carrying existingNodeId so the UI can focus it).
  addSidechainInputNodeForTrack: async (trackId, options = {}) => {
    const access = readGraphStateForMutation(get(), trackId)
    if (!access.ok) return access

    const opts = options != null && typeof options === 'object' ? options : {}
    const mutation = addSidechainInputNode(access.graphState, {
      idFactory: opts.idFactory,
      position: opts.position,
      sourceTrackId: opts.sourceTrackId,
    })
    if (!mutation.ok) return mutation

    const applied = await applyGraphStateMutation(
      set,
      access.key,
      mutation.graphState,
      { ...opts, syncRuntime: false },
    )
    if (applied.ok) {
      recordGraphEditTransaction(
        set,
        access.key,
        'add_sidechain_input_node',
        access.graphState,
        applied.graphState,
      )
    }
    return applied
  },

  // Sets (or clears with null) the Sidechain Input node's selected source track.
  // Structural validation (self-source, finiteness) lives in setSidechainInputSource.
  // Visual-only/non-audio eligibility is enforced here when the caller supplies the
  // current eligible source ids — the store layer is the only place with that metadata.
  setSidechainInputSourceForTrack: async (trackId, sidechainInputNodeId, sourceTrackIdOrNull, options = {}) => {
    const access = readGraphStateForMutation(get(), trackId)
    if (!access.ok) return access

    const opts = options != null && typeof options === 'object' ? options : {}
    if (
      sourceTrackIdOrNull != null &&
      Array.isArray(opts.eligibleSourceTrackIds) &&
      !opts.eligibleSourceTrackIds.some((id) => Number(id) === Number(sourceTrackIdOrNull))
    ) {
      return { ok: false, reason: 'invalid_sidechain_source' }
    }

    const mutation = setSidechainInputSource(access.graphState, sidechainInputNodeId, sourceTrackIdOrNull)
    if (!mutation.ok) return mutation

    const applied = await applyGraphStateMutation(
      set,
      access.key,
      mutation.graphState,
      { ...opts, syncRuntime: false },
    )
    if (applied.ok) {
      recordGraphEditTransaction(
        set,
        access.key,
        'set_sidechain_input_source',
        access.graphState,
        applied.graphState,
      )
      // Source change is route-relevant: rebind/clear the derived native route.
      await reconcileGraphSidechainRoutes(set, get, access.key, opts)
    }
    return applied
  },

  // Creates a sidechain edge from a Sidechain Input node's sidechainOut to a stock
  // compressor's sidechainIn. Validation (capability, dedupe, source selected) lives
  // in connectSidechainNodes. Runtime-inert in 6B.
  connectSidechainForTrack: async (trackId, sourceNodeId, targetNodeId, options = {}) => {
    const access = readGraphStateForMutation(get(), trackId)
    if (!access.ok) return access

    const opts = options != null && typeof options === 'object' ? options : {}
    const mutation = connectSidechainNodes(
      access.graphState,
      { sourceNodeId, targetNodeId },
      { idFactory: opts.idFactory },
    )
    if (!mutation.ok) return mutation

    const applied = await applyGraphStateMutation(
      set,
      access.key,
      mutation.graphState,
      { ...opts, syncRuntime: false },
    )
    if (!applied.ok) return applied

    recordGraphEditTransaction(
      set,
      access.key,
      'connect_sidechain',
      access.graphState,
      applied.graphState,
    )
    // New sidechain edge → create the derived native route + enable sc_external.
    const reconcile = await reconcileGraphSidechainRoutes(set, get, access.key, opts)
    return { ...applied, edge: mutation.edge, sidechainSync: reconcile.status }
  },

  // Removes a sidechain edge by id. Rejects non-sidechain edge ids with missing_edge
  // so it can never drop an audio/parameter cable.
  disconnectSidechainEdgeForTrack: async (trackId, edgeId, options = {}) => {
    const access = readGraphStateForMutation(get(), trackId)
    if (!access.ok) return access

    const opts = options != null && typeof options === 'object' ? options : {}
    const mutation = disconnectSidechainEdge(access.graphState, edgeId)
    if (!mutation.ok) return mutation

    const applied = await applyGraphStateMutation(
      set,
      access.key,
      mutation.graphState,
      { ...opts, syncRuntime: false },
    )
    if (applied.ok) {
      recordGraphEditTransaction(
        set,
        access.key,
        'disconnect_sidechain_edge',
        access.graphState,
        applied.graphState,
      )
      // Edge removed → tear down the derived native route + disable sc_external.
      await reconcileGraphSidechainRoutes(set, get, access.key, opts)
    }
    return applied
  },

  // FXG-SC.6C — public entry point to reconcile a graph track's derived sidechain
  // routes against the existing Timeline SidechainRoute transport. Graph-mode gated;
  // safe to call after panel mount, project load, or any external routing refresh.
  // The mutation actions above call this automatically after route-relevant edits.
  reconcileGraphSidechainRoutesForTrack: async (trackId, options = {}) => {
    const key = normalizeNormalTrackKey(trackId)
    if (key == null) {
      return { ok: false, reason: trackId === 'master' ? 'master_track' : 'no_track' }
    }
    return reconcileGraphSidechainRoutes(set, get, key, options ?? {})
  },

  // FXG.4-g — update the mapping on a Macro -> Parameter edge. Updates persist to
  // graphState, participate in graph-owned undo/redo, and immediately re-drive the
  // source macro so the parameter reflects the new mapping live. Does NOT change audio
  // topology, does NOT touch effectChains, does NOT sync the graph runtime. The drive
  // is best-effort: a failed target write does not roll back the mapping change.
  updateGraphParameterEdgeMappingForTrack: async (trackId, edgeId, mappingPatch, options = {}) => {
    const access = readGraphStateForMutation(get(), trackId)
    if (!access.ok) return access

    const mutation = updateParameterEdgeMapping(access.graphState, edgeId, mappingPatch)
    if (!mutation.ok) return mutation

    const applied = await applyGraphStateMutation(
      set,
      access.key,
      mutation.graphState,
      { ...options, syncRuntime: false },
    )
    if (!applied.ok) return applied

    recordGraphEditTransaction(
      set,
      access.key,
      'update_parameter_edge_mapping',
      access.graphState,
      applied.graphState,
    )

    // Re-drive the source macro so the parameter immediately reflects the new mapping.
    const edge = applied.graphState.edges.find((e) => e.id === edgeId)
    if (edge) {
      const macroNode = applied.graphState.nodes.find((n) => n.id === edge.sourceNodeId)
      const macroValue = Number.isFinite(macroNode?.data?.normalizedValue)
        ? macroNode.data.normalizedValue
        : 0
      await driveMacroParameterEdges(get, access.key, applied.graphState, edge.sourceNodeId, macroValue, options)
    }

    return applied
  },

  // ── FXG.4-h parent-attached macro automation lanes ────────────────────────
  // Lanes/clips live inside the owning track's graphState (the only renderer
  // channel that round-trips with the project without native changes) under
  // `macroAutomationLanes`. Each action is graph-mode gated, persists via
  // timeline.setTrackGraphState, records a graph-owned undo transaction, and
  // NEVER syncs audio runtime or touches effectChains — automation only drives a
  // Macro node's normalizedValue, which then flows through the existing FXG.4-e/f/g
  // macro→parameter edge path. Generic timeline clips/lanes are untouched.
  showMacroAutomationLaneForTrack: (trackId, macroNodeId, options = {}) =>
    runMacroAutomationMutation(set, get, trackId, 'show_macro_automation_lane', options, (graphState) =>
      showMacroAutomationLane(graphState, macroNodeId, options)),

  hideMacroAutomationLaneForTrack: (trackId, macroNodeId, options = {}) =>
    runMacroAutomationMutation(set, get, trackId, 'hide_macro_automation_lane', options, (graphState) =>
      hideMacroAutomationLane(graphState, macroNodeId)),

  removeMacroAutomationLaneForTrack: (trackId, macroNodeId, options = {}) =>
    runMacroAutomationMutation(set, get, trackId, 'remove_macro_automation_lane', options, (graphState) =>
      removeMacroAutomationLane(graphState, macroNodeId)),

  createMacroAutomationClipForTrack: (trackId, macroNodeId, clipDraft = {}, options = {}) =>
    runMacroAutomationMutation(set, get, trackId, 'create_macro_automation_clip', options, (graphState) =>
      createMacroAutomationClip(graphState, macroNodeId, clipDraft, options)),

  moveMacroAutomationClipForTrack: (trackId, clipId, newStartTick, options = {}) =>
    runMacroAutomationMutation(set, get, trackId, 'move_macro_automation_clip', options, (graphState) =>
      moveMacroAutomationClip(graphState, clipId, newStartTick)),

  resizeMacroAutomationClipForTrack: (trackId, clipId, patch, options = {}) =>
    runMacroAutomationMutation(set, get, trackId, 'resize_macro_automation_clip', options, (graphState) =>
      resizeMacroAutomationClip(graphState, clipId, patch)),

  toggleMacroAutomationClipLoopForTrack: (trackId, clipId, loopEnabled, options = {}) =>
    runMacroAutomationMutation(set, get, trackId, 'toggle_macro_automation_clip_loop', options, (graphState) =>
      toggleMacroAutomationClipLoop(graphState, clipId, loopEnabled)),

  deleteMacroAutomationClipForTrack: (trackId, clipId, options = {}) =>
    runMacroAutomationMutation(set, get, trackId, 'delete_macro_automation_clip', options, (graphState) =>
      deleteMacroAutomationClip(graphState, clipId)),

  // Copy/paste is lane-compatible only: the destination macroNodeId must match the
  // payload's source macro. Cross-macro / cross-track / macro<->normal-lane pastes
  // are rejected (INCOMPATIBLE_LANE) — automation clips never silently retarget.
  pasteMacroAutomationClipForTrack: (trackId, macroNodeId, clipPayload, options = {}) =>
    runMacroAutomationMutation(set, get, trackId, 'paste_macro_automation_clip', options, (graphState) =>
      pasteMacroAutomationClip(graphState, macroNodeId, clipPayload, options)),

  buildMacroAutomationClipCopyPayload: (trackId, clipId) => {
    const access = readGraphStateForMutation(get(), trackId)
    if (!access.ok) return null
    return buildMacroAutomationClipCopyPayload(access.graphState, clipId)
  },

  addMacroAutomationPointForTrack: (trackId, clipId, pointDraft, options = {}) =>
    runMacroAutomationMutation(set, get, trackId, 'add_macro_automation_point', options, (graphState) =>
      addMacroAutomationPoint(graphState, clipId, pointDraft)),

  moveMacroAutomationPointForTrack: (trackId, clipId, pointIndex, patch, options = {}) =>
    runMacroAutomationMutation(set, get, trackId, 'move_macro_automation_point', options, (graphState) =>
      moveMacroAutomationPoint(graphState, clipId, pointIndex, patch)),

  deleteMacroAutomationPointForTrack: (trackId, clipId, pointIndex, options = {}) =>
    runMacroAutomationMutation(set, get, trackId, 'delete_macro_automation_point', options, (graphState) =>
      deleteMacroAutomationPoint(graphState, clipId, pointIndex)),

  setMacroAutomationPointCurveForTrack: (trackId, clipId, pointIndex, curve, options = {}) =>
    runMacroAutomationMutation(set, get, trackId, 'set_macro_automation_point_curve', options, (graphState) =>
      setMacroAutomationPointCurve(graphState, clipId, pointIndex, curve)),

  // Control-rate playback evaluation. For every graph-mode track, evaluate each
  // macro's automation lane at the given global tick and, when a clip is in effect
  // (or holding), drive the macro's connected parameter edges with the evaluated
  // value via the existing FXG.4-e/f path. The persisted macro normalizedValue and
  // graphState are NOT mutated — this is runtime drive only, so playback never
  // dirties the project or churns React graphState. Redundant writes are suppressed
  // by comparing against the session macroAutomationLastValues cache.
  applyMacroAutomationAtTick: async (globalTick, options = {}) => {
    if (!Number.isFinite(globalTick)) return { ok: false, reason: 'invalid_tick' }
    const state = get()
    const epsilon = Number.isFinite(options.epsilon) ? options.epsilon : 1e-4
    const driven = []

    for (const [key, graphState] of Object.entries(state.graphStates)) {
      if (key === 'master') continue
      if (resolveFxMode(state.fxModes, key) !== 'graph') continue
      if (!graphState || !Array.isArray(graphState.nodes)) continue
      const lanes = Array.isArray(graphState.macroAutomationLanes) ? graphState.macroAutomationLanes : []
      if (lanes.length === 0) continue

      for (const node of graphState.nodes) {
        if (node.type !== 'macro') continue
        const fallback = Number.isFinite(node.data?.normalizedValue) ? node.data.normalizedValue : 0
        const evaluation = evaluateMacroAutomationForMacro(graphState, node.id, globalTick, fallback)
        if (!evaluation.hasAutomation) continue

        const last = get().macroAutomationLastValues?.[key]?.[node.id]
        if (last != null && Math.abs(last - evaluation.value) <= epsilon) continue

        set((current) => ({
          macroAutomationLastValues: {
            ...current.macroAutomationLastValues,
            [key]: { ...(current.macroAutomationLastValues?.[key] ?? {}), [node.id]: evaluation.value },
          },
        }))
        await driveMacroParameterEdges(get, key, graphState, node.id, evaluation.value, options)
        driven.push({ trackId: key, macroNodeId: node.id, value: evaluation.value })
      }
    }
    return { ok: true, driven }
  },

  // Clears the session last-applied cache so the next tick re-drives every macro
  // (used on transport stop/seek/project-load). Does not change any value itself.
  resetMacroAutomationRuntime: () => set({ macroAutomationLastValues: {} }),

  // EVC-R2 — control-rate Envelope modulation drive. For every graph-mode track that
  // owns Envelope nodes, evaluate each Envelope's triggered ADSR at the given global tick
  // from the parent track's trigger events (passed in via options.trackEvents, keyed by
  // String(trackId)) and drive its connected parameter edges with the single normalized
  // output value via the existing Envelope -> Parameter path. The persisted graphState and
  // node data are NOT mutated — runtime drive only, so playback never dirties the project.
  // Redundant writes are suppressed via the session envelopeAutomationLastValues cache.
  // Master and chain-mode tracks are skipped. One Envelope node yields one output value;
  // there is no per-voice aggregation.
  applyEnvelopeModulationAtTick: async (globalTick, options = {}) => {
    if (!Number.isFinite(globalTick)) return { ok: false, reason: 'invalid_tick' }
    const state = get()
    const epsilon = Number.isFinite(options.epsilon) ? options.epsilon : 1e-4
    const trackEvents = options.trackEvents != null && typeof options.trackEvents === 'object'
      ? options.trackEvents
      : {}
    const driven = []

    for (const [key, graphState] of Object.entries(state.graphStates)) {
      if (key === 'master') continue
      if (resolveFxMode(state.fxModes, key) !== 'graph') continue
      if (!graphState || !Array.isArray(graphState.nodes)) continue
      const envelopeNodes = graphState.nodes.filter((node) => node.type === 'envelope')
      if (envelopeNodes.length === 0) continue
      const events = Array.isArray(trackEvents[key]) ? trackEvents[key] : []

      for (const node of envelopeNodes) {
        const settings = normalizeEnvelopeRuntimeSettings(node.data, {
          msPerTick: options.msPerTick,
          bpm: options.bpm,
        })
        const out = evaluateEnvelopeOutput(settings, events, globalTick)

        // Non-reactive dedupe (EVC-R2-r1): updating the module-level holder instead of Zustand
        // state avoids a store notification on every 60 Hz drive pass.
        const cacheKey = envelopeRuntimeKey(key, node.id)
        const last = envelopeRuntimeLastValues.get(cacheKey)
        if (last != null && Math.abs(last - out.value) <= epsilon) continue

        envelopeRuntimeLastValues.set(cacheKey, out.value)
        await driveEnvelopeParameterEdges(get, key, graphState, node.id, out.value, options)
        driven.push({ trackId: key, envelopeNodeId: node.id, value: out.value, phase: out.phase })
      }
    }
    return { ok: true, driven }
  },

  // Clears the session last-applied envelope cache so the next drive re-applies every
  // envelope (used on transport stop/seek/project-load). The cache is the non-reactive
  // module-level holder (EVC-R2-r1), so this clears it without a store notification. Does
  // not change any value itself; the playback controller follows a stop reset with one
  // no-gate flush pass to drive 0.
  resetEnvelopeModulationRuntime: () => { clearEnvelopeRuntimeCache() },

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
    graphSidechainStatuses: {},
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
