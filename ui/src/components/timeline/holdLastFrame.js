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
