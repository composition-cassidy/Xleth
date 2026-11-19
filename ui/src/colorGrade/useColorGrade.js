// Color Grade: the hook a panel edits one grade through, and the shared
// summary every indicator and the stack view read.
//
// useColorGrade(target) holds the engine's value plus the draft of a drag in
// flight. Unlike Lens, a drag DOES reach the engine while it is in flight
// (colorGrade.preview), because the whole point of a grade control is to watch
// the picture move; the release is still exactly one undo step
// (colorGrade.commit).
//
// Previews are coalesced: at most one is in the air at a time, and when it
// lands the newest pending value goes next, so a fast drag never queues up a
// backlog the picture then has to play through.
//
// Staying in step with undo and redo: those run in the engine and reach the
// renderer only through the arrangement's refresh events, so both the hook and
// the summary refetch on every one of them.

import { useCallback, useEffect, useRef, useState } from 'react'
import { create } from 'zustand'
import { timelineEvents } from '../timelineEvents.js'
import {
  GRADE_CHANGED, cancelGrade, commitGrade, getAllGrades, getGrade, previewGrade,
} from './gradeApi.js'
import { gradesEqual, neutralGrade, targetKey } from './gradeModel.js'

export const GRADE_REFRESH_EVENTS = [
  GRADE_CHANGED,
  'timeline-tracks-changed',
  'timeline-track-layout-changed',
  'timeline-pattern-blocks-changed',
  'timeline-clips-changed',
  'timeline-regions-changed',
  'timeline-sources-changed',
  'timeline-automation-changed',
]

function useRefreshOn(events, refresh) {
  useEffect(() => {
    const on = () => refresh()
    events.forEach((e) => timelineEvents.addEventListener(e, on))
    const offLoad = window.xleth?.onProjectLoaded?.(on)
    return () => {
      events.forEach((e) => timelineEvents.removeEventListener(e, on))
      if (typeof offLoad === 'function') offLoad()
    }
  }, [events, refresh])
}

/**
 * @param {{level:string, id?:number}|null} target
 * @returns {{
 *   grade, base, ready, exists, lutError, dragging,
 *   preview(next), commit(next?, label?), cancel(), set(next, label?), refresh()
 * }}
 *   `grade` is the engine value with any in-flight draft on top. `next` is a
 *   whole grade or a function (grade) => grade.
 */
export function useColorGrade(target) {
  const key = targetKey(target)
  const targetRef = useRef(target)
  targetRef.current = target

  const [base, setBase] = useState(null)
  const [meta, setMeta] = useState({ exists: false, lutError: '' })
  const [draft, setDraftState] = useState(null)
  const draftRef = useRef(null)
  const baseRef = useRef(null)
  baseRef.current = base
  const token = useRef(0)
  // Preview coalescing: `flying` while one preview RPC is in the air,
  // `pending` the newest value that arrived meanwhile.
  const flying = useRef(false)
  const pending = useRef(null)
  // Bumped by commit / cancel / retarget, so a preview that lands late does
  // not send the stale pending value after the drag has ended.
  const gesture = useRef(0)

  const setDraft = useCallback((next) => {
    draftRef.current = next
    setDraftState(next)
  }, [])

  const refresh = useCallback(async () => {
    const t = targetRef.current
    if (!t?.level) { setBase(null); return }
    if (draftRef.current) return          // a drag owns the value until it ends
    const mine = ++token.current
    const res = await getGrade(t)
    if (mine !== token.current) return
    if (!res) { setBase(null); return }
    setBase(res.grade)
    setMeta({ exists: res.exists === true, lutError: res.lutError ?? '' })
  }, [])

  // A new target starts clean. A drag still open on the old one is dropped in
  // the engine too, or its preview would be left in the picture.
  useEffect(() => {
    const previous = targetRef.current
    setBase(null)
    setDraft(null)
    pending.current = null
    gesture.current++
    refresh()
    return () => {
      if (draftRef.current && previous?.level) cancelGrade(previous)
      draftRef.current = null
    }
  }, [key])
  useRefreshOn(GRADE_REFRESH_EVENTS, refresh)

  const resolve = (next) => {
    const current = draftRef.current ?? baseRef.current ?? neutralGrade()
    return typeof next === 'function' ? next(current) : next
  }

  const pump = useCallback(async () => {
    if (flying.current) return
    const mine = gesture.current
    flying.current = true
    try {
      while (pending.current && mine === gesture.current) {
        const value = pending.current
        pending.current = null
        await previewGrade(targetRef.current, value)
      }
    } finally {
      flying.current = false
    }
  }, [])

  const preview = useCallback((next) => {
    if (!targetRef.current?.level) return
    const value = resolve(next)
    setDraft(value)
    pending.current = value
    pump()
  }, [pump, setDraft])

  const commit = useCallback(async (next, label) => {
    const t = targetRef.current
    if (!t?.level) return null
    const value = next === undefined ? draftRef.current : resolve(next)
    if (!value) return null
    gesture.current++             // a preview still to be sent is superseded
    pending.current = null
    token.current++               // a refresh in flight is older than this write
    // Shown at once; the engine's answer replaces it.
    setDraft(value)
    const res = await commitGrade(t, value, label)
    if (res?.grade) {
      setBase(res.grade)
      setMeta({ exists: res.exists === true, lutError: res.lutError ?? '' })
    }
    setDraft(null)
    return res
  }, [setDraft])

  const cancel = useCallback(async () => {
    const t = targetRef.current
    gesture.current++
    pending.current = null
    const hadDraft = draftRef.current !== null
    setDraft(null)
    if (!t?.level || !hadDraft) return
    token.current++
    const res = await cancelGrade(t)
    if (res?.grade) setBase(res.grade)
  }, [setDraft])

  const grade = draft ?? base
  return {
    grade,
    base,
    ready: base !== null,
    exists: meta.exists,
    lutError: meta.lutError,
    dragging: draft !== null,
    changed: draft !== null && base !== null && !gradesEqual(draft, base),
    preview,
    commit,
    cancel,
    /** A change that is not a drag: one undo step. */
    set: commit,
    refresh,
  }
}

// ── The summary: which owners have a grade ───────────────────────────────────
// One fetch (colorGrade.getAll) shared by every indicator, the stack view and
// the bulk-apply dialog. Maps are keyed by id; a missing key means "the default
// grade" (neutral and switched on).

const EMPTY = Object.freeze({
  sources: new Map(), clips: new Map(), regions: new Map(), layers: new Map(), master: null,
})

export const useGradeSummaryStore = create((set, get) => ({
  ...EMPTY,
  loaded: false,
  token: 0,
  refresh: async () => {
    const mine = get().token + 1
    set({ token: mine })
    const res = await getAllGrades()
    if (get().token !== mine) return
    if (!res) { set({ ...EMPTY, loaded: true }); return }
    const toMap = (list) => new Map(list.map((e) => [e.id, e]))
    set({
      sources: toMap(res.sources),
      clips: toMap(res.clips),
      regions: toMap(res.regions),
      layers: toMap(res.layers),
      master: res.master,
      loaded: true,
    })
  },
}))

let summaryWired = false

/** Start keeping the summary current. Idempotent; called by the first reader. */
export function wireGradeSummary() {
  const refresh = () => useGradeSummaryStore.getState().refresh()
  if (summaryWired) {
    // Already listening. A reader that mounts before the first answer (or
    // after the store was emptied) still gets one fetch.
    if (!useGradeSummaryStore.getState().loaded) refresh()
    return
  }
  summaryWired = true
  GRADE_REFRESH_EVENTS.forEach((e) => timelineEvents.addEventListener(e, refresh))
  window.xleth?.onProjectLoaded?.(refresh)
  refresh()
}

const TABLE = { source: 'sources', clip: 'clips', region: 'regions', layer: 'layers' }

/** The summary entry for a target: { grade, active } or null (default grade). */
export function summaryEntry(state, target) {
  if (!target?.level) return null
  if (target.level === 'master') return state.master
  return state[TABLE[target.level]]?.get(target.id) ?? null
}

/**
 * 'none' (the default grade), 'on' (rendering) or 'off' (kept, switched off or
 * neutral). What an indicator shows for one owner.
 */
export function useGradeState(target) {
  useEffect(() => { wireGradeSummary() }, [])
  const level = target?.level ?? null
  const id = target?.id ?? null
  return useGradeSummaryStore((s) => {
    const entry = summaryEntry(s, level ? { level, id } : null)
    if (!entry) return 'none'
    return entry.active ? 'on' : 'off'
  })
}
