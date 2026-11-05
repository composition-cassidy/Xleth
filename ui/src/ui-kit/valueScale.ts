// Value <-> normalised-position scales for the kit's controls.
//
// A control's drag law works in NORMALISED 0..1 space over a fixed pixel travel,
// so the curve of a parameter (linear, skewed, log, the mixer's dB taper) is
// entirely the scale's business. A scale's `fromNorm` clamps its input to 0..1;
// `toNorm` clamps its output to 0..1.

export interface Scale {
  toNorm(value: number): number;
  fromNorm(norm: number): number;
  /** Snap out-of-domain values onto the scale's own floor/ceiling (typed -200 dB -> -inf). */
  normalize?(value: number): number;
}

export const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x);

export function linearScale(min: number, max: number): Scale {
  const span = max - min || 1;
  return {
    toNorm: (v) => clamp01((v - min) / span),
    fromNorm: (n) => min + clamp01(n) * span,
  };
}

/**
 * JUCE NormalisableRange-style skew, identical to the legacy sampler Knob:
 * toNorm = ((v - min) / (max - min)) ^ skew. A skew below 1 expands the low end.
 */
export function skewScale(min: number, max: number, skew: number): Scale {
  const k = Number.isFinite(skew) && skew > 0 ? skew : 1;
  if (k === 1) return linearScale(min, max);
  const span = max - min || 1;
  return {
    toNorm: (v) => clamp01(((v - min) / span) ** k),
    fromNorm: (n) => min + span * clamp01(n) ** (1 / k),
  };
}

/** Exponential (equal ratios per pixel): frequency, time. Needs 0 < min < max. */
export function logScale(min: number, max: number): Scale {
  const lo = Math.log(min);
  const span = Math.log(max) - lo || 1;
  return {
    toNorm: (v) => (v <= min ? 0 : clamp01((Math.log(v) - lo) / span)),
    fromNorm: (n) => Math.exp(lo + clamp01(n) * span),
  };
}

// ── Mixer fader taper, in dB ────────────────────────────────────────────────
// Position p in [0,1] -> dB: p=0 -inf, p=0.75 0 dB, p=1 +12 dB, a cubic below
// unity (fine near 0 dB, accelerating toward -96) and linear above. The same
// curve the mixer fader has always had, expressed over dB values instead of
// linear gain so the kit never handles gain.
export const FADER_FLOOR_DB = -96;
export const FADER_CEIL_DB = 12;

export const dbTaperScale: Scale = {
  normalize: (db) => (db <= FADER_FLOOR_DB ? -Infinity : db),
  toNorm(db) {
    if (db <= FADER_FLOOR_DB) return 0;
    if (db >= FADER_CEIL_DB) return 1;
    if (db >= 0) return 0.75 + (db / FADER_CEIL_DB) * 0.25;
    return 0.75 * (1 - (-db / -FADER_FLOOR_DB) ** (1 / 3));
  },
  fromNorm(p) {
    if (p <= 0) return -Infinity;
    if (p >= 1) return FADER_CEIL_DB;
    if (p <= 0.75) {
      const db = FADER_FLOOR_DB * (1 - p / 0.75) ** 3;
      return db <= FADER_FLOOR_DB ? -Infinity : db;
    }
    return ((p - 0.75) / 0.25) * FADER_CEIL_DB;
  },
};

/** Lowest and highest value a scale can produce. */
export function scaleBounds(scale: Scale): { lo: number; hi: number } {
  return { lo: scale.fromNorm(0), hi: scale.fromNorm(1) };
}

export function clampToScale(scale: Scale, value: number): number {
  const { lo, hi } = scaleBounds(scale);
  if (Number.isNaN(value)) return lo;
  const v = scale.normalize ? scale.normalize(value) : value;
  return v < lo ? lo : v > hi ? hi : v;
}
