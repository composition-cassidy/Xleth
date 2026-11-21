// Motion view: everything the view needs, fetched once and kept current
// (docs/XLETH_MOTION_VIEW_DESIGN.md 5.1, R18, R22).
//
// The timeline already holds the tracks, clips, pattern blocks, patterns and
// regions (TimelineView state); this hook adds what only the Lens / Roam getter
// knows: every track's Roam base and keys, Sweep keys, Parent and Masks, every
// Pattern source's Lens base and hit curve, and (Motion view only) every Clip
// track event's Lens. Plus the grid layout (which tracks have a cell) and the
// project's motion blur setting (R1).
//
// It refetches on the arrangement's refresh events (the same set every Lens /
// Roam hook follows; undo and redo announce themselves only through these) plus
// the pattern events (note overrides live on notes). A burst of events is ONE
// fetch (coalesced in a microtask) and a token drops a response a newer request
// has overtaken. A write's post-state (the 'lens-roam-changed' detail, or a
// motion plan's results through adopt()) is adopted at once, so a committed key
// never flickers back for the moment before the refetch lands.
//
// The derivations are pure and exported (buildMotionData, computeMotionTrackIds,
// buildNoteStrip, adoptPostState) so they are tested without React.
//
// MotionData (what providers, the row registry and the canvas read):
//   { version, tracks, tracksById, roamByTrack: Map<trackId, { roam, keys, sweep,
//     parentTrackId, masks }>, clipLens: Map<clipId, { lens, keys }>,
//     sources: Map<'trackId:regionId', { trackId, regionId, explicit, lens, hitCurve, zones }>,
//     placed: Set<trackId>, layout, motionBlur: { enabled, shutterAngleDeg },
//     clipsByTrack: Map<trackId, clip[] by start>, blocksByTrack, regionsByTrack: Map<trackId, regionId[]>,
//     patterns, regions,
//     noteStrip(trackId) -> NoteStrip (lazy, cached), clipUnder(trackId, tick), noteUnder(trackId, tick, regionId?),
//     clipLensOf(clip) -> { lens, keys }, sourceOf(trackId, regionId), regionName(regionId),
//     cloneOf(trackId) -> a Clone's settings (cloneMotion.normalizeClone) or null }
//
// Clones (docs/XLETH_CLONE_SPEC.md): a Clone track has no pattern blocks of its
// own; it plays its source's. noteStrip(id) is therefore the notes each CELL
// plays: a source's voice-0 notes (plus the overflow ones) once it has Voice
// clones, a Voice clone's own voice, a Trail clone's voice-0 notes shifted
// delayTicks later. regionsByTrack of a Voice clone with its own Lens (Own) is its
// source's regions (its Lens rows); a Linked Voice clone and a Trail have none.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { timelineEvents } from '../timelineEvents.js'
import { getLensRoam } from '../lensRoam/lensRoamApi.js'
import { REFRESH_EVENTS } from '../lensRoam/useLensRoam.js'
import { LENS_IDENTITY, ROAM_IDENTITY, normalizeRoam, roamIsIdentity } from '../lensRoam/lensRoamModel.js'
import { fxKeysFromWire } from './fxModel.js'
import { DEFAULT_ZONES } from '../lensRoam/lensKeyModel.js'
import { isClone, isTrailClone, isVoiceClone, noteFilterFor } from '../clones/cloneModel.js'
import { fromWireList } from './maskModel.js'
import { normalizeClone } from './cloneMotion.js'

const TAG = '[MotionView]'

/** Every event Motion view refetches on: the Lens / Roam set plus the pattern events (note overrides). */
export const MOTION_REFRESH_EVENTS = Object.freeze([
  ...REFRESH_EVENTS,
  'timeline-patterns-changed',
  'timeline-pattern-changed',
])

const NO_KEYS = Object.freeze([])
const fin = (v) => typeof v === 'number' && Number.isFinite(v)
export const sourceKey = (trackId, regionId) => `${trackId}:${regionId}`

/** The project's motion blur as Motion view shows it (R1): { enabled, shutterAngleDeg }. */
export function normalizeMotionBlur(m) {
  const deg = fin(m?.shutterAngleDeg) ? m.shutterAngleDeg : fin(m?.shutterAngle) ? m.shutterAngle : 180
  return { enabled: !!m?.enabled, shutterAngleDeg: deg }
}

/** An empty fetch state (nothing known yet). */
export function emptyLensRoamState() {
  return {
    roamByTrack: new Map(),
    clipLens: new Map(),
    sources: new Map(),
    clones: new Map(),
    placed: new Set(),
    layout: null,
    motionBlur: normalizeMotionBlur(null),
  }
}

function roamEntry(t) {
  return {
    roam: t?.roam ? normalizeRoam(t.roam) : ROAM_IDENTITY,
    keys: Array.isArray(t?.keys) ? t.keys : NO_KEYS,
    sweep: Array.isArray(t?.sweep) ? t.sweep : NO_KEYS,
    parentTrackId: Number.isInteger(t?.parentTrackId) ? t.parentTrackId : -1,
    masks: fromWireList(t?.masks),
    // Video effect param keys, in the UI's key shape (channel = 'uid:param').
    fxKeys: fxKeysFromWire(t?.fxKeys),
  }
}

function sourceEntry(s) {
  return {
    trackId: s.trackId,
    regionId: s.regionId,
    explicit: !!s.explicit,
    lens: s.lens ?? LENS_IDENTITY,
    hitCurve: Array.isArray(s.hitCurve) ? s.hitCurve : NO_KEYS,
    zones: s.zones ?? DEFAULT_ZONES,
  }
}

/**
 * The fetch state built from one round of answers:
 *   lensRoam = getLensRoam(...) result, layout = getGridLayout(), motionBlur = getMotionBlur().
 * `prev` keeps the clip Lens map when this round did not ask for clips.
 */
export function lensRoamStateFrom({ lensRoam, layout, motionBlur, includeClips = true }, prev = null) {
  const roamByTrack = new Map()
  const clones = new Map()
  for (const t of lensRoam?.tracks ?? []) {
    roamByTrack.set(t.trackId, roamEntry(t))
    const c = normalizeClone(t.clone)
    if (c && Number.isInteger(t.cloneOf) && t.cloneOf >= 0) clones.set(t.trackId, c)
  }
  const sources = new Map()
  for (const s of lensRoam?.sources ?? []) sources.set(sourceKey(s.trackId, s.regionId), sourceEntry(s))
  let clipLens
  if (includeClips) {
    clipLens = new Map()
    for (const c of lensRoam?.clips ?? []) clipLens.set(c.clipId, { lens: c.lens ?? LENS_IDENTITY, keys: Array.isArray(c.keys) ? c.keys : NO_KEYS })
  } else {
    clipLens = prev?.clipLens ?? new Map()
  }
  const placed = new Set()
  for (const s of layout?.slots ?? []) placed.add(s.trackId)
  for (const l of layout?.fullscreenLayers ?? []) placed.add(l.trackId)
  return { roamByTrack, clipLens, sources, clones, placed, layout: layout ?? null, motionBlur: normalizeMotionBlur(motionBlur) }
}

/**
 * The fetch state with one write's post-state adopted (a 'lens-roam-changed'
 * detail, or a motion plan's result). Returns `state` itself when nothing applies.
 *   { trackId, roam, keys }                     Roam base / keys
 *   { trackId, keys } (no roam, no regionId)    Sweep keys
 *   { trackId, masks }                          Masks
 *   { trackId, parentTrackId, roam, keys }      Parent (+ the keep-on-screen base)
 *   { clipId, lens, keys? }                     a clip's Lens
 *   { trackId, regionId, lens, hitCurve?, zones?, explicit? }   a Pattern source
 *   { trackId, clone }                          a Clone's settings (setCloneSettings)
 */
export function adoptPostState(state, d) {
  if (!d || typeof d !== 'object') return state
  if (Number.isInteger(d.trackId) && d.clone && typeof d.clone === 'object') {
    const c = normalizeClone(d.clone)
    if (!c) return state
    const clones = new Map(state.clones ?? [])
    clones.set(d.trackId, c)
    return { ...state, clones }
  }
  if (Number.isInteger(d.clipId)) {
    const cur = state.clipLens.get(d.clipId)
    const next = { lens: d.lens ?? cur?.lens ?? LENS_IDENTITY, keys: Array.isArray(d.keys) ? d.keys : cur?.keys ?? NO_KEYS }
    const clipLens = new Map(state.clipLens)
    clipLens.set(d.clipId, next)
    return { ...state, clipLens }
  }
  if (!Number.isInteger(d.trackId)) return state
  if (d.regionId !== undefined) {
    if (!Number.isInteger(d.regionId)) return state
    const k = sourceKey(d.trackId, d.regionId)
    const cur = state.sources.get(k)
    const next = {
      trackId: d.trackId,
      regionId: d.regionId,
      explicit: d.explicit ?? cur?.explicit ?? false,
      lens: d.lens ?? cur?.lens ?? LENS_IDENTITY,
      hitCurve: Array.isArray(d.hitCurve) ? d.hitCurve : cur?.hitCurve ?? NO_KEYS,
      zones: d.zones ?? cur?.zones ?? DEFAULT_ZONES,
    }
    const sources = new Map(state.sources)
    sources.set(k, next)
    return { ...state, sources }
  }
  const cur = state.roamByTrack.get(d.trackId) ?? roamEntry(null)
  const next = { ...cur }
  let touched = false
  if (Array.isArray(d.masks)) { next.masks = fromWireList(d.masks); touched = true }
  if (Array.isArray(d.fxKeys)) { next.fxKeys = fxKeysFromWire(d.fxKeys); touched = true }
  if (Number.isInteger(d.parentTrackId)) { next.parentTrackId = d.parentTrackId; touched = true }
  if (d.roam && typeof d.roam === 'object') {
    next.roam = d.roam
    if (Array.isArray(d.keys)) next.keys = d.keys
    touched = true
  } else if (Array.isArray(d.keys) && !Array.isArray(d.masks)) {
    // No roam beside the keys: a Sweep write ({ trackId, changed, keys }).
    next.sweep = d.keys
    touched = true
  }
  if (!touched) return state
  const roamByTrack = new Map(state.roamByTrack)
  roamByTrack.set(d.trackId, next)
  return { ...state, roamByTrack }
}

/** id -> clip object of a clips list. */
export function clipsById(clips) {
  const m = new Map()
  for (const c of clips ?? []) if (c && Number.isInteger(c.id)) m.set(c.id, c)
  return m
}

/**
 * The fetch state without the clip Lens entries whose clip was refetched: a clip
 * that is a new object (or gone) in `next` carries the engine's Lens on clip.lens,
 * which then wins (clipLensOf reads the map first). A clip that is the same object
 * keeps its entry (an adopted write clip.lens does not have yet). The Edit view
 * runs this whenever the clips are replaced, since it does not fetch the map.
 * Returns `state` itself when nothing goes.
 */
export function dropRefetchedClipLens(state, prev, next) {
  if (!state?.clipLens?.size || !prev) return state
  let clipLens = null
  for (const id of state.clipLens.keys()) {
    const c = next.get(id)
    if (c && c === prev.get(id)) continue
    clipLens ??= new Map(state.clipLens)
    clipLens.delete(id)
  }
  return clipLens ? { ...state, clipLens } : state
}

// ── Notes on the timeline (the reference strip, Pattern-track Lens keys) ────────

const EMPTY_STRIP = Object.freeze({
  count: 0,
  starts: new Float64Array(0),
  ends: new Float64Array(0),
  pitches: new Int16Array(0),
  noteIds: new Int32Array(0),
  patternIds: new Int32Array(0),
  regionIds: new Int32Array(0),
  modes: new Uint8Array(0),
  notes: Object.freeze([]),
  minPitch: 0,
  maxPitch: 0,
  maxLen: 0,
})

/** The Lens mode code of a note: 0 Follow, 1 Nudge, 2 Own. */
export function noteModeCode(note) {
  const m = note?.lensOverride?.mode
  return m === 'Nudge' ? 1 : m === 'Own' ? 2 : 0
}

/**
 * Every note instance one Pattern track plays, on the timeline, sorted by start
 * (then pitch): the same walk the Reel lane model and the engine's video event
 * builder use (block slice of an endless tape of the pattern, loop off = one pass,
 * note-off clamped to the block end, slide notes spawn nothing). Unlike the Reel
 * lane it covers tracks WITHOUT video too (the reference strip needs every note).
 *   { count, starts, ends (Float64Array), pitches, noteIds, patternIds, regionIds,
 *     modes (typed), notes: [note object per instance], minPitch, maxPitch, maxLen }
 * Options (Clones): filterFor(pattern) -> (note) => bool | null keeps only the notes
 * one cell plays (cloneModel.noteFilterFor; null = every note); shift moves every
 * instance later by that many ticks (a Trail's delay; the block end still clamps
 * the note-off before the shift).
 */
export function buildNoteStrip(blocks, patterns, { filterFor = null, shift = 0 } = {}) {
  const items = []
  const filters = new Map()
  const filterOf = (pattern) => {
    if (!filterFor) return null
    if (!filters.has(pattern.id)) filters.set(pattern.id, filterFor(pattern))
    return filters.get(pattern.id)
  }
  const dt = fin(shift) ? shift : 0
  for (const block of blocks ?? []) {
    const pattern = patterns?.[block.patternId]
    if (!pattern) continue
    const keep = filterOf(pattern)
    const patLen = pattern.lengthTicks
    const blockDur = block.durationTicks
    const notes = pattern.notes
    if (!(patLen > 0) || !(blockDur > 0) || !Array.isArray(notes) || notes.length === 0) continue
    const windowStart = block.offsetTicks || 0
    const windowEnd = windowStart + blockDur
    if (windowEnd <= 0) continue
    const blockPos = block.positionTicks
    const blockEnd = blockPos + blockDur
    const firstLoop = Math.max(0, Math.floor(windowStart / patLen))
    let lastLoop = Math.floor((windowEnd - 1) / patLen)
    if (block.loopEnabled === false) lastLoop = Math.min(lastLoop, 0)
    for (let L = firstLoop; L <= lastLoop; L++) {
      for (const note of notes) {
        if (!note || note.isSlide) continue
        if (keep && !keep(note)) continue
        const tape = L * patLen + note.positionTicks
        if (tape < windowStart || tape >= windowEnd) continue
        const start = blockPos + (tape - windowStart)
        const end = Math.min(start + (note.durationTicks ?? 0), blockEnd)
        if (!(end > start)) continue
        items.push({ start: start + dt, end: end + dt, note, patternId: pattern.id, regionId: pattern.regionId })
      }
    }
  }
  if (items.length === 0) return EMPTY_STRIP
  items.sort((a, b) => (a.start - b.start) || ((a.note.pitch ?? 0) - (b.note.pitch ?? 0)))
  const n = items.length
  const s = {
    count: n,
    starts: new Float64Array(n),
    ends: new Float64Array(n),
    pitches: new Int16Array(n),
    noteIds: new Int32Array(n),
    patternIds: new Int32Array(n),
    regionIds: new Int32Array(n),
    modes: new Uint8Array(n),
    notes: new Array(n),
    minPitch: Infinity,
    maxPitch: -Infinity,
    maxLen: 0,
  }
  for (let i = 0; i < n; i++) {
    const it = items[i]
    const pitch = fin(it.note.pitch) ? it.note.pitch : 60
    s.starts[i] = it.start
    s.ends[i] = it.end
    s.pitches[i] = pitch
    s.noteIds[i] = Number.isInteger(it.note.id) ? it.note.id : -1
    s.patternIds[i] = it.patternId
    s.regionIds[i] = Number.isInteger(it.regionId) ? it.regionId : -1
    s.modes[i] = noteModeCode(it.note)
    s.notes[i] = it.note
    if (pitch < s.minPitch) s.minPitch = pitch
    if (pitch > s.maxPitch) s.maxPitch = pitch
    if (it.end - it.start > s.maxLen) s.maxLen = it.end - it.start
  }
  return s
}

/** First index whose value is >= v in a sorted typed array (lower bound). */
export function lowerBound(arr, v, n = arr.length) {
  let lo = 0
  let hi = n
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (arr[mid] < v) lo = mid + 1
    else hi = mid
  }
  return lo
}

/**
 * The note instance sounding at `tick` (start <= tick < end), the latest start
 * winning and an exact tie going to the lowest pitch (the engine's one-active-
 * event rule). `regionId` narrows it to one source. Index into the strip, or -1.
 */
export function noteIndexAt(strip, tick, regionId = null) {
  if (!strip || strip.count === 0 || !fin(tick)) return -1
  // Last start <= tick.
  let i = lowerBound(strip.starts, tick + 1e-9, strip.count) - 1
  const floor = tick - strip.maxLen
  let best = -1
  for (; i >= 0 && strip.starts[i] > floor - 1e-9; i--) {
    if (regionId !== null && strip.regionIds[i] !== regionId) continue
    if (strip.ends[i] <= tick) continue
    if (best >= 0 && strip.starts[i] < strip.starts[best]) break
    // Same start: the strip is sorted by pitch inside one start, so the lower index (lower pitch) wins.
    best = i
  }
  return best
}

// ── The data the view reads ───────────────────────────────────────────────────

const byStart = (a, b) => (a.positionTicks - b.positionTicks) || (a.id - b.id)

let versionCounter = 0

/**
 * Everything Motion view reads, derived from the timeline state and one fetch
 * state (see the file header). Pure; its lazy parts (note strips) are cached on
 * the returned object, so build a new one whenever an input changes.
 */
export function buildMotionData({ tracks, clips, patternBlocks, patterns, regions, lensRoam } = {}) {
  const st = lensRoam ?? emptyLensRoamState()
  const list = Array.isArray(tracks) ? tracks : []
  const tracksById = new Map(list.map((t) => [t.id, t]))

  const clipsByTrack = new Map()
  for (const c of clips ?? []) {
    if (!c || !tracksById.has(c.trackId)) continue
    let arr = clipsByTrack.get(c.trackId)
    if (!arr) { arr = []; clipsByTrack.set(c.trackId, arr) }
    arr.push(c)
  }
  for (const arr of clipsByTrack.values()) arr.sort(byStart)
  // The longest clip per track bounds the backwards search of clipUnder.
  const maxClipLen = new Map()
  for (const [id, arr] of clipsByTrack) {
    let m = 0
    for (const c of arr) if (c.durationTicks > m) m = c.durationTicks
    maxClipLen.set(id, m)
  }

  const blocksByTrack = new Map()
  for (const b of patternBlocks ?? []) {
    if (!b || !tracksById.has(b.trackId)) continue
    let arr = blocksByTrack.get(b.trackId)
    if (!arr) { arr = []; blocksByTrack.set(b.trackId, arr) }
    arr.push(b)
  }

  // Clones: the settings each Clone track has (the fetched / adopted post-state
  // first, else what getTracks carried), and the live source of each.
  const clones = new Map()
  const cloneSource = new Map()
  for (const t of list) {
    if (!isClone(t)) continue
    const c = st.clones?.get(t.id) ?? normalizeClone(t.clone) ?? normalizeClone({ cloneOf: t.cloneOf })
    clones.set(t.id, c)
    const src = tracksById.get(t.cloneOf)
    if (src && !isClone(src)) cloneSource.set(t.id, src)
  }
  const cloneOf = (trackId) => clones.get(trackId) ?? null

  // A Pattern track's sources: the regions its blocks' patterns play, ascending.
  const regionsOfBlocks = (blocks) => {
    const set = new Set()
    for (const b of blocks ?? []) {
      const p = patterns?.[b.patternId]
      if (p && Number.isInteger(p.regionId) && p.regionId >= 0) set.add(p.regionId)
    }
    return [...set].sort((a, b) => a - b)
  }
  const regionsByTrack = new Map()
  for (const t of list) {
    if (t.type !== 'Pattern') continue
    if (isClone(t)) {
      // A Voice clone with its own Lens has a Lens per source region; Linked and Trails none.
      const src = cloneSource.get(t.id)
      const own = isVoiceClone(t) && clones.get(t.id)?.lensMode === 'Own'
      regionsByTrack.set(t.id, own && src ? regionsOfBlocks(blocksByTrack.get(src.id)) : [])
      continue
    }
    regionsByTrack.set(t.id, regionsOfBlocks(blocksByTrack.get(t.id)))
  }

  // The notes each cell plays (see the file header).
  const stripCache = new Map()
  const noteStrip = (trackId) => {
    let s = stripCache.get(trackId)
    if (!s) {
      const t = tracksById.get(trackId)
      if (t && isClone(t)) {
        const src = cloneSource.get(trackId)
        const shift = isTrailClone(t) ? (clones.get(trackId)?.delayTicks ?? 0) : 0
        s = src
          ? buildNoteStrip(blocksByTrack.get(src.id), patterns, { filterFor: (p) => noteFilterFor(list, t, p), shift })
          : EMPTY_STRIP
      } else if (t) {
        s = buildNoteStrip(blocksByTrack.get(trackId), patterns, { filterFor: (p) => noteFilterFor(list, t, p) })
      } else {
        s = buildNoteStrip(blocksByTrack.get(trackId), patterns)
      }
      stripCache.set(trackId, s)
    }
    return s
  }

  /** The clip on a Clip track under `tick` (start <= tick < end, the latest start winning), or null. */
  const clipUnder = (trackId, tick) => {
    const arr = clipsByTrack.get(trackId)
    if (!arr || arr.length === 0 || !fin(tick)) return null
    const maxLen = maxClipLen.get(trackId) ?? 0
    let lo = 0
    let hi = arr.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (arr[mid].positionTicks <= tick) lo = mid + 1
      else hi = mid
    }
    for (let i = lo - 1; i >= 0 && arr[i].positionTicks > tick - maxLen - 1e-9; i--) {
      const c = arr[i]
      if (tick < c.positionTicks + c.durationTicks) return c
    }
    return null
  }

  const clipLensOf = (clip) => {
    if (!clip) return null
    const fetched = st.clipLens.get(clip.id)
    if (fetched) return fetched
    const own = clip.lens
    if (own && typeof own === 'object') {
      return { lens: own.base ?? own.lens ?? LENS_IDENTITY, keys: Array.isArray(own.keys) ? own.keys : NO_KEYS }
    }
    return { lens: LENS_IDENTITY, keys: NO_KEYS }
  }

  const sourceOf = (trackId, regionId) => st.sources.get(sourceKey(trackId, regionId)) ?? {
    trackId, regionId, explicit: false, lens: LENS_IDENTITY, hitCurve: NO_KEYS, zones: DEFAULT_ZONES,
  }

  return {
    version: ++versionCounter,
    tracks: list,
    tracksById,
    roamByTrack: st.roamByTrack,
    clipLens: st.clipLens,
    sources: st.sources,
    placed: st.placed,
    layout: st.layout,
    motionBlur: st.motionBlur,
    clipsByTrack,
    blocksByTrack,
    regionsByTrack,
    patterns: patterns ?? {},
    regions: regions ?? {},
    noteStrip,
    noteUnder: (trackId, tick, regionId = null) => {
      const strip = noteStrip(trackId)
      const i = noteIndexAt(strip, tick, regionId)
      return i < 0 ? null : { strip, index: i }
    },
    clipUnder,
    clipLensOf,
    sourceOf,
    clones,
    cloneOf,
    /** A Clone's live source track (not a Clone itself), or null. */
    cloneSourceOf: (trackId) => cloneSource.get(trackId) ?? null,
    roamOf: (trackId) => st.roamByTrack.get(trackId) ?? null,
    regionName: (regionId) => {
      const r = regions?.[regionId]
      return r?.name ? String(r.name) : `Region ${regionId}`
    },
  }
}

/**
 * The tracks that have motion (R18): any of Roam keys, a non-identity Roam base,
 * Sweep keys, clip Lens keys on any of its clips, hit-curve keys, Nudge / Own
 * notes, a Parent (a track that exists), a Mask, Trail opacity keys.
 */
export function computeMotionTrackIds(data) {
  const out = new Set()
  if (!data) return out
  for (const t of data.tracks) {
    const id = t.id
    if ((data.cloneOf?.(id)?.opacityKeys?.length ?? 0) > 0) { out.add(id); continue }
    const e = data.roamByTrack.get(id)
    if (e) {
      if (e.keys.length > 0 || e.sweep.length > 0 || e.masks.length > 0) { out.add(id); continue }
      if (e.roam && !roamIsIdentity(e.roam)) { out.add(id); continue }
      if (e.parentTrackId >= 0 && e.parentTrackId !== id && data.tracksById.has(e.parentTrackId)) { out.add(id); continue }
    }
    if (t.type === 'Pattern') {
      let hit = false
      for (const regionId of data.regionsByTrack.get(id) ?? []) {
        if (data.sourceOf(id, regionId).hitCurve.length > 0) { hit = true; break }
      }
      if (!hit) {
        const seen = new Set()
        for (const b of data.blocksByTrack.get(id) ?? []) {
          if (seen.has(b.patternId)) continue
          seen.add(b.patternId)
          const notes = data.patterns?.[b.patternId]?.notes
          if (Array.isArray(notes) && notes.some((n) => noteModeCode(n) !== 0)) { hit = true; break }
        }
      }
      if (hit) out.add(id)
    } else {
      for (const c of data.clipsByTrack.get(id) ?? []) {
        if ((data.clipLensOf(c)?.keys?.length ?? 0) > 0) { out.add(id); break }
      }
    }
  }
  return out
}

const sameSet = (a, b) => a.size === b.size && [...a].every((v) => b.has(v))

// ── The hook ──────────────────────────────────────────────────────────────────

/**
 * @param {{ tracks, clips, patternBlocks, patterns, regions, includeClipLens?: boolean,
 *           enabled?: boolean }} args
 *   includeClipLens: also fetch every Clip-track event's Lens (Motion view; Edit
 *   view reads the Lens each clip already carries).
 * @returns {{ data, motionTrackIds: Set<number>, refresh(), adopt(detailOrResults) }}
 */
export function useMotionData({ tracks, clips, patternBlocks, patterns, regions, includeClipLens = false, enabled = true } = {}) {
  const [lensRoam, setLensRoam] = useState(emptyLensRoamState)
  const token = useRef(0)
  const pending = useRef(false)
  const inputs = useRef(null)
  inputs.current = { tracks, clips, patternBlocks, patterns, includeClipLens, enabled }

  const fetchNow = useCallback(async () => {
    pending.current = false
    const { tracks: ts, clips: cs, patternBlocks: bs, patterns: ps, includeClipLens: withClips, enabled: on } = inputs.current
    if (!on) return
    const list = Array.isArray(ts) ? ts : []
    const trackIds = list.map((t) => t.id)
    const patternTrack = new Set(list.filter((t) => t.type === 'Pattern').map((t) => t.id))
    const sourceSeen = new Set()
    const sources = []
    for (const b of bs ?? []) {
      if (!patternTrack.has(b.trackId)) continue
      const p = ps?.[b.patternId]
      if (!p || !Number.isInteger(p.regionId) || p.regionId < 0) continue
      const k = sourceKey(b.trackId, p.regionId)
      if (sourceSeen.has(k)) continue
      sourceSeen.add(k)
      sources.push({ trackId: b.trackId, regionId: p.regionId })
    }
    // A Voice clone's own Track Lens, per region its source plays (its Lens rows
    // when Own; fetched in both modes so switching to Own needs no new key).
    for (const t of list) {
      if (!isVoiceClone(t)) continue
      for (const s of sources.slice()) {
        if (s.trackId !== t.cloneOf) continue
        const k = sourceKey(t.id, s.regionId)
        if (sourceSeen.has(k)) continue
        sourceSeen.add(k)
        sources.push({ trackId: t.id, regionId: s.regionId })
      }
    }
    const clipTrack = new Set(list.filter((t) => t.type !== 'Pattern').map((t) => t.id))
    const clipIds = withClips ? (cs ?? []).filter((c) => clipTrack.has(c.trackId)).map((c) => c.id) : []
    const mine = ++token.current
    let res = null
    let layout = null
    let blur = null
    try {
      const tl = window.xleth?.timeline
      ;[res, layout, blur] = await Promise.all([
        trackIds.length || sources.length || clipIds.length
          ? getLensRoam({ trackIds, sources, ...(withClips ? { clipIds } : {}) })
          : Promise.resolve({ tracks: [], sources: [], clips: [] }),
        tl?.getGridLayout?.() ?? null,
        tl?.getMotionBlur?.() ?? null,
      ])
    } catch (err) {
      console.error(`${TAG} data refresh failed:`, err?.message ?? err)
      return
    }
    if (mine !== token.current) return
    setLensRoam((prev) => lensRoamStateFrom({ lensRoam: res, layout, motionBlur: blur, includeClips: withClips }, prev))
  }, [])

  const refresh = useCallback(() => {
    if (pending.current) return
    pending.current = true
    queueMicrotask(() => { fetchNow() })
  }, [fetchNow])

  // What the fetch depends on: the track ids, the Pattern sources and (Motion view) the clip ids.
  const fetchKey = useMemo(() => {
    const ids = (tracks ?? []).map((t) => `${t.id}${t.type === 'Pattern' ? 'p' : 'c'}${isClone(t) ? `>${t.cloneOf}${isTrailClone(t) ? 't' : 'v'}` : ''}`).join(',')
    let src = ''
    for (const b of patternBlocks ?? []) src += `${b.trackId}:${patterns?.[b.patternId]?.regionId};`
    const cl = includeClipLens ? (clips ?? []).map((c) => c.id).join(',') : ''
    return `${ids}|${src}|${cl}|${enabled ? 1 : 0}`
  }, [tracks, patternBlocks, patterns, clips, includeClipLens, enabled])

  useEffect(() => { refresh() }, [fetchKey, refresh])

  useEffect(() => {
    const on = () => refresh()
    for (const e of MOTION_REFRESH_EVENTS) timelineEvents.addEventListener(e, on)
    return () => { for (const e of MOTION_REFRESH_EVENTS) timelineEvents.removeEventListener(e, on) }
  }, [refresh])

  const adopt = useCallback((detail) => {
    const list = Array.isArray(detail) ? detail : [detail]
    token.current++     // a refetch already in flight is older than this post-state
    setLensRoam((s) => list.reduce((acc, d) => adoptPostState(acc, d), s))
    refresh()
  }, [refresh])

  // Any write announces its post-state on 'lens-roam-changed': adopt it at once.
  useEffect(() => {
    const on = (e) => {
      if (!e.detail) return
      token.current++
      setLensRoam((s) => adoptPostState(s, e.detail))
    }
    timelineEvents.addEventListener('lens-roam-changed', on)
    // A Clone settings write (cloneApi): { trackId, changed, clone }.
    timelineEvents.addEventListener('clone-settings-changed', on)
    return () => {
      timelineEvents.removeEventListener('lens-roam-changed', on)
      timelineEvents.removeEventListener('clone-settings-changed', on)
    }
  }, [])

  // Edit view (no clip Lens fetch): when the clips are replaced (undo / redo, a
  // clip change), a refetched clip's own clip.lens is the truth, so its adopted
  // or Motion-view-fetched entry goes. Keyed on `clips` only: going back from
  // Motion view keeps the map until the clips change, as clip.lens may not carry
  // a write made there yet. Motion view's own refetch replaces the map anyway.
  const lastClips = useRef(null)
  useEffect(() => {
    const next = clipsById(clips)
    const prev = lastClips.current
    lastClips.current = next
    if (!prev || inputs.current.includeClipLens) return
    setLensRoam((s) => dropRefetchedClipLens(s, prev, next))
  }, [clips])

  const data = useMemo(
    () => buildMotionData({ tracks, clips, patternBlocks, patterns, regions, lensRoam }),
    [tracks, clips, patternBlocks, patterns, regions, lensRoam],
  )

  const idsRef = useRef(new Set())
  const motionTrackIds = useMemo(() => {
    const next = computeMotionTrackIds(data)
    if (sameSet(next, idsRef.current)) return idsRef.current
    idsRef.current = next
    return next
  }, [data])

  return { data, motionTrackIds, refresh, adopt }
}

export default useMotionData
