import { describe, expect, it } from 'vitest'
import {
  formatTime, formatSamples, formatDurationShort, formatSamplesShort,
  formatRange, niceTimeStep, formatTick, formatClock, parseTime,
} from '../sandboxFormat.js'
import { opSampleRange, resolveOpRange } from '../sandboxOpRange.js'

describe('formatTime', () => {
  it('reads sub-minute times as plain seconds', () => {
    expect(formatTime(1.5)).toBe('1.500')
    expect(formatTime(0)).toBe('0.000')
  })

  it('switches to m:ss past a minute, zero-padding the seconds', () => {
    expect(formatTime(61.25)).toBe('1:01.250')
    expect(formatTime(605)).toBe('10:05.000')
  })

  it('says nothing rather than guessing for a missing value', () => {
    expect(formatTime(NaN)).toBe('—')
    expect(formatTime(Infinity)).toBe('—')
  })
})

describe('formatSamples', () => {
  it('converts against the buffer rate', () => {
    expect(formatSamples(24000, 48000)).toBe('0.500')
  })

  // Without a rate a sample index cannot be turned into a time. Printing a
  // number derived from a guessed 48000 would be confidently wrong.
  it('refuses to convert with no sample rate', () => {
    expect(formatSamples(24000, 0)).toBe('—')
    expect(formatSamples(24000, undefined)).toBe('—')
  })
})

describe('short forms', () => {
  it('uses ms below a second and seconds above it', () => {
    expect(formatDurationShort(0.84)).toBe('840ms')
    expect(formatDurationShort(1.239)).toBe('1.24s')
  })

  it('goes to m:ss past a minute', () => {
    expect(formatDurationShort(123)).toBe('2:03.0')
  })

  it('converts samples the same way', () => {
    expect(formatSamplesShort(48000, 48000)).toBe('1.00s')
    expect(formatSamplesShort(480, 48000)).toBe('10ms')
  })
})

describe('formatRange', () => {
  it('states both endpoints and the span', () => {
    expect(formatRange(0, 48000, 48000)).toBe('0ms → 1.00s (1.00s)')
  })

  // The op rail falls back to raw indices rather than '—' when a layer has not
  // published a buffer yet: an index is at least an ordering.
  it('falls back to sample indices with no rate', () => {
    expect(formatRange(100, 200, null)).toBe('100–200')
  })
})

describe('ruler ticks', () => {
  it('picks the next nice step at or above the minimum', () => {
    expect(niceTimeStep(0.03)).toBe(0.05)
    expect(niceTimeStep(1.2)).toBe(2)
    expect(niceTimeStep(0.00003)).toBe(0.0001)
  })

  it('caps at the top of the ladder rather than returning undefined', () => {
    expect(niceTimeStep(99999)).toBe(600)
  })

  it('shows only the digits the step can resolve', () => {
    expect(formatTick(1.5, 0.5)).toBe('1.5')
    expect(formatTick(2, 1)).toBe('2')
    expect(formatTick(0.104, 0.002)).toBe('0.104')
    expect(formatTick(65, 1)).toBe('1:05')
  })
})

// The transport clock keeps one shape whatever the time, so the digits do not
// shift sideways while the playhead runs.
describe('formatClock', () => {
  it('always prints minutes, seconds and milliseconds', () => {
    expect(formatClock(0)).toBe('0:00.000')
    expect(formatClock(0.625)).toBe('0:00.625')
    expect(formatClock(62.5)).toBe('1:02.500')
  })

  it('prints a placeholder of the same shape with no time to show', () => {
    expect(formatClock(null)).toBe('-:--.---')
    expect(formatClock(Number.NaN)).toBe('-:--.---')
  })
})

// The selection boxes accept what they print, plus the units people type.
describe('parseTime', () => {
  it('reads a bare number as seconds', () => {
    expect(parseTime('0.625')).toBe(0.625)
    expect(parseTime('2')).toBe(2)
    expect(parseTime('.5')).toBe(0.5)
  })

  it('reads the formats the boxes themselves print', () => {
    expect(parseTime('0.625 s')).toBe(0.625)
    expect(parseTime('1:02.500')).toBe(62.5)
    expect(parseTime(formatTime(75.25))).toBe(75.25)
  })

  it('reads milliseconds and a decimal comma', () => {
    expect(parseTime('625ms')).toBe(0.625)
    expect(parseTime('250 ms')).toBe(0.25)
    expect(parseTime('0,5')).toBe(0.5)
  })

  it('returns null for anything that is not a time', () => {
    expect(parseTime('')).toBeNull()
    expect(parseTime('soon')).toBeNull()
    expect(parseTime('1:2:3')).toBeNull()
  })
})

describe('opSampleRange', () => {
  // The engine fades [startSample, startSample + lengthSamples): a fade can sit
  // anywhere. Reading it as "against the edge" highlighted a mid-layer fade at
  // the wrong end of the waveform.
  it('locates a fade where it actually is, not against an edge', () => {
    expect(opSampleRange({ type: 'fade', params: { fadeIn: false, startSample: 3000, lengthSamples: 1000 } }))
      .toEqual({ startSample: 3000, endSample: 4000 })
    expect(opSampleRange({ type: 'fade', params: { fadeIn: true, startSample: 3000, lengthSamples: 1000 } }))
      .toEqual({ startSample: 3000, endSample: 4000 })
  })

  it('locates a gain scoped to a range, and nothing for a whole-layer gain', () => {
    expect(opSampleRange({ type: 'gain', params: { startSample: 100, endSample: 900, gainDb: 3 } }))
      .toEqual({ startSample: 100, endSample: 900 })
    expect(opSampleRange({ type: 'gain', params: { startSample: 0, endSample: -1, gainDb: 3 } })).toBeNull()
  })

  it('locates range-carrying ops', () => {
    expect(opSampleRange({ type: 'cut', params: { startSample: 10, endSample: 90 } }))
      .toEqual({ startSample: 10, endSample: 90 })
    expect(opSampleRange({ type: 'paste', params: { atSample: 100, clipboardLengthSamples: 50 } }))
      .toEqual({ startSample: 100, endSample: 150 })
    expect(opSampleRange({ type: 'crossfade', params: { atSample: 100, lengthSamples: 40 } }))
      .toEqual({ startSample: 80, endSample: 120 })
  })

  // A highlight over the whole waveform communicates nothing, so an op with no
  // locatable range must return null rather than the full span.
  it('returns null for whole-buffer ops', () => {
    expect(opSampleRange({ type: 'pitch', params: { cents: 100 } })).toBeNull()
    expect(opSampleRange({ type: 'autotune', params: { scale: 0 } })).toBeNull()
    expect(opSampleRange({ type: 'gain', params: { gainDb: 3 } })).toBeNull()
  })

  it('returns null for a degenerate or unpopulated range', () => {
    expect(opSampleRange({ type: 'cut', params: { startSample: 50, endSample: 50 } })).toBeNull()
    expect(opSampleRange({ type: 'spectralPaint', params: { dabs: [] } })).toBeNull()
    expect(opSampleRange({ type: 'gainEnvelope', params: { points: [{ samplePos: 1, db: 0 }] } })).toBeNull()
  })

  it('spans every dab of a spectral paint mask', () => {
    expect(opSampleRange({
      type: 'spectralPaint',
      params: { dabs: [
        { centerSample: 500, halfWidthSamples: 100 },
        { centerSample: 900, halfWidthSamples: 50 },
      ] },
    })).toEqual({ startSample: 400, endSample: 950 })
  })

  it('resolves a fade-out against the buffer length', () => {
    const range = opSampleRange({ type: 'fade', params: { fadeIn: false, lengthSamples: 1000 } })
    expect(resolveOpRange(range, 48000)).toEqual({ startSample: 47000, endSample: 48000 })
    // Fade-in is already absolute and passes through untouched.
    const inRange = opSampleRange({ type: 'fade', params: { fadeIn: true, lengthSamples: 1000 } })
    expect(resolveOpRange(inRange, 48000)).toEqual({ startSample: 0, endSample: 1000 })
  })
})
