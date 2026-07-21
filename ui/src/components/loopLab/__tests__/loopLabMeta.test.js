// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest'
import {
  deriveBehaviorFamily, autoName, slug, metaIsComplete,
  loadStickyMeta, saveStickyMeta, DEFAULT_STICKY_META,
} from '../loopLabMeta.js'

describe('deriveBehaviorFamily', () => {
  it('maps vocal classes directly', () => {
    expect(deriveBehaviorFamily('Hard-tuned vocal', '')).toBe('stable_periodic')
    expect(deriveBehaviorFamily('Natural vocal', '')).toBe('vibrato_sustained')
  })
  it('maps instruments by name', () => {
    expect(deriveBehaviorFamily('Instrument', 'flute')).toBe('stable_periodic')
    expect(deriveBehaviorFamily('Instrument', 'Organ')).toBe('stable_periodic')
    expect(deriveBehaviorFamily('Instrument', 'violin')).toBe('vibrato_sustained')
    expect(deriveBehaviorFamily('Instrument', 'BRASS')).toBe('vibrato_sustained')
    expect(deriveBehaviorFamily('Instrument', 'piano')).toBe('decaying_struck')
    expect(deriveBehaviorFamily('Instrument', 'guitar')).toBe('decaying_struck')
    expect(deriveBehaviorFamily('Instrument', 'mallets')).toBe('decaying_struck')
  })
  it('falls back to stable_periodic for unknown instruments', () => {
    expect(deriveBehaviorFamily('Instrument', 'theremin')).toBe('stable_periodic')
  })
})

describe('slug + autoName', () => {
  it('slugs free text to lower_snake_case', () => {
    expect(slug('Hard-tuned vocal')).toBe('hard_tuned_vocal')
    expect(slug('  Ep 12 !! ')).toBe('ep_12')
  })
  it('names hard-tuned vocals with class + source + zero-padded index', () => {
    expect(autoName({ className: 'Hard-tuned vocal', source: 'ep12' }, 7))
      .toBe('hard_tuned_vocal_ep12_0007')
  })
  it('uses instrument name as the leading token for instruments', () => {
    expect(autoName({ className: 'Instrument', instrumentName: 'Flute', source: '' }, 1))
      .toBe('flute_0001')
  })
  it('omits an empty source token', () => {
    expect(autoName({ className: 'Natural vocal', source: '' }, 42))
      .toBe('natural_vocal_0042')
  })
})

describe('metaIsComplete', () => {
  it('requires an instrument name only for the Instrument class', () => {
    expect(metaIsComplete({ className: 'Instrument', instrumentName: '' })).toBe(false)
    expect(metaIsComplete({ className: 'Instrument', instrumentName: 'sax' })).toBe(true)
    expect(metaIsComplete({ className: 'Hard-tuned vocal', instrumentName: '' })).toBe(true)
  })
})

describe('sticky metadata persistence', () => {
  beforeEach(() => localStorage.clear())
  it('returns defaults when nothing is stored', () => {
    expect(loadStickyMeta()).toEqual(DEFAULT_STICKY_META)
  })
  it('round-trips through localStorage', () => {
    const meta = { className: 'Instrument', instrumentName: 'cello', source: 'session3' }
    saveStickyMeta(meta)
    expect(loadStickyMeta()).toEqual(meta)
  })
  it('rejects an invalid class and coerces bad fields', () => {
    localStorage.setItem('xleth.loopLab.stickyMeta.v1',
      JSON.stringify({ className: 'Bogus', instrumentName: 5, source: null }))
    const loaded = loadStickyMeta()
    expect(loaded.className).toBe(DEFAULT_STICKY_META.className)
    expect(loaded.instrumentName).toBe('')
    expect(loaded.source).toBe('')
  })
})
