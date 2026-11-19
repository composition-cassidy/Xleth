// Video effect rows (the "Video effects" group under a track): one group per chain
// effect, one row per animatable parameter. Keys are timeline-absolute, like Roam's:
// a keyed parameter follows its keys, an unkeyed one holds the effect's own value
// (what the Video device's knob sets). The effect is addressed by its stable uid, so
// keys survive reordering and removing neighbours.
//
//   stopwatch ON   one key at the playhead holding the value shown now
//   stopwatch OFF  every key of the parameter removed AND the effect's own value set to the
//                  value at the playhead, in the same plan (one undo step)
//   value edit     animated: upsert a key at the playhead; static: the effect's value
//
// Row keys: 't:<id>/fx' (the group), 't:<id>/fx/<uid>' (one effect),
// 't:<id>/fx/<uid>/fx.<type>.<param>' (its rows). Trail clones replay their source's
// chain and have no rows of their own.
//
// Keys are in the Roam key shape with channel 'uid:param' (see fxModel.js), so the
// shared key helpers and gestures apply unchanged.

import { valueAtEvent } from '../../lensRoam/lensKeyModel.js'
import { isTrailClone } from '../../clones/cloneModel.js'
import { fxChannel, fxEffectsOf, fxPropsOfType } from '../fxModel.js'
import { channelKeys, clampFor, removeOriginKeyAt, sortInstances, upsertOriginKey, withoutChannel } from './common.js'

const NO_KEYS = Object.freeze([])

export const FX_GROUP_HINT = 'Video effects: the parameters of this track\'s effect chain. Keys sit on the timeline.'

const keysOf = (data, trackId) => (data.roamOf?.(trackId) ?? data.roamByTrack?.get(trackId))?.fxKeys ?? NO_KEYS
const chainOf = (row) => row.track?.visualEffectChain ?? NO_KEYS

function locate(row) {
  const { uid, param } = row.target ?? {}
  const index = chainOf(row).findIndex((fx) => fx.uid === uid)
  return { uid, param, index, channel: fxChannel(uid, param), base: index >= 0 ? chainOf(row)[index].params?.[param] : undefined }
}

export const fxProvider = {
  id: 'fx',

  groups(track) {
    if (isTrailClone(track)) return []
    const effects = fxEffectsOf(track.visualEffectChain).filter((e) => fxPropsOfType(e.type).length > 0)
    if (effects.length === 0) return []
    const t = `t:${track.id}`
    return [{
      key: `${t}/fx`,
      groupId: 'fx',
      label: 'Video effects',
      hint: FX_GROUP_HINT,
      provider: fxProvider,
      target: {},
      count: effects.length,
      children: effects.map((e) => ({
        key: `${t}/fx/${e.uid}`,
        groupId: 'fx-effect',
        label: e.bypassed ? `${e.label} (bypassed)` : e.label,
        hint: `${e.label}: its parameters can be keyed over time`,
        provider: fxProvider,
        target: { uid: e.uid, type: e.type },
        children: fxPropsOfType(e.type).map((prop) => ({
          key: `${t}/fx/${e.uid}/${prop.id}`,
          prop,
          provider: fxProvider,
          target: { uid: e.uid, type: e.type, param: Number(prop.channel) },
        })),
      })),
    }]
  },

  keys(row, data) {
    const { uid, param, channel } = locate(row)
    const out = []
    for (const k of channelKeys(keysOf(data, row.trackId), channel)) {
      out.push({
        id: `f:${row.trackId}:${channel}:${k.pos}`,
        rowKey: row.key,
        tick: k.pos,
        value: k.value,
        interp: k.interp ?? 'Linear',
        bez: k.bez,
        hollow: false,
        ref: { kind: 'fx', trackId: row.trackId, channel, uid, param, type: row.target.type, pos: k.pos },
        key: k,
      })
    }
    return sortInstances(out)
  },

  valueAt(row, data, tick) {
    const { channel, base } = locate(row)
    if (base === undefined) return null
    const ks = channelKeys(keysOf(data, row.trackId), channel)
    return ks.length > 0 ? valueAtEvent(ks, tick, base) : base
  },

  isAnimated(row, data) {
    const { channel } = locate(row)
    return keysOf(data, row.trackId).some((k) => k.channel === channel)
  },

  editBlocker(row) {
    return locate(row).index < 0 ? 'This effect is no longer in the chain' : null
  },

  stopwatchPlan(row, data, tick, on) {
    const { channel, index, param } = locate(row)
    if (index < 0) return []
    const clamp = clampFor(row.prop.id)
    const keys = keysOf(data, row.trackId)
    const now = fxProvider.valueAt(row, data, tick)
    if (on) {
      return [{ kind: 'fxKeys', trackId: row.trackId, keys: upsertOriginKey(keys, { channel, pos: tick, value: now }, clamp) }]
    }
    return [
      { kind: 'fxBase', trackId: row.trackId, index, param, value: clamp(now) },
      { kind: 'fxKeys', trackId: row.trackId, keys: withoutChannel(keys, channel) },
    ]
  },

  valuePlan(row, data, tick, value) {
    const { channel, index, param } = locate(row)
    if (index < 0) return []
    const clamp = clampFor(row.prop.id)
    const v = clamp(value)
    if (fxProvider.isAnimated(row, data, tick)) {
      return [{ kind: 'fxKeys', trackId: row.trackId, keys: upsertOriginKey(keysOf(data, row.trackId), { channel, pos: tick, value: v }, clamp) }]
    }
    return [{ kind: 'fxBase', trackId: row.trackId, index, param, value: v }]
  },

  addKeyPlan(row, data, tick) {
    return fxProvider.stopwatchPlan(row, data, tick, true)
  },

  removeKeyPlan(row, data, tick) {
    const { channel } = locate(row)
    const keys = keysOf(data, row.trackId)
    const next = removeOriginKeyAt(keys, channel, Math.round(tick))
    if (next.length === keys.length) return []
    // The last key of a parameter going: keep the value it held as the effect's own (R3).
    if (!next.some((k) => k.channel === channel)) return fxProvider.stopwatchPlan(row, data, tick, false)
    return [{ kind: 'fxKeys', trackId: row.trackId, keys: next }]
  },

  hint(row) {
    const p = row.prop
    return { hint: `${p.label}: a video effect parameter, timeline keys`, mods: '' }
  },
}

export default fxProvider
