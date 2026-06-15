import { describe, expect, it } from 'vitest'
import { PPQ } from '../../constants/timeline.js'
import { getClipRegionWaveformStartSec, getSnapGridIntervalBeats } from './timelineDrawing.js'

describe('getSnapGridIntervalBeats', () => {
  it('maps snap labels to beat intervals', () => {
    expect(getSnapGridIntervalBeats('1/64')).toBeCloseTo(1 / 16)
    expect(getSnapGridIntervalBeats('1/16')).toBeCloseTo(1 / 4)
    expect(getSnapGridIntervalBeats('Beat')).toBe(1)
    expect(getSnapGridIntervalBeats('Half')).toBe(2)
    expect(getSnapGridIntervalBeats('Bar')).toBe(4)
  })

  it('falls back to 1/16 for invalid labels', () => {
    expect(getSnapGridIntervalBeats('nonsense')).toBeCloseTo(1 / 4)
  })
})

describe('getClipRegionWaveformStartSec', () => {
  it('uses only region offset for whole-region clips', () => {
    expect(getClipRegionWaveformStartSec(
      { regionOffsetTicks: PPQ, syllableIndex: -1 },
      { syllables: [{ startTime: 0.5 }] },
      120,
    )).toBeCloseTo(0.5)
  })

  it('adds syllable start time for syllable clips', () => {
    expect(getClipRegionWaveformStartSec(
      { regionOffsetTicks: PPQ / 2, syllableIndex: 1 },
      { syllables: [{ startTime: 0.1 }, { startTime: 1.25 }] },
      120,
    )).toBeCloseTo(1.5)
  })

  it('falls back to region offset when the syllable index is invalid', () => {
    expect(getClipRegionWaveformStartSec(
      { regionOffsetTicks: PPQ / 2, syllableIndex: 9 },
      { syllables: [{ startTime: 1.25 }] },
      120,
    )).toBeCloseTo(0.25)
  })
})
