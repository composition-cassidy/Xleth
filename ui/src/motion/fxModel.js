// Video effect parameters as Motion view properties (the "Video effects" rows).
//
// A chain effect's params[] are animated with timeline-absolute keys, exactly like
// Roam's channels, only the property list is not in motionSchema.json: it is the
// effect catalog's (devices/video/videoFxCatalog.js CHAIN_PARAMS), so the ranges,
// units and labels are the ones the Video devices already show. Each catalog param
// becomes a schema-shaped property id `fx.<type>.<param>`, registered with schema.js
// so formatValue / numberBoxProps / clampValue work on it like on any other.
//
// Keys in the UI keep the Roam key shape ({ channel, anchor: 'Origin', pos, value,
// interp, bez? }) with channel = 'uid:param' (uid = the chain effect's stable id), so
// every key helper and gesture is shared. On the wire a key is { uid, param, pos,
// value, interp, bez? } (timeline_setTrackFxKeys); fxKeysToWire / fxKeysFromWire convert.
//
// Not animatable: colours (RGB triplets), enums, flags and the Echo's tap count.
// Mirrored by the engine's fxparam::range (engine/src/model/LensRoam.cpp).

import { CHAIN_PARAMS, FX, chainName } from '../components/devices/video/videoFxCatalog.js'
import { makeKey } from '../lensRoam/lensKeyModel.js'
import { registerProperty } from './schema.js'

export const FX_GROUP_ID = 'fx'

export const fxPropId = (type, param) => `fx.${type}.${param}`
export const fxChannel = (uid, param) => `${uid}:${param}`

/** 'uid:param' -> [uid, param] (NaN when malformed). */
export function parseFxChannel(channel) {
  const [u, p] = String(channel ?? '').split(':')
  return [Number(u), Number(p)]
}

// The unit a catalog formatter prints in, read off a sample (the catalog stores
// formatters, not unit names): '100 %' -> pct, '3.0 px' -> fxPx, '45°' -> deg, '1.00×' -> mul,
// else a plain number with its decimals.
function unitOfFormat(fmt) {
  const s = String(fmt?.format?.(1) ?? '1')
  if (s.includes('%')) return 'pct'
  if (/px\s*$/.test(s)) return 'fxPx'
  if (s.includes('°')) return 'deg'
  if (s.includes('×')) return 'mul'
  const decimals = Math.min(4, (s.split('.')[1] ?? '').replace(/\D+$/, '').length)
  return `fxPlain${decimals}`
}

const isAnimatableParam = (type, row) => !(type === FX.VISUAL_ECHO && row.pi === 0)   // Taps is a whole number

/** The schema-shaped property of one catalog parameter. */
function propOf(type, row) {
  return {
    id: fxPropId(type, row.pi),
    group: FX_GROUP_ID,
    owner: 'track',
    channel: String(row.pi),
    label: row.label,
    type: 'scalar',
    unit: unitOfFormat(row.fmt),
    identity: row.def,
    range: [row.min, row.max],
    clamp: [row.min, row.max],
    log: false,
    animatable: true,
    timeBase: 'timeline',
    blend: 'absolute',
    engineIndex: row.pi,
    ...(row.min < 0 && row.max > 0 ? { bipolar: true } : {}),
  }
}

const BY_TYPE = new Map()
for (const [typeKey, rows] of Object.entries(CHAIN_PARAMS)) {
  const type = Number(typeKey)
  const props = []
  for (const row of rows) {
    if (!isAnimatableParam(type, row)) continue
    props.push(registerProperty(propOf(type, row)))
  }
  BY_TYPE.set(type, Object.freeze(props))
}

/** The animatable params of an effect type, in the catalog's order. */
export const fxPropsOfType = (type) => BY_TYPE.get(type) ?? []

/**
 * The chain's effects as labelled groups: 'Chroma key', and 'Outline 2' when a type
 * repeats. [{ index, uid, type, label }]. An effect with no uid yet is skipped (the
 * engine hands every effect one).
 */
export function fxEffectsOf(chain) {
  const seen = new Map()
  const total = new Map()
  for (const fx of chain ?? []) total.set(fx.type, (total.get(fx.type) ?? 0) + 1)
  const out = []
  ;(chain ?? []).forEach((fx, index) => {
    const n = (seen.get(fx.type) ?? 0) + 1
    seen.set(fx.type, n)
    if (!Number.isInteger(fx.uid) || fx.uid <= 0) return
    const base = chainName(fx.type)
    out.push({ index, uid: fx.uid, type: fx.type, label: total.get(fx.type) > 1 ? `${base} ${n}` : base, bypassed: !!fx.bypassed })
  })
  return out
}

/** Wire keys ({ uid, param, ... }) -> the UI key shape. */
export function fxKeysFromWire(list) {
  if (!Array.isArray(list)) return []
  const out = []
  for (const k of list) {
    if (!k || !Number.isInteger(k.uid) || !Number.isInteger(k.param) || !Number.isFinite(k.pos) || !Number.isFinite(k.value)) continue
    out.push(makeKey({ channel: fxChannel(k.uid, k.param), anchor: 'Origin', pos: k.pos, value: k.value, interp: k.interp ?? 'Linear', bez: k.bez }))
  }
  return out
}

/** UI keys -> wire keys. */
export function fxKeysToWire(keys) {
  const out = []
  for (const k of keys ?? []) {
    const [uid, param] = parseFxChannel(k.channel)
    if (!Number.isInteger(uid) || !Number.isInteger(param)) continue
    const w = { uid, param, pos: k.pos, value: k.value, interp: k.interp ?? 'Linear' }
    if (w.interp === 'Bezier' && k.bez) w.bez = k.bez
    out.push(w)
  }
  return out
}
