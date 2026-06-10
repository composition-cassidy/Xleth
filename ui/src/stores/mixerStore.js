import { create } from 'zustand'
import { timelineEvents } from '../timelineEvents.js'
import { createPeakEntry, prunePeakSnapshotTracks } from '../components/mixer/meterTelemetry.js'

export const MASTER_OUTPUT_TARGET_ID = -1

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

function isAudioMixerTarget(track) {
  return Boolean(track) && !track.visualOnly && track.id !== MASTER_OUTPUT_TARGET_ID
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
  routingError: null,
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
      set(s => {
        const outputRoutes = {}
        for (const id of s.trackOrder) {
          outputRoutes[id] = fetchedRoutes[id] ?? MASTER_OUTPUT_TARGET_ID
        }
        return { outputRoutes, routingError: null }
      })
      return fetchedRoutes
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
      return { tracks, trackOrder, outputRoutes, routingError: null }
    })
  },
}))

export default useMixerStore
