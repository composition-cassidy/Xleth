import { describe, expect, it } from 'vitest'
import { PPQ } from '../../constants/timeline.js'
import { drawGhostClips, getClipRegionWaveformStartSec, getSnapGridIntervalBeats } from './timelineDrawing.js'

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

describe('drawGhostClips', () => {
  const makeCtx = () => {
    const calls = { fillRect: [], fillText: [] }
    const ctx = new Proxy({}, {
      get: (_t, prop) => {
        if (prop === 'fillRect') return (...a) => calls.fillRect.push(a)
        if (prop === 'fillText') return (...a) => calls.fillText.push(a)
        if (prop === 'measureText') return (text) => ({ width: String(text).length * 8 })
        return () => {}
      },
      set: () => true,
    })
    return { ctx, calls }
  }
  const palette = { trackPalette: ['#336699', '#996633'], accent: '#00ff00', warning: '#ffaa00', ink: '#ffffff', inkDark: '#000000', bg: '#141414' }
  const tickToPixel = (tick) => tick / 10

  it('puts every ghost on the same row, whatever its syllable, and labels it with the syllable number', () => {
    const { ctx, calls } = makeCtx()
    drawGhostClips(ctx, [
      { syllableIndex: 0, startTick: 0, lengthTicks: 240 },
      { syllableIndex: 2, startTick: 240, lengthTicks: 240 },
      { syllableIndex: 1, startTick: 480, lengthTicks: 240 },
    ], [], tickToPixel, 200, palette)
    expect(new Set(calls.fillRect.map((r) => r[1])).size).toBe(1)
    expect(calls.fillText.map((t) => t[0])).toEqual(['1', '3', '2'])
  })

  it('skips a label that does not fit before the next ghost instead of overprinting', () => {
    const { ctx, calls } = makeCtx()
    drawGhostClips(ctx, [
      { syllableIndex: 0, startTick: 0, lengthTicks: 120 },
      { syllableIndex: 1, startTick: 20, lengthTicks: 120 },
    ], [], tickToPixel, 0, palette)
    expect(calls.fillText.map((t) => t[0])).toEqual(['2'])
  })
})
