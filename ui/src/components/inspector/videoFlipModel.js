// Pure helpers for the Inspector's video flip rows. No DOM, no engine calls.
//
// The four flipping STYLES are the engine's own canonical cycles: exactly the
// configs migrateVideoFlipMode() (engine/src/model/TimelineTypes.h) builds from
// the legacy None / HorizontalEven / Clockwise / CounterClockwise enum, and the
// same ones videoFlipConfigToLegacyMode() recognises. Picking a style writes
// that cycle (states + start state) and keeps Enabled and the modifier; any
// other cycle reads as Custom, which is shown, never picked.

export const FLIP_STYLES = Object.freeze([
  { value: 'none', label: 'None', hint: 'No flip: one plain state', states: ['none'], start: 0 },
  { value: 'horizontal', label: 'Horizontal', hint: 'Mirror left-right on every other note', states: ['none', 'horizontal'], start: 1 },
  { value: 'clockwise', label: 'Clockwise', hint: 'Normal, vertical, half turn, horizontal, then again', states: ['none', 'vertical', 'rotate-180', 'horizontal'], start: 0 },
  { value: 'counterclockwise', label: 'Counter-clockwise', hint: 'Normal, horizontal, half turn, vertical, then again', states: ['none', 'horizontal', 'rotate-180', 'vertical'], start: 0 },
])

/** Which canonical style a config's cycle is, or 'custom'. */
export function flipStyleOf(config) {
  const states = (config?.states ?? []).map((s) => s.orientation ?? 'none')
  const start = config?.startStateIndex ?? 0
  const hit = FLIP_STYLES.find((st) => st.start === start
    && st.states.length === states.length
    && st.states.every((o, i) => o === states[i]))
  return hit ? hit.value : 'custom'
}

/** The config with a style's cycle written in; Enabled and the modifier are kept. */
export function applyFlipStyle(config, styleValue) {
  const st = FLIP_STYLES.find((s) => s.value === styleValue)
  if (!st) return config
  return {
    ...config,
    states: st.states.map((orientation, i) => ({ id: `s${i}`, orientation, label: '' })),
    startStateIndex: st.start,
  }
}

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']

/** MIDI 60 = C4 (the convention Xleth uses everywhere). */
export function midiNoteLabel(midi) {
  const safe = ((midi % 12) + 12) % 12
  return `${NOTE_NAMES[safe]}${Math.floor(midi / 12) - 1}`
}

/** "C4", "D#5", "Eb3" or a MIDI number 0..127 -> MIDI number, else null. */
export function parsePitchInput(text) {
  const t = String(text ?? '').trim()
  if (!t) return null
  if (/^-?\d+$/.test(t)) {
    const n = parseInt(t, 10)
    return n >= 0 && n <= 127 ? n : null
  }
  const m = t.match(/^([A-Ga-g])([#b]?)(-?\d+)$/)
  if (!m) return null
  let semi = NOTE_NAMES.indexOf(m[1].toUpperCase())
  if (m[2] === '#') semi += 1
  if (m[2] === 'b') semi -= 1
  const midi = (parseInt(m[3], 10) + 1) * 12 + semi
  return midi >= 0 && midi <= 127 ? midi : null
}

/**
 * The example notes the preview resolves (there is no upcoming-events call, so
 * it shows the rule on a made-up sequence, as the legacy section did): pitch
 * modifiers get a sequence that exercises them, the others a rising line.
 */
export function previewPitches(config) {
  const t = config?.modifier?.type
  if (t === 'specific-pitches') {
    const wl = config?.modifier?.config?.pitches ?? []
    if (wl.length === 0) return new Array(8).fill(60)
    return Array.from({ length: 8 }, (_, i) => (i % 2 === 0 ? wl[(i / 2) % wl.length] : 62))
  }
  if (t === 'new-note') return [60, 60, 62, 62, 64, 60, 64, 67]
  return [60, 62, 64, 65, 67, 69, 71, 72]
}

export const clampInt = (v, min, max) => Math.max(min, Math.min(max, v | 0))

/** Lowest unused "sN" id, so a deleted and re-added state never collides. */
export function nextStateId(states) {
  const used = new Set(states.map((s) => s.id))
  for (let i = 0; i < 1000; i += 1) if (!used.has(`s${i}`)) return `s${i}`
  return `s${Date.now()}`
}

export function cloneFlipConfig(c) {
  return {
    enabled: !!c?.enabled,
    states: (c?.states?.length ? c.states : [{ id: 's0', orientation: 'none' }]).map((s, i) => ({
      id: s.id || `s${i}`,
      orientation: s.orientation || 'none',
      label: s.label || '',
    })),
    modifier: c?.modifier
      ? { type: c.modifier.type || 'every-note', config: { ...(c.modifier.config || {}) } }
      : { type: 'every-note', config: {} },
    startStateIndex: Math.max(0, (c?.startStateIndex ?? 0) | 0),
  }
}
