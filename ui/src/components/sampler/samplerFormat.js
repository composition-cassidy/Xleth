// Display formats and type-in parsers for the sampler's kit controls. Pure: no React,
// no DOM, no tokenValue(). Every value the engine sees is unchanged; only how it reads
// (and what a person may type) lives here.

import { MINUS, THIN_SPACE, formatValue, parseValue } from '../../ui-kit'
import { noteName } from './auditionKeymap.js'

export { formatPan, parsePan } from '../mixer/mixerMath.js'

const NUM = String.raw`[+-]?(?:\d+\.?\d*|\.\d+)`

function normalise(text) {
  return String(text ?? '')
    .replace(/[−‒–—]/g, '-')
    .replace(/[   ]/g, ' ')
    .trim()
    .toLowerCase()
}

// ── Sample positions (trim, loop, crossfade) ──────────────────────────────────
// Stored and committed as integer sample indices. Read as time: ms below one
// second, seconds above (a two-minute sample would otherwise read "125000 ms").

export function samplesToMs(n, rate) {
  return rate > 0 ? (Number(n) / rate) * 1000 : 0
}

export function msToSamples(ms, rate) {
  return Math.round((Number(ms) / 1000) * (rate > 0 ? rate : 48000))
}

export function formatTime(ms) {
  if (!Number.isFinite(ms)) return '—'
  if (Math.abs(ms) < 1000) return formatValue(ms, 'ms')
  return `${ms < 0 ? MINUS : ''}${(Math.abs(ms) / 1000).toFixed(2)}${THIN_SPACE}s`
}

export function formatSamplePosition(n, rate) {
  return formatTime(samplesToMs(n, rate))
}

/** "33.1", "33.1 ms", "1.2 s", "1588 smp" (exact), "full" / "end" (when `sentinel` is set). Null = not a value. */
export function parseSamplePosition(text, rate, { total = 0, sentinel = null } = {}) {
  const s = normalise(text)
  if (!s) return null
  if (sentinel && (s === sentinel || s === 'full' || s === 'end')) return total
  const m = new RegExp(String.raw`^(${NUM})\s*(smp|samples?|spl|ms|s|sec)?$`).exec(s)
  if (!m) return null
  const n = Number(m[1])
  if (!Number.isFinite(n)) return null
  const u = m[2] || 'ms'
  if (u === 'smp' || u === 'sample' || u === 'samples' || u === 'spl') return Math.round(n)
  if (u === 's' || u === 'sec') return msToSamples(n * 1000, rate)
  return msToSamples(n, rate)
}

export function sampleCountText(n) {
  return `${Math.round(Number(n) || 0).toLocaleString('en-US')} samples`
}

// ── Level: linear gain 0..2 shown in dB ───────────────────────────────────────

const SILENT_GAIN = 1e-5

export function formatGainDb(gain) {
  const g = Number(gain)
  if (!Number.isFinite(g) || g <= SILENT_GAIN) return `${MINUS}inf${THIN_SPACE}dB`
  return formatValue(20 * Math.log10(g), 'dB', { signed: true })
}

/** Typed dB back to linear gain, clamped to the slot volume's 0..2. "-inf" = 0. */
export function parseGainDb(text) {
  const db = parseValue(String(text ?? ''), 'dB')
  if (db === null) return null
  if (db === -Infinity) return 0
  return Math.max(0, Math.min(2, 10 ** (db / 20)))
}

// ── Signed pitch offsets ──────────────────────────────────────────────────────

export function formatOffset(v, unit, decimals = 0) {
  const n = Number(v) || 0
  const r = Number(Math.abs(n).toFixed(decimals))
  const sign = r === 0 ? '' : (n < 0 ? MINUS : '')
  return `${sign}${r.toFixed(decimals)}${THIN_SPACE}${unit}`
}

/** A bare number, optionally followed by st / semitones / ct / cents / oct. */
export function parseOffset(text) {
  const s = normalise(text)
  const m = new RegExp(String.raw`^(${NUM})\s*(st|semi|semis|semitones?|ct|cents?|c|oct|octaves?)?$`).exec(s)
  if (!m) return null
  const n = Number(m[1])
  return Number.isFinite(n) ? n : null
}

// ── Root note (MIDI 0..127, C4 = 60 like the piano roll) ──────────────────────

const PITCH_CLASS = { c: 0, d: 2, e: 4, f: 5, g: 7, a: 9, b: 11 }

export { noteName }

/** "C4", "c#3", "Db2", or a MIDI number. Null when it is not a note in range. */
export function parseNote(text) {
  const s = normalise(text)
  if (!s) return null
  const m = /^([a-g])\s*([#b♯♭]?)\s*(-?\d+)$/.exec(s)
  let midi
  if (m) {
    const acc = m[2] === '#' || m[2] === '♯' ? 1 : (m[2] === 'b' || m[2] === '♭' ? -1 : 0)
    midi = PITCH_CLASS[m[1]] + acc + (Number(m[3]) + 1) * 12
  } else if (/^\d+$/.test(s)) {
    midi = Number(s)
  } else {
    return null
  }
  return midi >= 0 && midi <= 127 ? midi : null
}

// ── Slot identity colour ──────────────────────────────────────────────────────
// A slot has no stored colour; slot N reads the identity palette's entry N. One
// palette (DESIGN.md 3.4), so a slot never takes a state colour's hue.

export function slotColorVarName(slotIndex) {
  return `--theme-track-palette-${(Math.max(0, slotIndex | 0) % 16) + 1}`
}

export function slotColorVar(slotIndex) {
  return `var(${slotColorVarName(slotIndex)})`
}

// ── Tempo-synced lengths (modulation NoteValue table) ─────────────────────────
// Index-valued: 0 = Off, then 32 bars down to 1/256 (modConstants.NOTE_VALUES).
// A kit codec, so a knob drags through the list, prints the label and accepts a
// typed one ("1/8", "2 bars", "off").

export function noteValueLabel(label) {
  if (label === 'Off') return 'Off'
  if (/^\d+$/.test(label)) return `${label} ${label === '1' ? 'bar' : 'bars'}`
  return label
}

export function noteValueCodec(noteValues, { allowOff = true } = {}) {
  const list = allowOff ? noteValues : noteValues.filter((o) => o.v !== 0)
  const labels = list.map((o) => noteValueLabel(o.l))
  const min = list[0]?.v ?? 0
  const max = list[list.length - 1]?.v ?? 0
  return {
    min,
    max,
    step: 1,
    format(value) {
      const i = list.findIndex((o) => o.v === Math.round(value))
      return i >= 0 ? labels[i] : '—'
    },
    parse(text) {
      const s = normalise(text).replace(/\s*bars?$/, '')
      const i = list.findIndex((o) => o.l.toLowerCase() === s)
      return i >= 0 ? list[i].v : null
    },
  }
}

/** A unitless signed value with two decimals and a true minus ("−0.25"). */
export function formatSigned2(v) {
  const n = Number(v) || 0
  const r = Number(Math.abs(n).toFixed(2))
  return `${r === 0 ? '' : (n < 0 ? MINUS : '')}${r.toFixed(2)}`
}
