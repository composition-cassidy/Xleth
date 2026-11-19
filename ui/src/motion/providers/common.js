// Shared pieces of the Motion view row providers (docs/XLETH_MOTION_VIEW_DESIGN.md
// 5.3, R3, R4). Pure: no React, no IPC.
//
// A KEY INSTANCE is one key as Motion view draws and selects it:
//   { id, rowKey, tick, value, interp, bez?, hollow, outside?, ref, key }
//     id      unique per drawn key (see the keyId formats in rowRegistry.js)
//     tick    where it is drawn, timeline ticks
//     hollow  an inherited key (a hit-curve key drawn under a note, R5)
//     outside a key that does not play (a clip key past its event, a note key Cut away)
//     ref     what an edit addresses: { kind, trackId, channel, pos, ... } per provider
//     key     the wire key object itself (for keyEquals / applyKeyOp matching)

import { clampValue, layerIdentityOf, propertyById } from '../schema.js'
import { keysOfChannel, makeKey, sortEventKeys } from '../../lensRoam/lensKeyModel.js'

/** Two key positions closer than this are the same tick (whole-tick positions). */
export const SAME_TICK = 0.5
/** Two Body positions (fractions) closer than this are the same place. */
export const SAME_BODY = 1e-4

const fin = (v) => typeof v === 'number' && Number.isFinite(v)

/** Instances sorted by tick (stable). */
export function sortInstances(list) {
  return list.map((k, i) => ({ k, i })).sort((a, b) => (a.k.tick - b.k.tick) || (a.i - b.i)).map((e) => e.k)
}

/** One channel's Origin keys (timeline-absolute or event-relative), sorted by pos. */
export function channelKeys(keys, channel) {
  return sortEventKeys(keysOfChannel(keys, channel))
}

/** The list without any key of `channel`. */
export function withoutChannel(keys, channel) {
  return (keys ?? []).filter((k) => k.channel !== channel)
}

/**
 * Set `channel`'s value at `pos` on an Origin-anchored key list (Roam, Sweep, a
 * clip's Lens): the key within half a tick is updated (its interp kept), else one
 * is added (Linear). `clamp(v)` clamps the value; positions are whole ticks >= 0.
 */
export function upsertOriginKey(keys, { channel, pos, value, interp }, clamp = (v) => v) {
  const list = keys ?? []
  const p = Math.max(0, Math.round(pos))
  const v = clamp(value)
  const i = list.findIndex((k) => k.channel === channel && Math.abs(k.pos - p) < SAME_TICK)
  if (i < 0) return [...list, makeKey({ channel, anchor: 'Origin', pos: p, value: v, interp: interp ?? 'Linear' })]
  const prev = list[i]
  const next = makeKey({ ...prev, value: v, interp: interp ?? prev.interp })
  return list.map((k, j) => (j === i ? next : k))
}

/** The Origin key list without the key of `channel` at `pos` (within half a tick). */
export function removeOriginKeyAt(keys, channel, pos) {
  return (keys ?? []).filter((k) => !(k.channel === channel && Math.abs(k.pos - pos) < SAME_TICK))
}

const samePlace = (anchor, a, b) => Math.abs(a - b) < (anchor === 'Body' ? SAME_BODY : SAME_TICK)

/**
 * Set `channel`'s value at a note-relative place (Head / Body / Tail anchor + pos)
 * on a hit curve or a note's own keys: the key at the same anchor and place is
 * updated (interp kept), else one is added (Linear).
 */
export function upsertNoteKey(keys, { channel, anchor, pos, value, interp }) {
  const list = keys ?? []
  const i = list.findIndex((k) => k.channel === channel && k.anchor === anchor && samePlace(anchor, k.pos, pos))
  if (i < 0) return [...list, makeKey({ channel, anchor, pos, value, interp: interp ?? 'Linear' })]
  const prev = list[i]
  return list.map((k, j) => (j === i ? makeKey({ ...prev, value, interp: interp ?? prev.interp }) : k))
}

/** The note key list without the key of `channel` at that anchor and place. */
export function removeNoteKeyAt(keys, channel, anchor, pos) {
  return (keys ?? []).filter((k) => !(k.channel === channel && k.anchor === anchor && samePlace(anchor, k.pos, pos)))
}

/** Value clamp of a schema property (null clamp = any finite value; non-finite -> identity). */
export const clampFor = (propId) => (v) => clampValue(propertyById(propId), v)

/**
 * Value clamp of a LAYER (Sweep, hit curve, note keys): the property's layer
 * range, a multiplier kept > 0. Non-finite -> the layer identity.
 */
export function clampLayer(prop, v) {
  const p = typeof prop === 'string' ? propertyById(prop) : prop
  if (!fin(v)) return layerIdentityOf(p)
  const r = p.layerRange ?? p.range
  if (p.blend === 'multiply') return Math.min(r[1], Math.max(r[0], v))
  return v
}

/** Combine a value with a layer the way the engine blends it: multiply (zoom) or add. */
export function combineLayer(prop, a, layer) {
  const p = typeof prop === 'string' ? propertyById(prop) : prop
  return p.blend === 'multiply' || p.log ? a * layer : a + layer
}

/** The layer that takes `from` to `to`: to / from (multiply) or to - from (add). */
export function layerBetween(prop, from, to) {
  const p = typeof prop === 'string' ? propertyById(prop) : prop
  if (p.blend === 'multiply' || p.log) return from !== 0 ? to / from : 1
  return to - from
}

/** Is any instance drawn within half a tick of `tick`? */
export function instanceAt(instances, tick) {
  for (const k of instances ?? []) {
    if (Math.abs(k.tick - tick) < SAME_TICK) return k
  }
  return null
}

/** First index of tick-sorted instances whose tick is > t (strict) or >= t. Binary search. */
export function instanceIndexAfter(instances, t, strict = true) {
  let lo = 0
  let hi = instances.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    const v = instances[mid].tick
    if (strict ? v <= t : v < t) lo = mid + 1
    else hi = mid
  }
  return lo
}

/**
 * A key that plays (not `outside`) drawn within half a tick of `tick`, that
 * `accept(instance)` takes (any when omitted), or null. `instances` sorted by
 * tick; a binary search, nothing allocated (it runs per row per display tick).
 */
export function playingInstanceAt(instances, tick, accept = null) {
  const list = instances ?? []
  for (let i = instanceIndexAfter(list, tick - SAME_TICK); i < list.length && list[i].tick < tick + SAME_TICK; i++) {
    const k = list[i]
    if (k.outside) continue
    if (!accept || accept(k)) return k
  }
  return null
}

/** The ticks of a row's keys, unique and ascending (prev / next navigation). */
export function uniqueTicks(instances) {
  const out = []
  for (const k of instances ?? []) {
    if (k.outside) continue
    if (out.length === 0 || Math.abs(out[out.length - 1] - k.tick) >= SAME_TICK) out.push(k.tick)
  }
  return out
}

/** The tick of the previous (dir -1) or next (dir +1) key strictly before / after `tick`, or null. */
export function adjacentTick(ticks, tick, dir) {
  if (dir < 0) {
    for (let i = ticks.length - 1; i >= 0; i--) if (ticks[i] < tick - SAME_TICK) return ticks[i]
  } else {
    for (let i = 0; i < ticks.length; i++) if (ticks[i] > tick + SAME_TICK) return ticks[i]
  }
  return null
}

/** The read-through motion blur rows (R1): what the setting is. */
export const MOTION_BLUR_HINT = 'Motion blur: one project setting, Lens, Roam and Sweep blur on every track'
export const MOTION_BLUR_MODS = 'Not undoable, the same setting as Settings > Motion blur'

/** A plan-write label: 'Key Offset X', 'Set Scale'... */
export const planLabel = (verb, prop) => `${verb} ${prop?.label ?? 'value'}`

/** The value a disabled cell shows nothing for. */
export const NO_VALUE = null
