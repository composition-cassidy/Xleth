// Pure helpers for the sampler AUTO-loop telemetry. Kept out of the component so
// the nudge decision — "did the user adjust the snapped loop, and how soon?" —
// is unit-testable without rendering the whole sampler panel.

// How long after an AUTO apply an edit still counts as a nudge (task spec: 30 s).
export const NUDGE_WINDOW_MS = 30000

// Given the last AUTO apply record and a partial sampler-settings change, decide
// whether this edit is a "nudge" of the snapped loop. Returns the telemetry event
// to log, or null. `apply` is { t, regionId, loopStart, loopEnd, crossfadeSamples }
// (sample-rounded) or null.
export function nudgeEventFor(apply, partial, regionId, now = Date.now(), windowMs = NUDGE_WINDOW_MS) {
  if (!apply || apply.regionId !== regionId) return null
  if (now - apply.t > windowMs) return null
  for (const field of ['loopStart', 'loopEnd', 'crossfadeSamples']) {
    if (partial[field] == null) continue
    const to = Math.round(partial[field])
    if (to === apply[field]) continue      // unchanged from the snapped value
    return { kind: 'nudge', field, from: apply[field], to, since_apply_ms: now - apply.t }
  }
  return null
}

// The apply record to arm nudge detection with, from an engine AutoLoopResult.
export function applyRecordFor(res, regionId, now = Date.now()) {
  return {
    t: now,
    regionId,
    loopStart: Math.round(res.loopStart),
    loopEnd: Math.round(res.loopEnd),
    crossfadeSamples: Math.round(res.crossfadeSamples),
  }
}
