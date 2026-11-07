import { create } from 'zustand'

// How this user looks at the mixer. Renderer-only: nothing here reaches the
// engine or the project file. Persisted in localStorage (a per-viewer
// convenience), never required: every read and write is guarded.

export const STRIP_WIDTH_KEY = 'xleth.mixer.stripWidth'
export const STRIP_WIDTHS = { normal: 84, compact: 68 }

export function readStripWidthMode() {
  try {
    const v = localStorage.getItem(STRIP_WIDTH_KEY)
    return v === 'compact' ? 'compact' : 'normal'
  } catch {
    return 'normal'
  }
}

const useMixerUiStore = create((set) => ({
  stripWidthMode: readStripWidthMode(),
  setStripWidthMode: (mode) => {
    const next = mode === 'compact' ? 'compact' : 'normal'
    try { localStorage.setItem(STRIP_WIDTH_KEY, next) } catch { /* session only */ }
    set({ stripWidthMode: next })
  },
}))

export default useMixerUiStore
