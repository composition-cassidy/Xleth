// Lens rows (docs/XLETH_MOTION_VIEW_DESIGN.md R3, R4, R5, R22): Fit, Zoom, Center X,
// Center Y, Rotation, Flip. Two variants, by track kind:
//
//   Clip track (target { kind: 'clip' }): one Lens group. Its rows draw the keys of
//     EVERY clip on the track at clip.start + pos (event-relative keys move with the
//     event). The value cell, the key toggle and the add / remove key button act on
//     the clip under the playhead and are disabled (with a hint) when there is none.
//     Keys are ABSOLUTE: a keyed channel follows its keys, else the clip's base.
//
//   Pattern track (target { kind: 'source', regionId }): one Lens group per source
//     the track plays, titled "Lens" when there is one, "Lens · <region>" otherwise.
//     The hit curve (a LAYER every Follow / Nudge note plays) is drawn under every
//     note as hollow keys (R5); a Nudge / Own note's own keys are filled. The value
//     is the resolved value (base x hit x note, no Sweep) of the note sounding at the
//     playhead (the latest start wins, like the engine), else the base. The key
//     toggle is the hit curve's: ON writes a hit key holding the layer identity at
//     the playhead's place in its note (Head 0 when no note sounds); OFF removes the
//     channel's hit keys and folds the hit value at the playhead into the base.
//     An animated row's edit writes a hit key so the RESOLVED value becomes what was
//     typed: hit = desired / (base x note) for zoom, desired - base - note otherwise.
//
// Clones (docs/XLETH_CLONE_SPEC.md): a Trail clone has no Lens (no group). A Voice
// clone with its own Lens (Own) is a Pattern track like any other: one group per
// region its source plays, on the CLONE's trackId (its own Track Lens and hit
// curve), keys under the notes the clone plays (data.noteStrip). A Linked Voice
// clone plays its source's Lens: one read-only row "Lens · linked to <source>"
// (a group with no rows; the Inspector's Clone section switches it to Own).

import { propertiesOfGroup } from '../schema.js'
import { isTrailClone, isVoiceClone } from '../../clones/cloneModel.js'
import {
  DEFAULT_ZONES, anchorOffset, anchorReached, keyPlaceAt, keysOfChannel, layerIdentity, noteSpan,
  resolveClipLens, resolveNoteLens, sortNoteKeys,
} from '../../lensRoam/lensKeyModel.js'
import { LENS_IDENTITY } from '../../lensRoam/lensRoamModel.js'
import {
  channelKeys, clampFor, clampLayer, combineLayer, layerBetween, playingInstanceAt, removeNoteKeyAt, removeOriginKeyAt,
  sortInstances, upsertNoteKey, upsertOriginKey, withoutChannel,
} from './common.js'

const CLIP_PROPS = propertiesOfGroup('lens', { owner: 'clip' })
const SOURCE_PROPS = propertiesOfGroup('lens', { owner: 'source' })
const NO_KEYS = Object.freeze([])
const MODE_NAMES = ['Follow', 'Nudge', 'Own']

export const NO_CLIP_BLOCKER = 'No clip under the playhead on this track'
export const NO_NOTE_BLOCKER = 'Put the playhead on a note of this source to key its hit curve'
export const OWN_NOTE_BLOCKER = 'The note at the playhead plays its own curve: the hit curve does not reach it'

export const CLIP_LENS_HINT = 'Lens frames the video inside the cell. Keys belong to each clip and move with it; the rows edit the clip under the playhead.'
export const sourceLensHint = (name) => `Lens of ${name}: the framing and the hit curve every note plays. Hollow keys come from the hit curve; filled keys are a note's own (Nudge or Own).`
export const linkedLensLabel = (sourceName) => `Lens · linked to ${sourceName}`
export const linkedLensHint = (sourceName) => `This Voice clone plays ${sourceName}'s Track Lens and hit curve: edit them on ${sourceName}. Inspector > Clone > Lens: Own gives it its own Lens, starting from a copy.`

const isSource = (row) => row.target?.kind === 'source'
const round = (anchor, pos) => (anchor === 'Body' ? pos : Math.round(pos))

// ── Clip variant ──────────────────────────────────────────────────────────────

function clipAt(row, data, tick) {
  const clip = data.clipUnder(row.trackId, tick)
  if (!clip) return null
  return { clip, ...data.clipLensOf(clip) }
}

function clipKeys(row, data) {
  const ch = row.prop.channel
  if (row.prop.type !== 'scalar') return NO_KEYS
  const out = []
  for (const clip of data.clipsByTrack.get(row.trackId) ?? []) {
    const { keys } = data.clipLensOf(clip)
    if (!keys || keys.length === 0) continue
    for (const k of channelKeys(keys, ch)) {
      out.push({
        id: `c:${clip.id}:${ch}:${k.pos}`,
        rowKey: row.key,
        tick: clip.positionTicks + k.pos,
        value: k.value,
        interp: k.interp ?? 'Linear',
        bez: k.bez,
        hollow: false,
        outside: k.pos >= clip.durationTicks,
        ref: { kind: 'clipLens', trackId: row.trackId, clipId: clip.id, channel: ch, pos: k.pos },
        key: k,
      })
    }
  }
  return sortInstances(out)
}

function clipValueAt(row, data, tick) {
  const at = clipAt(row, data, tick)
  if (!at) return null
  const p = row.prop
  const base = { ...LENS_IDENTITY, ...at.lens }
  if (p.type !== 'scalar') return base[p.channel] ?? p.identity
  return resolveClipLens({ base, keys: at.keys, t: tick - at.clip.positionTicks }).resolved[p.channel]
}

// ── Source variant ────────────────────────────────────────────────────────────

/** The note of this source sounding at `tick` and its resolved Lens there, or null. */
function noteAt(row, data, tick) {
  const strip = data.noteStrip(row.trackId)
  const hit = data.noteUnder(row.trackId, tick, row.target.regionId)
  if (!hit) return null
  const i = hit.index
  const src = data.sourceOf(row.trackId, row.target.regionId)
  const note = strip.notes[i]
  const start = strip.starts[i]
  const end = strip.ends[i]
  const mode = MODE_NAMES[strip.modes[i]] ?? 'Follow'
  const resolved = resolveNoteLens({
    base: { ...LENS_IDENTITY, ...src.lens },
    hitKeys: src.hitCurve,
    zones: src.zones,
    mode,
    noteKeys: note?.lensOverride?.keys ?? [],
    noteLen: end - start,
    t: tick - start,
  })
  return { index: i, note, start, end, mode, src, resolved, patternId: strip.patternIds[i], noteId: strip.noteIds[i] }
}

function sourceKeys(row, data) {
  const p = row.prop
  if (p.type !== 'scalar') return NO_KEYS
  const ch = p.channel
  const { regionId } = row.target
  const src = data.sourceOf(row.trackId, regionId)
  const strip = data.noteStrip(row.trackId)
  const hitSorted = sortNoteKeys(keysOfChannel(src.hitCurve, ch), src.zones)
  const out = []
  for (let i = 0; i < strip.count; i++) {
    if (strip.regionIds[i] !== regionId) continue
    const start = strip.starts[i]
    const end = strip.ends[i]
    const len = end - start
    const mode = strip.modes[i]
    const patternId = strip.patternIds[i]
    const noteId = strip.noteIds[i]
    if (mode !== 2 && hitSorted.length > 0) {
      const span = noteSpan(len, src.zones)
      for (const k of hitSorted) {
        out.push({
          id: `h:${row.trackId}:${regionId}:${ch}:${k.anchor}:${k.pos}@${start}`,
          rowKey: row.key,
          tick: start + anchorOffset(span, k.anchor, k.pos),
          value: k.value,
          interp: k.interp ?? 'Linear',
          bez: k.bez,
          hollow: true,
          outside: !anchorReached(span, k.anchor, k.pos),
          ref: { kind: 'hit', trackId: row.trackId, regionId, channel: ch, anchor: k.anchor, pos: k.pos, patternId, noteId, noteStart: start, noteEnd: end },
          key: k,
        })
      }
    }
    if (mode !== 0) {
      const own = keysOfChannel(strip.notes[i]?.lensOverride?.keys, ch)
      if (own.length === 0) continue
      const zones = mode === 2 ? DEFAULT_ZONES : src.zones
      const span = noteSpan(len, zones)
      for (const k of sortNoteKeys(own, zones)) {
        out.push({
          id: `n:${patternId}:${noteId}:${ch}:${k.anchor}:${k.pos}@${start}`,
          rowKey: row.key,
          tick: start + anchorOffset(span, k.anchor, k.pos),
          value: k.value,
          interp: k.interp ?? 'Linear',
          bez: k.bez,
          hollow: false,
          outside: !anchorReached(span, k.anchor, k.pos),
          ref: { kind: 'note', trackId: row.trackId, regionId, patternId, noteId, channel: ch, anchor: k.anchor, pos: k.pos, noteStart: start, noteEnd: end, mode: MODE_NAMES[mode] },
          key: k,
        })
      }
    }
  }
  return sortInstances(out)
}

function sourceValueAt(row, data, tick) {
  const p = row.prop
  const src = data.sourceOf(row.trackId, row.target.regionId)
  const base = { ...LENS_IDENTITY, ...src.lens }
  if (p.type !== 'scalar') return base[p.channel] ?? p.identity
  const at = noteAt(row, data, tick)
  return at ? at.resolved.resolved[p.channel] : base[p.channel]
}

/** Where a hit key at the playhead goes: the playhead's place in its note, else Head 0. */
function hitPlace(at, tick) {
  if (!at) return { anchor: 'Head', pos: 0 }
  const span = noteSpan(at.end - at.start, at.src.zones)
  const place = keyPlaceAt(span, tick - at.start)
  return { anchor: place.anchor, pos: round(place.anchor, place.pos) }
}

// The zones are left out: the write replaces the keys only (setHitCurve keeps the zones).
const hitWrite = (row, keys) => ({
  kind: 'hitCurve', trackId: row.trackId, regionId: row.target.regionId, curve: { keys },
})

/** The note object of a { patternId, noteId } on this track's strip, or null. */
function stripNote(data, trackId, patternId, noteId) {
  const strip = data.noteStrip(trackId)
  for (let i = 0; i < strip.count; i++) {
    if (strip.noteIds[i] === noteId && strip.patternIds[i] === patternId) return strip.notes[i]
  }
  return null
}

// ── The provider ──────────────────────────────────────────────────────────────

export const lensProvider = {
  id: 'lens',

  groups(track, data) {
    const t = `t:${track.id}`
    if (isTrailClone(track)) return []
    if (isVoiceClone(track) && data.cloneOf?.(track.id)?.lensMode !== 'Own') {
      const name = data.cloneSourceOf?.(track.id)?.name ?? 'its source'
      return [{
        key: `${t}/lens`,
        groupId: 'lensLinked',
        label: linkedLensLabel(name),
        hint: linkedLensHint(name),
        provider: lensProvider,
        target: { kind: 'linked', sourceTrackId: track.cloneOf },
        children: [],
      }]
    }
    if (track.type !== 'Pattern') {
      const key = `${t}/lens`
      return [{
        key, groupId: 'lens', label: 'Lens', hint: CLIP_LENS_HINT, provider: lensProvider, target: { kind: 'clip' },
        children: CLIP_PROPS.map((prop) => ({ key: `${key}/${prop.id}`, prop, provider: lensProvider, target: { kind: 'clip' } })),
      }]
    }
    const regions = data.regionsByTrack?.get(track.id) ?? []
    return regions.map((regionId) => {
      const key = regions.length === 1 ? `${t}/lens` : `${t}/lens:${regionId}`
      const name = data.regionName(regionId)
      const target = { kind: 'source', regionId }
      return {
        key,
        groupId: 'lens',
        label: regions.length === 1 ? 'Lens' : `Lens · ${name}`,
        hint: sourceLensHint(name),
        provider: lensProvider,
        target,
        children: SOURCE_PROPS.map((prop) => ({ key: `${key}/${prop.id}`, prop, provider: lensProvider, target })),
      }
    })
  },

  keys(row, data) {
    return isSource(row) ? sourceKeys(row, data) : clipKeys(row, data)
  },

  valueAt(row, data, tick) {
    return isSource(row) ? sourceValueAt(row, data, tick) : clipValueAt(row, data, tick)
  },

  isAnimated(row, data, tick) {
    if (row.prop.type !== 'scalar') return false
    const ch = row.prop.channel
    if (isSource(row)) return data.sourceOf(row.trackId, row.target.regionId).hitCurve.some((k) => k.channel === ch)
    const at = clipAt(row, data, tick)
    return !!at && at.keys.some((k) => k.channel === ch)
  },

  /** intent: 'value' | 'stopwatch' | 'key'. */
  editBlocker(row, data, tick, intent) {
    if (!isSource(row)) return clipAt(row, data, tick) ? null : NO_CLIP_BLOCKER
    if (row.prop.type !== 'scalar' || intent === 'stopwatch') return null
    const animated = lensProvider.isAnimated(row, data, tick)
    if (intent === 'value' && !animated) return null
    const at = noteAt(row, data, tick)
    if (!at) return NO_NOTE_BLOCKER
    if (at.mode === 'Own') return OWN_NOTE_BLOCKER
    return null
  },

  stopwatchPlan(row, data, tick, on) {
    const p = row.prop
    if (!p.animatable || p.type !== 'scalar') return []
    const ch = p.channel
    if (!isSource(row)) {
      const at = clipAt(row, data, tick)
      if (!at) return []
      const now = clipValueAt(row, data, tick)
      if (on) {
        return [{ kind: 'clipLensKeys', clipId: at.clip.id, keys: upsertOriginKey(at.keys, { channel: ch, pos: tick - at.clip.positionTicks, value: now }, clampFor(p.id)) }]
      }
      return [
        { kind: 'clipLens', clipId: at.clip.id, params: { [ch]: clampFor(p.id)(now) } },
        { kind: 'clipLensKeys', clipId: at.clip.id, keys: withoutChannel(at.keys, ch) },
      ]
    }
    const src = data.sourceOf(row.trackId, row.target.regionId)
    const at = noteAt(row, data, tick)
    if (on) {
      const place = hitPlace(at, tick)
      return [hitWrite(row, upsertNoteKey(src.hitCurve, { channel: ch, ...place, value: layerIdentity(ch) }), src)]
    }
    const plan = [hitWrite(row, withoutChannel(src.hitCurve, ch), src)]
    const hit = at && at.mode !== 'Own' ? at.resolved.hit?.[ch] : undefined
    if (hit !== undefined && hit !== layerIdentity(ch)) {
      const base = { ...LENS_IDENTITY, ...src.lens }[ch]
      plan.unshift({ kind: 'trackLens', trackId: row.trackId, regionId: row.target.regionId, params: { [ch]: clampFor(p.id)(combineLayer(p, base, hit)) } })
    }
    return plan
  },

  valuePlan(row, data, tick, value) {
    const p = row.prop
    const ch = p.channel
    if (!isSource(row)) {
      const at = clipAt(row, data, tick)
      if (!at) return []
      if (p.type !== 'scalar') return [{ kind: 'clipLens', clipId: at.clip.id, params: { [ch]: value } }]
      const v = clampFor(p.id)(value)
      if (at.keys.some((k) => k.channel === ch)) {
        return [{ kind: 'clipLensKeys', clipId: at.clip.id, keys: upsertOriginKey(at.keys, { channel: ch, pos: tick - at.clip.positionTicks, value: v }, clampFor(p.id)) }]
      }
      return [{ kind: 'clipLens', clipId: at.clip.id, params: { [ch]: v } }]
    }
    const { regionId } = row.target
    const src = data.sourceOf(row.trackId, regionId)
    if (p.type !== 'scalar') return [{ kind: 'trackLens', trackId: row.trackId, regionId, params: { [ch]: value } }]
    const base = { ...LENS_IDENTITY, ...src.lens }[ch]
    const at = noteAt(row, data, tick)
    if (lensProvider.isAnimated(row, data, tick)) {
      if (!at || at.mode === 'Own') return []
      const noteLayer = at.resolved.note?.[ch] ?? layerIdentity(ch)
      const rest = combineLayer(p, base, noteLayer)
      const hit = clampLayer(p, layerBetween(p, rest, value))
      return [hitWrite(row, upsertNoteKey(src.hitCurve, { channel: ch, ...hitPlace(at, tick), value: hit }), src)]
    }
    const current = at ? at.resolved.resolved[ch] : base
    const next = clampFor(p.id)(combineLayer(p, base, layerBetween(p, current, value)))
    return [{ kind: 'trackLens', trackId: row.trackId, regionId, params: { [ch]: next } }]
  },

  addKeyPlan(row, data, tick) {
    const p = row.prop
    if (p.type !== 'scalar') return []
    if (!isSource(row)) return lensProvider.stopwatchPlan(row, data, tick, true)
    const at = noteAt(row, data, tick)
    if (!at || at.mode === 'Own') return []
    const src = at.src
    const hit = at.resolved.hit?.[p.channel] ?? layerIdentity(p.channel)
    return [hitWrite(row, upsertNoteKey(src.hitCurve, { channel: p.channel, ...hitPlace(at, tick), value: hit }), src)]
  },

  removeKeyPlan(row, data, tick) {
    const p = row.prop
    if (p.type !== 'scalar') return []
    const ch = p.channel
    if (!isSource(row)) {
      const at = clipAt(row, data, tick)
      if (!at) return []
      const pos = Math.round(tick - at.clip.positionTicks)
      const next = removeOriginKeyAt(at.keys, ch, pos)
      if (next.length === at.keys.length) return []
      if (!next.some((k) => k.channel === ch)) return lensProvider.stopwatchPlan(row, data, tick, false)
      return [{ kind: 'clipLensKeys', clipId: at.clip.id, keys: next }]
    }
    const inst = lensProvider.keyAtPlayhead(row, data, tick)
    if (!inst) return []
    if (inst.hollow) {
      const src = data.sourceOf(row.trackId, row.target.regionId)
      return [hitWrite(row, removeNoteKeyAt(src.hitCurve, ch, inst.ref.anchor, inst.ref.pos), src)]
    }
    const note = stripNote(data, row.trackId, inst.ref.patternId, inst.ref.noteId)
    const keys = removeNoteKeyAt(note?.lensOverride?.keys ?? [], ch, inst.ref.anchor, inst.ref.pos)
    return [{ kind: 'notesLensKeys', entries: [{ patternId: inst.ref.patternId, noteId: inst.ref.noteId, keys }] }]
  },

  /**
   * The key the add / remove key button acts on at `tick` (navState's "at a key"),
   * or null: a key that plays there, of the event the engine plays there. At a
   * boundary (a legato note's end = the next note's start, a clip's end = the next
   * clip's start) several keys share the tick; the one of the earlier event is not
   * the one the user sees play. `instances` = this row's keys (cached by the caller).
   */
  keyAtPlayhead(row, data, tick, instances = lensProvider.keys(row, data)) {
    if (!isSource(row)) {
      const clip = data.clipUnder(row.trackId, tick)
      return clip ? playingInstanceAt(instances, tick, (k) => k.ref.clipId === clip.id) : null
    }
    const strip = data.noteStrip(row.trackId)
    const hit = data.noteUnder(row.trackId, tick, row.target.regionId)
    // No note sounds here (the playhead at the last note's end): any key drawn here.
    if (!hit) return playingInstanceAt(instances, tick)
    const start = strip.starts[hit.index]
    const patternId = strip.patternIds[hit.index]
    const noteId = strip.noteIds[hit.index]
    return playingInstanceAt(instances, tick, (k) => k.ref.noteStart === start
      && (k.ref.kind === 'hit' || (k.ref.patternId === patternId && k.ref.noteId === noteId)))
  },

  hint(row) {
    const p = row.prop
    if (p.type !== 'scalar') {
      return { hint: `${p.label}: ${p.channel === 'fit' ? 'how the video fills the cell' : 'mirror the framed picture'}`, mods: '' }
    }
    if (isSource(row)) {
      return {
        hint: `${p.label}: the note at the playhead (base, hit curve and the note's own keys). Key toggle: the hit curve`,
        mods: 'Hollow keys: the hit curve · Filled: a note\'s own keys',
      }
    }
    return { hint: `${p.label}: the clip under the playhead. Keys move with their clip`, mods: '' }
  },
}

export default lensProvider
