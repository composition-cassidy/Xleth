import { create } from 'zustand'

const DEFAULT_CONTEXT = {
  mode: 'sample', // 'sample' (timeline syllable clips) | 'chord' (piano roll notes)
  regionId: null,
  regionName: '',
  syllableCount: 0,
  regionDurationTicks: 0,
  patternId: null,
  cursorTick: 0,
}

const useQuickNotationStore = create((set) => ({
  ...DEFAULT_CONTEXT,
  setContext: (ctx) => set({ ...DEFAULT_CONTEXT, ...ctx }),
  clearContext: () => set(DEFAULT_CONTEXT),
}))

export default useQuickNotationStore
