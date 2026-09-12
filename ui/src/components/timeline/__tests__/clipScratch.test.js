import { describe, expect, it } from 'vitest'
import {
  SCRATCH_BAKE_SEGMENTS,
  SCRATCH_PRESETS,
  SCRATCH_POINT_ADAPTER,
  bakeScratchCurve,
  evaluateScratchRate,
  generateBabyScratchCurve,
  inferBabyScratchSettings,
  makeScratchSampler,
  normalizeScratchCurve,
  scratchPresetKeyForScratch,
  scratchSegmentCanBend,
  scratchTensionFromPointer,
  scratchTensionHandle,
  scratchTimeDomain,
  unbakeScratchCurve,
} from '../clipScratch.js'
import { makeGeometry } from '../../common/breakpointCurveMath.js'

// These tests pin the AUTHOR <-> ENGINE boundary that lets the Scratch graph
// show tension at all.
//
// engine/src/model/ClipModulationEvaluator.cpp evaluateScratch() plays every
// segment as a straight line (lerpRate + a trapezoid integral) and never reads
// ScratchPoint::curve. So a tensioned segment is BAKED into real breakpoints on
// commit; the invariant that matters is that baking and unbaking are inverses,
// and that a curve with no tension survives the round trip unchanged so an
// untouched preset keeps its name.

const author = (time, rateMultiplier, tension = 0) => ({ time, rateMultiplier, tension })

describe('scratch bake / unbake', () => {
  it('is the identity (modulo curve:0) when nothing is tensioned', () => {
    const pts = [author(0, 1), author(0.5, -1), author(1, 1)]
    expect(bakeScratchCurve(pts)).toEqual([
      { time: 0, rateMultiplier: 1, curve: 0 },
      { time: 0.5, rateMultiplier: -1, curve: 0 },
      { time: 1, rateMultiplier: 1, curve: 0 },
    ])
  })

  it('leaves every stock preset byte-identical, so presets keep their names', () => {
    for (const preset of SCRATCH_PRESETS) {
      const round = bakeScratchCurve(unbakeScratchCurve(preset.curve))
      expect(scratchPresetKeyForScratch({ timeMode: preset.timeMode, curve: round }))
        .toBe(preset.key)
    }
  })

  it('emits exactly SCRATCH_BAKE_SEGMENTS points for a bent segment', () => {
    const baked = bakeScratchCurve([author(0, 1, 0.6), author(1, -1)])
    // one bent segment (12) + the trailing anchor
    expect(baked).toHaveLength(SCRATCH_BAKE_SEGMENTS + 1)
    expect(baked[0].curve).toBeCloseTo(0.6, 5)
    expect(baked.slice(1).every(p => p.curve === 0)).toBe(true)
    // Times stay strictly increasing, so the bridge's stable_sort is a no-op.
    for (let i = 1; i < baked.length; i++) {
      expect(baked[i].time).toBeGreaterThan(baked[i - 1].time)
    }
  })

  it('round-trips tension through bake -> unbake', () => {
    const pts = [author(0, 1, 0.7), author(0.4, -1, -0.35), author(1, 1)]
    const recovered = unbakeScratchCurve(bakeScratchCurve(pts))
    expect(recovered).toHaveLength(3)
    expect(recovered[0].tension).toBeCloseTo(0.7, 4)
    expect(recovered[1].tension).toBeCloseTo(-0.35, 4)
    expect(recovered[2].tension).toBe(0)
    expect(recovered.map(p => p.time)).toEqual([0, 0.4, 1])
  })

  it('survives the float32 narrowing the bridge applies to every point', () => {
    const narrow = (c) => c.map(p => ({
      time: Math.fround(p.time),
      rateMultiplier: Math.fround(p.rateMultiplier),
      curve: Math.fround(p.curve),
    }))
    const pts = [author(0, 1, 0.55), author(0.37, -0.8), author(1, 1)]
    const recovered = unbakeScratchCurve(narrow(bakeScratchCurve(pts)))
    expect(recovered).toHaveLength(3)
    expect(recovered[0].tension).toBeCloseTo(0.55, 3)
  })

  it('reports tension 0 for a stored curve value that does not front a bake', () => {
    // A hand-edited project could carry a tension the engine plays straight.
    // The graph is only allowed to draw what the engine plays, so it reads 0.
    const recovered = unbakeScratchCurve([
      { time: 0, rateMultiplier: 1, curve: 0.9 },
      { time: 1, rateMultiplier: 0, curve: 0 },
    ])
    expect(recovered.map(p => p.tension)).toEqual([0, 0])
  })

  it('refuses to bend a segment with no rate change (nothing to ease)', () => {
    expect(scratchSegmentCanBend(author(0, 1), author(1, 1))).toBe(false)
    expect(scratchSegmentCanBend(author(0, 1), author(1, -1))).toBe(true)
    // ...and a tension on such a segment bakes to a plain straight line.
    expect(bakeScratchCurve([author(0, 1, 0.8), author(1, 1)])).toHaveLength(2)
  })

  it('normalizes and sorts the way the bridge does', () => {
    const out = normalizeScratchCurve([
      { time: 1, rateMultiplier: 9, curve: 0 },      // rate clamped to +2
      { time: 0, rateMultiplier: 1 },                 // missing curve -> 0
      { time: 0.5, rateMultiplier: Number.NaN },      // dropped
      null,
    ])
    expect(out).toEqual([
      { time: 0, rateMultiplier: 1, curve: 0 },
      { time: 1, rateMultiplier: 2, curve: 0 },
    ])
  })
})

describe('scratch rate evaluation mirrors evaluateScratch()', () => {
  const A = { read: (p) => ({ t: p.time, v: p.rateMultiplier }) }

  it('plays unity BEFORE a curve whose first point is after zero', () => {
    // engine: currentRate = (t0 > 0.0) ? 1.0 : pts.front().rateMultiplier;
    const pts = [{ time: 0.2, rateMultiplier: 0 }, { time: 1, rateMultiplier: 0 }]
    expect(evaluateScratchRate(pts, A, 0.1)).toBe(1)
    // ...but exactly AT the first point it is that point's own rate.
    expect(evaluateScratchRate(pts, A, 0.2)).toBe(0)
  })

  it('uses the first point rate when the curve starts at or before zero', () => {
    const pts = [{ time: 0, rateMultiplier: -1 }, { time: 1, rateMultiplier: -1 }]
    expect(evaluateScratchRate(pts, A, -0.5)).toBe(-1)
  })

  it('holds the last point rate past the end of the curve', () => {
    const pts = [{ time: 0, rateMultiplier: 1 }, { time: 0.45, rateMultiplier: 0 }]
    expect(evaluateScratchRate(pts, A, 3)).toBe(0)
  })

  it('interpolates linearly between points', () => {
    const pts = [{ time: 0, rateMultiplier: 1 }, { time: 1, rateMultiplier: -1 }]
    expect(evaluateScratchRate(pts, A, 0.5)).toBeCloseTo(0, 10)
    expect(evaluateScratchRate(pts, A, 0.25)).toBeCloseTo(0.5, 10)
  })

  it('draws the baked bend, not the straight chord', () => {
    const straight = makeScratchSampler([author(0, 1), author(1, -1)])
    const bent = makeScratchSampler([author(0, 1, 0.8), author(1, -1)])
    expect(straight(null, SCRATCH_POINT_ADAPTER, 0.5)).toBeCloseTo(0, 6)
    // Positive tension holds the starting rate longer, so mid-segment sits high.
    expect(bent(null, SCRATCH_POINT_ADAPTER, 0.5)).toBeGreaterThan(0.3)
  })
})

describe('tension handle geometry', () => {
  const geo = makeGeometry({
    width: 504, height: 260,
    pad: { left: 30, right: 10, top: 10, bottom: 18 },
    tMin: 0, tMax: 1, vMin: -2, vMax: 2,
  })

  it('puts a zero-tension handle at the chord midpoint', () => {
    const h = scratchTensionHandle(author(0, 1), author(1, -1), 0)
    expect(h).toEqual({ t: 0.5, v: 0 })
  })

  it('recovers the tension a handle was drawn at', () => {
    const a = author(0, 1)
    const b = author(1, -1)
    for (const tau of [-1, -0.4, 0, 0.25, 0.9]) {
      const h = scratchTensionHandle(a, b, tau)
      const back = scratchTensionFromPointer(a, b, geo, geo.xOf(h.t), geo.yOf(h.v))
      expect(back).toBeCloseTo(tau, 6)
    }
  })

  it('clamps to -1..+1 rather than running away', () => {
    const a = author(0, 1)
    const b = author(1, -1)
    expect(scratchTensionFromPointer(a, b, geo, 9999, -9999)).toBe(1)
    expect(scratchTensionFromPointer(a, b, geo, -9999, 9999)).toBe(-1)
  })
})

describe('time-mode axis domain', () => {
  const pts = [author(0, 1), author(1, 1)]

  it('is 0..1 for clip percent, clip length for beats and seconds', () => {
    expect(scratchTimeDomain('clipPercent', { clipBeats: 8, clipSeconds: 3.43 }, pts).tMax).toBe(1)
    expect(scratchTimeDomain('beats', { clipBeats: 8, clipSeconds: 3.43 }, pts).tMax).toBe(8)
    expect(scratchTimeDomain('clipSeconds', { clipBeats: 8, clipSeconds: 3.43 }, pts).tMax).toBe(3.43)
  })

  it('falls back to a usable span when the clip length is unknown', () => {
    expect(scratchTimeDomain('beats', {}, pts).tMax).toBe(8)
    expect(scratchTimeDomain('clipSeconds', {}, pts).tMax).toBe(4)
  })

  it('stretches so a point beyond the natural end stays reachable', () => {
    // Switching mode reinterprets stored numbers rather than rescaling them, so
    // points CAN land past the natural end. None of them may become undraggable.
    const far = [author(0, 1), author(12, 1)]
    expect(scratchTimeDomain('beats', { clipBeats: 8 }, far).tMax).toBeGreaterThan(12)
  })
})

describe('relocated preset vocabulary still behaves', () => {
  it('generates and re-infers a baby-scratch curve', () => {
    const curve = generateBabyScratchCurve(3, 0.5)
    expect(inferBabyScratchSettings({ timeMode: 'beats', curve }))
      .toMatchObject({ count: 3, lengthBeats: 0.5 })
  })

  it('names every stock preset, and calls anything else Custom', () => {
    for (const preset of SCRATCH_PRESETS) {
      expect(scratchPresetKeyForScratch({ timeMode: preset.timeMode, curve: preset.curve }))
        .toBe(preset.key)
    }
    expect(scratchPresetKeyForScratch({
      timeMode: 'clipPercent',
      curve: [{ time: 0, rateMultiplier: 1, curve: 0 }, { time: 0.5, rateMultiplier: -2, curve: 0 }],
    })).toBe('custom')
  })
})
