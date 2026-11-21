// Clones in Motion view (docs/XLETH_CLONE_SPEC.md "Timeline and Motion view"):
// the pure pieces the data hook, the Trail provider, the key editor and the plan
// runner share. No React, no IPC.
//
// A Clone's settings arrive on getTracks / getLensRoam track entries and on a
// setCloneSettings post-state as `clone: { cloneOf, kind, voice, lensMode,
// delayTicks, tint, opacity, opacityKeys: [{ pos, value, interp, bez? }] }`.
// Motion view keeps the Trail's opacity keys in the SAME shape as every other
// timeline key it edits (Origin keys of one channel, 'opacity'), so the key
// gestures, the graph, copy / paste and the interp menu need no Trail-only path;
// opacityKeysToWire turns them back into the engine's strict form (an unknown
// field such as `channel` would be refused).

import { DEFAULT_BEZ, makeKey, sanitizeBez, sortEventKeys, valueAtEvent } from '../lensRoam/lensKeyModel.js'

export const OPACITY_CHANNEL = 'opacity'
/** The engine's delay range (timeline_setCloneSettings): 1 tick .. 64 bars. */
export const TRAIL_DELAY_MIN = 1
export const TRAIL_DELAY_MAX = 245760

const fin = (v) => typeof v === 'number' && Number.isFinite(v)
const clamp01 = (v) => Math.min(1, Math.max(0, v))
const INTERPS = new Set(['Hold', 'Linear', 'EaseOut', 'Bezier'])

/** Wire opacity keys -> Motion view keys ({ channel: 'opacity', anchor: 'Origin', pos, value, interp, bez? }), sorted. */
export function opacityKeysFromWire(keys) {
  const out = []
  for (const k of Array.isArray(keys) ? keys : []) {
    if (!k || !fin(k.pos) || !fin(k.value)) continue
    const interp = INTERPS.has(k.interp) ? k.interp : 'Linear'
    out.push(makeKey({ channel: OPACITY_CHANNEL, anchor: 'Origin', pos: Math.max(0, k.pos), value: clamp01(k.value), interp, bez: k.bez }))
  }
  return sortEventKeys(out)
}

/** Motion view opacity keys -> the strict wire list [{ pos, value, interp, bez? }] (whole ticks, values in [0, 1]). */
export function opacityKeysToWire(keys) {
  return sortEventKeys([...(keys ?? [])]).map((k) => {
    const interp = INTERPS.has(k.interp) ? k.interp : 'Linear'
    const w = { pos: Math.max(0, Math.round(k.pos)), value: clamp01(fin(k.value) ? k.value : 1), interp }
    if (interp === 'Bezier') w.bez = sanitizeBez(k.bez ?? DEFAULT_BEZ)
    return w
  })
}

/** A setCloneSettings patch in its wire form (opacityKeys converted; every other field as is). */
export function clonePatchToWire(patch) {
  const out = { ...patch }
  if (Array.isArray(out.opacityKeys)) out.opacityKeys = opacityKeysToWire(out.opacityKeys)
  return out
}

/**
 * A Clone's settings as Motion view reads them, or null when `c` is not one:
 *   { cloneOf, kind: 'Voice'|'Trail', voice, lensMode: 'Linked'|'Own', delayTicks, tint, opacity, opacityKeys }
 */
export function normalizeClone(c) {
  if (!c || typeof c !== 'object') return null
  return {
    cloneOf: Number.isInteger(c.cloneOf) ? c.cloneOf : -1,
    kind: c.kind === 'Trail' ? 'Trail' : 'Voice',
    voice: fin(c.voice) ? c.voice : 0,
    lensMode: c.lensMode === 'Own' ? 'Own' : 'Linked',
    delayTicks: fin(c.delayTicks) ? Math.max(TRAIL_DELAY_MIN, c.delayTicks) : 480,
    tint: typeof c.tint === 'string' && /^#[0-9a-fA-F]{6}$/.test(c.tint) ? c.tint.toUpperCase() : '#FFFFFF',
    opacity: fin(c.opacity) ? clamp01(c.opacity) : 1,
    opacityKeys: opacityKeysFromWire(c.opacityKeys),
  }
}

/** A Trail's opacity at a timeline tick: its keys (the engine's evaluator, Bezier included) or its base. */
export function trailOpacityValueAt(clone, tick) {
  if (!clone) return null
  const keys = clone.opacityKeys ?? []
  return keys.length > 0 ? clamp01(valueAtEvent(keys, tick, clone.opacity)) : clone.opacity
}

/** A delay typed or dragged, as the engine takes it: whole ticks in [1, 245760], or null. */
export function clampDelayTicks(v) {
  if (!fin(v)) return null
  return Math.min(TRAIL_DELAY_MAX, Math.max(TRAIL_DELAY_MIN, Math.round(v)))
}
