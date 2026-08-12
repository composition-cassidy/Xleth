// Sampler modulation — shared constants.
//
// Every enum index and key name here mirrors engine/src/model/
// SamplerModulationConfig.h and the JS wire shape produced by
// modConfigToJs / jsPatchModConfig in engine/src/XlethEngineService.cpp.
// The engine persists enums BY INDEX, so these tables are append-only —
// never reorder them.

// ── Source indices (one flat namespace, matches the engine) ──────────────────
// ENV 1-6 → 0..5, LFO 1-6 → 6..11, VELO → 12, NOTE → 13.
export const NUM_ENVS = 6
export const NUM_LFOS = 6
export const ENV_SOURCE_0 = 0
export const LFO_SOURCE_0 = ENV_SOURCE_0 + NUM_ENVS   // 6
export const VELO_SOURCE = LFO_SOURCE_0 + NUM_LFOS     // 12
export const NOTE_SOURCE = VELO_SOURCE + 1             // 13
export const NUM_SOURCES = NOTE_SOURCE + 1             // 14

export const MAX_LFO_POINTS = 32
export const MAX_CURVE_POINTS = 32

// ── LFO segment types (index = engine LfoSegment) ────────────────────────────
export const SEG_STEP = 0
export const SEG_LINE = 1
export const SEG_CURVE = 2

// ── LFO behavior (index = engine LfoBehavior) ────────────────────────────────
export const BEHAVIOR_FREE = 0
export const BEHAVIOR_RETRIG = 1
export const BEHAVIOR_ENVELOPE = 2
export const BEHAVIORS = [
  { v: BEHAVIOR_FREE, l: 'Free', title: 'One global instance, transport-anchored — runs whether or not notes sound' },
  { v: BEHAVIOR_RETRIG, l: 'Retrig', title: 'Per-voice, phase reset at note-on, loops for the life of the voice' },
  { v: BEHAVIOR_ENVELOPE, l: 'Env', title: 'Per-voice, plays the shape once then holds its final value' },
]

// ── Envelope stages (index = engine EnvStage; Sustain is a level, not a time) ─
export const STAGE_DELAY = 0
export const STAGE_ATTACK = 1
export const STAGE_HOLD = 2
export const STAGE_DECAY = 3
export const STAGE_SUSTAIN = 4
export const STAGE_RELEASE = 5

// ── Note values (index = engine NoteValue table) ─────────────────────────────
// 0 = Off (zero length). The rest run 32 bars → 1/256.
export const NOTEVAL_OFF = 0
export const NOTE_VALUES = [
  { v: 0, l: 'Off' },
  { v: 1, l: '32' }, { v: 2, l: '16' }, { v: 3, l: '8' }, { v: 4, l: '4' },
  { v: 5, l: '2' }, { v: 6, l: '1' },
  { v: 7, l: '1/2' }, { v: 8, l: '1/4' }, { v: 9, l: '1/8' }, { v: 10, l: '1/16' },
  { v: 11, l: '1/32' }, { v: 12, l: '1/64' }, { v: 13, l: '1/128' }, { v: 14, l: '1/256' },
]
// Same list minus Off — used where a length of zero makes no sense (LFO rate).
export const NOTE_VALUES_NONZERO = NOTE_VALUES.slice(1)

const NOTE_BEATS = [
  0, 128, 64, 32, 16, 8, 4, 2, 1, 0.5, 0.25, 0.125, 0.0625, 0.03125, 0.015625,
]

// Beats for one note value, mirrors engine noteValueBeats(). Used only for the
// editor's own read-outs (e.g. showing a synced time in ms at the project BPM).
export function noteValueBeats(noteValue, triplet, dotted) {
  let b = NOTE_BEATS[noteValue] ?? 0
  if (triplet) b *= 2 / 3
  if (dotted) b *= 3 / 2
  return b
}

export function modTimeSeconds(t, sync, bpm) {
  if (!sync) return (t?.ms ?? 0) / 1000
  const useBpm = bpm > 0 ? bpm : 120
  return noteValueBeats(t?.noteValue ?? 0, !!t?.triplet, !!t?.dotted) * 60 / useBpm
}

// ── Card catalogue ───────────────────────────────────────────────────────────
// The rack renders these in order. `kind` picks the editor; `source` is the flat
// index; `color` is a CSS custom property scoped on .sampler-mod-rack (see
// app.css) so the palette stays theme-driven and swappable, never hardcoded.
export function buildCards() {
  const cards = []
  for (let i = 0; i < NUM_ENVS; i++) {
    cards.push({ id: `env${i}`, kind: 'env', source: ENV_SOURCE_0 + i, index: i, label: `ENV ${i + 1}`, color: 'var(--mod-env)' })
  }
  for (let i = 0; i < NUM_LFOS; i++) {
    cards.push({ id: `lfo${i}`, kind: 'lfo', source: LFO_SOURCE_0 + i, index: i, label: `LFO ${i + 1}`, color: 'var(--mod-lfo)' })
  }
  cards.push({ id: 'velo', kind: 'velo', source: VELO_SOURCE, index: 0, label: 'VELO', color: 'var(--mod-velo)' })
  cards.push({ id: 'note', kind: 'note', source: NOTE_SOURCE, index: 0, label: 'NOTE', color: 'var(--mod-note)' })
  return cards
}

// Number of routes leaving a given source — the "in use" signal a card shows.
export function routeCountForSource(routes, source) {
  if (!Array.isArray(routes)) return 0
  let n = 0
  for (const r of routes) if (r?.source === source) n++
  return n
}
