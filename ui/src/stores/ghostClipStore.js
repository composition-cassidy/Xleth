import { create } from 'zustand'

const useGhostClipStore = create((set) => ({
  ghostClips: [],
  setGhostClips: (clips) => set({ ghostClips: clips }),
  clearGhostClips: () => set({ ghostClips: [] }),
}))

export default useGhostClipStore
