// Chord-token extension to Quick Notation, for the Piano Roll.
//
// Grammar: ROOT QUALITY? EXTENSION? ALTERATION* ("/" BASS)? DURATION
//   ROOT        letter A-G, optional accidentals (# or lowercase b)
//   QUALITY     static lookup, see QUALITIES below
//   EXTENSION   9 / 11 / 13, optionally prefixed "maj"/"min" (maj9, min11,
//               maj13, ...) — COMPOSED onto a third+seventh "shell" per
//               quality prefix (see EXTENSION_SHELLS), not a table of
//               precomputed voicings, so a new quality needs one shell
//               entry rather than three new interval arrays. Looked up the
//               same way as QUALITY (longest match wins, "maj9" beats "maj")
//   ALTERATION  "(b5)" "(#5)" "(b9)" "(#9)" "(#11)" "(b13)" — replaces or
//               adds that scale degree on the resolved formula (quality or
//               extension, alterations don't care which)
//   BASS        letter A-G + accidentals; rotates the voicing or adds a
//               note one octave below the root
//   DURATION    trailing "*" run, identical semantics to sample tokens
//
// A token that fails the chord grammar falls back to a literal note
// sequence (greedy letter+accidental reads, e.g. "CEGCb" = C, E, G, Cb),
// placed in pitch order from the default octave — typed order carries no
// musical meaning. If neither parses, the token is a hard error — never
// guessed.
//
// Tokens are delimited by whitespace and/or commas. Insertion is atomic per
// INSERT: if any token in the string fails to parse, the whole batch is
// void (nothing is placed) and every failing token is reported by name —
// never a silent partial insert.
//
// Pure function: token string in, note events out. The audio engine never
// learns what a chord is.

import { TICKS_PER_16TH } from './notationParser.js'

export interface ChordPlacement {
  pitch: number
  startTick: number
  lengthTicks: number
}

export interface ChordParseError {
  token: string
  position: number
  reason: string
}

export interface ChordParseResult {
  placements: ChordPlacement[]
  errors: ChordParseError[]
  totalTicks: number
}

interface TokenParse {
  pitches: number[]
  durationTicks: number
}

const ROOT_OCTAVE_PITCH = 60 // C4 — default chord/note root octave

const NOTE_BASE_PC: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 }

// name/alias -> interval formula (semitones from root). Table qualities
// only — 9/11/13 extensions are composed below, not enumerated here.
const QUALITIES: Array<{ names: string[]; intervals: number[] }> = [
  { names: ['maj', 'M', 'Δ', ''],           intervals: [0, 4, 7] },
  { names: ['min', 'm', 'mi', '-'],         intervals: [0, 3, 7] },
  { names: ['dim', 'o'],                    intervals: [0, 3, 6] },
  { names: ['aug', '+'],                    intervals: [0, 4, 8] },
  { names: ['sus2'],                        intervals: [0, 2, 7] },
  { names: ['sus4', 'sus'],                 intervals: [0, 5, 7] },
  { names: ['5'],                           intervals: [0, 7] },
  { names: ['6'],                           intervals: [0, 4, 7, 9] },
  { names: ['m6', 'min6'],                  intervals: [0, 3, 7, 9] },
  { names: ['6/9'],                         intervals: [0, 4, 7, 9, 14] },
  { names: ['7'],                           intervals: [0, 4, 7, 10] },
  { names: ['maj7', 'M7', 'Δ7'],            intervals: [0, 4, 7, 11] },
  { names: ['min7', 'm7', '-7'],            intervals: [0, 3, 7, 10] },
  { names: ['m(maj7)', 'min(maj7)'],        intervals: [0, 3, 7, 11] },
  { names: ['dim7', 'o7'],                  intervals: [0, 3, 6, 9] },
  { names: ['m7b5', 'ø', 'ø7'],             intervals: [0, 3, 6, 10] },
  { names: ['aug7', '7#5', '+7'],           intervals: [0, 4, 8, 10] },
  { names: ['7sus4'],                       intervals: [0, 5, 7, 10] },
  { names: ['add9'],                        intervals: [0, 4, 7, 14] },
  { names: ['madd9'],                       intervals: [0, 3, 7, 14] },
  { names: ['add11', 'add4'],               intervals: [0, 4, 7, 17] },
]

// Extensions compose onto a third+seventh "shell" chosen by the (optional)
// quality prefix — this is the anti-combinatorial-explosion design: a new
// quality needs one {third, seventh} entry here, not a new interval array
// per degree. Jazz voicing convention:
//   - 9th:  never omits anything (root, 3rd, 5th, 7th, 9th).
//   - 11th: omits the 3rd UNLESS the shell is minor — a minor 3rd doesn't
//     clash with a natural 11th the way a major 3rd does.
//   - 13th: always omits the 5th and the 11th (standard jazz "13" voicing).
const EXTENSION_SHELLS: Array<{ prefix: string; third: number; seventh: number }> = [
  { prefix: '',    third: 4, seventh: 10 }, // bare digit = dominant shell
  { prefix: 'maj', third: 4, seventh: 11 },
  { prefix: 'min', third: 3, seventh: 10 },
]

function buildExtensionFormula(third: number, seventh: number, degree: 9 | 11 | 13): number[] {
  if (degree === 9) return [0, third, 7, seventh, 14]
  if (degree === 11) return third === 3 ? [0, third, 7, seventh, 14, 17] : [0, 7, seventh, 14, 17]
  return [0, third, seventh, 14, 21] // 13th: always omits the 5th and 11th
}

const EXTENSION_LOOKUP: Array<[string, number[]]> = EXTENSION_SHELLS.flatMap(({ prefix, third, seventh }) =>
  ([9, 11, 13] as const).map((degree): [string, number[]] => [
    `${prefix}${degree}`,
    buildExtensionFormula(third, seventh, degree),
  ]))

// Flattened and sorted longest-key-first so e.g. "6/9" beats "6", "maj9"
// beats "maj", and "sus2" beats "sus" — plain greedy longest-prefix match.
// Quality and extension keys never collide (different literal strings), so
// they can share one lookup with no phase distinction at parse time.
const QUALITY_LOOKUP: Array<[string, number[]]> = QUALITIES
  .flatMap(({ names, intervals }) => names.map((name): [string, number[]] => [name, intervals]))
  .concat(EXTENSION_LOOKUP)
  .sort((a, b) => b[0].length - a[0].length)

// Alterations replace any existing tone in `family` with `value`, or add
// `value` if the formula doesn't already contain one of that family.
const ALTERATIONS: Record<string, { family: number[]; value: number }> = {
  'b5':  { family: [6, 7, 8],     value: 6 },
  '#5':  { family: [6, 7, 8],     value: 8 },
  'b9':  { family: [13, 14, 15],  value: 13 },
  '#9':  { family: [13, 14, 15],  value: 15 },
  '#11': { family: [17, 18],      value: 18 },
  'b13': { family: [20, 21],      value: 20 },
}

function normalizePc(n: number): number {
  return ((n % 12) + 12) % 12
}

// Reads one ROOT-shaped note (uppercase A-G + zero or more #/b accidentals)
// starting at `i`. Used for both the chord root and the slash-bass note.
// `semitone` is the UNWRAPPED base+accidental offset (e.g. Cb = -1, B# =
// 12) — the absolute pitch anchor, so a flat can actually reach below the
// octave it's spelled in instead of wrapping back up to the top of it.
// `pc` is that same value normalized to 0-11, for pitch-CLASS comparisons
// (does this pitch class already appear in the formula?) which are
// legitimately modular and must stay octave-independent.
function readRoot(str: string, i: number): { pc: number; semitone: number; next: number } | null {
  const base = NOTE_BASE_PC[str[i]]
  if (base === undefined) return null
  let offset = 0
  let j = i + 1
  while (j < str.length && (str[j] === '#' || str[j] === 'b')) {
    offset += str[j] === '#' ? 1 : -1
    j++
  }
  const semitone = base + offset
  return { pc: normalizePc(semitone), semitone, next: j }
}

function parseChordToken(token: string): TokenParse | null {
  const root = readRoot(token, 0)
  if (!root) return null
  let i = root.next

  let formula: number[] | null = null
  for (const [key, intervals] of QUALITY_LOOKUP) {
    if (token.startsWith(key, i)) {
      formula = intervals.slice()
      i += key.length
      break
    }
  }
  if (formula === null) return null // unreachable: '' always matches

  while (token[i] === '(') {
    const close = token.indexOf(')', i)
    if (close === -1) return null
    const alt = ALTERATIONS[token.slice(i + 1, close)]
    if (!alt) return null
    formula = formula.filter((iv) => !alt.family.includes(iv))
    if (!formula.includes(alt.value)) formula.push(alt.value)
    i = close + 1
  }

  if (token[i] === '/') {
    const bass = readRoot(token, i + 1)
    if (!bass) return null
    i = bass.next
    const matchIdx = formula.findIndex((iv) => normalizePc(root.pc + iv) === bass.pc)
    if (matchIdx === -1) {
      // Not a chord tone: add it one octave below the root.
      formula.push(bass.pc - root.pc - 12)
    } else if (formula[matchIdx] !== 0) {
      // Already a chord tone (and not the root itself): rotate it below
      // the root so it becomes the lowest note, however high up the
      // stack it started (e.g. the 13th of a 13-chord).
      const k = formula[matchIdx]
      formula.splice(matchIdx, 1)
      formula.push((k % 12) - 12)
    }
    // bass === root (k === 0): already the lowest tone, nothing to do.
  }

  let starCount = 0
  while (token[i] === '*') { starCount++; i++ }
  if (i !== token.length) return null // leftover garbage — not a valid chord token

  const rootPitch = ROOT_OCTAVE_PITCH + root.semitone
  const pitches = Array.from(new Set(formula.map((iv) => rootPitch + iv))).sort((a, b) => a - b)
  return { pitches, durationTicks: TICKS_PER_16TH * Math.pow(2, starCount) }
}

// Fallback for tokens that aren't chord symbols: a bare sequence of note
// letters, e.g. "CEGB" or "CEGCb". Accidentals are lowercase-only (`b`) so
// "B" (the letter) and "b" (flat) never collide — "CEGCb" reads C, E, G,
// Cb, not C, E, G, C, B.
//
// Each letter resolves to its own absolute pitch at the default octave
// (Cb = B3, one semitone below C4 — not "wrap up to B4"), and the result is
// sorted ascending by pitch. Typed order carries no musical meaning: "CEBG"
// and "GCEB" place the identical stack, C4·E4·G4·B4.
function parseLiteralNoteToken(token: string): TokenParse | null {
  let end = token.length
  let starCount = 0
  while (end > 0 && token[end - 1] === '*') { starCount++; end-- }
  const lettersPart = token.slice(0, end)
  if (lettersPart.length === 0) return null

  const pitches: number[] = []
  let i = 0
  while (i < lettersPart.length) {
    const note = readRoot(lettersPart, i)
    if (!note) return null
    pitches.push(ROOT_OCTAVE_PITCH + note.semitone)
    i = note.next
  }

  pitches.sort((a, b) => a - b)

  return { pitches, durationTicks: TICKS_PER_16TH * Math.pow(2, starCount) }
}

/**
 * Parse a Quick Notation string of chord/note tokens — delimited by
 * whitespace and/or commas, in any mix — into note placements for the
 * Piano Roll, starting at `cursorTick`.
 *
 * Parse order per token: chord symbol first, then literal note sequence,
 * then a hard error naming the token — chord parsing never silently falls
 * back and guesses wrong notes.
 *
 * Every token in the string is checked (so every bad token gets named, not
 * just the first), but insertion is atomic: if any token fails, the
 * returned `placements` is empty — a typo must never place a partial
 * progression that looks complete.
 */
export function parseChordNotation(str: string, cursorTick: number): ChordParseResult {
  const placements: ChordPlacement[] = []
  const errors: ChordParseError[] = []
  let tick = cursorTick
  let searchFrom = 0

  const tokens = str.split(/[\s,]+/).filter((t) => t.length > 0)
  for (const token of tokens) {
    const position = str.indexOf(token, searchFrom)
    searchFrom = position + token.length

    const parsed = parseChordToken(token) ?? parseLiteralNoteToken(token)
    if (!parsed) {
      errors.push({ token, position, reason: `Could not parse "${token}" as a chord or note sequence` })
      continue
    }

    for (const pitch of parsed.pitches) {
      placements.push({ pitch, startTick: tick, lengthTicks: parsed.durationTicks })
    }
    tick += parsed.durationTicks
  }

  if (errors.length > 0) return { placements: [], errors, totalTicks: 0 }
  return { placements, errors, totalTicks: tick - cursorTick }
}
