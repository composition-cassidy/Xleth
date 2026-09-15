import { describe, expect, it } from 'vitest'
import { findMatchingSample, gmDrumName, normalizeName, scoreName } from './filenameMatch.js'

describe('normalizeName', () => {
  it('lowercases, strips punctuation, and collapses whitespace', () => {
    expect(normalizeName('Acoustic Snare')).toBe('acoustic snare')
    expect(normalizeName('acoustic-snare')).toBe('acoustic snare')
    expect(normalizeName('Acoustic  Snare!!')).toBe('acoustic snare')
    expect(normalizeName('  Kick_1  ')).toBe('kick 1')
  })

  it('handles nullish input without throwing', () => {
    expect(normalizeName(null)).toBe('')
    expect(normalizeName(undefined)).toBe('')
    expect(normalizeName('')).toBe('')
  })
})

describe('gmDrumName (unchanged API)', () => {
  it('resolves note numbers 35-81 and returns null outside that range', () => {
    expect(gmDrumName(38)).toBe('Acoustic Snare')
    expect(gmDrumName(81)).toBe('Open Triangle')
    expect(gmDrumName(34)).toBe(null)
    expect(gmDrumName(82)).toBe(null)
  })
})

describe('scoreName tiers', () => {
  it('scores an exact normalized match highest', () => {
    expect(scoreName('Snare', 'snare')).toBeGreaterThan(scoreName('Snare', 'Snare 1'))
  })

  it('scores a prefix match above a plain substring match', () => {
    const prefixScore = scoreName('Snare', 'Snare 1')       // candidate starts with query
    const substringScore = scoreName('nare', 'Acoustic Snare') // buried substring, no word boundary
    expect(prefixScore).toBeGreaterThan(substringScore)
  })

  it('scores a word-boundary match above a non-boundary substring match', () => {
    const wordScore = scoreName('Acoustic Snare', 'My Snare Sample') // "snare" is a whole word
    const substringScore = scoreName('nare', 'Acoustic Snare')
    expect(wordScore).toBeGreaterThan(substringScore)
  })

  it('rejects unrelated names with a zero score', () => {
    expect(scoreName('Lead Synth', 'Kick 1')).toBe(0)
  })

  it('guards short queries from cheaply scoring a substring match', () => {
    // "1" is a substring of "Snare 1" but far too short/low-signal to trust.
    expect(scoreName('1', 'Snare 1')).toBeLessThan(50)
  })
})

describe('GM alias resolution', () => {
  it('resolves snare aliases onto a differently-named user region', () => {
    expect(scoreName('Acoustic Snare', 'Snare 1')).toBeGreaterThanOrEqual(50)
    expect(scoreName('Electric Snare', 'Snare 1')).toBeGreaterThanOrEqual(50)
  })

  it('resolves kick aliases', () => {
    expect(scoreName('Acoustic Bass Drum', 'Kick')).toBeGreaterThanOrEqual(50)
    expect(scoreName('Bass Drum 1', 'Kick')).toBeGreaterThanOrEqual(50)
  })

  it('resolves hi-hat aliases across open/closed/pedal variants', () => {
    expect(scoreName('Closed Hi-Hat', 'HiHat Closed')).toBeGreaterThanOrEqual(50)
    expect(scoreName('Open Hi-Hat', 'Hi Hat Open')).toBeGreaterThanOrEqual(50)
    expect(scoreName('Pedal Hi-Hat', 'Hihat')).toBeGreaterThanOrEqual(50)
  })

  it('resolves hand clap', () => {
    expect(scoreName('Hand Clap', 'Clap 1')).toBeGreaterThanOrEqual(50)
  })

  it('resolves tom variants onto a generic "tom" region', () => {
    for (const gm of ['Low Floor Tom', 'High Floor Tom', 'Low Tom', 'Low-Mid Tom', 'Hi-Mid Tom', 'High Tom']) {
      expect(scoreName(gm, 'Tom 1')).toBeGreaterThanOrEqual(50)
    }
  })

  it('resolves crash, ride, and cowbell', () => {
    expect(scoreName('Crash Cymbal 1', 'Crash')).toBeGreaterThanOrEqual(50)
    expect(scoreName('Ride Cymbal 2', 'Ride')).toBeGreaterThanOrEqual(50)
    expect(scoreName('Cowbell', 'Cowbell')).toBe(100)
  })
})

describe('findMatchingSample', () => {
  it('picks the highest-scoring region', () => {
    const regions = [
      { id: 1, name: 'Snare' },
      { id: 2, name: 'Snare 1' },
    ]
    // Exact match beats prefix match.
    expect(findMatchingSample('Snare', regions).id).toBe(1)
  })

  it('ties break by shortest name, then lowest id', () => {
    const regions = [
      { id: 5, name: 'Kick Drum' },
      { id: 2, name: 'Kick' },
      { id: 3, name: 'Kick' },
    ]
    // "Kick" (id 2) and "Kick" (id 3) both score exact and tie on name length;
    // id 2 wins. "Kick Drum" is a longer exact-prefix, so it loses the tie.
    expect(findMatchingSample('Kick', regions).id).toBe(2)
  })

  it('returns null below the minimum score threshold instead of guessing', () => {
    const regions = [{ id: 1, name: 'Lead Synth' }]
    expect(findMatchingSample('Kick', regions)).toBe(null)
  })

  it('returns null for an empty region list or missing name', () => {
    expect(findMatchingSample('Kick', [])).toBe(null)
    expect(findMatchingSample('', [{ id: 1, name: 'Kick' }])).toBe(null)
  })

  it('ignores regions without a name', () => {
    const regions = [{ id: 1, name: '' }, { id: 2, name: null }, { id: 3, name: 'Kick' }]
    expect(findMatchingSample('Kick', regions).id).toBe(3)
  })
})
