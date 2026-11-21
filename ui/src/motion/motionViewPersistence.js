// Motion view state saved with the project (docs/XLETH_MOTION_VIEW_DESIGN.md R19, 2.3).
//
// The engine keeps the project's `motionView` object (opaque to it) and writes it
// into project.json on save, only when non-empty. It is NOT undoable and never
// marks the project dirty, like motionBlur / masterVolume. This module is the
// one bridge between it and motionViewStore:
//
//   * on start and on every window.xleth.onProjectLoaded: getMotionViewState()
//     -> store.loadState(); an engine without the call (older build) or a failed
//     ask loads the defaults.
//   * on any change of the saved part of the store: setMotionViewState(toState())
//     debounced (~500 ms), never while a gesture's draft is non-null (a drag), and
//     null instead of an all-default state so a project that never used Motion
//     view saves byte-identically (R16).
//
// startMotionViewPersistence() returns { stop, flush, load, beforeProjectSwitch,
// cancelProjectSwitch }; flush() pushes a pending change at once (call it before
// a save). beforeProjectSwitch() flushes, then blocks pushes until the next
// load() (call it right before New / Open); cancelProjectSwitch() undoes the
// block when the switch failed.

import { isDefaultViewState, savedSlice, useMotionViewStore } from './motionViewStore.js'

const TAG = '[MotionView]'
export const PUSH_DEBOUNCE_MS = 500

const sameSlice = (a, b) => a.length === b.length && a.every((v, i) => Object.is(v, b[i]))

export function startMotionViewPersistence({
  store = useMotionViewStore,
  project = () => window.xleth?.project,
  onProjectLoaded = (cb) => window.xleth?.onProjectLoaded?.(cb),
  debounceMs = PUSH_DEBOUNCE_MS,
} = {}) {
  let timer = null
  let lastSent = null      // JSON of the last state loaded from or pushed to the engine
  let loading = 0          // > 0 while a load is in flight: pushes wait for it
  let loadToken = 0
  let stopped = false
  let switching = false    // between beforeProjectSwitch() and the next load(): no pushes

  const clearTimer = () => {
    if (timer !== null) clearTimeout(timer)
    timer = null
  }

  const schedule = () => {
    if (stopped) return
    clearTimer()
    timer = setTimeout(() => { timer = null; flush() }, debounceMs)
  }

  async function flush() {
    if (stopped) return false
    clearTimer()
    // Mid project switch: the engine may already hold the next project, so the
    // old project's view must not land in it. The next load() resumes pushes.
    if (switching) return false
    if (loading > 0) return false
    const s = store.getState()
    // Never mid-gesture: the drag's end changes the store again and reschedules;
    // if it does not, try again after the debounce.
    if (s.draft !== null) { schedule(); return false }
    const state = s.toState()
    const json = JSON.stringify(state)
    if (json === lastSent) return false
    const fn = project()?.setMotionViewState
    if (typeof fn !== 'function') return false
    lastSent = json
    const payload = isDefaultViewState(state) ? null : state
    try {
      await fn(payload)
      return true
    } catch (err) {
      console.error(`${TAG} setMotionViewState failed:`, err?.message ?? err)
      lastSent = null
      return false
    }
  }

  async function load() {
    const token = ++loadToken
    clearTimer()       // a change from the previous project must not land in this one
    switching = false  // the switch is over: this load owns the store now (loading blocks pushes)
    loading++
    let res = null
    try {
      const fn = project()?.getMotionViewState
      if (typeof fn === 'function') res = await fn()
    } catch (err) {
      console.warn(`${TAG} getMotionViewState failed, using defaults:`, err?.message ?? err)
      res = null
    } finally {
      loading--
    }
    if (stopped || token !== loadToken) return
    store.getState().loadState(res ?? null)
    lastSent = JSON.stringify(store.getState().toState())
    clearTimer()       // loadState itself is not a change to push back
  }

  let prev = savedSlice(store.getState())
  const unsubscribe = store.subscribe((s) => {
    const next = savedSlice(s)
    if (sameSlice(next, prev)) return
    prev = next
    if (loading > 0) return
    schedule()
  })
  const offLoaded = onProjectLoaded(() => { load() })

  load()

  /**
   * Call right before the engine switches project (New / Open): pushes a pending
   * change into the still-open project, then blocks every push until the next
   * load() (the new project's onProjectLoaded) so a debounced push can never
   * write the old project's view into the new one. Resolves to flush()'s result.
   */
  async function beforeProjectSwitch() {
    if (stopped) return false
    let pushed = false
    try {
      pushed = await flush()
    } finally {
      clearTimer()
      switching = true
    }
    return pushed
  }

  /** The switch did not happen (failed / threw): pushes resume, a pending change is rescheduled. */
  function cancelProjectSwitch() {
    if (!switching) return
    switching = false
    if (stopped || loading > 0) return
    if (JSON.stringify(store.getState().toState()) !== lastSent) schedule()
  }

  return {
    stop() {
      stopped = true
      clearTimer()
      unsubscribe()
      if (typeof offLoaded === 'function') offLoaded()
    },
    flush,
    load,
    beforeProjectSwitch,
    cancelProjectSwitch,
    /** Whether pushes are blocked by a project switch in progress (tests). */
    isSwitching: () => switching,
  }
}

export default startMotionViewPersistence
