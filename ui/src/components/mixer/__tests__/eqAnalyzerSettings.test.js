import { beforeEach, afterAll, describe, it, expect, vi } from 'vitest'
import {
  loadAnalyzerSettings, saveAnalyzerSettings,
  DEFAULT_ANALYZER,
  TILT_OPTIONS, RANGE_OPTIONS, SPEED_OPTIONS, RESOLUTION_OPTIONS,
  SPEED_DECAY, RESOLUTION_BARS,
} from '../eqAnalyzerSettings.js'

const LS_KEY = 'xleth.eq.analyzer'

// Provide a Map-backed localStorage stub so tests run in the node environment.
function makeLocalStorageStub() {
  const store = new Map()
  return {
    getItem:    key       => store.has(key) ? store.get(key) : null,
    setItem:    (key, v)  => store.set(key, String(v)),
    removeItem: key       => store.delete(key),
    clear:      ()        => store.clear(),
  }
}

const lsStub = makeLocalStorageStub()
vi.stubGlobal('localStorage', lsStub)
afterAll(() => vi.unstubAllGlobals())

describe('eqAnalyzerSettings — localStorage persistence', () => {
  beforeEach(() => { lsStub.clear() })

  it('returns defaults when storage is empty', () => {
    expect(loadAnalyzerSettings()).toEqual(DEFAULT_ANALYZER)
  })

  it('loads all four valid settings correctly', () => {
    const stored = { tiltDbPerOct: 3, rangeDb: 60, speed: 'fast', resolution: 'low' }
    localStorage.setItem(LS_KEY, JSON.stringify(stored))
    expect(loadAnalyzerSettings()).toEqual(stored)
  })

  it('rejects invalid tiltDbPerOct — uses default', () => {
    localStorage.setItem(LS_KEY, JSON.stringify({ ...DEFAULT_ANALYZER, tiltDbPerOct: 99 }))
    expect(loadAnalyzerSettings().tiltDbPerOct).toBe(DEFAULT_ANALYZER.tiltDbPerOct)
  })

  it('rejects invalid rangeDb — uses default', () => {
    localStorage.setItem(LS_KEY, JSON.stringify({ ...DEFAULT_ANALYZER, rangeDb: 45 }))
    expect(loadAnalyzerSettings().rangeDb).toBe(DEFAULT_ANALYZER.rangeDb)
  })

  it('rejects invalid speed — uses default', () => {
    localStorage.setItem(LS_KEY, JSON.stringify({ ...DEFAULT_ANALYZER, speed: 'turbo' }))
    expect(loadAnalyzerSettings().speed).toBe(DEFAULT_ANALYZER.speed)
  })

  it('rejects invalid resolution — uses default', () => {
    localStorage.setItem(LS_KEY, JSON.stringify({ ...DEFAULT_ANALYZER, resolution: 'ultra' }))
    expect(loadAnalyzerSettings().resolution).toBe(DEFAULT_ANALYZER.resolution)
  })

  it('falls back to defaults on malformed JSON', () => {
    localStorage.setItem(LS_KEY, 'not-valid-json{{')
    expect(loadAnalyzerSettings()).toEqual(DEFAULT_ANALYZER)
  })

  it('preserves valid keys when only some keys are invalid', () => {
    localStorage.setItem(LS_KEY, JSON.stringify({ tiltDbPerOct: 6, rangeDb: 999, speed: 'slow', resolution: 'high' }))
    const s = loadAnalyzerSettings()
    expect(s.tiltDbPerOct).toBe(6)                        // valid — kept
    expect(s.rangeDb).toBe(DEFAULT_ANALYZER.rangeDb)      // invalid — defaulted
    expect(s.speed).toBe('slow')                          // valid — kept
    expect(s.resolution).toBe('high')                     // valid — kept
  })

  it('saveAnalyzerSettings round-trips through loadAnalyzerSettings', () => {
    const settings = { tiltDbPerOct: 6, rangeDb: 120, speed: 'slow', resolution: 'maximum' }
    saveAnalyzerSettings(settings)
    expect(loadAnalyzerSettings()).toEqual(settings)
  })
})

describe('eqAnalyzerSettings — mapping constants', () => {
  it('SPEED_DECAY: slow=8, medium=24, fast=48', () => {
    expect(SPEED_DECAY.slow).toBe(8)
    expect(SPEED_DECAY.medium).toBe(24)
    expect(SPEED_DECAY.fast).toBe(48)
  })

  it('RESOLUTION_BARS: low=12, medium=18, high=24, maximum=36', () => {
    expect(RESOLUTION_BARS.low).toBe(12)
    expect(RESOLUTION_BARS.medium).toBe(18)
    expect(RESOLUTION_BARS.high).toBe(24)
    expect(RESOLUTION_BARS.maximum).toBe(36)
  })

  it('TILT_OPTIONS contains exactly [0, 3, 4.5, 6]', () => {
    expect(TILT_OPTIONS).toEqual([0, 3, 4.5, 6])
  })

  it('RANGE_OPTIONS contains exactly [60, 90, 120]', () => {
    expect(RANGE_OPTIONS).toEqual([60, 90, 120])
  })

  it('SPEED_OPTIONS contains exactly the three speed names', () => {
    expect(SPEED_OPTIONS).toEqual(['slow', 'medium', 'fast'])
  })

  it('RESOLUTION_OPTIONS contains exactly the four resolution names', () => {
    expect(RESOLUTION_OPTIONS).toEqual(['low', 'medium', 'high', 'maximum'])
  })

  it('DEFAULT_ANALYZER values are all valid members of their option arrays', () => {
    expect(TILT_OPTIONS).toContain(DEFAULT_ANALYZER.tiltDbPerOct)
    expect(RANGE_OPTIONS).toContain(DEFAULT_ANALYZER.rangeDb)
    expect(SPEED_OPTIONS).toContain(DEFAULT_ANALYZER.speed)
    expect(RESOLUTION_OPTIONS).toContain(DEFAULT_ANALYZER.resolution)
  })
})
