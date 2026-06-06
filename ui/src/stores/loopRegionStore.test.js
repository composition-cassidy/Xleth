import { describe, expect, it } from 'vitest'
import {
  DEFAULT_LOOP_REGION,
  loopMinLengthTicks,
  clampLoopRegionTicks,
} from './loopRegionStore.js'
import { PPQ } from '../constants/timeline.js'

describe('loopRegionStore pure helpers', () => {
  describe('DEFAULT_LOOP_REGION', () => {
    it('has endTick strictly greater than startTick', () => {
      expect(DEFAULT_LOOP_REGION.endTick).toBeGreaterThan(DEFAULT_LOOP_REGION.startTick)
    })
    it('defaults loop disabled with absolute origin and tailClamp', () => {
      expect(DEFAULT_LOOP_REGION.loopEnabled).toBe(false)
      expect(DEFAULT_LOOP_REGION.renderOrigin).toBe('absolute')
      expect(DEFAULT_LOOP_REGION.tailMode).toBe('tailClamp')
      expect(DEFAULT_LOOP_REGION.tailThresholdDb).toBe(-60)
      expect(DEFAULT_LOOP_REGION.tailMaxSeconds).toBe(10)
    })
    it('exposes renderScoped derived from loopEnabled (default false)', () => {
      expect(DEFAULT_LOOP_REGION.renderScoped).toBe(DEFAULT_LOOP_REGION.loopEnabled)
    })
  })

  describe('loopMinLengthTicks', () => {
    it('snap-on returns 1 snap unit (1/16 = 240 ticks)', () => {
      expect(loopMinLengthTicks('1/16', false)).toBe(240)
    })
    it('snap-on returns 1 bar for Bar granularity', () => {
      expect(loopMinLengthTicks('Bar', false)).toBe(4 * PPQ)
    })
    it('snap-off (Alt) returns 1 tick regardless of granularity', () => {
      expect(loopMinLengthTicks('1/16', true)).toBe(1)
      expect(loopMinLengthTicks('Bar', true)).toBe(1)
    })
    it('falls back to 1/16 for unknown granularity', () => {
      expect(loopMinLengthTicks('bogus', false)).toBe(240)
    })
  })

  describe('clampLoopRegionTicks', () => {
    it('enforces snap-on min length (240) when too short', () => {
      const r = clampLoopRegionTicks(0, 10, 240)
      expect(r.endTick - r.startTick).toBe(240)
    })
    it('enforces snap-off 1-tick min length', () => {
      const r = clampLoopRegionTicks(0, 0, 1)
      expect(r.endTick - r.startTick).toBe(1)
    })
    it('clamps negative startTick to 0', () => {
      const r = clampLoopRegionTicks(-100, 500, 1)
      expect(r.startTick).toBe(0)
    })
    it('leaves a valid region untouched', () => {
      const r = clampLoopRegionTicks(960, 1440, 240)
      expect(r).toEqual({ startTick: 960, endTick: 1440 })
    })
    it('forces apart a negative-length region', () => {
      const r = clampLoopRegionTicks(2000, 500, 1)
      expect(r.endTick).toBe(2001)
    })
  })
})
