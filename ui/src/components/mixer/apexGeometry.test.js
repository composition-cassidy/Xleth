// apexGeometry.test.js — pins the curve evaluator and the level-proportional
// axis mapping.
//
// The evaluator here is a hand-port of ApexDsp.h (evalCurveDb / tensionWarp).
// If the two drift, the editor draws one curve and the audio thread applies a
// different one — a class of bug nothing else in the UI can see. So this file
// asserts the PROPERTIES the engine version is written to guarantee, in the
// same terms the C++ tests use.

import { describe, it, expect } from 'vitest'
import {
  CURVE_MIN_DB, CURVE_MAX_DB,
  evalCurveAt, tensionWarp, tensionForMidpoint,
  levelNorm, normLevel,
  inDbToX, xToInDb, outDbToY, yToOutDb,
} from './apexGeometry.js'

const PLOT = { x: 0, y: 0, w: 600, h: 400 }

// Second difference of the curve, sampled evenly in dB. A kink shows up here
// as a spike; a smooth curve keeps it near zero everywhere.
function maxCurvature(curve, step = 0.05) {
  let worst = 0
  for (let db = CURVE_MIN_DB + step; db < CURVE_MAX_DB - step; db += step) {
    const d2 = evalCurveAt(curve, db + step) - 2 * evalCurveAt(curve, db) + evalCurveAt(curve, db - step)
    worst = Math.max(worst, Math.abs(d2))
  }
  return worst
}

describe('tensionWarp', () => {
  it('is pinned at both ends and monotone for every tension', () => {
    for (const tau of [-1, -0.5, 0, 0.37, 1]) {
      expect(tensionWarp(0, tau)).toBeCloseTo(0, 6)
      expect(tensionWarp(1, tau)).toBeCloseTo(1, 6)
      let prev = -Infinity
      for (let t = 0; t <= 1.0001; t += 0.01) {
        const w = tensionWarp(t, tau)
        expect(w).toBeGreaterThanOrEqual(prev - 1e-6)
        prev = w
      }
    }
  })

  it('has BOUNDED end slopes — the whole point of dropping the power warp', () => {
    // The old warp was t^(4^-tension): slope at one end was infinite for any
    // non-zero tension, which is what made bent segments look snapped.
    const h = 1e-4
    for (const tau of [-1, -0.5, 0.5, 1]) {
      const s0 = (tensionWarp(h, tau) - tensionWarp(0, tau)) / h
      const s1 = (tensionWarp(1, tau) - tensionWarp(1 - h, tau)) / h
      expect(s0).toBeLessThanOrEqual(3.01)
      expect(s1).toBeLessThanOrEqual(3.01)
      expect(s0).toBeGreaterThanOrEqual(-0.01)
      expect(s1).toBeGreaterThanOrEqual(-0.01)
    }
  })

  it('is exactly the identity at zero tension', () => {
    for (let t = 0; t <= 1; t += 0.125) expect(tensionWarp(t, 0)).toBe(t)
  })

  it('inverts at the midpoint in closed form', () => {
    for (const tau of [-1, -0.4, 0, 0.4, 1]) {
      expect(tensionForMidpoint(tensionWarp(0.5, tau))).toBeCloseTo(tau, 6)
    }
  })
})

describe('evalCurveAt', () => {
  const unity = { nodes: [{ in: CURVE_MIN_DB, out: CURVE_MIN_DB }, { in: CURVE_MAX_DB, out: CURVE_MAX_DB }], tensions: [0] }
  // 1:1 up to -12 dB, flat above — the classic limiter shape, and the one with
  // the sharpest corner.
  const limiter = {
    nodes: [{ in: CURVE_MIN_DB, out: CURVE_MIN_DB }, { in: -12, out: -12 }, { in: 12, out: -12 }],
    tensions: [0, 0],
  }

  it('leaves unity alone', () => {
    for (let db = -90; db <= 12; db += 3) expect(evalCurveAt(unity, db)).toBeCloseTo(db, 4)
  })

  it('holds the endpoint GAIN outside the authored domain', () => {
    const c = { nodes: [{ in: -24, out: -24 }, { in: 12, out: -12 }], tensions: [0] }
    expect(evalCurveAt(c, -40)).toBeCloseTo(-40, 4)   // gain 0 dB below the first node
    expect(evalCurveAt(c, 30)).toBeCloseTo(6, 4)      // gain -24 dB above the last
  })

  it('keeps straight segments EXACT away from the corner', () => {
    // Rounding must not soften a segment into "roughly 1:1" — a corner window
    // is 0.28 of the shorter neighbour (here 24 dB * 0.28 = 6.7 dB).
    for (const db of [-60, -40, -30, -22]) expect(evalCurveAt(limiter, db)).toBeCloseTo(db, 4)
    for (const db of [0, 6, 11]) expect(evalCurveAt(limiter, db)).toBeCloseTo(-12, 4)
  })

  it('rounds the corner instead of kinking it, and never overshoots it', () => {
    // At the node the curve must sit strictly BELOW the naive corner (the two
    // straight segments meet at -12) — that is what "cutting the corner" means.
    expect(evalCurveAt(limiter, -12)).toBeLessThan(-12)
    expect(evalCurveAt(limiter, -12)).toBeGreaterThan(-14)

    // The fillet stays inside BOTH segments everywhere: never above the -12
    // ceiling and never above the 1:1 line (i.e. never adds gain).
    for (let db = CURVE_MIN_DB; db <= CURVE_MAX_DB; db += 0.05) {
      const v = evalCurveAt(limiter, db)
      expect(v).toBeLessThanOrEqual(-12 + 1e-4)
      expect(v).toBeLessThanOrEqual(db + 1e-4)
    }

    // And the curvature stays bounded: a kink at the node would spike this.
    const step = 0.05
    expect(maxCurvature(limiter, step)).toBeLessThan(0.02 * step)
  })

  it('is continuous and monotone across a multi-node tensioned curve', () => {
    const curve = {
      nodes: [{ in: CURVE_MIN_DB, out: CURVE_MIN_DB }, { in: -30, out: -20 },
        { in: -10, out: -8 }, { in: 12, out: -4 }],
      tensions: [0.8, -0.7, 0.35],
    }
    let prev = -Infinity
    let prevSlope = null
    for (let db = CURVE_MIN_DB; db <= CURVE_MAX_DB; db += 0.05) {
      const v = evalCurveAt(curve, db)
      expect(Number.isFinite(v)).toBe(true)
      expect(v).toBeGreaterThanOrEqual(prev - 1e-4)          // monotone
      if (prevSlope !== null) {
        // No slope jump anywhere: C1 across nodes AND window edges. What is
        // left is pure curvature — measured max is 0.003 per 0.02 dB step; a
        // kink at a node or a fillet edge lands an order of magnitude above.
        expect(Math.abs((v - prev) / 0.05 - prevSlope)).toBeLessThan(0.02)
      }
      if (prev !== -Infinity) prevSlope = (v - prev) / 0.05
      prev = v
    }
  })
})

describe('level-proportional axis', () => {
  it('puts silence exactly on the edge and the top exactly on the far edge', () => {
    expect(levelNorm(CURVE_MIN_DB)).toBeCloseTo(0, 9)
    expect(levelNorm(CURVE_MAX_DB)).toBeCloseTo(1, 9)
  })

  it('round-trips dB → position → dB', () => {
    for (const db of [-96, -72, -48, -24, -12, -6, 0, 6, 12]) {
      expect(normLevel(levelNorm(db))).toBeCloseTo(db, 4)
      expect(xToInDb(inDbToX(db, PLOT), PLOT)).toBeCloseTo(db, 4)
      expect(yToOutDb(outDbToY(db, PLOT), PLOT)).toBeCloseTo(db, 4)
    }
  })

  it('is monotone and gives the quiet half real room', () => {
    let prev = -Infinity
    for (let db = CURVE_MIN_DB; db <= CURVE_MAX_DB; db += 1) {
      const t = levelNorm(db)
      expect(t).toBeGreaterThan(prev)
      prev = t
    }
    // A raw amplitude axis (gamma 1) would bury -24 dB at 6 % of the width.
    expect(levelNorm(-24)).toBeGreaterThan(0.12)
    expect(levelNorm(0)).toBeGreaterThan(0.5)
    expect(levelNorm(0)).toBeLessThan(0.65)
  })

  it('maps unity onto the box diagonal', () => {
    for (const db of [-72, -24, -6, 0, 12]) {
      const x = inDbToX(db, PLOT)
      const y = outDbToY(db, PLOT)
      expect(x / PLOT.w).toBeCloseTo(1 - y / PLOT.h, 6)
    }
  })
})
