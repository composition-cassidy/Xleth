import { create } from 'zustand'

// Roam key editing: the session state the arrangement's key lane, the viewer
// overlay and the Roam inspector share (docs/XLETH_LENS_ROAM_SPEC.md, P10).
//
// View and gesture state only. Not undoable, not saved with the project; the
// keys themselves live in the engine and every edit of them is one UndoManager
// command (lensRoamApi.setTrackRoamKeys). `draft` is a gesture's local preview:
// the lane and the viewer both draw it, and nothing reads it but a draw, so no
// IPC happens until the gesture ends.

const useRoamKeysStore = create((set, get) => ({
  /** Auto-key: a move, scale or rotate of the cell in the viewer writes a key at the playhead. */
  autoKey: false,
  setAutoKey: (autoKey) => set({ autoKey: !!autoKey }),

  /** Set<trackId> of tracks whose key lane is shown under the track. */
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

  /** The parameter each lane shows: { [trackId]: 'offsetX' | 'offsetY' | 'scale' | 'rotationDeg' }. */
  channelByTrack: {},
  setChannel(trackId, channel) {
    if (get().channelByTrack[trackId] === channel) return
    set({ channelByTrack: { ...get().channelByTrack, [trackId]: channel } })
  },

  /** The selected key: { trackId, channel, pos } or null. */
  selected: null,
  select: (selected) => set({ selected }),

  /**
   * The multi-selection: [{ trackId, channel, pos }], across tracks and channels.
   * Built with Ctrl/Shift-click and Ctrl/Shift-drag on the lane; the lane's right-click
   * menu (interp, Bezier, delete) acts on it. Empty = only `selected` is selected.
   */
  multi: [],
  setMulti: (multi) => set({ multi: multi ?? [] }),
  clearMulti: () => { if (get().multi.length) set({ multi: [] }) },

  /** A gesture's local preview of a track's whole key list: { trackId, keys } or null. */
  draft: null,
  setDraft: (trackId, keys) => set({ draft: { trackId, keys } }),
  clearDraft: () => { if (get().draft) set({ draft: null }) },
}))

export const DEFAULT_ROAM_CHANNEL = 'offsetX'

export default useRoamKeysStore
