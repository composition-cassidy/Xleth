// Meter slot assignments for XlethEffectBase (8 atomic slots per effect).
// Matches kNumMeterSlots in engine/src/audio/XlethEffectBase.h.
//
// Convention: slots 0–1 are universal L/R peak, slots 2–7 are effect-specific.
// Multiple effects may reuse the same slot indices since each effect instance
// has its own independent meterSlots_[8] array.

export const NUM_METER_SLOTS = 8

// Universal (all effects)
export const PEAK_L = 0
export const PEAK_R = 1

// Dynamics: Compressor, Limiter, Transient Proc
export const GAIN_REDUCTION   = 2
export const LUFS_MOMENTARY   = 3
export const LUFS_SHORT_TERM  = 4

// Multiband: OTT / Overdone
export const BAND_GR_LOW  = 2
export const BAND_GR_MID  = 3
export const BAND_GR_HIGH = 4
