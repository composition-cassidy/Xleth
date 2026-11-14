// Roam key lane: one pointer gesture (docs/XLETH_LENS_ROAM_SPEC.md, P10).
//
//   left-click on empty lane      add a key there (drag to place it)
//   left-drag a key               move it in time and value
//     Alt                           no snap on the time axis
//     Shift                         fine: the value moves a quarter of the pointer
//   right-click a key             delete it (removeKeyAt)
//   Escape                        cancel the gesture; nothing is sent
//
// LOCAL preview, ONE commit: pointermove only rewrites the draft key list (drawn by
// the lane and by the viewer's motion path), pointerup sends the whole list in one
// call, so a gesture is one undo step. The gesture never talks to the engine
// while the pointer is down. Pure of React and of the DOM except for the window
// listeners it owns.

import { snapTickToGrid } from '../../constants/timeline.js'
import {
  keyEquals, laneYToValue, moveKey, sameKeys, upsertKey,
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

/** The keys with `key` removed (right-click delete), or null when it is not in the list. */
export function removeKeyAt(keys, key) {
  const i = keys.findIndex((k) => keyEquals(k, key))
  return i < 0 ? null : keys.filter((_, j) => j !== i)
}
