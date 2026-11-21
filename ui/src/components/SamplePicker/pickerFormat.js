// Time text for the sample editor. One format everywhere in the sheet:
//
//   position   m:ss.mmm            0:01.204   (milliseconds: edges are placed to the ms)
//   length     seconds + unit      0.184 s    (number, thin space, unit: ui-kit/format.ts)
//
// Pure, no DOM.

import { THIN_SPACE } from '../../ui-kit/format'

const EM_DASH = '—'

/** A position in the source as m:ss.mmm. null / NaN is an em dash (nothing set). */
export function formatTimecode(seconds, decimals = 3) {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) return EM_DASH
  const unit = 10 ** decimals
  const total = Math.max(0, Math.round(seconds * unit))
  const whole = Math.floor(total / unit)
  const m = Math.floor(whole / 60)
  const s = whole % 60
  const base = `${m}:${String(s).padStart(2, '0')}`
  if (decimals <= 0) return base
  return `${base}.${String(total % unit).padStart(decimals, '0')}`
}

/**
 * Type-in parser for a position: "1:02.5", "62.5", "62.5 s", "1:02:03.25".
 * Returns seconds, or null for "not a time".
 */
export function parseTimecode(text) {
  const t = String(text ?? '').trim().toLowerCase().replace(/\s*s$/, '').replace(',', '.')
  if (!t) return null
  const parts = t.split(':')
  if (parts.length > 3) return null
  let seconds = 0
  for (const part of parts) {
    if (part.trim() === '' || !/^\d*\.?\d*$/.test(part.trim())) return null
    const n = Number(part)
    if (!Number.isFinite(n)) return null
    seconds = seconds * 60 + n
  }
  return seconds
}

/** A length: 0.184 s below ten seconds, 12.48 s above, m:ss.mmm from a minute up. */
export function formatSpan(seconds) {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) return EM_DASH
  const abs = Math.abs(seconds)
  if (abs >= 60) return formatTimecode(abs)
  return `${abs.toFixed(abs < 10 ? 3 : 2)}${THIN_SPACE}s`
}

/** Frame index at a time, for sources that have a frame rate. */
export function frameAt(seconds, fps) {
  if (!Number.isFinite(seconds) || !(fps > 0)) return null
  return Math.max(0, Math.floor(seconds * fps + 1e-6))
}

/** "30 fps", "29.97 fps": whole rates print whole. */
export function formatFps(fps) {
  if (!(fps > 0)) return ''
  const rounded = Math.round(fps * 100) / 100
  return `${Number.isInteger(rounded) ? rounded : rounded.toFixed(2)}${THIN_SPACE}fps`
}
