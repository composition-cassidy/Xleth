// Low / High Pass slopes: the UI mirror of engine/src/dsp/EqSlopeDesign.h, and
// how a Spectral ("Reso") region follows a slope band on the Core display.
// Reference numbers are from the engine's own design (slope_check, 48 kHz).
import { describe, expect, it } from 'vitest'
import {
  BAND_SLOPES, cascadeMagSq, clampSlope, firstOrderSection, isCascadeSlope, isCutBandType, slopeSections,
} from '../eqSlope.js'
import {
  applyCoreSpectralToTrace, coreRegionCutDb, responseFreqs,
} from '../eqCoreSpectral.js'
import { RESPONSE_SIZE } from '../eqGeometry.js'

const SR = 48000
const db = (sections, f) => 10 * Math.log10(Math.max(cascadeMagSq(sections, f, SR), 1e-300))
const spec = (o) => ({ freq: 1000, gain: -24, q: 0.707, type: 4, slope: 1, enabled: true, mode: 2, channel: 'stereo', ...o })

describe('slope table', () => {
  it('has the nine slopes, 12 dB/oct as the default index', () => {
    expect(BAND_SLOPES).toHaveLength(9)
    expect(BAND_SLOPES[0]).toBe('6 dB/oct')
    expect(BAND_SLOPES[1]).toBe('12 dB/oct')
    expect(BAND_SLOPES[8]).toBe('Brickwall')
  })

  it('only Low Pass and High Pass read the slope; slopes 2+ are cascades', () => {
    expect([0, 1, 2, 3, 4, 5, 6].map(isCutBandType)).toEqual([false, false, false, true, true, false, false])
    expect([0, 1, 2, 8].map(isCascadeSlope)).toEqual([false, false, true, true])
    expect(clampSlope(99)).toBe(8)
    expect(clampSlope(-3)).toBe(0)
    expect(clampSlope('x')).toBe(1)
  })
})

describe('slopeSections (engine EqSlopeDesign mirror)', () => {
  // [slope, dB one octave out, dB at 1.3x (HP: 1/1.3), section count]
  const LP = [[2, -18.24, 2], [3, -24.25, 2], [4, -36.35, 3], [5, -48.46, 4], [6, -72.70, 6], [7, -96.93, 8]]
  const HP = [[2, -18.16, 2], [3, -24.14, 2], [4, -36.18, 3], [5, -48.24, 4], [6, -72.36, 6], [7, -96.48, 8]]

  it.each(LP)('Low Pass slope %i: -3 dB at the corner, %f dB an octave up', (slope, oct, n) => {
    const s = slopeSections(false, 1000, 0.7071067811865476, slope, SR)
    expect(s).toHaveLength(n)
    expect(db(s, 1000)).toBeCloseTo(-3.0103, 2)
    expect(db(s, 2000)).toBeCloseTo(oct, 1)
    expect(db(s, 100)).toBeCloseTo(0, 3)
  })

  it.each(HP)('High Pass slope %i: -3 dB at the corner, %f dB an octave down', (slope, oct, n) => {
    const s = slopeSections(true, 1000, 0.7071067811865476, slope, SR)
    expect(s).toHaveLength(n)
    expect(db(s, 1000)).toBeCloseTo(-3.0103, 2)
    expect(db(s, 500)).toBeCloseTo(oct, 1)
    expect(db(s, 8000)).toBeCloseTo(0, 3)
  })

  it('Brickwall: -3 dB at the corner, ~-94 dB by 1.3x, flat pass band', () => {
    const lp = slopeSections(false, 1000, 0.7071067811865476, 8, SR)
    const hp = slopeSections(true, 1000, 0.7071067811865476, 8, SR)
    expect(lp).toHaveLength(8)
    expect(db(lp, 1000)).toBeCloseTo(-3.0103, 1)
    expect(db(lp, 1300)).toBeCloseTo(-94.34, 0)
    expect(db(hp, 1000 / 1.3)).toBeCloseTo(-93.74, 0)
    expect(db(lp, 100)).toBeCloseTo(0, 3)
  })

  it('Q is the resonance at the corner (default Q is the flat Butterworth)', () => {
    const peak = (q) => {
      const s = slopeSections(false, 1000, q, 3, SR)
      let m = -Infinity
      for (let f = 100; f < 3000; f *= 1.01) m = Math.max(m, db(s, f))
      return m
    }
    expect(peak(0.7071067811865476)).toBeCloseTo(0, 1)
    expect(peak(4)).toBeGreaterThan(10)
    expect(peak(0.3)).toBeLessThan(0.01)
  })

  it('6 dB/oct is a first-order section: -3 dB at the corner, ~-7 dB an octave out', () => {
    const lp = [firstOrderSection(false, 1000, SR)]
    const hp = [firstOrderSection(true, 1000, SR)]
    expect(db(lp, 1000)).toBeCloseTo(-3.01, 1)
    expect(db(lp, 2000)).toBeCloseTo(-7.02, 1)
    expect(db(hp, 500)).toBeCloseTo(-7.0, 1)
  })
})

describe('Reso region of a Low / High Pass band', () => {
  it('is the slope itself: stop band attenuation over the depth, capped at the depth', () => {
    const band = spec({ slope: 3, gain: -24 })
    // 24 dB/oct HP at 1 kHz: -24 dB at 500 Hz is exactly full depth.
    expect(coreRegionCutDb(band, 500, SR)).toBeCloseTo(-24, 0)
    expect(coreRegionCutDb(band, 100, SR)).toBeCloseTo(-24, 3)
    expect(coreRegionCutDb(band, 4000, SR)).toBeCloseTo(0, 2)
    // Corner: -3 dB of -24 -> weight 0.125 of the depth.
    expect(coreRegionCutDb(band, 1000, SR)).toBeCloseTo(-3.01, 1)
  })

  it('a steeper slope is a sharper edge on the same corner', () => {
    const at = (slope) => coreRegionCutDb(spec({ slope }), 700, SR)
    expect(at(8)).toBeLessThanOrEqual(at(5))
    expect(at(5)).toBeLessThanOrEqual(at(3))
    expect(at(3)).toBeLessThan(at(1))
    expect(at(8)).toBeCloseTo(-24, 2)
  })

  it('a Low Pass band cuts above its corner', () => {
    const band = spec({ type: 3, slope: 4 })
    expect(coreRegionCutDb(band, 4000, SR)).toBeCloseTo(-24, 1)
    expect(coreRegionCutDb(band, 200, SR)).toBeCloseTo(0, 2)
  })

  it('a Bell band is unchanged by the slope', () => {
    const bell = { ...spec({ type: 0, gain: -12, q: 2 }) }
    expect(coreRegionCutDb({ ...bell, slope: 8 }, 1000, SR)).toBe(coreRegionCutDb({ ...bell, slope: 1 }, 1000, SR))
  })

  it('the Core display swaps the plain slope curve for the region', () => {
    const freqs = responseFreqs(RESPONSE_SIZE)
    // What the engine draws for the Spectral High Pass: its plain 24 dB/oct curve.
    const hp = slopeSections(true, 1000, 0.707, 3, SR)
    const trace = Float32Array.from(freqs, (f) => db(hp, f))
    const bands = [spec({ slope: 3, q: 0.707 })]
    const out = applyCoreSpectralToTrace(trace, bands, SR)
    const at = (hz) => freqs.reduce((b, f, i) => (Math.abs(Math.log(f / hz)) < Math.abs(Math.log(freqs[b] / hz)) ? i : b), 0)
    // Pass band flat, deep stop band stops at the 24 dB depth cap.
    expect(out[at(6000)]).toBeCloseTo(0, 1)
    expect(out[at(100)]).toBeCloseTo(-24, 1)
    // The edge lines up with the slope curve until the depth is reached.
    expect(out[at(800)]).toBeCloseTo(trace[at(800)], 0)
  })
})
