import { create } from 'zustand'

// Notation ghost clips: the preview of what Quick Notation WILL insert. They
// all sit on one track (`trackId`, the track the clips will land on), never
// one row per syllable.
const useGhostClipStore = create((set) => ({
  ghostClips: [],
  trackId: null,
  setGhostClips: (clips, trackId = null) => set({ ghostClips: clips, trackId }),
  clearGhostClips: () => set({ ghostClips: [], trackId: null }),
}))

export default useGhostClipStore
