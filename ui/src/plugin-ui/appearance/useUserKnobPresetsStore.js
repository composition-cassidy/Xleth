import { create } from 'zustand'
import { resolveAppearance } from './appearanceRegistry.js'

const USER_PRESET_ID_PREFIX = 'user'
const USER_PRESET_ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/i

function getPluginUiIpc() {
  return (typeof window !== 'undefined' && window.xleth?.pluginUi) || null
}

function slugify(label) {
  const base = String(label || '').trim().toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
  return base || 'preset'
}

function makeUniqueId(label, existingIds) {
  const slug = slugify(label)
  let candidate = `${USER_PRESET_ID_PREFIX}-${slug}`
  let n = 2
  while (existingIds.has(candidate)) {
    candidate = `${USER_PRESET_ID_PREFIX}-${slug}-${n}`
    n += 1
  }
  return candidate
}

export const useUserKnobPresetsStore = create((set, get) => ({
  presets: [],
  isLoaded: false,
  isLoading: false,
  loadError: null,
  saveError: null,

  reset() {
    set({ presets: [], isLoaded: false, isLoading: false, loadError: null, saveError: null })
  },

  async load() {
    const ipc = getPluginUiIpc()
    if (!ipc || typeof ipc.listKnobPresets !== 'function') {
      set({ presets: [], isLoaded: true, loadError: null })
      return []
    }
    set({ isLoading: true, loadError: null })
    try {
      const list = await ipc.listKnobPresets()
      const safe = Array.isArray(list) ? list.filter(isValidPresetRecord) : []
      set({ presets: safe, isLoaded: true, isLoading: false })
      return safe
    } catch (err) {
      set({ presets: [], isLoaded: true, isLoading: false, loadError: String(err?.message || err) })
      return []
    }
  },

  async saveCurrent({ label, description, appearance }) {
    const ipc = getPluginUiIpc()
    if (!ipc || typeof ipc.saveKnobPreset !== 'function') {
      const message = 'User presets unavailable: pluginUi IPC missing'
      set({ saveError: message })
      return { ok: false, error: message }
    }
    if (typeof label !== 'string' || !label.trim()) {
      return { ok: false, error: 'Preset name is required' }
    }
    const trimmedLabel = label.trim().slice(0, 64)
    const trimmedDescription = typeof description === 'string' ? description.trim().slice(0, 256) : ''
    const snapshot = sanitizeAppearance(appearance)
    if (!snapshot) {
      return { ok: false, error: 'Cannot save preset: appearance is empty' }
    }

    const existing = get().presets
    const existingIds = new Set(existing.map(entry => entry.id))
    const id = makeUniqueId(trimmedLabel, existingIds)
    const record = {
      id,
      label: trimmedLabel,
      description: trimmedDescription,
      appearance: snapshot,
    }

    set({ saveError: null })
    try {
      const next = await ipc.saveKnobPreset(record)
      const safe = Array.isArray(next) ? next.filter(isValidPresetRecord) : [...existing, record]
      set({ presets: safe })
      return { ok: true, preset: record }
    } catch (err) {
      const message = String(err?.message || err)
      set({ saveError: message })
      return { ok: false, error: message }
    }
  },

  async remove(id) {
    const ipc = getPluginUiIpc()
    if (!ipc || typeof ipc.deleteKnobPreset !== 'function') {
      return { ok: false, error: 'User presets unavailable' }
    }
    if (typeof id !== 'string' || !USER_PRESET_ID_RE.test(id)) {
      return { ok: false, error: 'Invalid preset id' }
    }
    try {
      const next = await ipc.deleteKnobPreset(id)
      const safe = Array.isArray(next) ? next.filter(isValidPresetRecord) : get().presets.filter(p => p.id !== id)
      set({ presets: safe })
      return { ok: true }
    } catch (err) {
      const message = String(err?.message || err)
      set({ saveError: message })
      return { ok: false, error: message }
    }
  },

  getById(id) {
    return get().presets.find(p => p.id === id) || null
  },
}))

function isValidPresetRecord(entry) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return false
  if (typeof entry.id !== 'string' || !USER_PRESET_ID_RE.test(entry.id)) return false
  if (typeof entry.label !== 'string' || !entry.label.trim()) return false
  if (!entry.appearance || typeof entry.appearance !== 'object' || Array.isArray(entry.appearance)) return false
  return true
}

function sanitizeAppearance(appearance) {
  if (!appearance || typeof appearance !== 'object' || Array.isArray(appearance)) return null
  const normalized = resolveAppearance('knob', appearance)
  if (!normalized) return null
  return { ...normalized }
}

export { isValidPresetRecord, makeUniqueId, slugify }
