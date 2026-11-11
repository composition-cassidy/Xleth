import { create } from 'zustand'
import { timelineEvents } from '../timelineEvents.js'
import { usePanelRegistry } from '../windowing/registry/PanelRegistry'

let didInit = false

const usePianoRollStore = create((set, get) => ({
  patternId: null,
  // The last pattern that was open in the Piano Roll this session. Kept when the Piano Roll
  // is closed (patternId goes null), so reopening its tab shows that pattern again instead
  // of an empty dock (windowing/panels/dockTabFallback.ts). Session only: pattern ids
  // belong to a project, so this is never persisted.
  lastPatternId: null,
  activeCenterTab: 'timeline', // 'timeline' | 'piano-roll'
  detached: false,

  // Wires the four timelineEvents handlers that previously lived in AppInner.
  // Idempotent: repeated calls are no-ops (defends against StrictMode remounts).
  init() {
    if (didInit) return
    didInit = true

    timelineEvents.addEventListener('open-piano-roll', (e) => {
      const pid = e.detail?.patternId ?? null
      const registry = usePanelRegistry.getState()
      const panel = registry.panels.pianoRoll
      const shouldOpenFloating = get().detached || (!panel.hidden && panel.mode === 'floating')

      if (pid != null) {
        if (panel.hidden) {
          if (shouldOpenFloating) registry.openPanel('pianoRoll')
          else registry.dockPanel('pianoRoll', 'bottom')
        } else if (panel.mode !== 'floating') {
          registry.focusPanel('pianoRoll')
        }
      }

      const nextPanel = usePanelRegistry.getState().panels.pianoRoll
      const floating = !nextPanel.hidden && nextPanel.mode === 'floating'

      set(pid != null ? { patternId: pid, lastPatternId: pid, detached: floating } : { patternId: pid, detached: floating })
      // When the Piano Roll is floating, update its pattern but keep the
      // main window's tab on Timeline — don't yank the user away.
      if (pid != null) set({ activeCenterTab: floating ? 'timeline' : 'piano-roll' })
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

    // Scenario B: panel hidden via F7/togglePanel (keepAliveWhenHidden — panel
    // stays mounted so handleClose never fires). Reset activeCenterTab so the
    // TimelineView gate at TimelineView.jsx:1791 doesn't stay blocked.
    // TODO: remove when central keyboard router replaces activeCenterTab —
    // trigger: when unified keyboard-focus router lands and TimelineView.jsx:1791
    // no longer gates on activeCenterTab.
    usePanelRegistry.subscribe(
      (state) => state.panels.pianoRoll.hidden,
      (hidden) => { if (hidden) set({ activeCenterTab: 'timeline' }) }
    )
  },

  setPatternId: (id) => set(id != null ? { patternId: id, lastPatternId: id } : { patternId: id }),
  setActiveCenterTab: (tab) => set({ activeCenterTab: tab }),
  setDetached: (v) => set({ detached: v }),
}))

export default usePianoRollStore
