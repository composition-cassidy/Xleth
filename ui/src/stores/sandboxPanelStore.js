import { create } from 'zustand'

// Carries the "props" for the Sample Sandbox floating panel. The windowing
// system's openPanel() only takes a panel id, so the region a context-menu
// entry point wants opened rides through this dedicated store — mirroring
// splitSyllablesPanelStore / samplerPanelStore.
//
// `openTarget` is consumed once by SandboxSourcesPanel (added as a new layer,
// same as a drag-and-drop drop), then cleared — it is a one-shot "please open
// this" request, not a persistent selection.
const useSandboxPanelStore = create((set) => ({
  openTarget: null, // { id, sourceId, name, startTime, endTime, audioFilePath? }

  setOpenTarget: (region) => set({ openTarget: region }),
  clearOpenTarget: () => set({ openTarget: null }),
}))

export default useSandboxPanelStore
