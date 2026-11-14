// Roam keyframes: the renderer-side model behind the Roam key lane, the viewer's
// motion path and Auto-key (docs/XLETH_LENS_ROAM_SPEC.md, phase P10).
//
// Pure arithmetic, no React, no IPC. Roam keys are ABSOLUTE and timeline-absolute:
// a keyed channel follows its keys (before the first key it holds the first
// value, after the last key the last), an unkeyed channel holds the track's base.
// That is the engine's rule (LensRoamSnapshot::roamAt), and the evaluator here is a
// literal port of it (lensKeyModel.valueAtEvent), used ONLY to draw the lane and
// the motion path and to place the viewer handles at the playhead. The engine stays
// the one evaluator of what is rendered.
//
// Key shape (the wire format of getLensRoam / setTrackRoamKeys):
//   { channel: 'offsetX'|'offsetY'|'scale'|'rotationDeg', anchor: 'Origin',
//     pos: timeline ticks (960 PPQ), value, interp: 'Hold'|'Linear'|'EaseOut' }
// `interp` shapes the segment LEAVING a key (the last key's is never read).

import {
  applyKeyOp, keyEquals, keysOfChannel, makeKey, sortEventKeys, unitToValue, valueAtEvent, valueToUnit,
} from './lensKeyModel.js'
import { SCALE_MAX, SCALE_MIN, roamQuad } from './lensRoamModel.js'
import { MINUS, THIN_SPACE } from '../ui-kit/format.ts'

export { applyKeyOp, keyEquals, keysOfChannel, makeKey, unitToValue, valueToUnit }

export const TICKS_PER_BEAT = 960
export const BEATS_PER_BAR = 4
export const TICKS_PER_BAR = TICKS_PER_BEAT * BEATS_PER_BAR

export const ROAM_CHANNELS = ['offsetX', 'offsetY', 'scale', 'rotationDeg']
export const ROAM_CHANNEL_LABELS = {
  offsetX: 'Offset X', offsetY: 'Offset Y', scale: 'Scale', rotationDeg: 'Rotate',
}
export const ROAM_CHANNEL_OPTIONS = ROAM_CHANNELS.map((c) => ({ value: c, label: ROAM_CHANNEL_LABELS[c] }))
export const INTERPS = ['Hold', 'Linear', 'EaseOut']

// The most a key may hold. The engine accepts any finite number (a scale > 0); the
// UI keeps keys on the lane. A cell can leave the picture from the far corner of an
// 8 x 8 grid, so offsets reach eight cells.
export const KEY_LIMITS = {
  offsetX: [-8, 8],
  offsetY: [-8, 8],
  scale: [SCALE_MIN, SCALE_MAX],
  rotationDeg: [-720, 720],
}

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v))
const ROAM_FIELD_SET = new Set(ROAM_CHANNELS)

/** The identity of a channel: where the cell sits with no Roam. */
export const roamIdentityOf = (channel) => (channel === 'scale' ? 1 : 0)

export function clampKeyValue(channel, value) {
  const [lo, hi] = KEY_LIMITS[channel] ?? [-Infinity, Infinity]
  if (!Number.isFinite(value)) return roamIdentityOf(channel)
  return clamp(value, lo, hi)
}

// ── Evaluation (LensRoamSnapshot::roamAt) ────────────────────────────────────

/** Per-channel keys, each sorted by position (stable, like the engine's compile). */
export function compileRoamKeys(keys) {
  const out = {}
  for (const ch of ROAM_CHANNELS) out[ch] = sortEventKeys(keysOfChannel(keys, ch))
  return out
}

/** The track's Roam at a timeline tick: keyed channels follow their keys, the rest hold `base`. */
export function resolveRoamAt(base, keys, tick, compiled = null) {
  const b = base ?? {}
  if (!keys || keys.length === 0) return { ...b }
  const c = compiled ?? compileRoamKeys(keys)
  const out = { ...b }
  for (const ch of ROAM_CHANNELS) {
    if (c[ch].length > 0) out[ch] = valueAtEvent(c[ch], tick, b[ch] ?? roamIdentityOf(ch))
  }
  return out
}

/** Which channels have at least one key. */
export function keyedChannels(keys) {
  const set = new Set()
  for (const k of keys ?? []) if (ROAM_FIELD_SET.has(k.channel)) set.add(k.channel)
  return set
}

// ── Formatting (value, thin space, unit; true minus) ─────────────────────────

/** A key's value as the UI prints it. `short` drops the unit (a lane's axis labels). */
export function formatRoamValue(channel, value, { short = false } = {}) {
  const num = (v, d) => {
    const t = (Math.abs(v) < 0.5 * 10 ** -d ? 0 : v).toFixed(d)
    return t.startsWith('-') ? `${MINUS}${t.slice(1)}` : t
  }
  if (channel === 'scale') return short ? `\u00d7${num(value, 2)}` : `${num(value, 2)}${THIN_SPACE}\u00d7`
  if (channel === 'rotationDeg') return short ? `${num(value, 0)}\u00b0` : `${num(value, 1)}${THIN_SPACE}\u00b0`
  return short ? num(value, 1) : `${num(value, 2)}${THIN_SPACE}cells`
}

// ── Time ─────────────────────────────────────────────────────────────────────

/** 1-based "bar.beat.ticks" of a timeline tick, 4/4: 3840.1.0 would be bar 2. */
export function barBeatOf(tick) {
  const t = Math.max(0, Math.round(tick))
  const bar = Math.floor(t / TICKS_PER_BAR) + 1
  const inBar = t % TICKS_PER_BAR
  const beat = Math.floor(inBar / TICKS_PER_BEAT) + 1
  const ticks = inBar % TICKS_PER_BEAT
  return { bar, beat, ticks }
}

export function formatBarBeat(tick) {
  const { bar, beat, ticks } = barBeatOf(tick)
  return `${bar}.${beat}.${ticks}`
}

// ── Lane scale ───────────────────────────────────────────────────────────────

const OFFSET_STEPS = [1, 2, 3, 4, 6, 8]
const ROTATION_STEPS = [45, 90, 180, 360, 720]

function niceCeil(x, steps) {
  for (const s of steps) if (x <= s) return s
  return steps[steps.length - 1]
}

/**
 * The value range one lane shows, { min, max, log }. Snapped to a few steps so the
 * lane does not rescale on every nudge, and it always contains the identity, the
 * base value and every key, so a key can never sit off the lane.
 */
export function roamLaneRange(channel, keys, base) {
  const values = keysOfChannel(keys, channel).map((k) => k.value).filter(Number.isFinite)
  const b = base?.[channel]
  if (Number.isFinite(b)) values.push(b)
  if (channel === 'scale') {
    const lo = Math.min(1, ...values)
    const hi = Math.max(1, ...values)
    // Octave steps around 1, at least 1/2 .. 2.
    const down = Math.max(1, Math.ceil(Math.log2(1 / Math.max(lo, 1e-6)) - 1e-9))
    const up = Math.max(1, Math.ceil(Math.log2(hi) - 1e-9))
    return {
      min: Math.max(SCALE_MIN, 2 ** -down), max: Math.min(SCALE_MAX, 2 ** up), log: true,
    }
  }
  const peak = Math.max(0, ...values.map((v) => Math.abs(v)))
  const half = channel === 'rotationDeg' ? niceCeil(peak, ROTATION_STEPS) : niceCeil(peak, OFFSET_STEPS)
  return { min: -half, max: half, log: false }
}

/** Value -> y inside a lane (0 at the top). `inner` is { top, height }. */
export function laneValueToY(range, inner, value) {
  const u = clamp(valueToUnit(range, value), 0, 1)
  return inner.top + (1 - u) * inner.height
}

/** y -> a value on the lane, clamped to the lane's range and to what a key may hold. */
export function laneYToValue(range, inner, y, channel) {
  const u = clamp(1 - (y - inner.top) / Math.max(1, inner.height), 0, 1)
  return clampKeyValue(channel, unitToValue(range, u))
}

// ── Key edits (pure; every result is a new array) ────────────────────────────

const SAME_TICK = 0.5

/** Index of the key of `channel` at `pos` (within half a tick), else -1. */
export function keyIndexAt(keys, channel, pos) {
  return keys.findIndex((k) => k.channel === channel && Math.abs(k.pos - pos) < SAME_TICK)
}

/** Set `channel`'s value at `pos`: updates the key there, or adds one. */
export function upsertKey(keys, { channel, pos, value, interp }) {
  const p = Math.max(0, Math.round(pos))
  const v = clampKeyValue(channel, value)
  const i = keyIndexAt(keys, channel, p)
  if (i < 0) return [...keys, makeKey({ channel, anchor: 'Origin', pos: p, value: v, interp: interp ?? 'Linear' })]
  const next = makeKey({ ...keys[i], value: v, interp: interp ?? keys[i].interp })
  if (keyEquals(next, keys[i])) return keys
  return keys.map((k, j) => (j === i ? next : k))
}

/**
 * Move one key to (pos, value). A key may not land on another key of its channel
 * (two keys on one tick are ambiguous: the engine takes the later one), so it is
 * pushed one tick on, in the direction it was moving.
 */
export function moveKey(keys, match, { pos, value }) {
  const i = keys.findIndex((k) => keyEquals(k, match))
  if (i < 0) return keys
  const dir = pos >= match.pos ? 1 : -1
  let p = Math.max(0, Math.round(pos))
  const taken = (q) => keys.some((k, j) => j !== i && k.channel === match.channel && Math.abs(k.pos - q) < SAME_TICK)
  while (taken(p)) p += dir
  if (p < 0) p = 0
  while (taken(p)) p += 1
  const next = makeKey({ ...keys[i], pos: p, value: clampKeyValue(match.channel, value) })
  if (keyEquals(next, keys[i])) return keys
  return keys.map((k, j) => (j === i ? next : k))
}

/** The keys in time order per channel, channels in lane order (a stable display order). */
export function sortedForDisplay(keys) {
  return ROAM_CHANNELS.flatMap((ch) => sortEventKeys(keysOfChannel(keys, ch)))
}

// ── Auto-key and the edit router ─────────────────────────────────────────────

/** Split a Roam patch into its animatable channels and everything else (bounds, layer). */
export function splitRoamPatch(patch) {
  const channels = {}
  const other = {}
  for (const [k, v] of Object.entries(patch ?? {})) {
    if (ROAM_FIELD_SET.has(k)) channels[k] = v
    else other[k] = v
  }
  return { channels, other }
}

const EPS = 1e-6

/**
 * What a gesture on the cell should do, given the track's keys.
 *
 *   patch      the fields the gesture changed (a Roam patch: offsetX, scale, ...)
 *   tick       the playhead, in timeline ticks
 *   autoKey    Auto-key on: write keys at the playhead instead of the base
 *
 * Returns one of
 *   { kind: 'none' }                         nothing to do (no change)
 *   { kind: 'base', patch }                  an unkeyed gesture: the static base, as before
 *   { kind: 'keys', keys }                   the whole new key list (ONE setTrackRoamKeys)
 *   { kind: 'blocked', channels }            a keyed channel edited with Auto-key off: the
 *                                            base would be ignored, so the edit is refused
 *
 * Auto-key writes one key per changed channel at `tick`. The FIRST key on a
 * channel that had none also drops a rest key, holding the value the cell had,
 * `restTicks` earlier (clamped to tick 0): the cell then glides from where it was
 * instead of being displaced for the whole timeline before the playhead.
 */
export function planRoamEdit({ base, keys, patch, tick, autoKey, restTicks = TICKS_PER_BAR }) {
  const { channels, other } = splitRoamPatch(patch)
  const changedChannels = Object.keys(channels)
  const hasOther = Object.keys(other).length > 0
  if (changedChannels.length === 0) return hasOther ? { kind: 'base', patch: other } : { kind: 'none' }

  const at = Math.max(0, Math.round(tick))
  const keyed = keyedChannels(keys)
  if (!autoKey) {
    const hit = changedChannels.filter((c) => keyed.has(c))
    if (hit.length > 0) return { kind: 'blocked', channels: hit }
    // Unkeyed and Auto-key off: exactly the static edit it always was (the engine
    // skips the command when nothing changes).
    return { kind: 'base', patch: { ...channels, ...other } }
  }

  const now = resolveRoamAt(base, keys, at)
  let next = keys ?? []
  for (const ch of changedChannels) {
    const value = clampKeyValue(ch, channels[ch])
    const had = keyed.has(ch)
    if (!had) {
      if (Math.abs(value - now[ch]) <= EPS) continue     // nothing to animate
      const restTick = Math.max(0, at - Math.max(0, Math.round(restTicks)))
      if (restTick < at) next = upsertKey(next, { channel: ch, pos: restTick, value: now[ch], interp: 'Linear' })
    } else if (Math.abs(value - now[ch]) <= EPS && keyIndexAt(next, ch, at) < 0) {
      continue                                           // already there; do not add a redundant key
    }
    next = upsertKey(next, { channel: ch, pos: at, value })
  }
  if (next === keys || sameKeys(next, keys)) return hasOther ? { kind: 'base', patch: other } : { kind: 'none' }
  return { kind: 'keys', keys: next, ...(hasOther ? { basePatch: other } : {}) }
}

export function sameKeys(a, b) {
  if (a === b) return true
  if (!a || !b || a.length !== b.length) return false
  return a.every((k, i) => keyEquals(k, b[i]))
}

/** The value of `channel` a "key at the playhead" button writes: what the cell is doing now. */
export function keyAtPlayhead(keys, base, channel, tick) {
  const at = Math.max(0, Math.round(tick))
  const now = resolveRoamAt(base, keys, at)[channel]
  return upsertKey(keys ?? [], { channel, pos: at, value: now })
}

// ── Motion path (the viewer's dotted line through the key positions) ─────────

/**
 * Ticks where the cell's POSITION has a key (an offsetX or offsetY key), sorted,
 * de-duplicated. These are the dots.
 */
export function positionKeyTicks(keys) {
  const set = new Set()
  for (const k of keys ?? []) if (k.channel === 'offsetX' || k.channel === 'offsetY') set.add(Math.round(k.pos))
  return [...set].sort((a, b) => a - b)
}

/**
 * The path of the cell's centre, canvas-UV.
 *   dots  one per position-key tick: { tick, x, y }
 *   line  the centre sampled between the first and last dot (so Hold's step and
 *         EaseOut's curve show), `steps` samples per segment
 * Empty when there are no position keys or the track has no cell.
 */
export function roamMotionPath(base, keys, geo, steps = 24) {
  const out = { dots: [], line: [] }
  if (!geo || !keys || keys.length === 0) return out
  const ticks = positionKeyTicks(keys)
  if (ticks.length === 0) return out
  const compiled = compileRoamKeys(keys)
  const centreAt = (t) => roamQuad(resolveRoamAt(base, keys, t, compiled), geo).center
  for (const t of ticks) out.dots.push({ tick: t, ...centreAt(t) })
  if (ticks.length > 1) {
    for (let i = 0; i + 1 < ticks.length; i++) {
      const a = ticks[i]
      const b = ticks[i + 1]
      const n = Math.max(2, steps)
      for (let s = i === 0 ? 0 : 1; s <= n; s++) {
        const t = s === n ? b : a + ((b - a) * s) / n
        out.line.push(centreAt(t))
      }
    }
  }
  return out
}

/** The offset that puts the cell's centre at canvas-UV (u, v). Inverse of roamQuad's centre. */
export function offsetForCenter(geo, u, v) {
  return {
    offsetX: (u - geo.home.x - geo.home.w * 0.5) / geo.unit.w,
    offsetY: (v - geo.home.y - geo.home.h * 0.5) / geo.unit.h,
  }
}
