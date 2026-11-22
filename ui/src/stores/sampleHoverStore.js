import { create } from 'zustand'

// The sample the pointer (or the arrow keys) is on in the Piano Roll's sample list. The Sample
// Selector, when it is open, scrolls to that row and marks it. Null whenever the list is closed.
const useSampleHoverStore = create((set) => ({
  regionId: null,
  setRegionId: (regionId) => set((s) => (s.regionId === regionId ? s : { regionId })),
}))

export default useSampleHoverStore
