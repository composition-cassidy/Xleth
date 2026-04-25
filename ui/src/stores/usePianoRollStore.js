import { create } from 'zustand'
import { timelineEvents } from '../timelineEvents.js'

let didInit = false

const usePianoRollStore = create((set, get) => ({
  patternId: null,
  activeCenterTab: 'timeline', // 'timeline' | 'piano-roll'
  detached: false,

  // Wires the four timelineEvents handlers that previously lived in AppInner.
  // Idempotent: repeated calls are no-ops (defends against StrictMode remounts).
  init() {
    if (didInit) return
    didInit = true

    timelineEvents.addEventListener('open-piano-roll', (e) => {
      const pid = e.detail?.patternId ?? null
      set({ patternId: pid })
      // When the Piano Roll is floating, update its pattern but keep the
      // main window's tab on Timeline — don't yank the user away.
      if (pid != null && !get().detached) set({ activeCenterTab: 'piano-roll' })
    })
    timelineEvents.addEventListener('close-piano-roll', () => {
      // "Back to Timeline" — keep patternId, switch tab.
      set({ activeCenterTab: 'timeline' })
    })
    timelineEvents.addEventListener('piano-roll-detach', () => {
      set({ detached: true, activeCenterTab: 'timeline' })
    })
    timelineEvents.addEventListener('piano-roll-dock', () => {
      set({ detached: false, activeCenterTab: 'piano-roll' })
    })
  },

  setPatternId: (id) => set({ patternId: id }),
  setActiveCenterTab: (tab) => set({ activeCenterTab: tab }),
  setDetached: (v) => set({ detached: v }),
}))

export default usePianoRollStore
