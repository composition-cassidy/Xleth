import { describe, expect, it } from 'vitest'
import {
  TV_ADAPTER,
  TIME_VALUE_ADAPTER,
  makeGeometry,
  hitTestPoints,
  movePoint,
  insertPoint,
  removePoint,
  evaluateLinearBreakpoints,
} from '../breakpointCurveMath.js'
import {
  evaluateBuiltinVibratoShape,
  normalizeCustomShape,
  defaultCustomShape,
} from '../../timeline/clipVibrato.js'

const P = (time, value) => ({ time, value })

describe('makeGeometry', () => {
  const geo = makeGeometry({ width: 100, height: 60, pad: { left: 10, right: 10, top: 5, bottom: 5 } })

  it('maps the curve domain onto the padded plot box', () => {
    expect(geo.xOf(0)).toBe(10)
    expect(geo.xOf(1)).toBe(90)
    expect(geo.xOf(0.5)).toBe(50)
    expect(geo.yOf(1)).toBe(5)      // vMax at the top
    expect(geo.yOf(-1)).toBe(55)    // vMin at the bottom
    expect(geo.yOf(0)).toBe(30)
  })

  it('round-trips pixels back to curve space', () => {
    expect(geo.tOf(geo.xOf(0.37))).toBeCloseTo(0.37, 10)
    expect(geo.vOf(geo.yOf(-0.42))).toBeCloseTo(-0.42, 10)
  })

  it('clamps out-of-box pixels into the domain', () => {
    expect(geo.tOf(-500)).toBe(0)
    expect(geo.tOf(9999)).toBe(1)
    expect(geo.vOf(-500)).toBe(1)
    expect(geo.vOf(9999)).toBe(-1)
  })
})

describe('hitTestPoints', () => {
  const geo = makeGeometry({ width: 100, height: 100, pad: { left: 0, right: 0, top: 0, bottom: 0 } })
  const pts = [P(0, 0), P(0.5, 1), P(1, 0)]

  it('finds the point under the cursor', () => {
    expect(hitTestPoints(pts, TIME_VALUE_ADAPTER, geo, geo.xOf(0.5), geo.yOf(1), 11)).toBe(1)
  })

  it('returns -1 on empty canvas', () => {
    expect(hitTestPoints(pts, TIME_VALUE_ADAPTER, geo, 50, 50, 5)).toBe(-1)
  })

  it('returns the NEAREST candidate when handles overlap', () => {
    const crowded = [P(0.50, 0), P(0.52, 0)]
    const near = hitTestPoints(crowded, TIME_VALUE_ADAPTER, geo, geo.xOf(0.52), geo.yOf(0), 11)
    expect(near).toBe(1)
  })

  it('tolerates a non-array', () => {
    expect(hitTestPoints(undefined, TIME_VALUE_ADAPTER, geo, 0, 0)).toBe(-1)
  })
})

describe('movePoint', () => {
  const pts = [P(0, 0), P(0.4, 0.5), P(0.8, -0.5), P(1, 0)]

  it('clamps a dragged point between its neighbours so indices stay stable', () => {
    const pushedLeft = movePoint(pts, TIME_VALUE_ADAPTER, 2, -5, 0.2)
    expect(pushedLeft[2].time).toBeGreaterThan(pts[1].time)
    expect(pushedLeft[2].time).toBeLessThan(pts[3].time)

    const pushedRight = movePoint(pts, TIME_VALUE_ADAPTER, 1, 5, 0.2)
    expect(pushedRight[1].time).toBeLessThan(pts[2].time)
    // Ordering is preserved, so the caller's selected index is still valid.
    const times = pushedRight.map(p => p.time)
    expect([...times].sort((a, b) => a - b)).toEqual(times)
  })

  it('leaves other points untouched and does not mutate the input', () => {
    const next = movePoint(pts, TIME_VALUE_ADAPTER, 1, 0.45, 0.75)
    expect(next[0]).toBe(pts[0])
    expect(next[2]).toBe(pts[2])
    expect(pts[1]).toEqual(P(0.4, 0.5))
    expect(next[1]).toEqual({ time: 0.45, value: 0.75 })
  })

  it('pins the endpoints when lockEndpoints is set', () => {
    const first = movePoint(pts, TIME_VALUE_ADAPTER, 0, 0.3, 0.9, { lockEndpoints: true })
    expect(first[0].time).toBe(0)
    expect(first[0].value).toBe(0.9)      // value still moves freely
    const last = movePoint(pts, TIME_VALUE_ADAPTER, 3, 0.3, -0.9, { lockEndpoints: true })
    expect(last[3].time).toBe(1)
  })

  it('drives the { t, v } adapter equally well', () => {
    const tv = [{ t: 0, v: 0 }, { t: 1, v: 0 }]
    expect(movePoint(tv, TV_ADAPTER, 1, 0.7, 0.3)[1]).toEqual({ t: 0.7, v: 0.3 })
  })

  it('ignores an out-of-range index', () => {
    expect(movePoint(pts, TIME_VALUE_ADAPTER, 99, 0.5, 0)).toBe(pts)
  })
})

describe('insertPoint', () => {
  it('inserts in sorted position and reports the new index', () => {
    const pts = [P(0, 0), P(1, 0)]
    const { points, index } = insertPoint(pts, TIME_VALUE_ADAPTER, 0.5, 0.8)
    expect(index).toBe(1)
    expect(points.map(p => p.time)).toEqual([0, 0.5, 1])
    expect(points[1].value).toBe(0.8)
    expect(pts).toHaveLength(2)        // input untouched
  })

  it('refuses past maxPoints', () => {
    const pts = [P(0, 0), P(1, 0)]
    const { points, index } = insertPoint(pts, TIME_VALUE_ADAPTER, 0.5, 0, { maxPoints: 2 })
    expect(index).toBe(-1)
    expect(points).toBe(pts)
  })
})

describe('removePoint', () => {
  it('removes the point', () => {
    const pts = [P(0, 0), P(0.5, 1), P(1, 0)]
    expect(removePoint(pts, 1)).toEqual([P(0, 0), P(1, 0)])
  })

  it('refuses below the minimum, signalling with null', () => {
    expect(removePoint([P(0, 0), P(1, 0)], 0)).toBeNull()
    expect(removePoint([P(0, 0), P(1, 0)], 0, { minPoints: 2 })).toBeNull()
  })

  it('refuses an out-of-range index', () => {
    expect(removePoint([P(0, 0), P(0.5, 0), P(1, 0)], 7)).toBeNull()
  })
})

// The editor must draw exactly what the audio thread plays. These cases mirror
// engine/src/model/ClipModulationEvaluator.cpp evaluateCustomShape().
describe('evaluateLinearBreakpoints (engine parity)', () => {
  const ev = (pts, p) => evaluateLinearBreakpoints(pts, TIME_VALUE_ADAPTER, p)

  it('empty => 0, single point => that value', () => {
    expect(ev([], 0.5)).toBe(0)
    expect(ev([P(0.3, 0.7)], 0.9)).toBe(0.7)
  })

  it('clamps to the terminal breakpoints outside the authored range', () => {
    const pts = [P(0.25, -0.5), P(0.75, 0.5)]
    expect(ev(pts, 0)).toBe(-0.5)
    expect(ev(pts, 0.25)).toBe(-0.5)
    expect(ev(pts, 0.75)).toBe(0.5)
    expect(ev(pts, 1)).toBe(0.5)
  })

  it('interpolates linearly between breakpoints', () => {
    const pts = [P(0, 0), P(1, 1)]
    expect(ev(pts, 0.25)).toBeCloseTo(0.25, 10)
    expect(ev(pts, 0.5)).toBeCloseTo(0.5, 10)

    const seg = [P(0, -1), P(0.5, 1), P(1, -1)]
    expect(ev(seg, 0.25)).toBeCloseTo(0, 10)
    expect(ev(seg, 0.75)).toBeCloseTo(0, 10)
  })

  it('resolves a zero-width span to the left value', () => {
    const pts = [P(0, 0), P(0.5, 0.5), P(0.5, -0.5), P(1, 0)]
    expect(ev(pts, 0.5)).toBe(0.5)
  })

  it('the seeded default shape traces one sine-like cycle', () => {
    const seed = defaultCustomShape()
    expect(seed.length).toBeGreaterThanOrEqual(2)
    expect(ev(seed, 0)).toBe(0)
    expect(ev(seed, 0.25)).toBe(1)
    expect(ev(seed, 0.5)).toBe(0)
    expect(ev(seed, 0.75)).toBe(-1)
    expect(ev(seed, 1)).toBe(0)
  })
})

// Ports of engine evaluateBuiltinShape(). NOTE the Triangle: the engine peaks at
// t=0.25, which is NOT the phase-shifted triangle some sketches used.
describe('evaluateBuiltinVibratoShape (engine parity)', () => {
  it('sine', () => {
    expect(evaluateBuiltinVibratoShape('sine', 0)).toBeCloseTo(0, 10)
    expect(evaluateBuiltinVibratoShape('sine', 0.25)).toBeCloseTo(1, 10)
    expect(evaluateBuiltinVibratoShape('sine', 0.75)).toBeCloseTo(-1, 10)
  })

  it('triangle peaks at 0.25 and troughs at 0.75', () => {
    expect(evaluateBuiltinVibratoShape('triangle', 0)).toBeCloseTo(0, 10)
    expect(evaluateBuiltinVibratoShape('triangle', 0.25)).toBeCloseTo(1, 10)
    expect(evaluateBuiltinVibratoShape('triangle', 0.5)).toBeCloseTo(0, 10)
    expect(evaluateBuiltinVibratoShape('triangle', 0.75)).toBeCloseTo(-1, 10)
    expect(evaluateBuiltinVibratoShape('triangle', 1)).toBeCloseTo(0, 10)
  })

  it('saws and square', () => {
    expect(evaluateBuiltinVibratoShape('sawUp', 0)).toBe(-1)
    expect(evaluateBuiltinVibratoShape('sawUp', 1)).toBe(1)
    expect(evaluateBuiltinVibratoShape('sawDown', 0)).toBe(1)
    expect(evaluateBuiltinVibratoShape('sawDown', 1)).toBe(-1)
    expect(evaluateBuiltinVibratoShape('square', 0.25)).toBe(1)
    expect(evaluateBuiltinVibratoShape('square', 0.75)).toBe(-1)
  })

  it('custom is handled by the caller, never by the builtin path', () => {
    expect(evaluateBuiltinVibratoShape('custom', 0.3)).toBe(0)
  })
})

describe('normalizeCustomShape', () => {
  it('sorts by time, clamps into range and drops junk', () => {
    const out = normalizeCustomShape([
      P(0.8, 2), null, P(0.2, -5), { time: NaN, value: 0 }, P(0.5, 0.25),
    ])
    expect(out).toEqual([
      { time: 0.2, value: -1 },
      { time: 0.5, value: 0.25 },
      { time: 0.8, value: 1 },
    ])
  })

  it('returns an empty list for a non-array', () => {
    expect(normalizeCustomShape(undefined)).toEqual([])
    expect(normalizeCustomShape(null)).toEqual([])
  })
})
