// Motion view key editing, the pure half (docs/XLETH_MOTION_VIEW_DESIGN.md 5.4, R3,
// R5, R20, R22): what a key gesture or a key command WRITES. No React, no store, no
// IPC: the gesture (components/motionView/motionGesture.js) keeps a local draft
// while the pointer moves and turns it into ONE motion plan on pointerup.
//
// A selected key is a key INSTANCE (providers/common.js): { id, tick, value, interp,
// bez, hollow, ref, key }. Its ref names what an edit addresses, and refTarget(ref)
// its EDIT identity: one hit-curve key is drawn under every note (many instances)
// but is one target, so every edit here works per target.
//
// Position domains (how a tick becomes a key pos):
//   timeline   Roam, Sweep, Mask scalar, Mask shape,   pos = tick (whole ticks, >= 0)
//              Trail opacity
//   clip       clip Lens (R22)                         pos = tick - clip start (>= 0)
//   note       hit curve, a note's own keys (R5)       anchor kept; pos = the place of
//                                                      (tick - note-on) in that anchor's
//                                                      zone (lensKeyModel.positionAtNoteTime)
//
// planKeyEdits(data, edits) is the one writer: every move, value change, interp
// change and delete becomes per-list edits, collisions resolved (a moved key
// replaces a key already at its new place), and one write per list:
//   roamKeys / sweepKeys / clipLensKeys / hitCurve / notesLensKeys / masks / cloneSettings
// Deleting the last key of a BASE-BACKED channel (Roam, clip Lens, Mask scalar,
// Mask shape, Trail opacity) also sets the base to the value at `foldTick` in the
// same plan (R3: nothing jumps at the playhead). Layers (Sweep, hit curve, note
// keys) just go.

import {
  DEFAULT_BEZ, DEFAULT_ZONES, anchorOffset, keyEquals, keysOfChannel, layerIdentity, makeKey, normalizeZones, noteSpan,
  positionAtNoteTime, sanitizeBez, sortEventKeys, sortNoteKeys, valueAtEvent, valueAtNote, zoneSpan,
} from '../lensRoam/lensKeyModel.js'
import { resolveRoamAt } from '../lensRoam/roamKeyModel.js'
import { ROAM_IDENTITY, LENS_IDENTITY } from '../lensRoam/lensRoamModel.js'
import { propertyById } from './schema.js'
import { maskScalarAt, shapeAt, toWireList } from './maskModel.js'
import { trailOpacityValueAt } from './cloneMotion.js'
import { fxPropId, parseFxChannel } from './fxModel.js'
import { SAME_TICK, clampFor, clampLayer, layerBetween } from './providers/common.js'
import { propNodesUnder, refTarget, rowKeyTicks, rowKeys, summaryTicks, tickRange } from './rowRegistry.js'

const fin = (v) => typeof v === 'number' && Number.isFinite(v)
const NONE = Object.freeze([])

// ── Refs ─────────────────────────────────────────────────────────────────────

/** Is the key note-relative (hit curve or a note's own key)? */
export const isNoteRef = (ref) => ref?.kind === 'hit' || ref?.kind === 'note'
/** Is the key timeline-absolute (Roam, Sweep, Mask, Trail opacity)? */
export const isTimelineRef = (ref) => ref?.kind === 'roam' || ref?.kind === 'sweep' || ref?.kind === 'mask' || ref?.kind === 'maskShape'
  || ref?.kind === 'trailOpacity' || ref?.kind === 'fx'

/** The schema property id a key ref belongs to ('roam.offsetX', 'sourceLens.zoom', 'mask.shape'...). */
export function propIdOf(ref) {
  switch (ref?.kind) {
    case 'roam': return `roam.${ref.channel}`
    case 'sweep': return `sweep.${ref.channel}`
    case 'clipLens': return `clipLens.${ref.channel}`
    case 'hit':
    case 'note': return `sourceLens.${ref.channel}`
    case 'mask': return `mask.${ref.channel}`
    case 'maskShape': return 'mask.shape'
    case 'trailOpacity': return 'trail.opacity'
    case 'fx': return fxPropId(ref.type, ref.param)
    default: return null
  }
}

/** Is a key a layer value (Sweep, hit curve, a note's own key) rather than an absolute one? */
export const isLayerRef = (ref) => ref?.kind === 'sweep' || isNoteRef(ref)

/** A key value the engine accepts for this ref (schema clamp, or the layer range for layers). */
export function clampRefValue(ref, v) {
  const prop = propertyById(propIdOf(ref))
  if (!prop || prop.type !== 'scalar') return v
  return isLayerRef(ref) ? clampLayer(prop, v) : clampFor(prop.id)(v)
}

/** The zones a note-relative key plays on: the source's, or the defaults for an Own note. */
export function zonesOfRef(data, ref) {
  if (ref.kind === 'note' && ref.mode === 'Own') return DEFAULT_ZONES
  return data.sourceOf(ref.trackId, ref.regionId)?.zones ?? DEFAULT_ZONES
}

/** The note span a note-relative instance is drawn in. */
export const spanOfRef = (data, ref) => noteSpan(ref.noteEnd - ref.noteStart, zonesOfRef(data, ref))

/** The clip a clip-Lens ref belongs to, or null. */
export function clipOfRef(data, ref) {
  for (const c of data.clipsByTrack?.get(ref.trackId) ?? NONE) if (c.id === ref.clipId) return c
  return null
}

/** The note object of a { patternId, noteId }, or null. */
export function noteOf(data, patternId, noteId) {
  const notes = data.patterns?.[patternId]?.notes
  if (!Array.isArray(notes)) return null
  for (const n of notes) if (n?.id === noteId) return n
  return null
}

/** The lowest tick an instance's key can move to (timeline 0, clip start). Note keys clamp themselves. */
export function minTickOf(inst) {
  if (inst.ref.kind === 'clipLens') return inst.tick - inst.ref.pos
  if (isNoteRef(inst.ref)) return -Infinity
  return 0
}

/** Where an instance draws once its key's pos is `pos`. */
export function tickOfPos(data, inst, pos) {
  const ref = inst.ref
  if (isNoteRef(ref)) return ref.noteStart + anchorOffset(spanOfRef(data, ref), ref.anchor, pos)
  if (ref.kind === 'clipLens') return inst.tick - ref.pos + pos
  return pos
}

const roundPos = (anchor, pos) => (anchor === 'Body' ? Math.round(pos * 1e4) / 1e4 : Math.round(pos))

/**
 * Does a note span give `anchor` its whole pos range? Not a Squash short note's Body
 * (no length), nor a Cut short note's Head (clipped at tail-start) or Tail (shorter
 * than the tail zone): moving a key in such a zone would clamp its pos to the edge.
 */
export function zoneCovers(span, anchor) {
  if (anchor === 'Body') return span.tailStart > span.headEnd
  if (anchor === 'Tail') return positionAtNoteTime(span, 'Tail', span.tailStart) >= span.tailTicks - 1e-6
  return positionAtNoteTime(span, 'Head', span.headEnd) >= span.headTicks - 1e-6
}

/**
 * The note span a note-relative key's move is MEASURED in (null: the key keeps its pos).
 * The instance's own note when it gives the anchor its whole range. Otherwise a short
 * note's clamp would rewrite the key (for a hit-curve key, under EVERY note): a
 * hit-curve key takes the longest note it is drawn under that has the room (`index`);
 * a Head / Tail key with none takes an unsquashed note of exactly Head + Tail; a Body
 * key with none (every note too short to play a Body) keeps its pos.
 */
export function noteMoveSpan(data, inst, index = null) {
  const ref = inst.ref
  const own = spanOfRef(data, ref)
  if (zoneCovers(own, ref.anchor)) return own
  if (ref.kind === 'hit' && index) {
    let best = null
    for (const i of index.byTarget.get(refTarget(ref)) ?? NONE) {
      const len = i.ref.noteEnd - i.ref.noteStart
      if (best && !(len > best.noteLen)) continue
      const s = spanOfRef(data, i.ref)
      if (zoneCovers(s, ref.anchor)) best = s
    }
    if (best) return best
  }
  if (ref.anchor === 'Body') return null
  const z = normalizeZones(zonesOfRef(data, ref))
  return noteSpan(z.headTicks + z.tailTicks, z)
}

/**
 * The key pos that puts an instance at `tick`. `snapNote(span, anchor, noteTime) -> pos`
 * snaps note-relative keys (motionSnap.snapNotePos); without it they take the exact place.
 * A note-relative key moves by (tick - inst.tick) inside its move span (noteMoveSpan;
 * `index` lets a hit-curve key under a short note use a longer note); not moved and
 * not snapped, it keeps its exact pos.
 */
export function posAtTick(data, inst, tick, { snapNote = null, index = null } = {}) {
  const ref = inst.ref
  if (isNoteRef(ref)) {
    if (tick === inst.tick && !snapNote) return ref.pos
    const span = noteMoveSpan(data, inst, index)
    if (!span) return ref.pos
    const t = anchorOffset(span, ref.anchor, ref.pos) + (tick - inst.tick)
    return snapNote ? snapNote(span, ref.anchor, t) : roundPos(ref.anchor, positionAtNoteTime(span, ref.anchor, t))
  }
  if (ref.kind === 'clipLens') return Math.max(0, Math.round(tick - (inst.tick - ref.pos)))
  return Math.max(0, Math.round(tick))
}

// ── The key index (every key of every track, by id and by edit target) ────────

const indexCache = new WeakMap()   // data -> { trees, index }

function* treeProps(layout) {
  for (const tree of layout?.trees?.values() ?? []) {
    for (const pn of propNodesUnder(tree)) {
      yield { key: pn.key, prop: pn.prop, provider: pn.provider, target: pn.target, trackId: tree.trackId, node: pn }
    }
  }
}

/**
 * Every key instance of every track (expanded or not), by id and by edit target.
 * Built once per (data, layout trees).
 * @returns {{ byId: Map<id, { inst, row }>, byTarget: Map<target, inst[]> }}
 */
export function buildKeyIndex(layout, data) {
  if (!data || !layout) return { byId: new Map(), byTarget: new Map() }
  const hit = indexCache.get(data)
  if (hit && hit.trees === layout.trees) return hit.index
  const byId = new Map()
  const byTarget = new Map()
  for (const row of treeProps(layout)) {
    for (const inst of rowKeys(row, data)) {
      byId.set(inst.id, { inst, row })
      const t = refTarget(inst.ref)
      let arr = byTarget.get(t)
      if (!arr) { arr = []; byTarget.set(t, arr) }
      arr.push(inst)
    }
  }
  const index = { byId, byTarget }
  indexCache.set(data, { trees: layout.trees, index })
  return index
}

/** The selected instances that still exist, in selection order. */
export function selectedInstances(index, keySel) {
  const out = []
  for (const id of keySel?.keys?.() ?? NONE) {
    const e = index.byId.get(id)
    if (e) out.push(e.inst)
  }
  return out
}

/** One instance per edit target (the first seen, or `primary` for its own target). */
export function dedupeByTarget(instances, primary = null) {
  const out = new Map()
  const pt = primary ? refTarget(primary.ref) : null
  for (const inst of instances) {
    const t = refTarget(inst.ref)
    if (!out.has(t)) out.set(t, t === pt ? primary : inst)
  }
  if (primary && !out.has(pt)) out.set(pt, primary)
  return out
}

// ── Selection geometry ───────────────────────────────────────────────────────

/** Every key under a collapsed track / group row at `tick` (what its summary key stands for). */
export function summaryKeysAt(row, data, tick) {
  const out = []
  for (const pn of propNodesUnder(row?.node)) {
    const pr = { key: pn.key, prop: pn.prop, provider: pn.provider, target: pn.target, trackId: row.trackId, node: pn }
    for (const k of rowKeys(pr, data)) if (!k.outside && Math.abs(k.tick - tick) < SAME_TICK) out.push(k)
  }
  return out
}

/**
 * The keys a marquee covers, across rows and tracks: the keys of property rows the
 * rectangle crosses, and on collapsed track / group rows every key behind a summary
 * key inside it. rect = { x0, y0, x1, y1 } in content coords (y includes the scroll);
 * xToTick(x) maps the key area's x to a tick.
 */
export function keysInRect(layout, data, rect, xToTick) {
  const out = []
  if (!layout || !data) return out
  const y0 = Math.min(rect.y0, rect.y1)
  const y1 = Math.max(rect.y0, rect.y1)
  const t0 = xToTick(Math.min(rect.x0, rect.x1))
  const t1 = xToTick(Math.max(rect.x0, rect.x1))
  for (const row of layout.rows) {
    if (row.y + row.height <= y0 || row.y >= y1) continue
    if (row.kind === 'prop') {
      for (const k of rowKeys(row, data)) if (k.tick >= t0 && k.tick <= t1) out.push(k)
    } else if (!row.expanded) {
      // Every key behind a summary tick in [t0, t1]: one binary search per property
      // (rowKeys are tick-sorted), not a scan of every key per summary tick.
      const ticks = summaryTicks(row, data)
      const [a, b] = tickRange(ticks, t0, t1)
      if (a >= b) continue
      const lo = ticks[a] - SAME_TICK
      const hi = ticks[b - 1] + SAME_TICK
      for (const pn of propNodesUnder(row.node)) {
        const pr = { key: pn.key, prop: pn.prop, provider: pn.provider, target: pn.target, trackId: row.trackId, node: pn }
        const list = rowKeys(pr, data)
        const [i0, i1] = tickRange(rowKeyTicks(pr, data), lo, hi)
        for (let i = i0; i < i1; i++) {
          const k = list[i]
          if (!k.outside && k.tick > lo && k.tick < hi) out.push(k)
        }
      }
    }
  }
  return out
}

// ── Moves (keys in time; values in the graph) ────────────────────────────────

/**
 * The delta a selection can move by as a group: no timeline / clip key below its floor
 * and, with `data`, no note-relative key past its zone's edge (measured in its move
 * span, noteMoveSpan): a group held at the edge, never squeezed onto one place.
 */
export function clampMoveDelta(instances, delta, { data = null, index = null, primary = null } = {}) {
  let lo = -Infinity
  let hi = Infinity
  for (const inst of instances) {
    const floor = minTickOf(inst)
    if (floor > -Infinity) lo = Math.max(lo, floor - inst.tick)
  }
  if (data) {
    for (const rep of dedupeByTarget(instances, primary).values()) {
      if (!isNoteRef(rep.ref)) continue
      const span = noteMoveSpan(data, rep, index)
      if (!span) continue
      const [zlo, zhi] = zoneSpan(span, rep.ref.anchor)
      const t = anchorOffset(span, rep.ref.anchor, rep.ref.pos)
      lo = Math.max(lo, zlo - t)
      hi = Math.min(hi, zhi - t)
    }
  }
  if (!(lo <= hi)) return 0
  return Math.min(hi, Math.max(lo, delta))
}

/** The write list a ref's key lives in (listOf's id, without reading the list). */
function listIdOf(ref) {
  switch (ref.kind) {
    case 'roam': return `roam:${ref.trackId}`
    case 'sweep': return `sweep:${ref.trackId}`
    case 'clipLens': return `clip:${ref.clipId}`
    case 'hit': return `hit:${ref.trackId}:${ref.regionId}`
    case 'note': return `note:${ref.patternId}:${ref.noteId}`
    case 'mask': return `mask:${ref.trackId}:${ref.maskId}:keys`
    case 'maskShape': return `mask:${ref.trackId}:${ref.maskId}:shape`
    case 'trailOpacity': return `trail:${ref.trackId}:opacity`
    case 'fx': return `fx:${ref.trackId}`
    default: return null
  }
}

const placeKindOf = (ref) => (ref.kind === 'maskShape' ? 'shape' : isNoteRef(ref) ? 'note' : 'origin')

/**
 * The draft and the edits of moving a selection by `delta` ticks (and, in the
 * graph, to new values).
 *   instances  the selected instances; primary the one under the pointer
 *   snapNote   note-relative snapping (motionSnap.snapNotePos with the step bound)
 *   newValue(inst) -> number | undefined   the graph's new value per target
 * Returns { edits: [{ ref, key, pos, value? }], keyTicks: Map<instId, tick>,
 *           keyValues: Map<instId, value>, keyPos: Map<instId, pos>, blocked }
 * (every instance of a moved target is in the maps). Two moved keys of one list
 * landing on the same place would merge (one of them deleted): such a move is
 * refused (blocked: true, no edits), never written.
 */
export function moveSelection(data, index, instances, delta, { primary = null, snapNote = null, newValue = null } = {}) {
  const edits = []
  const keyTicks = new Map()
  const keyValues = new Map()
  const keyPos = new Map()
  const places = new Set()
  for (const [target, rep] of dedupeByTarget(instances, primary)) {
    const pos = posAtTick(data, rep, rep.tick + delta, isNoteRef(rep.ref) ? { snapNote, index } : undefined)
    const list = listIdOf(rep.ref)
    if (list !== null) {
      const place = `${list}|${placeKey(placeKindOf(rep.ref), { channel: rep.ref.channel, anchor: rep.ref.anchor, pos })}`
      if (places.has(place)) return { edits: [], keyTicks: new Map(), keyValues: new Map(), keyPos: new Map(), blocked: true }
      places.add(place)
    }
    const v = newValue ? newValue(rep) : undefined
    const value = fin(v) ? clampRefValue(rep.ref, v) : undefined
    edits.push(value === undefined ? { ref: rep.ref, key: rep.key, pos } : { ref: rep.ref, key: rep.key, pos, value })
    for (const inst of index.byTarget.get(target) ?? [rep]) {
      keyTicks.set(inst.id, tickOfPos(data, inst, pos))
      keyPos.set(inst.id, pos)
      if (value !== undefined) keyValues.set(inst.id, value)
    }
  }
  return { edits, keyTicks, keyValues, keyPos, blocked: false }
}

/** The hint of a refused (blocked) move. */
export const MOVE_MERGE_HINT = 'Two selected keys would land on the same place: the move stops before they merge'

/**
 * A keyboard nudge (R20): every selected key `step` ticks later (negative = earlier),
 * the timeline / clip keys held at their floor and note keys at their zone edge, as a group.
 */
export function nudgeSelection(data, index, instances, step) {
  return moveSelection(data, index, instances, clampMoveDelta(instances, step, { data, index }))
}

// ── The writer ───────────────────────────────────────────────────────────────

function placeKey(listKind, k) {
  if (listKind === 'shape') return `${Math.round(k.pos)}`
  if (listKind === 'note') return `${k.channel}|${k.anchor}|${k.anchor === 'Body' ? Math.round(k.pos * 1e4) : Math.round(k.pos)}`
  return `${k.channel}|${Math.round(k.pos)}`
}

function findKey(list, key, listKind) {
  const i = list.indexOf(key)
  if (i >= 0) return i
  if (!key) return -1
  if (listKind === 'shape') return list.findIndex((k) => Math.abs(k.pos - key.pos) < SAME_TICK)
  return list.findIndex((k) => keyEquals(k, key))
}

function rebuildKey(listKind, old, e) {
  const interp = e.interp ?? old.interp ?? 'Linear'
  let bez
  if (interp === 'Bezier') bez = e.bez ?? (old.interp === 'Bezier' ? old.bez : DEFAULT_BEZ)
  const pos = e.pos ?? old.pos
  if (listKind === 'shape') {
    const k = { pos, interp }
    if (interp === 'Bezier') k.bez = sanitizeBez(bez)
    k.vertices = old.vertices
    return k
  }
  const value = e.value ?? old.value
  return makeKey({ channel: old.channel, anchor: old.anchor ?? 'Origin', pos, value, interp, bez })
}

/** The list a ref's key lives in: { id, kind ('origin' | 'note' | 'shape'), list, ... }. */
function listOf(data, ref) {
  switch (ref.kind) {
    case 'roam': return { id: `roam:${ref.trackId}`, kind: 'origin', type: 'roam', trackId: ref.trackId, list: data.roamOf?.(ref.trackId)?.keys ?? NONE }
    case 'sweep': return { id: `sweep:${ref.trackId}`, kind: 'origin', type: 'sweep', trackId: ref.trackId, list: data.roamOf?.(ref.trackId)?.sweep ?? NONE }
    case 'clipLens': {
      const clip = clipOfRef(data, ref)
      if (!clip) return null
      return { id: `clip:${ref.clipId}`, kind: 'origin', type: 'clipLens', clip, list: data.clipLensOf(clip)?.keys ?? NONE }
    }
    case 'hit': {
      const src = data.sourceOf(ref.trackId, ref.regionId)
      return { id: `hit:${ref.trackId}:${ref.regionId}`, kind: 'note', type: 'hit', trackId: ref.trackId, regionId: ref.regionId, zones: src.zones, list: src.hitCurve ?? NONE }
    }
    case 'note': {
      const note = noteOf(data, ref.patternId, ref.noteId)
      if (!note) return null
      return { id: `note:${ref.patternId}:${ref.noteId}`, kind: 'note', type: 'note', patternId: ref.patternId, noteId: ref.noteId, zones: zonesOfRef(data, ref), list: note.lensOverride?.keys ?? NONE }
    }
    case 'mask':
    case 'maskShape': {
      const roam = data.roamOf?.(ref.trackId)
      const mask = (roam?.masks ?? NONE).find((m) => m.id === ref.maskId)
      if (!mask) return null
      const shape = ref.kind === 'maskShape'
      return {
        id: `mask:${ref.trackId}:${ref.maskId}:${shape ? 'shape' : 'keys'}`,
        kind: shape ? 'shape' : 'origin',
        type: shape ? 'maskShape' : 'mask',
        trackId: ref.trackId,
        maskId: ref.maskId,
        mask,
        list: (shape ? mask.shapeKeys : mask.keys) ?? NONE,
      }
    }
    case 'fx': return { id: `fx:${ref.trackId}`, kind: 'origin', type: 'fx', trackId: ref.trackId, list: data.roamOf?.(ref.trackId)?.fxKeys ?? NONE }
    case 'trailOpacity': {
      const clone = data.cloneOf?.(ref.trackId)
      if (!clone) return null
      return { id: `trail:${ref.trackId}:opacity`, kind: 'origin', type: 'trailOpacity', trackId: ref.trackId, clone, list: clone.opacityKeys ?? NONE }
    }
    default: return null
  }
}

function resolveList(state) {
  if (state.edited.size === 0) return state.work
  const byPlace = new Map()
  for (const k of state.work) if (!state.edited.has(k)) byPlace.set(placeKey(state.kind, k), k)
  for (const k of state.editOrder) if (state.work.includes(k)) byPlace.set(placeKey(state.kind, k), k)
  return [...byPlace.values()]
}

const channelsOf = (list) => new Set(list.map((k) => k.channel))

/**
 * The plan of a set of key edits: [{ ref, key (the wire key as drawn), pos?, value?,
 * interp?, bez?, remove? }] or [{ ref, add: newWireKey }] (a key added, replacing a
 * key at its place). One write per touched list (see the file header).
 * `foldTick`: where a base-backed channel whose last key goes takes its base from.
 */
export function planKeyEdits(data, edits, { foldTick = null } = {}) {
  const states = new Map()
  for (const e of edits ?? NONE) {
    if (!e?.ref) continue
    const info = listOf(data, e.ref)
    if (!info) continue
    let st = states.get(info.id)
    if (!st) {
      st = { ...info, work: [...info.list], edited: new Set(), editOrder: [], removed: false }
      states.set(info.id, st)
    }
    if (e.add) {
      // A new key (paste): it replaces whatever sits at its place.
      st.work.push(e.add)
      st.edited.add(e.add)
      st.editOrder.push(e.add)
      continue
    }
    const i = findKey(st.work, e.key, st.kind)
    if (i < 0) continue
    if (e.remove) {
      st.work.splice(i, 1)
      st.removed = true
      continue
    }
    const next = rebuildKey(st.kind, st.work[i], e)
    st.work[i] = next
    st.edited.add(next)
    st.editOrder.push(next)
  }

  const plan = []
  const maskTracks = new Map()   // trackId -> Map<maskId, mask> (edited masks of one track: one write)
  const touchMask = (st) => {
    let m = maskTracks.get(st.trackId)
    if (!m) { m = new Map(); maskTracks.set(st.trackId, m) }
    return m
  }
  for (const st of states.values()) {
    const list = resolveList(st)
    const before = channelsOf(st.list)
    const after = channelsOf(list)
    const emptied = st.removed && fin(foldTick) ? [...before].filter((c) => !after.has(c)) : []
    switch (st.type) {
      case 'roam': {
        if (emptied.length) {
          const roam = data.roamOf?.(st.trackId)
          const now = resolveRoamAt(roam?.roam ?? ROAM_IDENTITY, st.list, foldTick)
          const params = {}
          for (const c of emptied) params[c] = clampFor(`roam.${c}`)(now[c])
          plan.push({ kind: 'roamBase', trackId: st.trackId, params })
        }
        plan.push({ kind: 'roamKeys', trackId: st.trackId, keys: sortEventKeys(list) })
        break
      }
      case 'sweep':
        plan.push({ kind: 'sweepKeys', trackId: st.trackId, keys: sortEventKeys(list) })
        break
      case 'fx': {
        // A video effect param whose last key goes keeps the value it held at the fold tick.
        const chain = data.tracksById?.get(st.trackId)?.visualEffectChain ?? NONE
        for (const c of emptied) {
          const [uid, param] = parseFxChannel(c)
          const index = chain.findIndex((fx) => fx.uid === uid)
          if (index < 0) continue
          const base = chain[index].params?.[param] ?? 0
          const ks = sortEventKeys(keysOfChannel(st.list, c))
          plan.push({ kind: 'fxBase', trackId: st.trackId, index, param, value: valueAtEvent(ks, foldTick, base) })
        }
        plan.push({ kind: 'fxKeys', trackId: st.trackId, keys: sortEventKeys(list) })
        break
      }
      case 'clipLens': {
        if (emptied.length) {
          const base = { ...LENS_IDENTITY, ...data.clipLensOf(st.clip)?.lens }
          const params = {}
          for (const c of emptied) {
            const ks = sortEventKeys(keysOfChannel(st.list, c))
            params[c] = clampFor(`clipLens.${c}`)(valueAtEvent(ks, foldTick - st.clip.positionTicks, base[c]))
          }
          plan.push({ kind: 'clipLens', clipId: st.clip.id, params })
        }
        plan.push({ kind: 'clipLensKeys', clipId: st.clip.id, keys: sortEventKeys(list) })
        break
      }
      case 'hit':
        plan.push({ kind: 'hitCurve', trackId: st.trackId, regionId: st.regionId, curve: { keys: sortNoteKeys(list, st.zones) } })
        break
      case 'note':
        plan.push({ kind: 'notesLensKeys', entries: [{ patternId: st.patternId, noteId: st.noteId, keys: sortNoteKeys(list, st.zones) }] })
        break
      case 'mask': {
        const masks = touchMask(st)
        const cur = masks.get(st.maskId) ?? st.mask
        const base = { ...cur.base }
        for (const c of emptied) base[c] = maskScalarAt(st.mask, c, foldTick)
        masks.set(st.maskId, { ...cur, base, keys: sortEventKeys(list) })
        break
      }
      case 'maskShape': {
        const masks = touchMask(st)
        const cur = masks.get(st.maskId) ?? st.mask
        let base = cur.base
        if (st.removed && list.length === 0 && st.list.length > 0 && fin(foldTick)) {
          base = { ...cur.base, shape: { closed: true, vertices: shapeAt(st.mask, foldTick) } }
        }
        masks.set(st.maskId, { ...cur, base, shapeKeys: sortEventKeys(list) })
        break
      }
      case 'trailOpacity': {
        const patch = { opacityKeys: sortEventKeys(list) }
        if (emptied.length) patch.opacity = clampFor('trail.opacity')(trailOpacityValueAt(st.clone, foldTick))
        plan.push({ kind: 'cloneSettings', trackId: st.trackId, patch })
        break
      }
      default: break
    }
  }
  for (const [trackId, edited] of maskTracks) {
    const all = (data.roamOf?.(trackId)?.masks ?? NONE).map((m) => edited.get(m.id) ?? m)
    plan.push({ kind: 'masks', trackId, masks: toWireList(all) })
  }
  return plan
}

// ── Commands over a selection ────────────────────────────────────────────────

/** The plan that deletes every selected key (R20 Delete / Backspace). */
export function deleteKeysPlan(data, instances, { foldTick = null } = {}) {
  const edits = [...dedupeByTarget(instances).values()].map((inst) => ({ ref: inst.ref, key: inst.key, remove: true }))
  return planKeyEdits(data, edits, { foldTick })
}

/** The plan that gives every selected key `interp` (Bezier: the preset's handles, else each key's own). */
export function interpPlan(data, instances, interp, bez = null) {
  const edits = [...dedupeByTarget(instances).values()].map((inst) => ({
    ref: inst.ref,
    key: inst.key,
    interp,
    bez: interp === 'Bezier' ? (bez ?? (inst.key?.interp === 'Bezier' ? inst.key.bez : DEFAULT_BEZ)) : undefined,
  }))
  return planKeyEdits(data, edits)
}

/** The plan of a finished move draft (moveSelection's edits). */
export const movePlan = (data, moved) => planKeyEdits(data, moved.edits)

/** The plan that sets one key's Bezier handles (graph handle drag). */
export const bezierPlan = (data, inst, bez) => planKeyEdits(data, [{ ref: inst.ref, key: inst.key, interp: 'Bezier', bez }])

/**
 * The pos a "Nudge this note" key takes at `tick` (the hollow key's anchor kept),
 * measured in THIS note: at the hollow key's own place it is the hit key's pos, and a
 * zone this note squashes or cuts never collapses it (posAtTick without an index).
 */
export function nudgeNotePos(data, inst, tick = inst.tick, { snapNote = null } = {}) {
  return posAtTick(data, inst, tick, { snapNote })
}

/**
 * Where a Ctrl+Alt drag of a hollow key by `delta` ticks puts the Nudge key:
 * { pos, tick }, computed from THIS instance (chord notes share a hit instance id, so
 * no id-keyed lookup).
 */
export function nudgeNoteMove(data, inst, delta, { snapNote = null } = {}) {
  const pos = nudgeNotePos(data, inst, inst.tick + delta, { snapNote })
  return { pos, tick: tickOfPos(data, inst, pos) }
}

/**
 * The key id and ref an instance has once its key's pos is `pos` (the id formats of
 * rowRegistry.js), so a selection follows its keys through a commit.
 */
export function keyIdAfter(inst, pos) {
  const r = inst.ref
  const ref = { ...r, pos }
  switch (r.kind) {
    case 'roam': return [`r:${r.trackId}:${r.channel}:${pos}`, ref]
    case 'sweep': return [`s:${r.trackId}:${r.channel}:${pos}`, ref]
    case 'clipLens': return [`c:${r.clipId}:${r.channel}:${pos}`, ref]
    case 'mask': return [`m:${r.trackId}:${r.maskId}:${r.channel}:${pos}`, ref]
    case 'maskShape': return [`ms:${r.trackId}:${r.maskId}:${pos}`, ref]
    case 'trailOpacity': return [`to:${r.trackId}:${pos}`, ref]
    case 'fx': return [`f:${r.trackId}:${r.channel}:${pos}`, ref]
    case 'hit': return [`h:${r.trackId}:${r.regionId}:${r.channel}:${r.anchor}:${pos}@${r.noteStart}`, ref]
    case 'note': return [`n:${r.patternId}:${r.noteId}:${r.channel}:${r.anchor}:${pos}@${r.noteStart}`, ref]
    default: return [inst.id, r]
  }
}

/** The selection after a move: every selected instance under its moved target's new pos. */
export function selectionAfterMove(instances, edits) {
  const posByTarget = new Map(edits.map((e) => [refTarget(e.ref), e.pos]))
  return instances.map((inst) => {
    const pos = posByTarget.get(refTarget(inst.ref))
    return pos === undefined ? [inst.id, inst.ref] : keyIdAfter(inst, pos)
  })
}

/**
 * "Nudge this note" (R5): a Nudge key on ONE note at a hollow (hit-curve) key's
 * place, so the note plays `desired` there while the hit curve and every other
 * note stay as they are. layer = desired / hit (zoom) or desired - hit (centre,
 * rotation), where hit is the hit curve at that place in this note. The note becomes
 * Nudge (the engine turns a Follow note with keys into Nudge).
 *   inst      the hollow instance (ref.kind 'hit')
 *   tick      where the key goes (default: where the hollow key is)
 *   desired   the layer value the note should play there (default: the hit key's value)
 *   pos       the Nudge key's pos when the caller has it (nudgeNoteMove), else from `tick`
 */
export function nudgeNotePlan(data, inst, { tick = inst.tick, desired = inst.value, snapNote = null, pos: atPos = null } = {}) {
  const ref = inst.ref
  if (ref?.kind !== 'hit') return []
  const note = noteOf(data, ref.patternId, ref.noteId)
  if (!note) return []
  const src = data.sourceOf(ref.trackId, ref.regionId)
  const span = noteSpan(ref.noteEnd - ref.noteStart, src.zones)
  const pos = fin(atPos) ? atPos : nudgeNotePos(data, inst, tick, { snapNote })
  const at = anchorOffset(span, ref.anchor, pos)
  const ch = ref.channel
  const hitKeys = sortNoteKeys(keysOfChannel(src.hitCurve, ch), src.zones)
  const hit = valueAtNote(hitKeys, span, at, layerIdentity(ch))
  const prop = propertyById(`sourceLens.${ch}`)
  const value = clampLayer(prop, layerBetween(prop, hit, fin(desired) ? desired : hit))
  const own = note.lensOverride?.keys ?? NONE
  const place = placeKey('note', { channel: ch, anchor: ref.anchor, pos })
  const keys = own.filter((k) => placeKey('note', k) !== place)
  keys.push(makeKey({ channel: ch, anchor: ref.anchor, pos, value, interp: inst.key?.interp ?? inst.interp ?? 'Linear', bez: inst.key?.bez }))
  return [{ kind: 'notesLensKeys', entries: [{ patternId: ref.patternId, noteId: ref.noteId, keys: sortNoteKeys(keys, src.zones) }] }]
}

/**
 * Double-click on empty space of an animated row (5.4): a key at `tick` holding the
 * curve's value there, through the row's provider (null when the row cannot take a
 * key there: not animated, or blocked).
 */
export function addKeyAtPlan(row, data, tick) {
  if (!row || row.kind !== 'prop' || !row.prop?.animatable) return null
  const p = row.provider
  if (!p.isAnimated(row, data, tick)) return null
  if (p.editBlocker?.(row, data, tick, 'key')) return null
  const plan = p.addKeyPlan(row, data, tick)
  return plan.length > 0 ? plan : null
}
