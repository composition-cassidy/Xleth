import { describe, expect, it, beforeEach } from 'vitest'
import {
  TIMELINE_DISPLAY_DEFAULTS,
  TIMELINE_DISPLAY_VALIDATORS,
  sanitizeTimelineDisplaySettings,
} from './timelineDisplayStore.js'

describe('timelineDisplayStore pure helpers', () => {
  describe('TIMELINE_DISPLAY_DEFAULTS', () => {
    it('has schemaVersion 1', () => {
      expect(TIMELINE_DISPLAY_DEFAULTS.schemaVersion).toBe(1)
    })

    it('has plain as default body modes', () => {
      expect(TIMELINE_DISPLAY_DEFAULTS.timelineClipBodyMode).toBe('plain')
      expect(TIMELINE_DISPLAY_DEFAULTS.timelinePatternBodyMode).toBe('plain')
    })

    it('has auto as default visibility settings', () => {
      expect(TIMELINE_DISPLAY_DEFAULTS.timelineShowClipNames).toBe('auto')
      expect(TIMELINE_DISPLAY_DEFAULTS.timelineShowPitchShift).toBe('auto')
      expect(TIMELINE_DISPLAY_DEFAULTS.timelineShowWaveforms).toBe('auto')
      expect(TIMELINE_DISPLAY_DEFAULTS.timelineShowPatternPreview).toBe('auto')
    })
  })

  describe('TIMELINE_DISPLAY_VALIDATORS', () => {
    it('lists chip as the only pitch style', () => {
      expect(TIMELINE_DISPLAY_VALIDATORS.timelinePitchShiftStyle).toEqual(['chip'])
    })

    it('lists four body modes', () => {
      expect(TIMELINE_DISPLAY_VALIDATORS.timelineClipBodyMode).toEqual(['minimal', 'plain', 'gradient', 'solid'])
    })
  })

  describe('sanitizeTimelineDisplaySettings', () => {
    it('returns defaults when called with null', () => {
      const result = sanitizeTimelineDisplaySettings(null)
      expect(result).toEqual(TIMELINE_DISPLAY_DEFAULTS)
    })

    it('returns defaults when called with undefined', () => {
      const result = sanitizeTimelineDisplaySettings(undefined)
      expect(result).toEqual(TIMELINE_DISPLAY_DEFAULTS)
    })

    it('returns defaults when called with a non-object', () => {
      const result = sanitizeTimelineDisplaySettings('plain')
      expect(result).toEqual(TIMELINE_DISPLAY_DEFAULTS)
    })

    it('returns defaults for an empty object', () => {
      const result = sanitizeTimelineDisplaySettings({})
      expect(result).toEqual(TIMELINE_DISPLAY_DEFAULTS)
    })

    it('preserves valid values from a partial object', () => {
      const result = sanitizeTimelineDisplaySettings({
        timelineClipBodyMode: 'gradient',
        timelineClipContrast: 'high',
      })
      expect(result.timelineClipBodyMode).toBe('gradient')
      expect(result.timelineClipContrast).toBe('high')
      expect(result.timelinePatternBodyMode).toBe(TIMELINE_DISPLAY_DEFAULTS.timelinePatternBodyMode)
    })

    it('replaces an invalid enum value with the default for that key', () => {
      const result = sanitizeTimelineDisplaySettings({
        timelineClipBodyMode: 'fancy',
        timelineShowWaveforms: 'sometimes',
      })
      expect(result.timelineClipBodyMode).toBe(TIMELINE_DISPLAY_DEFAULTS.timelineClipBodyMode)
      expect(result.timelineShowWaveforms).toBe(TIMELINE_DISPLAY_DEFAULTS.timelineShowWaveforms)
    })

    it('drops unknown keys that are not in the validators', () => {
      const result = sanitizeTimelineDisplaySettings({
        timelineClipBodyMode: 'solid',
        unknownFutureKey: 'someValue',
        anotherUnknown: 42,
      })
      expect(result.timelineClipBodyMode).toBe('solid')
      expect(result).not.toHaveProperty('unknownFutureKey')
      expect(result).not.toHaveProperty('anotherUnknown')
    })

    it('handles all valid body modes without replacement', () => {
      for (const mode of ['minimal', 'plain', 'gradient', 'solid']) {
        const result = sanitizeTimelineDisplaySettings({ timelineClipBodyMode: mode })
        expect(result.timelineClipBodyMode).toBe(mode)
      }
    })

    it('handles all valid visibility values without replacement', () => {
      for (const val of ['auto', 'always', 'never']) {
        const result = sanitizeTimelineDisplaySettings({ timelineShowWaveforms: val })
        expect(result.timelineShowWaveforms).toBe(val)
      }
    })

    it('does not mutate the input object', () => {
      const input = { timelineClipBodyMode: 'invalid' }
      sanitizeTimelineDisplaySettings(input)
      expect(input.timelineClipBodyMode).toBe('invalid')
    })
  })
})
