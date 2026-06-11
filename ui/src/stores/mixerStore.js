import { create } from 'zustand'
import { timelineEvents } from '../timelineEvents.js'
import { createPeakEntry, prunePeakSnapshotTracks } from '../components/mixer/meterTelemetry.js'

export const MASTER_OUTPUT_TARGET_ID = -1
export const COMPRESSOR_EXTERNAL_SIDECHAIN_PARAM_ID = 'sc_external'

export function normalizeOutputTargetId(value) {
  const n = Number(value)
  return Number.isInteger(n) ? n : MASTER_OUTPUT_TARGET_ID
}

export function normalizeOutputRoutesFromTracks(list) {
  const outputRoutes = {}
  if (!Array.isArray(list)) return outputRoutes
  for (const t of list) {
    const id = normalizeOutputTargetId(t?.id)
    if (id === MASTER_OUTPUT_TARGET_ID) continue
    outputRoutes[id] = normalizeOutputTargetId(t?.outputRoute?.targetTrackId)
  }
  return outputRoutes
}

export function normalizeOutputRoutesFromRoutingSnapshot(snapshot) {
  const outputRoutes = {}
  if (!Array.isArray(snapshot)) return outputRoutes
  for (const entry of snapshot) {
    const id = normalizeOutputTargetId(entry?.trackId)
    if (id === MASTER_OUTPUT_TARGET_ID) continue
    outputRoutes[id] = normalizeOutputTargetId(entry?.outputRoute?.targetTrackId)
  }
  return outputRoutes
}

export function normalizeSidechainRoutesFromRoutingSnapshot(snapshot) {
  const routes = []
  if (!Array.isArray(snapshot)) return routes

  for (const entry of snapshot) {
    const sourceTrackId = normalizeOutputTargetId(entry?.trackId)
    if (sourceTrackId === MASTER_OUTPUT_TARGET_ID) continue
    const rawRoutes = Array.isArray(entry?.sidechainRoutes) ? entry.sidechainRoutes : []
    for (const route of rawRoutes) {
      const routeId = typeof route?.routeId === 'string' ? route.routeId : ''
      const targetEffectInstanceId =
        typeof route?.targetEffectInstanceId === 'string' ? route.targetEffectInstanceId : ''
      if (!routeId || !targetEffectInstanceId) continue
      routes.push({
        routeId,
        sourceTrackId: normalizeOutputTargetId(route?.sourceTrackId ?? sourceTrackId),
        targetTrackId: normalizeOutputTargetId(route?.targetTrackId),
        targetEffectInstanceId,
        gain: Number.isFinite(route?.gain) ? route.gain : 1,
        preFader: route?.preFader === true,
        enabled: route?.enabled !== false,
        status: typeof route?.status === 'string' && route.status.length > 0
          ? route.status
          : 'ok',
      })
    }
  }
  return routes
}

export function wouldCreateOutputRouteCycle(routesByTrackId, sourceTrackId, targetTrackId) {
  const sourceId = normalizeOutputTargetId(sourceTrackId)
  let current = normalizeOutputTargetId(targetTrackId)
  if (current === MASTER_OUTPUT_TARGET_ID) return false
  if (current === sourceId) return true

  const visited = new Set()
  while (current !== MASTER_OUTPUT_TARGET_ID && !visited.has(current)) {
    if (current === sourceId) return true
    visited.add(current)
    const next = routesByTrackId?.[current]
    if (next == null) return false
    current = normalizeOutputTargetId(next)
  }
  return false
}

function buildRoutingAdjacency(outputRoutes, sidechainRoutes, candidateRoute = null) {
  const adjacency = new Map()
  const addEdge = (source, target) => {
    const sourceId = normalizeOutputTargetId(source)
    const targetId = normalizeOutputTargetId(target)
    if (sourceId === MASTER_OUTPUT_TARGET_ID || targetId === MASTER_OUTPUT_TARGET_ID) return
    if (!adjacency.has(sourceId)) adjacency.set(sourceId, new Set())
    adjacency.get(sourceId).add(targetId)
  }

  for (const [sourceTrackId, targetTrackId] of Object.entries(outputRoutes ?? {})) {
    addEdge(sourceTrackId, targetTrackId)
  }

  const routes = Array.isArray(sidechainRoutes) ? sidechainRoutes : []
  for (const route of routes) {
    if (!route || route.enabled === false) continue
    addEdge(route.sourceTrackId, route.targetTrackId)
  }

  if (candidateRoute) {
    addEdge(candidateRoute.sourceTrackId, candidateRoute.targetTrackId)
  }

  return adjacency
}

export function wouldCreateSidechainRouteCycle(
  outputRoutes,
  sidechainRoutes,
  sourceTrackId,
  targetTrackId,
) {
  const sourceId = normalizeOutputTargetId(sourceTrackId)
  const targetId = normalizeOutputTargetId(targetTrackId)
  if (sourceId === MASTER_OUTPUT_TARGET_ID || targetId === MASTER_OUTPUT_TARGET_ID) return false
  if (sourceId === targetId) return true

  const adjacency = buildRoutingAdjacency(outputRoutes, sidechainRoutes, {
    sourceTrackId: sourceId,
    targetTrackId: targetId,
  })
  const visited = new Set()
  const stack = [targetId]

  while (stack.length > 0) {
    const current = stack.pop()
    if (current === sourceId) return true
    if (visited.has(current)) continue
    visited.add(current)
    const nextTargets = adjacency.get(current)
    if (!nextTargets) continue
    for (const next of nextTargets) {
      if (!visited.has(next)) stack.push(next)
    }
  }
  return false
}

export function mapOutputRouteError(reason) {
  switch (reason) {
    case 'cycle':
      return 'Would create feedback loop'
    case 'self_route':
      return 'Cannot route a track to itself'
    case 'unknown_track':
      return 'Target track no longer exists'
    case 'invalid_target':
      return 'Invalid output target'
    case 'master_as_source':
      return 'Master has no output route'
    default:
      return 'Route rejected'
  }
}

export function mapSidechainRouteError(reason) {
  switch (reason) {
    case 'cycle':
      return 'Would create feedback loop'
    case 'self_sidechain':
      return 'Cannot sidechain a track into itself'
    case 'unknown_source_track':
      return 'Source track no longer exists'
    case 'unknown_target_track':
      return 'Target track no longer exists'
    case 'empty_effect_instance':
      return 'Effect is missing a stable instance ID'
    case 'unknown_effect_instance':
      return 'Target effect no longer exists'
    case 'master_as_source':
    case 'master_as_target':
      return 'Master sidechain is not supported yet'
    case 'invalid_gain':
      return 'Invalid sidechain gain'
    case 'duplicate_route':
      return 'Sidechain route already exists'
    default:
      return 'Route rejected'
  }
}

function mapCompressorSidechainModeError() {
  return 'Could not update compressor sidechain mode'
}

function mapSidechainRouteRemoveError() {
  return 'Could not remove sidechain route'
}

function sidechainEffectKey(targetTrackId, effectInstanceId) {
  return `${normalizeOutputTargetId(targetTrackId)}::${effectInstanceId ?? ''}`
}

export function findSidechainRouteForEffect(sidechainRoutes, targetTrackId, effectInstanceId) {
  if (typeof effectInstanceId !== 'string' || effectInstanceId.length === 0) return null
  const targetId = normalizeOutputTargetId(targetTrackId)
  const routes = Array.isArray(sidechainRoutes) ? sidechainRoutes : []
  const matches = routes.filter((route) =>
    normalizeOutputTargetId(route?.targetTrackId) === targetId &&
    route?.targetEffectInstanceId === effectInstanceId)
  return matches.find((route) => route.enabled !== false) ?? matches[0] ?? null
}

function isAudioMixerTarget(track) {
  return Boolean(track) && !track.visualOnly && track.id !== MASTER_OUTPUT_TARGET_ID
}

function sidechainDiag(eventName, fields = {}) {
  try {
    globalThis.window?.xleth?.diagnostics?.sidechain?.('UI', eventName, fields)
  } catch {}
}

function summarizeRelevantSidechainRoutes(routes, targetTrackId, effectInstanceId) {
  const targetId = normalizeOutputTargetId(targetTrackId)
  return (Array.isArray(routes) ? routes : [])
    .filter(route =>
      normalizeOutputTargetId(route?.targetTrackId) === targetId &&
      route?.targetEffectInstanceId === effectInstanceId)
    .map(route => ({
      routeId: route.routeId,
      sourceTrackId: route.sourceTrackId,
      targetTrackId: route.targetTrackId,
      targetEffectInstanceId: route.targetEffectInstanceId,
      enabled: route.enabled,
      status: route.status,
      gain: route.gain,
      preFader: route.preFader,
    }))
}

async function setCompressorExternalSidechainParam({
  targetTrackId,
  targetNodeId,
  effectInstanceId,
  enabled,
  options = {},
}) {
  const audio = options.audio ?? globalThis.window?.xleth?.audio
  const setEffectParameter = options.setEffectParameter ?? audio?.setEffectParameter
  if (typeof setEffectParameter !== 'function') {
    return { ok: false, reason: 'engine_unavailable', error: mapCompressorSidechainModeError() }
  }
  if (!Number.isInteger(targetNodeId) || targetNodeId < 0) {
    return { ok: false, reason: 'unknown_effect_instance', error: mapCompressorSidechainModeError() }
  }

  try {
    sidechainDiag('setEffectParameter_call', {
      targetTrackId: normalizeOutputTargetId(targetTrackId),
      nodeId: targetNodeId,
      effectInstanceId,
      paramId: COMPRESSOR_EXTERNAL_SIDECHAIN_PARAM_ID,
      value: enabled ? 1 : 0,
    })
    const result = await setEffectParameter(
      normalizeOutputTargetId(targetTrackId),
      targetNodeId,
      COMPRESSOR_EXTERNAL_SIDECHAIN_PARAM_ID,
      enabled ? 1 : 0,
    )
    sidechainDiag('setEffectParameter_result', {
      targetTrackId: normalizeOutputTargetId(targetTrackId),
      nodeId: targetNodeId,
      effectInstanceId,
      paramId: COMPRESSOR_EXTERNAL_SIDECHAIN_PARAM_ID,
      resolvedValue: enabled ? 1 : 0,
      result,
    })
    // audio_setEffectParameter resolves to a plain boolean (Napi::Boolean):
    // false means the engine could not set the parameter (unknown track/node/
    // param — e.g. an out-of-date native addon without `sc_external`). Treat it
    // as a real failure; masking it leaves the toggle ON with no engine effect.
    if (result === false || (result && typeof result === 'object' && result.ok === false)) {
      const reason = (result && typeof result === 'object' && result.reason) || 'engine_error'
      return { ok: false, reason, error: mapCompressorSidechainModeError() }
    }
    return { ok: true }
  } catch (e) {
    sidechainDiag('setEffectParameter_error', {
      targetTrackId: normalizeOutputTargetId(targetTrackId),
      nodeId: targetNodeId,
      effectInstanceId,
      paramId: COMPRESSOR_EXTERNAL_SIDECHAIN_PARAM_ID,
      value: enabled ? 1 : 0,
      error: e?.message ?? String(e),
    })
    ;(options.warn ?? console.warn)?.('[mixerStore] compressor sidechain parameter set failed:', e?.message ?? e)
    return { ok: false, reason: 'ipc_error', error: mapCompressorSidechainModeError() }
  }
}

// ── Peak snapshot (non-reactive, mutated in-place) ──────────────────────────
// PeakMeter reads this in rAF; polling loop writes it. Never triggers renders.
export const peaksSnapshot = {
  tracks: {},  // { [trackId]: { peakL, peakR, holdL, holdR, holdTimeL, holdTimeR, hasTelemetry, lastTelemetryMs } }
  master: createPeakEntry(),
}

// ── Store ───────────────────────────────────────────────────────────────────
const useMixerStore = create((set, get) => ({
  tracks: {},       // { [trackId]: { id, name, volume, pan, spread, muted, solo, visualOnly, type } }
  trackOrder: [],   // [id, ...]
  outputRoutes: {}, // { [sourceTrackId]: targetTrackId }, -1 = Master
  sidechainRoutes: [], // [{ routeId, sourceTrackId, targetTrackId, targetEffectInstanceId, ... }]
  routingError: null,
  sidechainRoutingErrors: {}, // { [`${targetTrackId}::${effectInstanceId}`]: message }
  master: { volume: 1.0 },
  visible: false,

  toggleMixer: () => set(s => ({ visible: !s.visible })),
  setVisible: (v) => set({ visible: v }),

  init: async () => {
    try {
      const list = await window.xleth?.timeline?.getTracks()
      if (!Array.isArray(list)) return
      const prev = get().tracks
      const tracks = {}
      const trackOrder = []
      const outputRoutes = normalizeOutputRoutesFromTracks(list)
      for (const t of list) {
        trackOrder.push(t.id)
        // Preserve mixer-owned params if already set, otherwise use engine values
        const existing = prev[t.id]
        tracks[t.id] = {
          id: t.id,
          name: t.name,
          volume: existing != null ? existing.volume : (t.volume ?? 1.0),
          pan: existing != null ? existing.pan : (t.pan ?? 0.0),
          spread: existing != null ? existing.spread : (t.stereoSpread ?? 1.0),
          muted: t.muted,
          solo: t.solo,
          visualOnly: t.visualOnly ?? false,
          type: t.type,
        }
        // Ensure peak entry exists
        if (!peaksSnapshot.tracks[t.id]) {
          peaksSnapshot.tracks[t.id] = createPeakEntry()
        }
      }
      prunePeakSnapshotTracks(peaksSnapshot, trackOrder)
      set({ tracks, trackOrder, outputRoutes, routingError: null })
      if (list.some(t => t?.outputRoute == null)) {
        await get().refreshRouting()
      }
    } catch (e) {
      console.warn('[mixerStore] init failed:', e.message)
    }
  },

  setVolume: (trackId, linearGain) => {
    set(s => {
      const t = s.tracks[trackId]
      if (!t) return s
      return { tracks: { ...s.tracks, [trackId]: { ...t, volume: linearGain } } }
    })
    window.xleth?.audio?.setTrackVolume(trackId, linearGain)
  },

  setMasterVolume: (linearGain) => {
    set({ master: { volume: linearGain } })
    window.xleth?.audio?.setMasterVolume(linearGain)
  },

  setPan: (trackId, pan) => {
    set(s => {
      const t = s.tracks[trackId]
      if (!t) return s
      return { tracks: { ...s.tracks, [trackId]: { ...t, pan } } }
    })
    window.xleth?.audio?.setTrackPan(trackId, pan)
  },

  setSpread: (trackId, spread) => {
    set(s => {
      const t = s.tracks[trackId]
      if (!t) return s
      return { tracks: { ...s.tracks, [trackId]: { ...t, spread } } }
    })
    window.xleth?.audio?.setTrackSpread(trackId, spread)
  },

  toggleMute: (trackId) => {
    const t = get().tracks[trackId]
    if (!t) return
    const next = !t.muted
    set(s => ({ tracks: { ...s.tracks, [trackId]: { ...s.tracks[trackId], muted: next } } }))
    window.xleth?.timeline?.setTrackMuted(trackId, next)
    timelineEvents.dispatchEvent(new Event('timeline-tracks-changed'))
  },

  toggleSolo: (trackId) => {
    const t = get().tracks[trackId]
    if (!t) return
    const next = !t.solo
    set(s => ({ tracks: { ...s.tracks, [trackId]: { ...s.tracks[trackId], solo: next } } }))
    window.xleth?.timeline?.setTrackSolo(trackId, next)
    timelineEvents.dispatchEvent(new Event('timeline-tracks-changed'))
  },

  toggleVisualOnly: (trackId) => {
    const t = get().tracks[trackId]
    if (!t) return
    const next = !t.visualOnly
    set(s => ({ tracks: { ...s.tracks, [trackId]: { ...s.tracks[trackId], visualOnly: next } } }))
    window.xleth?.timeline?.setTrackVisualOnly(trackId, next)
    timelineEvents.dispatchEvent(new Event('timeline-tracks-changed'))
  },

  // Output routing state mirrors engine/project state; engine validation remains final.
  getTrackOutputRoute: (trackId) => ({
    targetTrackId: get().outputRoutes[normalizeOutputTargetId(trackId)] ?? MASTER_OUTPUT_TARGET_ID,
  }),

  getBusInputCount: (trackId) => {
    const id = normalizeOutputTargetId(trackId)
    if (id === MASTER_OUTPUT_TARGET_ID) return 0
    const { outputRoutes, tracks } = get()
    return Object.entries(outputRoutes).reduce((count, [sourceId, targetId]) => {
      if (normalizeOutputTargetId(targetId) !== id) return count
      return tracks[sourceId] ? count + 1 : count
    }, 0)
  },

  getSidechainRouteForEffect: (targetTrackId, effectInstanceId) =>
    findSidechainRouteForEffect(get().sidechainRoutes, targetTrackId, effectInstanceId),

  getSidechainErrorForEffect: (targetTrackId, effectInstanceId) =>
    get().sidechainRoutingErrors[sidechainEffectKey(targetTrackId, effectInstanceId)] ?? null,

  getEligibleSidechainSources: (targetTrackId) => {
    const targetId = normalizeOutputTargetId(targetTrackId)
    const { tracks, trackOrder, outputRoutes, sidechainRoutes } = get()
    const sources = []
    for (const id of trackOrder) {
      const source = tracks[id]
      if (!source || id === targetId) continue
      if (!isAudioMixerTarget(source)) continue
      if (wouldCreateSidechainRouteCycle(outputRoutes, sidechainRoutes, id, targetId)) continue
      sources.push({ sourceTrackId: id, name: source.name || `Track ${id}` })
    }
    return sources
  },

  getEligibleOutputTargets: (trackId) => {
    const sourceId = normalizeOutputTargetId(trackId)
    const { tracks, trackOrder, outputRoutes } = get()
    const targets = [{ targetTrackId: MASTER_OUTPUT_TARGET_ID, name: 'Master' }]
    for (const id of trackOrder) {
      const target = tracks[id]
      if (!target || id === sourceId) continue
      if (!isAudioMixerTarget(target)) continue
      if (wouldCreateOutputRouteCycle(outputRoutes, sourceId, id)) continue
      targets.push({ targetTrackId: id, name: target.name || `Track ${id}` })
    }
    return targets
  },

  getOutputTargetRejectionReason: (trackId, targetTrackId) => {
    const sourceId = normalizeOutputTargetId(trackId)
    const targetId = normalizeOutputTargetId(targetTrackId)
    const { tracks, outputRoutes } = get()
    if (targetId === MASTER_OUTPUT_TARGET_ID) return null
    if (targetId === sourceId) return 'self_route'
    const target = tracks[targetId]
    if (!target) return 'unknown_track'
    if (!isAudioMixerTarget(target)) return 'invalid_target'
    if (wouldCreateOutputRouteCycle(outputRoutes, sourceId, targetId)) return 'cycle'
    return null
  },

  refreshRouting: async () => {
    try {
      const routing = await window.xleth?.timeline?.getRouting?.()
      if (!Array.isArray(routing)) return null
      const fetchedRoutes = normalizeOutputRoutesFromRoutingSnapshot(routing)
      const sidechainRoutes = normalizeSidechainRoutesFromRoutingSnapshot(routing)
      set(s => {
        const outputRoutes = {}
        for (const id of s.trackOrder) {
          outputRoutes[id] = fetchedRoutes[id] ?? MASTER_OUTPUT_TARGET_ID
        }
        return { outputRoutes, sidechainRoutes, routingError: null }
      })
      return { outputRoutes: fetchedRoutes, sidechainRoutes }
    } catch (e) {
      console.warn('[mixerStore] refreshRouting failed:', e.message)
      return null
    }
  },

  setOutputRoute: async (trackId, targetTrackId) => {
    const sourceId = normalizeOutputTargetId(trackId)
    const targetId = normalizeOutputTargetId(targetTrackId)
    const rejectionReason = get().getOutputTargetRejectionReason(sourceId, targetId)
    if (rejectionReason) {
      const error = mapOutputRouteError(rejectionReason)
      set({ routingError: error })
      return { ok: false, reason: rejectionReason, error }
    }

    const previousTargetId = get().outputRoutes[sourceId] ?? MASTER_OUTPUT_TARGET_ID
    set(s => ({
      outputRoutes: { ...s.outputRoutes, [sourceId]: targetId },
      routingError: null,
    }))

    try {
      const result = await window.xleth?.timeline?.setTrackOutputRoute?.(sourceId, targetId)
      if (!result || result.ok === false) {
        const reason = result?.reason || 'rejected'
        const error = mapOutputRouteError(reason)
        set(s => ({
          outputRoutes: { ...s.outputRoutes, [sourceId]: previousTargetId },
          routingError: error,
        }))
        await get().refreshRouting()
        set({ routingError: error })
        return { ok: false, reason, error }
      }

      const confirmedTargetId = normalizeOutputTargetId(result.targetTrackId ?? targetId)
      set(s => ({
        outputRoutes: { ...s.outputRoutes, [sourceId]: confirmedTargetId },
        routingError: null,
      }))
      timelineEvents.dispatchEvent(new Event('timeline-routing-changed'))
      return { ok: true, targetTrackId: confirmedTargetId }
    } catch (e) {
      const error = 'Route rejected'
      set(s => ({
        outputRoutes: { ...s.outputRoutes, [sourceId]: previousTargetId },
        routingError: error,
      }))
      await get().refreshRouting()
      set({ routingError: error })
      return { ok: false, reason: 'ipc_error', error }
    }
  },

  removeSidechainRouteForEffect: async ({ targetTrackId, effectInstanceId } = {}, options = {}) => {
    const targetId = normalizeOutputTargetId(targetTrackId)
    const route = findSidechainRouteForEffect(get().sidechainRoutes, targetId, effectInstanceId)
    const errorKey = sidechainEffectKey(targetId, effectInstanceId)
    if (!route) {
      set(s => {
        const nextErrors = { ...s.sidechainRoutingErrors }
        delete nextErrors[errorKey]
        return { sidechainRoutingErrors: nextErrors }
      })
      return { ok: true, removed: false }
    }

    const timeline = options.timeline ?? globalThis.window?.xleth?.timeline
    const removeRoute = options.removeSidechainRoute ?? timeline?.removeSidechainRoute
    if (typeof removeRoute !== 'function') {
      const error = mapSidechainRouteRemoveError()
      set(s => ({
        sidechainRoutingErrors: { ...s.sidechainRoutingErrors, [errorKey]: error },
      }))
      return { ok: false, reason: 'engine_unavailable', error }
    }

    try {
      sidechainDiag('removeSidechainRoute_call', {
        sourceTrackId: route.sourceTrackId,
        routeId: route.routeId,
        targetTrackId: targetId,
        targetEffectInstanceId: effectInstanceId,
      })
      const result = await removeRoute(route.sourceTrackId, route.routeId)
      sidechainDiag('removeSidechainRoute_result', {
        sourceTrackId: route.sourceTrackId,
        routeId: route.routeId,
        targetTrackId: targetId,
        targetEffectInstanceId: effectInstanceId,
        result,
      })
      if (result === false || result?.ok === false) {
        const reason = result?.reason || 'rejected'
        const error = mapSidechainRouteRemoveError()
        await get().refreshRouting()
        sidechainDiag('getRouting_afterRouteMutation', {
          targetTrackId: targetId,
          targetEffectInstanceId: effectInstanceId,
          routes: summarizeRelevantSidechainRoutes(get().sidechainRoutes, targetId, effectInstanceId),
        })
        set(s => ({
          sidechainRoutingErrors: { ...s.sidechainRoutingErrors, [errorKey]: error },
        }))
        return { ok: false, reason, error }
      }
      await get().refreshRouting()
      sidechainDiag('getRouting_afterRouteMutation', {
        targetTrackId: targetId,
        targetEffectInstanceId: effectInstanceId,
        routes: summarizeRelevantSidechainRoutes(get().sidechainRoutes, targetId, effectInstanceId),
      })
      set(s => {
        const nextErrors = { ...s.sidechainRoutingErrors }
        delete nextErrors[errorKey]
        return { sidechainRoutingErrors: nextErrors }
      })
      timelineEvents.dispatchEvent(new Event('timeline-routing-changed'))
      return { ok: true, removed: true }
    } catch (e) {
      sidechainDiag('removeSidechainRoute_error', {
        sourceTrackId: route.sourceTrackId,
        routeId: route.routeId,
        targetTrackId: targetId,
        targetEffectInstanceId: effectInstanceId,
        error: e?.message ?? String(e),
      })
      ;(options.warn ?? console.warn)?.('[mixerStore] removeSidechainRouteForEffect failed:', e?.message ?? e)
      const error = mapSidechainRouteRemoveError()
      await get().refreshRouting()
      sidechainDiag('getRouting_afterRouteMutation', {
        targetTrackId: targetId,
        targetEffectInstanceId: effectInstanceId,
        routes: summarizeRelevantSidechainRoutes(get().sidechainRoutes, targetId, effectInstanceId),
      })
      set(s => ({
        sidechainRoutingErrors: { ...s.sidechainRoutingErrors, [errorKey]: error },
      }))
      return { ok: false, reason: 'ipc_error', error }
    }
  },

  setCompressorExternalSidechain: async ({
    targetTrackId,
    targetNodeId,
    effectInstanceId,
    enabled,
    sourceTrackId = null,
  } = {}, options = {}) => {
    const targetId = normalizeOutputTargetId(targetTrackId)
    const sourceId = sourceTrackId == null || sourceTrackId === ''
      ? null
      : normalizeOutputTargetId(sourceTrackId)
    const errorKey = sidechainEffectKey(targetId, effectInstanceId)
    const previousRoute = findSidechainRouteForEffect(get().sidechainRoutes, targetId, effectInstanceId)

    sidechainDiag('setCompressorExternalSidechain_request', {
      targetTrackId: targetId,
      nodeId: targetNodeId,
      effectInstanceId,
      requestedEnabled: enabled === true,
      sourceTrackId: sourceId,
      previousSourceTrackId: previousRoute?.sourceTrackId ?? null,
      previousRouteId: previousRoute?.routeId ?? null,
    })

    const setError = (error) => set(s => ({
      sidechainRoutingErrors: { ...s.sidechainRoutingErrors, [errorKey]: error },
    }))
    const clearError = () => set(s => {
      const nextErrors = { ...s.sidechainRoutingErrors }
      delete nextErrors[errorKey]
      return { sidechainRoutingErrors: nextErrors }
    })

    if (targetId === MASTER_OUTPUT_TARGET_ID) {
      const error = mapSidechainRouteError('master_as_target')
      setError(error)
      return { ok: false, reason: 'master_as_target', error, externalEnabled: false }
    }
    if (typeof effectInstanceId !== 'string' || effectInstanceId.length === 0) {
      const reason = 'empty_effect_instance'
      const error = mapSidechainRouteError(reason)
      setError(error)
      return { ok: false, reason, error, externalEnabled: false }
    }
    if (enabled === true && sourceId != null) {
      if (sourceId === targetId) {
        const reason = 'self_sidechain'
        const error = mapSidechainRouteError(reason)
        setError(error)
        return { ok: false, reason, error, externalEnabled: false }
      }
      if (!get().tracks[sourceId]) {
        const reason = 'unknown_source_track'
        const error = mapSidechainRouteError(reason)
        setError(error)
        return { ok: false, reason, error, externalEnabled: false }
      }
      if (wouldCreateSidechainRouteCycle(get().outputRoutes, get().sidechainRoutes, sourceId, targetId)) {
        const reason = 'cycle'
        const error = mapSidechainRouteError(reason)
        setError(error)
        return { ok: false, reason, error, externalEnabled: false }
      }
    }

    const paramResult = await setCompressorExternalSidechainParam({
      targetTrackId: targetId,
      targetNodeId,
      effectInstanceId,
      enabled: enabled === true,
      options,
    })
    if (!paramResult.ok) {
      setError(paramResult.error)
      return {
        ok: false,
        reason: paramResult.reason,
        error: paramResult.error,
        externalEnabled: !enabled,
      }
    }

    if (enabled !== true) {
      const removeResult = await get().removeSidechainRouteForEffect({
        targetTrackId: targetId,
        effectInstanceId,
      }, options)
      if (!removeResult.ok) {
        return { ...removeResult, externalEnabled: false }
      }
      clearError()
      return { ok: true, externalEnabled: false, route: null }
    }

    if (sourceId == null) {
      const removeResult = previousRoute
        ? await get().removeSidechainRouteForEffect({ targetTrackId: targetId, effectInstanceId }, options)
        : { ok: true }
      if (!removeResult.ok) {
        return { ...removeResult, externalEnabled: true }
      }
      clearError()
      return { ok: true, externalEnabled: true, route: null }
    }

    if (previousRoute?.sourceTrackId === sourceId && previousRoute.enabled !== false) {
      clearError()
      return { ok: true, externalEnabled: true, route: previousRoute }
    }

    if (previousRoute) {
      const removeResult = await get().removeSidechainRouteForEffect({
        targetTrackId: targetId,
        effectInstanceId,
      }, options)
      if (!removeResult.ok) {
        return { ...removeResult, externalEnabled: true }
      }
    }

    const timeline = options.timeline ?? globalThis.window?.xleth?.timeline
    const addRoute = options.addSidechainRoute ?? timeline?.addSidechainRoute
    if (typeof addRoute !== 'function') {
      const error = mapSidechainRouteError('engine_unavailable')
      setError(error)
      return { ok: false, reason: 'engine_unavailable', error, externalEnabled: true }
    }

    try {
      const payload = {
        targetTrackId: targetId,
        targetEffectInstanceId: effectInstanceId,
        gain: 1.0,
        preFader: false,
        enabled: true,
      }
      sidechainDiag('addSidechainRoute_call', {
        sourceTrackId: sourceId,
        targetTrackId: targetId,
        targetEffectInstanceId: effectInstanceId,
        payload,
      })
      const result = await addRoute(sourceId, payload)
      sidechainDiag('addSidechainRoute_result', {
        sourceTrackId: sourceId,
        targetTrackId: targetId,
        targetEffectInstanceId: effectInstanceId,
        ok: result?.ok ?? result,
        reason: result?.reason,
        routeId: result?.routeId,
      })
      if (result === false || result?.ok === false) {
        const reason = result?.reason || 'rejected'
        const error = mapSidechainRouteError(reason)
        if (previousRoute) {
          try {
            await addRoute(previousRoute.sourceTrackId, {
              targetTrackId: previousRoute.targetTrackId,
              targetEffectInstanceId: previousRoute.targetEffectInstanceId,
              gain: previousRoute.gain,
              preFader: previousRoute.preFader,
              enabled: previousRoute.enabled,
            })
          } catch {}
        }
        await get().refreshRouting()
        sidechainDiag('getRouting_afterRouteMutation', {
          targetTrackId: targetId,
          targetEffectInstanceId: effectInstanceId,
          routes: summarizeRelevantSidechainRoutes(get().sidechainRoutes, targetId, effectInstanceId),
        })
        setError(error)
        return { ok: false, reason, error, externalEnabled: true }
      }

      await get().refreshRouting()
      sidechainDiag('getRouting_afterRouteMutation', {
        targetTrackId: targetId,
        targetEffectInstanceId: effectInstanceId,
        routes: summarizeRelevantSidechainRoutes(get().sidechainRoutes, targetId, effectInstanceId),
      })
      clearError()
      timelineEvents.dispatchEvent(new Event('timeline-routing-changed'))
      return {
        ok: true,
        externalEnabled: true,
        routeId: result?.routeId,
      }
    } catch (e) {
      sidechainDiag('addSidechainRoute_error', {
        sourceTrackId: sourceId,
        targetTrackId: targetId,
        targetEffectInstanceId: effectInstanceId,
        error: e?.message ?? String(e),
      })
      ;(options.warn ?? console.warn)?.('[mixerStore] setCompressorExternalSidechain failed:', e?.message ?? e)
      if (previousRoute) {
        try {
          await addRoute(previousRoute.sourceTrackId, {
            targetTrackId: previousRoute.targetTrackId,
            targetEffectInstanceId: previousRoute.targetEffectInstanceId,
            gain: previousRoute.gain,
            preFader: previousRoute.preFader,
            enabled: previousRoute.enabled,
          })
        } catch {}
      }
      const error = 'Route rejected'
      await get().refreshRouting()
      sidechainDiag('getRouting_afterRouteMutation', {
        targetTrackId: targetId,
        targetEffectInstanceId: effectInstanceId,
        routes: summarizeRelevantSidechainRoutes(get().sidechainRoutes, targetId, effectInstanceId),
      })
      setError(error)
      return { ok: false, reason: 'ipc_error', error, externalEnabled: true }
    }
  },

  // One-way sync from timeline fetches — only muted/solo/name/order/routes, NOT vol/pan/spread
  syncFromTimeline: (list) => {
    if (!Array.isArray(list)) return
    set(s => {
      const tracks = { ...s.tracks }
      const trackOrder = []
      const outputRoutes = { ...s.outputRoutes }
      for (const t of list) {
        trackOrder.push(t.id)
        outputRoutes[t.id] = normalizeOutputTargetId(t.outputRoute?.targetTrackId)
        const existing = tracks[t.id]
        if (existing) {
          tracks[t.id] = { ...existing, name: t.name, muted: t.muted, solo: t.solo, visualOnly: t.visualOnly ?? false, type: t.type }
        } else {
          tracks[t.id] = {
            id: t.id, name: t.name,
            volume: t.volume ?? 1.0, pan: t.pan ?? 0.0, spread: t.stereoSpread ?? 1.0,
            muted: t.muted, solo: t.solo, visualOnly: t.visualOnly ?? false, type: t.type,
          }
          if (!peaksSnapshot.tracks[t.id]) {
            peaksSnapshot.tracks[t.id] = createPeakEntry()
          }
        }
      }
      // Remove tracks that no longer exist
      for (const id of Object.keys(tracks)) {
        if (!trackOrder.includes(Number(id))) {
          delete tracks[id]
          delete outputRoutes[id]
        }
      }
      prunePeakSnapshotTracks(peaksSnapshot, trackOrder)
      const nextSidechainRoutes = s.sidechainRoutes.filter((route) =>
        trackOrder.includes(Number(route.sourceTrackId)) &&
        trackOrder.includes(Number(route.targetTrackId)))
      return {
        tracks,
        trackOrder,
        outputRoutes,
        sidechainRoutes: nextSidechainRoutes,
        routingError: null,
      }
    })
  },
}))

export default useMixerStore
