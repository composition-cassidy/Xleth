import { create } from 'zustand'

// Minimal store for the Amp Stack panel — tracks which effect instance is open.
// Parameter reads/writes go directly via window.xleth.audio (generic N-API).
//
// `skinOverride` is panel-local UI state, NOT an engine parameter: spec §8 says
// the skin follows the model side (vintage models -> ANALOG, modern -> MODERN)
// with a header toggle that overrides it. Nothing here is persisted — reopening
// an instance re-derives the skin from its Model.

const useAmpStore = create((set) => ({
  // { trackId: number, nodeId: number, storeKey: string } | null
  target: null,

  // null = follow the model; 'analog' | 'modern' = user override
  skinOverride: null,

  open(trackId, nodeId, storeKey) {
    set({ target: { trackId, nodeId, storeKey }, skinOverride: null })
  },

  setSkinOverride(skin) {
    set({ skinOverride: skin })
  },

  close() {
    set({ target: null, skinOverride: null })
  },
}))

export default useAmpStore
