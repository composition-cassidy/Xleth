import { create } from 'zustand'

// ── FX chain drag + clipboard ────────────────────────────────────────────────
// Two pieces of session-only mixer state, neither of which belongs in
// effectChainStore (that one mirrors the engine; nothing here crosses the
// bridge or survives a reload).
//
// ── The drag is STICKY ──
// Press and hold "Save FX Chain" in a strip's context menu and the chain
// detaches onto the cursor. The gesture that motivates this is "put Track 1's
// effects on Track 2 AND Track 3": a normal press-drag-release can only ever
// end on one strip, so a drop here does NOT end the drag. Click as many strips
// as you like, then Escape (or a right-click, or a click on empty space) to put
// it down. `drops` counts what has been applied so the UI can say so.
//
// Pointer-based rather than HTML5 drag-and-drop, for the same reason
// samplerModDragStore is: the source lives in a menu portaled to <body> while
// the drop targets are strips inside the mixer panel, and a window-level
// pointermove needs no dataTransfer round trip across that boundary.

const useFxChainDragStore = create((set, get) => ({
  // ── Open context menu ──
  // Which strip was right-clicked and where. Held here rather than in each
  // strip so only ONE menu can be open at a time and a single layer component
  // owns the menu, the save dialog, the drag ghost and the toasts — strips just
  // report the click.
  menu: null,               // { fxKey, x, y } | null

  openMenu: (fxKey, x, y) => set({ menu: { fxKey: String(fxKey), x, y } }),
  closeMenu: () => set({ menu: null }),

  // ── Sticky drag ──
  // The effects array being carried, or null when idle.
  effects: null,
  // fxKey the chain came from — that strip is the source, not a drop target.
  sourceKey: null,
  sourceLabel: '',
  // Pointer position, for the floating ghost.
  x: 0,
  y: 0,
  // fxKey of the strip under the pointer, or null.
  hoverKey: null,
  // How many strips this drag has been dropped on so far.
  drops: 0,

  // Starting a drag always closes the menu it was started from — the chain is
  // on the cursor now, and a menu still hanging there would cover the strips
  // the user is aiming at.
  begin: (sourceKey, sourceLabel, effects, x, y) => set({
    menu: null,
    effects: Array.isArray(effects) ? effects : [],
    sourceKey: String(sourceKey),
    sourceLabel: sourceLabel ?? '',
    x, y,
    hoverKey: null,
    drops: 0,
  }),

  move: (x, y, hoverKey) => set({ x, y, hoverKey: hoverKey ?? null }),

  // Record a drop. Returns false when the target is not a legal one, so the
  // caller can skip the engine call without duplicating the rule.
  countDrop: (targetKey) => {
    const state = get()
    if (!state.effects) return false
    if (String(targetKey) === state.sourceKey) return false
    set({ drops: state.drops + 1 })
    return true
  },

  end: () => set({
    effects: null, sourceKey: null, sourceLabel: '',
    hoverKey: null, drops: 0,
  }),

  // ── Copy / paste ──
  // The keyboard route to the same thing the drag does. Survives menu closes and
  // strip selection, but not a reload — a chain worth keeping belongs in the
  // library, not the clipboard.
  clipboard: null,          // { effects, sourceLabel } | null

  copyChain: (sourceLabel, effects) => set({
    clipboard: { effects: Array.isArray(effects) ? effects : [], sourceLabel: sourceLabel ?? '' },
  }),

  clearClipboard: () => set({ clipboard: null }),
}))

export default useFxChainDragStore
