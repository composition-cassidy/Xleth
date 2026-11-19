/**
 * undoGroup — a gesture that takes several engine calls is ONE undo entry.
 *
 * The engine collects whatever is recorded between undo.beginGroup and
 * undo.endGroup into a single history entry (UndoManager groups), so Ctrl+Z
 * always pops exactly one entry and Ctrl+Y replays exactly one.
 *
 * This replaced a count kept in the renderer ("the last gesture pushed N
 * entries, so pop N"). A count could not survive an edit made afterwards,
 * could not be told about edits made in other panels, and could not undo a
 * gesture larger than the engine's 100-entry history at all: pitch-shifting
 * 150 clips left 50 of them shifted for good.
 *
 * Three properties the wrapper guarantees:
 *
 *   • `fn` starts synchronously. beginGroup is not awaited first: calls reach
 *     the engine in the order they are sent, so it is processed before the
 *     gesture's own calls either way, and awaiting it would add a round trip
 *     of latency to every gesture (and break callers that must read event data
 *     before their first await).
 *   • The group is closed however `fn` ends, including by throwing.
 *   • Nesting joins. Engine groups do not nest (a second beginGroup commits the
 *     first), so a gesture started while one is already open here runs inside
 *     that group instead of opening its own, and the group closes when the
 *     last of them finishes.
 *
 * An engine that predates groups answers beginGroup with no token; the
 * gesture's calls are then recorded one by one, as they were before.
 */
export function createUndoGrouper({ beginGroup, endGroup } = {}) {
  const state = { depth: 0, opening: null }

  const settle = (call) => {
    try {
      return Promise.resolve(call()).catch(() => null)
    } catch {
      return Promise.resolve(null)
    }
  }

  return async function withUndoGroup(label, fn) {
    if (state.depth === 0) state.opening = settle(() => beginGroup?.(label))
    state.depth++
    const opening = state.opening
    try {
      return await fn()
    } finally {
      state.depth--
      if (state.depth === 0) {
        const token = await opening
        if (token) await settle(() => endGroup?.(token))
      }
    }
  }
}

// ── The app's ONE shared grouper ─────────────────────────────────────────────
// Engine groups do not nest: a second beginGroup commits the first. So every
// view that opens groups (the Edit view's TimelineView, Motion view's
// runMotionPlan) must go through the SAME grouper, or a gesture in one view
// would close the other's group half-way. Created on first use; it reads
// window.xleth.undo at call time, so a test (or a late preload) can swap it.

let sharedGrouper = null

/** The shared grouper (created lazily over window.xleth.undo.beginGroup / endGroup). */
export function sharedUndoGrouper() {
  if (!sharedGrouper) {
    sharedGrouper = createUndoGrouper({
      beginGroup: (label) => window.xleth?.undo?.beginGroup?.(label),
      endGroup: (token) => window.xleth?.undo?.endGroup?.(token),
    })
  }
  return sharedGrouper
}

/**
 * Run a gesture of several engine calls as ONE undo entry, through the shared
 * grouper (same guarantees as createUndoGrouper: `fn` starts synchronously, the
 * group closes however `fn` ends, a nested or overlapping gesture joins the open
 * group).
 */
export function withSharedUndoGroup(label, fn) {
  return sharedUndoGrouper()(label, fn)
}

/** Test seam: forget the shared grouper (its nesting depth goes with it). */
export function resetSharedUndoGrouper() {
  sharedGrouper = null
}
