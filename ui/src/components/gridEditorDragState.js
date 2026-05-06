// Shared mutable state for HTML5 drag between GridEditorOverlay and GridEditorDock.
// A module-level variable rather than React state because drag is single-instance
// and the drag source (dock) and drop target (overlay) are DOM siblings with no
// common React ancestor that could own this state cleanly.
export let activeDragTrackId = null

export function setActiveDragTrackId(id) {
  activeDragTrackId = id
}
