import { create } from 'zustand'

const useWorldProcessingStore = create((set) => ({
  worldProcessingClips: new Set(),
  addProcessingClip: (id) =>
    set(s => ({ worldProcessingClips: new Set([...s.worldProcessingClips, id]) })),
  removeProcessingClip: (id) =>
    set(s => {
      const next = new Set(s.worldProcessingClips)
      next.delete(id)
      return { worldProcessingClips: next }
    }),
}))

export default useWorldProcessingStore
