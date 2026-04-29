// ─── scaling.js ─────────────────────────────────────────────────────────────
// Pure helpers for mapping dB values, gain reduction, and time onto canvas
// pixel coordinates. Stateless — no caching, no DOM.

// dB → pixel Y, where minDb maps to bottom (h-1) and maxDb maps to top (0).
export function dbToY(db, minDb, maxDb, h) {
  if (!Number.isFinite(db)) return h - 1
  const clamped = db < minDb ? minDb : (db > maxDb ? maxDb : db)
  const t = (clamped - minDb) / (maxDb - minDb)
  return Math.round((1 - t) * (h - 1))
}

// Gain reduction (positive dB = more reduction) → pixel Y, top-down strip.
// 0 GR → top (y=0), maxGrDb → bottom (y=h-1).
export function grToY(grDb, maxGrDb, h) {
  const g = Number.isFinite(grDb) ? Math.max(0, grDb) : 0
  const t = Math.min(1, g / Math.max(maxGrDb, 0.001))
  return Math.round(t * (h - 1))
}

// dB → bar height fraction in [0..1] (0 dB at top, minDb at bottom).
export function dbToFrac(db, minDb, maxDb) {
  if (!Number.isFinite(db)) return 0
  const clamped = db < minDb ? minDb : (db > maxDb ? maxDb : db)
  return (clamped - minDb) / (maxDb - minDb)
}

// Compute soft-knee compressor output from input level using current params.
// Used by the static transfer-curve background trace. All in dB.
export function softKneeOutputDb(inDb, threshold, ratio, knee, makeup) {
  const slope    = 1 - 1 / Math.max(ratio, 1)
  const halfW    = knee * 0.5
  const overshoot = inDb - threshold
  let grDb
  if (overshoot <= -halfW) grDb = 0
  else if (overshoot >= halfW) grDb = slope * overshoot
  else {
    const t = overshoot + halfW
    grDb = 0.5 * slope * t * t / Math.max(knee, 1e-6)
  }
  return inDb - grDb + (makeup || 0)
}

// Default scale presets used by the painters. Centralised so multiple presets
// can share consistent ranges.
export const SCALES = Object.freeze({
  level:         { minDb: -60, maxDb: 0 },
  gainReduction: { maxGrDb: 24 },
  transfer:      { minDb: -60, maxDb: 0 },
})
