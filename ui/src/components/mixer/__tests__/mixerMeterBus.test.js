import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  METER_FLOOR_DB, levelsOf, meterSubscriberCount, peakToDb, publishMeters, subscribeMeter,
} from '../mixerMeterBus.js'
import { createPeakEntry } from '../meterTelemetry.js'

describe('mixerMeterBus', () => {
  const unsubs = []
  afterEach(() => { while (unsubs.length) unsubs.pop()() })

  it('converts linear peaks to dB with a hard floor', () => {
    expect(peakToDb(1)).toBeCloseTo(0, 6)
    expect(peakToDb(0.5)).toBeCloseTo(-6.0206, 3)
    expect(peakToDb(0)).toBe(METER_FLOOR_DB)
    expect(peakToDb(NaN)).toBe(METER_FLOOR_DB)
    expect(peakToDb(1e-12)).toBe(METER_FLOOR_DB)
  })

  it('reports the floor for an entry with no telemetry, real levels otherwise', () => {
    expect(levelsOf(createPeakEntry())).toEqual([METER_FLOOR_DB, METER_FLOOR_DB])
    expect(levelsOf(undefined)).toEqual([METER_FLOOR_DB, METER_FLOOR_DB])
    const entry = { ...createPeakEntry(), hasTelemetry: true, peakL: 1, peakR: 0.5 }
    const [l, r] = levelsOf(entry)
    expect(l).toBeCloseTo(0, 6)
    expect(r).toBeCloseTo(-6.02, 1)
  })

  it('publishes each subscribed strip its own levels and nothing else', () => {
    const t1 = vi.fn()
    const t2 = vi.fn()
    const master = vi.fn()
    unsubs.push(subscribeMeter(1, t1), subscribeMeter('2', t2), subscribeMeter('master', master))
    const snapshot = {
      tracks: { 1: { ...createPeakEntry(), hasTelemetry: true, peakL: 1, peakR: 1 } },
      master: { ...createPeakEntry(), hasTelemetry: true, peakL: 0.1, peakR: 0.1 },
    }
    publishMeters(snapshot)
    expect(t1).toHaveBeenCalledTimes(1)
    expect(t1.mock.calls[0][0][0]).toBeCloseTo(0, 6)
    expect(t2).toHaveBeenCalledWith([METER_FLOOR_DB, METER_FLOOR_DB])
    expect(master.mock.calls[0][0][0]).toBeCloseTo(-20, 3)
  })

  it('stops calling an unsubscribed meter', () => {
    const push = vi.fn()
    const off = subscribeMeter(7, push)
    expect(meterSubscriberCount()).toBe(1)
    off()
    expect(meterSubscriberCount()).toBe(0)
    publishMeters({ tracks: {}, master: createPeakEntry() })
    expect(push).not.toHaveBeenCalled()
  })
})
