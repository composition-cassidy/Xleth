// Middle-mouse "grab and pan" helpers for the timeline viewport.
//
// The canvas reports raw pixel deltas; these helpers (1) gate when a pan
// gesture has actually begun (so a plain middle-click can still act as a
// copy gesture) and (2) translate pixel deltas into viewport scroll amounts.
//
// Sign convention matches the wheel handler in TimelineView:
//   positive deltaBeats / scrollTop = scroll forward / down.
// A grab-pan moves the content WITH the cursor, so the viewport scrolls
// OPPOSITE to the drag direction — hence the negation below.

// Minimum cursor travel (px) before a middle-drag counts as a pan.
export const MIDDLE_MOUSE_PAN_THRESHOLD_PX = 3;

/**
 * Whether the accumulated movement from the gesture start is large enough
 * to be treated as a pan (rather than a stationary middle-click).
 * @param {number} totalDx  total horizontal movement since gesture start (px)
 * @param {number} totalDy  total vertical movement since gesture start (px)
 * @returns {boolean}
 */
export function didMiddleMousePanStart(totalDx, totalDy) {
  return Math.hypot(totalDx, totalDy) >= MIDDLE_MOUSE_PAN_THRESHOLD_PX;
}

/**
 * Convert an incremental pixel drag into viewport pan amounts.
 * @param {number} deltaXPx       horizontal drag since last move (px)
 * @param {number} deltaYPx       vertical drag since last move (px)
 * @param {number} pixelsPerBeat  current horizontal zoom (px per beat)
 * @returns {{ deltaBeats: number, deltaScrollTop: number }}
 */
export function pixelsToViewportPan(deltaXPx, deltaYPx, pixelsPerBeat) {
  const ppb = pixelsPerBeat || 40;
  return {
    deltaBeats: -deltaXPx / ppb,
    deltaScrollTop: -deltaYPx,
  };
}
