import { create } from 'zustand'
import { timelineEvents } from '../timelineEvents.js'
import { mergeClipModulationPatch } from '../components/timeline/clipModulationPatch.js'
import { bakeScratchCurve, unbakeScratchCurve } from '../components/timeline/clipScratch.js'

// ── Floating per-clip Scratch editor store ───────────────────────────────────
//
// The twin of stores/clipVibratoEditorStore.js, and deliberately its mirror
// image: identity is `{ clipId }`, open()/close() say nothing about WHERE the
// editor is mounted, the store keeps its own copy of the target clip refreshed
// off the shared `timelineEvents` bus, and every write goes through
// mergeClipModulationPatch + timeline.setClipModulation.
//
// The one structural difference is the AUTHOR/ENGINE split. The engine stores a
// flat list of `{ time, rateMultiplier, curve }` and plays every segment as a
// straight line (ClipModulationEvaluator.cpp evaluateScratch → lerpRate); the
// editor authors `{ time, rateMultiplier, tension }` and bakes a tensioned
// segment down into real breakpoints on commit. This store owns that boundary:
//   - `authorCurve()` unbakes whatever the engine currently holds,
//   - `commitCurve(authorPoints)` bakes once and writes once.
// Nothing outside this store — and nothing at all outside clipScratch.js — needs
// to know the bake exists.
//
// EDIT DISCIPLINE. `draftCurve` is a purely local preview of the author points
// mid-gesture: pointer-move calls previewCurve() (no IPC at all), and release
// calls commitCurve() exactly once. One gesture is one setClipModulation call is
// one undo step, and there is no parallel write path.

function readClipList(raw) {
  return Array.isArray(raw) ? raw : []
}

const useClipScratchEditorStore = create((set, get) => ({
  // { clipId } | null
  target: null,

  // Last known engine state for the target clip (whole clip object).
  clip: null,

  // Local, uncommitted AUTHOR points during a drag. null => read the engine.
  draftCurve: null,

  // Canvas selection (UI-only).
  selectedIdx: -1,

  open(clipId) {
    const id = Number(clipId)
    if (!Number.isFinite(id)) return
    set({ target: { clipId: id }, clip: null, draftCurve: null, selectedIdx: -1 })
    get().refresh()
  },

  close() {
    set({ target: null, clip: null, draftCurve: null, selectedIdx: -1 })
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

  // The scratch block the panel should render.
  currentScratch() {
    return get().clip?.modulation?.scratch ?? {}
  },

  // The AUTHOR points the graph edits: the local draft while a gesture is in
  // flight, otherwise the engine curve unbaked.
  authorCurve() {
    const draft = get().draftCurve
    if (draft) return draft
    return unbakeScratchCurve(get().clip?.modulation?.scratch?.curve)
  },

  // LOCAL preview only — deliberately no IPC. Called on every pointer-move of a
  // point or tension drag.
  previewCurve(authorPoints) {
    set({ draftCurve: Array.isArray(authorPoints) ? authorPoints : null })
  },

  clearDraft() {
    set({ draftCurve: null })
  },

  // The single commit point for curve edits. Clears the draft only after the
  // engine has the new value, so the graph never flashes back to the old curve.
  async commitCurve(authorPoints) {
    const baked = bakeScratchCurve(authorPoints)
    if (baked.length === 0) return false
    set({ draftCurve: Array.isArray(authorPoints) ? authorPoints : null })
    const ok = await get().commitScratch({ curve: baked })
    set({ draftCurve: null })
    return ok
  },

  // Scalar (and preset-stamp) commits take the same route the clip dropdown
  // does: merge onto the whole modulation block, one setClipModulation call.
  // The video companion's amounts (Swirl / Wave), edited in this window since
  // round 2 step 17: the same merge-and-write as every other control here, one
  // setClipModulation per gesture. Turning the companion on or off stays in the
  // Inspector, which seeds it from Settings > Clip FX.
  async commitVideo(videoPatch) {
    const t = get().target
    if (!t || !videoPatch) return false
    try {
      const timeline = globalThis.window?.xleth?.timeline
      if (typeof timeline?.setClipModulation !== 'function') {
        console.error('[ClipScratch] timeline.setClipModulation unavailable')
        return false
      }
      await get().refresh()
      const clip = get().clip
      if (!clip) return false
      const merged = mergeClipModulationPatch(clip, { videoPatch })
      const updated = await timeline.setClipModulation(t.clipId, merged)
      if (updated && updated.id === t.clipId) set({ clip: updated })
      else await get().refresh()
      timelineEvents.dispatchEvent(new Event('timeline-clips-changed'))
      return true
    } catch (err) {
      console.error('[ClipScratch] setClipModulation (video) error:', err)
      return false
    }
  },

  async commitScratch(scratchPatch) {
    const t = get().target
    if (!t || !scratchPatch) return false
    try {
      const timeline = globalThis.window?.xleth?.timeline
      if (typeof timeline?.setClipModulation !== 'function') {
        console.error('[ClipScratch] timeline.setClipModulation unavailable')
        return false
      }
      // Merge against the freshest clip we can get, so a commit never resurrects
      // fields another surface changed since this panel last refreshed.
      await get().refresh()
      const clip = get().clip
      if (!clip) return false

      const merged = mergeClipModulationPatch(clip, {
        scratchPatch,
        forceEnabled: scratchPatch.enabled === true,
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
      console.error('[ClipScratch] setClipModulation error:', err)
      return false
    }
  },
}))

// Stay coherent with the rest of the app: any timeline clip mutation refreshes
// the open panel (and closes it if its clip is gone). Registered once at module
// scope, exactly as clipVibratoEditorStore.js does.
timelineEvents.addEventListener('timeline-clips-changed', () => {
  if (useClipScratchEditorStore.getState().target) {
    useClipScratchEditorStore.getState().refresh()
  }
})

export default useClipScratchEditorStore
