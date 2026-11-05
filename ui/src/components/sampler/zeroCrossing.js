// ── Zero-crossing snap ──────────────────────────────────────────────────────
// Nudge a just-placed trim or loop point onto the nearest sample where the
// waveform crosses zero. A loop whose two ends sit at non-zero samples steps
// discontinuously on every wrap, which is the click you hear on a sustained
// layer; landing both ends on a crossing removes it at the source rather than
// hiding it under a crossfade.
//
// The search radius is deliberately tied to the ZOOM, not to a fixed sample
// count: it is about two pixels' worth of samples at the current view scale, so
// a snap is never a visible jump — the marker lands where it was dropped, just
// cleaned up. Zoomed far out, two pixels is a lot of samples, so the radius is
// capped; zoomed right in, it shrinks to a handful.
const MIN_RADIUS = 4
const MAX_RADIUS = 2048

export function radiusForView(viewLen, width) {
  const perPx = (viewLen > 0 && width > 0) ? viewLen / width : 1
  return Math.max(MIN_RADIUS, Math.min(MAX_RADIUS, Math.round(perPx * 2)))
}

// Pure part, exported for tests: index of the crossing nearest `centerIdx`.
// Returns -1 when the block never crosses zero (a fully-DC or silent window),
// in which case the caller keeps the original position.
export function nearestCrossingIndex(samples, centerIdx) {
  if (!samples || samples.length < 2) return -1
  const n = samples.length
  const c = Math.max(0, Math.min(n - 1, Math.round(centerIdx)))

  // An exact zero is already a crossing.
  if (samples[c] === 0) return c

  let best = -1
  let bestDist = Infinity
  for (let i = 0; i < n - 1; i++) {
    const a = samples[i]
    const b = samples[i + 1]
    // A sign change between consecutive samples, or an exact zero at i+1.
    const crosses = (a <= 0 && b > 0) || (a >= 0 && b < 0) || b === 0
    if (!crosses) continue
    // Snap to whichever side of the crossing is actually closer to zero — that
    // is the sample that will be played, so it is the one that matters.
    const idx = Math.abs(a) <= Math.abs(b) ? i : i + 1
    const d = Math.abs(idx - c)
    if (d < bestDist) { bestDist = d; best = idx }
  }
  return best
}

// Resolve `target` to the nearest zero crossing in the slot's audio.
// Falls back to `target` unchanged on any failure — a snap is a convenience,
// and a failed fetch must never move or drop the point the user placed.
export async function snapToZeroCrossing(regionId, slotIndex, target, viewLen, width, numSamples) {
  const t = Math.round(Number(target) || 0)
  if (regionId == null || !Number.isFinite(t)) return t
  const total = Number(numSamples) || 0
  const radius = radiusForView(viewLen, width)
  const start = Math.max(0, t - radius)
  const end = total > 0 ? Math.min(total, t + radius) : t + radius
  if (end - start < 2) return t

  try {
    const res = await window.xleth?.waveform?.getRawSamples?.(
      regionId, start, end, 0, slotIndex)
    const samples = res?.samples
    if (!samples || samples.length < 2) return t
    const idx = nearestCrossingIndex(samples, t - start)
    if (idx < 0) return t
    const snapped = start + idx
    // Guard against a pathological result moving the point further than the
    // radius we asked for.
    return Math.abs(snapped - t) <= radius ? snapped : t
  } catch {
    return t
  }
}
