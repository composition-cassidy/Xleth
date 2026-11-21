// Motion view keyboard (docs/XLETH_MOTION_VIEW_DESIGN.md R20): what Delete /
// Backspace, Ctrl+C / X / V, Ctrl+A, Left / Right (Shift = 1/4 step) and Escape
// do while Motion view is shown. TimelineView routes these commands (timelineKeymap
// ids 'delete' | 'copy' | 'cut' | 'paste' | 'selectAll' | 'nudge' | 'escape') to
// MotionView's handle, which calls runMotionKeyCommand. A command CLAIMS the key
// only when it acts (returns true); otherwise the key goes on to whoever else binds it.
//
// UA1 implements Escape (cancel the gesture, else clear the key selection) and
// Ctrl+A (every key of the expanded rows). The key-editing actions (delete, copy,
// cut, paste, nudge) are registered by the key-gesture module (UA2) through
// registerMotionKeyAction; until then they leave the key unclaimed.
//
// ctx: { store (useMotionViewStore), layout, data, tick (playhead), snapGranularity,
//        runPlan(plan, label) -> Promise, adopt(results), hint(text) }

import { keysInExpandedRows } from '../../motion/rowRegistry.js'

const actions = new Map()

/**
 * Register the action of one command id. fn(command, ctx) -> boolean (claimed).
 * Returns the unregister function. A later registration replaces the earlier one.
 */
export function registerMotionKeyAction(id, fn) {
  actions.set(id, fn)
  return () => { if (actions.get(id) === fn) actions.delete(id) }
}

/** The command ids a Motion view handles (TimelineView routes exactly these). */
export const MOTION_KEY_COMMANDS = Object.freeze(['delete', 'copy', 'cut', 'paste', 'selectAll', 'nudge', 'escape'])

function escape(command, ctx) {
  return ctx.store.getState().escape() !== null
}

function selectAll(command, ctx) {
  const keys = keysInExpandedRows(ctx.layout, ctx.data)
  if (keys.length === 0) {
    ctx.hint?.('Ctrl+A selects the keys of open rows: open a property first')
    return true
  }
  ctx.store.getState().selectKeys(keys.map((k) => [k.id, k.ref]), 'replace')
  return true
}

const BUILT_IN = { escape, selectAll }

/** Run one routed command; true = it acted and claims the key. */
export function runMotionKeyCommand(command, ctx) {
  const id = command?.id
  if (!MOTION_KEY_COMMANDS.includes(id)) return false
  const fn = actions.get(id) ?? BUILT_IN[id]
  if (!fn) return false
  try {
    return fn(command, ctx) === true
  } catch (err) {
    console.error(`[MotionView] key command ${id} failed:`, err?.message ?? err)
    return false
  }
}
