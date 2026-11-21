// Clones: the ONE renderer entry point to the engine's Clone RPCs
// (docs/XLETH_CLONE_SPEC.md; engine handlers Timeline_AddClone & co.).
//
// Every write is ONE engine UndoManager command (Ctrl+Z restores it), parses
// strictly on the engine side, and records nothing when it changes nothing.
// A successful write dispatches the timeline events the views already listen
// to, so the track list, Reel lanes, Motion view and preview refresh:
//   add / reorder           'timeline-tracks-changed' + 'timeline-grid-changed'
//   settings                'timeline-tracks-changed' + 'clone-settings-changed' (detail = post-state)
//   pins                    'timeline-patterns-changed'
// A failed write logs and resolves to null.

import { timelineEvents } from '../timelineEvents.js'

const TAG = '[Clones]'

function fn(name) {
  const f = window.xleth?.timeline?.[name]
  if (typeof f !== 'function') {
    console.warn(`${TAG} timeline.${name} is unavailable; nothing sent`)
    return null
  }
  return f
}

async function call(name, args) {
  const f = fn(name)
  if (!f) return null
  try {
    const res = await f(...args)
    console.log(`${TAG} ${name}`, res)
    return res ?? null
  } catch (err) {
    console.error(`${TAG} ${name} failed:`, err?.message ?? err)
    return null
  }
}

function emit(...names) {
  for (const n of names) timelineEvents.dispatchEvent(new Event(n))
}

/** Adds a Voice or Trail clone under `sourceTrackId`. -> { trackId, placed, track } | null */
export async function addClone(sourceTrackId, kind, opts) {
  const res = await call('addClone', opts ? [sourceTrackId, kind, opts] : [sourceTrackId, kind])
  if (res) emit('timeline-tracks-changed', 'timeline-grid-changed', 'timeline-pattern-blocks-changed')
  return res
}

/** Voice: { lensMode }. Trail: { delayTicks?, tint?, opacity?, opacityKeys? }. -> { trackId, changed, clone } | null */
export async function setCloneSettings(trackId, patch) {
  const res = await call('setCloneSettings', [trackId, patch])
  if (res?.changed) {
    emit('timeline-tracks-changed')
    timelineEvents.dispatchEvent(new CustomEvent('clone-settings-changed', { detail: res }))
  }
  return res
}

/** Every Clone of the source, once, in the new order. -> { changed } | null */
export async function reorderClones(sourceTrackId, cloneIds) {
  const res = await call('reorderClones', [sourceTrackId, cloneIds])
  if (res?.changed) emit('timeline-tracks-changed', 'timeline-patterns-changed', 'timeline-track-layout-changed')
  return res
}

/** Pins notes [{patternId, noteId}] to a voice (-1 = Auto). One undo step. -> { changed, count } | null */
export async function setNotesVoicePin(refs, pin) {
  const res = await call('setNotesVoicePin', [refs, pin])
  if (res?.changed) {
    emit('timeline-patterns-changed')
    const ids = [...new Set(refs.map((r) => r.patternId))]
    for (const patternId of ids)
      timelineEvents.dispatchEvent(new CustomEvent('timeline-pattern-changed', { detail: { patternId } }))
  }
  return res
}

/** The engine's own assignment for a source (or any of its Clones). Read-only. */
export function getVoiceAssignment(trackId) {
  return call('getVoiceAssignment', [trackId])
}

/** Moves a Clone one place up (-1) or down (+1) among its source's Clones. */
export async function moveClone(tracks, cloneId, delta) {
  const clone = tracks.find((t) => t.id === cloneId)
  if (!clone || !(clone.cloneOf >= 0)) return null
  const siblings = tracks
    .filter((t) => t.cloneOf === clone.cloneOf && t.id !== clone.cloneOf)
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || a.id - b.id)
    .map((t) => t.id)
  const i = siblings.indexOf(cloneId)
  const j = i + delta
  if (i < 0 || j < 0 || j >= siblings.length) return null
  ;[siblings[i], siblings[j]] = [siblings[j], siblings[i]]
  return reorderClones(clone.cloneOf, siblings)
}
