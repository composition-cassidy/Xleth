import { tokenValue } from '../theming/tokenValue.ts'

// ── Shared label constants & utilities ────────────────────────────────────────
// Used by SamplePicker, SampleSelectorTab, MarkedSamplesList, ProjectMediaTab

export const DEFAULT_LABELS = ['Kick', 'Snare', 'HiHat', 'Crash', 'Pitch', 'Quote']

export const CUSTOM_LABELS_KEY = 'xleth-custom-labels'

export const LABEL_COLORS = {
  kick:   'var(--theme-label-kick)',
  snare:  'var(--theme-label-snare)',
  hihat:  'var(--theme-label-hihat)',
  crash:  'var(--theme-label-crash)',
  pitch:  'var(--theme-label-pitch)',
  quote:  'var(--theme-label-quote)',
}

export function labelColor(label) {
  return LABEL_COLORS[label?.toLowerCase()] || 'var(--theme-label-custom)'
}

// Token names for canvas drawing (resolved at draw time via tokenValue())
const LABEL_TOKEN_MAP = {
  kick:   '--theme-label-kick',
  snare:  '--theme-label-snare',
  hihat:  '--theme-label-hihat',
  crash:  '--theme-label-crash',
  pitch:  '--theme-label-pitch',
  quote:  '--theme-label-quote',
  custom: '--theme-label-custom',
}

export function labelHexColor(label) {
  const token = LABEL_TOKEN_MAP[label?.toLowerCase()] || '--theme-label-custom'
  return tokenValue(token)
}

export function loadCustomLabels() {
  try {
    return JSON.parse(localStorage.getItem(CUSTOM_LABELS_KEY) || '[]')
  } catch {
    return []
  }
}

export function saveCustomLabels(labels) {
  localStorage.setItem(CUSTOM_LABELS_KEY, JSON.stringify(labels))
}

export function buildAudioUrl(filePath) {
  // Serve local media through the xleth-media:// custom protocol to avoid
  // CSP / CORS issues when the renderer is loaded from http://localhost:5173.
  //
  // Windows paths (e.g. "E:\Shows\file.mp4") cannot be naively percent-encoded
  // because Chromium's standard-scheme URL normalizer treats the drive letter
  // colon as a host:port separator and rewrites "xleth-media:///E:/path" to
  // "xleth-media://E/path" (drive letter becomes host, colon is dropped).
  // We lean into that behaviour by placing the drive letter in the host
  // component from the start: "xleth-media://e/Shows/file.mp4".
  // The protocol handler reconstructs "E:\Shows\file.mp4" from host + pathname.
  const normalised = filePath.replace(/\\/g, '/')
  const driveMatch = normalised.match(/^([a-zA-Z]):\/(.*)$/)
  if (driveMatch) {
    const [, drive, rest] = driveMatch
    return 'xleth-media://' + drive.toLowerCase() + '/' +
           rest.split('/').map(encodeURIComponent).join('/')
  }
  // Non-Windows (Unix) paths
  return 'xleth-media:///' + normalised.split('/').map(encodeURIComponent).join('/')
}

// ── MIDI note name conversion ────────────────────────────────────────────────

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']

export function midiToNoteName(midi) {
  if (midi < 0 || midi > 127) return '--'
  const octave = Math.floor(midi / 12) - 1
  return NOTE_NAMES[midi % 12] + octave
}

// ── Time formatting ──────────────────────────────────────────────────────────

export function formatTime(s) {
  if (!isFinite(s) || s === null || s === undefined) return '0:00'
  const m   = Math.floor(s / 60)
  const sec = s % 60
  return `${m}:${String(Math.floor(sec)).padStart(2, '0')}.${String(Math.floor((sec % 1) * 100)).padStart(2, '0')}`
}

export function formatDuration(s) {
  if (!isFinite(s) || s < 0) return '0.00s'
  return s.toFixed(2) + 's'
}
