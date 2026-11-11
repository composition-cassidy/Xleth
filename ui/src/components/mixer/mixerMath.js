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

/** The inserts in words, for an accessible name: "No FX", "FX 3", "FX graph". */
export function insertLabel(chain, fxMode) {
  if (fxMode === 'graph') return 'FX graph'
  return chain.length === 0 ? 'No FX' : `FX ${chain.length}`
}

/** Volume fields and faders print an explicit plus on positive gain (+3.0 dB beside −12.9 dB). */
export const GAIN_FORMAT = Object.freeze({ signed: true })

/**
 * What a strip's insert list shows in `rows` rows (ui/DESIGN.md 10).
 *
 * Each entry is `{ text, index, off }`: `index` is the chain position the row opens in the
 * Devices tab, or null for a row that only opens the chain. A chain longer than the list
 * keeps its first `rows - 1` names and ends with "+N more", which opens the first hidden
 * device. A track whose effects live in its FX Graph says so in one row. Rows past the end
 * are null: empty wells.
 */
export function insertRows(chain, fxMode, rows, nameOf) {
  const out = Array.from({ length: rows }, () => null)
  if (rows <= 0) return out
  if (fxMode === 'graph') {
    out[0] = { text: 'FX graph', index: null, off: false }
    return out
  }
  const named = (effect, index) => ({ text: nameOf(effect), index, off: !!effect?.bypassed })
  if (chain.length <= rows) {
    chain.forEach((effect, i) => { out[i] = named(effect, i) })
    return out
  }
  for (let i = 0; i < rows - 1; i += 1) out[i] = named(chain[i], i)
  out[rows - 1] = { text: `+${chain.length - (rows - 1)} more`, index: rows - 1, off: false, more: true }
  return out
}
