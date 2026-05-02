import { describe, it, expect } from 'vitest'
import {
  clampVoices,
  rateToAngularVelocity,
  delayToOrbitRadius,
  feedbackToGlow,
  mixToOrbAlpha,
  widthToEllipseRx,
} from '../ChorusOrbitVisualizer.jsx'

describe('ChorusOrbitVisualizer helpers', () => {

  describe('clampVoices', () => {
    it('rounds to nearest integer', () => {
      expect(clampVoices(1.4)).toBe(1)
      expect(clampVoices(1.6)).toBe(2)
      expect(clampVoices(3.5)).toBe(4)
    })
    it('clamps at minimum 1', () => {
      expect(clampVoices(0)).toBe(1)
      expect(clampVoices(-5)).toBe(1)
      expect(clampVoices(0.4)).toBe(1)
    })
    it('clamps at maximum 10', () => {
      expect(clampVoices(10)).toBe(10)
      expect(clampVoices(15)).toBe(10)
      expect(clampVoices(10.7)).toBe(10)
    })
  })

  describe('rateToAngularVelocity', () => {
    it('returns 2π/1000 rad/ms at exactly 1 Hz', () => {
      expect(rateToAngularVelocity(1)).toBeCloseTo(2 * Math.PI / 1000, 9)
    })
    it('scales linearly — 2 Hz is double 1 Hz', () => {
      expect(rateToAngularVelocity(2)).toBeCloseTo(2 * rateToAngularVelocity(1), 9)
    })
    it('returns a positive value for positive rate', () => {
      expect(rateToAngularVelocity(0.05)).toBeGreaterThan(0)
      expect(rateToAngularVelocity(5)).toBeGreaterThan(0)
    })
  })

  describe('delayToOrbitRadius', () => {
    it('returns baseRadius unchanged at minimum delay (7 ms)', () => {
      expect(delayToOrbitRadius(7, 100)).toBeCloseTo(100, 9)
    })
    it('returns baseRadius × 1.8 at maximum delay (30 ms)', () => {
      expect(delayToOrbitRadius(30, 100)).toBeCloseTo(180, 9)
    })
    it('grows monotonically between min and max delay', () => {
      const r1 = delayToOrbitRadius(10, 100)
      const r2 = delayToOrbitRadius(20, 100)
      const r3 = delayToOrbitRadius(29, 100)
      expect(r1).toBeLessThan(r2)
      expect(r2).toBeLessThan(r3)
    })
    it('clamps below minimum delay to baseRadius', () => {
      expect(delayToOrbitRadius(0, 100)).toBeCloseTo(100, 9)
    })
  })

  describe('feedbackToGlow', () => {
    it('returns baseBlur at feedback=0', () => {
      expect(feedbackToGlow(0, 4, 22)).toBeCloseTo(4, 9)
    })
    it('returns maxBlur at feedback=25', () => {
      expect(feedbackToGlow(25, 4, 22)).toBeCloseTo(22, 9)
    })
    it('clamps input below 0 to baseBlur', () => {
      expect(feedbackToGlow(-10, 4, 22)).toBeCloseTo(4, 9)
    })
    it('clamps input above 25 to maxBlur', () => {
      expect(feedbackToGlow(100, 4, 22)).toBeCloseTo(22, 9)
    })
    it('interpolates linearly at midpoint', () => {
      // feedback=12.5 is 50% → (4 + 22) / 2 = 13
      expect(feedbackToGlow(12.5, 4, 22)).toBeCloseTo(13, 9)
    })
  })

  describe('mixToOrbAlpha', () => {
    it('returns 0.2 at mix=0', () => {
      expect(mixToOrbAlpha(0)).toBeCloseTo(0.2, 9)
    })
    it('returns 1.0 at mix=100', () => {
      expect(mixToOrbAlpha(100)).toBeCloseTo(1.0, 9)
    })
    it('clamps below 0', () => {
      expect(mixToOrbAlpha(-50)).toBeCloseTo(0.2, 9)
    })
    it('clamps above 100', () => {
      expect(mixToOrbAlpha(200)).toBeCloseTo(1.0, 9)
    })
    it('returns 0.6 at mix=50 (linear midpoint)', () => {
      // 0.2 + 0.5 * 0.8 = 0.6
      expect(mixToOrbAlpha(50)).toBeCloseTo(0.6, 9)
    })
  })

  describe('widthToEllipseRx', () => {
    it('returns orbitRy × 0.2 at width=0 (near-mono)', () => {
      expect(widthToEllipseRx(100, 0)).toBeCloseTo(20, 9)
    })
    it('returns orbitRy × 1.8 at width=100 (wide stereo)', () => {
      expect(widthToEllipseRx(100, 100)).toBeCloseTo(180, 9)
    })
    it('returns orbitRy × 1.0 at width=50 (circular orbit)', () => {
      // 0.2 + 0.5 * 1.6 = 1.0
      expect(widthToEllipseRx(100, 50)).toBeCloseTo(100, 9)
    })
    it('scales proportionally with orbitRy', () => {
      expect(widthToEllipseRx(200, 50)).toBeCloseTo(200, 9)
    })
  })

})
