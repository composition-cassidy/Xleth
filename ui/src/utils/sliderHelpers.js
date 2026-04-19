// ─── Slider helpers (Prompt 12) ──────────────────────────────────────────────
//
// Shared helpers for visual-effect parameter sliders. Two snap functions and
// one debounce wrapper. These exist because of two real bugs we hit in earlier
// prompts:
//
// 1. Sliders that landed at 0.013 instead of 0 because users couldn't get
//    pixel-perfect onto the neutral position. snapToZero/snapToOne fix that.
//
// 2. Sliders that flooded the bridge with 20+ IPC calls per drag, each
//    creating an undo entry, overflowing the undo stack. debounce coalesces
//    rapid changes to one trailing call per ~50ms.

/**
 * Snap to exactly 0 when within ±threshold. For sliders where 0 is neutral.
 * Apply to: gap scale, corner radius, brightness, contrast, desat amount,
 * tint strength, pan X/Y, rotation, slide deltas.
 */
export function snapToZero(value, threshold = 0.025) {
  return Math.abs(value) < threshold ? 0 : value
}

/**
 * Snap to exactly 1.0 when within ±threshold. For zoom sliders where 1.0 is
 * neutral. Apply to: startZoom, targetZoom.
 */
export function snapToOne(value, threshold = 0.025) {
  return Math.abs(value - 1.0) < threshold ? 1.0 : value
}

/**
 * Trailing-edge debounce. Returns a wrapped function that delays calling `fn`
 * until `wait` ms have passed since the last invocation. Used to coalesce
 * rapid slider onChange events into a single bridge call so each drag creates
 * exactly one undo entry instead of dozens.
 *
 * Example:
 *   const debouncedSet = debounce((v) => bridge.setX(v), 50)
 *   <input onChange={(e) => debouncedSet(parseFloat(e.target.value))} />
 */
export function debounce(fn, wait = 50) {
  let timer = null
  let lastArgs = null
  const debounced = (...args) => {
    lastArgs = args
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = null
      fn(...lastArgs)
    }, wait)
  }
  debounced.flush = () => {
    if (timer) {
      clearTimeout(timer)
      timer = null
      if (lastArgs) fn(...lastArgs)
    }
  }
  debounced.cancel = () => {
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
  }
  return debounced
}

/**
 * Convenience: wrap a setter so each call snaps-to-zero before forwarding.
 */
export function withSnapZero(setter, threshold = 0.025) {
  return (v) => setter(snapToZero(v, threshold))
}

export function withSnapOne(setter, threshold = 0.025) {
  return (v) => setter(snapToOne(v, threshold))
}
