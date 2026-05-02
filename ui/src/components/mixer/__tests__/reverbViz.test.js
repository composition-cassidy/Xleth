import { describe, it, expect } from 'vitest'
import {
  clamp01,
  decayToSpread,
  sizeToRoomFrac,
  hicutToColor,
  locutToBodyAlpha,
  seedRays,
  seedParticles,
} from '../ReverbVisualizerCanvas.jsx'

// ── Deterministic PRNG for tests ─────────────────────────────────────────────
// A simple counter-based rng that returns a well-distributed sequence without
// depending on the component's internal mulberry32 implementation.

function makeSeqRng(values) {
  let i = 0
  return () => values[i++ % values.length]
}

// A deterministic mulberry32-equivalent for seedRays/seedParticles stability tests.
// Identical to the component's implementation so we can cross-check output.
function mulberry32(a) {
  let s = a | 0
  return function () {
    s = (s + 0x6D2B79F5) | 0
    let t = Math.imul(s ^ (s >>> 15), 1 | s)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// ── clamp01 ───────────────────────────────────────────────────────────────────

describe('clamp01', () => {
  it('passes through values already in [0, 1]', () => {
    expect(clamp01(0)).toBe(0)
    expect(clamp01(0.5)).toBe(0.5)
    expect(clamp01(1)).toBe(1)
  })
  it('clamps below 0 to 0', () => {
    expect(clamp01(-0.001)).toBe(0)
    expect(clamp01(-999)).toBe(0)
  })
  it('clamps above 1 to 1', () => {
    expect(clamp01(1.001)).toBe(1)
    expect(clamp01(999)).toBe(1)
  })
})

// ── decayToSpread ─────────────────────────────────────────────────────────────

describe('decayToSpread', () => {
  it('returns 0 at minimum decay (0.1 s)', () => {
    expect(decayToSpread(0.1)).toBeCloseTo(0, 9)
  })
  it('returns 1 at maximum decay (30 s)', () => {
    expect(decayToSpread(30)).toBeCloseTo(1, 9)
  })
  it('returns ~0.5 at the geometric midpoint of 0.1 and 30', () => {
    // geometric midpoint = sqrt(0.1 * 30) = sqrt(3) ≈ 1.7321
    const geoMid = Math.sqrt(0.1 * 30)
    expect(decayToSpread(geoMid)).toBeCloseTo(0.5, 5)
  })
  it('grows monotonically across the decay range', () => {
    const s1 = decayToSpread(0.5)
    const s2 = decayToSpread(2)
    const s3 = decayToSpread(10)
    const s4 = decayToSpread(25)
    expect(s1).toBeLessThan(s2)
    expect(s2).toBeLessThan(s3)
    expect(s3).toBeLessThan(s4)
  })
  it('clamps input below 0.1 to 0', () => {
    expect(decayToSpread(0)).toBeCloseTo(0, 9)
    expect(decayToSpread(-5)).toBeCloseTo(0, 9)
  })
  it('clamps input above 30 to 1', () => {
    expect(decayToSpread(100)).toBeCloseTo(1, 9)
  })
})

// ── sizeToRoomFrac ────────────────────────────────────────────────────────────

describe('sizeToRoomFrac', () => {
  it('returns 0.24 at size = 0 (smallest room)', () => {
    expect(sizeToRoomFrac(0)).toBeCloseTo(0.24, 9)
  })
  it('returns 0.60 at size = 100 (largest room)', () => {
    expect(sizeToRoomFrac(100)).toBeCloseTo(0.60, 9)
  })
  it('returns 0.42 at size = 50 (midpoint)', () => {
    // 0.24 + 0.5 * 0.36 = 0.42
    expect(sizeToRoomFrac(50)).toBeCloseTo(0.42, 9)
  })
  it('clamps below 0 to 0.24', () => {
    expect(sizeToRoomFrac(-50)).toBeCloseTo(0.24, 9)
  })
  it('clamps above 100 to 0.60', () => {
    expect(sizeToRoomFrac(200)).toBeCloseTo(0.60, 9)
  })
  it('grows monotonically', () => {
    expect(sizeToRoomFrac(25)).toBeLessThan(sizeToRoomFrac(75))
  })
})

// ── hicutToColor ─────────────────────────────────────────────────────────────

describe('hicutToColor', () => {
  it('returns warm amber at hicutNorm = 0 (1 kHz — darkest/warmest)', () => {
    const c = hicutToColor(0)
    expect(c.r).toBe(200)
    expect(c.g).toBe(105)
    expect(c.b).toBe(20)
  })
  it('returns cool purple-white at hicutNorm = 1 (20 kHz — brightest)', () => {
    const c = hicutToColor(1)
    expect(c.r).toBe(175)
    expect(c.g).toBe(135)
    expect(c.b).toBe(255)
  })
  it('interpolates linearly at hicutNorm = 0.5', () => {
    const c = hicutToColor(0.5)
    // r: 200 + 0.5*(175-200) = 187.5 → 188
    expect(c.r).toBe(Math.round(200 + 0.5 * (175 - 200)))
    // g: 105 + 0.5*(135-105) = 120
    expect(c.g).toBe(Math.round(105 + 0.5 * (135 - 105)))
    // b: 20 + 0.5*(255-20) = 137.5 → 138
    expect(c.b).toBe(Math.round(20 + 0.5 * (255 - 20)))
  })
  it('clamps hicutNorm below 0 to the warm colour', () => {
    expect(hicutToColor(-0.5)).toEqual(hicutToColor(0))
  })
  it('clamps hicutNorm above 1 to the cool colour', () => {
    expect(hicutToColor(2)).toEqual(hicutToColor(1))
  })
  it('blue channel increases monotonically from 0 to 1', () => {
    expect(hicutToColor(0.25).b).toBeLessThan(hicutToColor(0.75).b)
  })
})

// ── locutToBodyAlpha ──────────────────────────────────────────────────────────

describe('locutToBodyAlpha', () => {
  it('returns baseAlpha unchanged at locutNorm = 0 (no thinning)', () => {
    expect(locutToBodyAlpha(0, 0.1)).toBeCloseTo(0.1, 9)
    expect(locutToBodyAlpha(0, 0.5)).toBeCloseTo(0.5, 9)
  })
  it('reduces alpha to 18% of baseAlpha at locutNorm = 1 (maximum thinning)', () => {
    // 1 - 1.0 * 0.82 = 0.18
    expect(locutToBodyAlpha(1, 0.1)).toBeCloseTo(0.1 * 0.18, 9)
  })
  it('reduces alpha by 41% at locutNorm = 0.5', () => {
    // 1 - 0.5 * 0.82 = 0.59
    expect(locutToBodyAlpha(0.5, 0.1)).toBeCloseTo(0.1 * 0.59, 9)
  })
  it('clamps locutNorm below 0', () => {
    expect(locutToBodyAlpha(-0.5, 0.1)).toBeCloseTo(locutToBodyAlpha(0, 0.1), 9)
  })
  it('clamps locutNorm above 1', () => {
    expect(locutToBodyAlpha(2, 0.1)).toBeCloseTo(locutToBodyAlpha(1, 0.1), 9)
  })
  it('output alpha is always ≤ baseAlpha', () => {
    for (const n of [0, 0.25, 0.5, 0.75, 1]) {
      expect(locutToBodyAlpha(n, 0.2)).toBeLessThanOrEqual(0.2 + 1e-9)
    }
  })
})

// ── seedRays ──────────────────────────────────────────────────────────────────

describe('seedRays', () => {
  it('produces exactly count rays', () => {
    const rng = mulberry32(0x1234ABCD)
    expect(seedRays(12, rng)).toHaveLength(12)
    expect(seedRays(0, mulberry32(0x01))).toHaveLength(0)
  })
  it('all wallSide values are in {0, 1, 2, 3}', () => {
    const rays = seedRays(12, mulberry32(0xDEADBEEF))
    for (const r of rays) {
      expect([0, 1, 2, 3]).toContain(r.wallSide)
    }
  })
  it('all wallNorm values are in [0.1, 0.9]', () => {
    const rays = seedRays(12, mulberry32(0xCAFEBABE))
    for (const r of rays) {
      expect(r.wallNorm).toBeGreaterThanOrEqual(0.1)
      expect(r.wallNorm).toBeLessThanOrEqual(0.9)
    }
  })
  it('is deterministic — same seed produces identical output', () => {
    const r1 = seedRays(12, mulberry32(0xA9B3C1D2))
    const r2 = seedRays(12, mulberry32(0xA9B3C1D2))
    expect(r1).toEqual(r2)
  })
  it('different seeds produce different output', () => {
    const r1 = seedRays(12, mulberry32(0x00000001))
    const r2 = seedRays(12, mulberry32(0x00000002))
    expect(r1).not.toEqual(r2)
  })
})

// ── seedParticles ─────────────────────────────────────────────────────────────

describe('seedParticles', () => {
  it('produces exactly count particles', () => {
    expect(seedParticles(48, mulberry32(0xABCDEF01))).toHaveLength(48)
    expect(seedParticles(0,  mulberry32(0x01))).toHaveLength(0)
  })
  it('all nx and ny values are in [-0.96, 0.96]', () => {
    const ptcs = seedParticles(48, mulberry32(0x11223344))
    for (const p of ptcs) {
      expect(p.nx).toBeGreaterThanOrEqual(-0.96)
      expect(p.nx).toBeLessThanOrEqual(0.96)
      expect(p.ny).toBeGreaterThanOrEqual(-0.96)
      expect(p.ny).toBeLessThanOrEqual(0.96)
    }
  })
  it('phase values are in [0, 2π]', () => {
    const ptcs = seedParticles(48, mulberry32(0x55667788))
    for (const p of ptcs) {
      expect(p.phase).toBeGreaterThanOrEqual(0)
      expect(p.phase).toBeLessThanOrEqual(2 * Math.PI + 1e-9)
    }
  })
  it('phaseRate values are in [0.28, 1.72]', () => {
    const ptcs = seedParticles(48, mulberry32(0x99AABBCC))
    for (const p of ptcs) {
      expect(p.phaseRate).toBeGreaterThanOrEqual(0.28)
      expect(p.phaseRate).toBeLessThanOrEqual(0.28 + 1.44 + 1e-9)
    }
  })
  it('baseAlpha values are in [0.50, 1.00]', () => {
    const ptcs = seedParticles(48, mulberry32(0xDDEEFF00))
    for (const p of ptcs) {
      expect(p.baseAlpha).toBeGreaterThanOrEqual(0.50)
      expect(p.baseAlpha).toBeLessThanOrEqual(1.00 + 1e-9)
    }
  })
  it('baseSize values are in [0.35, 1.00]', () => {
    const ptcs = seedParticles(48, mulberry32(0x12345678))
    for (const p of ptcs) {
      expect(p.baseSize).toBeGreaterThanOrEqual(0.35)
      expect(p.baseSize).toBeLessThanOrEqual(1.00 + 1e-9)
    }
  })
  it('is deterministic — same seed produces identical output', () => {
    const p1 = seedParticles(48, mulberry32(0xA9B3C1D2))
    const p2 = seedParticles(48, mulberry32(0xA9B3C1D2))
    expect(p1).toEqual(p2)
  })
  it('different seeds produce different output', () => {
    const p1 = seedParticles(48, mulberry32(0x00000001))
    const p2 = seedParticles(48, mulberry32(0x00000002))
    expect(p1).not.toEqual(p2)
  })
  it('particles are Gaussian-distributed — most nx/ny values closer to 0 than to ±0.8', () => {
    const ptcs = seedParticles(200, mulberry32(0xFACEFACE))
    const nearCenter = ptcs.filter(p => Math.abs(p.nx) < 0.5 && Math.abs(p.ny) < 0.5)
    // Uniform on [-1,1]×[-1,1] gives 25%. Gaussian-ish gives ~35%+.
    // Threshold at 0.28 — comfortably above the uniform baseline.
    expect(nearCenter.length).toBeGreaterThan(ptcs.length * 0.28)
  })
})
