import { create } from 'zustand'

const SETTINGS_KEY = 'quickLaunchers'

function getXleth() {
  return typeof window !== 'undefined' ? window.xleth : undefined
}

export const useQuickLaunchersStore = create((set, get) => ({
  launchers: [],
  hydrated: false,

  hydrate: async () => {
    if (get().hydrated) return get().launchers
    const saved = await getXleth()?.settings?.get?.(SETTINGS_KEY)
    const launchers = Array.isArray(saved) ? saved : []
    set({ launchers, hydrated: true })
    return launchers
  },

  _persist: async (launchers) => {
    set({ launchers })
    await getXleth()?.settings?.set?.(SETTINGS_KEY, launchers)
  },

  addLauncher: async (entry) => {
    const { launchers, _persist } = get()
    await _persist([...launchers, entry])
  },

  removeLauncher: async (id) => {
    const { launchers, _persist } = get()
    await _persist(launchers.filter(l => l.id !== id))
  },

  updateLauncher: async (id, patch) => {
    const { launchers, _persist } = get()
    await _persist(launchers.map(l => l.id === id ? { ...l, ...patch } : l))
  },
}))
