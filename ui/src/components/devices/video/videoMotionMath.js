// Pure maths behind the Bounce and Note fade displays. Each function is a line
// for line port of the engine code that animates the picture, so the display
// draws what the compositor does, never a made-up shape:
//   bounce   — engine/src/render/AnimationManager.cpp (easeOutBack /
//              easeOutElastic / easeOutSpring and the "Advance bounce animation"
//              block: per-repeat decay 0.5^n, offset = distance * (1 - eased))
//   noteFade — engine/src/model/NoteFade.h (curvePoints, divisionBeats,
//              sidePercent) and engine/src/audio/ClipFade.h
//              (evaluateClipFadeBezier, evaluateClipFadeGain)
// No DOM, no engine calls. Tested in __tests__/videoMotionMath.test.js.

// ── Bounce ───────────────────────────────────────────────────────────────────

export function easeOutBack(t, overshoot = 1.70158) {
  const c3 = overshoot + 1
  return 1 + c3 * (t - 1) ** 3 + overshoot * (t - 1) ** 2
}

export function easeOutElastic(t) {
  if (t <= 0) return 0
  if (t >= 1) return 1
  return 2 ** (-10 * t) * Math.sin((t * 10 - 0.75) * ((2 * Math.PI) / 3)) + 1
}

export function easeOutSpring(t) {
  return 1 - 2 ** (-6 * t) * Math.cos(6 * Math.PI * t)
}

/** Total length of one bounce, in ms: durationMs per repeat. */
export function bounceTotalMs(b) {
  const rc = (b?.repeatCount ?? 1) > 0 ? (b?.repeatCount ?? 1) : 1
  return (b?.durationMs ?? 200) * rc
}

/**
 * Displacement of the cell at `elapsedMs` after the note, as a fraction of the
 * cell (signed along the bounce direction; the engine splits it into x and y by
 * the direction angle). 0 once every repeat is done.
 */
export function bounceDisplacement(b, elapsedMs) {
  const total = bounceTotalMs(b)
  if (!(total > 0)) return 0
  const rc = (b?.repeatCount ?? 1) > 0 ? (b?.repeatCount ?? 1) : 1
  const single = total / rc
  const repeat = Math.floor(elapsedMs / single)
  if (repeat >= rc || elapsedMs < 0) return 0
  const localT = Math.min(1, Math.max(0, (elapsedMs % single) / single))
  let eased
  switch (b?.easingType ?? 0) {
    case 1: eased = easeOutElastic(localT); break
    case 2: eased = easeOutSpring(localT); break
    default: eased = easeOutBack(localT, b?.overshoot ?? 1.70158)
  }
  const decay = 0.5 ** repeat
  return (b?.distance ?? 0.15) * (1 - eased) * decay
}

// ── Note fade ────────────────────────────────────────────────────────────────

/** NoteFadeSettings::Curve -> cubic-bezier control points (NoteFade.h curvePoints). */
export const FADE_CURVES = Object.freeze({
  0: [0, 0, 1, 1], // Linear
  1: [0.42, 0, 0.58, 1], // Smooth
  2: [0, 0, 0.58, 1], // Snappy
  3: [0.42, 0, 1, 1], // Gentle
})

export const MIN_DIVISION = 4
export const MAX_DIVISION = 64

/** ClipFade.h evaluateClipFadeBezier: y at x of a (0,0)-(1,1) cubic bezier, 5 Newton steps. */
export function fadeBezier(x, [x1, y1, x2, y2]) {
  if (x <= 0) return 0
  if (x >= 1) return 1
  let t = x
  for (let i = 0; i < 5; i += 1) {
    const omt = 1 - t
    const bx = 3 * omt * omt * t * x1 + 3 * omt * t * t * x2 + t * t * t
    const dbx = 3 * omt * omt * x1 + 6 * omt * t * (x2 - x1) + 3 * t * t * (1 - x2)
    if (Math.abs(dbx) < 1e-7) break
    t = Math.min(1, Math.max(0, t - (bx - x) / dbx))
  }
  const omt = 1 - t
  return 3 * omt * omt * t * y1 + 3 * omt * t * t * y2 + t * t * t
}

export const divisionBeats = (d) => 4 / Math.min(MAX_DIVISION, Math.max(MIN_DIVISION, d))

/** NoteFade.h sidePercent: one side's length as 0..100 % of this note. */
export function sidePercent(side, noteBeats, bpm) {
  if (!(noteBeats > 0) || !Number.isFinite(noteBeats)) return 0
  let pct = 0
  switch (side?.mode ?? 0) {
    case 1: pct = (100 * divisionBeats(side?.divisionDenominator ?? 16)) / noteBeats; break
    case 2: {
      const safeBpm = bpm > 0 && Number.isFinite(bpm) ? bpm : 140
      const noteMs = noteBeats * (60000 / safeBpm)
      if (!(noteMs > 0)) return 0
      pct = (100 * (side?.ms ?? 60)) / noteMs
      break
    }
    default: pct = Number.isFinite(side?.percent) ? side.percent : 10
  }
  return Number.isFinite(pct) ? Math.min(100, Math.max(0, pct)) : 0
}

/** ClipFade.h evaluateClipFadeGain over the resolved percents: opacity 0..1 at `progress` 0..1 of the note. */
export function noteFadeGain(nf, progress, noteBeats, bpm) {
  const p = Math.min(1, Math.max(0, progress))
  let inR = sidePercent(nf?.fadeIn, noteBeats, bpm) / 100
  let outR = sidePercent(nf?.fadeOut, noteBeats, bpm) / 100
  const total = inR + outR
  if (total > 1) { inR /= total; outR /= total }
  let gain = 1
  if (inR > 0 && p < inR) gain *= fadeBezier(p / inR, FADE_CURVES[nf?.fadeIn?.curve ?? 0] ?? FADE_CURVES[0])
  const remaining = 1 - p
  if (outR > 0 && remaining < outR) gain *= fadeBezier(remaining / outR, FADE_CURVES[nf?.fadeOut?.curve ?? 0] ?? FADE_CURVES[0])
  return gain
}
