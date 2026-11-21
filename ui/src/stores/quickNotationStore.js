import { create } from 'zustand'

const DEFAULT_CONTEXT = {
  mode: 'sample', // 'sample' (timeline syllable clips) | 'chord' (piano roll notes)
  regionId: null,
  regionName: '',
  syllableCount: 0,
  regionDurationTicks: 0,
  patternId: null,
  cursorTick: 0,
  // Sample mode: what the panel needs to audition the notation and tune each
  // syllable's 32nd offset. `region` is a snapshot (times in seconds);
  // `syllables` is the region's saved syllable list, including each one's
  // `quickOffsetPercent` (a percentage of that syllable's own length).
  region: null,
  syllables: [],
}

const useQuickNotationStore = create((set) => ({
  ...DEFAULT_CONTEXT,
  setContext: (ctx) => set({ ...DEFAULT_CONTEXT, ...ctx }),
  setSyllables: (syllables) => set({ syllables }),
  clearContext: () => set(DEFAULT_CONTEXT),
}))

export default useQuickNotationStore
