import { create } from 'zustand'

const useUIStore = create((set) => ({
  timelineTrackHeaderWidth: 200,
  setTimelineTrackHeaderWidth: (width) => set({ timelineTrackHeaderWidth: width }),
}))

export default useUIStore
