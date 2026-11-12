import { create } from 'zustand'

// Click track. The engine owns the sound; this store owns the persisted
// preference and mirrors it to the engine (audio.setMetronome). The first beat
// of every bar is accented +3 semitones engine-side — nothing to configure here.
const SETTINGS_KEY = 'metronome'

// Order matches the engine's Metronome::Sound enum.
export const METRONOME_SOUNDS = ['Bump', 'Hat', 'Rim']

let writeTimer = null
function scheduleWrite(value) {
  clearTimeout(writeTimer)
  writeTimer = setTimeout(() => {
    window.xleth?.settings?.set(SETTINGS_KEY, value)
      .catch(e => console.warn('[Metronome] Failed to persist settings:', e))
  }, 300)
}

function pushToEngine(patch) {
  try {
    const p = window.xleth?.audio?.setMetronome?.(patch)
    p?.catch?.(e => console.warn('[Metronome] Engine rejected setMetronome:', e))
  } catch (e) {
    console.warn('[Metronome] setMetronome failed:', e)
  }
}

const snapshot = (s) => ({ enabled: s.enabled, volume: s.volume, sound: s.sound })

const useMetronomeStore = create((set, get) => ({
  enabled: false,
  volume: 0.8,
  sound: 0,

  toggle: () => get().setEnabled(!get().enabled),

  setEnabled: (enabled) => {
    set({ enabled: !!enabled })
    pushToEngine({ enabled: !!enabled })
    scheduleWrite(snapshot(get()))
  },

  setVolume: (volume) => {
    const v = Math.min(1, Math.max(0, Number(volume) || 0))
    set({ volume: v })
    pushToEngine({ volume: v })
    scheduleWrite(snapshot(get()))
  },

  setSound: (sound) => {
    const i = Math.min(METRONOME_SOUNDS.length - 1, Math.max(0, Math.trunc(Number(sound) || 0)))
    set({ sound: i })
    pushToEngine({ sound: i })
    scheduleWrite(snapshot(get()))
  },

  /** Load the saved preference and apply it to the engine. Call once the engine is up. */
  hydrate: async () => {
    try {
      const saved = await window.xleth?.settings?.get(SETTINGS_KEY)
      if (saved && typeof saved === 'object') {
        const next = {}
        if (typeof saved.enabled === 'boolean') next.enabled = saved.enabled
        if (typeof saved.volume === 'number') next.volume = Math.min(1, Math.max(0, saved.volume))
        if (typeof saved.sound === 'number') next.sound = Math.min(2, Math.max(0, Math.trunc(saved.sound)))
        set(next)
      }
    } catch (e) {
      console.warn('[Metronome] Could not load saved settings, using defaults:', e)
    }
    pushToEngine(snapshot(get()))
  },
}))

export default useMetronomeStore
