// The Motion view reveal (docs/XLETH_MOTION_VIEW_DESIGN.md 5.2, R17, R18).
//
// A surface outside Motion view that wants to show a track's motion there (the Edit
// view's motion marker, the Roam inspector's "Show in Motion view", Lens Advanced's
// "Edit Sweep in Motion view") dispatches this window event. TimelineView listens:
// it switches to Motion view, expands the path, selects and scrolls to the row.
// A plain dispatch: no store, no IPC, no undo.
//
//   window CustomEvent 'xleth-motion-reveal'  detail { trackId, path }
//     trackId  the track (number)
//     path     group ids under the track row, outermost first:
//              []        the track row itself
//              ['roam']  its Roam group      ('t:<id>/roam')
//              ['sweep'] its Sweep group     ('t:<id>/sweep')

export const MOTION_REVEAL_EVENT = 'xleth-motion-reveal'

/**
 * Ask the timeline to show `trackId` in Motion view, expanded down to `path`.
 * Returns true when the event was sent; false (nothing sent) without a usable
 * track id or outside a browser.
 *
 * @param {number} trackId
 * @param {string[]} [path]
 */
export function requestMotionReveal(trackId, path = []) {
  if (trackId == null || typeof trackId === 'boolean') return false
  if (typeof trackId === 'number' && !Number.isFinite(trackId)) return false
  if (typeof window === 'undefined' || typeof window.dispatchEvent !== 'function') return false
  const clean = Array.isArray(path) ? path.filter((p) => typeof p === 'string' && p.length > 0) : []
  window.dispatchEvent(new CustomEvent(MOTION_REVEAL_EVENT, { detail: { trackId, path: clean } }))
  return true
}
