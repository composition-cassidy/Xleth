import { create } from 'zustand'

const useUIStore = create((set) => ({
  timelineTrackHeaderWidth: 200,
  setTimelineTrackHeaderWidth: (width) => set((state) => (
    state.timelineTrackHeaderWidth === width ? state : { timelineTrackHeaderWidth: width }
  )),
}))

export default useUIStore
