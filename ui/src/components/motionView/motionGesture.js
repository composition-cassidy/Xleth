// Motion view key gestures, menus and key commands (docs/XLETH_MOTION_VIEW_DESIGN.md
// 5.4, R5, R20, R21, R23). installMotionEditing() plugs them into the hooks UA1 left
// (motionInteraction: pointer / context menu / graph painter; motionKeyCommands:
// delete, copy, cut, paste, nudge) and returns the uninstall function.
//
// Pointer grammar, key rows:
//   click a key            select it (Shift adds, Ctrl toggles); a plain click on a key
//                          of a multi-selection keeps the selection for a drag and
//                          narrows to that key on release without a move
//   drag a selected key    move every selected key in time (snapped: motionSnap; Alt =
//                          free); note-relative keys keep their anchor (5.4)
//   Ctrl+Alt + drag a hollow key   a Nudge key on THAT note only (R5)
//   click a summary key    select every key behind it at that tick (and drag them)
//   drag on empty space    marquee across rows and tracks (Shift adds, Ctrl toggles)
//   double-click empty space on an animated row   a key there with the curve's value
//   right-click            the key menu (motionKeyMenu.js)
// Graph mode: the same, plus keys move in value too (Shift = fine) and the handles
// of a selected Bezier key are dragged.
//
// The contract of every gesture: a local draft in motionViewStore (keyTicks /
// keyValues / bez / marquee / snapTick) repainted by the canvas, NO IPC while the
// pointer moves, ONE runMotionPlan on pointerup (one undo step across tracks),
// Escape cancels (the window capture listener eats that Escape so the router does
// not also clear the selection).

import { dragBezierHandle } from '../../lensRoam/lensKeyModel.js'
import { trackIdOfRowKey } from '../../motion/motionViewStore.js'
import { refTarget } from '../../motion/rowRegistry.js'
import {
  MOVE_MERGE_HINT, addKeyAtPlan, bezierPlan, buildKeyIndex, clampMoveDelta, deleteKeysPlan, interpPlan, isNoteRef,
  keyIdAfter, keysInRect, moveSelection, movePlan, nudgeNoteMove, nudgeNotePlan, nudgeNotePos, nudgeSelection,
  selectedInstances, selectionAfterMove, summaryKeysAt,
} from '../../motion/motionGestureModel.js'
import { buildSnapIndex, gridStepTicks, snapMotionTick, snapNotePos } from '../../motion/motionSnap.js'
import { clipboardSummary, copyKeys, cutKeys, pasteKeysPlan } from '../../motion/motionClipboard.js'
import { selectionMode, setMotionContextMenuHandler, setMotionGraphPainter, setMotionPointerHandler } from './motionInteraction.js'
import { registerMotionKeyAction } from './motionKeyCommands.js'
import { drawGraphLayer, curveValueAtY, curveYOfValue, graphCurvesOf, hitTestGraph, keysInGraphRect } from './motionGraph.js'
import { tickToX, xToTick } from './motionDrawing.js'
import { keyMenuItems } from './motionKeyMenu.js'

export const DRAG_SLOP_PX = 3
export const DOUBLE_CLICK_MS = 400
const DOUBLE_CLICK_PX = 4

// ── Frame scheduling (test seam) ─────────────────────────────────────────────

let schedule = (fn) => (typeof requestAnimationFrame === 'function' ? requestAnimationFrame(fn) : setTimeout(fn, 16))
let unschedule = (id) => (typeof cancelAnimationFrame === 'function' ? cancelAnimationFrame(id) : clearTimeout(id))

/** Test seam: run draft updates through `fn` (e.g. (cb) => cb() for synchronous drafts). Null restores. */
export function setGestureFrameScheduler(fn, cancel = () => {}) {
  if (typeof fn === 'function') { schedule = fn; unschedule = cancel } else {
    schedule = (cb) => (typeof requestAnimationFrame === 'function' ? requestAnimationFrame(cb) : setTimeout(cb, 16))
    unschedule = (id) => (typeof cancelAnimationFrame === 'function' ? cancelAnimationFrame(id) : clearTimeout(id))
  }
}

// ── Shared helpers ───────────────────────────────────────────────────────────

const viewOf = (ctx) => ctx.canvas?.view?.() ?? ctx.view
const ticksPerPx = (v) => xToTick(1, 0, v.ppb) - xToTick(0, 0, v.ppb)

/** Pointer position in the key area: x, content y (with the scroll) and canvas y. */
function pointOf(ctx, e) {
  const host = ctx.canvas?.host
  const r = host?.getBoundingClientRect?.() ?? { left: 0, top: 0 }
  const scrollTop = ctx.canvas?.scroller?.scrollTop ?? viewOf(ctx)?.scrollTop ?? 0
  const cy = e.clientY - r.top
  return { x: e.clientX - r.left, y: cy + scrollTop, cy }
}

/** The one track selected in Motion view (R23 paste target), or null. */
export function singleSelectedTrack(selectedRows) {
  const ids = new Set()
  for (const key of selectedRows ?? []) {
    const id = trackIdOfRowKey(key)
    if (id !== null) ids.add(id)
  }
  return ids.size === 1 ? [...ids][0] : null
}

let active = null   // the gesture in progress: { cancel() }

/** Is a gesture in progress? */
export const gestureActive = () => active !== null

/**
 * Window listeners of one gesture. handlers: { move(p, e), up(p, e), cancel() }.
 * A draft set by this gesture that disappears from the store (Escape routed through
 * the keyboard router -> store.escape()) cancels it too.
 */
function track(ctx, handlers) {
  active?.cancel()
  const store = ctx.store
  let done = false
  let frame = null
  let pending = null
  let ownDraft = null
  const finish = () => {
    if (done) return
    done = true
    if (frame !== null) { unschedule(frame); frame = null }
    window.removeEventListener('pointermove', onMove, true)
    window.removeEventListener('pointerup', onUp, true)
    window.removeEventListener('pointercancel', onCancel, true)
    window.removeEventListener('keydown', onKey, true)
    unsub?.()
    if (active === api) active = null
  }
  const setDraft = (d) => {
    pending = d
    if (frame !== null) return
    let ran = false
    const id = schedule(() => {
      ran = true
      frame = null
      if (done || pending === null) return
      ownDraft = pending
      store.getState().setDraft(pending)
    })
    // A scheduler that ran the callback at once leaves no frame pending.
    if (!ran) frame = id
  }
  const dropDraft = () => {
    pending = null
    if (ownDraft && store.getState().draft === ownDraft) store.getState().clearDraft()
    ownDraft = null
  }
  const cancel = () => {
    if (done) return
    dropDraft()
    finish()
    handlers.cancel?.()
  }
  const onMove = (e) => handlers.move(pointOf(ctx, e), e, setDraft)
  // The final draft stays on screen until the commit lands (then one more frame, so
  // React has rendered the adopted post-state): a moved key never flashes back.
  const holdDraft = (d) => {
    pending = null
    ownDraft = d
    store.getState().setDraft(d)
  }
  const onUp = (e) => {
    if (done) return
    if (frame !== null) { unschedule(frame); frame = null }
    finish()
    const res = handlers.up(pointOf(ctx, e), e, holdDraft)
    if (res && typeof res.then === 'function') {
      const later = () => { schedule(dropDraft) }
      res.then(later, later)
    } else dropDraft()
  }
  const onCancel = () => cancel()
  const onKey = (e) => {
    if (e.key !== 'Escape') return
    e.preventDefault()
    e.stopPropagation()
    cancel()
  }
  const unsub = store.subscribe?.((s, prev) => {
    if (ownDraft && prev.draft === ownDraft && s.draft !== ownDraft) { ownDraft = null; cancel() }
  })
  window.addEventListener('pointermove', onMove, true)
  window.addEventListener('pointerup', onUp, true)
  window.addEventListener('pointercancel', onCancel, true)
  window.addEventListener('keydown', onKey, true)
  const api = { cancel }
  active = api
  return api
}

async function commit(ctx, plan, label) {
  if (!Array.isArray(plan) || plan.length === 0) return null
  return ctx.runPlan(plan, label)
}

// ── Move (time; time and value in the graph); Nudge this note (Ctrl+Alt) ────

function beginMove(e, ctx, { primary, selected, collapseTo = null, nudgeNote = false }) {
  const store = ctx.store
  const data = ctx.data
  const index = buildKeyIndex(ctx.layout, data)
  const v0 = viewOf(ctx)
  const graph = !!store.getState().graph
  const x0 = ctx.x
  const cy0 = ctx.y - (v0.scrollTop ?? 0)
  const tick0 = xToTick(x0, v0.scrollOffset, v0.ppb)
  const sel = nudgeNote ? [primary] : selected
  const moving = new Set()
  for (const inst of sel) for (const i of index.byTarget.get(refTarget(inst.ref)) ?? [inst]) moving.add(i.id)
  const snapIndex = buildSnapIndex({
    data, trackIds: [primary.ref.trackId], layout: graph ? null : ctx.layout, scrollTop: v0.scrollTop, height: v0.h, excludeIds: moving,
  })
  const step = gridStepTicks(ctx.snapGranularity)
  let moved = false
  // Graph mode moves keys in value AND time: time (and its snapping) only once the
  // pointer has gone sideways past the slop, so a straight vertical drag changes the
  // value alone and never re-snaps an off-grid key.
  let timeMoved = !graph
  let lastGood = null   // the last move that merges no keys (what a refused move holds)
  let mergeHinted = false

  const compute = (p, ev) => {
    const v = viewOf(ctx)
    if (!timeMoved && Math.abs(p.x - x0) >= DRAG_SLOP_PX) timeMoved = true
    const free = nudgeNote ? false : !!ev.altKey
    const snapNote = timeMoved ? (span, anchor, t) => snapNotePos(span, anchor, t, { step, alt: free }) : null
    let delta = timeMoved ? xToTick(p.x, v.scrollOffset, v.ppb) - tick0 : 0
    let snapTick
    if (timeMoved && !isNoteRef(primary.ref)) {
      const s = snapMotionTick(primary.tick + delta, { modifiers: { alt: free }, granularity: ctx.snapGranularity, candidates: snapIndex, ticksPerPx: ticksPerPx(v) })
      delta = s.tick - primary.tick
      if (s.kind !== 'free') snapTick = s.tick
    }
    delta = clampMoveDelta(sel, delta, { data, index: nudgeNote ? null : index, primary })
    let newValue = null
    if (graph) {
      const dy = (p.cy - cy0) * (ev.shiftKey ? 0.25 : 1)
      const byRow = new Map(graphCurvesOf(v).map((c) => [c.rowKey, c]))
      newValue = (rep) => {
        const c = byRow.get(rep.rowKey)
        return c ? curveValueAtY(v, c, curveYOfValue(v, c, rep.value) + dy) : undefined
      }
    }
    if (nudgeNote) {
      // A Nudge key on THIS note: placed from this instance (chord notes share its id).
      const nm = nudgeNoteMove(data, primary, delta, { snapNote })
      const value = newValue ? newValue(primary) : undefined
      return {
        edits: [],
        keyTicks: new Map([[primary.id, nm.tick]]),
        keyValues: Number.isFinite(value) ? new Map([[primary.id, value]]) : new Map(),
        nudge: nm,
        snapTick: timeMoved ? nm.tick : undefined,
      }
    }
    let r = moveSelection(data, index, sel, delta, { primary, snapNote, newValue })
    if (r.blocked) {
      if (!mergeHinted) { mergeHinted = true; ctx.hint?.(MOVE_MERGE_HINT) }
      return lastGood ?? { ...moveSelection(data, index, sel, 0, { primary }), snapTick: undefined }
    }
    if (isNoteRef(primary.ref) && !free && timeMoved) snapTick = r.keyTicks.get(primary.id)
    r = { ...r, snapTick }
    lastGood = r
    return r
  }

  track(ctx, {
    move(p, ev, setDraft) {
      if (!moved && Math.abs(p.x - x0) < DRAG_SLOP_PX && (!graph || Math.abs(p.cy - cy0) < DRAG_SLOP_PX)) return
      moved = true
      const r = compute(p, ev)
      setDraft({ kind: nudgeNote ? 'nudgeNote' : 'move', keyTicks: r.keyTicks, keyValues: r.keyValues, keyPos: r.keyPos, snapTick: r.snapTick })
    },
    up(p, ev, holdDraft) {
      const s = store.getState()
      if (!moved) {
        if (nudgeNote) {
          // Ctrl+Alt+click: the Nudge key at the hollow key's own place.
          const pos = nudgeNotePos(data, primary)
          s.selectKeys([keyIdAfter({ ...primary, ref: { ...primary.ref, kind: 'note', mode: 'Nudge' } }, pos)], 'replace')
          return commit(ctx, nudgeNotePlan(data, primary), 'Nudge this note')
        } else if (collapseTo) s.selectKeys([[collapseTo.id, collapseTo.ref]], 'replace')
        return
      }
      const r = compute(p, ev)
      holdDraft({ kind: nudgeNote ? 'nudgeNote' : 'move', keyTicks: r.keyTicks, keyValues: r.keyValues, keyPos: r.keyPos })
      if (nudgeNote) {
        const { tick, pos } = r.nudge
        const desired = graph ? r.keyValues.get(primary.id) : undefined
        const plan = nudgeNotePlan(data, primary, { tick, pos, desired })
        s.selectKeys([keyIdAfter({ ...primary, ref: { ...primary.ref, kind: 'note', mode: 'Nudge' } }, pos)], 'replace')
        return commit(ctx, plan, 'Nudge this note')
      }
      const plan = movePlan(data, r)
      if (plan.length === 0) return null
      s.selectKeys(selectionAfterMove(sel, r.edits), 'replace')
      return commit(ctx, plan, graph ? 'Edit keys' : (sel.length > 1 ? 'Move keys' : 'Move key'))
    },
  })
}

// ── Bezier handle (graph) ────────────────────────────────────────────────────

function beginHandle(e, ctx, hit) {
  const data = ctx.data
  const index = buildKeyIndex(ctx.layout, data)
  const twins = index.byTarget.get(refTarget(hit.inst.ref)) ?? [hit.inst]
  let bez = null
  const compute = (p) => {
    const v = viewOf(ctx)
    const toX = (k) => tickToX(k.tick, v.scrollOffset, v.ppb)
    const fromY = (y) => curveValueAtY(v, hit.curve, y)
    return dragBezierHandle(hit.A, hit.B, hit.which, p.x, p.cy, toX, fromY)
  }
  track(ctx, {
    move(p, ev, setDraft) {
      bez = compute(p)
      setDraft({ kind: 'bez', bez: new Map(twins.map((k) => [k.id, bez])) })
    },
    up(p, ev, holdDraft) {
      if (!bez) return null
      bez = compute(p)
      holdDraft({ kind: 'bez', bez: new Map(twins.map((k) => [k.id, bez])) })
      return commit(ctx, bezierPlan(data, hit.inst, bez), 'Shape curve')
    },
  })
}

// ── Marquee ──────────────────────────────────────────────────────────────────

function beginMarquee(e, ctx, mode, { onClick } = {}) {
  const store = ctx.store
  const graph = !!store.getState().graph
  const x0 = ctx.x
  const y0 = ctx.y
  let moved = false
  const rectTo = (p) => ({ x0, y0, x1: p.x, y1: p.y })
  track(ctx, {
    move(p, ev, setDraft) {
      if (!moved && Math.abs(p.x - x0) < DRAG_SLOP_PX && Math.abs(p.y - y0) < DRAG_SLOP_PX) return
      moved = true
      setDraft({ kind: 'marquee', marquee: rectTo(p) })
    },
    up(p) {
      const s = store.getState()
      if (!moved) { onClick?.(); return }
      const v = viewOf(ctx)
      const rect = rectTo(p)
      const keys = graph
        ? keysInGraphRect(v, { x0: rect.x0, x1: rect.x1, y0: rect.y0 - v.scrollTop, y1: rect.y1 - v.scrollTop })
        : keysInRect(ctx.layout, ctx.data, rect, (x) => xToTick(x, v.scrollOffset, v.ppb))
      s.selectKeys(keys.map((k) => [k.id, k.ref]), mode)
    },
  })
}

// ── Double-click: a key with the curve's value ───────────────────────────────

let lastEmpty = null

function isDoubleClick(e, ctx, rowKey) {
  const now = typeof performance !== 'undefined' ? performance.now() : Date.now()
  const prev = lastEmpty
  lastEmpty = { t: now, x: ctx.x, y: ctx.y, rowKey }
  if ((e.detail ?? 0) >= 2) { lastEmpty = null; return true }
  if (prev && now - prev.t <= DOUBLE_CLICK_MS && prev.rowKey === rowKey
    && Math.abs(prev.x - ctx.x) <= DOUBLE_CLICK_PX && Math.abs(prev.y - ctx.y) <= DOUBLE_CLICK_PX) {
    lastEmpty = null
    return true
  }
  return false
}

/** Test seam: forget the last empty click. */
export function resetDoubleClick() {
  lastEmpty = null
}

export const ADD_KEY_STATIC_NOTE = 'Double-click adds a key on an animated row: turn its key toggle on first'

function addKeyAt(e, ctx, row) {
  const v = viewOf(ctx)
  const raw = xToTick(ctx.x, v.scrollOffset, v.ppb)
  const tick = snapMotionTick(raw, { modifiers: { alt: !!e.altKey }, granularity: ctx.snapGranularity }).tick
  const plan = addKeyAtPlan(row, ctx.data, tick)
  if (!plan) {
    const why = row.provider.isAnimated(row, ctx.data, tick)
      ? row.provider.editBlocker?.(row, ctx.data, tick, 'key') ?? 'No key can go there'
      : ADD_KEY_STATIC_NOTE
    ctx.hint?.(why)
    return false
  }
  commit(ctx, plan, `Add ${row.prop.label} key`)
  return true
}

// ── Pointer down ─────────────────────────────────────────────────────────────

function selectThen(ctx, e, inst, keysForSel) {
  const s = ctx.store.getState()
  const mode = selectionMode(e)
  const entries = keysForSel.map((k) => [k.id, k.ref])
  if (mode === 'toggle') { s.selectKeys(entries, 'toggle'); return null }
  const allSelected = keysForSel.every((k) => s.keySel.has(k.id))
  if (!allSelected) s.selectKeys(entries, mode)
  const index = buildKeyIndex(ctx.layout, ctx.data)
  const selected = selectedInstances(index, ctx.store.getState().keySel)
  const collapseTo = allSelected && mode === 'replace' && selected.length > keysForSel.length ? inst : null
  return { selected, collapseTo }
}

function graphPointerDown(e, ctx) {
  const v = viewOf(ctx)
  const hit = hitTestGraph(v, ctx.x, ctx.y - (v.scrollTop ?? 0))
  const s = ctx.store.getState()
  if (!hit) {
    if (selectionMode(e) === 'replace') s.clearKeySel()
    return true
  }
  if (hit.kind === 'handle') { beginHandle(e, ctx, hit); return true }
  if (hit.kind === 'key') {
    s.setFocusedRow(hit.curve.rowKey)
    ctx.onFocusTrack?.(hit.curve.trackId)
    if (e.ctrlKey && e.altKey && hit.inst.hollow) {
      beginMove(e, ctx, { primary: hit.inst, selected: [hit.inst], nudgeNote: true })
      return true
    }
    const r = selectThen(ctx, e, hit.inst, [hit.inst])
    if (r) beginMove(e, ctx, { primary: hit.inst, selected: r.selected, collapseTo: r.collapseTo })
    return true
  }
  const mode = selectionMode(e)
  beginMarquee(e, ctx, mode, { onClick: () => { if (mode === 'replace') ctx.store.getState().clearKeySel() } })
  return true
}

/** The pointerdown of the key area (motionInteraction's handler). */
export function motionGesturePointerDown(e, ctx) {
  if (e.button !== 0) return false
  const s = ctx.store.getState()
  if (s.graph) return graphPointerDown(e, ctx)
  const hit = ctx.hit
  if (hit?.row) ctx.onFocusTrack?.(hit.row.trackId)
  if (hit?.key) {
    if (e.ctrlKey && e.altKey && hit.key.hollow && hit.key.ref?.kind === 'hit') {
      beginMove(e, ctx, { primary: hit.key, selected: [hit.key], nudgeNote: true })
      return true
    }
    const r = selectThen(ctx, e, hit.key, [hit.key])
    if (r) beginMove(e, ctx, { primary: hit.key, selected: r.selected, collapseTo: r.collapseTo })
    return true
  }
  if (hit?.row && hit.summaryTick !== undefined) {
    const keys = summaryKeysAt(hit.row, ctx.data, hit.summaryTick)
    if (keys.length === 0) return true
    const r = selectThen(ctx, e, keys[0], keys)
    if (r) beginMove(e, ctx, { primary: keys[0], selected: r.selected })
    return true
  }
  const mode = selectionMode(e)
  if (hit?.row?.kind === 'prop' && mode === 'replace' && isDoubleClick(e, ctx, hit.row.key)) {
    addKeyAt(e, ctx, hit.row)
    return true
  }
  beginMarquee(e, ctx, mode, { onClick: () => { if (mode === 'replace') ctx.store.getState().clearKeySel() } })
  return true
}

// ── Commands (menu and keyboard) ─────────────────────────────────────────────

function selection(ctx) {
  return selectedInstances(buildKeyIndex(ctx.layout, ctx.data), ctx.store.getState().keySel)
}

const plural = (n, one, many) => (n === 1 ? one : many)

export function deleteSelected(ctx) {
  const sel = selection(ctx)
  if (sel.length === 0) return false
  const plan = deleteKeysPlan(ctx.data, sel, { foldTick: ctx.tick })
  ctx.store.getState().clearKeySel()
  commit(ctx, plan, plural(sel.length, 'Delete key', 'Delete keys'))
  return true
}

export function copySelected(ctx) {
  const sel = selection(ctx)
  if (sel.length === 0) return false
  const clip = copyKeys(ctx.data, sel)
  if (!clip) return false
  ctx.store.getState().setClipboard(clip)
  ctx.hint?.(`Copied ${clipboardSummary(clip)}: Ctrl+V pastes them at the playhead`)
  return true
}

export function cutSelected(ctx) {
  const sel = selection(ctx)
  if (sel.length === 0) return false
  const { clipboard, plan } = cutKeys(ctx.data, sel, { foldTick: ctx.tick })
  if (!clipboard) return false
  const s = ctx.store.getState()
  s.setClipboard(clipboard)
  s.clearKeySel()
  commit(ctx, plan, plural(sel.length, 'Cut key', 'Cut keys'))
  return true
}

export function pasteClipboard(ctx) {
  const s = ctx.store.getState()
  const clip = s.clipboard
  if (!clip?.entries?.length) {
    ctx.hint?.('Nothing to paste: copy some keys first (Ctrl+C)')
    return true
  }
  const { plan, note } = pasteKeysPlan(ctx.data, clip, { tick: ctx.tick, targetTrackId: singleSelectedTrack(s.selectedRows) })
  if (note) ctx.hint?.(note)
  if (plan.length) commit(ctx, plan, 'Paste keys')
  return true
}

export function nudgeSelected(ctx, direction, fine) {
  const sel = selection(ctx)
  if (sel.length === 0) return false
  const step = gridStepTicks(ctx.snapGranularity)
  const amount = fine ? Math.max(1, Math.round(step / 4)) : step
  const index = buildKeyIndex(ctx.layout, ctx.data)
  const r = nudgeSelection(ctx.data, index, sel, (direction < 0 ? -1 : 1) * amount)
  if (r.blocked) {
    ctx.hint?.(MOVE_MERGE_HINT)
    return true
  }
  // Held at a floor / zone edge: nothing moves, so nothing is written (no empty undo step).
  if (r.edits.every((e) => e.pos === e.ref.pos)) return true
  const plan = movePlan(ctx.data, r)
  if (plan.length === 0) return true
  ctx.store.getState().selectKeys(selectionAfterMove(sel, r.edits), 'replace')
  commit(ctx, plan, plural(sel.length, 'Nudge key', 'Nudge keys'))
  return true
}

export function setSelectedInterp(ctx, interp, bez = null) {
  const sel = selection(ctx)
  if (sel.length === 0) return false
  commit(ctx, interpPlan(ctx.data, sel, interp, bez), interp === 'Bezier' ? 'Bezier keys' : `${interp === 'EaseOut' ? 'Ease out' : interp} keys`)
  return true
}

export function nudgeThisNote(ctx, inst) {
  const plan = nudgeNotePlan(ctx.data, inst)
  if (plan.length === 0) return false
  commit(ctx, plan, 'Nudge this note')
  return true
}

// ── Right-click ──────────────────────────────────────────────────────────────

/** The context-menu handler: select what is under the pointer, then open the key menu. */
export function motionGestureContextMenu(e, ctx) {
  const s = ctx.store.getState()
  let hitKey = null
  if (s.graph) {
    const v = viewOf(ctx)
    const h = hitTestGraph(v, ctx.x, ctx.y - (v.scrollTop ?? 0))
    if (h?.kind === 'key' || h?.kind === 'handle') hitKey = h.inst
  } else if (ctx.hit?.key) {
    hitKey = ctx.hit.key
  } else if (ctx.hit?.row && ctx.hit.summaryTick !== undefined) {
    const keys = summaryKeysAt(ctx.hit.row, ctx.data, ctx.hit.summaryTick)
    if (keys.length && !keys.every((k) => s.keySel.has(k.id))) s.selectKeys(keys.map((k) => [k.id, k.ref]), 'replace')
  }
  if (hitKey && !s.keySel.has(hitKey.id)) s.selectKeys([[hitKey.id, hitKey.ref]], 'replace')
  const sel = selection(ctx)
  const items = keyMenuItems({
    instances: sel,
    hitKey,
    canPaste: !!ctx.store.getState().clipboard?.entries?.length,
    on: {
      interp: (interp, bez) => setSelectedInterp(ctx, interp, bez),
      copy: () => copySelected(ctx),
      paste: () => pasteClipboard(ctx),
      remove: () => deleteSelected(ctx),
      nudgeNote: (inst) => nudgeThisNote(ctx, inst),
    },
  })
  if (typeof ctx.openMenu !== 'function') return false
  ctx.openMenu({ x: e.clientX, y: e.clientY, items, label: 'Keys' })
  return true
}

// ── Install ──────────────────────────────────────────────────────────────────

/** Plug the gestures, the menu, the graph painter and the key commands into Motion view. */
export function installMotionEditing() {
  const offs = [
    setMotionPointerHandler(motionGesturePointerDown),
    setMotionContextMenuHandler(motionGestureContextMenu),
    setMotionGraphPainter(drawGraphLayer),
    registerMotionKeyAction('delete', (cmd, ctx) => deleteSelected(ctx)),
    registerMotionKeyAction('copy', (cmd, ctx) => copySelected(ctx)),
    registerMotionKeyAction('cut', (cmd, ctx) => cutSelected(ctx)),
    registerMotionKeyAction('paste', (cmd, ctx) => pasteClipboard(ctx)),
    registerMotionKeyAction('nudge', (cmd, ctx) => nudgeSelected(ctx, cmd.direction ?? 1, !!cmd.fine)),
  ]
  return () => {
    active?.cancel()
    for (const off of offs) off()
  }
}

export default installMotionEditing
