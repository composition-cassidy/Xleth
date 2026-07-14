// Vitest global setup.
//
// jsdom does not implement ResizeObserver, but real browsers (and Electron's
// renderer) always do. Canvas-backed timeline components (TimelineRuler,
// TimelineCanvas, VideoMirrorCanvas, …) construct one in a mount effect, so a
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
