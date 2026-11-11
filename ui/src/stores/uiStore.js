import { create } from 'zustand'

const useUIStore = create((set) => ({
  timelineTrackHeaderWidth: 232, // = HEADER_WIDTH (constants/timeline.js)
  setTimelineTrackHeaderWidth: (width) => set((state) => (
    state.timelineTrackHeaderWidth === width ? state : { timelineTrackHeaderWidth: width }
  )),
}))

export default useUIStore
