// Roam rows (docs/XLETH_MOTION_VIEW_DESIGN.md 5.3, R1, R3, R4): Offset X, Offset Y,
// Scale, Rotation (timeline-absolute keys; a keyed channel follows its keys, an
// unkeyed one holds the base), Bounds and Layer (base only, pickers), the
// project's Motion blur read-through row (R1), then the Masks group (maskProvider).
//
// Plans (motionPlan.js) a row returns:
//   stopwatch ON   one key at the playhead holding the value shown now
//   stopwatch OFF  every key of the channel removed AND the base set to the value at
//                  the playhead, in the same plan (one undo step), so nothing jumps there
//   value edit     animated: upsert a key at the playhead; static: the base (R4, never a rest key)
//
// A Trail clone (docs/XLETH_CLONE_SPEC.md) has an ADDED Roam: the engine applies
// only its Offset X / Y, on top of the delayed source position, timeline-absolute.
// Its group is "Roam · added" with those two rows (no Scale, Rotation, Bounds,
// Layer, blur row or Masks); the plans are the same, on the Trail's own trackId.

import { propertiesOfGroup, propertyById } from '../schema.js'
import { isTrailClone } from '../../clones/cloneModel.js'
import { resolveRoamAt } from '../../lensRoam/roamKeyModel.js'
import { ROAM_IDENTITY } from '../../lensRoam/lensRoamModel.js'
import {
  MOTION_BLUR_HINT, MOTION_BLUR_MODS, channelKeys, clampFor, removeOriginKeyAt, sortInstances, upsertOriginKey, withoutChannel,
} from './common.js'
import { maskProvider } from './maskProvider.js'

const ROAM_PROPS = propertiesOfGroup('roam')
const TRAIL_ROAM_PROPS = ROAM_PROPS.filter((p) => p.channel === 'offsetX' || p.channel === 'offsetY')
// Row order under Roam: the schema lists the properties by engine channel, the tree reads
// better with Scale Y beside Scale and the crop edges after Rotation.
const ROW_ORDER = ['offsetX', 'offsetY', 'scale', 'scaleY', 'scaleLinked', 'rotationDeg',
  'cropLeft', 'cropRight', 'cropTop', 'cropBottom', 'bounds', 'layer', 'motionBlur']
const ORDERED_ROAM_PROPS = ROW_ORDER.map((c) => ROAM_PROPS.find((p) => p.channel === c)).filter(Boolean)
const NO_KEYS = Object.freeze([])

export const ROAM_GROUP_HINT = 'Roam moves the cell itself: offset, scale and rotation. Keys sit on the timeline.'
export const TRAIL_ROAM_LABEL = 'Roam · added'
export const trailRoamHint = (sourceName) => `Added Roam: an offset on top of where ${sourceName} was, so the Trail can sit beside its path. Only Offset X and Y apply. Keys sit on the timeline.`

function entry(data, trackId) {
  return data.roamOf?.(trackId) ?? data.roamByTrack?.get(trackId) ?? null
}
const baseOf = (data, trackId) => entry(data, trackId)?.roam ?? ROAM_IDENTITY
const keysOf = (data, trackId) => entry(data, trackId)?.keys ?? NO_KEYS

/**
 * Link / unlink Scale X and Y (one undo step). Unlinking starts Scale Y at what the cell's
 * scale is now and gives it a copy of the Scale keys, so nothing moves; linking lets the
 * one Scale drive both axes again and drops the Scale Y keys (the engine ignores them).
 */
export function linkScalePlan(trackId, data, tick, linked) {
  const keys = keysOf(data, trackId)
  if (linked) {
    const plan = [{ kind: 'roamBase', trackId, params: { scaleLinked: true } }]
    if (keys.some((k) => k.channel === 'scaleY')) plan.push({ kind: 'roamKeys', trackId, keys: withoutChannel(keys, 'scaleY') })
    return plan
  }
  const now = resolveRoamAt(baseOf(data, trackId), keys, tick).scale
  const plan = [{ kind: 'roamBase', trackId, params: { scaleLinked: false, scaleY: clampFor('roam.scaleY')(now) } }]
  const scaleKeys = channelKeys(keys, 'scale')
  if (scaleKeys.length) {
    plan.push({ kind: 'roamKeys', trackId, keys: [...withoutChannel(keys, 'scaleY'), ...scaleKeys.map((k) => ({ ...k, channel: 'scaleY' }))] })
  }
  return plan
}

export const roamProvider = {
  id: 'roam',

  groups(track, data) {
    const t = `t:${track.id}`
    if (isTrailClone(track)) {
      return [{
        key: `${t}/roam`,
        groupId: 'roam',
        label: TRAIL_ROAM_LABEL,
        hint: trailRoamHint(data.cloneSourceOf?.(track.id)?.name ?? 'its source'),
        provider: roamProvider,
        target: { added: true },
        children: TRAIL_ROAM_PROPS.map((prop) => ({ key: `${t}/roam/${prop.id}`, prop, provider: roamProvider, target: { added: true } })),
      }]
    }
    // Scale: while linked one "Scale" row drives both axes and Scale Y is hidden; unlinked,
    // the rows read "Scale X" and "Scale Y".
    const linked = baseOf(data, track.id).scaleLinked !== false
    const props = ORDERED_ROAM_PROPS
      .filter((prop) => !(prop.channel === 'scaleY' && linked))
      .map((prop) => ({
        key: `${t}/roam/${prop.id}`,
        prop: !linked && prop.channel === 'scale' ? { ...prop, label: 'Scale X' } : prop,
        provider: roamProvider,
        target: {},
      }))
    const masks = maskProvider.groups(track, data)
    const placed = data.placed?.has?.(track.id) ?? true
    return [{
      key: `${t}/roam`,
      groupId: 'roam',
      label: 'Roam',
      hint: placed ? ROAM_GROUP_HINT : `${ROAM_GROUP_HINT} This track has no cell on the grid right now.`,
      provider: roamProvider,
      target: {},
      children: [...props, ...masks],
    }]
  },

  keys(row, data) {
    const ch = row.prop.channel
    if (row.prop.type !== 'scalar') return NO_KEYS
    const out = []
    for (const k of channelKeys(keysOf(data, row.trackId), ch)) {
      out.push({
        id: `r:${row.trackId}:${ch}:${k.pos}`,
        rowKey: row.key,
        tick: k.pos,
        value: k.value,
        interp: k.interp ?? 'Linear',
        bez: k.bez,
        hollow: false,
        ref: { kind: 'roam', trackId: row.trackId, channel: ch, pos: k.pos },
        key: k,
      })
    }
    return sortInstances(out)
  },

  valueAt(row, data, tick) {
    const p = row.prop
    if (p.type === 'motionBlur') return data.motionBlur ?? { enabled: false, shutterAngleDeg: 180 }
    const base = baseOf(data, row.trackId)
    if (p.type !== 'scalar') return base[p.channel] ?? p.identity
    return resolveRoamAt(base, keysOf(data, row.trackId), tick)[p.channel] ?? p.identity
  },

  isAnimated(row, data) {
    if (row.prop.type !== 'scalar') return false
    return keysOf(data, row.trackId).some((k) => k.channel === row.prop.channel)
  },

  editBlocker() {
    return null
  },

  stopwatchPlan(row, data, tick, on) {
    const p = row.prop
    if (!p.animatable || p.type !== 'scalar') return []
    const keys = keysOf(data, row.trackId)
    const now = roamProvider.valueAt(row, data, tick)
    if (on) {
      return [{ kind: 'roamKeys', trackId: row.trackId, keys: upsertOriginKey(keys, { channel: p.channel, pos: tick, value: now }, clampFor(p.id)) }]
    }
    return [
      { kind: 'roamBase', trackId: row.trackId, params: { [p.channel]: clampFor(p.id)(now) } },
      { kind: 'roamKeys', trackId: row.trackId, keys: withoutChannel(keys, p.channel) },
    ]
  },

  valuePlan(row, data, tick, value) {
    const p = row.prop
    if (p.type === 'motionBlur') return []      // a project setting, not a plan (setMotionBlur)
    if (p.channel === 'scaleLinked') return linkScalePlan(row.trackId, data, tick, !!value)
    if (p.type !== 'scalar') return [{ kind: 'roamBase', trackId: row.trackId, params: { [p.channel]: value } }]
    const v = clampFor(p.id)(value)
    if (roamProvider.isAnimated(row, data, tick)) {
      return [{ kind: 'roamKeys', trackId: row.trackId, keys: upsertOriginKey(keysOf(data, row.trackId), { channel: p.channel, pos: tick, value: v }, clampFor(p.id)) }]
    }
    return [{ kind: 'roamBase', trackId: row.trackId, params: { [p.channel]: v } }]
  },

  addKeyPlan(row, data, tick) {
    return roamProvider.stopwatchPlan(row, data, tick, true)
  },

  removeKeyPlan(row, data, tick) {
    const p = row.prop
    if (p.type !== 'scalar') return []
    const keys = keysOf(data, row.trackId)
    const next = removeOriginKeyAt(keys, p.channel, Math.round(tick))
    if (next.length === keys.length) return []
    // The last key of a channel going: keep the value it held as the base (R3).
    if (!next.some((k) => k.channel === p.channel)) return roamProvider.stopwatchPlan(row, data, tick, false)
    return [{ kind: 'roamKeys', trackId: row.trackId, keys: next }]
  },

  hint(row) {
    const p = row.prop
    if (p.type === 'motionBlur') return { hint: MOTION_BLUR_HINT, mods: MOTION_BLUR_MODS }
    if (p.channel === 'scaleLinked') return { hint: 'Link scale: on, one Scale resizes the cell evenly; off, Scale X and Scale Y stretch it independently', mods: '' }
    if (p.channel.startsWith('crop')) return { hint: `${p.label}: trim this share of the cell's edge off the picture. The video is not squished, the edge just stops showing`, mods: '' }
    if (p.channel === 'bounds') return { hint: 'Bounds: Clip keeps the cell inside its grid rect; Float lets it move over its neighbours', mods: '' }
    if (p.channel === 'layer') return { hint: 'Layer: where a floating cell draws, among its neighbours', mods: '' }
    if (row.target?.added) return { hint: `${p.label}: added on top of the delayed source position, timeline keys`, mods: '' }
    return { hint: `${p.label}: Roam ${p.label.toLowerCase()} of the cell, timeline keys`, mods: '' }
  },
}

/** The schema property of a Roam row by channel (tests, reveal). */
export const roamPropOf = (channel) => propertyById(`roam.${channel}`)

export default roamProvider
