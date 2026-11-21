// Lens + Roam: the hooks the panels and the viewer overlay read through.
//
// Reads go through getLensRoam; writes go through lensRoamApi (one engine
// UndoManager command each). Nothing here talks to the engine while a gesture
// is in flight: preview() only updates a local draft, commit() sends it once.
//
// Staying in step with undo and redo: those run in the engine and tell the
// renderer only through the arrangement's refresh events, so the hooks refetch
// on every one of them (the keyboard path and the Edit menu path fire different
// subsets). A fetch token drops a response that a newer request has overtaken.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { create } from 'zustand'
import { timelineEvents } from '../timelineEvents.js'
import { playheadClock } from '../services/PlayheadClock.js'
import useRoamKeysStore from '../stores/useRoamKeysStore.js'
import {
  LENS_FIELDS, changedFields, getLensRoam, resetClipLens, resetTrackLens, resetTrackRoam,
  setClipLens, setTrackLens, setTrackRoam, setTrackRoamKeys,
} from './lensRoamApi.js'
import { LENS_IDENTITY, ROAM_IDENTITY, cellGeometry, normalizeRoam } from './lensRoamModel.js'
import {
  TICKS_PER_BEAT, compileRoamKeys, keyedChannels, planRoamEdit, resolveRoamAt,
} from './roamKeyModel.js'
import { fromWireList, toWireList } from '../motion/maskModel.js'
import { parentIdOf } from '../motion/parentModel.js'
import { runMotionPlan } from '../motion/motionPlan.js'
import {
  chainIdsOf, makePoseResolver, trackIndexFor,
} from '../components/lensRoam/roamOverlayPose.js'

export const REFRESH_EVENTS = [
  'lens-roam-changed',
  'timeline-tracks-changed',
  'timeline-track-layout-changed',
  'timeline-pattern-blocks-changed',
  'timeline-clips-changed',
  'timeline-grid-changed',
]

export function useRefreshOn(events, refresh) {
  useEffect(() => {
    const on = () => refresh()
    events.forEach((e) => timelineEvents.addEventListener(e, on))
    return () => events.forEach((e) => timelineEvents.removeEventListener(e, on))
  }, [events, refresh])
}

// ── Roam draft, shared between the inspector and the viewer overlay ──────────
// A drag in either one previews in both. Local only; never read by the engine.

const useRoamDraftStore = create((set) => ({
  trackId: null,
  patch: null,
  tick: null,     // the playhead the gesture began at (Auto-key writes its key there)
  setDraft: (trackId, patch, tick = null) => set((s) => ({
    trackId, patch, tick: tick ?? (s.trackId === trackId ? s.tick : null),
  })),
  clearDraft: () => set({ trackId: null, patch: null, tick: null }),
}))

export { useRoamDraftStore }

// ── Lens ─────────────────────────────────────────────────────────────────────

/**
 * @param {{kind:'clip', clipId:number} | {kind:'source', trackId:number, regionId:number} | null} target
 * @returns {{ lens, base, ready, preview(patch), commit(patch), commitDraft(), cancel(), reset() }}
 *   `lens` is the base with any in-flight draft merged in.
 */
export function useLensValue(target) {
  const kind = target?.kind ?? null
  const clipId = target?.clipId ?? null
  const trackId = target?.trackId ?? null
  const regionId = target?.regionId ?? null

  const [base, setBase] = useState(null)
  const [draft, setDraftState] = useState(null)
  const draftRef = useRef(null)       // the same draft, readable from a pointerup closure
  const setDraft = useCallback((next) => {
    draftRef.current = typeof next === 'function' ? next(draftRef.current) : next
    setDraftState(draftRef.current)
  }, [])
  const baseRef = useRef(null)
  baseRef.current = base
  const token = useRef(0)

  const refresh = useCallback(async () => {
    if (!kind) { setBase(null); return }
    const mine = ++token.current
    const res = await getLensRoam(kind === 'clip'
      ? { clipIds: [clipId] }
      : { sources: [{ trackId, regionId }] })
    if (mine !== token.current) return
    const hit = kind === 'clip' ? res?.clips?.[0] : res?.sources?.[0]
    setBase(hit?.lens ?? null)
  }, [kind, clipId, trackId, regionId])

  // A new target starts clean: no stale value, no draft from the last one.
  useEffect(() => {
    setBase(null)
    setDraft(null)
    refresh()
  }, [refresh])
  useRefreshOn(REFRESH_EVENTS, refresh)

  const write = useCallback(async (patch) => {
    token.current++        // a refresh already in flight is now older than this write
    const res = kind === 'clip'
      ? await setClipLens(clipId, patch)
      : await setTrackLens(trackId, regionId, patch)
    // Failure resolves to null: drop the preview, keep the last engine value.
    if (res?.lens) setBase(res.lens)
    setDraft(null)
    return res
  }, [kind, clipId, trackId, regionId])

  const reset = useCallback(async () => {
    token.current++
    const res = kind === 'clip'
      ? await resetClipLens(clipId)
      : await resetTrackLens(trackId, regionId)
    if (res?.lens) setBase(res.lens)
    setDraft(null)
    return res
  }, [kind, clipId, trackId, regionId])

  // Commit whatever the gesture previewed: only the fields that differ from the
  // engine value, as ONE command; a gesture that ended where it began sends nothing.
  const commitDraft = useCallback(async () => {
    const patch = changedFields(baseRef.current ?? {}, { ...(baseRef.current ?? {}), ...(draftRef.current ?? {}) }, LENS_FIELDS)
    if (!patch) { setDraft(null); return null }
    return write(patch)
  }, [write, setDraft])

  const lens = base ? { ...base, ...(draft ?? {}) } : null
  return {
    lens,
    base,
    ready: base !== null,
    preview: useCallback((patch) => setDraft((d) => ({ ...(d ?? {}), ...patch })), [setDraft]),
    commit: write,
    commitDraft,
    cancel: useCallback(() => setDraft(null), [setDraft]),
    reset,
  }
}

// ── Roam ─────────────────────────────────────────────────────────────────────

const NO_KEYS = Object.freeze([])

/** The playhead as a timeline tick (960 PPQ), read at the moment it is needed. */
export const playheadTick = () => playheadClock.positionBeats * TICKS_PER_BEAT

/**
 * The playhead as React state at the clock's DISPLAY rate (10 fps, the sanctioned
 * path for numbers on screen), only while `enabled`. Class A motion (drawing that
 * follows the playhead) must not use this: it subscribes to the frame clock instead.
 */
export function usePlayheadTick(enabled = true) {
  const [tick, setTick] = useState(playheadTick)
  useEffect(() => {
    if (!enabled) return undefined
    setTick(playheadTick())
    return playheadClock.onDisplayUpdate(() => setTick(playheadTick()))
  }, [enabled])
  return tick
}

/**
 * @param {number|null} trackId
 * @returns {{ roam, base, keys, committedKeys, keyed, autoKey, ready, resolveAt(tick), preview(patch),
 *             commit(patch), commitDraft(), cancel(), reset(), commitKeys(keys),
 *             masks, parentTrackId, commitMasks(masks, label), adopt(res) }}
 *
 * `roam` is the static base with any in-flight draft merged in (what the inspector's
 * boxes edit). `keys` are the track's Roam keys with a lane / dot gesture's local
 * draft applied; `resolveAt(tick)` is the cell's Roam at that tick, draft included.
 *
 * Every edit of a Roam value goes through planRoamEdit: an unkeyed channel edits the
 * base as it always did; with Auto-key on a move / scale / rotate writes keys at the
 * playhead instead; a KEYED channel edited with Auto-key off is refused (the base
 * would be ignored), resolving to { changed: false, blocked: true, channels }.
 *
 * Motion view (docs/XLETH_MOTION_VIEW_DESIGN.md 2.1, 2.2): `masks` is the track's
 * Mask list (maskModel form, read tolerantly) and `parentTrackId` its Parent (-1 =
 * none), both from getLensRoam. commitMasks(next) replaces the whole list as ONE
 * runMotionPlan 'masks' write (one undo step) and adopts the engine's post-state.
 */
export function useRoamValue(trackId) {
  const [base, setBase] = useState(null)
  const [committedKeys, setKeys] = useState(NO_KEYS)
  const [masks, setMasks] = useState(NO_KEYS)
  const [parentTrackId, setParentTrackId] = useState(-1)
  const token = useRef(0)
  const draftTrack = useRoamDraftStore((s) => s.trackId)
  const draftPatch = useRoamDraftStore((s) => s.patch)
  const setStoreDraft = useRoamDraftStore((s) => s.setDraft)
  const clearStoreDraft = useRoamDraftStore((s) => s.clearDraft)
  const autoKey = useRoamKeysStore((s) => s.autoKey)
  const keyDraft = useRoamKeysStore((s) => (s.draft && s.draft.trackId === trackId ? s.draft.keys : null))

  const refresh = useCallback(async () => {
    if (trackId == null) { setBase(null); setKeys(NO_KEYS); setMasks(NO_KEYS); setParentTrackId(-1); return }
    const mine = ++token.current
    const res = await getLensRoam({ trackIds: [trackId] })
    if (mine !== token.current) return
    const hit = res?.tracks?.[0]
    setBase(hit?.roam ? normalizeRoam(hit.roam) : null)
    setKeys(Array.isArray(hit?.keys) ? hit.keys : NO_KEYS)
    setMasks(Array.isArray(hit?.masks) && hit.masks.length ? fromWireList(hit.masks) : NO_KEYS)
    setParentTrackId(parentIdOf(hit))
  }, [trackId])

  useEffect(() => {
    setBase(null)
    setKeys(NO_KEYS)
    setMasks(NO_KEYS)
    setParentTrackId(-1)
    refresh()
  }, [refresh])
  useRefreshOn(REFRESH_EVENTS, refresh)

  const mine = draftTrack === trackId && trackId != null ? draftPatch : null

  const preview = useCallback((patch, tick) => {
    const s = useRoamDraftStore.getState()
    setStoreDraft(trackId, { ...(s.trackId === trackId ? (s.patch ?? {}) : {}), ...patch }, tick)
  }, [trackId, setStoreDraft])

  const cancel = useCallback(() => {
    if (useRoamDraftStore.getState().trackId === trackId) clearStoreDraft()
  }, [trackId, clearStoreDraft])

  const baseRef = useRef(null)
  baseRef.current = base
  const keysRef = useRef(NO_KEYS)
  keysRef.current = committedKeys

  // The track this hook shows NOW: a write that resolves after the hook moved to
  // another track (the pen closing on the pen's track) must not land in its state.
  const trackRef = useRef(trackId)
  trackRef.current = trackId
  const adopt = useCallback((res) => {
    if (!res || (res.trackId != null && res.trackId !== trackRef.current)) return
    if (res.roam) setBase(normalizeRoam(res.roam))
    if (Array.isArray(res.keys)) setKeys(res.keys)
    if (Array.isArray(res.masks)) setMasks(res.masks.length ? fromWireList(res.masks) : NO_KEYS)
    if (Number.isInteger(res.parentTrackId)) setParentTrackId(parentIdOf(res))
  }, [])

  // Replace the whole Mask list: ONE runMotionPlan write, one undo step.
  const commitMasks = useCallback(async (next, label = 'Edit mask') => {
    token.current++
    const run = await runMotionPlan([{ kind: 'masks', trackId, masks: toWireList(next) }], label)
    const res = run.results[0] ?? null
    adopt(res)
    return res
  }, [trackId, adopt])

  // Replace the whole key list: ONE command, one undo step.
  const commitKeys = useCallback(async (keys) => {
    token.current++
    const res = await setTrackRoamKeys(trackId, keys)
    adopt(res)
    useRoamKeysStore.getState().clearDraft()
    return res
  }, [trackId, adopt])

  const commit = useCallback(async (patch, { tick } = {}) => {
    const plan = planRoamEdit({
      base: baseRef.current ?? {}, keys: keysRef.current, patch,
      tick: tick ?? playheadTick(), autoKey: useRoamKeysStore.getState().autoKey,
    })
    if (plan.kind === 'none') { cancel(); return { changed: false, skipped: true } }
    if (plan.kind === 'blocked') { cancel(); return { changed: false, blocked: true, channels: plan.channels } }
    token.current++
    let res
    if (plan.kind === 'keys') {
      res = await setTrackRoamKeys(trackId, plan.keys)
      adopt(res)
      if (plan.basePatch) adopt(await setTrackRoam(trackId, plan.basePatch))
    } else {
      res = await setTrackRoam(trackId, plan.patch)
      adopt(res)
    }
    cancel()
    return res
  }, [trackId, cancel, adopt])

  const commitDraft = useCallback(async () => {
    const s = useRoamDraftStore.getState()
    const draft = s.trackId === trackId ? s.patch : null
    if (!baseRef.current || !draft) { cancel(); return null }
    // The tick the gesture BEGAN at, if it recorded one, else the playhead now.
    return commit(draft, { tick: s.tick ?? undefined })
  }, [trackId, commit, cancel])

  const reset = useCallback(async () => {
    token.current++
    const res = await resetTrackRoam(trackId)
    adopt(res)
    cancel()
    return res
  }, [trackId, cancel, adopt])

  const keys = keyDraft ?? committedKeys
  const keyed = useMemo(() => keyedChannels(keys), [keys])
  const compiled = useMemo(() => compileRoamKeys(keys), [keys])
  const resolveAt = useCallback((tick) => {
    const resolved = resolveRoamAt(base ?? ROAM_IDENTITY, keys, tick, compiled)
    return mine ? { ...resolved, ...mine } : resolved
  }, [base, keys, compiled, mine])

  const roam = base ? { ...base, ...(mine ?? {}) } : null
  return {
    roam, base, keys, committedKeys, keyed, autoKey, ready: base !== null, resolveAt,
    preview, commit, commitDraft, cancel, reset, commitKeys,
    masks, parentTrackId, commitMasks, adopt,
  }
}

// ── Parent: the ancestors' Roam, and the selected cell's pose on screen ─────

const NO_ANCESTORS = new Map()

/**
 * Map<trackId, { base, keys }> for a track's ancestors (one getLensRoam for the
 * whole chain), kept current on the same events as the other Roam hooks. `chainIds`
 * nearest first; an empty chain fetches nothing.
 */
export function useAncestorRoams(chainIds) {
  const [state, setState] = useState(NO_ANCESTORS)
  const token = useRef(0)
  const idsKey = (chainIds ?? []).join(',')

  const refresh = useCallback(async () => {
    const ids = idsKey ? idsKey.split(',').map(Number) : []
    const mine = ++token.current
    if (ids.length === 0) { setState(NO_ANCESTORS); return }
    const res = await getLensRoam({ trackIds: ids })
    if (mine !== token.current) return
    const m = new Map()
    for (const t of res?.tracks ?? []) {
      m.set(t.trackId, {
        base: t.roam ?? ROAM_IDENTITY,
        keys: Array.isArray(t.keys) ? t.keys : NO_KEYS,
        parentTrackId: parentIdOf(t),
      })
    }
    setState(m)
  }, [idsKey])

  useEffect(() => { refresh() }, [refresh])
  useRefreshOn(REFRESH_EVENTS, refresh)
  return state
}

/**
 * The selected track's Roam with its Parent chain (docs/XLETH_MOTION_VIEW_DESIGN.md
 * 5.5, R7): everything useRoamValue gives (as `R`), the geometry, and
 *   poseAt(tick, ownRoam?)  composePose at that tick (ownRoam defaults to R.resolveAt(tick)),
 *                           or null when the track has no cell
 *   poseWith(tick, ownRoam) the same with ownRoam required; stable across drafts (memo key)
 *   chainIds                the ancestors, nearest first ([] = unparented)
 *   ancestors               Map<id, { base, keys }>
 *   parented                chainIds.length > 0
 * The parent's home comes from the same getGridLayout the child's does.
 */
export function useRoamPose(trackId) {
  const R = useRoamValue(trackId)
  const { layout, track, tracks } = useTrackGeometry(trackId)
  const childParent = R.ready ? R.parentTrackId : undefined
  const tracksById = useMemo(() => trackIndexFor(tracks, trackId, childParent), [tracks, trackId, childParent])
  const chainIds = useMemo(() => chainIdsOf(trackId, tracksById), [trackId, tracksById])
  // The ancestors are fetched by id list (a string), so a track-list refetch that
  // keeps the same chain does not refetch them.
  const ancestors = useAncestorRoams(chainIds)
  const geo = useMemo(() => cellGeometry(layout, track), [layout, track])
  const resolver = useMemo(
    () => makePoseResolver({ trackId, layout, tracksById, ancestors }),
    [trackId, layout, tracksById, ancestors],
  )
  // poseWith needs the child's own Roam passed in, so it does not change with a draft
  // (the motion path is memoized on it); poseAt fills it from resolveAt (draft included).
  const poseWith = useCallback((tick, ownRoam) => (geo ? resolver(tick, ownRoam) : null), [geo, resolver])
  const resolveAt = R.resolveAt
  const poseAt = useCallback((tick, ownRoam) => poseWith(tick, ownRoam ?? resolveAt(tick)), [poseWith, resolveAt])
  return {
    R, layout, track, tracks, tracksById, geo, chainIds, ancestors, parented: chainIds.length > 0, poseAt, poseWith,
  }
}

// ── Every track's Roam keys, for the arrangement's key lanes ─────────────────

const EMPTY_LANE_DATA = Object.freeze({ placed: new Set(), byTrack: new Map() })

/**
 * { placed: Set<trackId>, byTrack: Map<trackId, {base, keys}> } for these tracks.
 * `placed` is the tracks with a cell (a grid slot or a fullscreen layer): only
 * those can Roam. Kept current on the same events the other Roam hooks use.
 */
export function useRoamLaneData(trackIds) {
  const [state, setState] = useState(EMPTY_LANE_DATA)
  const token = useRef(0)
  const idsKey = (trackIds ?? []).join(',')

  const refresh = useCallback(async () => {
    const ids = idsKey ? idsKey.split(',').map(Number) : []
    if (ids.length === 0) { setState(EMPTY_LANE_DATA); return }
    const mine = ++token.current
    let layout = null
    let res = null
    try {
      ;[layout, res] = await Promise.all([
        window.xleth?.timeline?.getGridLayout?.(),
        getLensRoam({ trackIds: ids }),
      ])
    } catch (err) {
      console.error('[LensBridge] roam lane refresh failed:', err?.message ?? err)
      return
    }
    if (mine !== token.current) return
    const placed = new Set()
    for (const s of layout?.slots ?? []) placed.add(s.trackId)
    for (const l of layout?.fullscreenLayers ?? []) placed.add(l.trackId)
    const byTrack = new Map()
    for (const t of res?.tracks ?? []) {
      byTrack.set(t.trackId, {
        base: t.roam ?? ROAM_IDENTITY,
        keys: Array.isArray(t.keys) ? t.keys : NO_KEYS,
        // P11: the track's Sweep keys (Lens channels, timeline ticks).
        sweep: Array.isArray(t.sweep) ? t.sweep : NO_KEYS,
      })
    }
    // `placed` keeps its identity while its members do not change, so the arrangement's
    // row layout (which depends on it) is not rebuilt by every refetch.
    setState((s) => {
      const same = s.placed.size === placed.size && [...placed].every((id) => s.placed.has(id))
      return { placed: same ? s.placed : placed, byTrack }
    })
  }, [idsKey])

  useEffect(() => { refresh() }, [refresh])
  useRefreshOn(REFRESH_EVENTS, refresh)

  // A committed gesture shows the engine's post-state at once, so a key does not jump
  // back to its old place for the moment before the refetch lands.
  const applyKeys = useCallback((trackId, keys, base) => {
    token.current++
    setState((s) => {
      const byTrack = new Map(s.byTrack)
      byTrack.set(trackId, {
        base: base ?? byTrack.get(trackId)?.base ?? ROAM_IDENTITY, keys,
        sweep: byTrack.get(trackId)?.sweep ?? NO_KEYS,
      })
      return { placed: s.placed, byTrack }
    })
  }, [])
  // The same for a Sweep write (the lane, the Lens panel): the engine's post-state at once.
  const applySweepKeys = useCallback((trackId, sweep) => {
    token.current++
    setState((s) => {
      const byTrack = new Map(s.byTrack)
      const cur = byTrack.get(trackId)
      byTrack.set(trackId, { base: cur?.base ?? ROAM_IDENTITY, keys: cur?.keys ?? NO_KEYS, sweep })
      return { placed: s.placed, byTrack }
    })
  }, [])
  // Any Roam write (the lane, the viewer's dots, the inspector) announces its post-state
  // on 'lens-roam-changed' BEFORE its caller's draft is cleared, so the lanes adopt it
  // here and a key never flickers back to its old place while the refetch is in flight.
  useEffect(() => {
    const on = (e) => {
      const d = e.detail
      if (d && d.trackId != null && d.roam && Array.isArray(d.keys)) applyKeys(d.trackId, d.keys, d.roam)
    }
    timelineEvents.addEventListener('lens-roam-changed', on)
    return () => timelineEvents.removeEventListener('lens-roam-changed', on)
  }, [applyKeys])
  return useMemo(
    () => ({ placed: state.placed, byTrack: state.byTrack, applyKeys, applySweepKeys }),
    [state, applyKeys, applySweepKeys],
  )
}

// ── Grid layout and the track list (geometry for both) ───────────────────────

const GEOMETRY_EVENTS = [
  'timeline-tracks-changed', 'timeline-track-layout-changed', 'timeline-grid-changed',
]

/** { layout, track, tracks } for one track, kept current as the grid or the track changes. */
export function useTrackGeometry(trackId) {
  const [state, setState] = useState({ layout: null, track: null, tracks: [] })
  const token = useRef(0)

  const refresh = useCallback(async () => {
    if (trackId == null) { setState({ layout: null, track: null, tracks: [] }); return }
    const mine = ++token.current
    try {
      const [layout, tracks] = await Promise.all([
        window.xleth?.timeline?.getGridLayout?.(),
        window.xleth?.timeline?.getTracks?.(),
      ])
      if (mine !== token.current) return
      const list = Array.isArray(tracks) ? tracks : []
      setState({ layout: layout ?? null, track: list.find((t) => t.id === trackId) ?? null, tracks: list })
    } catch (err) {
      console.error('[LensBridge] geometry refresh failed:', err?.message ?? err)
    }
  }, [trackId])

  useEffect(() => { refresh() }, [refresh])
  useRefreshOn(GEOMETRY_EVENTS, refresh)
  return state
}

export { LENS_IDENTITY, ROAM_IDENTITY }
