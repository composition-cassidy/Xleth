import { describe, expect, it } from 'vitest'
import {
  clearAllMeterTelemetry,
  createPeakEntry,
  mergeMeterTelemetry,
} from '../meterTelemetry.js'

function createSnapshot() {
  return {
    tracks: {},
    master: createPeakEntry(),
  }
}

describe('meterTelemetry', () => {
  it('maps payload entries by stable track id', () => {
    const snapshot = createSnapshot()
    snapshot.tracks['3'] = createPeakEntry()
    snapshot.tracks['11'] = createPeakEntry()

    mergeMeterTelemetry(snapshot, {
      tracks: {
        11: { peakL: 0.4, peakR: 0.2 },
        3: { peakL: 0.1, peakR: 0.05 },
      },
      master: { peakL: 0.5, peakR: 0.45 },
    }, 100)

    expect(snapshot.tracks['3'].peakL).toBeCloseTo(0.1, 6)
    expect(snapshot.tracks['3'].peakR).toBeCloseTo(0.05, 6)
    expect(snapshot.tracks['11'].peakL).toBeCloseTo(0.4, 6)
    expect(snapshot.tracks['11'].peakR).toBeCloseTo(0.2, 6)
    expect(snapshot.tracks['3'].hasTelemetry).toBe(true)
    expect(snapshot.tracks['11'].hasTelemetry).toBe(true)
  })

  it('keeps payload-present zero peaks as valid telemetry', () => {
    const snapshot = createSnapshot()

    mergeMeterTelemetry(snapshot, {
      tracks: {
        7: { peakL: 0, peakR: 0 },
      },
      master: { peakL: 0, peakR: 0 },
    }, 321)

    expect(snapshot.tracks['7'].peakL).toBe(0)
    expect(snapshot.tracks['7'].peakR).toBe(0)
    expect(snapshot.tracks['7'].hasTelemetry).toBe(true)
    expect(snapshot.tracks['7'].lastTelemetryMs).toBe(321)
    expect(snapshot.master.hasTelemetry).toBe(true)
    expect(snapshot.master.lastTelemetryMs).toBe(321)
  })

  it('clears omitted track telemetry on a successful poll', () => {
    const snapshot = createSnapshot()

    mergeMeterTelemetry(snapshot, {
      tracks: {
        4: { peakL: 0.9, peakR: 0.8 },
        9: { peakL: 0.3, peakR: 0.2 },
      },
      master: { peakL: 0.95, peakR: 0.9 },
    }, 100)

    mergeMeterTelemetry(snapshot, {
      tracks: {
        9: { peakL: 0.1, peakR: 0.05 },
      },
      master: { peakL: 0.2, peakR: 0.15 },
    }, 200)

    expect(snapshot.tracks['4'].peakL).toBe(0)
    expect(snapshot.tracks['4'].peakR).toBe(0)
    expect(snapshot.tracks['4'].holdL).toBe(0)
    expect(snapshot.tracks['4'].holdR).toBe(0)
    expect(snapshot.tracks['4'].hasTelemetry).toBe(false)
    expect(snapshot.tracks['4'].lastTelemetryMs).toBe(0)
    expect(snapshot.tracks['9'].hasTelemetry).toBe(true)
    expect(snapshot.tracks['9'].lastTelemetryMs).toBe(200)
  })

  it('clears every entry on poll failure to avoid frozen meters', () => {
    const snapshot = createSnapshot()

    mergeMeterTelemetry(snapshot, {
      tracks: {
        2: { peakL: 0.6, peakR: 0.4 },
      },
      master: { peakL: 0.7, peakR: 0.5 },
    }, 111)

    clearAllMeterTelemetry(snapshot)

    expect(snapshot.tracks['2'].peakL).toBe(0)
    expect(snapshot.tracks['2'].peakR).toBe(0)
    expect(snapshot.tracks['2'].holdL).toBe(0)
    expect(snapshot.tracks['2'].holdR).toBe(0)
    expect(snapshot.tracks['2'].hasTelemetry).toBe(false)
    expect(snapshot.master.peakL).toBe(0)
    expect(snapshot.master.peakR).toBe(0)
    expect(snapshot.master.holdL).toBe(0)
    expect(snapshot.master.holdR).toBe(0)
    expect(snapshot.master.hasTelemetry).toBe(false)
  })
})
