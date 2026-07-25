// chromaKeyEyedropper.js — cross-component state for the Chroma Key colour picker.
//
// The eyedropper button lives in the track's effect-param panel, but the pixels
// it has to sample live in the preview canvas, which is a completely different
// part of the tree. Rather than lift that state into a store that nothing else
// needs, this module is a tiny subscribable singleton: the param panel starts a
// pick and awaits a promise, VideoPreview notices a pick is active and resolves
// it with the pixel the user clicked.
//
// Why the pixel is read from shared memory and not the canvas: the preview
// WebGL context is created with preserveDrawingBuffer:false, so readPixels
// outside the draw call returns garbage. The RGBA shm frame the engine writes
// is the same data the canvas was drawn from, and it is readable at any time.

let state = {
  active:  false,
  trackId: null,
  resolve: null,
}

const listeners = new Set()

function notify() {
  for (const fn of listeners) {
    try { fn(state) } catch (e) { console.error('[eyedropper] listener threw', e) }
  }
}

/** Subscribe to pick-mode changes. Returns an unsubscribe function. */
export function subscribe(fn) {
  listeners.add(fn)
  fn(state)
  return () => listeners.delete(fn)
}

export function isPicking() {
  return state.active
}

export function getPickTrackId() {
  return state.trackId
}

/**
 * Enter pick mode for a track.
 * Resolves with { r, g, b } in 0..1 when the user clicks the preview, or with
 * null if the pick is cancelled (Escape, or a second pick superseding this one).
 */
export function beginPick(trackId) {
  // A pick already in flight is superseded, not queued.
  if (state.active && state.resolve) state.resolve(null)

  return new Promise((resolve) => {
    state = { active: true, trackId, resolve }
    notify()
  })
}

/** Resolve the in-flight pick with a colour. rgb components are 0..1. */
export function completePick(rgb) {
  const done = state.resolve
  state = { active: false, trackId: null, resolve: null }
  notify()
  if (done) done(rgb)
}

/** Abandon the in-flight pick. */
export function cancelPick() {
  const done = state.resolve
  state = { active: false, trackId: null, resolve: null }
  notify()
  if (done) done(null)
}
