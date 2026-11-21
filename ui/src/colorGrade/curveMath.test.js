import { describe, expect, it } from 'vitest'
import {
  addPoint, editablePoints, evaluateCurve, movePoint, removePoint, sampleCurve, storedPoints,
} from './curveMath.js'
import { MAX_CURVE_POINTS, MIN_CURVE_GAP } from './gradeModel.js'

const S = [[0, 0], [0.2, 0.05], [0.5, 0.5], [0.8, 0.95], [1, 1]]
const STEEP = [[0, 0], [0.48, 0.02], [0.52, 0.98], [1, 1]]
const BUMP = [[0, 0], [0.5, 0.9], [1, 0.2]]

describe('evaluateCurve', () => {
  // Golden values shared with engine/test/test_color_grade.cpp ("[2] curves").
  // The editor draws with this function and the engine bakes with its own; the
  // two must be the same curve. Change one side and both tests fail.
  it('matches the engine at the shared golden points', () => {
    const xs = [0.1, 0.3, 0.4, 0.5, 0.6, 0.7, 0.9]
    const gold = {
      s: [0.021023, 0.151515, 0.325758, 0.5, 0.674242, 0.848485, 0.978977],
      steep: [0.002945, 0.007294, 0.012553, 0.5, 0.987447, 0.992706, 0.997055],
      bump: [0.2088, 0.6696, 0.8352, 0.9, 0.8496, 0.7208, 0.3624],
    }
    xs.forEach((x, i) => {
      expect(evaluateCurve(S, x)).toBeCloseTo(gold.s[i], 5)
      expect(evaluateCurve(STEEP, x)).toBeCloseTo(gold.steep[i], 5)
      expect(evaluateCurve(BUMP, x)).toBeCloseTo(gold.bump[i], 5)
    })
  })

  it('is the diagonal with fewer than two points', () => {
    for (const x of [0, 0.25, 0.5, 1]) {
      expect(evaluateCurve([], x)).toBe(x)
      expect(evaluateCurve([[0.5, 0.9]], x)).toBe(x)
    }
  })

  it('passes through every point and is flat outside the ends', () => {
    for (const [x, y] of S) expect(evaluateCurve(S, x)).toBeCloseTo(y, 6)
    const inset = [[0.2, 0.1], [0.8, 0.9]]
    expect(evaluateCurve(inset, 0)).toBe(0.1)
    expect(evaluateCurve(inset, 1)).toBe(0.9)
  })

  it('never reverses through rising points, however steep', () => {
    for (const curve of [S, STEEP]) {
      const samples = sampleCurve(curve, 2000)
      for (let i = 1; i < samples.length; i++) expect(samples[i]).toBeGreaterThanOrEqual(samples[i - 1] - 1e-9)
      expect(Math.min(...samples)).toBeGreaterThanOrEqual(0)
      expect(Math.max(...samples)).toBeLessThanOrEqual(1)
    }
  })

  it('never overshoots a peak', () => {
    expect(Math.max(...sampleCurve(BUMP, 1000))).toBeLessThanOrEqual(0.9 + 1e-9)
  })
})

describe('editing points', () => {
  it('shows an empty curve as its two ends and stores the diagonal as nothing', () => {
    expect(editablePoints([])).toEqual([[0, 0], [1, 1]])
    expect(storedPoints([[0, 0], [1, 1]])).toEqual([])
    expect(storedPoints(S)).toEqual(S)
  })

  it('adds a point in order and refuses one on top of a neighbour', () => {
    const res = addPoint([], 0.4, 0.6)
    expect(res.index).toBe(1)
    expect(res.points).toEqual([[0, 0], [0.4, 0.6], [1, 1]])
    expect(addPoint(res.points, 0.4 + MIN_CURVE_GAP / 2, 0.2)).toBeNull()
  })

  it('refuses a point past the limit', () => {
    let pts = [[0, 0], [1, 1]]
    for (let i = 1; pts.length < MAX_CURVE_POINTS; i++) pts = addPoint(pts, i / 40, i / 40).points
    expect(pts.length).toBe(MAX_CURVE_POINTS)
    expect(addPoint(pts, 0.9, 0.9)).toBeNull()
  })

  it('never lets a dragged point pass its neighbours', () => {
    const pts = [[0, 0], [0.3, 0.3], [0.6, 0.6], [1, 1]]
    const left = movePoint(pts, 2, 0.05, 0.5)
    expect(left[2][0]).toBeCloseTo(0.3 + MIN_CURVE_GAP, 9)
    const right = movePoint(pts, 1, 0.99, 0.5)
    expect(right[1][0]).toBeCloseTo(0.6 - MIN_CURVE_GAP, 9)
    // x stays strictly increasing, so the curve stays a function of x.
    for (const p of [left, right]) for (let i = 1; i < p.length; i++) expect(p[i][0]).toBeGreaterThan(p[i - 1][0])
  })

  it('clamps a moved point into the plot', () => {
    const moved = movePoint([[0, 0], [1, 1]], 1, 2, -1)
    expect(moved[1]).toEqual([1, 0])
  })

  it('removes a point but always keeps two', () => {
    expect(removePoint(S, 2).length).toBe(4)
    expect(removePoint([[0, 0], [1, 1]], 0)).toEqual([[0, 0], [1, 1]])
  })
})
