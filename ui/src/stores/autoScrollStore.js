import { create } from 'zustand'

// Playback-only "follow the playhead" toggle for the audio timeline. Off by
// default: the timeline never moves itself, during playback or otherwise —
// see TimelineView's playheadClock.onFrame handler. When on, the timeline
// centers the playhead every frame while playing and manual horizontal
// scroll/pan is locked out (zoom/resize remains available).
const SETTINGS_KEY = 'timelineAutoScroll'

let writeTimer = null
function scheduleWrite(value) {
  clearTimeout(writeTimer)
  writeTimer = setTimeout(() => {
    window.xleth?.settings?.set(SETTINGS_KEY, value)
      .catch(e => console.warn('[AutoScrollPref] Failed to persist timelineAutoScroll:', e))
  }, 300)
}

const useAutoScrollStore = create((set, get) => ({
  enabled: false,

  toggle: () => {
    const next = !get().enabled
    set({ enabled: next })
    scheduleWrite(next)
  },
}))

// Hydrate from persisted settings on module load
;(async () => {
  try {
    const saved = await window.xleth?.settings?.get(SETTINGS_KEY)
    if (typeof saved === 'boolean') {
      useAutoScrollStore.setState({ enabled: saved })
    }
  } catch (e) {
    console.warn('[AutoScrollPref] Could not load saved timelineAutoScroll, using default:', e)
  }
})()

export default useAutoScrollStore
