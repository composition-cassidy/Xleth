import { describe, it, expect } from 'vitest'
import { parseChordNotation } from './chordNotationParser'

const SIXTEENTH = 240

function pitches(result: ReturnType<typeof parseChordNotation>) {
  return result.placements.map((p) => p.pitch)
}

describe('parseChordNotation — quality table', () => {
  it('plain root with no quality defaults to major', () => {
    expect(pitches(parseChordNotation('C', 0))).toEqual([60, 64, 67])
  })

  it.each([
    ['CM', [60, 64, 67]],
    ['CΔ', [60, 64, 67]],
    ['Cmin', [60, 63, 67]],
    ['Cm', [60, 63, 67]],
    ['Cmi', [60, 63, 67]],
    ['C-', [60, 63, 67]],
    ['Cdim', [60, 63, 66]],
    ['Co', [60, 63, 66]],
    ['Caug', [60, 64, 68]],
    ['C+', [60, 64, 68]],
    ['Csus2', [60, 62, 67]],
    ['Csus4', [60, 65, 67]],
    ['Csus', [60, 65, 67]],
    ['C5', [60, 67]],
    ['C6', [60, 64, 67, 69]],
    ['Cm6', [60, 63, 67, 69]],
    ['Cmin6', [60, 63, 67, 69]],
    ['C6/9', [60, 64, 67, 69, 74]],
    ['C7', [60, 64, 67, 70]],
    ['Cmaj7', [60, 64, 67, 71]],
    ['CM7', [60, 64, 67, 71]],
    ['CΔ7', [60, 64, 67, 71]],
    ['Cmin7', [60, 63, 67, 70]],
    ['Cm7', [60, 63, 67, 70]],
    ['C-7', [60, 63, 67, 70]],
    ['Cm(maj7)', [60, 63, 67, 71]],
    ['Cmin(maj7)', [60, 63, 67, 71]],
    ['Cdim7', [60, 63, 66, 69]],
    ['Co7', [60, 63, 66, 69]],
    ['Cm7b5', [60, 63, 66, 70]],
    ['Cø', [60, 63, 66, 70]],
    ['Cø7', [60, 63, 66, 70]],
    ['Caug7', [60, 64, 68, 70]],
    ['C7#5', [60, 64, 68, 70]],
    ['C+7', [60, 64, 68, 70]],
    ['C7sus4', [60, 65, 67, 70]],
    ['Cadd9', [60, 64, 67, 74]],
    ['Cmadd9', [60, 63, 67, 74]],
    ['Cadd11', [60, 64, 67, 77]],
    ['Cadd4', [60, 64, 67, 77]],
  ])('%s -> %j', (token, expected) => {
    expect(pitches(parseChordNotation(token, 0))).toEqual(expected)
  })
})

describe('parseChordNotation — extensions (composed onto a third+seventh shell, not table rows)', () => {
  it.each([
    ['C9', [60, 64, 67, 70, 74]],
    ['C11', [60, 67, 70, 74, 77]],
    ['C13', [60, 64, 70, 74, 81]],
    ['Cmaj9', [60, 64, 67, 71, 74]],
    ['Cmin9', [60, 63, 67, 70, 74]],
    // min11 keeps the 3rd (no clash with a natural 11th the way maj3 has) —
    // this combo was never in the flat table and is the regression this
    // fix targets: it must fall out of the same shell composition as the
    // others, not need its own hardcoded row.
    ['Cmin11', [60, 63, 67, 70, 74, 77]],
    ['Cmaj13', [60, 64, 71, 74, 81]],
    ['Cmin13', [60, 63, 70, 74, 81]],
  ])('%s -> %j', (token, expected) => {
    const result = parseChordNotation(token, 0)
    expect(result.errors).toEqual([])
    expect(pitches(result)).toEqual(expected)
  })

  it('maj9 wins over the shorter "maj" quality match', () => {
    // If "maj" matched greedily first this would leave a stray "9" and fail.
    expect(pitches(parseChordNotation('Cmaj9', 0))).toEqual([60, 64, 67, 71, 74])
  })

  it('an alteration composes on top of an extension exactly as it would on a table quality', () => {
    // 13 = [0,4,10,14,21]; (b9) replaces the 9th (14) with a flat 9th (13).
    expect(pitches(parseChordNotation('C13(b9)', 0))).toEqual([60, 64, 70, 73, 81])
  })
})

describe('parseChordNotation — extensions acceptance', () => {
  it('C9* -> C4 E4 G4 Bb4 D5', () => {
    const result = parseChordNotation('C9*', 0)
    expect(result.errors).toEqual([])
    expect(pitches(result)).toEqual([60, 64, 67, 70, 74])
  })

  it('C13* -> C4 E4 Bb4 D5 A5', () => {
    const result = parseChordNotation('C13*', 0)
    expect(result.errors).toEqual([])
    expect(pitches(result)).toEqual([60, 64, 70, 74, 81])
  })

  it('Cmaj9* -> C4 E4 G4 B4 D5', () => {
    const result = parseChordNotation('Cmaj9*', 0)
    expect(result.errors).toEqual([])
    expect(pitches(result)).toEqual([60, 64, 67, 71, 74])
  })

  it('Cmin11* -> C4 Eb4 G4 Bb4 D5 F5', () => {
    const result = parseChordNotation('Cmin11*', 0)
    expect(result.errors).toEqual([])
    expect(pitches(result)).toEqual([60, 63, 67, 70, 74, 77])
  })

  it('C13(b9)* -> C4 E4 Bb4 Db5 A5', () => {
    const result = parseChordNotation('C13(b9)*', 0)
    expect(result.errors).toEqual([])
    expect(pitches(result)).toEqual([60, 64, 70, 73, 81])
  })

  it('C9z* -> nothing inserted, error names the token', () => {
    const result = parseChordNotation('C9z*', 0)
    expect(result.placements).toEqual([])
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0].token).toBe('C9z*')
  })
})

describe('parseChordNotation — alterations', () => {
  it('(b5) replaces the natural 5th', () => {
    expect(pitches(parseChordNotation('C(b5)', 0))).toEqual([60, 64, 66])
  })

  it('(#5) replaces the natural 5th', () => {
    expect(pitches(parseChordNotation('C(#5)', 0))).toEqual([60, 64, 68])
  })

  it('(#11) adds a degree the base formula lacks (13 omits the 11th)', () => {
    expect(pitches(parseChordNotation('C13(#11)', 0))).toEqual([60, 64, 70, 74, 78, 81])
  })

  it('(b9) replaces an existing 9th', () => {
    expect(pitches(parseChordNotation('C9(b9)', 0))).toEqual([60, 64, 67, 70, 73])
  })

  it('(b13) adds a 13th onto a 9 chord that lacks one', () => {
    expect(pitches(parseChordNotation('C9(b13)', 0))).toEqual([60, 64, 67, 70, 74, 80])
  })

  it('stacks multiple alterations left to right', () => {
    expect(pitches(parseChordNotation('C7(#9)(b13)', 0))).toEqual([60, 64, 67, 70, 75, 80])
  })
})

describe('parseChordNotation — slash bass', () => {
  it('rotates a chord tone below the root (Cmaj7/E)', () => {
    // maj7 = C4 E4 G4 B4 (60,64,67,71); E is already in the chord -> drops
    // to E3 (52) and becomes the lowest note, everything else unchanged.
    expect(pitches(parseChordNotation('Cmaj7/E', 0))).toEqual([52, 60, 67, 71])
  })

  it('rotates correctly even when the bass is more than an octave up the stack (C13/A)', () => {
    // 13 = [0,4,10,14,21]; A is the 13th itself (interval 21). Naive "-12"
    // would leave it above the root — must fold back below C4 first.
    expect(pitches(parseChordNotation('C13/A', 0))).toEqual([57, 60, 64, 70, 74])
  })

  it('adds a note one octave below the root when the bass is not a chord tone (C/D)', () => {
    expect(pitches(parseChordNotation('C/D', 0))).toEqual([50, 60, 64, 67])
  })

  it('is a no-op when the bass equals the root (C/C)', () => {
    expect(pitches(parseChordNotation('C/C', 0))).toEqual([60, 64, 67])
  })

  it('does not confuse the "6/9" quality name with slash-bass syntax', () => {
    expect(pitches(parseChordNotation('C6/9', 0))).toEqual([60, 64, 67, 69, 74])
  })

  it('still parses a real slash bass after a plain "6" quality (C6/E)', () => {
    // 6 = [0,4,7,9]; E is the 3rd (interval 4) — rotates below the root,
    // it isn't duplicated, so only 4 notes come out.
    expect(pitches(parseChordNotation('C6/E', 0))).toEqual([52, 60, 67, 69])
  })
})

describe('parseChordNotation — roots with accidentals', () => {
  it('sharp root', () => {
    expect(pitches(parseChordNotation('C#', 0))).toEqual([61, 65, 68])
  })

  it('flat root', () => {
    expect(pitches(parseChordNotation('Db', 0))).toEqual([61, 65, 68])
  })

  it('matches the Sparta Remix progression roots (Dmin7 - D#maj7 - Cmin7 - D#maj7)', () => {
    const result = parseChordNotation('Dmin7 D#maj7 Cmin7 D#maj7', 0)
    expect(result.errors).toEqual([])
    // Each token's first (root) pitch:
    const roots = [result.placements[0], result.placements[4], result.placements[8], result.placements[12]]
      .map((p) => p.pitch)
    expect(roots).toEqual([62, 63, 60, 63])
  })
})

describe('parseChordNotation — literal note mode', () => {
  it('reads a plain uppercase sequence as separate natural notes', () => {
    expect(pitches(parseChordNotation('CEGB', 0))).toEqual([60, 64, 67, 71])
  })

  it('treats a trailing lowercase b as a flat accidental, not the letter B — and it sorts below C4, not up at B4', () => {
    // Cb is one semitone BELOW C4 (=59, B3), not the same pitch class
    // wrapped up into octave 4 (=71, B4).
    expect(pitches(parseChordNotation('CEGCb', 0))).toEqual([59, 60, 64, 67])
  })

  it('places letters in pitch order regardless of typed order (typed order carries no musical meaning)', () => {
    expect(pitches(parseChordNotation('GCE', 0))).toEqual([60, 64, 67])
    expect(pitches(parseChordNotation('CEBG', 0))).toEqual([60, 64, 67, 71])
    expect(pitches(parseChordNotation('CEBG', 0))).toEqual(pitches(parseChordNotation('GCEB', 0)))
  })

  it('applies duration suffix the same as a chord token', () => {
    const result = parseChordNotation('CEGB***', 0)
    expect(result.placements.every((p) => p.lengthTicks === SIXTEENTH * 8)).toBe(true)
  })
})

describe('parseChordNotation — parse order (chord wins over literal)', () => {
  it('parses "CEG" as a chord (major triad), not three literal notes with a coincidentally identical result', () => {
    // Both interpretations happen to agree numerically for a bare major
    // triad; the real test is that "Cm" parses as the min quality and NOT
    // as literal notes C + (invalid letter "m").
    const result = parseChordNotation('Cm', 0)
    expect(result.errors).toEqual([])
    expect(pitches(result)).toEqual([60, 63, 67])
  })
})

describe('parseChordNotation — duration semantics match sample tokens', () => {
  it('no suffix = 16th note', () => {
    expect(parseChordNotation('C', 0).placements[0].lengthTicks).toBe(SIXTEENTH)
  })

  it('* = 8th, ** = quarter, *** = 2 beats (half note)', () => {
    expect(parseChordNotation('C*', 0).placements[0].lengthTicks).toBe(SIXTEENTH * 2)
    expect(parseChordNotation('C**', 0).placements[0].lengthTicks).toBe(SIXTEENTH * 4)
    expect(parseChordNotation('C***', 0).placements[0].lengthTicks).toBe(SIXTEENTH * 8)
  })
})

describe('parseChordNotation — multi-token sequencing', () => {
  it('advances the tick cursor by each token\'s duration, in order', () => {
    const result = parseChordNotation('C* Dmin**', 100)
    const cTicks = result.placements.filter((p) => p.startTick === 100)
    expect(cTicks.length).toBe(3) // C major triad
    const dTicks = result.placements.filter((p) => p.startTick === 100 + SIXTEENTH * 2)
    expect(dTicks.length).toBe(3) // D minor triad
    expect(result.totalTicks).toBe(SIXTEENTH * 2 + SIXTEENTH * 4)
  })
})

describe('parseChordNotation — hard errors are atomic (insert nothing on any failure)', () => {
  it('names the offending token instead of guessing, and voids the whole batch even though an earlier token was valid', () => {
    const result = parseChordNotation('Cmaj7 Xyz123', 0)
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0].token).toBe('Xyz123')
    // Atomic per INSERT: one bad token means nothing is placed, even
    // though "Cmaj7" alone would have parsed fine.
    expect(result.placements).toEqual([])
  })

  it('names every failing token, not just the first', () => {
    const result = parseChordNotation('Cmaj7 Xyz123 Dmin Abc456', 0)
    expect(result.errors.map((e) => e.token)).toEqual(['Xyz123', 'Abc456'])
    expect(result.placements).toEqual([])
  })

  it('rejects a lowercase root (root letters must be uppercase A-G)', () => {
    const result = parseChordNotation('cmaj7', 0)
    expect(result.errors).toHaveLength(1)
    expect(result.placements).toEqual([])
  })

  it('rejects trailing garbage after a valid chord body', () => {
    const result = parseChordNotation('Cmaj7zzz', 0)
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0].token).toBe('Cmaj7zzz')
    expect(result.placements).toEqual([])
  })
})

describe('parseChordNotation — comma-separated tokens (acceptance)', () => {
  it('treats commas as delimiters, with or without surrounding spaces', () => {
    const withSpaces = parseChordNotation('Cmaj7***, CEGCb***, F#dim7*', 0)
    const noSpaces = parseChordNotation('Cmaj7***,CEGCb***,F#dim7*', 0)
    expect(withSpaces.errors).toEqual([])
    expect(noSpaces.errors).toEqual([])
    expect(withSpaces.placements).toEqual(noSpaces.placements)
  })

  it('places 3 sequential, non-overlapping chords with zero silent skips', () => {
    const result = parseChordNotation('Cmaj7***, CEGCb***, F#dim7*', 0)
    expect(result.errors).toEqual([])

    const eighthNote = SIXTEENTH * 2
    const halfNote = SIXTEENTH * 8
    // Cmaj7*** (half note, 4 notes) at tick 0
    const chord1 = result.placements.filter((p) => p.startTick === 0)
    expect(chord1.map((p) => p.pitch).sort((a, b) => a - b)).toEqual([60, 64, 67, 71])
    expect(chord1.every((p) => p.lengthTicks === halfNote)).toBe(true)

    // CEGCb*** (half note, 4 notes) immediately after, no overlap
    const chord2 = result.placements.filter((p) => p.startTick === halfNote)
    expect(chord2.map((p) => p.pitch).sort((a, b) => a - b)).toEqual([59, 60, 64, 67])

    // F#dim7* (eighth note, 4 notes) immediately after that
    const chord3 = result.placements.filter((p) => p.startTick === halfNote * 2)
    expect(chord3).toHaveLength(4)
    expect(chord3.every((p) => p.lengthTicks === eighthNote)).toBe(true)

    expect(result.totalTicks).toBe(halfNote * 2 + eighthNote)
  })

  it('does not silently drop a comma-terminated token', () => {
    // Regression: the tokenizer previously only split on whitespace, so a
    // trailing "," left on a token made the whole token fail to parse and
    // vanish with no error.
    const dropped = parseChordNotation('Cmaj7***,', 0)
    expect(dropped.errors).toEqual([])
    expect(pitches(dropped)).toEqual([60, 64, 67, 71])
  })
})

describe('parseChordNotation — literal mode acceptance (pitch order, not input order)', () => {
  it('CEBG*** -> C4 E4 G4 B4', () => {
    const result = parseChordNotation('CEBG***', 0)
    expect(result.errors).toEqual([])
    expect(pitches(result)).toEqual([60, 64, 67, 71])
  })
})

describe('parseChordNotation — invalid token blocks the whole insert', () => {
  it('Cmaj9z*** -> nothing inserted, error names the exact literal token', () => {
    const result = parseChordNotation('Cmaj9z***', 0)
    expect(result.placements).toEqual([])
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0].token).toBe('Cmaj9z***')
  })
})
