import { describe, expect, it } from 'vitest'
import { dbToGain, formatPan, formatWidth, gainToDb, insertLabel, parsePan, parseWidth } from '../mixerMath.js'

describe('mixerMath', () => {
  it('round-trips gain and dB, and treats the floor as silence', () => {
    expect(gainToDb(1)).toBeCloseTo(0, 9)
    expect(dbToGain(gainToDb(0.25))).toBeCloseTo(0.25, 9)
    expect(gainToDb(0)).toBe(-Infinity)
    expect(dbToGain(-Infinity)).toBe(0)
    expect(dbToGain(-96)).toBe(0)
    expect(dbToGain(12)).toBeCloseTo(3.981, 3)
    expect(gainToDb(1e-9)).toBe(-Infinity) // below -96 dB
  })

  it('prints pan as C / L n / R n with a thin space', () => {
    expect(formatPan(0)).toBe('C')
    expect(formatPan(-0.3)).toBe('L 30')
    expect(formatPan(1)).toBe('R 100')
    expect(formatPan(0.004)).toBe('C')
  })

  it('parses typed pan values', () => {
    expect(parsePan('c')).toBe(0)
    expect(parsePan('L30')).toBeCloseTo(-0.3, 9)
    expect(parsePan('r 100')).toBe(1)
    expect(parsePan('-50')).toBeCloseTo(-0.5, 9)
    expect(parsePan('−25')).toBeCloseTo(-0.25, 9)
    expect(parsePan('300')).toBe(1)
    expect(parsePan('hello')).toBeNull()
    expect(parsePan('')).toBeNull()
  })

  it('prints and parses width as a percent', () => {
    expect(formatWidth(1)).toBe('100 %')
    expect(formatWidth(0)).toBe('0 %')
    expect(parseWidth('150')).toBeCloseTo(1.5, 9)
    expect(parseWidth('250')).toBe(2)
    expect(parseWidth('x')).toBeNull()
  })

  it('labels the inserts button', () => {
    expect(insertLabel([], 'chain')).toBe('No FX')
    expect(insertLabel([{}, {}], 'chain')).toBe('FX 2')
    expect(insertLabel([{}], 'graph')).toBe('FX graph')
  })
})
