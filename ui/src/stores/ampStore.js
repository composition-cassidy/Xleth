import { create } from 'zustand'

// Minimal store for the Amp Stack — tracks which effect instance is popped out.
// Parameter reads/writes go directly via window.xleth.audio (generic N-API).
// (The old panel's `skinOverride` is gone with the two skins.)

const useAmpStore = create((set) => ({
  // { trackId: number, nodeId: number, storeKey: string } | null
  target: null,

  open(trackId, nodeId, storeKey) {
    set({ target: { trackId, nodeId, storeKey } })
  },

  close() {
    set({ target: null })
  },
}))

export default useAmpStore
