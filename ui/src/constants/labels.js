// ── Shared label constants & utilities ────────────────────────────────────────
// Used by SamplePicker, SampleSelectorTab, MarkedSamplesList, ProjectMediaTab

export const DEFAULT_LABELS = ['Kick', 'Snare', 'HiHat', 'Crash', 'Pitch', 'Quote']

export const CUSTOM_LABELS_KEY = 'xleth-custom-labels'

export const LABEL_COLORS = {
  kick:   'var(--label-kick)',
  snare:  'var(--label-snare)',
  hihat:  'var(--label-hihat)',
  crash:  'var(--label-crash)',
  pitch:  'var(--label-pitch)',
  quote:  'var(--label-quote)',
}

export function labelColor(label) {
  return LABEL_COLORS[label?.toLowerCase()] || 'var(--label-custom)'
}

// Concrete hex values for canvas drawing (CSS vars don't work in canvas context)
export const LABEL_HEX_COLORS = {
  kick:   '#FF6B6B',
  snare:  '#FFA94D',
  hihat:  '#FFD93D',
  crash:  '#FF6B9D',
  pitch:  '#69DB7C',
  quote:  '#748FFC',
  custom: '#B197FC',
}

export function labelHexColor(label) {
  return LABEL_HEX_COLORS[label?.toLowerCase()] || '#B197FC'
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
