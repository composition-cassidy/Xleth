import { create } from 'zustand'

// Carries the one-shot open request for the Sample Sandbox panel.
//
// openPanel(id, props) now exists, and the panels that only needed to pass an
// argument were migrated onto it (see usePanelProps). This store stays because
// its payload is not props: it is a request that is CONSUMED and cleared, with
// a lifetime shorter than the panel's.
//
// `openTarget` is consumed once by SandboxPanelContent (added as a new layer,
// same as a drag-and-drop drop), then cleared — it is a one-shot "please open
// this" request, not a persistent selection.
const useSandboxPanelStore = create((set) => ({
  openTarget: null, // { id, sourceId, name, startTime, endTime, audioFilePath? }

  setOpenTarget: (region) => set({ openTarget: region }),
  clearOpenTarget: () => set({ openTarget: null }),
}))

export default useSandboxPanelStore
