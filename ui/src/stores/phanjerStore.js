import { create } from 'zustand'

// Minimal store for the Phanjer panel — tracks which effect instance is open.
// Identity-agnostic ({ trackId, nodeId, storeKey }), the same shape every stock
// effect editor store uses so effectEditorOpeners can close it generically.
// Parameter reads/writes go directly via window.xleth.audio (generic N-API).

const usePhanjerStore = create((set) => ({
  // { trackId: number, nodeId: number, storeKey: string } | null
  target: null,

  open(trackId, nodeId, storeKey) {
    set({ target: { trackId, nodeId, storeKey } })
  },

  close() {
    set({ target: null })
  },
}))

export default usePhanjerStore
