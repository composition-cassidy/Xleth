// How a Lens value is printed and typed, one place for the whole panel
// (value, thin space, unit; true minus; one decimal rule per unit).

import { THIN_SPACE, formatValue, logScale, parseValue } from '../ui-kit'
import { ZOOM_MAX, ZOOM_MIN } from './lensRoamModel.js'

export const ZOOM_SCALE = logScale(ZOOM_MIN, ZOOM_MAX)

export const zoomFmt = {
  format: (v) => `${formatValue(v, 'dB', { unitless: true, decimals: 2 })}${THIN_SPACE}×`,
  parse: (t) => parseValue(String(t).replace(/[×x]/gi, ''), 'dB'),
}

export const pctFmt = {
  format: (v) => formatValue(v * 100, '%', { decimals: 1 }),
  parse: (t) => { const n = parseValue(t, '%'); return n === null ? null : n / 100 },
}

export const degFmt = {
  format: (v) => `${formatValue(v, 'dB', { unitless: true, decimals: 1 })}${THIN_SPACE}°`,
  parse: (t) => parseValue(String(t).replace(/°/g, ''), 'dB'),
}

/** A layer's offset: always signed, so "+0.0 %" reads as an offset and "50.0 %" as a position. */
export const signedPctFmt = {
  format: (v) => formatValue(v * 100, '%', { decimals: 1, signed: true }),
  parse: pctFmt.parse,
}

export const signedDegFmt = {
  format: (v) => `${formatValue(v, 'dB', { unitless: true, decimals: 1, signed: true })}${THIN_SPACE}°`,
  parse: degFmt.parse,
}

/** A layer's zoom: the multiplier it applies. */
export const mulFmt = {
  format: (v) => `×${THIN_SPACE}${formatValue(v, 'dB', { unitless: true, decimals: 2 })}`,
  parse: zoomFmt.parse,
}

export const ticksFmt = {
  format: (v) => `${Math.round(v)}${THIN_SPACE}ticks`,
  parse: (t) => { const n = Number.parseFloat(String(t).replace(/ticks?/i, '').replace(/[\s ]/g, '').replace(/−/g, '-')); return Number.isFinite(n) ? n : null },
}

/** Format + NumberBox settings for one channel. `absolute`: a position (clip keys) rather than a layer offset. */
export function channelNumberProps(channel, absolute) {
  if (channel === 'zoom') {
    return { format: absolute ? zoomFmt.format : mulFmt.format, parse: zoomFmt.parse, scale: ZOOM_SCALE, defaultValue: 1 }
  }
  if (channel === 'rotationDeg') {
    return {
      format: absolute ? degFmt.format : signedDegFmt.format, parse: degFmt.parse,
      min: -360, max: 360, pxPerRange: 1440, defaultValue: 0,
    }
  }
  return absolute
    ? { format: pctFmt.format, parse: pctFmt.parse, min: 0, max: 1, defaultValue: 0.5 }
    : { format: signedPctFmt.format, parse: pctFmt.parse, min: -1, max: 1, defaultValue: 0 }
}

/** A note length as a musical value when it is one ("1/16"), else ''. 960 ticks = a quarter note. */
export function noteValueLabel(ticks) {
  const whole = 3840
  for (const d of [1, 2, 4, 8, 16, 32, 64]) {
    if (Math.abs(ticks - whole / d) < 0.5) return d === 1 ? '1 bar' : `1/${d}`
  }
  return ''
}
