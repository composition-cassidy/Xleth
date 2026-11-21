import { getRegime } from '../../utils/waveformRenderer.js'

// Shared zoom-regime tracker for the audio timeline.
//
// getRegime() implements a 30% hysteresis band around each regime boundary,
// but ONLY when it is handed the previous regime — and both of this app's
// callers were invoking it as getRegime(spp), i.e. with the default
// prev = 'envelope'. That made the hysteresis dead code, so a zoom gesture
// crossing spp ≈ 200 (or 8, or 0.5) flipped regime on individual frames.
//
// That flapping is not merely cosmetic. TimelineView's hi-res fetch effect
// WIPES hiResCacheRef whenever the regime reads 'envelope' and refetches when
// it does not, so a zoom parked near a boundary would clear and refetch the
// whole viewport's peak data over and over.
//
// The two callers (drawClips, and the hi-res fetch effect) must always agree —
// if the drawer thinks 'waveform' while the fetcher thinks 'envelope', the
// fetcher populates nothing the drawer can use. So the previous-regime state
// is shared here rather than kept per-caller. Both derive spp from the same
// (ppb, bpm, 48kHz) inputs, and getRegime is idempotent while spp stays inside
// the current regime's band, so the order and frequency of calls does not
// matter — only the zoom level does.
let _prev = 'envelope'

/** Advance and return the current regime for this samples-per-pixel value. */
export function currentRegime(spp) {
  _prev = getRegime(spp, _prev)
  return _prev
}

/** Peek without advancing. */
export function peekRegime() {
  return _prev
}

/**
 * Reset to the cold-start regime. For tests, and for project load — a fresh
 * project should not inherit the previous one's hysteresis position.
 */
export function resetRegime() {
  _prev = 'envelope'
}
