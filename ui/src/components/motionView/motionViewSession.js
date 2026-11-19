// The app's one Motion view persistence session (docs/XLETH_MOTION_VIEW_DESIGN.md R19).
//
// TimelineView starts it once (startMotionViewSession) and stops it on unmount.
// A project save calls flushMotionViewState() first, so a view change made in
// the last half second (the push debounce) still lands in the saved project.

import { startMotionViewPersistence } from '../../motion/motionViewPersistence.js'

let active = null
let users = 0

/** Start (ref-counted) the persistence of motionViewStore; returns the stop function. */
export function startMotionViewSession(options) {
  users++
  if (!active) active = startMotionViewPersistence(options)
  let stopped = false
  return () => {
    if (stopped) return
    stopped = true
    users--
    if (users <= 0) {
      users = 0
      active?.stop()
      active = null
    }
  }
}

/** Push a pending Motion view state change now (call before saving the project). */
export async function flushMotionViewState() {
  if (!active) return false
  try {
    return await active.flush()
  } catch {
    return false
  }
}

/**
 * Call right before switching project (New / Open): pushes a pending change into
 * the still-open project, then holds every push until the new project's state
 * loads. Pair with cancelMotionViewProjectSwitch() when the switch fails.
 */
export async function beforeMotionViewProjectSwitch() {
  if (!active) return false
  try {
    return await active.beforeProjectSwitch()
  } catch {
    return false
  }
}

/** The project switch failed or threw: Motion view pushes resume. */
export function cancelMotionViewProjectSwitch() {
  active?.cancelProjectSwitch?.()
}

/** Whether a session is running (tests). */
export const motionViewSessionActive = () => active !== null
