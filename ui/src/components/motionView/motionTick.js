// The playhead as Motion view's value column reads it (docs/XLETH_MOTION_VIEW_DESIGN.md
// 5.4): a tick at the DISPLAY rate (PlayheadClock.onDisplayUpdate: <= 10 Hz while
// playing, at once on a seek), never a React render per frame. Every value cell and
// key toggle subscribes with a selector, so a cell re-renders only when ITS value
// changes. The canvas playhead marker does not use this: it follows the frame clock.

import { create } from 'zustand'
import { playheadClock } from '../../services/PlayheadClock.js'
import { beatsToTicks } from '../../constants/timeline.js'

const nowTick = () => Math.max(0, beatsToTicks(playheadClock.positionBeats ?? 0))

export const useMotionTick = create(() => ({ tick: nowTick() }))

let users = 0
let off = null

/** Start following the clock (ref-counted); returns the stop function. */
export function startMotionTick() {
  users++
  if (!off) {
    useMotionTick.setState({ tick: nowTick() })
    off = playheadClock.onDisplayUpdate(() => {
      const tick = nowTick()
      if (useMotionTick.getState().tick !== tick) useMotionTick.setState({ tick })
    })
  }
  let stopped = false
  return () => {
    if (stopped) return
    stopped = true
    users--
    if (users <= 0) {
      users = 0
      if (typeof off === 'function') off()
      off = null
    }
  }
}

/** The tick right now (read at the moment it is needed, e.g. a click handler). */
export const motionTickNow = () => nowTick()

/** Test seam: set the tick the cells read. */
export function setMotionTickForTest(tick) {
  useMotionTick.setState({ tick })
}
