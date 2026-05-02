import { describe, it, expect } from 'vitest'
import {
  clamp01,
  rateToAngVel,
  normFeedback,
  mixToAlpha,
  delayToNorm,
  widthToPhaseOffset,
} from '../FlangerVisualizerCanvas.jsx'

describe('FlangerVisualizerCanvas helpers', () => {

  describe('clamp01', () => {
    it('passes through values already in [0, 1]', () => {
      expect(clamp01(0)).toBe(0)
      expect(clamp01(0.5)).toBe(0.5)
      expect(clamp01(1)).toBe(1)
    })
    it('clamps below 0', () => {
      expect(clamp01(-0.1)).toBe(0)
      expect(clamp01(-100)).toBe(0)
    })
    it('clamps above 1', () => {
      expect(clamp01(1.1)).toBe(1)
      expect(clamp01(100)).toBe(1)
    })
  })

  describe('rateToAngVel', () => {
    it('returns 2π/1000 rad/ms at exactly 1 Hz', () => {
      expect(rateToAngVel(1)).toBeCloseTo(2 * Math.PI / 1000, 9)
    })
    it('scales linearly — 2 Hz is double 1 Hz', () => {
      expect(rateToAngVel(2)).toBeCloseTo(2 * rateToAngVel(1), 9)
    })
    it('returns a positive value for the full Flanger rate range', () => {
      expect(rateToAngVel(0.05)).toBeGreaterThan(0)
      expect(rateToAngVel(10)).toBeGreaterThan(0)
    })
  })

  describe('normFeedback', () => {
    it('returns 0 at feedback = 0', () => {
      expect(normFeedback(0)).toBeCloseTo(0, 9)
    })
    it('returns 1 at feedback = 95 (positive maximum)', () => {
      expect(normFeedback(95)).toBeCloseTo(1, 9)
    })
    it('returns -1 at feedback = -95 (negative maximum)', () => {
      expect(normFeedback(-95)).toBeCloseTo(-1, 9)
    })
    it('returns positive for positive feedback', () => {
      expect(normFeedback(50)).toBeGreaterThan(0)
    })
    it('returns negative for negative feedback', () => {
      expect(normFeedback(-30)).toBeLessThan(0)
    })
    it('clamps values beyond ±95', () => {
      expect(normFeedback(200)).toBeCloseTo(1, 9)
      expect(normFeedback(-200)).toBeCloseTo(-1, 9)
    })
    it('is linear at midpoint — 47.5 → 0.5', () => {
      expect(normFeedback(47.5)).toBeCloseTo(0.5, 9)
    })
  })

  describe('mixToAlpha', () => {
    it('returns 0.15 at mix = 0 (always faintly visible)', () => {
      expect(mixToAlpha(0)).toBeCloseTo(0.15, 9)
    })
    it('returns 1.0 at mix = 100', () => {
      expect(mixToAlpha(100)).toBeCloseTo(1.0, 9)
    })
    it('clamps below 0', () => {
      expect(mixToAlpha(-50)).toBeCloseTo(0.15, 9)
    })
    it('clamps above 100', () => {
      expect(mixToAlpha(200)).toBeCloseTo(1.0, 9)
    })
    it('returns linear midpoint at mix = 50', () => {
      // 0.15 + 0.5 × 0.85 = 0.575
      expect(mixToAlpha(50)).toBeCloseTo(0.575, 9)
    })
  })

  describe('delayToNorm', () => {
    it('returns 0 at the minimum axis value (0.1 ms)', () => {
      expect(delayToNorm(0.1)).toBeCloseTo(0, 9)
    })
    it('returns 1 at the maximum axis value (5 ms)', () => {
      expect(delayToNorm(5)).toBeCloseTo(1, 9)
    })
    it('clamps values below 0.1 ms to 0', () => {
      expect(delayToNorm(0)).toBeCloseTo(0, 9)
      expect(delayToNorm(-1)).toBeCloseTo(0, 9)
    })
    it('clamps values above 5 ms to 1', () => {
      expect(delayToNorm(6)).toBeCloseTo(1, 9)
      expect(delayToNorm(100)).toBeCloseTo(1, 9)
    })
    it('grows monotonically between min and max', () => {
      const n1 = delayToNorm(1)
      const n2 = delayToNorm(2.5)
      const n3 = delayToNorm(4)
      expect(n1).toBeLessThan(n2)
      expect(n2).toBeLessThan(n3)
    })
    it('returns ~0.185 at 1 ms (known linear check)', () => {
      // (1 - 0.1) / (5 - 0.1) = 0.9 / 4.9 ≈ 0.18367...
      expect(delayToNorm(1)).toBeCloseTo(0.9 / 4.9, 9)
    })
  })

  describe('widthToPhaseOffset', () => {
    it('returns 0 at width = 0 (mono — no phase offset)', () => {
      expect(widthToPhaseOffset(0)).toBeCloseTo(0, 9)
    })
    it('returns π at width = 100 (maximum stereo spread)', () => {
      expect(widthToPhaseOffset(100)).toBeCloseTo(Math.PI, 9)
    })
    it('returns π/2 at width = 50', () => {
      expect(widthToPhaseOffset(50)).toBeCloseTo(Math.PI / 2, 9)
    })
    it('clamps below 0', () => {
      expect(widthToPhaseOffset(-50)).toBeCloseTo(0, 9)
    })
    it('clamps above 100', () => {
      expect(widthToPhaseOffset(200)).toBeCloseTo(Math.PI, 9)
    })
    it('scales linearly — 75 % → 0.75π', () => {
      expect(widthToPhaseOffset(75)).toBeCloseTo(Math.PI * 0.75, 9)
    })
  })

})
