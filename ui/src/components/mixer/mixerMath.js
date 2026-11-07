// Value conversions between what the engine stores (linear gain, -1..1 pan,
// 0..2 stereo width) and what the kit controls show. Pure; no store, no IPC.

import { formatValue, parseValue } from '../../ui-kit'

export const FADER_FLOOR_DB = -96

/** Linear gain to dB. Silence is -Infinity, which the kit dB taper treats as the floor. */
export function gainToDb(gain) {
  if (!Number.isFinite(gain) || gain <= 0) return -Infinity
  const db = 20 * Math.log10(gain)
  return db <= FADER_FLOOR_DB ? -Infinity : db
}

/** dB to linear gain. At or below the floor (including -Infinity) the track is silent. */
export function dbToGain(db) {
  if (!Number.isFinite(db) || db <= FADER_FLOOR_DB) return 0
  return 10 ** (db / 20)
}

/** Pan reads "C", "L 30", "R 100": the convention every mixer prints. */
export function formatPan(pan) {
  const pct = Math.round(Math.abs(pan) * 100)
  if (pct === 0) return 'C'
  return `${pan < 0 ? 'L' : 'R'} ${pct}`
}

/** Accepts "C", "L30", "r 20", or a bare percent (-30 = 30 left). Null when it is not a pan. */
export function parsePan(text) {
  if (typeof text !== 'string') return null
  const s = text.trim().toLowerCase()
  if (s === '') return null
  if (s === 'c' || s === 'centre' || s === 'center') return 0
  const m = /^([lr])\s*(\d+(?:\.\d+)?)$/.exec(s)
  if (m) {
    const v = Math.min(100, Number(m[2])) / 100
    return m[1] === 'l' ? -v : v
  }
  const n = Number(s.replace('−', '-'))
  return Number.isFinite(n) ? Math.max(-1, Math.min(1, n / 100)) : null
}

/** Stereo width is stored 0..2 and printed as a percent (1 = 100 %). */
export function formatWidth(spread) {
  return formatValue(spread * 100, '%')
}

export function parseWidth(text) {
  const n = parseValue(text, '%')
  return n == null ? null : Math.max(0, Math.min(2, n / 100))
}

/** What the inserts button says. */
export function insertLabel(chain, fxMode) {
  if (fxMode === 'graph') return 'FX graph'
  return chain.length === 0 ? 'No FX' : `FX ${chain.length}`
}
