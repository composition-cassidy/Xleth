// Who owns the keyboard while the sample editor (the picker sheet) is open.
//
// The sheet sits over the Preview/Inspector row and the arrangement stays live
// under it, so "the sheet is mounted" is not enough to claim Space: out in the
// arrangement Space has to stay the transport's.
//
// The rule used to be "a key is the editor's when its TARGET is inside the
// sheet". That is not the same thing as "the editor is what I am working in",
// and the gap is exactly where Space went wrong:
//
//   - focus falls to <body> whenever the focused control goes away. Add sample
//     disables itself after adding; a marked row's remove button unmounts with
//     its row; the custom-label field unmounts on commit. The very next Space
//     then targeted <body>, was "not inside the sheet", and started the
//     timeline instead of the preview;
//   - a click elsewhere (a Browser row, a transport button) left focus on that
//     button, and Space both ran the transport and re-clicked the button.
//
// So ownership is a state, not a hit test: the editor is ACTIVE from the moment
// it opens, stays active for as long as the pointer and focus stay in it, and
// goes inactive when the user deliberately clicks or tabs somewhere else. While
// it is active a key that lands on nothing (<body>) is the editor's.
let open = false
let root = null
let active = false
const listeners = new Set()

function emit() {
  listeners.forEach((fn) => fn(active))
}

export function setSamplePickerOpen(value) {
  open = !!value
  if (!open) root = null
  setSamplePickerActive(open)
}

/** Register the element that is "inside the editor" (the sheet), or null. */
export function setSamplePickerRoot(element) {
  root = element || null
}

/** The editor is mounted. */
export function isSamplePickerOpen() {
  return open
}

/** The editor is what the user is working in (see the header of this file). */
export function isSamplePickerActive() {
  return open && active
}

export function setSamplePickerActive(value) {
  const next = open && !!value
  if (next === active) return
  active = next
  emit()
}

export function subscribeSamplePickerActive(fn) {
  listeners.add(fn)
  return () => { listeners.delete(fn) }
}

/** Nothing has focus: the event landed on the document itself. */
function isUnfocusedTarget(target) {
  if (!target || typeof document === 'undefined') return true
  return target === document.body || target === document.documentElement || target === document
}

/**
 * An element is the editor's own: inside the sheet, or inside a popup list that
 * one of the sheet's controls opened (kit Select portals its list to <body>).
 */
export function isInsideSamplePicker(target) {
  if (!open || !root || !target) return false
  if (typeof root.contains === 'function' && root.contains(target)) return true
  const popup = typeof target.closest === 'function' ? target.closest('[role="listbox"]') : null
  const ownerId = popup?.getAttribute?.('aria-labelledby')
  const owner = ownerId && typeof document !== 'undefined' ? document.getElementById(ownerId) : null
  return !!owner && root.contains(owner)
}

/**
 * The editor owns this key event. True when the target is inside the sheet, or
 * when the editor is active and the key landed on nothing. With no registered
 * root an open editor owns every key (the old whole-window behaviour).
 */
export function isSamplePickerKeyTarget(event) {
  if (!open) return false
  const target = event?.target
  if (!root || typeof root.contains !== 'function') return true
  if (target && isInsideSamplePicker(target)) return true
  return active && isUnfocusedTarget(target)
}
