// Mask rows (docs/XLETH_MOTION_VIEW_DESIGN.md 2.2, 5.3, R3, R4, R11-R15): under Roam,
// a "Masks" group (its Add mask menu: Rectangle, Ellipse, Path) holding one group
// per mask ("Mask n": Shape, Feather, Expansion, Opacity, Mode, Invert). Keys are
// timeline-absolute. Every edit is ONE whole-list write (setTrackMasks), so a
// plan carries the track's complete mask list in wire form.
//
//   Shape        key toggle: ON = a shape key at the playhead holding the shape now;
//                OFF = no shape keys, the base shape set to the shape at the playhead.
//                Value cell: the kind (Rectangle / Ellipse / Path); a static
//                Rectangle or Ellipse can be swapped for the other (same bounds) or
//                turned into a Path. The points themselves are edited on the viewer.
//   Feather, Expansion, Opacity   scalars like Roam (absolute, base-backed).
//   Mode, Invert                  base only, pickers.
//
// Row keys: 't:<id>/roam/masks' (the group), 't:<id>/mask:<maskId>' (one mask),
// 't:<id>/mask:<maskId>/<propId>' (its rows). Mask groups are not nested in the
// key path under roam/masks (design 2.3), so revealing one expands both by hand.

import { LIMITS, propertiesOfGroup } from '../schema.js'
import {
  MAX_NAME_LENGTH, addMaskBlocker, clearMaskChannelKeys, clearShapeKeys, convertToPath, isShapeAnimated, makeEllipse, makeMask,
  makeRectangle, maskScalarAt, nextMaskId, removeShapeKey, shapeAt, shapeBounds, toWireList, upsertMaskKey,
  upsertShapeKey,
} from '../maskModel.js'
import { channelKeys, clampFor, removeOriginKeyAt, sortInstances } from './common.js'

const MASK_PROPS = propertiesOfGroup('mask')
const NO_MASKS = Object.freeze([])

export const MASKS_GROUP_HINT = 'Masks cut what the cell shows, top to bottom (Add, Subtract, Intersect). They move with the cell.'
export const maskGroupHint = (mask) => `${mask.name}: a ${mask.kind.toLowerCase()} mask. Its shape is edited on the viewer`

export const masksOf = (data, trackId) => (data.roamOf?.(trackId) ?? data.roamByTrack?.get(trackId))?.masks ?? NO_MASKS
export const maskOf = (data, trackId, maskId) => masksOf(data, trackId).find((m) => m.id === maskId) ?? null

/** A mask name as saved: trimmed, at most MAX_NAME_LENGTH code points; '' when blank. */
export function cleanMaskName(name) {
  const s = String(name ?? '').trim()
  return [...s].slice(0, MAX_NAME_LENGTH).join('')
}

/** The masks write with one mask replaced (a whole-list write, wire form). */
function replaceMask(data, trackId, mask) {
  const list = masksOf(data, trackId).map((m) => (m.id === mask.id ? mask : m))
  return { kind: 'masks', trackId, masks: toWireList(list) }
}

/** A Rectangle / Ellipse with the bounds of a shape (the swap of a static mask's kind). */
function reshape(mask, kind) {
  if (kind === mask.kind) return mask
  if (kind === 'Path') return convertToPath(mask)
  const b = shapeBounds(mask.base.shape)
  const cx = b.x + b.w / 2
  const cy = b.y + b.h / 2
  const shape = kind === 'Ellipse'
    ? makeEllipse({ cx, cy, rx: Math.max(b.w / 2, 0.01), ry: Math.max(b.h / 2, 0.01) })
    : makeRectangle({ cx, cy, hw: Math.max(b.w / 2, 0.01), hh: Math.max(b.h / 2, 0.01) })
  return { ...mask, kind, base: { ...mask.base, shape } }
}

export const maskProvider = {
  id: 'mask',

  /** The Masks group (always, so a mask can be added) with one group per mask. */
  groups(track, data) {
    const t = `t:${track.id}`
    const masks = masksOf(data, track.id)
    return [{
      key: `${t}/roam/masks`,
      groupId: 'masks',
      label: 'Masks',
      hint: MASKS_GROUP_HINT,
      provider: maskProvider,
      target: { kind: 'masks' },
      count: masks.length,
      children: masks.map((mask) => {
        const key = `${t}/mask:${mask.id}`
        const target = { kind: 'mask', maskId: mask.id }
        return {
          key,
          groupId: 'mask',
          label: mask.name,
          hint: maskGroupHint(mask),
          provider: maskProvider,
          target,
          children: MASK_PROPS.map((prop) => ({ key: `${key}/${prop.id}`, prop, provider: maskProvider, target })),
        }
      }),
    }]
  },

  keys(row, data) {
    const mask = maskOf(data, row.trackId, row.target?.maskId)
    if (!mask) return []
    const p = row.prop
    const out = []
    if (p.type === 'shape') {
      for (const k of mask.shapeKeys ?? []) {
        out.push({
          id: `ms:${row.trackId}:${mask.id}:${k.pos}`,
          rowKey: row.key,
          tick: k.pos,
          value: null,
          interp: k.interp ?? 'Linear',
          bez: k.bez,
          hollow: false,
          ref: { kind: 'maskShape', trackId: row.trackId, maskId: mask.id, pos: k.pos },
          key: k,
        })
      }
    } else if (p.type === 'scalar') {
      for (const k of channelKeys(mask.keys, p.channel)) {
        out.push({
          id: `m:${row.trackId}:${mask.id}:${p.channel}:${k.pos}`,
          rowKey: row.key,
          tick: k.pos,
          value: k.value,
          interp: k.interp ?? 'Linear',
          bez: k.bez,
          hollow: false,
          ref: { kind: 'mask', trackId: row.trackId, maskId: mask.id, channel: p.channel, pos: k.pos },
          key: k,
        })
      }
    }
    return sortInstances(out)
  },

  valueAt(row, data, tick) {
    const mask = maskOf(data, row.trackId, row.target?.maskId)
    if (!mask) return null
    const p = row.prop
    if (p.type === 'scalar') return maskScalarAt(mask, p.channel, tick)
    if (p.type === 'shape') return { kind: mask.kind, vertices: shapeAt(mask, tick) }
    return mask.base[p.channel] ?? p.identity
  },

  isAnimated(row, data) {
    const mask = maskOf(data, row.trackId, row.target?.maskId)
    if (!mask) return false
    const p = row.prop
    if (p.type === 'shape') return isShapeAnimated(mask)
    if (p.type === 'scalar') return (mask.keys ?? []).some((k) => k.channel === p.channel)
    return false
  },

  editBlocker(row, data, tick, intent) {
    const mask = maskOf(data, row.trackId, row.target?.maskId)
    if (!mask) return 'This mask is gone'
    if (intent === 'value' && row.prop.type === 'shape' && isShapeAnimated(mask)) {
      return 'An animated shape keeps its kind: edit its points on the viewer'
    }
    return null
  },

  stopwatchPlan(row, data, tick, on) {
    const mask = maskOf(data, row.trackId, row.target?.maskId)
    const p = row.prop
    if (!mask || !p.animatable) return []
    if (p.type === 'shape') {
      const now = shapeAt(mask, tick)
      return [replaceMask(data, row.trackId, on ? upsertShapeKey(mask, tick, now) : clearShapeKeys(mask, now))]
    }
    const now = maskScalarAt(mask, p.channel, tick)
    return [replaceMask(data, row.trackId, on
      ? upsertMaskKey(mask, { channel: p.channel, pos: tick, value: now })
      : clearMaskChannelKeys(mask, p.channel, now))]
  },

  valuePlan(row, data, tick, value) {
    const mask = maskOf(data, row.trackId, row.target?.maskId)
    const p = row.prop
    if (!mask) return []
    if (p.type === 'shape') {
      if (isShapeAnimated(mask) || typeof value !== 'string') return []
      const next = reshape(mask, value)
      return next === mask ? [] : [replaceMask(data, row.trackId, next)]
    }
    if (p.type === 'scalar') {
      const v = clampFor(p.id)(value)
      if (maskProvider.isAnimated(row, data, tick)) {
        return [replaceMask(data, row.trackId, upsertMaskKey(mask, { channel: p.channel, pos: tick, value: v }))]
      }
      return [replaceMask(data, row.trackId, { ...mask, base: { ...mask.base, [p.channel]: v } })]
    }
    return [replaceMask(data, row.trackId, { ...mask, base: { ...mask.base, [p.channel]: value } })]
  },

  addKeyPlan(row, data, tick) {
    return maskProvider.stopwatchPlan(row, data, tick, true)
  },

  removeKeyPlan(row, data, tick) {
    const mask = maskOf(data, row.trackId, row.target?.maskId)
    const p = row.prop
    if (!mask) return []
    if (p.type === 'shape') {
      const next = removeShapeKey(mask, Math.round(tick))
      if (next === mask) return []
      if (!isShapeAnimated(next)) return maskProvider.stopwatchPlan(row, data, tick, false)
      return [replaceMask(data, row.trackId, next)]
    }
    if (p.type !== 'scalar') return []
    const keys = removeOriginKeyAt(mask.keys, p.channel, Math.round(tick))
    if (keys.length === (mask.keys ?? []).length) return []
    if (!keys.some((k) => k.channel === p.channel)) return maskProvider.stopwatchPlan(row, data, tick, false)
    return [replaceMask(data, row.trackId, { ...mask, keys })]
  },

  /** Why a mask of `kind` cannot be added to this track now (R15 caps), or null. */
  addBlocker(trackId, data, kind) {
    return addMaskBlocker(masksOf(data, trackId), { kind })
  },

  /** The plan that adds a Rectangle or Ellipse mask (a Path is drawn with the pen tool). */
  addMaskPlan(trackId, data, kind) {
    const masks = masksOf(data, trackId)
    if (kind === 'Path' || addMaskBlocker(masks, { kind })) return []
    const id = nextMaskId(masks)
    return [{ kind: 'masks', trackId, masks: toWireList([...masks, makeMask(kind, id, `Mask ${id}`)]) }]
  },

  /** The plan that deletes one mask. */
  deleteMaskPlan(trackId, data, maskId) {
    const masks = masksOf(data, trackId)
    if (!masks.some((m) => m.id === maskId)) return []
    return [{ kind: 'masks', trackId, masks: toWireList(masks.filter((m) => m.id !== maskId)) }]
  },

  /** The plan that renames a mask (trimmed, at most MAX_NAME_LENGTH characters; blank or unchanged = nothing). */
  renameMaskPlan(trackId, data, maskId, name) {
    const mask = maskOf(data, trackId, maskId)
    const next = cleanMaskName(name)
    if (!mask || !next || next === mask.name) return []
    return [replaceMask(data, trackId, { ...mask, name: next })]
  },

  /** Why a mask cannot be duplicated now (R15 caps), or null. */
  duplicateBlocker(trackId, data, maskId) {
    const mask = maskOf(data, trackId, maskId)
    if (!mask) return 'This mask is gone'
    return addMaskBlocker(masksOf(data, trackId), { kind: mask.kind, vertexCount: mask.base.shape.vertices.length })
  },

  /** The plan that duplicates a mask right below it (a new id, "<name> copy"). */
  duplicateMaskPlan(trackId, data, maskId) {
    const masks = masksOf(data, trackId)
    const i = masks.findIndex((m) => m.id === maskId)
    if (i < 0 || maskProvider.duplicateBlocker(trackId, data, maskId)) return []
    const src = toWireList([masks[i]])[0]
    const copy = { ...src, id: nextMaskId(masks), name: cleanMaskName(`${src.name} copy`) }
    const list = [...masks.slice(0, i + 1), copy, ...masks.slice(i + 1)]
    return [{ kind: 'masks', trackId, masks: toWireList(list) }]
  },

  /** The plan that moves a mask one place up (dir -1) or down (+1) in the stack (R12 order). */
  moveMaskPlan(trackId, data, maskId, dir) {
    const masks = masksOf(data, trackId)
    const i = masks.findIndex((m) => m.id === maskId)
    const j = i + (dir < 0 ? -1 : 1)
    if (i < 0 || j < 0 || j >= masks.length) return []
    const list = [...masks]
    ;[list[i], list[j]] = [list[j], list[i]]
    return [{ kind: 'masks', trackId, masks: toWireList(list) }]
  },

  hint(row) {
    const p = row.prop
    switch (p.channel) {
      case 'shape': return { hint: 'Shape: the mask\'s path. Drag its points on the viewer; animated, each key stores every point', mods: '' }
      case 'feather': return { hint: 'Feather: the soft edge, in units of the cell\'s shorter side', mods: '' }
      case 'expansion': return { hint: 'Expansion: grows (+) or shrinks (−) the shape, in units of the cell\'s shorter side', mods: '' }
      case 'opacity': return { hint: 'Opacity: how strongly this mask applies; 0 % = no effect', mods: '' }
      case 'mode': return { hint: 'Mode: Add shows inside it, Subtract cuts it out, Intersect keeps the overlap', mods: '' }
      case 'invert': return { hint: 'Invert: use the outside of the shape', mods: '' }
      default: return { hint: p.label, mods: '' }
    }
  },
}

/** The caps (R15) the Add mask menu explains. */
export const MASK_LIMITS = LIMITS

export default maskProvider
