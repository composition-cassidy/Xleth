import { describe, expect, it } from 'vitest'
import { TRANSPOSE_MIN_SEMITONES, TRANSPOSE_MAX_SEMITONES, DEFAULT_TRANSPOSE_SEMITONES, clampTransposeSemitones } from './transpose.js'

describe('clampTransposeSemitones', () => {
  it('passes values already inside [-24, 24] through unchanged', () => {
    expect(clampTransposeSemitones(0)).toBe(0)
    expect(clampTransposeSemitones(12)).toBe(12)
    expect(clampTransposeSemitones(-12)).toBe(-12)
    expect(clampTransposeSemitones(TRANSPOSE_MIN_SEMITONES)).toBe(TRANSPOSE_MIN_SEMITONES)
    expect(clampTransposeSemitones(TRANSPOSE_MAX_SEMITONES)).toBe(TRANSPOSE_MAX_SEMITONES)
  })

  it('clamps out-of-range values to the nearest bound', () => {
    expect(clampTransposeSemitones(25)).toBe(TRANSPOSE_MAX_SEMITONES)
    expect(clampTransposeSemitones(-25)).toBe(TRANSPOSE_MIN_SEMITONES)
    expect(clampTransposeSemitones(1000)).toBe(TRANSPOSE_MAX_SEMITONES)
    expect(clampTransposeSemitones(-1000)).toBe(TRANSPOSE_MIN_SEMITONES)
  })

  it('rounds fractional input and falls back to the default for non-finite input', () => {
    expect(clampTransposeSemitones(3.6)).toBe(4)
    expect(clampTransposeSemitones(3.4)).toBe(3)
    expect(clampTransposeSemitones(NaN)).toBe(DEFAULT_TRANSPOSE_SEMITONES)
    expect(clampTransposeSemitones(undefined)).toBe(DEFAULT_TRANSPOSE_SEMITONES)
  })
})
