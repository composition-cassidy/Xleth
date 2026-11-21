// Motion property schema helpers (docs/XLETH_MOTION_VIEW_DESIGN.md section 4).
//
// motionSchema.json is the ONE definition of every motion property: id, group,
// owner, channel, label, value type, unit, identity, range, clamp, log, time
// base, blend and the limits. New Motion view code reads ranges, identities,
// labels, units and options through these helpers and never re-declares them.
// The engine reads the same file through scripts/generate-motion-schema.js ->
// engine/src/model/MotionSchema.generated.inc (staleness: motionSchema.test.js).
//
// Pure: no React, no IPC. Values are printed the kit way: number, THIN SPACE,
// unit, a true minus sign, and no sign on a value that rounds to zero.

import schema from './motionSchema.json'
import { MINUS, THIN_SPACE } from '../ui-kit/format.ts'
import { logScale } from '../ui-kit/valueScale.ts'

export const MOTION_SCHEMA = schema
export const SCHEMA_VERSION = schema.version

const deepFreeze = (o) => {
  if (o && typeof o === 'object' && !Object.isFrozen(o)) {
    Object.freeze(o)
    for (const v of Object.values(o)) deepFreeze(v)
  }
  return o
}

/** Every property, in schema order (frozen). */
export const PROPERTIES = deepFreeze(schema.properties.map((p) => ({ ...p })))
/** Every group, in schema order (frozen). Trail rows exist only on Trail clones (trailProvider). */
export const GROUPS = deepFreeze(schema.groups.map((g) => ({ ...g })))
/** The unit table: { suffix, decimals, signed, space, factor? } per unit id. */
export const UNITS = deepFreeze({ ...schema.units })
/** Key interpolations, in menu order. */
export const INTERPS = Object.freeze([...schema.interps])
/**
 * The caps (R15): { maxParentDepth, maxMasksPerTrack, maxVerticesPerMask,
 * maxMaskVerticesPerTrack, minVerticesPerMask }.
 */
export const LIMITS = deepFreeze({ ...schema.limits })
export const limits = LIMITS

const BY_ID = new Map(PROPERTIES.map((p) => [p.id, p]))
const GROUP_BY_ID = new Map(GROUPS.map((g) => [g.id, g]))

/** The property with this id ('roam.offsetX'), or null. */
export function propertyById(id) {
  return BY_ID.get(id) ?? null
}

/**
 * Add a property that is not in the JSON schema: a video effect parameter. Its id
 * (`fx.<type>.<param>`) is per effect TYPE and param, so one registration serves
 * every instance of that effect. Idempotent.
 */
export function registerProperty(prop) {
  if (prop && typeof prop.id === 'string' && !BY_ID.has(prop.id)) BY_ID.set(prop.id, Object.freeze({ ...prop }))
  return BY_ID.get(prop?.id) ?? null
}

/** The group with this id ('roam'), or null. */
export function groupById(id) {
  return GROUP_BY_ID.get(id) ?? null
}

/**
 * The properties of a group in schema order. `owner` narrows the Lens group to
 * one owner ('clip' | 'source'); without it the Lens group lists both.
 */
export function propertiesOfGroup(groupId, { owner } = {}) {
  return PROPERTIES.filter((p) => p.group === groupId && (owner === undefined || p.owner === owner))
}

/** The property of an id prefix and channel: propertyFor('roam', 'scale') -> roam.scale. */
export function propertyFor(prefix, channel) {
  return propertyById(`${prefix}.${channel}`)
}

/** The unit spec of a scalar property, else null. */
export function unitOf(prop) {
  const p = resolve(prop)
  return p && p.type === 'scalar' ? UNITS[p.unit] ?? null : null
}

/** The value an untouched property holds (the absolute identity: zoom 1, centre 0.5, offset 0...). */
export function identityOf(prop) {
  const p = resolve(prop)
  return p ? p.identity : undefined
}

/** A layer (blend multiply / add) rather than an absolute value: Sweep, hit curve, note keys. */
export function isLayer(prop) {
  const p = resolve(prop)
  return !!p && (p.blend === 'multiply' || p.blend === 'add')
}

/** What an unkeyed LAYER contributes: 1 for a multiplier, 0 for an offset; else the identity. */
export function layerIdentityOf(prop) {
  const p = resolve(prop)
  if (!p) return undefined
  if (p.blend === 'multiply') return 1
  if (p.blend === 'add') return 0
  return p.identity
}

/** Has a key toggle (stopwatch, R3): keys can animate it. */
export function isAnimatable(prop) {
  const p = resolve(prop)
  return !!p && p.animatable === true
}

/** A multiplier drawn and dragged on a log scale (zoom, scale). */
export function isLog(prop) {
  const p = resolve(prop)
  return !!p && p.log === true
}

/** The range a value cell and a graph show; `layer` = the layer range of a source Lens channel. */
export function rangeOf(prop, { layer = false } = {}) {
  const p = resolve(prop)
  if (!p || p.type !== 'scalar') return null
  const r = layer && p.layerRange ? p.layerRange : p.range
  return [r[0], r[1]]
}

/** Clamp to the property's engine clamp (null clamp = any finite value). Non-finite -> identity. */
export function clampValue(prop, v) {
  const p = resolve(prop)
  if (!p || p.type !== 'scalar') return v
  if (!Number.isFinite(v)) return p.identity
  if (!p.clamp) return v
  return Math.min(p.clamp[1], Math.max(p.clamp[0], v))
}

function resolve(prop) {
  if (typeof prop === 'string') return BY_ID.get(prop) ?? null
  return prop && typeof prop === 'object' ? prop : null
}

// ── Labels ───────────────────────────────────────────────────────────────────

/**
 * An option name as the UI prints it, in sentence case:
 * 'AboveNeighbours' -> 'Above neighbours', 'FollowTrack' -> 'Follow track', 'EaseOut' -> 'Ease out'.
 */
export function readableLabel(name) {
  const s = String(name ?? '')
  const words = s.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/([A-Z])([A-Z][a-z])/g, '$1 $2').split(' ')
  return words.map((w, i) => (i === 0 ? w : w.toLowerCase())).join(' ')
}

/** Motion blur shutter angles the row's menu offers (R1); 0 = off. */
export const MOTION_BLUR_SHUTTERS = Object.freeze([90, 180, 270, 360])

/**
 * The choices of a picker row as [{ value, label }]: enum and shape options,
 * Off / On for a bool, Off and the shutter angles for the motion blur row.
 */
export function enumOptions(prop) {
  const p = resolve(prop)
  if (!p) return []
  if (p.type === 'bool') return [{ value: false, label: 'Off' }, { value: true, label: 'On' }]
  if (p.type === 'motionBlur') {
    return [{ value: 0, label: 'Off' }, ...MOTION_BLUR_SHUTTERS.map((d) => ({ value: d, label: `${d}°` }))]
  }
  if (!Array.isArray(p.options)) return []
  return p.options.map((o) => ({ value: o, label: readableLabel(o) }))
}

// ── Formatting ───────────────────────────────────────────────────────────────

const EM_DASH = '—'

/** Round |n| half away from zero to `d` decimals, immune to binary artefacts (1.005 -> 1.01). */
function roundAbs(abs, d) {
  const s = String(abs)
  if (s.includes('e')) return Math.round(abs * 10 ** d) / 10 ** d
  return Number(`${Math.round(Number(`${s}e${d}`))}e-${d}`)
}

function formatScalar(unit, v, { short = false, signed } = {}) {
  if (typeof v !== 'number' || Number.isNaN(v)) return EM_DASH
  const factor = unit.factor ?? 1
  const x = v * factor
  if (!Number.isFinite(x)) return `${x < 0 ? MINUS : ''}inf`
  const d = unit.decimals
  const r = roundAbs(Math.abs(x), d)
  const sign = r === 0 ? '' : x < 0 ? MINUS : (signed ?? unit.signed) ? '+' : ''
  const num = `${sign}${r.toFixed(d)}`
  if (!unit.suffix) return num
  return short || !unit.space ? `${num}${unit.suffix}` : `${num}${THIN_SPACE}${unit.suffix}`
}

/**
 * A value as the UI prints it, per the schema unit: '1.00 ×', '−0.25 c', '45.0°',
 * '100 %', '+0.10'. `short` drops the space before the unit (canvas chips and axis
 * labels). `layer` prints a source Lens layer value: an offset layer is signed.
 * Enums print their readable label, bools On / Off, the motion blur row
 * 'Project · 180°' / 'Project · Off' (R1), a shape its kind, a colour its hex
 * in capitals ('#F07A2A').
 */
export function formatValue(prop, v, { short = false, layer = false } = {}) {
  const p = resolve(prop)
  if (!p) return EM_DASH
  switch (p.type) {
    case 'scalar': {
      const unit = UNITS[p.unit]
      if (!unit) return EM_DASH
      return formatScalar(unit, v, { short, signed: layer && p.blend === 'add' ? true : undefined })
    }
    case 'enum':
      return v === undefined || v === null ? EM_DASH : readableLabel(v)
    case 'bool':
      return v ? 'On' : 'Off'
    case 'motionBlur': {
      const on = typeof v === 'object' && v !== null ? !!v.enabled : typeof v === 'number' ? v > 0 : v === 'On'
      const deg = typeof v === 'object' && v !== null ? v.shutterAngleDeg : typeof v === 'number' ? v : null
      if (!on) return `Project · Off`
      return Number.isFinite(deg) ? `Project · ${Math.round(deg)}°` : 'Project · On'
    }
    case 'shape': {
      if (typeof v === 'string') return readableLabel(v)
      if (v && typeof v === 'object') {
        if (typeof v.kind === 'string') return readableLabel(v.kind)
        const n = Array.isArray(v.vertices) ? v.vertices.length : 0
        return `${n}${THIN_SPACE}points`
      }
      return EM_DASH
    }
    case 'color':
      return normaliseHex(v) ?? EM_DASH
    default:
      return EM_DASH
  }
}

/** A '#RRGGBB' (or 'RRGGBB', any case, spaces ignored) colour as '#RRGGBB' in capitals, else null. */
export function normaliseHex(v) {
  const m = /^#?([0-9a-fA-F]{6})$/.exec(String(v ?? '').trim())
  return m ? `#${m[1].toUpperCase()}` : null
}

// ── Parsing typed values ─────────────────────────────────────────────────────

// Unit words a typed value may carry, longest first so 'cells' wins over 'c'.
const SUFFIXES = {
  mul: ['×', 'x'],
  cells: ['cells', 'cell', 'c'],
  deg: ['degrees', 'degree', 'deg', '°'],
  pct: ['%'],
  fxPx: ['px'],
  cellDist: ['c'],
  cellDistSigned: ['c'],
  srcNorm: [],
  srcDelta: [],
  none: [],
}
const NUMBER = /^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/

function normaliseText(text) {
  return String(text ?? '')
    .replace(/[−‒–—]/g, '-')
    .replace(/[\s   ]/g, '')
    .toLowerCase()
}

function parseScalar(p, text) {
  let t = normaliseText(text)
  if (!t) return null
  const suffixes = SUFFIXES[p.unit] ?? []
  if (p.unit === 'mul' && (t.startsWith('×') || t.startsWith('x'))) t = t.slice(1)
  for (const s of suffixes) {
    if (t.length > s.length && t.endsWith(s)) { t = t.slice(0, -s.length); break }
  }
  if (!NUMBER.test(t)) return null
  const n = Number(t)
  if (!Number.isFinite(n)) return null
  const factor = UNITS[p.unit]?.factor ?? 1
  return n / factor
}

/**
 * A typed value back to the property's value: a number in the property's own
 * units (a percent is typed as 50 and returns 0.5), an option string, a bool, or
 * a shutter angle for the motion blur row (0 = off), a '#RRGGBB' colour. null = not a value.
 * Accepts the true minus, a '+', thin spaces and the unit words ('×', 'x', '°',
 * 'deg', '%', 'c', 'cells'). Not clamped: the caller's control clamps.
 */
export function parseValue(prop, text) {
  const p = resolve(prop)
  if (!p) return null
  switch (p.type) {
    case 'scalar':
      return parseScalar(p, text)
    case 'enum':
    case 'shape': {
      const t = normaliseText(text)
      const hit = (p.options ?? []).find((o) => o.toLowerCase() === t || normaliseText(readableLabel(o)) === t)
      return hit ?? null
    }
    case 'bool': {
      const t = normaliseText(text)
      if (['on', 'true', 'yes', '1'].includes(t)) return true
      if (['off', 'false', 'no', '0'].includes(t)) return false
      return null
    }
    case 'motionBlur': {
      const t = normaliseText(text).replace(/(degrees|degree|deg|°)$/, '')
      if (t === 'off' || t === '0') return 0
      if (!NUMBER.test(t)) return null
      const n = Number(t)
      return Number.isFinite(n) && n > 0 && n <= 360 ? n : null
    }
    case 'color':
      return normaliseHex(String(text ?? '').replace(/\s/g, ''))
    default:
      return null
  }
}

// ── NumberBox props ──────────────────────────────────────────────────────────

// Drag travel per unit of value, tuned like the Roam and Lens inspector boxes
// (RoamPanel: 50 px per cell, 2 px per degree; LensPanel: 200 px across a source
// frame). A log property uses LOG_PX for its whole range (the RoamPanel scale box).
const PX_PER_UNIT = {
  cells: 50, deg: 2, srcNorm: 200, srcDelta: 100, pct: 200, cellDist: 400, cellDistSigned: 400, none: 100,
}
const LOG_PX = 200
const MIN_PX = 120

/**
 * Props for a kit NumberBox editing this property:
 *   { label, min, max | scale, defaultValue (= identity, the Ctrl+click reset),
 *     pxPerRange, bipolar?, centre?, format, parse }
 * `layer` uses the layer range and identity (a source Lens hit / note layer).
 * null for a property that is not a scalar (its value cell is a picker).
 */
export function numberBoxProps(prop, { layer = false } = {}) {
  const p = resolve(prop)
  if (!p || p.type !== 'scalar') return null
  const [lo, hi] = rangeOf(p, { layer })
  const identity = layer ? layerIdentityOf(p) : p.identity
  const out = {
    label: p.label,
    defaultValue: identity,
    format: (v) => formatValue(p, v, { layer }),
    parse: (t) => parseValue(p, t),
  }
  if (p.log) {
    out.scale = logScale(lo, hi)
    out.pxPerRange = LOG_PX
    return out
  }
  out.min = lo
  out.max = hi
  out.pxPerRange = Math.max(MIN_PX, Math.round((hi - lo) * (PX_PER_UNIT[p.unit] ?? 100)))
  if (lo < 0 && hi > 0) {
    out.bipolar = true
    out.centre = identity >= lo && identity <= hi ? identity : 0
  }
  return out
}
