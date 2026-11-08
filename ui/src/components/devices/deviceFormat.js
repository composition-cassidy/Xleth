import { THIN_SPACE, formatValue, parseValue } from '../../ui-kit'

/**
 * A number with a unit the kit does not know ("st", "ct", "×"): thin space, true
 * minus, optional "+". Returns { format, parse } for a Knob / NumberBox.
 */
export const suffixFormat = (suffix, decimals = 1, signed = false) => ({
  format: (v) => `${formatValue(v, 'dB', { unitless: true, decimals, signed })}${THIN_SPACE}${suffix}`,
  parse: (text) => parseValue(String(text).split(suffix).join(''), 'dB'),
})

// Formatting for the few values the kit's units do not cover (a plain amount, a
// 0..1 fraction shown as a percentage, a phase in degrees). Every one of them is
// still `formatValue`, so the thin space, the true minus and the rounding rule are
// the kit's.

/** A unitless number with fixed decimals ("5.0", "0.71", "+0.50"). */
export const plainFormat = (decimals = 1, signed = false) => (v) => (
  formatValue(v, 'dB', { unitless: true, decimals, signed })
)

/** A 0..1 engine value shown and typed as a percentage. */
export const fractionPercent = {
  format: (v) => formatValue(v * 100, '%'),
  parse: (text) => {
    const n = parseValue(text, '%')
    return n === null ? null : n / 100
  },
}

/** A 0..1 phase shown as degrees ("90°"). */
export const phaseDegrees = {
  format: (v) => `${formatValue(v * 360, 'dB', { unitless: true, decimals: 0 })}°`,
  parse: (text) => {
    const n = parseValue(String(text).replace(/°/g, ''), 'dB')
    return n === null ? null : n / 360
  },
}
