import { describe, it, expect } from 'vitest'
import {
  SCALE_MODES,
  scalePitchClasses,
  isPitchInScale,
  snapPitchToScale,
  nextScalePitch,
} from '../scales.js'

describe('scale mode table', () => {
  it('ships the seven diatonic modes the toolbar offers', () => {
    expect(SCALE_MODES.map((m) => m.id)).toEqual([
      'ionian', 'dorian', 'phrygian', 'lydian', 'mixolydian', 'aeolian', 'locrian',
    ])
  })

  it('gives every mode exactly seven distinct pitch classes', () => {
    for (const mode of SCALE_MODES) {
      const pcs = scalePitchClasses(0, mode.id)
      expect(pcs).toHaveLength(7)
      expect(new Set(pcs).size).toBe(7)
    }
  })

  it('places each mode on its textbook degrees', () => {
    // C Ionian is the white keys.
    expect(scalePitchClasses(0, 'ionian').sort((a, b) => a - b)).toEqual([0, 2, 4, 5, 7, 9, 11])
    // A Aeolian is also the white keys — the relative-minor identity.
    expect(scalePitchClasses(9, 'aeolian').sort((a, b) => a - b)).toEqual([0, 2, 4, 5, 7, 9, 11])
    // D Dorian, likewise.
    expect(scalePitchClasses(2, 'dorian').sort((a, b) => a - b)).toEqual([0, 2, 4, 5, 7, 9, 11])
    // Lydian's identity is the raised 4th; Mixolydian's is the flat 7th.
    expect(scalePitchClasses(0, 'lydian')).toContain(6)
    expect(scalePitchClasses(0, 'mixolydian')).toContain(10)
    // Phrygian's flat 2nd and Locrian's flat 5th.
    expect(scalePitchClasses(0, 'phrygian')).toContain(1)
    expect(scalePitchClasses(0, 'locrian')).toContain(6)
    expect(scalePitchClasses(0, 'locrian')).not.toContain(7)
  })
})

describe('isPitchInScale', () => {
  it('is octave-invariant', () => {
    expect(isPitchInScale(60, 0, 'ionian')).toBe(true)   // C4
    expect(isPitchInScale(72, 0, 'ionian')).toBe(true)   // C5
    expect(isPitchInScale(61, 0, 'ionian')).toBe(false)  // C#4
  })

  it('follows the root', () => {
    expect(isPitchInScale(61, 1, 'ionian')).toBe(true)   // C# is the root of C# major
    // D natural is not in C# major (which has C# and D#). C natural IS — it is
    // that scale's leading tone, spelled B#.
    expect(isPitchInScale(62, 1, 'ionian')).toBe(false)
    expect(isPitchInScale(60, 1, 'ionian')).toBe(true)
  })
})

describe('snapPitchToScale', () => {
  it('leaves in-scale pitches untouched', () => {
    expect(snapPitchToScale(64, 0, 'ionian')).toBe(64)
  })

  it('resolves a whole-tone gap downward', () => {
    // C#4 sits between C4 and D4 in C major — both one semitone away.
    expect(snapPitchToScale(61, 0, 'ionian')).toBe(60)
  })

  it('never returns an out-of-scale pitch', () => {
    for (const mode of SCALE_MODES) {
      for (let p = 0; p < 128; p++) {
        expect(isPitchInScale(snapPitchToScale(p, 3, mode.id), 3, mode.id)).toBe(true)
      }
    }
  })

  it('stays inside the supplied range', () => {
    expect(snapPitchToScale(20, 0, 'ionian', 60, 72)).toBeGreaterThanOrEqual(60)
    expect(snapPitchToScale(120, 0, 'ionian', 60, 72)).toBeLessThanOrEqual(72)
  })
})

describe('nextScalePitch', () => {
  it('always moves off the starting pitch', () => {
    // E4 (64) up in C major is F4 (65) — a semitone step that is in scale.
    expect(nextScalePitch(64, 1, 0, 'ionian')).toBe(65)
    // C4 (60) up in C major skips C#4 and lands on D4 (62).
    expect(nextScalePitch(60, 1, 0, 'ionian')).toBe(62)
    // ...and down lands on B3 (59).
    expect(nextScalePitch(60, -1, 0, 'ionian')).toBe(59)
  })

  it('walks a full octave in seven steps', () => {
    let p = 60
    for (let i = 0; i < 7; i++) p = nextScalePitch(p, 1, 0, 'ionian')
    expect(p).toBe(72)
  })

  it('holds at the range bound instead of running away', () => {
    expect(nextScalePitch(72, 1, 0, 'ionian', 60, 72)).toBe(72)
  })
})
