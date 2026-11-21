// Cursor-anchored zoom: the two pure decisions the Timeline's per-frame
// onTick makes about horizontal scroll. Extracted so the invariant they exist
// to protect is directly testable.
//
// THE INVARIANT: the scrollX spring must never hold a value the view did not
// actually draw.
//
// Why it matters: the ctrl+wheel handler reads the spring to work out which
// beat currently sits under the cursor, and anchors the new zoom to it. The
// drawn scroll, however, is clamped to [0, maxScroll]. Let the two diverge and
// the next wheel notch anchors to a beat that is NOT the one on screen, so the
// view jumps sideways — and because a burst of notches compounds, it reads as
// the view bouncing around unpredictably.
//
// Divergence is not a rare edge case. maxScroll is (totalBeats - visibleBeats),
// so it SHRINKS as you zoom out: pushing past it is the normal state of a
// zoom-out gesture near the end of a song, and scrollX < 0 is routine anywhere
// near beat 0.

/**
 * The scroll position this frame should draw at.
 *
 * While a zoom is easing, scrollX is not an independently-sprung value — it is
 * a function of the anchor and the CURRENT (mid-ease) ppb, recomputed every
 * frame. That is what keeps the beat under the cursor pinned for the whole
 * animation rather than only on the final frame.
 *
 * @param {number} rawScrollX  the scrollX spring's own eased value
 * @param {{beat:number, pixelX:number}|null} anchor  active zoom anchor
 * @param {number} ppb         current (eased) pixels-per-beat
 */
export function anchoredScrollX(rawScrollX, anchor, ppb) {
  if (!anchor) return rawScrollX
  if (!(ppb > 0)) return rawScrollX
  return anchor.beat - anchor.pixelX / ppb
}

/**
 * What to write back into the scrollX spring after the clamp, or null to leave
 * the spring untouched.
 *
 * With an anchor the spring is slaved outright — it is not steering, so
 * snapping it to the committed value every frame is the intended behaviour.
 *
 * Without an anchor, only intervene when the clamp actually bit. Snapping
 * unconditionally would zero the velocity of every eased scroll on every
 * frame, turning the spring into a jump-cut; snapping never would leave the
 * spring pushing against a wall it cannot pass, holding an out-of-range value
 * for the next gesture to misread.
 *
 * @param {number} requested  what this frame asked to scroll to
 * @param {number} committed  what applyScroll actually clamped it to
 * @param {boolean} hasAnchor whether a zoom anchor is active
 * @returns {number|null}
 */
export function scrollSpringWriteback(requested, committed, hasAnchor) {
  if (hasAnchor) return committed
  return committed !== requested ? committed : null
}
