// Lens keyframes: the hooks the Advanced Lens editor reads and writes through
// (docs/XLETH_LENS_ROAM_SPEC.md, P9).
//
// Reads go through getLensRoam / getPattern; writes go through lensRoamApi, ONE
// engine UndoManager command per call. Nothing here talks to the engine while a
// gesture is in flight: the lanes keep a local draft and call write() once, on
// mouseup. A write shows its result at once (optimistic) and is replaced by the
// engine's post-state; a failed write (null) is rolled back by a refetch, so the
// lanes never show a key the engine does not have.

import { useCallback, useEffect, useRef, useState } from 'react'
import useNoteSelectionStore from '../stores/useNoteSelectionStore.js'
import {
  applyHitPreset, getHitPresets, getLensRoam, revertNotesToFollow, setClipLensKeys, setHitCurve,
  setNoteLensMode, setNotesLensKeys,
} from './lensRoamApi.js'
import { REFRESH_EVENTS, useRefreshOn } from './useLensRoam.js'
import { applyKeyOp } from './lensKeyModel.js'
import {
  notePlacements, noteModeOf, selectedNotesForRegion, summarizeMode,
} from './lensNoteTarget.js'

const NOTE_EVENTS = [
  ...REFRESH_EVENTS,
  'timeline-patterns-changed',
  'timeline-pattern-changed',
  'timeline-pattern-blocks-changed',
]

/** The engine's hit presets (static), or null until they arrive / if unavailable. */
export function useHitPresets() {
  const [presets, setPresets] = useState(null)
  useEffect(() => {
    let alive = true
    getHitPresets().then((p) => { if (alive) setPresets(p) })
    return () => { alive = false }
  }, [])
  return presets
}

// ── A Pattern Track source's hit curve ───────────────────────────────────────

/**
 * @returns {{ curve: {keys: object[], zones: object}|null, ready: boolean,
 *   write(keys, zones?): Promise, applyPreset(name): Promise }}
 */
export function useSourceCurve(trackId, regionId) {
  const [curve, setCurve] = useState(null)
  const token = useRef(0)
  const valid = trackId != null && regionId != null

  const refresh = useCallback(async () => {
    if (!valid) { setCurve(null); return }
    const mine = ++token.current
    const res = await getLensRoam({ sources: [{ trackId, regionId }] })
    if (mine !== token.current) return
    const hit = res?.sources?.[0]
    setCurve(hit ? { keys: hit.hitCurve ?? [], zones: hit.zones ?? null } : null)
  }, [valid, trackId, regionId])

  useEffect(() => { setCurve(null); refresh() }, [refresh])
  useRefreshOn(REFRESH_EVENTS, refresh)

  const land = useCallback((res) => {
    if (res?.hitCurve) setCurve({ keys: res.hitCurve, zones: res.zones ?? null })
    else refresh()   // a failed write: show what the engine really has
  }, [refresh])

  const write = useCallback(async (keys, zones) => {
    token.current++
    setCurve((c) => ({ keys, zones: zones ? { ...(c?.zones ?? {}), ...zones } : c?.zones ?? null }))
    const res = await setHitCurve(trackId, regionId, zones ? { keys, zones } : { keys })
    land(res)
    return res
  }, [trackId, regionId, land])

  const applyPreset = useCallback(async (name) => {
    token.current++
    const res = await applyHitPreset(trackId, regionId, name)
    land(res)
    return res
  }, [trackId, regionId, land])

  return { curve, ready: curve !== null, write, applyPreset }
}

// ── A Clip Track event's keys ────────────────────────────────────────────────

export function useClipKeys(clipId) {
  const [keys, setKeys] = useState(null)
  const token = useRef(0)

  const refresh = useCallback(async () => {
    if (clipId == null) { setKeys(null); return }
    const mine = ++token.current
    const res = await getLensRoam({ clipIds: [clipId] })
    if (mine !== token.current) return
    const hit = res?.clips?.[0]
    setKeys(hit ? (hit.keys ?? []) : null)
  }, [clipId])

  useEffect(() => { setKeys(null); refresh() }, [refresh])
  useRefreshOn(REFRESH_EVENTS, refresh)

  const write = useCallback(async (next) => {
    token.current++
    setKeys(next)
    const res = await setClipLensKeys(clipId, next)
    if (res?.keys) setKeys(res.keys)
    else refresh()
    return res
  }, [clipId, refresh])

  return { keys, ready: keys !== null, write }
}

// ── The selected notes of one source ─────────────────────────────────────────

/**
 * The notes selected in the Piano Roll / Reel lane that play this source, with
 * the edits that apply to ALL of them (a multi-select edit is one undo step).
 *
 * `primary` is the first selected note; the lanes show ITS keys, and each edit is
 * applied to every selected note's own keys (not copied over them).
 */
export function useSelectedNotes(trackId, regionId, enabled = true) {
  const byPattern = useNoteSelectionStore((s) => s.byPattern)
  const [data, setData] = useState({ patterns: new Map(), blocks: [] })
  const [pending, setPending] = useState(null)   // optimistic keys per "pattern:note"
  const token = useRef(0)

  const patternIds = Object.keys(byPattern).join(',')

  const refresh = useCallback(async () => {
    if (!enabled || !patternIds) { setData({ patterns: new Map(), blocks: [] }); return }
    const mine = ++token.current
    const tl = window.xleth?.timeline
    try {
      const [pats, blocks] = await Promise.all([
        Promise.all(patternIds.split(',').map((id) => tl?.getPattern?.(Number(id)))),
        tl?.getPatternBlocks?.(),
      ])
      if (mine !== token.current) return
      const patterns = new Map()
      for (const p of pats) if (p && p.id != null) patterns.set(p.id, p)
      setData({ patterns, blocks: Array.isArray(blocks) ? blocks : [] })
    } catch (err) {
      console.error('[LensBridge] selected-notes refresh failed:', err?.message ?? err)
    }
  }, [enabled, patternIds])

  useEffect(() => { refresh() }, [refresh])
  useRefreshOn(NOTE_EVENTS, refresh)

  const entries = enabled ? selectedNotesForRegion(byPattern, data.patterns, regionId) : []
  const keyOf = (e) => `${e.patternId}:${e.noteId}`
  const keysOf = (e) => pending?.[keyOf(e)] ?? e.note.lensOverride?.keys ?? []
  const refs = entries.map((e) => ({ patternId: e.patternId, noteId: e.noteId }))
  const primary = entries[0] ?? null

  const setMode = useCallback(async (mode) => {
    if (!refs.length) return null
    return setNoteLensMode(refs, mode)
  }, [JSON.stringify(refs)])

  const revert = useCallback(async () => {
    if (!refs.length) return null
    return revertNotesToFollow(refs)
  }, [JSON.stringify(refs)])

  /**
   * One key edit (see lensKeyModel.applyKeyOp), applied to every selected note's
   * own keys; notes the edit does not apply to are left alone. ONE engine call.
   */
  const applyOp = useCallback(async (op) => {
    const writes = []
    for (const e of entries) {
      const next = applyKeyOp(e.note.lensOverride?.keys ?? [], op)
      if (next) writes.push({ patternId: e.patternId, noteId: e.noteId, keys: next })
    }
    if (!writes.length) return null
    token.current++
    setPending(Object.fromEntries(writes.map((w) => [`${w.patternId}:${w.noteId}`, w.keys])))
    const res = await setNotesLensKeys(writes)
    await refresh()
    setPending(null)
    return res
  }, [entries, refresh])

  const mode = summarizeMode(entries.map((e) => e.note))
  const placements = primary
    ? notePlacements(data.patterns.get(primary.patternId), primary.note,
      data.blocks.filter((b) => b.trackId === trackId))
    : []

  return {
    entries,
    count: entries.length,
    primary: primary && {
      ...primary,
      mode: noteModeOf(primary.note),
      keys: keysOf(primary),
      lengthTicks: primary.note.durationTicks,
    },
    mode,
    placements,
    setMode,
    revert,
    applyOp,
  }
}

/**
 * The Pattern Track source {trackId, regionId} behind the shared note selection
 * (the first selected pattern's region, on the track that places it), or null.
 * The Inspector uses it to show the Lens panel for a note picked in the Piano
 * Roll or the Reel lane.
 */
export function useNoteSource(enabled) {
  const byPattern = useNoteSelectionStore((s) => s.byPattern)
  const [source, setSource] = useState(null)
  const firstId = Object.keys(byPattern).map(Number).sort((a, b) => a - b)[0] ?? null

  const refresh = useCallback(async () => {
    if (!enabled || firstId == null) { setSource(null); return }
    try {
      const tl = window.xleth?.timeline
      const [pattern, blocks] = await Promise.all([tl?.getPattern?.(firstId), tl?.getPatternBlocks?.()])
      const block = Array.isArray(blocks) ? blocks.find((b) => b.patternId === firstId) : null
      if (!pattern || pattern.regionId == null || pattern.regionId < 0 || !block) { setSource(null); return }
      setSource((prev) => (prev && prev.trackId === block.trackId && prev.regionId === pattern.regionId && prev.patternId === firstId
        ? prev
        : { trackId: block.trackId, regionId: pattern.regionId, patternId: firstId }))
    } catch (err) {
      console.error('[LensBridge] note source refresh failed:', err?.message ?? err)
    }
  }, [enabled, firstId])

  useEffect(() => { refresh() }, [refresh])
  useRefreshOn(NOTE_EVENTS, refresh)
  return source
}

/** Deselect every note (back to editing the hit curve). */
export function clearNoteSelection() {
  useNoteSelectionStore.getState().clear()
}
