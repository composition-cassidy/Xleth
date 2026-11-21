// Simple | Advanced: which Lens panel the user wants, remembered per user.
//
// Advanced only REVEALS more (spec "UI"): nothing the Simple panel shows moves
// or disappears, and nothing is stored in the project. The choice is a viewer
// convenience, so it lives in localStorage (Electron's per-user profile), never
// in the engine. Storage can be blocked or empty; the panel must work without it.

import { create } from 'zustand'

export const LENS_PANEL_MODES = ['simple', 'advanced']
export const LENS_PANEL_MODE_KEY = 'xleth.lens.panelMode'

function read() {
  try {
    const v = window.localStorage.getItem(LENS_PANEL_MODE_KEY)
    return LENS_PANEL_MODES.includes(v) ? v : 'simple'
  } catch {
    return 'simple'
  }
}

const useLensPanelMode = create((set, get) => ({
  mode: read(),
  setMode(mode) {
    if (!LENS_PANEL_MODES.includes(mode) || mode === get().mode) return
    try { window.localStorage.setItem(LENS_PANEL_MODE_KEY, mode) } catch { /* not remembered; still applied */ }
    set({ mode })
  },
}))

export default useLensPanelMode
