// Roam key lane: one pointer gesture (docs/XLETH_LENS_ROAM_SPEC.md, P10).
//
//   left-click on empty lane      add a key there (drag to place it)
//   left-drag a key               move it in time and value
//     Alt                           no snap on the time axis
//     Shift                         fine: the value moves a quarter of the pointer
//   Ctrl/Shift-click a key        add it to / take it out of the multi-selection
//   Ctrl/Shift-drag on the lane   marquee: select every key inside the rectangle
//   left-drag a Bezier handle     reshape that key's segment (beginBezierHandleGesture)
//   right-click                   the key menu: Hold / Linear / Ease out / Bezier / Delete,
//                                 applied to the whole selection (TimelineCanvas)
//   Escape                        cancel the gesture; nothing is sent
//
// LOCAL preview, ONE commit: pointermove only rewrites the draft key list (drawn by
// the lane and by the viewer's motion path), pointerup sends the whole list in one
// call, so a gesture is one undo step. The gesture never talks to the engine
// while the pointer is down. Pure of React and of the DOM except for the window
// listeners it owns.

import { snapTickToGrid, tickToPixel } from '../../constants/timeline.js'
import {
  applyKeyOp, dragBezierHandle, keyEquals, laneYToValue, moveKey, sameKeys, unitToValue, upsertKey,
} from '../../lensRoam/roamKeyModel.js'
import { lanePointAt, roamLaneInner } from './roamLaneModel.js'

const DRAG_SLOP = 3
const FINE = 0.25

/**
 * @param {object} o
 * @param {PointerEvent|MouseEvent} o.event       the pointerdown / mousedown that began it
 * @param {object} o.hit                          hitTestRoamLane's result
 * @param {{base:object, keys:object[]}} o.data   the lane's COMMITTED keys
 * @param {() => ({scrollOffset:number, ppb:number})} o.view
 * @param {(e: MouseEvent) => ({localX:number, localY:number})} o.localOf
 * @param {() => string} o.granularity
 * @param {(keys: object[]) => void} o.setDraft   local preview (called at most once per frame)
 * @param {() => void} o.clearDraft
 * @param {(keys: object[]) => Promise<unknown>} o.commit    ONE engine call
 * @param {(sel: object|null) => void} o.select
 * @returns {{ cancel(): void }}
 */
export function beginRoamLaneGesture(o) {
  const { hit, data, view, localOf, granularity, setDraft, clearDraft, commit, select } = o
  const { trackId, channel, range, row } = hit
  const startKeys = data.keys
  const snap = (tick, e) => snapTickToGrid(tick, { alt: e.altKey, ctrl: e.ctrlKey }, granularity())

  // The key being moved, in a list that contains it: an existing one, or a new one
  // dropped where the pointer went down.
  let keysBase = startKeys
  let match = hit.key
  const created = !match
  if (created) {
    const pos = Math.max(0, Math.round(snap(hit.tick, o.event)))
    keysBase = upsertKey(startKeys, { channel, pos, value: hit.value })
    match = keysBase.find((k) => k.channel === channel && Math.abs(k.pos - pos) < 0.5)
  }
  const start = localOf(o.event)
  const startValue = match.value
  const inner = roamLaneInner(row)

  let draftKeys = keysBase
  let moved = false
  let done = false
  let raf = 0
  let pending = null

  select({ trackId, channel, pos: match.pos })
  if (created) setDraft(keysBase)

  const apply = (e) => {
    const p = localOf(e)
    const { scrollOffset, ppb } = view()
    const at = lanePointAt(row, range, channel, p.localX, p.localY, scrollOffset, ppb)
    const tick = Math.max(0, Math.round(snap(at.tick, e)))
    let value = at.value
    if (e.shiftKey) {
      // Fine: a quarter of the pointer's vertical travel, from where the key began.
      const startAt = laneYToValue(range, inner, start.localY, channel)
      value = startValue + (at.value - startAt) * FINE
    }
    const next = moveKey(keysBase, match, { pos: tick, value })
    draftKeys = next
    const i = keysBase.findIndex((k) => keyEquals(k, match))
    const moving = next[i] ?? match
    select({ trackId, channel, pos: moving.pos })
    pending = next
    if (!raf) {
      raf = requestAnimationFrame(() => {
        raf = 0
        if (pending) { setDraft(pending); pending = null }
      })
    }
  }

  const onMove = (e) => {
    if (done) return
    const p = localOf(e)
    if (!moved && Math.hypot(p.localX - start.localX, p.localY - start.localY) < DRAG_SLOP) return
    moved = true
    apply(e)
  }

  const finish = (e, doCommit) => {
    if (done) return
    done = true
    window.removeEventListener('pointermove', onMove, true)
    window.removeEventListener('pointerup', onUp, true)
    window.removeEventListener('pointercancel', onCancel, true)
    window.removeEventListener('keydown', onKey, true)
    window.removeEventListener('mousemove', onMove, true)
    window.removeEventListener('mouseup', onUp, true)
    if (raf) { cancelAnimationFrame(raf); raf = 0 }
    if (doCommit && moved) apply(e)
    pending = null
    const final = draftKeys
    if (doCommit && (moved || created) && !sameKeys(final, startKeys)) {
      Promise.resolve(commit(final)).catch(() => clearDraft())
    } else {
      clearDraft()
      if (!doCommit) select(null)
    }
  }
  const onUp = (e) => finish(e, true)
  const onCancel = (e) => finish(e, false)
  const onKey = (e) => {
    if (e.key !== 'Escape') return
    e.stopPropagation()
    finish(e, false)
  }

  window.addEventListener('pointermove', onMove, true)
  window.addEventListener('pointerup', onUp, true)
  window.addEventListener('pointercancel', onCancel, true)
  window.addEventListener('keydown', onKey, true)
  // A plain mouse event stream (and jsdom) has no pointer events.
  window.addEventListener('mousemove', onMove, true)
  window.addEventListener('mouseup', onUp, true)

  return { cancel: () => finish(null, false) }
}

// Window listeners for one pointer gesture, mouse events included (jsdom and a plain
// mouse stream have no pointer events). Returns the detach function.
function listen(onMove, onUp, onCancel, onKey) {
  window.addEventListener('pointermove', onMove, true)
  window.addEventListener('pointerup', onUp, true)
  window.addEventListener('pointercancel', onCancel, true)
  window.addEventListener('keydown', onKey, true)
  window.addEventListener('mousemove', onMove, true)
  window.addEventListener('mouseup', onUp, true)
  return () => {
    window.removeEventListener('pointermove', onMove, true)
    window.removeEventListener('pointerup', onUp, true)
    window.removeEventListener('pointercancel', onCancel, true)
    window.removeEventListener('keydown', onKey, true)
    window.removeEventListener('mousemove', onMove, true)
    window.removeEventListener('mouseup', onUp, true)
  }
}

/**
 * Drag one handle of a Bezier segment. `hit.handle` is { key, next, which } from
 * hitTestRoamLane. The same contract as a key drag: the draft is the whole key list
 * with that key's `bez` changed, drawn once per frame; pointerup commits it once.
 * The lane's range is frozen at the gesture's start, so the handle tracks the pointer.
 *
 * @param {object} o   { event, hit, data, view, localOf, setDraft, clearDraft, commit }
 */
export function beginBezierHandleGesture(o) {
  const { hit, data, view, localOf, setDraft, clearDraft, commit } = o
  const { range, row } = hit
  const { key, next: nextKey, which } = hit.handle
  const startKeys = data.keys
  const inner = roamLaneInner(row)
  // A handle's y is a VALUE fraction; read the pointer through the lane's own scale,
  // unclamped (a handle may sit past the next key's value: overshoot).
  const fromY = (y) => unitToValue(range, 1 - (y - inner.top) / Math.max(1, inner.height))
  let draftKeys = startKeys
  let moved = false
  let done = false
  let raf = 0
  let pending = null

  const apply = (e) => {
    const p = localOf(e)
    const { scrollOffset, ppb } = view()
    const toX = (k) => tickToPixel(k.pos, scrollOffset, ppb)
    const bez = dragBezierHandle(key, nextKey, which, p.localX, p.localY, toX, fromY)
    draftKeys = applyKeyOp(startKeys, { type: 'update', match: key, patch: { bez } }) ?? startKeys
    pending = draftKeys
    if (!raf) {
      raf = requestAnimationFrame(() => {
        raf = 0
        if (pending) { setDraft(pending); pending = null }
      })
    }
  }
  const onMove = (e) => { if (!done) { moved = true; apply(e) } }
  let detach = () => {}
  const finish = (e, doCommit) => {
    if (done) return
    done = true
    detach()
    if (raf) { cancelAnimationFrame(raf); raf = 0 }
    if (doCommit && moved && e) apply(e)
    pending = null
    if (doCommit && moved && !sameKeys(draftKeys, startKeys)) {
      Promise.resolve(commit(draftKeys)).catch(() => clearDraft())
    } else {
      clearDraft()
    }
  }
  const onUp = (e) => finish(e, true)
  const onCancel = (e) => finish(e, false)
  const onKey = (e) => {
    if (e.key !== 'Escape') return
    e.stopPropagation()
    finish(e, false)
  }
  detach = listen(onMove, onUp, onCancel, onKey)
  return { cancel: () => finish(null, false) }
}

/**
 * A marquee over the lanes of one kind: the rubber band follows the pointer, and on
 * release every key whose centre is inside becomes the multi-selection (added to it
 * when the drag began with Ctrl as well as Shift held, or with `additive`).
 *
 * @param {object} o   { event, localOf, setMarquee(rect|null), keysIn(rect) -> refs,
 *                       base: refs already selected, additive: boolean, select(refs) }
 */
export function beginRoamMarqueeGesture(o) {
  const { localOf, setMarquee, keysIn, select, base = [], additive = false } = o
  const start = localOf(o.event)
  let rect = { x0: start.localX, y0: start.localY, x1: start.localX, y1: start.localY }
  let done = false
  let raf = 0
  setMarquee(rect)
  const onMove = (e) => {
    if (done) return
    const p = localOf(e)
    rect = { ...rect, x1: p.localX, y1: p.localY }
    if (!raf) raf = requestAnimationFrame(() => { raf = 0; if (!done) setMarquee(rect) })
  }
  let detach = () => {}
  const finish = (e, doSelect) => {
    if (done) return
    done = true
    detach()
    if (raf) { cancelAnimationFrame(raf); raf = 0 }
    if (e && doSelect) {
      const p = localOf(e)
      rect = { ...rect, x1: p.localX, y1: p.localY }
    }
    setMarquee(null)
    if (!doSelect) return
    const inside = keysIn(rect)
    if (!additive) { select(inside); return }
    const merged = [...base]
    for (const r of inside) {
      if (!merged.some((m) => m.trackId === r.trackId && m.channel === r.channel && Math.abs(m.pos - r.pos) < 0.5)) merged.push(r)
    }
    select(merged)
  }
  const onUp = (e) => finish(e, true)
  const onCancel = (e) => finish(e, false)
  const onKey = (e) => {
    if (e.key !== 'Escape') return
    e.stopPropagation()
    finish(e, false)
  }
  detach = listen(onMove, onUp, onCancel, onKey)
  return { cancel: () => finish(null, false) }
}

/** The keys with `key` removed (right-click delete), or null when it is not in the list. */
export function removeKeyAt(keys, key) {
  const i = keys.findIndex((k) => keyEquals(k, key))
  return i < 0 ? null : keys.filter((_, j) => j !== i)
}
