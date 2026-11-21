// The sample editor's viewport: the ONE place a pixel becomes a time and back.
//
// A view is `{ start, end }` in seconds, or `null` meaning FIT (the whole
// source). null-means-fit matters: the duration is not known until the engine
// has decoded the file, and a fitted view must keep fitting when it arrives.
// Every other view is clamped when it is READ (`resolveView`), never when it is
// written, so a late or corrected duration cannot corrupt stored state.
//
// Pure and dependency-free.

/** Deepest zoom: 20 ms across the canvas, about a third of a millisecond per pixel. */
export const MIN_VIEW_DUR = 0.02

const EPS = 1e-6

const clamp = (v, lo, hi) => (hi < lo ? lo : Math.min(Math.max(v, lo), hi))

/** Concrete bounds for a stored view. */
export function resolveView(view, duration) {
  const d = Math.max(0, Number(duration) || 0)
  if (!view || d <= 0) return { start: 0, end: d, dur: Math.max(d, 0.001), zoomed: false }
  const span = clamp(view.end - view.start, Math.min(MIN_VIEW_DUR, d), d)
  const start = clamp(view.start, 0, d - span)
  const end = start + span
  return { start, end, dur: Math.max(span, 0.001), zoomed: span < d - 0.001 }
}

/** null once the span covers the whole source, so zooming out re-enters fit. */
function normalise(start, end, duration) {
  const span = end - start
  if (span >= duration - 0.001) return null
  const s = clamp(start, 0, duration - span)
  return { start: s, end: s + span }
}

/**
 * Zoom by `factor` (>1 zooms out) keeping `anchorTime` under the same pixel.
 * `anchorTime` defaults to the middle of the view.
 */
export function zoomView(view, duration, factor, anchorTime) {
  if (!(duration > 0) || !(factor > 0)) return view
  const v = resolveView(view, duration)
  const anchor = clamp(anchorTime ?? (v.start + v.end) / 2, v.start, v.end)
  const ratio = (anchor - v.start) / v.dur
  const span = clamp(v.dur * factor, Math.min(MIN_VIEW_DUR, duration), duration)
  const start = anchor - ratio * span
  return normalise(start, start + span, duration)
}

/** Shift the view by `deltaSec`. A fitted view cannot pan. */
export function panView(view, duration, deltaSec) {
  if (!view || !(duration > 0)) return view
  const v = resolveView(view, duration)
  return normalise(v.start + deltaSec, v.start + deltaSec + v.dur, duration)
}

/** Same span, centred on `time` (a click on the overview strip). */
export function centreView(view, duration, time) {
  if (!view || !(duration > 0)) return view
  const v = resolveView(view, duration)
  return normalise(time - v.dur / 2, time + v.dur / 2, duration)
}

/** Same span, starting at `start` (dragging the overview window). */
export function moveView(view, duration, start) {
  if (!view || !(duration > 0)) return view
  const v = resolveView(view, duration)
  return normalise(start, start + v.dur, duration)
}

/** Frame a range with `pad` of its length on each side (zoom to selection). */
export function viewForRange(start, end, duration, pad = 0.12) {
  if (!(duration > 0) || !(end > start)) return null
  const span = Math.max(end - start, MIN_VIEW_DUR / (1 + 2 * pad))
  const mid = (start + end) / 2
  const padded = Math.min(duration, span * (1 + 2 * pad))
  return normalise(mid - padded / 2, mid + padded / 2, duration)
}

/**
 * Keep `time` on screen during playback by paging. Returns the SAME object when
 * no scroll is needed, so a caller can skip the state write on identity.
 */
export function followView(view, duration, time) {
  if (!view || !(duration > 0)) return view
  const v = resolveView(view, duration)
  if (time >= v.start - EPS && time <= v.end + EPS) return view
  const start = time - v.dur * 0.1
  const next = normalise(start, start + v.dur, duration)
  return next ?? view
}

export function timeToX(time, v, width) {
  return ((time - v.start) / v.dur) * width
}

export function xToTime(x, v, width, duration) {
  if (!(width > 0)) return v.start
  const t = v.start + (x / width) * v.dur
  return clamp(t, 0, duration > 0 ? duration : Math.max(0, t))
}

// ── Ruler ───────────────────────────────────────────────────────────────────

const RULER_STEPS = [
  0.001, 0.002, 0.005, 0.01, 0.02, 0.05, 0.1, 0.2, 0.5,
  1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 1200, 1800, 3600,
]

/**
 * Labelled tick spacing for `pxPerSec`, at least `minLabelPx` apart, on a
 * 1-2-5 ladder; `minor` subdivides it when the subdivisions are 6px or wider.
 */
export function rulerStep(pxPerSec, minLabelPx = 72) {
  let major = RULER_STEPS[RULER_STEPS.length - 1]
  for (const step of RULER_STEPS) {
    if (step * pxPerSec >= minLabelPx) { major = step; break }
  }
  const lead = Number(String(major.toExponential()).charAt(0))
  const divisions = lead === 2 ? 4 : 5
  const minor = (major / divisions) * pxPerSec >= 6 ? major / divisions : major
  return { major, minor }
}

/** A ruler label carries only the precision its step needs. */
export function rulerLabel(time, step) {
  const decimals = step >= 1 ? 0 : step >= 0.1 ? 1 : step >= 0.01 ? 2 : 3
  const unit = 10 ** decimals
  const total = Math.max(0, Math.round(time * unit))
  const whole = Math.floor(total / unit)
  const base = `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`
  return decimals ? `${base}.${String(total % unit).padStart(decimals, '0')}` : base
}
