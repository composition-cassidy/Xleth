import { describe, it, expect } from 'vitest'
import {
  PAD_L, PAD_T, PLOT_W, PLOT_H,
  FREQ_MIN, FREQ_MAX, ANA_DB_MIN, ANA_DB_MAX, RESPONSE_SIZE,
  freqToX, xToFreq,
  dbToY_response, dbToY_analyzer, dbToY_analyzerWithRange, yToDb_response,
  evalResponseAt, clamp,
} from '../eqGeometry.js'

describe('eqGeometry — coordinate transforms', () => {
  it('freqToX endpoints land at the plot edges', () => {
    expect(freqToX(FREQ_MIN)).toBeCloseTo(PAD_L, 6)
    expect(freqToX(FREQ_MAX)).toBeCloseTo(PAD_L + PLOT_W, 6)
  })

  it('freqToX is strictly monotonic in log frequency', () => {
    let prev = -Infinity
    for (let n = 0; n <= 100; n++) {
      const f = FREQ_MIN * Math.pow(FREQ_MAX / FREQ_MIN, n / 100)
      const x = freqToX(f)
      expect(x).toBeGreaterThan(prev)
      prev = x
    }
  })

  it('xToFreq is the inverse of freqToX (round-trip within 1e-9 rel error)', () => {
    for (const f of [20, 87.3, 220, 1000, 2840, 10000, 19000, 20000]) {
      const round = xToFreq(freqToX(f))
      expect(Math.abs(round - f) / f).toBeLessThan(1e-9)
    }
  })

  it('dbToY_analyzer clamps to the plot range and respects axis polarity', () => {
    const yTop = dbToY_analyzer(ANA_DB_MAX + 50)
    const yBot = dbToY_analyzer(ANA_DB_MIN - 50)
    expect(yTop).toBeCloseTo(PAD_T, 6)            // above ceiling clamps to plot top
    expect(yBot).toBeCloseTo(PAD_T + PLOT_H, 6)   // below floor clamps to plot bottom
    expect(dbToY_analyzer(ANA_DB_MAX)).toBeCloseTo(PAD_T, 6)
    expect(dbToY_analyzer(ANA_DB_MIN)).toBeCloseTo(PAD_T + PLOT_H, 6)
  })

  it('dbToY_response is symmetric around 0 dB for the given zoom', () => {
    const zoom = 12
    const yPlus = dbToY_response(+zoom, zoom)
    const yMinus = dbToY_response(-zoom, zoom)
    const yZero = dbToY_response(0, zoom)
    expect(yPlus).toBeCloseTo(PAD_T, 6)
    expect(yMinus).toBeCloseTo(PAD_T + PLOT_H, 6)
    expect(yZero).toBeCloseTo(PAD_T + PLOT_H / 2, 6)
  })

  it('yToDb_response inverts dbToY_response', () => {
    const zoom = 24
    for (const db of [-zoom, -10, 0, 6.5, +zoom]) {
      const round = yToDb_response(dbToY_response(db, zoom), zoom)
      expect(round).toBeCloseTo(db, 6)
    }
  })

  it('evalResponseAt returns exact samples at the log-spaced grid', () => {
    const data = new Float32Array(RESPONSE_SIZE)
    for (let i = 0; i < RESPONSE_SIZE; i++) data[i] = i // monotonic
    expect(evalResponseAt(data, FREQ_MIN)).toBeCloseTo(0, 6)
    expect(evalResponseAt(data, FREQ_MAX)).toBeCloseTo(RESPONSE_SIZE - 1, 6)
  })

  it('evalResponseAt linearly interpolates between adjacent samples', () => {
    // Build curve where values are exactly = sample index.
    const data = new Float32Array(RESPONSE_SIZE)
    for (let i = 0; i < RESPONSE_SIZE; i++) data[i] = i
    // The midpoint of the log-frequency grid (i = 255.5) is the geometric
    // mean of FREQ_MIN and FREQ_MAX along log-space at idx = 255.5/511.
    const t = 255.5 / (RESPONSE_SIZE - 1)
    const f = Math.exp(Math.log(FREQ_MIN) + t * (Math.log(FREQ_MAX) - Math.log(FREQ_MIN)))
    expect(evalResponseAt(data, f)).toBeCloseTo(255.5, 4)
  })

  it('clamp behaves as min/max', () => {
    expect(clamp(5, 0, 10)).toBe(5)
    expect(clamp(-1, 0, 10)).toBe(0)
    expect(clamp(99, 0, 10)).toBe(10)
  })
})

describe('eqGeometry — dbToY_analyzerWithRange', () => {
  it('with null rangeDb is identical to dbToY_analyzer', () => {
    for (const db of [-80, -60, -40, -20, 0, 12]) {
      expect(dbToY_analyzerWithRange(db, null)).toBeCloseTo(dbToY_analyzer(db), 6)
    }
  })

  it('with rangeDb=60 top and bottom land at the plot edges', () => {
    // top of range = ANA_DB_MAX, bottom = ANA_DB_MAX - 60
    expect(dbToY_analyzerWithRange(ANA_DB_MAX,      60)).toBeCloseTo(PAD_T,           6)
    expect(dbToY_analyzerWithRange(ANA_DB_MAX - 60, 60)).toBeCloseTo(PAD_T + PLOT_H,  6)
  })

  it('with rangeDb=90 top and bottom land at the plot edges', () => {
    expect(dbToY_analyzerWithRange(ANA_DB_MAX,      90)).toBeCloseTo(PAD_T,           6)
    expect(dbToY_analyzerWithRange(ANA_DB_MAX - 90, 90)).toBeCloseTo(PAD_T + PLOT_H,  6)
  })

  it('clamps values above ANA_DB_MAX to the plot top', () => {
    expect(dbToY_analyzerWithRange(ANA_DB_MAX + 50, 60)).toBeCloseTo(PAD_T, 6)
  })

  it('clamps values below the range floor to the plot bottom', () => {
    expect(dbToY_analyzerWithRange(ANA_DB_MAX - 200, 60)).toBeCloseTo(PAD_T + PLOT_H, 6)
  })

  it('a value at the midpoint of the range maps to vertical centre', () => {
    const midDb = ANA_DB_MAX - 60 / 2
    expect(dbToY_analyzerWithRange(midDb, 60)).toBeCloseTo(PAD_T + PLOT_H / 2, 4)
  })
})
