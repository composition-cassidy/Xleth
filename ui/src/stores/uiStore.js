import { create } from 'zustand'

const useUIStore = create((set) => ({
  timelineTrackHeaderWidth: 212, // = HEADER_WIDTH (constants/timeline.js)
  setTimelineTrackHeaderWidth: (width) => set((state) => (
    state.timelineTrackHeaderWidth === width ? state : { timelineTrackHeaderWidth: width }
  )),
}))

export default useUIStore
