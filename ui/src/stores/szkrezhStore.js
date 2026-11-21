import { create } from 'zustand'

// Minimal store for the Szkrezh pop-out — tracks which effect instance is open.
// Parameter reads/writes go directly via window.xleth.audio (generic N-API).

const useSzkrezhStore = create((set) => ({
  // { trackId: number, nodeId: number, storeKey: string } | null
  target: null,

  open(trackId, nodeId, storeKey) {
    set({ target: { trackId, nodeId, storeKey } })
  },

  close() {
    set({ target: null })
  },
}))

export default useSzkrezhStore
