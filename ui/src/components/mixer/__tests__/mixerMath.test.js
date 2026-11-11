import { describe, expect, it } from 'vitest'
import { formatValue } from '../../../ui-kit'
import {
  FADER_MIN_H, GAIN_FORMAT, INSERT_ROW_H, STRIP_FIXED_H, dbToGain, formatPan, formatWidth, gainToDb, insertLabel, insertRows,
  insertRowsFor, longestInsertList, parsePan, parseWidth,
} from '../mixerMath.js'

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

  // The insert area is one height for the whole mixer (every fader the same length), and only
  // as tall as the longest chain needs.
  describe('insertRowsFor', () => {
    const chains = { 1: [{}, {}], 2: [{}, {}, {}, {}], 3: [], master: [{}] }

    it('finds the longest list among the strips; an FX-graph track counts as one row', () => {
      expect(longestInsertList(chains, {}, ['1', '2', '3'])).toBe(4)
      expect(longestInsertList(chains, {}, ['1', '3'])).toBe(2)
      expect(longestInsertList(chains, { 2: 'graph' }, ['2', '3'])).toBe(1)
      expect(longestInsertList(chains, {}, ['9'])).toBe(0)
      expect(longestInsertList({}, {}, [])).toBe(0)
    })

    it('is the longest chain, never less than one row, so short chains leave the faders the space', () => {
      const tall = 400
      expect(insertRowsFor(0, tall)).toEqual({ rows: 1, short: false })
      expect(insertRowsFor(2, tall)).toEqual({ rows: 2, short: false })
      expect(insertRowsFor(5, tall)).toEqual({ rows: 5, short: false })
    })

    it('grows past five for a longer chain while a 64px fader still fits, up to ten', () => {
      // 360px for strips (a 409px dock in the app): 172 fixed + 64 fader leaves 124px = 7 rows.
      expect(insertRowsFor(6, 360).rows).toBe(6)
      expect(insertRowsFor(9, 360).rows).toBe(7)
      expect(insertRowsFor(9, 600).rows).toBe(9)
      expect(insertRowsFor(30, 2000).rows).toBe(10)
      for (const h of [300, 360, 420, 600]) {
        for (const longest of [1, 4, 8, 12]) {
          const { rows, short } = insertRowsFor(longest, h)
          if (!short) expect(STRIP_FIXED_H + rows * INSERT_ROW_H + FADER_MIN_H).toBeLessThanOrEqual(h)
        }
      }
    })

    it('on a short dock it shows at most three rows over the shorter fader floor', () => {
      // 271px for strips (a 320px dock at 1366x768).
      expect(insertRowsFor(6, 271)).toEqual({ rows: 3, short: true })
      expect(insertRowsFor(2, 271)).toEqual({ rows: 2, short: false })
      expect(insertRowsFor(1, 271)).toEqual({ rows: 1, short: false })
      // Far too short for anything: still one row.
      expect(insertRowsFor(6, 200).rows).toBe(1)
    })

    it('before the panel is measured it shows the chain up to five rows', () => {
      expect(insertRowsFor(3, 0)).toEqual({ rows: 3, short: false })
      expect(insertRowsFor(9, 0)).toEqual({ rows: 5, short: false })
    })
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
