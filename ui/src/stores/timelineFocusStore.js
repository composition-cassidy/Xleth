import { create } from 'zustand'

const useTimelineFocusStore = create((set) => ({
  focusedTrackId: null,
  setFocusedTrackId: (id) => set((state) => {
    const nextId = id ?? null
    return state.focusedTrackId === nextId ? state : { focusedTrackId: nextId }
  }),
}))

export default useTimelineFocusStore
