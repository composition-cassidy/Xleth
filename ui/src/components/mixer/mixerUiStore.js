import { create } from 'zustand'

// How this user looks at the mixer. Renderer-only: nothing here reaches the
// engine or the project file. Persisted in localStorage (a per-viewer
// convenience), never required: every read and write is guarded.

export const STRIP_WIDTH_KEY = 'xleth.mixer.stripWidth'
// Compact is 72, not 68: a strip holds three state toggles (M / S / V) side by side
// and each needs a 24px hit area (ui/DESIGN.md 1, 10). It is the default since round 3.
export const STRIP_WIDTHS = { normal: 84, compact: 72 }
export const DEFAULT_STRIP_WIDTH_MODE = 'compact'

/** A stored 'normal' or 'compact' is the user's choice and is kept; only an unset key takes the default. */
export function readStripWidthMode() {
  try {
    const v = localStorage.getItem(STRIP_WIDTH_KEY)
    return v === 'compact' || v === 'normal' ? v : DEFAULT_STRIP_WIDTH_MODE
  } catch {
    return DEFAULT_STRIP_WIDTH_MODE
  }
}

/** Whether the loudness dock is open while metering is off (it is always open while metering is on). */
export const LOUDNESS_DOCK_OPEN_KEY = 'xleth.mixer.loudnessDockOpen'

export function readLoudnessDockOpen() {
  try {
    return localStorage.getItem(LOUDNESS_DOCK_OPEN_KEY) === '1'
  } catch {
    return false
  }
}

/** Whether the strips list their inserts by name. Closed unless the user opened it. */
export const INSERTS_OPEN_KEY = 'xleth.mixer.insertsOpen'

export function readInsertsOpen() {
  try {
    return localStorage.getItem(INSERTS_OPEN_KEY) === '1'
  } catch {
    return false
  }
}

const useMixerUiStore = create((set) => ({
  insertsOpen: readInsertsOpen(),
  setInsertsOpen: (open) => {
    const next = !!open
    try { localStorage.setItem(INSERTS_OPEN_KEY, next ? '1' : '0') } catch { /* session only */ }
    set({ insertsOpen: next })
  },
  stripWidthMode: readStripWidthMode(),
  setStripWidthMode: (mode) => {
    const next = mode === 'normal' ? 'normal' : 'compact'
    try { localStorage.setItem(STRIP_WIDTH_KEY, next) } catch { /* session only */ }
    set({ stripWidthMode: next })
  },
  loudnessDockOpen: readLoudnessDockOpen(),
  setLoudnessDockOpen: (open) => {
    const next = !!open
    try { localStorage.setItem(LOUDNESS_DOCK_OPEN_KEY, next ? '1' : '0') } catch { /* session only */ }
    set({ loudnessDockOpen: next })
  },
}))

export default useMixerUiStore
