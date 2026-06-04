import { create } from 'zustand'

const VALID_GRANULARITIES = ['1/64', '1/32', '1/16', '1/8', 'Beat', 'Half', 'Bar']
const DEFAULT_GRANULARITY = '1/16'
const SETTINGS_KEY = 'snapGranularity'

let writeTimer = null
function scheduleWrite(value) {
  clearTimeout(writeTimer)
  writeTimer = setTimeout(() => {
    window.xleth?.settings?.set(SETTINGS_KEY, value)
      .catch(e => console.warn('[SnapPref] Failed to persist snapGranularity:', e))
  }, 300)
}

const useSnapStore = create((set) => ({
  snapGranularity: DEFAULT_GRANULARITY,

  setSnapGranularity: (key) => {
    if (!VALID_GRANULARITIES.includes(key)) {
      console.warn(`[SnapPref] Invalid granularity "${key}", ignoring`)
      return
    }
    if (useSnapStore.getState().snapGranularity === key) return
    console.log(`[SnapPref] snapGranularity -> ${key}`)
    set({ snapGranularity: key })
    scheduleWrite(key)
  },
}))

// Hydrate from persisted settings on module load
;(async () => {
  try {
    const saved = await window.xleth?.settings?.get(SETTINGS_KEY)
    if (saved && VALID_GRANULARITIES.includes(saved)) {
      console.log(`[SnapPref] Loaded snapGranularity: ${saved}`)
      useSnapStore.setState({ snapGranularity: saved })
    }
  } catch (e) {
    console.warn('[SnapPref] Could not load saved snapGranularity, using default:', e)
  }
})()

export default useSnapStore
