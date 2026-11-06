// Vitest global setup.
//
// jsdom does not implement ResizeObserver, but real browsers (and Electron's
// renderer) always do. Canvas-backed timeline components (TimelineRuler,
// TimelineCanvas, SnapshotCueLane, …) construct one in a mount effect, so a
// jsdom render that runs effects throws "ResizeObserver is not defined". Provide
// an inert stub so those components mount cleanly in tests, matching the browser
// where the observer exists. observe/unobserve/disconnect are no-ops — nothing
// in the test env produces layout callbacks anyway.
if (typeof globalThis.ResizeObserver === 'undefined') {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
}

// And for Element.prototype.scrollIntoView: jsdom omits it, browsers have it.
// MixerStrip calls it when a strip becomes selected. Guarded on `Element` so the
// node-environment test files (no DOM) are unaffected.
if (typeof Element !== 'undefined' && typeof Element.prototype.scrollIntoView !== 'function') {
  Element.prototype.scrollIntoView = function scrollIntoView() {}
}

// Same situation for requestAnimationFrame/cancelAnimationFrame: real browsers
// and Electron's renderer always have them, jsdom/node do not. The timeline
// select tool schedules its drag-preview repaint on one, so any test that
// drives a mousemove needs the global to exist. setTimeout(cb, 0) is close
// enough for tests — nothing here asserts frame timing, only call counts.
if (typeof globalThis.requestAnimationFrame === 'undefined') {
  globalThis.requestAnimationFrame = (cb) => setTimeout(() => cb(performance.now()), 0)
}
if (typeof globalThis.cancelAnimationFrame === 'undefined') {
  globalThis.cancelAnimationFrame = (id) => clearTimeout(id)
}
