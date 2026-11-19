// Pure helpers for the Szkrezh device. Every table mirrors engine/src/dsp/szkrezh/SzkrezhCore.cpp
// (kDivisions, kScales) and every id / range mirrors XlethSzkrezhEffect::createLayout(); the
// device test pins them so the two cannot drift.

import { THIN_SPACE, formatValue, parseValue } from '../../ui-kit'
import { pitchLabel } from '../pianoRoll/pianoRollGeometry.js'

// Index 0 is "0" (Delay only). Splice uses 1..15.
export const DIVISIONS = Object.freeze([
  { label: '0', beats: 0 },
  { label: '1/64', beats: 1 / 16 },
  { label: '1/32', beats: 1 / 8 },
  { label: '1/16T', beats: 1 / 6 },
  { label: '1/16', beats: 1 / 4 },
  { label: '1/8T', beats: 1 / 3 },
  { label: '1/16D', beats: 3 / 8 },
  { label: '1/8', beats: 1 / 2 },
  { label: '1/4T', beats: 2 / 3 },
  { label: '1/8D', beats: 3 / 4 },
  { label: '1/4', beats: 1 },
  { label: '1/2T', beats: 4 / 3 },
  { label: '1/4D', beats: 3 / 2 },
  { label: '1/2', beats: 2 },
  { label: '1/2D', beats: 3 },
  { label: '1/1', beats: 4 },
])

export const SCALES = Object.freeze([
  'Major', 'Minor', 'Harmonic minor', 'Dorian', 'Phrygian', 'Mixolydian',
  'Major pentatonic', 'Minor pentatonic', 'Chromatic',
])
const SCALE_SIZE = [7, 7, 7, 7, 7, 7, 5, 5, 12]
export const KEYS = Object.freeze(['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'])

export const PITCH_SOURCES = Object.freeze([
  { value: 0, label: 'Knob', hint: 'The Pitch knob sets the shift. Repeats climb by it every pass.' },
  { value: 1, label: 'Harmony', hint: 'Follows the notes on this track: every crystal is a scale-correct interval above or below the note it is reading. Put it on a pitch-sample pattern track.' },
  { value: 2, label: 'Keys', hint: 'Play the crystals: notes from a MIDI track set their pitch. From another track they land on the note you play, over the note this track is playing.' },
])

export const FB_MODES = Object.freeze([
  { value: 0, label: 'Dual' },
  { value: 1, label: 'Ping-pong' },
  { value: 2, label: 'Mixed' },
])

export const DYN_TARGETS = Object.freeze([
  { value: 0, label: 'Output' },
  { value: 1, label: 'Feedback' },
  { value: 2, label: 'Both' },
])

export const clampInt = (v, lo, hi) => {
  const n = Math.round(Number(v))
  return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : lo
}

export const divisionLabel = (i) => DIVISIONS[clampInt(i, 0, DIVISIONS.length - 1)].label

/** Length of a division in ms at `bpm`. */
export const divisionMs = (i, bpm) => DIVISIONS[clampInt(i, 0, DIVISIONS.length - 1)].beats * (60000 / (bpm > 0 ? bpm : 140))

/** Knob codec for a division index from `min`: "1/8d", "1/8 dotted", "0" all type in. */
export function divisionCodec(min) {
  const norm = (s) => String(s).trim().toLowerCase().replace(/\s+/g, '').replace(/dotted|\./g, 'd').replace(/triplet|trip/g, 't')
  return {
    min,
    max: DIVISIONS.length - 1,
    step: 1,
    format: (v) => (Math.round(v) === 0 ? 'Off' : divisionLabel(v)),
    parse: (text) => {
      const t = norm(text)
      if (t === '0' || t === 'off') return min === 0 ? 0 : null
      const i = DIVISIONS.findIndex((d, k) => k >= min && d.label.toLowerCase() === t)
      return i >= 0 ? i : null
    },
  }
}

/** Pitch in cents shown and typed as semitones: "+12.00 st". Typing "700ct" also works. */
export const centsAsSemitones = {
  format: (v) => `${formatValue(v / 100, 'dB', { unitless: true, decimals: 2, signed: true })}${THIN_SPACE}st`,
  parse: (text) => {
    const s = String(text)
    if (/ct/i.test(s)) {
      const c = parseValue(s.replace(/ct/gi, ''), 'dB')
      return c === null ? null : c
    }
    const st = parseValue(s.replace(/st/gi, ''), 'dB')
    return st === null ? null : st * 100
  },
}

/** Cents with a sign: "+24 ct". */
export const signedCents = {
  format: (v) => `${formatValue(v, 'dB', { unitless: true, decimals: 0, signed: true })}${THIN_SPACE}ct`,
  parse: (text) => parseValue(String(text).replace(/ct/gi, ''), 'dB'),
}

const ORDINALS = ['unison', '2nd', '3rd', '4th', '5th', '6th', '7th', 'octave', '9th', '10th', '11th', '12th', '13th', '14th', '2 oct']

/** A Harmony interval: "+3rd", "-5th" in a seven-note scale, "+2 steps" or "+5 st" otherwise. */
export function intervalLabel(steps, scale) {
  const s = clampInt(steps, -14, 14)
  const size = SCALE_SIZE[clampInt(scale, 0, SCALE_SIZE.length - 1)]
  const sign = s > 0 ? '+' : s < 0 ? '−' : ''
  if (s === 0) return 'Unison'
  if (size === 12) return `${sign}${Math.abs(s)}${THIN_SPACE}st`
  if (size === 7) return `${sign}${ORDINALS[Math.abs(s)]}`
  return `${sign}${Math.abs(s)} step${Math.abs(s) === 1 ? '' : 's'}`
}

export function intervalCodec(scale) {
  return {
    min: -14,
    max: 14,
    step: 1,
    format: (v) => intervalLabel(v, scale),
    parse: (text) => {
      const n = Number.parseInt(String(text).replace('−', '-').replace(/[^0-9+-]/g, ''), 10)
      return Number.isFinite(n) ? Math.max(-14, Math.min(14, n)) : null
    },
  }
}

/** A MIDI note shown and typed by name ("C4" = 60, the piano roll's naming). */
export const noteCodec = {
  min: 0,
  max: 127,
  step: 1,
  format: (v) => pitchLabel(clampInt(v, 0, 127)),
  parse: (text) => {
    const s = String(text).trim()
    if (/^\d+$/.test(s)) return clampInt(s, 0, 127)
    const m = /^([a-g])(#|b)?(-?\d+)$/i.exec(s)
    if (!m) return null
    const pc = KEYS.indexOf(m[1].toUpperCase())
    const acc = m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0
    const note = (Number(m[3]) + 1) * 12 + pc + acc
    return note >= 0 && note <= 127 ? note : null
  },
}

/** Gate / Duck: one bipolar control, gate below zero, duck above. */
export const dynAmountFormat = {
  format: (v) => {
    const a = Math.round(Math.abs(v))
    if (a === 0) return 'Off'
    return `${v < 0 ? 'Gate' : 'Duck'} ${formatValue(a, '%')}`
  },
  parse: (text) => {
    const s = String(text).toLowerCase()
    if (s.includes('off')) return 0
    const n = parseValue(s.replace(/gate|duck/g, ''), '%')
    if (n === null) return null
    return s.includes('gate') ? -Math.abs(n) : n
  },
}

/**
 * The repeats the display draws: repeat k (1..count) sits k * shift semitones from the source and
 * at recycle^(k-1) of the first repeat's level. `shiftSt` is the live latched shift when the
 * engine has one, else the Pitch knob (Knob mode) or 0.
 */
export function staircase(shiftSt, recyclePct, count = 6) {
  const fb = Math.max(0, Math.min(1, Number(recyclePct) / 100)) * 0.98
  const steps = []
  let level = 1
  for (let k = 1; k <= count; k++) {
    steps.push({ k, semitones: k * shiftSt, level })
    level *= fb
    if (level < 0.001) break
  }
  return steps
}
