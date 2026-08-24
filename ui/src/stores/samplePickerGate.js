// Tiny module-level gate so TransportBar's global spacebar/transport shortcuts
// can be suppressed for the lifetime of the Sample Selection window, independent
// of DOM focus/event-propagation quirks (buttons inside the picker can steal
// keydown targeting and leak past capture-phase stopImmediatePropagation).
let open = false

export function setSamplePickerOpen(value) {
  open = value
}

export function isSamplePickerOpen() {
  return open
}
