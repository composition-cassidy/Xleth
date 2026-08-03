// ─── delayVizMath.js ──────────────────────────────────────────────────────────
// Pure, side-effect-free math shared by the Delay panel's two canvases
// (DelayEchoFieldVisualizer, DelayFilterCurve) and by DelayPanel's readouts.
//
// Nothing here touches the DOM, the canvas, or the theme — every export is
// directly unit-testable. See __tests__/delayViz.test.js.
//
// Historical note: these helpers previously lived inside
// DelayTapeheadVisualizer.jsx. They were lifted out unchanged (same signatures,
// same numeric behaviour) when the tapehead visual was replaced by the echo
// field, so the existing test expectations still apply verbatim.

// ── Basics ───────────────────────────────────────────────────────────────────

// The frequency-axis and first-order filter-response helpers moved to
// mixerFilterMath.js when the Reverb panel gained the same draggable curve —
// the two engines build an identical LP×HP topology, so the maths is shared
// rather than duplicated. They are re-exported here unchanged so every existing
// `from './delayVizMath.js'` import (and its tests) keeps working verbatim.
export {
  clamp,
  filterMagnitude,
  filterMagnitudeDb,
  freqToNorm,
  normToFreq,
  dbToNorm,
  pickFilterHandle,
  formatHz,
  FILTER_F_MIN,
  FILTER_F_MAX,
} from './mixerFilterMath.js'

import { clamp } from './mixerFilterMath.js'

/** Maps mix (0–100 %) to wet opacity in [0.12, 1.0]. */
export function mixToAlpha(mixPct) {
  return 0.12 + clamp(mixPct / 100, 0, 1) * 0.88
}

/** Maps feedback (0–95 %) to per-echo decay factor in [0, 1]. */
export function feedbackToDecay(fbPct) {
  return clamp(fbPct / 95, 0, 1)
}

/** Returns the LFO phase in radians given rate (Hz) and elapsed time (ms). */
export function lfoPhase(rateHz, elapsedMs) {
  return (2 * Math.PI * rateHz * elapsedMs) / 1000
}

/**
 * Maps a delay time (ms) to a normalised x position [0, 1].
 * axisMaxMs is the total visible range in ms.
 */
export function timeToNorm(timeMs, axisMaxMs) {
  return clamp(timeMs / axisMaxMs, 0, 1)
}

/**
 * Derives the visible axis range (ms) from current L and R delay times.
 * Keeps the first tap at roughly 33 % of the visible width.
 * Result is clamped to [800, 5000] ms.
 */
export function computeAxisMax(timeLMs, timeRMs) {
  const peak = Math.max(timeLMs, timeRMs, 1)
  return clamp(peak * 2.8, 800, 5000)
}

// ── Sync divisions ───────────────────────────────────────────────────────────

// Decode a legacy sync_div index to a display label.
// Matches engine kDivFractions order exactly:
//   0=1/1, 1=1/2, 2=1/2D, 3=1/4, 4=1/4D, 5=1/4T,
//   6=1/8, 7=1/8D, 8=1/8T, 9=1/16, 10=1/16D, 11=1/16T
const SYNC_DIV_LABELS = [
  '1/1', '1/2', '1/2D', '1/4', '1/4D', '1/4T',
  '1/8', '1/8D', '1/8T', '1/16', '1/16D', '1/16T',
]

/** Returns the display label for a legacy sync_div index (0–11). */
export function syncDivLabel(idx) {
  const i = Math.round(clamp(idx ?? 3, 0, 11))
  return SYNC_DIV_LABELS[i] ?? '1/4'
}

// Beat-fraction multipliers, parallel to engine kDivFractions.
const K_FRACS = [4, 2, 3, 1, 1.5, 2 / 3, 0.5, 0.75, 1 / 3, 0.25, 0.375, 1 / 6]

/** Returns the beat multiplier for a legacy sync_div index (0–11). */
export function divisionBeats(idx) {
  const i = Math.round(clamp(idx ?? 3, 0, 11))
  return K_FRACS[i] ?? 1
}

/**
 * Converts a legacy sync_div index to milliseconds at the given tempo.
 * Used only for the visualizer's tap spacing when sync is engaged — the engine
 * does its own conversion from the live transport tempo.
 */
export function divisionToMs(idx, bpm) {
  const safeBpm = clamp(bpm || 120, 20, 300)
  return (60000 / safeBpm) * divisionBeats(idx)
}

// ── Echo tap series ──────────────────────────────────────────────────────────

/**
 * Builds the visible echo series for the two lanes.
 *
 * Models the engine's feedback loop honestly: each bounce applies the ping-pong
 * cross-feed matrix (stereo_width = cross amount) and then the feedback gain.
 *
 *   [gL', gR'] = fbGain × [ (1−c)·gL + c·gR ,  (1−c)·gR + c·gL ]
 *
 * The seed is deliberately asymmetric (a mostly-left source) so cross-feed is
 * visible: at c = 0 the lanes stay independent, at c = 1 the energy alternates
 * lane to lane — exactly what the parameter does to the audio.
 *
 * Returns [{ n, tL, tR, gL, gR }], ordered n = 1, 2, 3 …, truncated once both
 * gains fall under `floor` or a tap would land past `axisMaxMs`.
 */
export function echoTaps({
  timeLMs,
  timeRMs,
  feedbackPct,
  crossPct = 0,
  axisMaxMs = 5000,
  maxTaps = 14,
  seedL = 1,
  seedR = 0.55,
  floor = 0.006,
}) {
  const fb = feedbackToDecay(feedbackPct) * 0.985  // 95 % maps to just under unity
  const c = clamp(crossPct / 100, 0, 1)
  const taps = []

  let gL = clamp(seedL, 0, 1)
  let gR = clamp(seedR, 0, 1)

  for (let n = 1; n <= maxTaps; n++) {
    const tL = timeLMs * n
    const tR = timeRMs * n
    if (tL > axisMaxMs && tR > axisMaxMs) break
    if (gL < floor && gR < floor) break

    taps.push({ n, tL, tR, gL, gR })

    const nextL = fb * ((1 - c) * gL + c * gR)
    const nextR = fb * ((1 - c) * gR + c * gL)
    gL = nextL
    gR = nextR
  }

  return taps
}

// ── Stereo mode ──────────────────────────────────────────────────────────────
// Matches the engine's discrete stereo_mode parameter exactly (XlethDelayEffect.h).

export const STEREO_MODE_SINGLE = 0
export const STEREO_MODE_DUAL = 1
export const STEREO_MODE_PINGPONG = 2

/**
 * Display label for the stereo_width knob. Single mode repurposes the same
 * engine parameter as a symmetric time spread rather than cross-feed, so the
 * label changes to match what the knob actually does — the param id sent to
 * the engine never changes.
 */
export function stereoWidthLabel(mode) {
  return mode === STEREO_MODE_SINGLE ? 'SPREAD' : 'WIDTH'
}

/**
 * Effective cross-feed percentage (0–100) for the echo-field simulation.
 * Single forces cross-feed to 0 (stereo_width means spread there instead);
 * PingPong forces cross-feed to 100 regardless of the knob; Dual passes
 * stereo_width through unchanged — mirrors the engine's per-mode overrides.
 */
export function crossFeedForMode(mode, widthPct) {
  if (mode === STEREO_MODE_SINGLE) return 0
  if (mode === STEREO_MODE_PINGPONG) return 100
  return clamp(widthPct, 0, 100)
}

/**
 * Single-mode spread in ms: stereo_width steers a ±100 ms symmetric offset
 * around the shared base time. 50 % is centred (no spread).
 */
export function singleModeSpreadMs(widthPct) {
  return clamp((widthPct - 50) / 50, -1, 1) * 100
}

/** Per-lane delay times (ms) for Single mode: base time offset symmetrically by spread. */
export function singleModeLaneTimes(baseMs, widthPct) {
  const spread = singleModeSpreadMs(widthPct)
  return {
    timeL: clamp(baseMs - spread, 1, 5000),
    timeR: clamp(baseMs + spread, 1, 5000),
  }
}

// ── Readout formatting ───────────────────────────────────────────────────────

/** "480 ms" / "1.25 s" */
export function formatMs(ms) {
  if (ms >= 1000) return `${(ms / 1000).toFixed(2)} s`
  return `${Math.round(ms)} ms`
}
