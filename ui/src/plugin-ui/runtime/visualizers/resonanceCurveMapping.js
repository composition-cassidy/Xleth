// Pure coordinate / range helpers for the Resonance Suppressor focus-curve
// editor. Kept axis-consistent with resonancePainter.js so canvas visuals and
// the overlay handles share the same log-frequency mapping.
//
// Frequency: log scale, 20 Hz .. 20 kHz, x = 0 .. (w-1)
// Bell gain: linear, -12 dB .. +12 dB, y = (h-1) .. 0 (top is +12 dB)
//
// Param ranges (mirroring engine APVTS / manifest):
//   wc_hp        : 20    .. 2000   Hz
//   wc_lp        : 2000  .. 20000  Hz
//   wc_bN_freq   : 40    .. 20000  Hz
//   wc_bN_gain   : -12   .. 12     dB
//   wc_bN_q      : 0.25  .. 4.0
//   wc_bN_active : 0|1
//   wc_bN_type   : 0..4  (Bell/LowShelf/HighShelf/BandReject/Tilt)

export const FREQ_MIN_HZ = 20
export const FREQ_MAX_HZ = 20000

export const BELL_GAIN_MIN_DB = -12
export const BELL_GAIN_MAX_DB =  12

export const HP_MIN_HZ = 20
export const HP_MAX_HZ = 2000
export const LP_MIN_HZ = 2000
export const LP_MAX_HZ = 20000
export const BELL_FREQ_MIN_HZ = 40
export const BELL_FREQ_MAX_HZ = 20000

export const BAND_Q_MIN = 0.25
export const BAND_Q_MAX = 4.0

export const NUM_BANDS = 8

// Engine type enum (must mirror weightingForBin() in
// engine/src/audio/XlethResonanceSuppressorEffect.h). Mapping is canonical —
// changing values here without an engine change will silently mis-route DSP.
export const BAND_TYPE = Object.freeze({
  BELL:        0,
  LOW_SHELF:   1,
  HIGH_SHELF:  2,
  BAND_REJECT: 3,
  TILT:        4,
})

export const BAND_TYPE_OPTIONS = Object.freeze([
  Object.freeze({ value: 0, key: 'bell',  shortLabel: 'Bell', label: 'Bell'        }),
  Object.freeze({ value: 1, key: 'lsh',   shortLabel: 'LSh',  label: 'Low Shelf'   }),
  Object.freeze({ value: 2, key: 'hsh',   shortLabel: 'HSh',  label: 'High Shelf'  }),
  // Engine value 3 is "Band Reject"; UI-facing wording is "Protect".
  Object.freeze({ value: 3, key: 'prot',  shortLabel: 'Prot', label: 'Protect'     }),
  Object.freeze({ value: 4, key: 'tilt',  shortLabel: 'Tilt', label: 'Tilt'        }),
])

const LOG_SPAN = Math.log(FREQ_MAX_HZ / FREQ_MIN_HZ)

function finiteOr(value, fallback) {
  return Number.isFinite(value) ? value : fallback
}

export function clamp(value, min, max) {
  if (!Number.isFinite(value)) return min
  return Math.min(max, Math.max(min, value))
}

export function clampHp(hz)        { return clamp(hz, HP_MIN_HZ, HP_MAX_HZ) }
export function clampLp(hz)        { return clamp(hz, LP_MIN_HZ, LP_MAX_HZ) }
export function clampBellFreq(hz)  { return clamp(hz, BELL_FREQ_MIN_HZ, BELL_FREQ_MAX_HZ) }
export function clampBellGain(db)  { return clamp(db, BELL_GAIN_MIN_DB, BELL_GAIN_MAX_DB) }
export function clampBandQ(q)      { return clamp(q, BAND_Q_MIN, BAND_Q_MAX) }
export function clampBandType(t) {
  const i = Math.round(finiteOr(t, 0))
  return clamp(i, 0, BAND_TYPE_OPTIONS.length - 1)
}

export function freqToX(hz, w) {
  const safeW = Math.max(1, w | 0)
  const safe = clamp(finiteOr(hz, FREQ_MIN_HZ), FREQ_MIN_HZ, FREQ_MAX_HZ)
  const norm = Math.log(safe / FREQ_MIN_HZ) / LOG_SPAN
  return clamp(norm, 0, 1) * Math.max(1, safeW - 1)
}

export function xToFreq(x, w) {
  const safeW = Math.max(1, w | 0)
  const safeX = clamp(finiteOr(x, 0), 0, Math.max(0, safeW - 1))
  const norm  = safeW <= 1 ? 0 : safeX / (safeW - 1)
  return FREQ_MIN_HZ * Math.exp(norm * LOG_SPAN)
}

export function gainToY(db, h) {
  const safeH = Math.max(1, h | 0)
  const safe = clamp(finiteOr(db, 0), BELL_GAIN_MIN_DB, BELL_GAIN_MAX_DB)
  const norm = (safe - BELL_GAIN_MIN_DB) / (BELL_GAIN_MAX_DB - BELL_GAIN_MIN_DB)
  return (1 - norm) * Math.max(1, safeH - 1)
}

export function yToGain(y, h) {
  const safeH = Math.max(1, h | 0)
  const safeY = clamp(finiteOr(y, 0), 0, Math.max(0, safeH - 1))
  const norm  = safeH <= 1 ? 0.5 : 1 - (safeY / (safeH - 1))
  return BELL_GAIN_MIN_DB + norm * (BELL_GAIN_MAX_DB - BELL_GAIN_MIN_DB)
}

// ── Band param-id helpers ─────────────────────────────────────────────────────

export function bandParamIds(idx) {
  const i = idx | 0
  return Object.freeze({
    activeId: `wc_b${i}_active`,
    typeId:   `wc_b${i}_type`,
    freqId:   `wc_b${i}_freq`,
    gainId:   `wc_b${i}_gain`,
    qId:      `wc_b${i}_q`,
  })
}

// Stable list of band handle descriptors used by the overlay component and
// tests. Centralising the param-id binding keeps drag math, render, and tests
// from drifting.
export const BAND_HANDLES = Object.freeze(
  Array.from({ length: NUM_BANDS }, (_, i) => Object.freeze({ idx: i + 1, ...bandParamIds(i + 1) })),
)

// Read which bands are currently active (wc_bN_active >= 0.5). Order is 1..8.
export function getActiveBandIndices(params) {
  const out = []
  for (let i = 1; i <= NUM_BANDS; i++) {
    if (Number(params?.[`wc_b${i}_active`] ?? 0) >= 0.5) out.push(i)
  }
  return out
}

// Return the lowest 1..8 index whose wc_bN_active is currently inactive, or
// null if all 8 slots are taken.
export function findFirstInactiveBandIndex(params) {
  for (let i = 1; i <= NUM_BANDS; i++) {
    if (Number(params?.[`wc_b${i}_active`] ?? 0) < 0.5) return i
  }
  return null
}

// Compute parameter updates for a drag event. Pure: consumes a drag descriptor
// + pointer position + container size; emits a {paramId: value} map. The
// component layer is then responsible for calling setParam on each entry.
//
// drag.kind:
//   'hp' | 'lp'                                   — boundary drag
//   'bell'                                        — legacy bell drag
//                                                   (drag.freqId, drag.gainId)
//   'band'                                        — type-aware band drag
//                                                   (drag.bandType, drag.freqId,
//                                                    drag.gainId)
//
// For 'band', the gain axis is clamped to <= 0 dB when bandType is BandReject
// (UI: Protect) so the overlay drag can never push a Protect band into a
// boost regime even though the underlying APVTS still allows ±12 dB.
export function computeDragParamUpdates(drag, x, y, w, h) {
  if (!drag || typeof drag.kind !== 'string') return {}
  if (drag.kind === 'hp') {
    return { wc_hp: clampHp(xToFreq(x, w)) }
  }
  if (drag.kind === 'lp') {
    return { wc_lp: clampLp(xToFreq(x, w)) }
  }
  if (drag.kind === 'bell') {
    const freqId = typeof drag.freqId === 'string' ? drag.freqId : null
    const gainId = typeof drag.gainId === 'string' ? drag.gainId : null
    const out = {}
    if (freqId) out[freqId] = clampBellFreq(xToFreq(x, w))
    if (gainId) out[gainId] = clampBellGain(yToGain(y, h))
    return out
  }
  if (drag.kind === 'band') {
    const freqId   = typeof drag.freqId === 'string' ? drag.freqId : null
    const gainId   = typeof drag.gainId === 'string' ? drag.gainId : null
    const bandType = clampBandType(drag.bandType)
    const out = {}
    if (freqId) out[freqId] = clampBellFreq(xToFreq(x, w))
    if (gainId) {
      const rawGain = yToGain(y, h)
      out[gainId] = bandType === BAND_TYPE.BAND_REJECT
        ? clamp(rawGain, BELL_GAIN_MIN_DB, 0)
        : clampBellGain(rawGain)
    }
    return out
  }
  return {}
}

// ── Legacy alias ──────────────────────────────────────────────────────────────
// BELL_HANDLES is preserved as a 4-entry slice for any external readers / older
// snapshots, but the overlay now drives the full 8-slot model via BAND_HANDLES.
// New code should prefer BAND_HANDLES + getActiveBandIndices.
export const BELL_HANDLES = Object.freeze(BAND_HANDLES.slice(0, 4))
