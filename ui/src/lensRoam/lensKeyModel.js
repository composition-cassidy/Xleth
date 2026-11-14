// Lens keyframes: the renderer-side model behind the Advanced Lens editor
// (docs/XLETH_LENS_ROAM_SPEC.md, phase P9).
//
// Pure arithmetic, no React, no IPC. This is a PORT of the engine's curve maths
// (engine/src/model/KeyCurve.h noteSpan / noteCurveTime / evaluateSorted, and the
// blend in LensRoamSnapshot::lensForEventAt), used ONLY to draw the lanes, hit-
// test keys and print the resolved value at the playhead. The engine stays the
// one evaluator of what is rendered: if the two ever disagree the picture is
// right and the lane is wrong, which is why every function here is a literal
// transcription and lensKeyModel.test.js pins the same numbers the engine tests do.
//
// Key shape (the wire format of getLensRoam / getPattern / setNoteLensKeys):
//   { channel: 'zoom'|'centerX'|'centerY'|'rotationDeg',
//     anchor: 'Head'|'Body'|'Tail' (note keys) | 'Origin' (Clip Track event keys),
//     pos, value, interp: 'Hold'|'Linear'|'EaseOut' }
//   Head / Tail pos = ticks (960 PPQ); Body pos = a 0..1 fraction; Origin pos =
//   ticks from the event start.
//
// What a value MEANS (spec "Blend"):
//   Clip event keys are ABSOLUTE: a keyed channel follows its keys, an unkeyed
//   one holds the base. Hit-curve and note keys are LAYERS on the base: zoom
//   multiplies, centre and rotation add, and an unkeyed layer channel is the
//   layer's identity (zoom 1, offsets 0).

export const TICKS_PER_BEAT = 960

export const LENS_CHANNELS = ['zoom', 'centerX', 'centerY', 'rotationDeg']
export const NOTE_ANCHORS = ['Head', 'Body', 'Tail']
export const INTERPS = ['Hold', 'Linear', 'EaseOut']

export const DEFAULT_ZONES = Object.freeze({ headTicks: 120, tailTicks: 240, shortNote: 'Squash' })

/** The layer identity of a channel: what an unkeyed layer contributes. */
export const layerIdentity = (channel) => (channel === 'zoom' ? 1 : 0)

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v))
const zoneTicks = (v, fallback) => (Number.isFinite(v) && v >= 0 ? v : fallback)

export function normalizeZones(zones) {
  return {
    headTicks: zoneTicks(zones?.headTicks, DEFAULT_ZONES.headTicks),
    tailTicks: zoneTicks(zones?.tailTicks, DEFAULT_ZONES.tailTicks),
    shortNote: zones?.shortNote === 'Cut' ? 'Cut' : 'Squash',
  }
}

// ── Note span (KeyCurve.h noteSpan) ──────────────────────────────────────────

/**
 * One note's resolved zone geometry. NOTE time is ticks since note-on; CURVE
 * time is where keys sit. They are the same axis except under Cut.
 */
export function noteSpan(noteLen, zones) {
  const z = normalizeZones(zones)
  const H = z.headTicks
  const T = z.tailTicks
  const L = Number.isFinite(noteLen) && noteLen > 0 ? noteLen : 0
  const s = {
    noteLen: L, headTicks: H, tailTicks: T,
    headEnd: 0, tailStart: 0, scale: 1,
    curveHeadEnd: 0, curveTailStart: 0, curveEnd: 0, cut: false,
  }
  if (L >= H + T) {
    s.curveEnd = L
  } else if (z.shortNote === 'Cut') {
    s.cut = true
    s.curveEnd = H + T
  } else {
    s.scale = L / (H + T)
    s.curveEnd = L
  }
  s.curveTailStart = s.curveEnd - T * s.scale
  s.curveHeadEnd = L >= H + T ? H : s.curveTailStart
  if (s.cut) {
    s.tailStart = Math.max(0, L - T)
    s.headEnd = s.tailStart
  } else {
    s.headEnd = s.curveHeadEnd
    s.tailStart = s.curveTailStart
  }
  return s
}

/** A note anchor's place on the CURVE time axis, clamped into its zone. */
export function noteCurveTime(s, anchor, pos) {
  if (anchor === 'Body') {
    const f = clamp(pos, 0, 1)
    if (f >= 1) return s.curveTailStart
    return Math.min(s.curveHeadEnd + f * (s.curveTailStart - s.curveHeadEnd), s.curveTailStart)
  }
  if (anchor === 'Tail') {
    const v = clamp(pos, 0, s.tailTicks)
    if (v >= s.tailTicks) return s.curveTailStart
    if (v <= 0) return s.curveEnd
    return clamp(s.curveEnd - v * s.scale, s.curveTailStart, s.curveEnd)
  }
  const v = clamp(pos, 0, s.headTicks)   // Head, and anything else read as Head
  if (v >= s.headTicks) return s.curveHeadEnd
  return Math.min(v * s.scale, s.curveHeadEnd)
}

/** A note anchor as an offset from note-on, in ticks (Squash or Cut applied). */
export function anchorOffset(s, anchor, pos) {
  if (s.cut && anchor === 'Tail') return s.noteLen - clamp(pos, 0, s.tailTicks)
  return noteCurveTime(s, anchor, pos)
}

/** Does playback pass through this anchor? Always, except under Cut. */
export function anchorReached(s, anchor, pos) {
  if (!s.cut) return true
  const off = anchorOffset(s, anchor, pos)
  return anchor === 'Tail' ? off >= 0 : off < s.tailStart
}

/** Note time (ticks since note-on, clamped to the note) -> curve time. */
export function noteTimeToCurveTime(s, t) {
  const c = clamp(t, 0, s.noteLen)
  if (s.cut && c >= s.tailStart) return s.curveEnd - (s.noteLen - c)
  return c
}

/** Which zone plays at note time `t`: 'Head' | 'Body' | 'Tail'. */
export function zoneAt(s, t) {
  if (t < s.headEnd) return 'Head'
  if (t < s.tailStart) return 'Body'
  return 'Tail'
}

/** The note-time interval [lo, hi] of a zone. */
export function zoneSpan(s, anchor) {
  if (anchor === 'Body') return [s.headEnd, s.tailStart]
  if (anchor === 'Tail') return [s.tailStart, s.noteLen]
  return [0, s.headEnd]
}

/**
 * The inverse of anchorOffset: the position that puts `anchor` at note time `t`
 * (clamped into that zone). Squash divides by its scale, Cut counts the tail
 * back from the note end. A zone with no room (a Body of length 0) gives 0.
 */
export function positionAtNoteTime(s, anchor, t) {
  const [lo, hi] = zoneSpan(s, anchor)
  const c = clamp(t, lo, hi)
  if (anchor === 'Body') {
    const len = s.tailStart - s.headEnd
    return len > 0 ? clamp((c - s.headEnd) / len, 0, 1) : 0
  }
  if (anchor === 'Tail') {
    if (s.cut) return clamp(s.noteLen - c, 0, s.tailTicks)
    return s.scale > 0 ? clamp((s.curveEnd - c) / s.scale, 0, s.tailTicks) : 0
  }
  return s.scale > 0 ? clamp(c / s.scale, 0, s.headTicks) : 0
}

/** The anchor + position a note-time `t` falls on (the zone under it). */
export function keyPlaceAt(s, t) {
  const anchor = zoneAt(s, clamp(t, 0, s.noteLen))
  return { anchor, pos: positionAtNoteTime(s, anchor, t) }
}

// ── Canonical order (KeyCurve.h sortNoteKeys) ────────────────────────────────

const zoneRank = (anchor) => (anchor === 'Body' ? 1 : anchor === 'Tail' ? 2 : 0)

function zoneOrder(k, zones) {
  const z = normalizeZones(zones)
  if (k.anchor === 'Body') return clamp(k.pos, 0, 1)
  if (k.anchor === 'Tail') return -clamp(k.pos, 0, z.tailTicks)
  return clamp(k.pos, 0, z.headTicks)
}

/** A stable copy in the engine's canonical note order (time order for any note length). */
export function sortNoteKeys(keys, zones) {
  return keys
    .map((k, i) => ({ k, i }))
    .sort((a, b) => {
      const ra = zoneRank(a.k.anchor)
      const rb = zoneRank(b.k.anchor)
      if (ra !== rb) return ra - rb
      const oa = zoneOrder(a.k, zones)
      const ob = zoneOrder(b.k, zones)
      return oa === ob ? a.i - b.i : oa - ob
    })
    .map((e) => e.k)
}

/** A stable copy sorted by pos (event keys). */
export function sortEventKeys(keys) {
  return keys.map((k, i) => ({ k, i })).sort((a, b) => (a.k.pos === b.k.pos ? a.i - b.i : a.k.pos - b.k.pos)).map((e) => e.k)
}

// ── Evaluation (KeyCurve.h evaluateSorted / interpolate) ─────────────────────

const easeOut = (u) => 1 - (1 - u) * (1 - u)

function interpolate(a, b, u) {
  switch (a.interp) {
    case 'Hold': return a.value
    case 'EaseOut': return a.value + (b.value - a.value) * easeOut(u)
    default: return a.value + (b.value - a.value) * u
  }
}

function evaluateSorted(keys, t, fallback, timeOf) {
  const n = keys.length
  if (n === 0) return fallback
  if (!(t >= timeOf(keys[0]))) return keys[0].value
  let lo = 1
  let hi = n
  while (lo < hi) {
    const mid = lo + ((hi - lo) >> 1)
    if (timeOf(keys[mid]) <= t) lo = mid + 1
    else hi = mid
  }
  if (lo >= n) return keys[n - 1].value
  const a = keys[lo - 1]
  const b = keys[lo]
  const ta = timeOf(a)
  const tb = timeOf(b)
  return interpolate(a, b, (t - ta) / (tb - ta))
}

/** One channel's keys of a note curve (already filtered, canonical order) at note time `t`. */
export function valueAtNote(keys, span, t, fallback) {
  if (keys.length === 0) return fallback
  const u = noteTimeToCurveTime(span, t)
  return evaluateSorted(keys, u, fallback, (k) => noteCurveTime(span, k.anchor, k.pos))
}

/** One channel's keys of an event curve (sorted by pos) `t` ticks after the event start. */
export function valueAtEvent(keys, t, fallback) {
  return evaluateSorted(keys, t, fallback, (k) => k.pos)
}

export const keysOfChannel = (keys, channel) => (keys ?? []).filter((k) => k.channel === channel)

// ── Blend and the layer stack ────────────────────────────────────────────────

const blank = () => ({ zoom: 1, centerX: 0.5, centerY: 0.5, rotationDeg: 0 })

/**
 * Per-channel values of one note at note time `t`.
 *
 *   mode      'Follow' | 'Nudge' | 'Own'
 *   zones     the SOURCE's zones. An Own note plays on the spec defaults (a
 *             hit-curve edit, zones included, never reaches it).
 *
 * Returns { span, zones, base, hit, note, resolved }:
 *   hit   the hit-curve layer ({zoom, centerX, centerY, rotationDeg}) or null
 *         when it does not reach this note (Own) or the curve has no keys
 *   note  the note's own keys layer, or null (Follow / no keys)
 */
export function resolveNoteLens({ base, hitKeys = [], zones, mode = 'Follow', noteKeys = [], noteLen, t }) {
  const own = mode === 'Own'
  const z = own ? { ...DEFAULT_ZONES } : normalizeZones(zones)
  const span = noteSpan(noteLen, z)
  const useHit = !own && hitKeys.length > 0
  const useNote = mode !== 'Follow' && noteKeys.length > 0
  const layer = (keys) => {
    const out = {}
    for (const ch of LENS_CHANNELS) {
      const ck = sortNoteKeys(keysOfChannel(keys, ch), z)
      out[ch] = valueAtNote(ck, span, t, layerIdentity(ch))
    }
    return out
  }
  const hit = useHit ? layer(hitKeys) : null
  const note = useNote ? layer(noteKeys) : null
  const b = { ...blank(), ...base }
  const resolved = {
    zoom: b.zoom * (hit?.zoom ?? 1) * (note?.zoom ?? 1),
    centerX: b.centerX + (hit?.centerX ?? 0) + (note?.centerX ?? 0),
    centerY: b.centerY + (hit?.centerY ?? 0) + (note?.centerY ?? 0),
    rotationDeg: b.rotationDeg + (hit?.rotationDeg ?? 0) + (note?.rotationDeg ?? 0),
  }
  return { span, zones: z, base: b, hit, note, resolved }
}

/** A Clip Track event's lens `t` ticks after its start: keys replace the base per channel. */
export function resolveClipLens({ base, keys = [], t }) {
  const b = { ...blank(), ...base }
  const out = { ...b }
  for (const ch of LENS_CHANNELS) {
    const ck = sortEventKeys(keysOfChannel(keys, ch))
    out[ch] = valueAtEvent(ck, t, b[ch])
  }
  return { base: b, resolved: out }
}

// ── Key editing (pure; every result is a new array) ──────────────────────────

export const keyEquals = (a, b) => !!a && !!b
  && a.channel === b.channel && a.anchor === b.anchor && a.pos === b.pos
  && a.value === b.value && (a.interp ?? 'Linear') === (b.interp ?? 'Linear')

export function makeKey({ channel, anchor, pos, value, interp = 'Linear' }) {
  return { channel, anchor, pos, value, interp }
}

/**
 * One edit, applied to ANY note's key list. `match` is the key as it was when the
 * gesture started, so a multi-select applies the SAME edit to each note's own keys
 * instead of overwriting them with the first note's list:
 *   { type: 'add', key }
 *   { type: 'update', match, patch }
 *   { type: 'remove', match }
 * Returns the new list, or null when the edit does not apply to this list
 * (an update / remove whose key is not in it, or an add that is already there).
 */
export function applyKeyOp(keys, op) {
  if (op.type === 'add') {
    if (keys.some((k) => keyEquals(k, op.key))) return null
    return [...keys, makeKey(op.key)]
  }
  const i = keys.findIndex((k) => keyEquals(k, op.match))
  if (i < 0) return null
  if (op.type === 'remove') return keys.filter((_, j) => j !== i)
  if (op.type === 'update') {
    const next = makeKey({ ...keys[i], ...op.patch })
    if (keyEquals(next, keys[i])) return null
    return keys.map((k, j) => (j === i ? next : k))
  }
  return null
}

/** Re-anchor a key, keeping its place in time as far as the new zone allows. */
export function reanchorKey(key, anchor, span) {
  if (key.anchor === anchor) return key
  const t = anchorOffset(span, key.anchor, key.pos)
  return { ...key, anchor, pos: positionAtNoteTime(span, anchor, t) }
}

/** Clamp a key's pos into its zone (what the engine does on compile). */
export function clampKeyPos(key, zones) {
  const z = normalizeZones(zones)
  if (key.anchor === 'Body') return { ...key, pos: clamp(key.pos, 0, 1) }
  if (key.anchor === 'Tail') return { ...key, pos: clamp(key.pos, 0, z.tailTicks) }
  if (key.anchor === 'Head') return { ...key, pos: clamp(key.pos, 0, z.headTicks) }
  return { ...key, pos: Math.max(0, key.pos) }
}

export const VALUE_MIN = { zoom: 0.05, centerX: -2, centerY: -2, rotationDeg: -720 }
export const VALUE_MAX = { zoom: 16, centerX: 2, centerY: 2, rotationDeg: 720 }

/** A value the engine will accept for this channel (zoom must be > 0). */
export function clampChannelValue(channel, value, absolute = false) {
  if (!Number.isFinite(value)) return layerIdentity(channel)
  if (absolute && (channel === 'centerX' || channel === 'centerY')) return clamp(value, 0, 1)
  return clamp(value, VALUE_MIN[channel], VALUE_MAX[channel])
}

// ── Lane scales ──────────────────────────────────────────────────────────────

/**
 * The value range a lane shows. Zoom is logarithmic. The range always contains
 * the identity (or the base, for absolute clip keys) and every key, with padding,
 * so a key can never sit off the lane.
 */
export function laneRange(channel, values, { absolute = false, base = null } = {}) {
  const ref = absolute && base != null ? base : layerIdentity(channel)
  const all = [ref, ...values.filter(Number.isFinite)]
  const lo = Math.min(...all)
  const hi = Math.max(...all)
  if (channel === 'zoom') {
    const a = Math.min(lo, 1 / 1.5)
    const b = Math.max(hi, 1.5)
    const pad = Math.exp(Math.log(b / a) * 0.08)
    return { min: a / pad, max: b * pad, log: true }
  }
  if (absolute && (channel === 'centerX' || channel === 'centerY')) {
    return { min: Math.min(0, lo) - 0.05, max: Math.max(1, hi) + 0.05, log: false }
  }
  const floor = channel === 'rotationDeg' ? 30 : 0.25
  const half = Math.max(floor, Math.max(Math.abs(lo), Math.abs(hi)) * 1.15)
  return { min: -half, max: half, log: false }
}

/** value -> 0..1 along the lane (0 = bottom). */
export function valueToUnit(range, v) {
  if (range.log) return (Math.log(Math.max(v, 1e-6)) - Math.log(range.min)) / (Math.log(range.max) - Math.log(range.min))
  return (v - range.min) / (range.max - range.min)
}

/** 0..1 along the lane -> value. */
export function unitToValue(range, u) {
  if (range.log) return Math.exp(Math.log(range.min) + u * (Math.log(range.max) - Math.log(range.min)))
  return range.min + u * (range.max - range.min)
}

// ── Presets and Strength ─────────────────────────────────────────────────────
// The preset keys live in the engine (model/LensHitPresets.h, read through
// timeline_getHitPresets): the UI never keeps a copy. Strength scales every key's
// distance from its layer identity, so 100 % is the preset as defined.

export const STRENGTH_MIN = 0.1
export const STRENGTH_MAX = 2

const near = (a, b) => Math.abs(a - b) <= 1e-6

/** The keys of `preset` scaled to `strength` (value = identity + strength * (value - identity)). */
export function scalePresetKeys(presetKeys, strength) {
  return presetKeys.map((k) => {
    const id = layerIdentity(k.channel)
    return { ...k, value: clampChannelValue(k.channel, id + strength * (k.value - id)) }
  })
}

/**
 * Which preset (if any) are these keys, and at what strength? A curve that is
 * not exactly a scaled preset is Custom (null). 'Still' is the empty curve.
 * @returns {{name: string, strength: number}|null}
 */
export function matchPreset(keys, presets) {
  if (!keys || !presets) return null
  if (keys.length === 0) {
    const still = presets.find((p) => p.keys.length === 0)
    return still ? { name: still.name, strength: 1 } : null
  }
  for (const p of presets) {
    if (p.keys.length !== keys.length || p.keys.length === 0) continue
    let strength = null
    let ok = true
    for (let i = 0; i < keys.length && ok; i++) {
      const a = keys[i]
      const b = p.keys[i]
      if (a.channel !== b.channel || a.anchor !== b.anchor || !near(a.pos, b.pos)
        || (a.interp ?? 'Linear') !== (b.interp ?? 'Linear')) { ok = false; break }
      const id = layerIdentity(a.channel)
      const d = b.value - id
      if (Math.abs(d) > 1e-9) {
        const s = (a.value - id) / d
        if (strength === null) strength = s
        else if (!near(strength, s)) ok = false
      } else if (!near(a.value, b.value)) {
        ok = false
      }
    }
    if (ok && strength !== null && strength > 0) return { name: p.name, strength }
  }
  return null
}

// ── Formatting ───────────────────────────────────────────────────────────────

/** "Head +120" style label of a key's place, for hints and screen readers. */
export function describeKeyPlace(key) {
  if (key.anchor === 'Body') return `Body ${Math.round(key.pos * 1000) / 10} %`
  if (key.anchor === 'Origin') return `${Math.round(key.pos)} ticks`
  return `${key.anchor} ${Math.round(key.pos * 10) / 10} ticks`
}
