import { describe, it, expect, beforeEach } from 'vitest'
import { currentRegime, peekRegime, resetRegime } from '../waveformRegime.js'

// Boundaries from waveformRenderer.js: envelope > 200 > trace > 8 > waveform
// > 0.5 > sample, with a 1.3x hysteresis band.
describe('waveformRegime', () => {
  beforeEach(resetRegime)

  it('starts in envelope', () => {
    expect(peekRegime()).toBe('envelope')
  })

  it('classifies each band from a cold start', () => {
    expect(currentRegime(1000)).toBe('envelope')
    resetRegime(); expect(currentRegime(50)).toBe('trace')
    resetRegime(); expect(currentRegime(4)).toBe('waveform')
    resetRegime(); expect(currentRegime(0.2)).toBe('sample')
  })

  it('is idempotent inside a band — repeated calls do not drift', () => {
    expect(currentRegime(50)).toBe('trace')
    for (let i = 0; i < 20; i++) expect(currentRegime(50)).toBe('trace')
  })

  it('does not flip on a single step across a boundary', () => {
    // 210 is above the raw 200 threshold but inside trace's hysteresis band
    // (200 * 1.3 = 260), so a zoom that nudges past 200 must stay put.
    expect(currentRegime(50)).toBe('trace')
    expect(currentRegime(210)).toBe('trace')
    expect(currentRegime(255)).toBe('trace')
    expect(currentRegime(275)).toBe('envelope')  // past 260, commit
  })

  it('does not flap when spp dithers around a boundary', () => {
    // This is the real failure mode: a zoom gesture parked near a boundary
    // used to flip regime frame to frame, which wipes and refetches the whole
    // hi-res peak cache each time.
    currentRegime(50)
    const seen = new Set()
    for (const spp of [195, 205, 198, 210, 201, 199, 207, 202]) {
      seen.add(currentRegime(spp))
    }
    expect([...seen]).toEqual(['trace'])
  })

  it('still commits when the zoom genuinely leaves the band', () => {
    currentRegime(50)
    expect(currentRegime(400)).toBe('envelope')
    expect(currentRegime(50)).toBe('trace')   // 50 < 200/1.3, commit back
  })

  it('resetRegime clears hysteresis state', () => {
    currentRegime(0.2)
    expect(peekRegime()).toBe('sample')
    resetRegime()
    expect(peekRegime()).toBe('envelope')
  })
})
