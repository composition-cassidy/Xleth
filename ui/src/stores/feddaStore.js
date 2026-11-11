import { create } from 'zustand'

// Which Fedda instance is popped out into a floating window (FloatingDevice).
// Parameter reads/writes go directly via window.xleth.audio (generic N-API).

const useFeddaStore = create((set) => ({
  // { trackId: number, nodeId: number, storeKey: string } | null
  target: null,

  open(trackId, nodeId, storeKey) {
    set({ target: { trackId, nodeId, storeKey } })
  },

  close() {
    set({ target: null })
  },
}))

export default useFeddaStore
