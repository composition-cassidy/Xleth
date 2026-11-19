// Masks: the renderer-side model (docs/XLETH_MOTION_VIEW_DESIGN.md 2.2, R11-R15).
//
// Pure arithmetic, no React, no IPC. A Mask is a closed bezier path on a cell
// that CUTS what the cell shows; it belongs to the track's Roam, so it moves,
// scales, rotates and blurs with the cell. The engine (LensRoamSnapshot::masksAt
// and the FX_Mask pass) is the one evaluator of what renders; this module mirrors
// it to draw and edit masks, and its validator mirrors the strict
// timeline_setTrackMasks parser so the UI can refuse an edit before sending it.
//
// Wire format (the JS model IS the wire format; toWire only cleans a copy):
//   { id: positive int (unique in the track), name: <= 64 chars,
//     kind: 'Rectangle' | 'Ellipse' | 'Path',
//     base: { shape: { closed: true, vertices: [[x, y, inX, inY, outX, outY], ...] },
//             feather, expansion, opacity, mode: 'Add'|'Subtract'|'Intersect', invert },
//     keys: [{ channel: 'feather'|'expansion'|'opacity', anchor: 'Origin', pos, value,
//              interp, bez? }],
//     shapeKeys: [{ pos, interp, bez?, vertices: [[...6 numbers], ...] }] }
//
// Space (R11): vertices are in normalized CELL space, origin at the centre of the
// drawn cell, x in [-0.5, 0.5] left -> right, y in [-0.5, 0.5] top -> bottom (y
// down); shown as "c". Tangents are RELATIVE to their vertex. Feather and
// expansion are distances in units of the drawn cell's SHORTER side.
//
// Shape keys (R14) store every vertex; all of a mask's shape keys have the base's
// vertex count. The leaving key's interp / bez gives the blend factor and every
// vertex and tangent lerps with it.

import { LIMITS, INTERPS, clampValue, identityOf, propertyById, propertiesOfGroup } from './schema.js'
import { sanitizeBez, segmentEase, sortEventKeys, valueAtEvent } from '../lensRoam/lensKeyModel.js'

export const MASK_KINDS = Object.freeze([...propertyById('mask.shape').options])
export const MASK_MODES = Object.freeze([...propertyById('mask.mode').options])
/** The scalar Mask channels in engine order (MaskChannel { Feather, Expansion, Opacity }). */
export const MASK_CHANNELS = Object.freeze(
  propertiesOfGroup('mask').filter((p) => p.type === 'scalar').sort((a, b) => a.engineIndex - b.engineIndex).map((p) => p.channel),
)
const CHANNEL_PROP = Object.fromEntries(MASK_CHANNELS.map((c) => [c, propertyById(`mask.${c}`)]))

/** Bezier circle constant: a quarter ellipse's handle length over its radius. */
export const KAPPA = 0.5522847498
/** Defaults when a mask is added from the UI: inset rectangle ±0.4, ellipse radii 0.4. */
export const DEFAULT_RECT_HALF = 0.4
export const DEFAULT_ELLIPSE_RADIUS = 0.4
export const MAX_NAME_LENGTH = 64
/** The largest mask id (the engine stores an int32). */
export const MAX_MASK_ID = 2147483647
/** The largest |coordinate| of a vertex or tangent (cell units); engine LensRoam.cpp kMaxMaskCoord. */
export const MAX_MASK_COORD = 10000
/** Edge flattening of the coverage reference (the engine flattens adaptively, at most 16). */
export const DEFAULT_SEGMENTS_PER_EDGE = 16

const SAME_TICK = 0.5

/** The identity Mask parameters (schema): no feather, no expansion, full opacity, Add, not inverted. */
export const MASK_BASE_IDENTITY = Object.freeze({
  feather: identityOf('mask.feather'),
  expansion: identityOf('mask.expansion'),
  opacity: identityOf('mask.opacity'),
  mode: identityOf('mask.mode'),
  invert: identityOf('mask.invert'),
})

// ── Shapes ───────────────────────────────────────────────────────────────────

const vtx = (x, y, inX = 0, inY = 0, outX = 0, outY = 0) => [x, y, inX, inY, outX, outY]
const copyVertices = (vs) => vs.map((v) => [v[0], v[1], v[2], v[3], v[4], v[5]])

/** A rectangle path: 4 corner vertices TL, TR, BR, BL (clockwise on screen), zero tangents. */
export function makeRectangle({ cx = 0, cy = 0, hw = DEFAULT_RECT_HALF, hh = hw } = {}) {
  return {
    closed: true,
    vertices: [vtx(cx - hw, cy - hh), vtx(cx + hw, cy - hh), vtx(cx + hw, cy + hh), vtx(cx - hw, cy + hh)],
  }
}

/** An ellipse path: 4 vertices top, right, bottom, left with KAPPA tangents (clockwise on screen). */
export function makeEllipse({ cx = 0, cy = 0, rx = DEFAULT_ELLIPSE_RADIUS, ry = rx } = {}) {
  const kx = KAPPA * rx
  const ky = KAPPA * ry
  return {
    closed: true,
    vertices: [
      vtx(cx, cy - ry, -kx, 0, kx, 0),
      vtx(cx + rx, cy, 0, -ky, 0, ky),
      vtx(cx, cy + ry, kx, 0, -kx, 0),
      vtx(cx - rx, cy, 0, ky, 0, -ky),
    ],
  }
}

/**
 * A new mask of `kind` with identity parameters, no keys. A Path starts from
 * `opts.shape` (the pen tool's points) or, without one, from the default rectangle.
 */
export function makeMask(kind, id, name, { shape } = {}) {
  const k = MASK_KINDS.includes(kind) ? kind : 'Rectangle'
  const s = shape
    ? { closed: true, vertices: copyVertices(shape.vertices) }
    : k === 'Ellipse' ? makeEllipse() : makeRectangle()
  return {
    id,
    name: typeof name === 'string' && name ? name : `Mask ${id}`,
    kind: k,
    base: { shape: s, ...MASK_BASE_IDENTITY },
    keys: [],
    shapeKeys: [],
  }
}

/**
 * The id a new mask on this track takes: one more than the largest (1 for the
 * first); past MAX_MASK_ID, the smallest unused positive id.
 */
export function nextMaskId(masks) {
  let max = 0
  const used = new Set()
  for (const m of masks ?? []) {
    if (!Number.isInteger(m?.id)) continue
    used.add(m.id)
    if (m.id > max) max = m.id
  }
  if (max < MAX_MASK_ID) return max + 1
  let id = 1
  while (used.has(id)) id++
  return id
}

/** Mask points on the track in total (each mask counts its base vertices). */
export function maskVertexTotal(masks) {
  let n = 0
  for (const m of masks ?? []) n += m?.base?.shape?.vertices?.length ?? 0
  return n
}

/**
 * Why a mask of `kind` (or `vertexCount` points) cannot be added, or null when it can.
 * The UI disables the action and puts this in its hint (R15).
 */
export function addMaskBlocker(masks, { kind = 'Rectangle', vertexCount } = {}) {
  const list = masks ?? []
  const n = vertexCount ?? (kind === 'Path' ? LIMITS.minVerticesPerMask : 4)
  if (list.length >= LIMITS.maxMasksPerTrack) return `A track holds at most ${LIMITS.maxMasksPerTrack} masks`
  if (maskVertexTotal(list) + n > LIMITS.maxMaskVerticesPerTrack) {
    return `A track holds at most ${LIMITS.maxMaskVerticesPerTrack} mask points in total`
  }
  return null
}

/** Why a point cannot be added to masks[index], or null when it can. */
export function insertVertexBlocker(masks, index) {
  const m = masks?.[index]
  if (!m) return 'No such mask'
  if (m.base.shape.vertices.length >= LIMITS.maxVerticesPerMask) return `A mask holds at most ${LIMITS.maxVerticesPerMask} points`
  if (maskVertexTotal(masks) + 1 > LIMITS.maxMaskVerticesPerTrack) {
    return `A track holds at most ${LIMITS.maxMaskVerticesPerTrack} mask points in total`
  }
  return null
}

/** Why masks[index]'s point cannot be deleted, or null when it can. */
export function deleteVertexBlocker(mask) {
  if (!mask) return 'No such mask'
  if (mask.base.shape.vertices.length <= LIMITS.minVerticesPerMask) return `A mask needs at least ${LIMITS.minVerticesPerMask} points`
  return null
}

// ── Validation (mirror of the strict timeline_setTrackMasks parser) ──────────

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
const fin = (v) => typeof v === 'number' && Number.isFinite(v)
const inCoord = (v) => fin(v) && Math.abs(v) <= MAX_MASK_COORD
const defaultName = (id) => `Mask ${id}`
const codePoints = (s) => [...s].length

function unknownField(obj, allowed, at) {
  for (const f of Object.keys(obj)) {
    if (!allowed.includes(f)) return `${at}: unknown field '${f}' (${allowed.join(', ')})`
  }
  return null
}

function checkVertices(vs, at, expectCount = null) {
  if (!Array.isArray(vs)) return `${at} must be an array of [x, y, inX, inY, outX, outY]`
  const { minVerticesPerMask: lo, maxVerticesPerMask: hi } = LIMITS
  if (vs.length < lo || vs.length > hi) return `${at} must hold ${lo}..${hi} points (has ${vs.length})`
  if (expectCount !== null && vs.length !== expectCount) {
    return `${at} must hold the base's ${expectCount} points (has ${vs.length})`
  }
  for (let i = 0; i < vs.length; i++) {
    const v = vs[i]
    if (!Array.isArray(v) || v.length !== 6 || !v.every(inCoord)) {
      return `${at}[${i}] must be six finite numbers [x, y, inX, inY, outX, outY] with |v| <= ${MAX_MASK_COORD}`
    }
  }
  return null
}

function checkInterp(k, at) {
  if (k.interp !== undefined && !INTERPS.includes(k.interp)) return `${at}: interp must be ${INTERPS.join(' | ')}`
  if (k.bez !== undefined && k.bez !== null && !(Array.isArray(k.bez) && k.bez.length === 4 && k.bez.every(fin))) {
    return `${at}: bez must be [x1, y1, x2, y2], four finite numbers`
  }
  return null
}

function checkScalarField(prop, v, at) {
  if (!fin(v)) return `${at} must be a finite number`
  if (prop.clamp && (v < prop.clamp[0] || v > prop.clamp[1])) return `${at} must be in ${prop.clamp[0]}..${prop.clamp[1]}`
  return null
}

/**
 * One mask against the wire contract (2.2 + R14/R15). Returns { ok, error }.
 * Rules: fields id, name?, kind, base, keys?, shapeKeys? (no others); id a positive
 * integer <= 2147483647; name a string of <= 64 characters (empty = 'Mask <id>');
 * kind Rectangle | Ellipse | Path, and a Rectangle or Ellipse has exactly 4 points;
 * base { shape, feather?, expansion?, opacity?, mode?, invert? } with values inside
 * the schema clamp; shape { closed?: true, vertices: 3..32 x six finite numbers with
 * |v| <= 10000 } (open paths rejected); keys { channel,
 * anchor: 'Origin', pos >= 0, value inside the clamp, interp?, bez? }; shapeKeys
 * { pos >= 0 (one per pos), interp?, bez?, vertices with the base's count }.
 */
export function validateMask(mask, at = 'mask') {
  const fail = (error) => ({ ok: false, error })
  if (!isObj(mask)) return fail(`${at} must be an object`)
  const uf = unknownField(mask, ['id', 'name', 'kind', 'base', 'keys', 'shapeKeys'], at)
  if (uf) return fail(uf)
  if (!Number.isInteger(mask.id) || mask.id <= 0 || mask.id > MAX_MASK_ID) {
    return fail(`${at}.id must be a positive integer (at most ${MAX_MASK_ID})`)
  }
  // An empty (or missing) name is valid: it is stored as 'Mask <id>' (toWire and the engine).
  if (mask.name !== undefined) {
    if (typeof mask.name !== 'string') return fail(`${at}.name must be a string`)
    if (codePoints(mask.name) > MAX_NAME_LENGTH) return fail(`${at}.name must be at most ${MAX_NAME_LENGTH} characters`)
  }
  if (!MASK_KINDS.includes(mask.kind)) return fail(`${at}.kind must be ${MASK_KINDS.join(' | ')}`)

  const base = mask.base
  if (!isObj(base)) return fail(`${at}.base must be an object`)
  const ub = unknownField(base, ['shape', 'feather', 'expansion', 'opacity', 'mode', 'invert'], `${at}.base`)
  if (ub) return fail(ub)
  const shape = base.shape
  if (!isObj(shape)) return fail(`${at}.base.shape must be an object`)
  const us = unknownField(shape, ['closed', 'vertices'], `${at}.base.shape`)
  if (us) return fail(us)
  if (shape.closed !== undefined && shape.closed !== true) return fail(`${at}.base.shape.closed must be true (open paths are not supported)`)
  const vErr = checkVertices(shape.vertices, `${at}.base.shape.vertices`)
  if (vErr) return fail(vErr)
  const count = shape.vertices.length
  if ((mask.kind === 'Rectangle' || mask.kind === 'Ellipse') && count !== 4) {
    const article = mask.kind === 'Ellipse' ? 'an' : 'a'
    return fail(`${at}: ${article} ${mask.kind} has exactly 4 points (has ${count}); edit it as a Path`)
  }
  for (const ch of MASK_CHANNELS) {
    if (base[ch] === undefined) continue
    const e = checkScalarField(CHANNEL_PROP[ch], base[ch], `${at}.base.${ch}`)
    if (e) return fail(e)
  }
  if (base.mode !== undefined && !MASK_MODES.includes(base.mode)) return fail(`${at}.base.mode must be ${MASK_MODES.join(' | ')}`)
  if (base.invert !== undefined && typeof base.invert !== 'boolean') return fail(`${at}.base.invert must be a boolean`)

  if (mask.keys !== undefined) {
    if (!Array.isArray(mask.keys)) return fail(`${at}.keys must be an array`)
    for (let i = 0; i < mask.keys.length; i++) {
      const k = mask.keys[i]
      const kat = `${at}.keys[${i}]`
      if (!isObj(k)) return fail(`${kat} must be an object`)
      const uk = unknownField(k, ['channel', 'anchor', 'pos', 'value', 'interp', 'bez'], kat)
      if (uk) return fail(uk)
      if (!MASK_CHANNELS.includes(k.channel)) return fail(`${kat}: channel must be ${MASK_CHANNELS.join(' | ')}`)
      if (k.anchor !== 'Origin') return fail(`${kat}: anchor must be 'Origin' (a Mask key is timeline ticks)`)
      if (!fin(k.pos) || k.pos < 0) return fail(`${kat}: pos must be a finite number >= 0`)
      const ve = checkScalarField(CHANNEL_PROP[k.channel], k.value, `${kat}.value`)
      if (ve) return fail(ve)
      const ie = checkInterp(k, kat)
      if (ie) return fail(ie)
    }
  }

  if (mask.shapeKeys !== undefined) {
    if (!Array.isArray(mask.shapeKeys)) return fail(`${at}.shapeKeys must be an array`)
    const seen = []
    for (let i = 0; i < mask.shapeKeys.length; i++) {
      const k = mask.shapeKeys[i]
      const kat = `${at}.shapeKeys[${i}]`
      if (!isObj(k)) return fail(`${kat} must be an object`)
      const uk = unknownField(k, ['pos', 'interp', 'bez', 'vertices'], kat)
      if (uk) return fail(uk)
      if (!fin(k.pos) || k.pos < 0) return fail(`${kat}: pos must be a finite number >= 0`)
      if (seen.includes(k.pos)) return fail(`${kat}: a second shape key at pos ${k.pos} (one per pos)`)
      seen.push(k.pos)
      const ie = checkInterp(k, kat)
      if (ie) return fail(ie)
      const ve = checkVertices(k.vertices, `${kat}.vertices`, count)
      if (ve) return fail(ve)
    }
  }
  return { ok: true, error: null }
}

/**
 * A track's whole mask list (the timeline_setTrackMasks argument): every mask
 * valid, at most 8 masks, ids unique, at most 64 base points in total. { ok, error }.
 */
export function validateMasks(masks) {
  if (!Array.isArray(masks)) return { ok: false, error: 'masks must be an array' }
  if (masks.length > LIMITS.maxMasksPerTrack) {
    return { ok: false, error: `a track holds at most ${LIMITS.maxMasksPerTrack} masks (got ${masks.length})` }
  }
  const ids = new Set()
  for (let i = 0; i < masks.length; i++) {
    const r = validateMask(masks[i], `masks[${i}]`)
    if (!r.ok) return r
    if (ids.has(masks[i].id)) return { ok: false, error: `masks[${i}].id ${masks[i].id} is used twice` }
    ids.add(masks[i].id)
  }
  const total = maskVertexTotal(masks)
  if (total > LIMITS.maxMaskVerticesPerTrack) {
    return { ok: false, error: `a track holds at most ${LIMITS.maxMaskVerticesPerTrack} mask points in total (got ${total})` }
  }
  return { ok: true, error: null }
}

// ── Wire ─────────────────────────────────────────────────────────────────────

function wireKey(k) {
  const interp = INTERPS.includes(k.interp) ? k.interp : 'Linear'
  const out = { channel: k.channel, anchor: 'Origin', pos: k.pos, value: k.value, interp }
  if (interp === 'Bezier') out.bez = sanitizeBez(k.bez)
  return out
}

function wireShapeKey(k) {
  const interp = INTERPS.includes(k.interp) ? k.interp : 'Linear'
  const out = { pos: k.pos, interp }
  if (interp === 'Bezier') out.bez = sanitizeBez(k.bez)
  out.vertices = copyVertices(k.vertices)
  return out
}

/**
 * A clean copy in wire form: known fields only, every base field present, keys in
 * wire form (bez only on Bezier keys), shape keys sorted by pos. Does not validate.
 */
export function toWire(mask) {
  const b = mask.base ?? {}
  return {
    id: mask.id,
    name: typeof mask.name === 'string' && mask.name ? mask.name : defaultName(mask.id),
    kind: mask.kind,
    base: {
      shape: { closed: true, vertices: copyVertices(b.shape?.vertices ?? []) },
      feather: b.feather ?? MASK_BASE_IDENTITY.feather,
      expansion: b.expansion ?? MASK_BASE_IDENTITY.expansion,
      opacity: b.opacity ?? MASK_BASE_IDENTITY.opacity,
      mode: b.mode ?? MASK_BASE_IDENTITY.mode,
      invert: b.invert ?? MASK_BASE_IDENTITY.invert,
    },
    keys: (mask.keys ?? []).map(wireKey),
    shapeKeys: sortEventKeys(mask.shapeKeys ?? []).map(wireShapeKey),
  }
}

/** The whole list in wire form. */
export const toWireList = (masks) => (masks ?? []).map(toWire)

function readVertex(v) {
  if (!Array.isArray(v)) return null
  const n = (i) => (fin(v[i]) ? v[i] : 0)
  if (!fin(v[0]) || !fin(v[1])) return null
  const out = [v[0], v[1], n(2), n(3), n(4), n(5)]
  // Past the coordinate bound the engine drops the mask (or shape key): so do we.
  return out.every(inCoord) ? out : null
}

function readVertices(vs) {
  if (!Array.isArray(vs)) return null
  const out = []
  for (const v of vs) {
    const r = readVertex(v)
    if (!r) return null
    out.push(r)
  }
  return out
}

/**
 * A mask as the engine returned it (getLensRoam / setTrackMasks post-state), read
 * TOLERANTLY: missing fields take the identity, unusable keys are dropped, shape
 * keys whose point count differs from the base are dropped. null when the mask has
 * no usable id or shape.
 */
export function fromWire(obj) {
  if (!isObj(obj) || !Number.isInteger(obj.id) || obj.id <= 0 || obj.id > MAX_MASK_ID) return null
  const b = isObj(obj.base) ? obj.base : {}
  const vertices = readVertices(b.shape?.vertices)
  if (!vertices || vertices.length < LIMITS.minVerticesPerMask) return null
  const pick = (ch) => (fin(b[ch]) ? clampValue(CHANNEL_PROP[ch], b[ch]) : MASK_BASE_IDENTITY[ch])
  let kind = MASK_KINDS.includes(obj.kind) ? obj.kind : 'Path'
  if (kind !== 'Path' && vertices.length !== 4) kind = 'Path'
  const keys = []
  for (const k of Array.isArray(obj.keys) ? obj.keys : []) {
    if (!isObj(k) || !MASK_CHANNELS.includes(k.channel) || !fin(k.pos) || k.pos < 0 || !fin(k.value)) continue
    keys.push(wireKey({ ...k, value: clampValue(CHANNEL_PROP[k.channel], k.value) }))
  }
  const shapeKeys = []
  for (const k of Array.isArray(obj.shapeKeys) ? obj.shapeKeys : []) {
    if (!isObj(k) || !fin(k.pos) || k.pos < 0) continue
    const vs = readVertices(k.vertices)
    if (!vs || vs.length !== vertices.length) continue
    if (shapeKeys.some((s) => s.pos === k.pos)) continue
    shapeKeys.push(wireShapeKey({ ...k, vertices: vs }))
  }
  return {
    id: obj.id,
    name: typeof obj.name === 'string' && obj.name ? obj.name : `Mask ${obj.id}`,
    kind,
    base: {
      shape: { closed: true, vertices },
      feather: pick('feather'),
      expansion: pick('expansion'),
      opacity: pick('opacity'),
      mode: MASK_MODES.includes(b.mode) ? b.mode : MASK_BASE_IDENTITY.mode,
      invert: typeof b.invert === 'boolean' ? b.invert : MASK_BASE_IDENTITY.invert,
    },
    keys,
    shapeKeys: sortEventKeys(shapeKeys),
  }
}

/** A track's mask list read tolerantly (unusable masks dropped). */
export function fromWireList(arr) {
  if (!Array.isArray(arr)) return []
  return arr.map(fromWire).filter(Boolean)
}

// ── Evaluation at a tick (mirror of LensRoamSnapshot::masksAt) ───────────────

/** One scalar channel of a mask at a timeline tick: keyed follows its keys, else the base. */
export function maskScalarAt(mask, channel, tick) {
  const base = mask.base?.[channel] ?? MASK_BASE_IDENTITY[channel]
  const ks = sortEventKeys((mask.keys ?? []).filter((k) => k.channel === channel))
  const v = ks.length > 0 ? valueAtEvent(ks, tick, base) : base
  return clampValue(CHANNEL_PROP[channel], v)
}

const lerp = (a, b, f) => a + (b - a) * f

/**
 * The mask's shape at a timeline tick (R14): the base when it has no shape keys;
 * before the first key the first key's shape, after the last the last's; between
 * two keys every vertex and tangent lerps by the LEAVING key's eased fraction
 * (Hold keeps the leaving key's shape). Returns new vertex arrays.
 */
export function shapeAt(mask, tick) {
  const keys = sortEventKeys(mask.shapeKeys ?? [])
  const n = keys.length
  if (n === 0) return copyVertices(mask.base.shape.vertices)
  if (!(tick >= keys[0].pos)) return copyVertices(keys[0].vertices)
  let lo = 1
  let hi = n
  while (lo < hi) {
    const mid = lo + ((hi - lo) >> 1)
    if (keys[mid].pos <= tick) lo = mid + 1
    else hi = mid
  }
  if (lo >= n) return copyVertices(keys[n - 1].vertices)
  const a = keys[lo - 1]
  const b = keys[lo]
  if (a.interp === 'Hold') return copyVertices(a.vertices)
  const f = segmentEase(a, (tick - a.pos) / (b.pos - a.pos))
  return a.vertices.map((va, i) => {
    const vb = b.vertices[i]
    return [lerp(va[0], vb[0], f), lerp(va[1], vb[1], f), lerp(va[2], vb[2], f),
      lerp(va[3], vb[3], f), lerp(va[4], vb[4], f), lerp(va[5], vb[5], f)]
  })
}

/**
 * Everything a mask contributes at a timeline tick:
 *   { vertices, feather, expansion, opacity, mode, invert }
 * Scalars are clamped to the schema clamp after evaluation (a Bezier overshoot
 * never takes opacity past 1).
 */
export function evaluateMask(mask, tick) {
  return {
    vertices: shapeAt(mask, tick),
    feather: maskScalarAt(mask, 'feather', tick),
    expansion: maskScalarAt(mask, 'expansion', tick),
    opacity: maskScalarAt(mask, 'opacity', tick),
    mode: MASK_MODES.includes(mask.base?.mode) ? mask.base.mode : MASK_BASE_IDENTITY.mode,
    invert: !!mask.base?.invert,
  }
}

/** Every mask of a track at a tick, top to bottom (the R12 order). */
export const evaluateMasks = (masks, tick) => (masks ?? []).map((m) => evaluateMask(m, tick))

// ── Key edits (pure; every result is a new mask) ─────────────────────────────

/** Is the mask's shape animated (has shape keys)? */
export const isShapeAnimated = (mask) => (mask?.shapeKeys?.length ?? 0) > 0

/**
 * Set the shape at `tick`: the shape key within half a tick is replaced (its
 * interp / bez kept unless given), else one is added. `vertices` must have the
 * base's count (insert or delete points across every key first).
 */
export function upsertShapeKey(mask, tick, vertices, { interp, bez } = {}) {
  const count = mask.base.shape.vertices.length
  if (!Array.isArray(vertices) || vertices.length !== count) {
    throw new Error(`upsertShapeKey: a shape key needs the base's ${count} points (got ${vertices?.length})`)
  }
  const pos = Math.max(0, Math.round(tick))
  const keys = mask.shapeKeys ?? []
  const i = keys.findIndex((k) => Math.abs(k.pos - pos) < SAME_TICK)
  const prev = i >= 0 ? keys[i] : null
  const nextInterp = interp ?? prev?.interp ?? 'Linear'
  const key = wireShapeKey({ pos: prev ? prev.pos : pos, interp: nextInterp, bez: bez ?? prev?.bez, vertices })
  const list = i >= 0 ? keys.map((k, j) => (j === i ? key : k)) : [...keys, key]
  return { ...mask, shapeKeys: sortEventKeys(list) }
}

/** Remove the shape key at `tick` (within half a tick). */
export function removeShapeKey(mask, tick) {
  const keys = mask.shapeKeys ?? []
  const next = keys.filter((k) => Math.abs(k.pos - tick) >= SAME_TICK)
  return next.length === keys.length ? mask : { ...mask, shapeKeys: next }
}

/**
 * Set a scalar channel's value at `tick`: the key within half a tick is updated
 * (interp kept unless given), else one is added. The value is clamped to the schema.
 */
export function upsertMaskKey(mask, { channel, pos, value, interp, bez }) {
  if (!MASK_CHANNELS.includes(channel)) throw new Error(`upsertMaskKey: unknown channel '${channel}'`)
  const p = Math.max(0, Math.round(pos))
  const v = clampValue(CHANNEL_PROP[channel], value)
  const keys = mask.keys ?? []
  const i = keys.findIndex((k) => k.channel === channel && Math.abs(k.pos - p) < SAME_TICK)
  if (i < 0) return { ...mask, keys: [...keys, wireKey({ channel, pos: p, value: v, interp: interp ?? 'Linear', bez })] }
  const prev = keys[i]
  const key = wireKey({ ...prev, value: v, interp: interp ?? prev.interp, bez: bez ?? prev.bez })
  return { ...mask, keys: keys.map((k, j) => (j === i ? key : k)) }
}

/** The mask with every key of `channel` removed and its base set to `value` (stopwatch OFF, R3). */
export function clearMaskChannelKeys(mask, channel, value) {
  const keys = (mask.keys ?? []).filter((k) => k.channel !== channel)
  const base = { ...mask.base }
  if (value !== undefined) base[channel] = clampValue(CHANNEL_PROP[channel], value)
  return { ...mask, keys, base }
}

/** The mask with no shape keys and its base shape set to `vertices` (shape stopwatch OFF, R3). */
export function clearShapeKeys(mask, vertices) {
  const vs = vertices ? copyVertices(vertices) : copyVertices(mask.base.shape.vertices)
  return { ...mask, shapeKeys: [], base: { ...mask.base, shape: { closed: true, vertices: vs } } }
}

// ── Vertex insert / delete across the base and every shape key (R14) ────────

const isStraightEdge = (a, b) => a[4] === 0 && a[5] === 0 && b[2] === 0 && b[3] === 0

/**
 * Split edge `edgeIndex` (vertex i -> i+1, wrapping) of ONE vertex list at the
 * bezier parameter t with de Casteljau. A straight edge (both handles zero) gets
 * a corner vertex at the curve point; a curved edge gets a smooth vertex and the
 * neighbours' handles shortened, so the drawn path does not change.
 */
export function splitEdge(vertices, edgeIndex, t) {
  const n = vertices.length
  const i = ((edgeIndex % n) + n) % n
  const j = (i + 1) % n
  const a = vertices[i]
  const b = vertices[j]
  const p0 = [a[0], a[1]]
  const p1 = [a[0] + a[4], a[1] + a[5]]
  const p2 = [b[0] + b[2], b[1] + b[3]]
  const p3 = [b[0], b[1]]
  const L = (u, v) => [lerp(u[0], v[0], t), lerp(u[1], v[1], t)]
  const q0 = L(p0, p1)
  const q1 = L(p1, p2)
  const q2 = L(p2, p3)
  const r0 = L(q0, q1)
  const r1 = L(q1, q2)
  const s = L(r0, r1)
  const out = copyVertices(vertices)
  let mid
  if (isStraightEdge(a, b)) {
    mid = [s[0], s[1], 0, 0, 0, 0]
  } else {
    out[i] = [a[0], a[1], a[2], a[3], q0[0] - p0[0], q0[1] - p0[1]]
    out[j] = [b[0], b[1], q2[0] - p3[0], q2[1] - p3[1], b[4], b[5]]
    mid = [s[0], s[1], r0[0] - s[0], r0[1] - s[1], r1[0] - s[0], r1[1] - s[1]]
  }
  out.splice(i + 1, 0, mid)
  return out
}

/**
 * Insert a point on edge `edgeIndex` at parameter t in the base AND every shape
 * key (same parametric position in each), so an animated path keeps one point
 * count. The mask becomes a Path. null when the mask is at its point cap.
 */
export function insertVertexAll(mask, edgeIndex, t) {
  if (mask.base.shape.vertices.length >= LIMITS.maxVerticesPerMask) return null
  const tt = Math.min(1, Math.max(0, Number.isFinite(t) ? t : 0.5))
  return {
    ...mask,
    kind: 'Path',
    base: { ...mask.base, shape: { closed: true, vertices: splitEdge(mask.base.shape.vertices, edgeIndex, tt) } },
    shapeKeys: (mask.shapeKeys ?? []).map((k) => ({ ...k, vertices: splitEdge(k.vertices, edgeIndex, tt) })),
  }
}

/** Delete point `index` from the base and every shape key. The mask becomes a Path. null below 3 points. */
export function deleteVertexAll(mask, index) {
  const n = mask.base.shape.vertices.length
  if (n <= LIMITS.minVerticesPerMask || index < 0 || index >= n) return null
  const drop = (vs) => vs.filter((_, i) => i !== index).map((v) => [...v])
  return {
    ...mask,
    kind: 'Path',
    base: { ...mask.base, shape: { closed: true, vertices: drop(mask.base.shape.vertices) } },
    shapeKeys: (mask.shapeKeys ?? []).map((k) => ({ ...k, vertices: drop(k.vertices) })),
  }
}

/** A Rectangle or Ellipse as a Path with the same points (editing one vertex converts it, R14). */
export function convertToPath(mask) {
  return mask.kind === 'Path' ? mask : { ...mask, kind: 'Path' }
}

/**
 * A shape with every point mapped by fn([x, y]) -> [x', y']. Handles are mapped
 * by their END points and made relative again, so any affine map (move, scale,
 * rotate a selection) transforms the curve exactly.
 */
export function transformShape(shape, fn) {
  const vertices = shape.vertices.map((v) => {
    const [x, y] = fn([v[0], v[1]])
    const [ix, iy] = fn([v[0] + v[2], v[1] + v[3]])
    const [ox, oy] = fn([v[0] + v[4], v[1] + v[5]])
    return [x, y, ix - x, iy - y, ox - x, oy - y]
  })
  return { closed: true, vertices }
}

/** The axis-aligned bounds of a shape's points (not its handles): { x, y, w, h }. */
export function shapeBounds(shape) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
  for (const v of shape.vertices) {
    x0 = Math.min(x0, v[0]); y0 = Math.min(y0, v[1]); x1 = Math.max(x1, v[0]); y1 = Math.max(y1, v[1])
  }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }
}

/** The cubic bezier point of one edge at t. */
export function edgePoint(vertices, edgeIndex, t) {
  const n = vertices.length
  const i = ((edgeIndex % n) + n) % n
  const a = vertices[i]
  const b = vertices[(i + 1) % n]
  const mt = 1 - t
  const w0 = mt * mt * mt
  const w1 = 3 * mt * mt * t
  const w2 = 3 * mt * t * t
  const w3 = t * t * t
  return [
    w0 * a[0] + w1 * (a[0] + a[4]) + w2 * (b[0] + b[2]) + w3 * b[0],
    w0 * a[1] + w1 * (a[1] + a[5]) + w2 * (b[1] + b[3]) + w3 * b[1],
  ]
}

/**
 * The closed path as a polygon [[x, y], ...] (implicitly closed): each straight
 * edge contributes its start point, each curved edge its start point plus
 * segmentsPerEdge - 1 interior samples.
 */
export function flattenShape(shape, segmentsPerEdge = DEFAULT_SEGMENTS_PER_EDGE) {
  const vs = shape.vertices
  const n = vs.length
  const segs = Math.max(1, Math.floor(segmentsPerEdge))
  const out = []
  for (let i = 0; i < n; i++) {
    const a = vs[i]
    const b = vs[(i + 1) % n]
    out.push([a[0], a[1]])
    if (isStraightEdge(a, b)) continue
    for (let s = 1; s < segs; s++) out.push(edgePoint(vs, i, s / segs))
  }
  return out
}

/**
 * The edge and parameter nearest to a cell-space point, for "Ctrl+click on an
 * edge adds a vertex": { edgeIndex, t, distance } (distance in cell units, measured
 * in the given pixel aspect when `cellPx` is passed).
 */
export function nearestEdge(shape, x, y, { cellPx = { w: 1, h: 1 }, samples = 32 } = {}) {
  const vs = shape.vertices
  let best = { edgeIndex: -1, t: 0, distance: Infinity }
  for (let i = 0; i < vs.length; i++) {
    for (let s = 0; s <= samples; s++) {
      const t = s / samples
      const [px, py] = edgePoint(vs, i, t)
      const d = Math.hypot((px - x) * cellPx.w, (py - y) * cellPx.h)
      if (d < best.distance) best = { edgeIndex: i, t, distance: d }
    }
  }
  return best
}

// ── Coverage reference (R12): what the FX_Mask pass computes per texel ──────

const smoothstep = (e0, e1, x) => {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)))
  return t * t * (3 - 2 * t)
}

/** Nonzero winding number of a polygon around a point. */
export function windingNumber(poly, px, py) {
  let w = 0
  const n = poly.length
  for (let i = 0; i < n; i++) {
    const [x0, y0] = poly[i]
    const [x1, y1] = poly[(i + 1) % n]
    const side = (x1 - x0) * (py - y0) - (px - x0) * (y1 - y0)
    if (y0 <= py) {
      if (y1 > py && side > 0) w++
    } else if (y1 <= py && side < 0) {
      w--
    }
  }
  return w
}

function distanceToPolygon(poly, px, py) {
  let best = Infinity
  const n = poly.length
  for (let i = 0; i < n; i++) {
    const [x0, y0] = poly[i]
    const [x1, y1] = poly[(i + 1) % n]
    const dx = x1 - x0
    const dy = y1 - y0
    const len2 = dx * dx + dy * dy
    const u = len2 > 0 ? Math.min(1, Math.max(0, ((px - x0) * dx + (py - y0) * dy) / len2)) : 0
    const d = Math.hypot(px - (x0 + u * dx), py - (y0 + u * dy))
    if (d < best) best = d
  }
  return best
}

/**
 * One mask's coverage at a cell-space point (before invert / opacity / mode):
 * signed distance in PIXELS to the flattened path (positive inside, nonzero
 * winding), pushed out by expansion x shorter side, then
 *   c = smoothstep(-w/2, +w/2, sd),  w = max(feather x shorter side, 1 px)
 * (feather centred on the edge; a 1 px anti-aliased edge when feather is 0).
 */
export function shapeCoverage(frame, x, y, cellPx, segmentsPerEdge = DEFAULT_SEGMENTS_PER_EDGE) {
  const W = cellPx?.w > 0 ? cellPx.w : 1
  const H = cellPx?.h > 0 ? cellPx.h : 1
  const short = Math.min(W, H)
  const poly = flattenShape({ vertices: frame.vertices }, segmentsPerEdge).map(([u, v]) => [u * W, v * H])
  const px = x * W
  const py = y * H
  const inside = windingNumber(poly, px, py) !== 0
  const dist = distanceToPolygon(poly, px, py)
  const sd = (inside ? dist : -dist) + (frame.expansion ?? 0) * short
  const w = Math.max((frame.feather ?? 0) * short, 1)
  return smoothstep(-w / 2, w / 2, sd)
}

/**
 * The R12 combination of a track's evaluated masks (evaluateMasks) at a
 * cell-space point; 1 when there are none. Top to bottom, start 0 when the first
 * mask with any opacity is Add, else 1 (opacity 0 = no effect, so such a mask
 * does not pick the start either: render/MaskMath.h maskStart); per mask
 * c = coverage, c = invert ? 1 - c : c, o = opacity:
 *   Add:       acc = acc + o*c - acc*o*c
 *   Subtract:  acc = acc * (1 - o*c)
 *   Intersect: acc = acc * (1 - o*(1 - c))
 * `cellPx` = the drawn cell's size in pixels { w, h }.
 */
export function coverageAt(maskFrames, x, y, cellPx, segmentsPerEdge = DEFAULT_SEGMENTS_PER_EDGE) {
  const frames = maskFrames ?? []
  if (frames.length === 0) return 1
  const opacityOf = (f) => Math.min(1, Math.max(0, f.opacity ?? 1))
  const lead = frames.find((f) => opacityOf(f) > 0)
  let acc = lead && lead.mode === 'Add' ? 0 : 1
  for (const f of frames) {
    let c = shapeCoverage(f, x, y, cellPx, segmentsPerEdge)
    if (f.invert) c = 1 - c
    const o = opacityOf(f)
    if (f.mode === 'Subtract') acc = acc * (1 - o * c)
    else if (f.mode === 'Intersect') acc = acc * (1 - o * (1 - c))
    else acc = acc + o * c - acc * o * c
  }
  return Math.min(1, Math.max(0, acc))
}
