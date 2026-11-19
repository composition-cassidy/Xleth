// Sweep rows (docs/XLETH_MOTION_VIEW_DESIGN.md R2, R3, R4): the real Sweep channels
// Zoom, Center X, Center Y, Rotation, plus the project's Motion blur read-through
// row (R1). Pattern tracks only. Sweep is a LAYER on every note's Lens: no base,
// an unkeyed channel is the identity (x 1, + 0). So:
//   stopwatch ON   one key at the playhead holding the layer identity
//   stopwatch OFF  every key of the channel removed (back to the identity)
//   value edit     animated: upsert a key at the playhead; static: refused (no base
//                  to edit), the cell says to turn the key toggle on

import { propertiesOfGroup } from '../schema.js'
import { valueAtEvent } from '../../lensRoam/lensKeyModel.js'
import { isTrailClone } from '../../clones/cloneModel.js'
import {
  MOTION_BLUR_HINT, MOTION_BLUR_MODS, channelKeys, clampLayer, removeOriginKeyAt, sortInstances, upsertOriginKey,
  withoutChannel,
} from './common.js'

const SWEEP_PROPS = propertiesOfGroup('sweep')
const NO_KEYS = Object.freeze([])

export const SWEEP_GROUP_HINT = 'Sweep: a Lens move across several notes. Zoom multiplies every note\'s framing; centre and rotation add. Keys sit on the timeline.'
export const SWEEP_STATIC_BLOCKER = 'Sweep has no static value: turn on the key toggle to animate it'

const keysOf = (data, trackId) => (data.roamOf?.(trackId) ?? data.roamByTrack?.get(trackId))?.sweep ?? NO_KEYS

export const sweepProvider = {
  id: 'sweep',

  groups(track) {
    // Pattern tracks and their Voice clones; a Trail clone replays its source's Sweep.
    if (track.type !== 'Pattern' || isTrailClone(track)) return []
    const t = `t:${track.id}`
    return [{
      key: `${t}/sweep`,
      groupId: 'sweep',
      label: 'Sweep',
      hint: SWEEP_GROUP_HINT,
      provider: sweepProvider,
      target: {},
      children: SWEEP_PROPS.map((prop) => ({ key: `${t}/sweep/${prop.id}`, prop, provider: sweepProvider, target: {} })),
    }]
  },

  keys(row, data) {
    const ch = row.prop.channel
    if (row.prop.type !== 'scalar') return NO_KEYS
    const out = []
    for (const k of channelKeys(keysOf(data, row.trackId), ch)) {
      out.push({
        id: `s:${row.trackId}:${ch}:${k.pos}`,
        rowKey: row.key,
        tick: k.pos,
        value: k.value,
        interp: k.interp ?? 'Linear',
        bez: k.bez,
        hollow: false,
        ref: { kind: 'sweep', trackId: row.trackId, channel: ch, pos: k.pos },
        key: k,
      })
    }
    return sortInstances(out)
  },

  /** The Sweep LAYER at the tick (identity when unkeyed); motion blur: the project setting. */
  valueAt(row, data, tick) {
    const p = row.prop
    if (p.type === 'motionBlur') return data.motionBlur ?? { enabled: false, shutterAngleDeg: 180 }
    const ks = channelKeys(keysOf(data, row.trackId), p.channel)
    return ks.length > 0 ? valueAtEvent(ks, tick, p.identity) : p.identity
  },

  isAnimated(row, data) {
    if (row.prop.type !== 'scalar') return false
    return keysOf(data, row.trackId).some((k) => k.channel === row.prop.channel)
  },

  editBlocker(row, data, tick, intent) {
    if (intent === 'value' && row.prop.type === 'scalar' && !sweepProvider.isAnimated(row, data, tick)) return SWEEP_STATIC_BLOCKER
    return null
  },

  stopwatchPlan(row, data, tick, on) {
    const p = row.prop
    if (!p.animatable || p.type !== 'scalar') return []
    const keys = keysOf(data, row.trackId)
    if (on) {
      return [{ kind: 'sweepKeys', trackId: row.trackId, keys: upsertOriginKey(keys, { channel: p.channel, pos: tick, value: p.identity }, (v) => clampLayer(p, v)) }]
    }
    return [{ kind: 'sweepKeys', trackId: row.trackId, keys: withoutChannel(keys, p.channel) }]
  },

  valuePlan(row, data, tick, value) {
    const p = row.prop
    if (p.type !== 'scalar' || !sweepProvider.isAnimated(row, data, tick)) return []
    return [{ kind: 'sweepKeys', trackId: row.trackId, keys: upsertOriginKey(keysOf(data, row.trackId), { channel: p.channel, pos: tick, value }, (v) => clampLayer(p, v)) }]
  },

  addKeyPlan(row, data, tick) {
    const p = row.prop
    if (p.type !== 'scalar') return []
    const now = sweepProvider.valueAt(row, data, tick)
    return [{ kind: 'sweepKeys', trackId: row.trackId, keys: upsertOriginKey(keysOf(data, row.trackId), { channel: p.channel, pos: tick, value: now }, (v) => clampLayer(p, v)) }]
  },

  removeKeyPlan(row, data, tick) {
    const p = row.prop
    if (p.type !== 'scalar') return []
    const keys = keysOf(data, row.trackId)
    const next = removeOriginKeyAt(keys, p.channel, Math.round(tick))
    return next.length === keys.length ? [] : [{ kind: 'sweepKeys', trackId: row.trackId, keys: next }]
  },

  hint(row) {
    const p = row.prop
    if (p.type === 'motionBlur') return { hint: MOTION_BLUR_HINT, mods: MOTION_BLUR_MODS }
    const how = p.blend === 'multiply' ? 'multiplies' : 'adds to'
    return { hint: `Sweep ${p.label.toLowerCase()}: ${how} every note's Lens ${p.label.toLowerCase()}, timeline keys`, mods: '' }
  },
}

export default sweepProvider
