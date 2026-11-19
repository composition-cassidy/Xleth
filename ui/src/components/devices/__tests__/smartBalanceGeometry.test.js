import { describe, expect, it } from 'vitest'
import {
  BANDS, bandAtX, bandColumns, bandIds, dbToY, freqToX, hasLevel,
  targetParamFromVisual, targetVisualDb, yToDb,
} from '../smartBalanceGeometry.js'

describe('Smart Balance geometry', () => {
  it('lays four bands across a log axis, edge to edge, in the engine\'s order', () => {
    const cols = bandColumns(600)
    expect(cols).toHaveLength(4)
    expect(cols[0].x1).toBeCloseTo(0, 6)
    expect(cols[3].x2).toBeCloseTo(600, 6)
    for (let i = 0; i < 3; i += 1) expect(cols[i].x2).toBeCloseTo(cols[i + 1].x1, 6)
    expect(BANDS.map((b) => b.key)).toEqual(['sub', 'lomid', 'upmid', 'air'])
  })

  it('puts the crossovers at 150 Hz, 800 Hz and 4 kHz', () => {
    const cols = bandColumns(1000)
    expect(cols[0].x2).toBeCloseTo(freqToX(150, 1000), 6)
    expect(cols[1].x2).toBeCloseTo(freqToX(800, 1000), 6)
    expect(cols[2].x2).toBeCloseTo(freqToX(4000, 1000), 6)
  })

  it('finds the band under an x', () => {
    const cols = bandColumns(600)
    expect(bandAtX((cols[0].x1 + cols[0].x2) / 2, 600)).toBe(0)
    expect(bandAtX((cols[2].x1 + cols[2].x2) / 2, 600)).toBe(2)
    expect(bandAtX(-5, 600)).toBe(-1)
    expect(bandAtX(700, 600)).toBe(-1)
  })

  it('maps +6 dB to the top of the plot and -60 dB to the bottom, and back', () => {
    expect(dbToY(6, 30, 200)).toBeCloseTo(30, 6)
    expect(dbToY(-60, 30, 200)).toBeCloseTo(230, 6)
    expect(yToDb(dbToY(-18, 30, 200), 30, 200)).toBeCloseTo(-18, 6)
  })

  it('names each band\'s three parameters like the engine does', () => {
    expect(bandIds(1)).toEqual({ target: 'target_lomid', amount: 'bandamt_lomid', floor: 'floor_lomid' })
    expect(bandIds(3)).toEqual({ target: 'target_air', amount: 'bandamt_air', floor: 'floor_air' })
  })

  it('treats the engine\'s silence readings as no level', () => {
    expect(hasLevel(-100)).toBe(false)
    expect(hasLevel(-60)).toBe(false)
    expect(hasLevel(-59)).toBe(true)
    expect(hasLevel(Number.NaN)).toBe(false)
  })

  describe('target line', () => {
    it('Absolute: the line is the literal level and a drag stores the level', () => {
      expect(targetVisualDb(1, -100, -18)).toBe(-18)
      expect(targetParamFromVisual(1, -100, -18)).toBe(-18)
    })

    it('Relative: the line is the band\'s balanced reference plus the offset, and a drag stores the offset', () => {
      expect(targetVisualDb(0, -20, 3)).toBe(-17)
      expect(targetParamFromVisual(0, -20, -17)).toBe(3)
    })

    it('Relative with no live reading has no honest place to draw or drag', () => {
      expect(targetVisualDb(0, -100, 3)).toBeNull()
      expect(targetParamFromVisual(0, -100, -17)).toBeNull()
    })

    it('clamps a dragged target to the engine\'s -40..+12 dB', () => {
      expect(targetParamFromVisual(1, -100, 5.5)).toBe(5.5)
      expect(targetParamFromVisual(1, -100, 30)).toBe(12)
      expect(targetParamFromVisual(1, -100, -55)).toBe(-40)
      expect(targetParamFromVisual(0, -20, 40)).toBe(12)
    })
  })
})
