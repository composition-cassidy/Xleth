import { create } from 'zustand'

// ─── Global UI scale (Phase 7) ────────────────────────────────────────────────
// The UI scale is the Electron window zoom factor: real Chromium zoom, so hit-testing and
// text stay correct (never a CSS transform on the root). The main process owns the value
// (electron-main main.js: 100-200 % in 10 % steps, persisted as settings `uiScale`) and
// tells every renderer when it changes, whoever changed it: this store is only a mirror.
//
//   Settings > Appearance slider  -> setPercent -> window.setZoom
//   Zoom In / Zoom Out / Reset    -> window.zoomIn / zoomOut / resetZoom (menu + shortcuts)
//   all of them                   -> main -> 'xleth:window:zoomChanged' -> this store
//
// Debug logs use the [Theme] prefix.

export const UI_SCALE_MIN = 100
export const UI_SCALE_MAX = 200
export const UI_SCALE_STEP = 10
export const UI_SCALE_DEFAULT = 100

/** Snap any percent (or garbage) onto the 10 % grid inside 100-200. */
export function clampUiScalePercent(value) {
  const n = Number(value)
  if (!Number.isFinite(n)) return UI_SCALE_DEFAULT
  const snapped = Math.round(n / UI_SCALE_STEP) * UI_SCALE_STEP
  return Math.min(UI_SCALE_MAX, Math.max(UI_SCALE_MIN, snapped))
}

const percentFromFactor = (factor) => clampUiScalePercent(Number(factor) * 100)

let unsubscribe = null

export const useUiScaleStore = create((set, get) => ({
  percent: UI_SCALE_DEFAULT,
  hydrated: false,

  /** Read the live value and follow changes. Safe to call more than once and without the bridge. */
  hydrate() {
    const win = typeof window !== 'undefined' ? window.xleth?.window : null
    if (unsubscribe) { unsubscribe(); unsubscribe = null }
    if (!win) { set({ hydrated: true }); return }
    unsubscribe = win.onZoomChanged?.((factor) => {
      const percent = percentFromFactor(factor)
      set({ percent, hydrated: true })
    }) ?? null
    Promise.resolve(win.getZoom?.())
      .then((factor) => set({ percent: percentFromFactor(factor), hydrated: true }))
      .catch(() => set({ hydrated: true }))
  },

  /** Ask main for an absolute scale; the change comes back through onZoomChanged. */
  setPercent(percent) {
    const next = clampUiScalePercent(percent)
    set({ percent: next })
    window.xleth?.window?.setZoom?.(next / 100)
  },

  reset() {
    get().setPercent(UI_SCALE_DEFAULT)
  },
}))
