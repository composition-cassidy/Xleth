import { create } from 'zustand'

const useSamplerPanelStore = create((set) => ({
  regionId: null,
  setRegionId: (regionId) => set({ regionId }),
}))

export default useSamplerPanelStore
