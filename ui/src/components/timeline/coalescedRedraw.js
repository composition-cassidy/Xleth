// Coalesce "this layer is stale" notifications into one repaint.
//
// A canvas layer repaint is a full rebuild. React effects that say "the data
// changed" fire in groups: one commit that changes clips, selection and the row
// layout runs three effects, and each used to rebuild the content layer on its
// own, all but the last painted over at once. A project load ran six.
//
// request() marks the layer stale and schedules ONE paint in a microtask, which
// runs after the current commit's effects and before the browser paints, so
// the repaint lands in the same frame it always did. Anything that paints the
// layer directly (the view animator, a drag) calls settle() so a pending
// request does not repaint what was just painted.
//
// Sibling of hiResRedrawScheduler.js, which coalesces per animation frame for
// a stream of async results; this one is for synchronous bursts.

export function createCoalescedRedraw(paint, schedule = queueMicrotask) {
  let stale = false
  return {
    /** Ask for a repaint. The first `reason` of a burst is the one reported. */
    request(reason) {
      if (stale) return
      stale = true
      schedule(() => {
        if (!stale) return
        stale = false
        paint(reason)
      })
    },
    /** The layer was just painted by someone else: drop any pending request. */
    settle() {
      stale = false
    },
    get pending() {
      return stale
    },
  }
}
