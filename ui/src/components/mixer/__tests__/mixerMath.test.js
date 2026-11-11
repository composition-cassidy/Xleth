import { describe, expect, it } from 'vitest'
import { formatValue } from '../../../ui-kit'
import { GAIN_FORMAT, dbToGain, formatPan, formatWidth, gainToDb, insertLabel, insertRows, parsePan, parseWidth } from '../mixerMath.js'

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

  it('summarises the inserts in words, for the accessible name of the insert list', () => {
    expect(insertLabel([], 'chain')).toBe('No FX')
    expect(insertLabel([{}, {}], 'chain')).toBe('FX 2')
    expect(insertLabel([{}], 'graph')).toBe('FX graph')
  })

  it('prints positive gain with an explicit plus, negative with a true minus, zero bare', () => {
    // Number, thin space (U+2009), unit; a true minus (U+2212).
    expect(formatValue(3, 'dB', GAIN_FORMAT)).toBe('+3.0\u2009dB')
    expect(formatValue(7.1, 'dB', GAIN_FORMAT)).toBe('+7.1\u2009dB')
    expect(formatValue(-12.9, 'dB', GAIN_FORMAT)).toBe('\u221212.9\u2009dB')
    expect(formatValue(0, 'dB', GAIN_FORMAT)).toBe('0.0\u2009dB')
    expect(formatValue(-Infinity, 'dB', GAIN_FORMAT)).toBe('\u2212inf\u2009dB')
  })

  describe('insertRows', () => {
    const fx = (pluginId, extra) => ({ pluginId, ...extra })
    const name = (e) => e.pluginId.toUpperCase()
    const texts = (rows) => rows.map((r) => (r ? r.text : null))

    it('names each insert in chain order and leaves the rest as empty wells', () => {
      const rows = insertRows([fx('eq'), fx('comp')], 'chain', 5, name)
      expect(texts(rows)).toEqual(['EQ', 'COMP', null, null, null])
      expect(rows.slice(0, 2).map((r) => r.index)).toEqual([0, 1])
    })

    it('an empty chain is five wells', () => {
      expect(insertRows([], 'chain', 5, name)).toEqual([null, null, null, null, null])
    })

    it('exactly as many inserts as rows are all named', () => {
      const chain = ['a', 'b', 'c', 'd', 'e'].map((p) => fx(p))
      expect(texts(insertRows(chain, 'chain', 5, name))).toEqual(['A', 'B', 'C', 'D', 'E'])
    })

    it('a longer chain keeps the first rows - 1 names and ends in "+N more", which opens the first hidden device', () => {
      const chain = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((p) => fx(p))
      const rows = insertRows(chain, 'chain', 5, name)
      expect(texts(rows)).toEqual(['A', 'B', 'C', 'D', '+3 more'])
      expect(rows[4]).toMatchObject({ index: 4, more: true })
      expect(texts(insertRows(chain, 'chain', 3, name))).toEqual(['A', 'B', '+5 more'])
    })

    it('marks a bypassed insert', () => {
      const rows = insertRows([fx('eq'), fx('comp', { bypassed: true })], 'chain', 5, name)
      expect(rows.map((r) => r && r.off)).toEqual([false, true, null, null, null])
    })

    it('a track on an FX graph says so in one row, which opens the chain, not a device', () => {
      const rows = insertRows([fx('eq')], 'graph', 5, name)
      expect(texts(rows)).toEqual(['FX graph', null, null, null, null])
      expect(rows[0].index).toBeNull()
    })
  })
})
