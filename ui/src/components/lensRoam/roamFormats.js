import { THIN_SPACE, formatValue, logScale, parseValue } from '../../ui-kit'
import { SCALE_MAX, SCALE_MIN } from '../../lensRoam/lensRoamModel.js'

// How a Roam value is printed and typed (value, thin space, unit; true minus), one
// place for the Roam panel, its key inspector and the lane.

export const SCALE_SCALE = logScale(SCALE_MIN, SCALE_MAX)
export const scaleFmt = {
  format: (v) => `${formatValue(v, 'dB', { unitless: true, decimals: 2 })}${THIN_SPACE}×`,
  parse: (t) => parseValue(String(t).replace(/[×x]/gi, ''), 'dB'),
}
// A crop edge is stored as a fraction of the cell (0..0.99) and shown as a percentage.
export const cropFmt = {
  format: (v) => `${formatValue(v * 100, 'dB', { unitless: true, decimals: 1 })}${THIN_SPACE}%`,
  parse: (t) => {
    const n = parseValue(String(t).replace(/%/g, ''), 'dB')
    return Number.isFinite(n) ? n / 100 : n
  },
}
export const degFmt = {
  format: (v) => `${formatValue(v, 'dB', { unitless: true, decimals: 1 })}${THIN_SPACE}°`,
  parse: (t) => parseValue(String(t).replace(/°/g, ''), 'dB'),
}
export const cellFmt = {
  format: (v) => `${formatValue(v, 'dB', { unitless: true, decimals: 2 })}${THIN_SPACE}cells`,
  parse: (t) => parseValue(String(t).replace(/cells?/gi, ''), 'dB'),
}
export const pxFmt = {
  format: (v) => `${formatValue(Math.round(v), 'dB', { unitless: true, decimals: 0 })}${THIN_SPACE}px`,
  parse: (t) => parseValue(String(t).replace(/px/gi, ''), 'dB'),
}
