import { create } from 'zustand'

const useTimelineFocusStore = create((set) => ({
  focusedTrackId: null,
  setFocusedTrackId: (id) => set({ focusedTrackId: id ?? null }),
}))

export default useTimelineFocusStore
