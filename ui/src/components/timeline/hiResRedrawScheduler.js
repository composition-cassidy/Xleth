// Coalesces the "hi-res waveform arrived, redraw the canvas" notification
// down to at most one redraw per animation frame.
//
// WHY: TimelineView's settle-pass fetch effect dispatches every job
// concurrently (Promise.allSettled) and each job called
// `canvasRef.current.redrawContent('hires-waveform')` the moment its own IPC
// reply landed. redrawContent (TimelineCanvas.jsx) is fully synchronous and
// unconditional — it clears and redraws every visible clip, every pattern
// block, the automation lanes, ghost clips and WORLD spinners on each call.
// So N resolved jobs cost N full canvas redraws, back to back, in the window
// right after a scroll/zoom gesture settles.
//
// On the real `BFDIA 9` project that N reached 125 in a single settle pass
// (see hiResProcessedPlanner.js for the measurements). Capping the fetch
// count cuts N, but the redraws still want coalescing on principle: the
// results arrive within a few ms of one another and every redraw but the last
// is immediately overwritten, so all but one were pure waste. This is the
// cheapest of the three fixes and likely the largest share of the visible
// stutter, because unlike the fetches it burns the RENDERER's main thread —
// the one that also has to paint the scroll.
//
// Deliberately NOT a general-purpose rAF batcher: it is scoped to this one
// reason string so it can never swallow a redraw some other code path needs
// synchronously (a drag commit, say). Drag/zoom paths keep calling
// redrawContent directly.

/**
 * Create a scheduler that collapses any number of `request()` calls made
 * within one frame into a single `redraw()` call on the next frame.
 *
 * Injectable timer functions so this is unit-testable without a real browser
 * frame clock — the production call site passes nothing and gets
 * requestAnimationFrame.
 *
 * @param {() => void} redraw  invoked at most once per frame
 * @param {{raf?: Function, caf?: Function}} [timers]
 * @returns {{request: () => void, cancel: () => void, isPending: () => boolean}}
 */
export function createHiResRedrawScheduler(redraw, timers = {}) {
  const raf = timers.raf
    || (typeof requestAnimationFrame === 'function' ? requestAnimationFrame : (fn) => setTimeout(fn, 16))
  const caf = timers.caf
    || (typeof cancelAnimationFrame === 'function' ? cancelAnimationFrame : clearTimeout)

  let handle = null

  return {
    /** Ask for a redraw. Idempotent within a frame. */
    request() {
      if (handle !== null) return
      handle = raf(() => {
        // Cleared BEFORE redraw() runs: a request made from inside the redraw
        // (or from a job resolving in the same microtask flush) must schedule
        // the NEXT frame rather than being dropped as already-pending.
        handle = null
        redraw()
      })
    },
    /** Drop any pending redraw — call on unmount. */
    cancel() {
      if (handle === null) return
      caf(handle)
      handle = null
    },
    isPending() {
      return handle !== null
    },
  }
}
