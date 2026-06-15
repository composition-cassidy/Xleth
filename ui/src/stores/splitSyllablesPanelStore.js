import { create } from 'zustand'

// Carries the "props" for the Split Syllables floating panel. The windowing
// system's openPanel() only takes a panel id, so dynamic per-open context
// (which region to edit, its source file, the cached source waveform) rides
// through this dedicated store — mirroring samplerPanelStore / quickNotationStore.
const useSplitSyllablesPanelStore = create((set) => ({
  region: null,          // { id, startTime, endTime, syllables, label, name, ... }
  sourceFilePath: null,  // string — source media path for preview playback
  sourceWaveform: null,  // { peaks, duration, stride } for the whole source (sliced in-panel)

  // sourceFilePath / sourceWaveform are optional — the context-menu entry point
  // only knows the region, so the panel resolves the rest from region.sourceId.
  setSplitTarget: ({ region, sourceFilePath = null, sourceWaveform = null }) =>
    set({ region, sourceFilePath, sourceWaveform }),

  clearSplitTarget: () =>
    set({ region: null, sourceFilePath: null, sourceWaveform: null }),
}))

export default useSplitSyllablesPanelStore
