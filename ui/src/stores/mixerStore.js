import { create } from 'zustand'
import { timelineEvents } from '../timelineEvents.js'
import { createPeakEntry, prunePeakSnapshotTracks } from '../components/mixer/meterTelemetry.js'

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
      set({ tracks, trackOrder })
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

  // One-way sync from timeline fetches — only muted/solo/name/order, NOT vol/pan/spread
  syncFromTimeline: (list) => {
    if (!Array.isArray(list)) return
    set(s => {
      const tracks = { ...s.tracks }
      const trackOrder = []
      for (const t of list) {
        trackOrder.push(t.id)
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
        if (!trackOrder.includes(Number(id))) delete tracks[id]
      }
      prunePeakSnapshotTracks(peaksSnapshot, trackOrder)
      return { tracks, trackOrder }
    })
  },
}))

export default useMixerStore
