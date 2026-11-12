import { gainEnvelopeAt } from '../../stores/sandboxStore.js'

// ── Gain envelope: the dB axis, and what the pointer is over ────────────────
//
// Pure geometry for the Envelope tool, kept out of the canvas component so it
// can be tested without one. The component supplies the two view mappings
// (`s2x`: sample → x, `x2s`: x → sample) for the view that is ON SCREEN NOW.
//
// That last part is the reason this file exists. The handle hit-test used to
// live in the component as a callback with an empty dependency list, so it kept
// the `s2x` from the component's very first render — which happens before the
// layer's audio has arrived, when the view is zero samples wide and every
// handle maps to nowhere. It never matched a handle again. Every press on the
// line therefore fell through to "insert a breakpoint here", and right-click
// never found a handle to delete: the curve could only grow. Taking the
// mappings as arguments means there is nothing here to go stale.

// ── The dB axis ──────────────────────────────────────────────────────────────
// Linear in dB from ENV_TOP_DB down to ENV_BOTTOM_DB, so equal vertical
// distances are equal dB — the whole point of "Y axis is dB, not linear".
// Unity sits near the TOP rather than at the middle, because this axis is used
// for ducking far more than for boosting, and because a unity line through the
// vertical centre would land exactly on the waveform's own zero-crossing line.
// The engine clamps wider than this (±96/24 dB); a curve loaded from a project
// that exceeds the drawable range is displayed clamped to the edge, and moving
// that handle rewrites it to what is on screen.
export const ENV_TOP_DB = 12
export const ENV_BOTTOM_DB = -60
export const ENV_HANDLE_R = 4       // drawn radius
export const ENV_HIT_R = 8          // grab radius — a pointer target, larger than the dot
export const ENV_LINE_HIT_PX = 7    // how close to the curve a press counts as "on the line"
export const ENV_GRID_DB = [0, -12, -24, -36, -48]

export function envDbToY(db, h) {
  const t = (ENV_TOP_DB - db) / (ENV_TOP_DB - ENV_BOTTOM_DB)
  return Math.max(0, Math.min(1, t)) * h
}

export function envYToDb(y, h) {
  const t = Math.max(0, Math.min(1, y / Math.max(1, h)))
  return ENV_TOP_DB - t * (ENV_TOP_DB - ENV_BOTTOM_DB)
}

// Index of the handle under the pointer, or -1. `pos` is { x, y, w, h } in the
// canvas's own pixels. The NEAREST handle inside the grab radius wins, not the
// first one found: two breakpoints a few pixels apart overlap each other's
// radius, and "first in the list" would make the right-hand one ungrabbable.
export function hitEnvelopeHandle(points, pos, s2x) {
  let best = -1
  let bestDist = ENV_HIT_R
  for (let i = 0; i < points.length; i++) {
    const dist = Math.hypot(s2x(points[i].samplePos, pos.w) - pos.x, envDbToY(points[i].db, pos.h) - pos.y)
    if (dist <= bestDist) { best = i; bestDist = dist }
  }
  return best
}

// What a press at `pos` would act on:
//   { kind: 'handle', index }     an existing breakpoint — a press grabs it
//   { kind: 'line', sample, db }  the curve between breakpoints — a press adds one
//   { kind: 'none' }              neither — the press belongs to the selection
// The one decision the press, the right-click and the hover cursor all share,
// so what the cursor promises is what the press does.
export function envelopeTargetAt(points, pos, { s2x, x2s }) {
  const index = hitEnvelopeHandle(points, pos, s2x)
  if (index >= 0) return { kind: 'handle', index }
  const sample = x2s(pos.x, pos.w)
  const db = 20 * Math.log10(Math.max(1e-9, gainEnvelopeAt(points, sample)))
  if (Math.abs(envDbToY(db, pos.h) - pos.y) <= ENV_LINE_HIT_PX) return { kind: 'line', sample, db }
  return { kind: 'none' }
}
