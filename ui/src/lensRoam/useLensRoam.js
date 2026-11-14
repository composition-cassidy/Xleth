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

import { useCallback, useEffect, useRef, useState } from 'react'
import { create } from 'zustand'
import { timelineEvents } from '../timelineEvents.js'
import {
  LENS_FIELDS, ROAM_FIELDS, changedFields, getLensRoam, resetClipLens, resetTrackLens, resetTrackRoam,
  setClipLens, setTrackLens, setTrackRoam,
} from './lensRoamApi.js'
import { LENS_IDENTITY, ROAM_IDENTITY } from './lensRoamModel.js'

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
  setDraft: (trackId, patch) => set({ trackId, patch }),
  clearDraft: () => set({ trackId: null, patch: null }),
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

/**
 * @param {number|null} trackId
 * @returns {{ roam, base, ready, preview(patch), commit(patch), commitDraft(), cancel(), reset() }}
 */
export function useRoamValue(trackId) {
  const [base, setBase] = useState(null)
  const token = useRef(0)
  const draftTrack = useRoamDraftStore((s) => s.trackId)
  const draftPatch = useRoamDraftStore((s) => s.patch)
  const setStoreDraft = useRoamDraftStore((s) => s.setDraft)
  const clearStoreDraft = useRoamDraftStore((s) => s.clearDraft)

  const refresh = useCallback(async () => {
    if (trackId == null) { setBase(null); return }
    const mine = ++token.current
    const res = await getLensRoam({ trackIds: [trackId] })
    if (mine !== token.current) return
    setBase(res?.tracks?.[0]?.roam ?? null)
  }, [trackId])

  useEffect(() => {
    setBase(null)
    refresh()
  }, [refresh])
  useRefreshOn(REFRESH_EVENTS, refresh)

  const mine = draftTrack === trackId && trackId != null ? draftPatch : null

  const preview = useCallback((patch) => {
    const s = useRoamDraftStore.getState()
    setStoreDraft(trackId, { ...(s.trackId === trackId ? (s.patch ?? {}) : {}), ...patch })
  }, [trackId, setStoreDraft])

  const cancel = useCallback(() => {
    if (useRoamDraftStore.getState().trackId === trackId) clearStoreDraft()
  }, [trackId, clearStoreDraft])

  const commit = useCallback(async (patch) => {
    token.current++
    const res = await setTrackRoam(trackId, patch)
    if (res?.roam) setBase(res.roam)
    cancel()
    return res
  }, [trackId, cancel])

  const baseRef = useRef(null)
  baseRef.current = base
  const commitDraft = useCallback(async () => {
    const s = useRoamDraftStore.getState()
    const draft = s.trackId === trackId ? s.patch : null
    const b = baseRef.current
    const patch = b && draft ? changedFields(b, { ...b, ...draft }, ROAM_FIELDS) : null
    if (!patch) { cancel(); return null }
    return commit(patch)
  }, [trackId, commit, cancel])

  const reset = useCallback(async () => {
    token.current++
    const res = await resetTrackRoam(trackId)
    if (res?.roam) setBase(res.roam)
    cancel()
    return res
  }, [trackId, cancel])

  const roam = base ? { ...base, ...(mine ?? {}) } : null
  return { roam, base, ready: base !== null, preview, commit, commitDraft, cancel, reset }
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
