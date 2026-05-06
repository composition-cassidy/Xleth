import { create } from 'zustand'

const SETTINGS_KEY = 'timelineDisplaySettings'

export const TIMELINE_DISPLAY_DEFAULTS = {
  schemaVersion: 1,
  timelineClipBodyMode: 'plain',
  timelinePatternBodyMode: 'plain',
  timelineBodyGradientDirection: 'top',
  timelineClipContrast: 'medium',
  timelineShowClipNames: 'auto',
  timelineShowPitchShift: 'auto',
  timelinePitchShiftStyle: 'chip',
  timelineShowWaveforms: 'auto',
  timelineShowPatternPreview: 'auto',
}

export const TIMELINE_DISPLAY_VALIDATORS = {
  timelineClipBodyMode:          ['minimal', 'plain', 'gradient', 'solid'],
  timelinePatternBodyMode:       ['minimal', 'plain', 'gradient', 'solid'],
  timelineBodyGradientDirection: ['top', 'bottom'],
  timelineClipContrast:          ['low', 'medium', 'high'],
  timelineShowClipNames:         ['auto', 'always', 'never'],
  timelineShowPitchShift:        ['auto', 'always', 'never'],
  timelinePitchShiftStyle:       ['chip'],
  timelineShowWaveforms:         ['auto', 'always', 'never'],
  timelineShowPatternPreview:    ['auto', 'always', 'never'],
}

export function sanitizeTimelineDisplaySettings(raw) {
  const merged = { ...TIMELINE_DISPLAY_DEFAULTS }
  if (!raw || typeof raw !== 'object') return merged
  for (const [key, validValues] of Object.entries(TIMELINE_DISPLAY_VALIDATORS)) {
    if (raw[key] !== undefined) {
      merged[key] = validValues.includes(raw[key]) ? raw[key] : TIMELINE_DISPLAY_DEFAULTS[key]
    }
  }
  return merged
}

let writeTimer = null
function scheduleWrite(settings) {
  clearTimeout(writeTimer)
  writeTimer = setTimeout(() => {
    window.xleth?.settings?.set(SETTINGS_KEY, settings)
      .catch(e => console.warn('[TimelineDisplay] Failed to persist settings:', e))
  }, 300)
}

const useTimelineDisplayStore = create((set) => ({
  timelineDisplaySettings: { ...TIMELINE_DISPLAY_DEFAULTS },

  setTimelineDisplaySetting: (key, value) => {
    const validValues = TIMELINE_DISPLAY_VALIDATORS[key]
    if (!validValues) {
      console.warn(`[TimelineDisplay] Unknown setting key "${key}", ignoring`)
      return
    }
    if (!validValues.includes(value)) {
      console.warn(`[TimelineDisplay] Invalid value "${value}" for "${key}", ignoring`)
      return
    }
    set((state) => {
      const next = { ...state.timelineDisplaySettings, [key]: value }
      scheduleWrite(next)
      return { timelineDisplaySettings: next }
    })
  },

  resetTimelineDisplaySettings: () => {
    const next = { ...TIMELINE_DISPLAY_DEFAULTS }
    scheduleWrite(next)
    set({ timelineDisplaySettings: next })
  },
}))

;(async () => {
  try {
    const saved = await window.xleth?.settings?.get(SETTINGS_KEY)
    if (saved) {
      const sanitized = sanitizeTimelineDisplaySettings(saved)
      console.log('[TimelineDisplay] Loaded settings:', sanitized)
      useTimelineDisplayStore.setState({ timelineDisplaySettings: sanitized })
    }
  } catch (e) {
    console.warn('[TimelineDisplay] Could not load saved settings, using defaults:', e)
  }
})()

export default useTimelineDisplayStore
