import { create } from 'zustand'

const VALID_MODES = ['list', 'thumbnails']
const DEFAULT_MODE = 'list'
const SETTINGS_KEY = 'sampleSelectorViewMode'

let writeTimer = null
function scheduleWrite(value) {
  clearTimeout(writeTimer)
  writeTimer = setTimeout(() => {
    window.xleth?.settings?.set(SETTINGS_KEY, value)
      .catch(e => console.warn('[SampleViewMode] Failed to persist viewMode:', e))
  }, 300)
}

const useSampleViewModeStore = create((set) => ({
  viewMode: DEFAULT_MODE,

  setViewMode: (mode) => {
    if (!VALID_MODES.includes(mode)) {
      console.warn(`[SampleViewMode] Invalid mode "${mode}", ignoring`)
      return
    }
    console.log(`[SampleViewMode] viewMode → ${mode}`)
    set({ viewMode: mode })
    scheduleWrite(mode)
  },
}))

;(async () => {
  try {
    const saved = await window.xleth?.settings?.get(SETTINGS_KEY)
    if (saved && VALID_MODES.includes(saved)) {
      console.log(`[SampleViewMode] Loaded viewMode: ${saved}`)
      useSampleViewModeStore.setState({ viewMode: saved })
    }
  } catch (e) {
    console.warn('[SampleViewMode] Could not load saved viewMode, using default:', e)
  }
})()

export default useSampleViewModeStore
