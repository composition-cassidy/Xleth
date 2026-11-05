// ── Sample Sandbox viewport ─────────────────────────────────────────────────
//
// Every px↔sample conversion in the panel goes through this file. Before it,
// SandboxWaveformCanvas mapped the WHOLE buffer to the canvas width in two
// one-line helpers, which is why nothing in the panel could be edited
// accurately: at a typical 1000px card a 4-second 48 kHz sample gave ~190
// samples per pixel, so a selection edge, a fade boundary and an envelope
// breakpoint could only ever land within ~4 ms of where they were dropped.
//
// A view is `{ startSample, endSample }` over the layer's RENDERED buffer, or
// `null` meaning "fit the whole buffer". The null form is not a convenience:
// an op that changes length (trim/cut/paste/varispeed) replaces the buffer
// under the view, and a fitted view must keep fitting afterwards rather than
// freezing at the old length's sample indices. Every other view is clamped
// against the current length instead — see resolveView.
//
// Pure, and deliberately dependency-free: the canvas, the overview strip, the
// ruler, the keyboard shortcuts and the store all need the same arithmetic,
// and a zoom that is one formula in one place cannot drift between them.

// Floor on how far in a view may zoom. 32 samples across a ~1000px card is
// ~30px per sample — well past sample-level editing, and low enough that the
// floor is never the thing a user notices.
export const MIN_VIEW_SAMPLES = 32

// Wheel zoom response. deltaY is in whatever units the device reports, so this
// is exponential rather than linear: one notch of a typical mouse wheel
// (deltaY ±100) zooms by ~18%, and a trackpad's many small deltas accumulate
// to the same curve instead of stepping.
const WHEEL_ZOOM_RATE = 0.0017

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v
}

// Resolve a stored view against the buffer length it will be drawn over.
// ALWAYS call this before using a view: the stored value may be null (fit),
// may predate a length change, and may have been written by a gesture that
// clamped differently. Returns a concrete, in-bounds, non-degenerate range.
export function resolveView(view, numSamples) {
  const n = Math.max(0, Math.floor(numSamples) || 0)
  if (n <= 0) return { startSample: 0, endSample: 0 }
  // A buffer shorter than the zoom floor can only ever be shown whole.
  if (!view || n <= MIN_VIEW_SAMPLES) return { startSample: 0, endSample: n }

  let start = clamp(Math.round(view.startSample ?? 0), 0, n)
  let end = clamp(Math.round(view.endSample ?? n), 0, n)
  if (end < start) [start, end] = [end, start]

  // A view that survived a buffer SHRINK can collapse to nothing. Grow it back
  // to the floor around its own centre rather than snapping to fit — the user
  // was zoomed in, and a trim should not throw that away.
  if (end - start < MIN_VIEW_SAMPLES) {
    const centre = (start + end) / 2
    start = Math.round(centre - MIN_VIEW_SAMPLES / 2)
    end = start + MIN_VIEW_SAMPLES
    if (start < 0) { start = 0; end = MIN_VIEW_SAMPLES }
    if (end > n) { end = n; start = n - MIN_VIEW_SAMPLES }
  }
  return { startSample: start, endSample: end }
}

// Width of a RESOLVED view, in samples. Floored at 1 so it is always a legal
// divisor — a caller dividing by this never has to check for an empty buffer.
export function viewSpan(view) {
  return Math.max(1, view.endSample - view.startSample)
}

export function isFitted(view, numSamples) {
  if (!view) return true
  const v = resolveView(view, numSamples)
  return v.startSample <= 0 && v.endSample >= Math.floor(numSamples || 0)
}

// sample → x, in CSS pixels across a canvas of width `w`. Deliberately
// unclamped: a dab, an envelope handle or a selection edge outside the visible
// window must draw off-canvas (and be clipped by the canvas itself) rather
// than pile up against the edge, which would read as content that is there.
export function sampleToX(sample, view, w) {
  return ((sample - view.startSample) / viewSpan(view)) * w
}

// x → sample. Clamped to the BUFFER (not the view) so a pointer dragged past
// the canvas edge yields the first/last sample rather than an out-of-range
// index an op would then be built from.
export function xToSample(px, view, w, numSamples) {
  const n = Math.max(0, Math.floor(numSamples) || 0)
  const s = view.startSample + (px / Math.max(1, w)) * viewSpan(view)
  return clamp(Math.round(s), 0, n)
}

// Samples per pixel at the current view — the scale factor a hit radius or a
// snap radius should be expressed in, so both stay constant in PIXELS as the
// zoom changes.
export function samplesPerPixel(view, w) {
  return viewSpan(view) / Math.max(1, w)
}

// Zoom by `factor` (>1 zooms out, <1 zooms in) keeping the sample under
// `anchorT` (0..1 across the width) pinned to that same fraction. Returns null
// once the result covers the whole buffer, so zooming all the way out re-enters
// fit mode rather than freezing at today's length.
export function zoomView(view, numSamples, factor, anchorT = 0.5) {
  const n = Math.max(0, Math.floor(numSamples) || 0)
  if (n <= MIN_VIEW_SAMPLES) return null
  const v = resolveView(view, n)
  const span = viewSpan(v)
  const nextSpan = clamp(span * factor, MIN_VIEW_SAMPLES, n)
  if (nextSpan >= n) return null

  const t = clamp(anchorT, 0, 1)
  const anchorSample = v.startSample + span * t
  let start = anchorSample - nextSpan * t
  let end = start + nextSpan
  if (start < 0) { start = 0; end = nextSpan }
  if (end > n) { end = n; start = n - nextSpan }
  return { startSample: Math.round(start), endSample: Math.round(end) }
}

// The wheel's own zoom step, so the canvas handler holds no arithmetic of its
// own. Matches the timeline's Ctrl+wheel direction: wheel DOWN (positive
// deltaY) zooms out.
export function zoomViewByWheel(view, numSamples, deltaY, anchorT) {
  return zoomView(view, numSamples, Math.exp(deltaY * WHEEL_ZOOM_RATE), anchorT)
}

// Slide the window without changing its span. A fitted view has nowhere to go,
// so panning one is a no-op rather than an error.
export function panView(view, numSamples, deltaSamples) {
  const n = Math.max(0, Math.floor(numSamples) || 0)
  if (!view || n <= MIN_VIEW_SAMPLES) return view ?? null
  const v = resolveView(view, n)
  const span = viewSpan(v)
  if (span >= n) return null
  const start = clamp(Math.round(v.startSample + deltaSamples), 0, n - span)
  return { startSample: start, endSample: start + span }
}

// Pan by a fraction of the visible width — what a shift+wheel notch and the
// arrow keys both want, since "scroll by 10% of what I can see" stays sensible
// at every zoom level.
export function panViewByFraction(view, numSamples, fraction) {
  const v = resolveView(view, numSamples)
  return panView(view, numSamples, viewSpan(v) * fraction)
}

// Frame a sample range, with breathing room either side. Used by Zoom to
// Selection and by "reveal the op I just selected" — both want the range
// visible WITH context, not butted against the canvas edges.
export function zoomToRange(startSample, endSample, numSamples, padFraction = 0.08) {
  const n = Math.max(0, Math.floor(numSamples) || 0)
  if (n <= MIN_VIEW_SAMPLES) return null
  let a = clamp(Math.round(Math.min(startSample, endSample)), 0, n)
  let b = clamp(Math.round(Math.max(startSample, endSample)), 0, n)
  if (b - a < 1) {
    // A zero-width range is a cursor position, not a region — frame the zoom
    // floor around it so "zoom to selection" with only a cursor still does
    // something useful rather than nothing.
    const centre = (a + b) / 2
    a = Math.round(centre - MIN_VIEW_SAMPLES / 2)
    b = a + MIN_VIEW_SAMPLES
  }
  const pad = (b - a) * padFraction
  const start = a - pad
  const end = b + pad
  if (end - start >= n) return null
  return resolveView({ startSample: start, endSample: end }, n)
}

// Centre the view on a sample without changing its span — how the playhead
// keeps itself on screen while zoomed in. Returns the view UNCHANGED when the
// sample is already comfortably inside, so a following playhead doesn't
// re-centre on every frame (which reads as the waveform sliding continuously
// under a pinned line, and makes the material impossible to read).
export function scrollViewToInclude(view, numSamples, sample, edgeFraction = 0.12) {
  const n = Math.max(0, Math.floor(numSamples) || 0)
  if (!view || n <= MIN_VIEW_SAMPLES) return view ?? null
  const v = resolveView(view, n)
  const span = viewSpan(v)
  if (span >= n) return null
  const margin = span * clamp(edgeFraction, 0, 0.49)
  if (sample >= v.startSample + margin && sample <= v.endSample - margin) return view
  const start = clamp(Math.round(sample - span / 2), 0, n - span)
  return { startSample: start, endSample: start + span }
}
