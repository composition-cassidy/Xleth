// Motion view key copy / paste (docs/XLETH_MOTION_VIEW_DESIGN.md R23). Pure: the
// clipboard is plain data kept in motionViewStore; a paste is ONE motion plan.
//
// Every key keeps its time base:
//   Timeline keys (Roam, Sweep, Mask scalar, Mask shape, Trail opacity)   the earliest
//       copied one lands at the playhead, spacing kept. Trail opacity keys paste
//       onto Trail clones only.
//   Clip event keys (clip Lens)   into the clip under the playhead on the target
//       track, the earliest landing at the playhead, spacing kept (event-relative pos).
//   Note keys (hit curve, a note's own keys)   anchor and pos kept: hit keys into the
//       target source's hit curve, own keys into the note under the playhead (a
//       Follow note becomes Nudge).
// Target track: the one selected track when exactly one is selected, otherwise each
// key's own track. Same property only; masks are matched by their index within the
// track. A pasted key replaces a key at its place. When nothing applies the paste
// writes nothing and says why.

import { makeKey, sanitizeBez } from '../lensRoam/lensKeyModel.js'
import { isTrailClone } from '../clones/cloneModel.js'
import { dedupeByTarget, isNoteRef, isTimelineRef, noteOf, planKeyEdits, propIdOf, deleteKeysPlan } from './motionGestureModel.js'

export const CLIPBOARD_VERSION = 1

const copyVertices = (vs) => (vs ?? []).map((v) => [...v])

function cloneKey(ref, key) {
  if (ref.kind === 'maskShape') {
    const k = { pos: key.pos, interp: key.interp ?? 'Linear', vertices: copyVertices(key.vertices) }
    if (k.interp === 'Bezier') k.bez = sanitizeBez(key.bez)
    return k
  }
  return makeKey({ ...key })
}

/**
 * The clipboard of a key selection: one entry per edit target (a hit key drawn
 * under many notes is copied once).
 * @returns {{ v, entries: [{ kind, propId, channel, trackId, regionId?, clipId?, maskId?, maskIndex?,
 *            tick, key }] } | null}
 */
export function copyKeys(data, instances) {
  const entries = []
  for (const inst of dedupeByTarget(instances ?? []).values()) {
    const ref = inst.ref
    if (!ref || !inst.key) continue
    const e = { kind: ref.kind, propId: propIdOf(ref), channel: ref.channel ?? null, trackId: ref.trackId, tick: inst.tick, key: cloneKey(ref, inst.key) }
    if (ref.kind === 'clipLens') e.clipId = ref.clipId
    if (ref.kind === 'fx') { e.uid = ref.uid; e.param = ref.param; e.fxType = ref.type }
    if (isNoteRef(ref)) e.regionId = ref.regionId
    if (ref.kind === 'mask' || ref.kind === 'maskShape') {
      e.maskId = ref.maskId
      e.maskIndex = (data.roamOf?.(ref.trackId)?.masks ?? []).findIndex((m) => m.id === ref.maskId)
    }
    entries.push(e)
  }
  if (entries.length === 0) return null
  entries.sort((a, b) => a.tick - b.tick)
  return { v: CLIPBOARD_VERSION, entries }
}

/** A short description of a clipboard ('3 keys', '1 key'). */
export const clipboardSummary = (clip) => {
  const n = clip?.entries?.length ?? 0
  return n === 1 ? '1 key' : `${n} keys`
}

const minTick = (entries) => entries.reduce((m, e) => Math.min(m, e.tick), Infinity)

/** The region a hit key pastes into on `trackId` (5.3 / R23), or null. */
function hitRegionFor(data, entry, trackId, tick) {
  const regions = data.regionsByTrack?.get(trackId) ?? []
  if (regions.length === 0) return null
  if (regions.includes(entry.regionId)) return entry.regionId
  const under = data.noteUnder(trackId, tick)
  if (under) {
    const r = under.strip.regionIds[under.index]
    if (regions.includes(r)) return r
  }
  return regions[0]
}

/**
 * The plan of pasting `clip` at `tick`.
 *   targetTrackId   the one selected track (null = each key's own track)
 * Returns { plan, count (keys written), note (why nothing / what was skipped, or null) }.
 */
export function pasteKeysPlan(data, clip, { tick = 0, targetTrackId = null } = {}) {
  const entries = clip?.entries ?? []
  if (entries.length === 0) return { plan: [], count: 0, note: 'Nothing to paste: copy some keys first (Ctrl+C)' }
  const timeline = entries.filter((e) => isTimelineRef(e))
  const clipKeys = entries.filter((e) => e.kind === 'clipLens')
  const tFirst = minTick(timeline)
  const cFirst = minTick(clipKeys)
  const skipped = new Set()
  const adds = []
  const at = Math.max(0, Math.round(tick))

  for (const e of entries) {
    const trackId = targetTrackId ?? e.trackId
    const track = data.tracksById?.get(trackId)
    if (!track) { skipped.add('the track is gone'); continue }
    switch (e.kind) {
      case 'roam': {
        if (isTrailClone(track) && e.channel !== 'offsetX' && e.channel !== 'offsetY') {
          skipped.add("a Trail's added Roam is Offset X and Y only"); continue
        }
        const pos = Math.max(0, Math.round(e.tick - tFirst + at))
        adds.push({ ref: { kind: 'roam', trackId }, add: makeKey({ ...e.key, pos }) })
        break
      }
      case 'sweep': {
        if (track.type !== 'Pattern' || isTrailClone(track)) { skipped.add('Sweep keys go on Pattern tracks only'); continue }
        const pos = Math.max(0, Math.round(e.tick - tFirst + at))
        adds.push({ ref: { kind: 'sweep', trackId }, add: makeKey({ ...e.key, pos }) })
        break
      }
      case 'fx': {
        const fx = (track.visualEffectChain ?? []).find((c) => c.uid === e.uid)
        if (!fx || fx.type !== e.fxType) { skipped.add('the track has no such video effect'); continue }
        const pos = Math.max(0, Math.round(e.tick - tFirst + at))
        adds.push({ ref: { kind: 'fx', trackId, channel: e.channel, uid: e.uid, param: e.param, type: e.fxType }, add: makeKey({ ...e.key, pos }) })
        break
      }
      case 'trailOpacity': {
        if (!isTrailClone(track) || !data.cloneOf?.(trackId)) { skipped.add('Trail opacity keys go on Trail clones'); continue }
        const pos = Math.max(0, Math.round(e.tick - tFirst + at))
        adds.push({ ref: { kind: 'trailOpacity', trackId }, add: makeKey({ ...e.key, pos }) })
        break
      }
      case 'mask':
      case 'maskShape': {
        const mask = (data.roamOf?.(trackId)?.masks ?? [])[e.maskIndex]
        if (!mask) { skipped.add(`the track has no Mask ${e.maskIndex + 1}`); continue }
        const pos = Math.max(0, Math.round(e.tick - tFirst + at))
        if (e.kind === 'maskShape') {
          if (mask.base.shape.vertices.length !== e.key.vertices.length) { skipped.add('a shape key needs a mask with the same number of points'); continue }
          adds.push({ ref: { kind: 'maskShape', trackId, maskId: mask.id }, add: { ...e.key, pos, vertices: copyVertices(e.key.vertices) } })
        } else {
          adds.push({ ref: { kind: 'mask', trackId, maskId: mask.id }, add: makeKey({ ...e.key, pos }) })
        }
        break
      }
      case 'clipLens': {
        if (track.type === 'Pattern') { skipped.add('clip Lens keys go on Clip tracks'); continue }
        const clipAt = data.clipUnder(trackId, at)
        if (!clipAt) { skipped.add('no clip under the playhead'); continue }
        const pos = Math.max(0, Math.round(e.tick - cFirst + at - clipAt.positionTicks))
        adds.push({ ref: { kind: 'clipLens', trackId, clipId: clipAt.id }, add: makeKey({ ...e.key, pos }) })
        break
      }
      case 'hit': {
        if (track.type !== 'Pattern') { skipped.add('hit-curve keys go on Pattern tracks'); continue }
        const regionId = hitRegionFor(data, e, trackId, at)
        if (regionId === null) { skipped.add('the track plays no source'); continue }
        adds.push({ ref: { kind: 'hit', trackId, regionId }, add: makeKey({ ...e.key }) })
        break
      }
      case 'note': {
        if (track.type !== 'Pattern') { skipped.add('note keys go on Pattern tracks'); continue }
        const under = data.noteUnder(trackId, at)
        if (!under) { skipped.add('no note under the playhead'); continue }
        const s = under.strip
        const i = under.index
        const patternId = s.patternIds[i]
        const noteId = s.noteIds[i]
        const note = noteOf(data, patternId, noteId)
        if (!note) { skipped.add('no note under the playhead'); continue }
        const mode = note.lensOverride?.mode === 'Own' ? 'Own' : note.lensOverride?.mode === 'Nudge' ? 'Nudge' : 'Follow'
        adds.push({ ref: { kind: 'note', trackId, regionId: s.regionIds[i], patternId, noteId, mode }, add: makeKey({ ...e.key }) })
        break
      }
      default: skipped.add('unknown key')
    }
  }
  const plan = planKeyEdits(data, adds)
  const why = [...skipped]
  let note = null
  if (adds.length === 0) note = `Paste: nothing applies here (${why.join('; ') || 'no matching rows'})`
  else if (why.length) note = `Pasted ${adds.length} of ${entries.length} keys (${why.join('; ')})`
  return { plan, count: adds.length, note }
}

/** Cut = copy + delete, as ONE plan: { clipboard, plan }. */
export function cutKeys(data, instances, { foldTick = null } = {}) {
  const clipboard = copyKeys(data, instances)
  if (!clipboard) return { clipboard: null, plan: [] }
  return { clipboard, plan: deleteKeysPlan(data, instances, { foldTick }) }
}
