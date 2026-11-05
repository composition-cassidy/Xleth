// Meter ballistics, in dB (pure). Levels fall LINEARLY IN dB, never linearly in
// amplitude, so the decay reads the same at every level.
//
//   level  instant attack; releases at `fallDbPerSec`.
//   peak   latches the highest level, holds `holdMs`, then falls at `peakFallDbPerSec`
//          (never below the live level).
//   clip   `clipped` is true for the frame in which the input reached `clipDb`;
//          the component latches it until the user clears it.

export interface MeterState {
  level: number;
  peak: number;
  /** Milliseconds of peak hold left. */
  hold: number;
}

export interface BallisticsOptions {
  /** Floor of the display; inputs below it (and -inf) clamp to it. */
  min: number;
  fallDbPerSec?: number;
  peakFallDbPerSec?: number;
  holdMs?: number;
  clipDb?: number;
}

export const DEFAULT_FALL_DB_PER_SEC = 24;
export const DEFAULT_PEAK_FALL_DB_PER_SEC = 12;
export const DEFAULT_HOLD_MS = 1500;

export function initialMeterState(min: number): MeterState {
  return { level: min, peak: min, hold: 0 };
}

export function stepMeter(
  s: MeterState,
  inputDb: number,
  dtMs: number,
  o: BallisticsOptions,
): { state: MeterState; clipped: boolean } {
  const fall = o.fallDbPerSec ?? DEFAULT_FALL_DB_PER_SEC;
  const peakFall = o.peakFallDbPerSec ?? DEFAULT_PEAK_FALL_DB_PER_SEC;
  const holdMs = o.holdMs ?? DEFAULT_HOLD_MS;
  const clipDb = o.clipDb ?? 0;
  const dt = Math.max(0, dtMs) / 1000;

  const input = Number.isNaN(inputDb) ? o.min : Math.max(inputDb, o.min);

  const level = input >= s.level ? input : Math.max(input, s.level - fall * dt);

  let peak = s.peak;
  let hold = s.hold;
  if (input >= peak) {
    peak = input;
    hold = holdMs;
  } else if (hold > 0) {
    hold = Math.max(0, hold - dtMs);
  } else {
    peak = Math.max(level, o.min, peak - peakFall * dt);
  }

  return { state: { level, peak, hold }, clipped: input >= clipDb };
}

/** True when nothing on the meter is still moving or showing (the draw loop can sleep). */
export function isSettled(s: MeterState, min: number): boolean {
  return s.level <= min + 0.01 && s.peak <= min + 0.01;
}
