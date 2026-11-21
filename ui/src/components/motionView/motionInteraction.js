// Motion view key area: the pointer grammar's entry point (docs/XLETH_MOTION_VIEW_DESIGN.md 5.4).
//
// MotionKeyCanvas hit-tests every pointerdown (motionDrawing.hitTestKey) and hands
// it here with a context. The key-gesture module (UA2: drag, marquee, double-click
// add, right-click menu, Ctrl+Alt Nudge) replaces the default through
// setMotionPointerHandler; the default only selects:
//   click a key        select it (Shift adds, Ctrl toggles)
//   click empty space  clear the key selection (Shift / Ctrl keep it)
//
// ctx: { hit: { row, key?, summaryTick?, index? } | null, x, y (content px), view,
//        store (useMotionViewStore), data, layout, tick (playhead),
//        canvas: { redraw(), drawOverlay(), host }, runPlan(plan, label), adopt(results),
//        onFocusTrack(trackId) }
// Returns true when it handled the event.

let handler = null

/** Install the key area's pointerdown handler (null = the default). Returns the uninstall function. */
export function setMotionPointerHandler(fn) {
  handler = typeof fn === 'function' ? fn : null
  return () => { if (handler === fn) handler = null }
}

export function selectionMode(e) {
  if (e.ctrlKey || e.metaKey) return 'toggle'
  if (e.shiftKey) return 'add'
  return 'replace'
}

export function defaultPointerDown(e, ctx) {
  if (e.button !== 0) return false
  const { hit, store } = ctx
  if (hit?.row) ctx.onFocusTrack?.(hit.row.trackId)
  if (hit?.key) {
    store.getState().selectKeys([[hit.key.id, hit.key.ref]], selectionMode(e))
    return true
  }
  if (!e.shiftKey && !e.ctrlKey && !e.metaKey) store.getState().clearKeySel()
  return true
}

/** The handler a pointerdown goes to. */
export function motionPointerDown(e, ctx) {
  if (handler) {
    const done = handler(e, ctx)
    if (done) return true
  }
  return defaultPointerDown(e, ctx)
}

// ── Right-click (UA2: the interp / Delete / Copy / Paste / "Nudge this note" menu) ──

let menuHandler = null

/** Install the key area's context-menu handler (null = none). Same ctx as pointerdown. */
export function setMotionContextMenuHandler(fn) {
  menuHandler = typeof fn === 'function' ? fn : null
  return () => { if (menuHandler === fn) menuHandler = null }
}

/** A right-click on the key area: the installed handler, else nothing (the browser menu never shows). */
export function motionContextMenu(e, ctx) {
  e.preventDefault?.()
  if (menuHandler) return !!menuHandler(e, ctx)
  return false
}

// ── Graph mode (UA2: motionGraph.js) ─────────────────────────────────────────

let graphPainter = null

/**
 * Install the graph-mode painter of the KEYS layer: fn(ctx2d, view) draws the
 * selected rows as curves in place of the key rows (R21). While none is installed,
 * graph mode draws the key rows.
 */
export function setMotionGraphPainter(fn) {
  graphPainter = typeof fn === 'function' ? fn : null
  return () => { if (graphPainter === fn) graphPainter = null }
}

export const motionGraphPainter = () => graphPainter
