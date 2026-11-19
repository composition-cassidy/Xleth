// Hold Last Frame threshold — shared renderer-side helpers.
//
// The engine stores the threshold on TrackInfo as
// `videoHoldLastFrameThresholdBeats`, in BEATS, where any negative value is the
// canonical "unlimited" sentinel (see TimelineTypes.h
// TrackInfo::kHoldLastFrameThresholdUnlimited). Unlimited is the default for
// every project saved before the threshold existed, so the read paths here
// treat missing/NaN exactly like unlimited.
//
// Everything in this module is pure arithmetic over data already in the track
// store — no IPC, no engine queries — so the canvas draw path can call it every
// frame for free.

import { PPQ } from '../../constants/timeline.js'

export const HOLD_THRESHOLD_UNLIMITED = -1

// A track's threshold is "unlimited" unless it is a finite number >= 0.
//
// null / undefined / '' are rejected BEFORE the Number() coercion on purpose:
// Number(null) and Number('') are both 0, which would silently read as a
// zero-beat threshold — i.e. cut the held frame instantly — for a track that
// actually means "unlimited". Unlimited is the backward-compatible default, so
// every ambiguous input must land there.
export function isHoldThresholdUnlimited(thresholdBeats) {
  if (thresholdBeats == null || thresholdBeats === '') return true
  const n = Number(thresholdBeats)
  return !(Number.isFinite(n) && n >= 0)
}

// Read the threshold off a track record, in beats.
// Returns HOLD_THRESHOLD_UNLIMITED for unlimited / absent / malformed.
export function getHoldThresholdBeats(track) {
  const raw = track?.videoHoldLastFrameThresholdBeats
  return isHoldThresholdUnlimited(raw) ? HOLD_THRESHOLD_UNLIMITED : Number(raw)
}

// Threshold in TICKS, or null when unlimited. Mirrors the engine's beat-domain
// comparison; the renderer works in ticks, hence the PPQ scale here only.
export function getHoldThresholdTicks(track) {
  const beats = getHoldThresholdBeats(track)
  return beats < 0 ? null : beats * PPQ
}

// ── Smart hold ────────────────────────────────────────────────────────────────
// Mirror of engine/src/model/SmartHold.h — keep the constants and the rule
// identical, so the hold zones drawn on the timeline are the gaps the engine
// actually holds. A gap is held iff gapBeats <= threshold.
export const SMART_MIN_BLANK_GAP_BEATS = 1
export const SMART_MIN_BREAK_RATIO = 2
export const SMART_FALLBACK_THRESHOLD_BEATS = 4
const SMART_GAP_FLOOR_BEATS = 1 / 16
const SMART_GAP_EPSILON_BEATS = 1e-6

export function smartHoldThresholdBeats(gaps) {
  const g = (gaps ?? []).filter((x) => Number.isFinite(x) && x > SMART_GAP_EPSILON_BEATS).sort((a, b) => a - b)
  if (g.length === 0) return Number.POSITIVE_INFINITY
  let bestRatio = 0
  let bestThreshold = 0
  for (let i = 0; i + 1 < g.length; i++) {
    const hi = g[i + 1]
    if (hi < SMART_MIN_BLANK_GAP_BEATS) continue
    const lo = Math.max(g[i], SMART_GAP_FLOOR_BEATS)
    const ratio = hi / lo
    if (ratio >= SMART_MIN_BREAK_RATIO && ratio > bestRatio) {
      bestRatio = ratio
      bestThreshold = Math.sqrt(lo * hi)
    }
  }
  if (bestRatio > 0) return bestThreshold
  if (g[g.length - 1] < SMART_MIN_BLANK_GAP_BEATS) return Number.POSITIVE_INFINITY
  return SMART_FALLBACK_THRESHOLD_BEATS
}

// intervals: [[startBeats, endBeats], ...] of one track, any order, overlaps
// allowed. Gap lengths between the merged busy spans.
export function gapsBetween(intervals) {
  const gaps = []
  if (!intervals || intervals.length < 2) return gaps
  const sorted = [...intervals].sort((a, b) => a[0] - b[0] || a[1] - b[1])
  let end = sorted[0][1]
  for (let i = 1; i < sorted.length; i++) {
    const [s, e] = sorted[i]
    if (s > end) gaps.push(s - end)
    end = Math.max(end, e)
  }
  return gaps
}

// Display label for the threshold in menus / summary chips.
export function formatHoldThreshold(thresholdBeats) {
  if (isHoldThresholdUnlimited(thresholdBeats)) return 'Unlimited'
  const n = Number(thresholdBeats)
  // Trim trailing zeros: 4 -> "4", 0.5 -> "0.5", 1.50 -> "1.5".
  const text = Number.isInteger(n) ? String(n) : String(Number(n.toFixed(3)))
  return `${text} ${n === 1 ? 'beat' : 'beats'}`
}

// Menu presets offered next to the Hold Last Frame toggle. Kept musical
// (fractions and multiples of a beat) rather than linear.
export const HOLD_THRESHOLD_PRESETS = [
  { beats: HOLD_THRESHOLD_UNLIMITED, label: 'Unlimited' },
  { beats: 0.25, label: '1/16 note (0.25)' },
  { beats: 0.5, label: '1/8 note (0.5)' },
  { beats: 1, label: '1 beat' },
  { beats: 2, label: '2 beats' },
  { beats: 4, label: '1 bar (4 beats)' },
  { beats: 8, label: '2 bars (8 beats)' },
  { beats: 16, label: '4 bars (16 beats)' },
]
