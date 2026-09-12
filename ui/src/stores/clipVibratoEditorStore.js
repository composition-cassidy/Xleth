import { create } from 'zustand'
import { timelineEvents } from '../timelineEvents.js'
import { mergeClipModulationPatch } from '../components/timeline/clipModulationPatch.js'
import { normalizeCustomShape } from '../components/timeline/clipVibrato.js'

// ── Floating per-clip Vibrato editor store ───────────────────────────────────
//
// Mirrors the stock-effect editor stores (see stores/eqStore.js): an
// identity-agnostic `target` with open()/close(), and nothing about WHERE the
// editor is mounted. The Timeline clip dropdown only *requests* the editor;
// ClipFxEditorHost owns its mounting.
//
// Identity here is clip identity — `{ clipId }` — rather than the effect
// stores' `{ trackId, nodeId, storeKey }`, because a per-clip modulation editor
// addresses a timeline clip, not a graph node.
//
// Data flow. The store keeps its OWN copy of the target clip, refreshed from
// `timeline.getClips()` whenever the timeline announces a change. TimelineView
// holds clips in component state, not a store, so subscribing to the shared
// `timelineEvents` bus is how a panel outside the Timeline tree stays coherent
// with it — and dispatching on that bus after a commit is how TimelineView
// learns about edits made from the panel.
//
// EDIT DISCIPLINE. `draftShape` is a purely local preview of the breakpoints
// mid-drag: pointer-move calls previewShape() (no IPC at all), and mouseup calls
// commitShape() exactly once. Every write — scalar or shape — goes through
// mergeClipModulationPatch + timeline.setClipModulation, which is
// UndoManager-backed, so one gesture is one undo step and there is no parallel
// write path.

function readClipList(raw) {
  return Array.isArray(raw) ? raw : []
}

const useClipVibratoEditorStore = create((set, get) => ({
  // { clipId } | null
  target: null,

  // Last known engine state for the target clip (whole clip object).
  clip: null,

  // Local, uncommitted breakpoint preview during a drag. null => show `clip`.
  draftShape: null,

  // Canvas selection (UI-only).
  selectedIdx: -1,

  open(clipId) {
    const id = Number(clipId)
    if (!Number.isFinite(id)) return
    set({ target: { clipId: id }, clip: null, draftShape: null, selectedIdx: -1 })
    get().refresh()
  },

  close() {
    set({ target: null, clip: null, draftShape: null, selectedIdx: -1 })
  },

  setSelectedIdx(idx) {
    set({ selectedIdx: Number.isInteger(idx) ? idx : -1 })
  },

  // Pull the target clip's current engine state. Closes the editor if the clip
  // is gone (deleted while open, or replaced by a project load).
  async refresh() {
    const t = get().target
    if (!t) return
    try {
      const clips = readClipList(await globalThis.window?.xleth?.timeline?.getClips?.())
      const clip = clips.find(c => c && c.id === t.clipId) ?? null
      // Only act on a definitive answer: an empty list from an engine that is
      // not ready yet must not be read as "the clip was deleted".
      if (!clip && clips.length > 0) { get().close(); return }
      if (clip) set({ clip })
    } catch { /* engine not ready */ }
  },

  // The vibrato block the panel should render: engine state, with the local
  // draft breakpoints layered on top while a drag is in flight.
  currentVibrato() {
    const { clip, draftShape } = get()
    const vibrato = clip?.modulation?.vibrato ?? {}
    if (!draftShape) return vibrato
    return { ...vibrato, customShape: draftShape }
  },

  // LOCAL preview only — deliberately no IPC. Called on every pointer-move of a
  // point drag.
  previewShape(points) {
    set({ draftShape: Array.isArray(points) ? points : null })
  },

  clearDraft() {
    set({ draftShape: null })
  },

  // The single commit point for shape edits. Clears the draft only after the
  // engine has the new value, so the graph never flashes back to the old shape.
  async commitShape(points) {
    const normalized = normalizeCustomShape(points)
    set({ draftShape: normalized })
    const ok = await get().commitVibrato({ customShape: normalized })
    set({ draftShape: null })
    return ok
  },

  // Scalar (and shape-selection) commits take the same route the clip dropdown
  // does: merge onto the whole modulation block, one setClipModulation call.
  async commitVibrato(vibratoPatch) {
    const t = get().target
    if (!t || !vibratoPatch) return false
    try {
      const timeline = globalThis.window?.xleth?.timeline
      if (typeof timeline?.setClipModulation !== 'function') {
        console.error('[ClipVibrato] timeline.setClipModulation unavailable')
        return false
      }
      // Merge against the freshest clip we can get, so a commit never resurrects
      // fields another surface changed since this panel last refreshed.
      await get().refresh()
      const clip = get().clip
      if (!clip) return false

      const merged = mergeClipModulationPatch(clip, {
        vibratoPatch,
        forceEnabled: vibratoPatch.enabled === true,
      })
      const updated = await timeline.setClipModulation(t.clipId, merged)

      // setClipModulation returns the updated clip; fall back to a refetch if a
      // future bridge revision stops doing so.
      if (updated && updated.id === t.clipId) set({ clip: updated })
      else await get().refresh()

      // Tell the Timeline (and anything else on the bus) to re-fetch.
      timelineEvents.dispatchEvent(new Event('timeline-clips-changed'))
      return true
    } catch (err) {
      console.error('[ClipVibrato] setClipModulation error:', err)
      return false
    }
  },
}))

// Stay coherent with the rest of the app: any timeline clip mutation refreshes
// the open panel (and closes it if its clip is gone). Registered once at module
// scope, exactly as effectChainStore.js hooks the project-load event.
timelineEvents.addEventListener('timeline-clips-changed', () => {
  if (useClipVibratoEditorStore.getState().target) {
    useClipVibratoEditorStore.getState().refresh()
  }
})

export default useClipVibratoEditorStore
