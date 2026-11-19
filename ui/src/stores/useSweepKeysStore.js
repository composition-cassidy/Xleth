import { create } from 'zustand'

// Sweep key editing: the session state the arrangement's Sweep lane and the Lens
// panel share (docs/XLETH_LENS_ROAM_SPEC.md, P11). It mirrors useRoamKeysStore minus
// Auto-key: a Sweep has no viewer handles to record from, so a key is only ever
// placed on the lane or typed.
//
// View and gesture state only. Not undoable, not saved with the project; the keys
// themselves live in the engine and every edit of them is ONE UndoManager command
// (lensRoamApi.setTrackSweepKeys). `draft` is a gesture's local preview: the lane
// draws it and nothing else reads it, so no IPC happens until the gesture ends.

export const DEFAULT_SWEEP_CHANNEL = 'zoom'

const useSweepKeysStore = create((set, get) => ({
  /** Set<trackId> of tracks whose Sweep lane is shown under the Reel lane. */
  laneOpen: new Set(),
  setLaneOpen(trackId, open) {
    const cur = get().laneOpen
    if (cur.has(trackId) === !!open) return
    const next = new Set(cur)
    if (open) next.add(trackId)
    else next.delete(trackId)
    set({ laneOpen: next })
  },
  toggleLane(trackId) {
    get().setLaneOpen(trackId, !get().laneOpen.has(trackId))
  },

  /** The parameter each lane shows: { [trackId]: 'zoom' | 'centerX' | 'centerY' | 'rotationDeg' }. */
  channelByTrack: {},
  setChannel(trackId, channel) {
    if (get().channelByTrack[trackId] === channel) return
    set({ channelByTrack: { ...get().channelByTrack, [trackId]: channel } })
  },

  /** The selected key: { trackId, channel, pos } or null. */
  selected: null,
  select: (selected) => set({ selected }),

  /** The multi-selection: [{ trackId, channel, pos }] (see useRoamKeysStore.multi). */
  multi: [],
  setMulti: (multi) => set({ multi: multi ?? [] }),
  clearMulti: () => { if (get().multi.length) set({ multi: [] }) },

  /** A gesture's local preview of a track's whole key list: { trackId, keys } or null. */
  draft: null,
  setDraft: (trackId, keys) => set({ draft: { trackId, keys } }),
  clearDraft: () => { if (get().draft) set({ draft: null }) },
}))

export default useSweepKeysStore
