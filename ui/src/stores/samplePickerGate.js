// Tiny module-level gate so TransportBar's global spacebar/transport shortcuts
// can be suppressed while the Sample Picker has the keyboard, independent of DOM
// focus/event-propagation quirks (buttons inside the picker can steal keydown
// targeting and leak past capture-phase stopImmediatePropagation).
//
// The picker is a sheet over the Preview/Inspector row now and the arrangement
// stays live under it, so "open" is not enough: Space must still reach the
// transport when focus is out in the arrangement. A key belongs to the picker
// only when its target is inside the sheet.
let open = false
let root = null

export function setSamplePickerOpen(value) {
  open = value
  if (!value) root = null
}

/** Register the element that is "inside the picker" (the sheet), or null. */
export function setSamplePickerRoot(element) {
  root = element || null
}

/** The picker is mounted. */
export function isSamplePickerOpen() {
  return open
}

/**
 * The picker owns this key event: it is open and the event's target is inside the
 * sheet. With no registered root (or no target) an open picker owns every key,
 * which is the old whole-window behaviour.
 */
export function isSamplePickerKeyTarget(event) {
  if (!open) return false
  const target = event?.target
  if (!root || !target || typeof root.contains !== 'function') return true
  return root.contains(target)
}
