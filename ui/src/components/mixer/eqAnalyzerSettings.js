// Analyzer control settings for the EQ panel.
// Pure data + localStorage helpers — no React, no DOM, fully testable.
//
// All four controls are renderer-only: changing them never touches the
// engine bridge or IPC. They are persisted to localStorage so the EQ
// panel reopens with the same view settings the user last used.

export const TILT_OPTIONS       = [0, 3, 4.5, 6]              // dB/oct
export const RANGE_OPTIONS      = [60, 90, 120]                // dB total vertical range
export const SPEED_OPTIONS      = ['slow', 'medium', 'fast']
export const RESOLUTION_OPTIONS = ['low', 'medium', 'high', 'maximum']

// Speed → max-hold decay rate (dB per second)
export const SPEED_DECAY = { slow: 8, medium: 24, fast: 48 }

// Resolution → bars per octave for the aggregation step
export const RESOLUTION_BARS = { low: 12, medium: 18, high: 24, maximum: 36 }

export const DEFAULT_ANALYZER = {
  tiltDbPerOct: 4.5,
  rangeDb:      90,
  speed:        'medium',
  resolution:   'high',
}

const LS_KEY = 'xleth.eq.analyzer'

export function loadAnalyzerSettings() {
  try {
    const raw = localStorage.getItem(LS_KEY)
    if (!raw) return { ...DEFAULT_ANALYZER }
    const p = JSON.parse(raw)
    return {
      tiltDbPerOct: TILT_OPTIONS.includes(p.tiltDbPerOct)           ? p.tiltDbPerOct : DEFAULT_ANALYZER.tiltDbPerOct,
      rangeDb:      RANGE_OPTIONS.includes(p.rangeDb)               ? p.rangeDb      : DEFAULT_ANALYZER.rangeDb,
      speed:        SPEED_OPTIONS.includes(p.speed)                  ? p.speed        : DEFAULT_ANALYZER.speed,
      resolution:   RESOLUTION_OPTIONS.includes(p.resolution)        ? p.resolution   : DEFAULT_ANALYZER.resolution,
    }
  } catch {
    return { ...DEFAULT_ANALYZER }
  }
}

export function saveAnalyzerSettings(settings) {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(settings))
  } catch { /* quota exceeded or private browsing */ }
}
