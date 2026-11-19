// Pure geometry and parameter maths for the Smart Balance display. No DOM, no
// engine: everything here is unit-tested.
//
// The engine splits the input with a balanced LR4 tree at 150 Hz / 800 Hz / 4 kHz
// into four bands (SmartBalanceEffect.h), and the display lays them out on a log
// frequency axis, 20 Hz to 20 kHz, against a -60..+6 dB level axis.

export const BANDS = Object.freeze([
  { key: 'sub', label: 'Sub', range: '20–150 Hz' },
  { key: 'lomid', label: 'Low-mid', range: '150–800 Hz' },
  { key: 'upmid', label: 'Upper-mid', range: '0.8–4 kHz' },
  { key: 'air', label: 'Air', range: '4–20 kHz' },
])

export const CROSSOVER_FREQS = Object.freeze([150, 800, 4000])
export const FREQ_MIN = 20
export const FREQ_MAX = 20000
export const DB_MIN = -60
export const DB_MAX = 6
export const DB_RANGE = DB_MAX - DB_MIN

// The Target / Offset range of the engine (target_*): -40..+12 dB.
export const TARGET_MIN = -40
export const TARGET_MAX = 12

/** Param ids of band `i`. */
export const bandIds = (i) => {
  const k = BANDS[i].key
  return { target: `target_${k}`, amount: `bandamt_${k}`, floor: `floor_${k}` }
}

const LOG_MIN = Math.log10(FREQ_MIN)
const LOG_RANGE = Math.log10(FREQ_MAX) - LOG_MIN

/** x in [0, width] of a frequency on the log axis. */
export function freqToX(freq, width) {
  return ((Math.log10(freq) - LOG_MIN) / LOG_RANGE) * width
}

/** The four band columns across `width`: [{ x1, x2 }]. */
export function bandColumns(width) {
  const edges = [FREQ_MIN, ...CROSSOVER_FREQS, FREQ_MAX]
  return BANDS.map((_, i) => ({ x1: freqToX(edges[i], width), x2: freqToX(edges[i + 1], width) }))
}

/** Index of the band whose column holds x, or -1. */
export function bandAtX(x, width) {
  const cols = bandColumns(width)
  for (let i = 0; i < cols.length; i += 1) {
    if (x >= cols[i].x1 && x <= cols[i].x2) return i
  }
  return -1
}

/** y of a level inside a plot spanning [top, top + height]: +6 dB on top, -60 dB at the bottom. */
export function dbToY(db, top, height) {
  return top + (1 - (db - DB_MIN) / DB_RANGE) * height
}

/** The inverse of dbToY. */
export function yToDb(y, top, height) {
  return DB_MIN + (1 - (y - top) / height) * DB_RANGE
}

/** A level reading (engine reports -100 and below for silence) that can be placed on the axis. */
export const hasLevel = (db) => Number.isFinite(db) && db > DB_MIN

/**
 * Where a band's target line sits, in dB on the display. Relative mode (mode 0)
 * measures it from the band's balanced reference (smartBalanceGetDebug().ref[b]:
 * where that band would sit in a balanced mix at the material's own level), so it
 * needs a live reading; with none it returns null rather than a made-up place.
 * Absolute mode (mode 1) is the literal level.
 */
export function targetVisualDb(mode, refDb, targetParam) {
  if (Math.round(mode) !== 0) return targetParam
  return hasLevel(refDb) ? refDb + targetParam : null
}

/**
 * The parameter a dragged line stands for: an offset from the band's balanced
 * reference in Relative mode, the level itself in Absolute. Clamped to the
 * engine's range. Returns null when Relative has no live reading to measure from.
 */
export function targetParamFromVisual(mode, refDb, visualDb) {
  let param = visualDb
  if (Math.round(mode) === 0) {
    if (!hasLevel(refDb)) return null
    param = visualDb - refDb
  }
  return Math.max(TARGET_MIN, Math.min(TARGET_MAX, param))
}
