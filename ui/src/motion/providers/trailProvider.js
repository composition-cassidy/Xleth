// Trail rows (docs/XLETH_CLONE_SPEC.md "Trail clones", docs/XLETH_MOTION_VIEW_DESIGN.md
// R3, R4): a Trail clone's own settings, Trail clones only. The schema group
// 'trail' defines the three rows:
//   Delay    static, whole ticks (the value cell is a musical-value picker + exact ticks)
//   Tint     static colour (swatch + hex)
//   Opacity  animatable, timeline-absolute keys (like Roam: a keyed Trail follows
//            its keys, an unkeyed one holds its base opacity)
// Every write is ONE setCloneSettings call (a 'cloneSettings' plan write), so it
// is one undo step:
//   stopwatch ON   one key at the playhead holding the opacity shown now
//   stopwatch OFF  every key removed AND the base set to the value at the playhead,
//                  in the same patch, so nothing jumps there
//   value edit     animated: upsert a key at the playhead; static: the base (R4)
// The Trail's added Roam (Offset X / Y) is roamProvider's, on the Trail's own id.

import { normaliseHex, propertiesOfGroup } from '../schema.js'
import { isTrailClone } from '../../clones/cloneModel.js'
import { OPACITY_CHANNEL, clampDelayTicks, trailOpacityValueAt } from '../cloneMotion.js'
import { clampFor, removeOriginKeyAt, sortInstances, upsertOriginKey } from './common.js'

const TRAIL_PROPS = propertiesOfGroup('trail')
const NO_KEYS = Object.freeze([])

export const TRAIL_GONE_BLOCKER = 'This Trail clone has no settings yet: wait for the engine'
export const trailGroupHint = (sourceName) => `Trail clone: replays ${sourceName}'s whole picture (notes, Lens, Roam path, Masks, Parent) this far behind, with its own tint and opacity. Video only.`

const settingsOf = (data, trackId) => data.cloneOf?.(trackId) ?? null
const keysOf = (data, trackId) => settingsOf(data, trackId)?.opacityKeys ?? NO_KEYS
const isOpacity = (row) => row.prop.channel === OPACITY_CHANNEL
const write = (row, patch) => ({ kind: 'cloneSettings', trackId: row.trackId, patch })
const clampOpacity = clampFor('trail.opacity')

export const trailProvider = {
  id: 'trail',

  groups(track, data) {
    if (!isTrailClone(track)) return []
    const t = `t:${track.id}`
    const src = data.cloneSourceOf?.(track.id)
    return [{
      key: `${t}/trail`,
      groupId: 'trail',
      label: 'Trail',
      hint: trailGroupHint(src?.name ?? 'its source'),
      provider: trailProvider,
      target: {},
      children: TRAIL_PROPS.map((prop) => ({ key: `${t}/trail/${prop.id}`, prop, provider: trailProvider, target: {} })),
    }]
  },

  keys(row, data) {
    if (!isOpacity(row)) return NO_KEYS
    const out = []
    for (const k of keysOf(data, row.trackId)) {
      out.push({
        id: `to:${row.trackId}:${k.pos}`,
        rowKey: row.key,
        tick: k.pos,
        value: k.value,
        interp: k.interp ?? 'Linear',
        bez: k.bez,
        hollow: false,
        ref: { kind: 'trailOpacity', trackId: row.trackId, channel: OPACITY_CHANNEL, pos: k.pos },
        key: k,
      })
    }
    return sortInstances(out)
  },

  valueAt(row, data, tick) {
    const c = settingsOf(data, row.trackId)
    if (!c) return null
    switch (row.prop.channel) {
      case 'delayTicks': return c.delayTicks
      case 'tint': return c.tint
      case OPACITY_CHANNEL: return trailOpacityValueAt(c, tick)
      default: return null
    }
  },

  isAnimated(row, data) {
    return isOpacity(row) && keysOf(data, row.trackId).length > 0
  },

  editBlocker(row, data) {
    return settingsOf(data, row.trackId) ? null : TRAIL_GONE_BLOCKER
  },

  stopwatchPlan(row, data, tick, on) {
    if (!isOpacity(row)) return []
    const c = settingsOf(data, row.trackId)
    if (!c) return []
    const now = trailOpacityValueAt(c, tick)
    if (on) return [write(row, { opacityKeys: upsertOriginKey(c.opacityKeys, { channel: OPACITY_CHANNEL, pos: tick, value: now }, clampOpacity) })]
    return [write(row, { opacity: clampOpacity(now), opacityKeys: [] })]
  },

  valuePlan(row, data, tick, value) {
    const c = settingsOf(data, row.trackId)
    if (!c) return []
    switch (row.prop.channel) {
      case 'delayTicks': {
        const v = clampDelayTicks(value)
        return v === null || v === c.delayTicks ? [] : [write(row, { delayTicks: v })]
      }
      case 'tint': {
        const hex = normaliseHex(value)
        return !hex || hex === c.tint ? [] : [write(row, { tint: hex })]
      }
      case OPACITY_CHANNEL: {
        const v = clampOpacity(value)
        if (trailProvider.isAnimated(row, data, tick)) {
          return [write(row, { opacityKeys: upsertOriginKey(c.opacityKeys, { channel: OPACITY_CHANNEL, pos: tick, value: v }, clampOpacity) })]
        }
        return [write(row, { opacity: v })]
      }
      default: return []
    }
  },

  addKeyPlan(row, data, tick) {
    return trailProvider.stopwatchPlan(row, data, tick, true)
  },

  removeKeyPlan(row, data, tick) {
    if (!isOpacity(row)) return []
    const keys = keysOf(data, row.trackId)
    const next = removeOriginKeyAt(keys, OPACITY_CHANNEL, Math.round(tick))
    if (next.length === keys.length) return []
    // The last key going: keep the value it held as the base (R3).
    if (next.length === 0) return trailProvider.stopwatchPlan(row, data, tick, false)
    return [write(row, { opacityKeys: next })]
  },

  hint(row) {
    switch (row.prop.channel) {
      case 'delayTicks':
        return { hint: 'Delay: how far behind its source this Trail runs. A musical value or exact ticks (960 = a quarter note)', mods: 'Click: choose a value · type exact ticks in the menu' }
      case 'tint':
        return { hint: "Tint: the colour laid over the Trail's picture", mods: 'Click the swatch: the colour dialog · type a hex value (#RRGGBB)' }
      default:
        return { hint: "Opacity: how strongly the Trail's picture shows. Keys sit on the timeline", mods: '' }
    }
  },
}

export default trailProvider
