// [EQCore] The Param EQ's Core-engine display rules, derived from band
// parameters only (eqCoreSpectral.js). The "engine trace" here is rebuilt the
// way XlethParametricEQ::writeResponseTraces builds it: the product of every
// enabled band's biquad (a sum in dB), Spectral bands at their plain gain.
import { describe, expect, it } from 'vitest'
import {
  CORE_MAX_DEPTH_DB, applyCoreSpectralToTrace, coreBandFillDb, coreRegionCutDb, coreSpectralStatus,
  displayResponseCurves, engineBiquad, responseFreqs,
} from '../eqCoreSpectral.js'
import { sampleBandResponseDb } from '../eqBandCurve.js'
import { RESPONSE_SIZE } from '../eqGeometry.js'

const SR = 48000
const band = (o) => ({ freq: 1000, gain: 0, q: 1, type: 0, enabled: true, mode: 0, channel: 'stereo', ...o })
const spec = (o) => band({ mode: 2, ...o })

function magDb(c, f) {
  const w = (2 * Math.PI * f) / SR
  const nRe = c.b0 + c.b1 * Math.cos(w) + c.b2 * Math.cos(2 * w)
  const nIm = -c.b1 * Math.sin(w) - c.b2 * Math.sin(2 * w)
  const dRe = 1 + c.a1 * Math.cos(w) + c.a2 * Math.cos(2 * w)
  const dIm = -c.a1 * Math.sin(w) - c.a2 * Math.sin(2 * w)
  return 10 * Math.log10((nRe * nRe + nIm * nIm) / (dRe * dRe + dIm * dIm))
}
function engineTrace(bands) {
  const freqs = responseFreqs(RESPONSE_SIZE)
  return Float32Array.from(freqs, (f) => bands
    .filter((b) => b.enabled)
    .reduce((acc, b) => acc + magDb(engineBiquad(b.type, b.freq, b.gain, b.q, SR), f), 0))
}
const idxOf = (hz) => {
  const freqs = responseFreqs(RESPONSE_SIZE)
  let best = 0
  freqs.forEach((f, i) => { if (Math.abs(Math.log(f / hz)) < Math.abs(Math.log(freqs[best] / hz))) best = i })
  return best
}
const minOf = (a) => a.reduce((m, v) => Math.min(m, v), Infinity)

describe('coreSpectralStatus', () => {
  it('dominant = deepest cut after the 24 dB cap, lowest index on a tie', () => {
    expect(coreSpectralStatus([spec({ gain: -10 }), spec({ gain: -20 })]).dominant).toBe(1)
    // -30 and -26 both cap at 24 dB: a tie, so the first one wins (the engine compares with a strict >).
    expect(coreSpectralStatus([spec({ gain: -26 }), spec({ gain: -30 })]).dominant).toBe(0)
    expect(coreSpectralStatus([spec({ gain: -30 }), spec({ gain: -26 })]).dominant).toBe(0)
  })

  it('only enabled Spectral cut bands can be dominant; none -> -1', () => {
    expect(coreSpectralStatus([band({ gain: -20 }), spec({ gain: -20, enabled: false }), spec({ gain: 6 })]).dominant).toBe(-1)
    expect(coreSpectralStatus([band({ gain: -20 }), spec({ gain: -3 })]).dominant).toBe(1)
    expect(coreSpectralStatus([]).dominant).toBe(-1)
  })

  it('upward = enabled Spectral bands with a positive gain (0 dB is inert, not upward)', () => {
    const s = coreSpectralStatus([spec({ gain: 6 }), spec({ gain: 0 }), spec({ gain: -6 }), band({ gain: 6 }), spec({ gain: 3, enabled: 0 })])
    expect(s.upward).toEqual([0])
    expect(s.cuts).toEqual([2])
  })

  it('conflict = enabled Spectral bands with different routings (upward ones count, off / Static ones do not)', () => {
    expect(coreSpectralStatus([spec({ gain: -6 }), spec({ gain: -6, channel: 'left' })]).conflict).toBe(true)
    expect(coreSpectralStatus([spec({ gain: -6 }), spec({ gain: 6, channel: 'mid' })]).conflict).toBe(true)
    expect(coreSpectralStatus([spec({ gain: -6, channel: 'side' }), spec({ gain: -3, channel: 'side' })]).conflict).toBe(false)
    expect(coreSpectralStatus([spec({ gain: -6 }), spec({ gain: -6, channel: 'left', enabled: false })]).conflict).toBe(false)
    expect(coreSpectralStatus([spec({ gain: -6 }), band({ gain: -6, channel: 'left' })]).conflict).toBe(false)
    // Engine numbering 0 = Stereo: a missing channel is Stereo.
    expect(coreSpectralStatus([spec({ gain: -6, channel: undefined }), spec({ gain: -6 })]).conflict).toBe(false)
  })
})

describe('engine biquads', () => {
  it("the bell matches the display fills' cookbook bell to float precision", () => {
    const freqs = [50, 200, 1000, 3000, 12000]
    const ref = sampleBandResponseDb({ type: 0, freq: 1000, gain: -9, q: 1.4 }, freqs, SR)
    const c = engineBiquad(0, 1000, -9, 1.4, SR)
    freqs.forEach((f, i) => expect(magDb(c, f)).toBeCloseTo(ref[i], 3))
  })
})

describe('Core curve rules', () => {
  it('Legacy: the engine curves are returned untouched (same object)', () => {
    const curves = { stereo: engineTrace([spec({ gain: -30 })]), left: new Float32Array(RESPONSE_SIZE) }
    expect(displayResponseCurves(curves, { spectralEngine: 0, bands: [spec({ gain: -30 })], sampleRate: SR })).toBe(curves)
  })

  it('Core without an enabled Spectral band: untouched', () => {
    const bands = [band({ gain: 6 }), spec({ gain: -12, enabled: false })]
    const curves = { stereo: engineTrace(bands) }
    expect(displayResponseCurves(curves, { spectralEngine: 1, bands, sampleRate: SR })).toBe(curves)
  })

  it('caps a Spectral cut at 24 dB (the engine drew 30)', () => {
    const bands = [spec({ gain: -30 })]
    const legacy = engineTrace(bands)
    const core = applyCoreSpectralToTrace(legacy, bands, SR)
    expect(minOf(legacy)).toBeLessThan(-29.8)
    expect(minOf(core)).toBeCloseTo(-CORE_MAX_DEPTH_DB, 1)
    expect(core[idxOf(1000)]).toBeCloseTo(-24, 1)
  })

  it('a cut within the cap draws as its own bell (the region reaches its gain at the centre)', () => {
    const bands = [spec({ gain: -12, q: 2 })]
    const legacy = engineTrace(bands)
    const core = applyCoreSpectralToTrace(legacy, bands, SR)
    expect(minOf(core)).toBeCloseTo(-12, 1)
    // Same bell shape: the region is the band's own bell normalised, so within the cap the two agree.
    for (const hz of [500, 900, 1100, 2000]) expect(core[idxOf(hz)]).toBeCloseTo(legacy[idxOf(hz)], 2)
  })

  it('an upward Spectral band draws nothing on Core; Static bands stay as the engine drew them', () => {
    const staticBell = band({ freq: 100, gain: 6 })
    const bands = [staticBell, spec({ gain: 12, freq: 3000 })]
    const core = applyCoreSpectralToTrace(engineTrace(bands), bands, SR)
    const staticOnly = engineTrace([staticBell])
    for (let i = 0; i < RESPONSE_SIZE; i += 7) expect(core[i]).toBeCloseTo(staticOnly[i], 3)
  })

  it('overlapping regions take the deeper cut (max), not the sum the engine trace has', () => {
    const a = spec({ freq: 1000, gain: -12, q: 1 })
    const b = spec({ freq: 1400, gain: -12, q: 1 })
    const legacy = engineTrace([a, b])
    const core = applyCoreSpectralToTrace(legacy, [a, b], SR)
    const freqs = responseFreqs(RESPONSE_SIZE)
    const k = idxOf(1180)
    const ra = coreRegionCutDb(a, freqs[k], SR)
    const rb = coreRegionCutDb(b, freqs[k], SR)
    expect(core[k]).toBeCloseTo(Math.min(ra, rb), 3)
    expect(legacy[k]).toBeLessThan(core[k] - 3) // the engine's product (sum in dB) is much deeper
    expect(minOf(core)).toBeGreaterThan(-12.01)
  })

  it('band type is ignored on Core (a Spectral High Shelf is a bell region)', () => {
    const shelf = spec({ type: 2, gain: -12, freq: 4000, q: 1 })
    const core = applyCoreSpectralToTrace(engineTrace([shelf]), [shelf], SR)
    expect(core[idxOf(4000)]).toBeCloseTo(-12, 1)
    expect(core[idxOf(16000)]).toBeGreaterThan(-3) // a shelf would hold -12 up here
  })

  it("the engine's -300 dB null floor is left alone", () => {
    const trace = new Float32Array(RESPONSE_SIZE).fill(-300)
    const core = applyCoreSpectralToTrace(trace, [spec({ gain: -12 })], SR)
    expect(core.every((v) => v === -300)).toBe(true)
  })
})

describe('coreBandFillDb', () => {
  it('a cut fills its capped region; an upward, off or Static band has no Core fill', () => {
    const freqs = responseFreqs(RESPONSE_SIZE)
    expect(minOf(coreBandFillDb(spec({ gain: -30 }), freqs, SR))).toBeCloseTo(-24, 1)
    expect(coreBandFillDb(spec({ gain: 6 }), freqs, SR)).toBeNull()
    expect(coreBandFillDb(spec({ gain: -6, enabled: false }), freqs, SR)).toBeNull()
    expect(coreBandFillDb(band({ gain: -6 }), freqs, SR)).toBeNull()
  })
})
