import { create } from 'zustand'

const useQuickNotationStore = create((set) => ({
  regionId: null,
  regionName: '',
  syllableCount: 0,
  regionDurationTicks: 0,
  setContext: (ctx) => set(ctx),
  clearContext: () => set({ regionId: null, regionName: '', syllableCount: 0, regionDurationTicks: 0 }),
}))

export default useQuickNotationStore
