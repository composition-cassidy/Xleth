import { create } from 'zustand'

// Which Pattern tracks have their Reel lane collapsed. The lane is shown by
// default, so the store holds the exceptions. Session view state (like the folder
// and automation-group collapse flags): not undoable, not saved with the project.

const useReelLaneStore = create((set, get) => ({
  /** Set<trackId> of tracks whose Reel lane is collapsed to its strip. */
  collapsed: new Set(),

  toggle(trackId) {
    const next = new Set(get().collapsed)
    if (next.has(trackId)) next.delete(trackId)
    else next.add(trackId)
    set({ collapsed: next })
  },

  setCollapsed(trackId, collapsed) {
    const current = get().collapsed
    if (current.has(trackId) === collapsed) return
    const next = new Set(current)
    if (collapsed) next.add(trackId)
    else next.delete(trackId)
    set({ collapsed: next })
  },
}))

export default useReelLaneStore
