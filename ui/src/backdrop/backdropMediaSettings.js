import { create } from 'zustand'

export const BACKDROP_MEDIA_SETTINGS_KEY = 'backdropMedia'

export const BACKDROP_MEDIA_SOURCE_TYPES = Object.freeze([
  { value: 'none', label: 'None' },
  { value: 'acrylic', label: 'Acrylic' },
  { value: 'image', label: 'Image' },
  { value: 'video', label: 'Video' },
])

export const DEFAULT_BACKDROP_MEDIA_SETTINGS = Object.freeze({
  sourceType: 'none',
  imagePath: '',
  videoPath: '',
  lastError: '',
})

const VALID_SOURCE_TYPES = new Set(BACKDROP_MEDIA_SOURCE_TYPES.map((item) => item.value))

export const VIDEO_BACKDROP_ERROR_MESSAGE = 'Video backdrop could not be played. The file may be missing or unsupported.'

function stringOrEmpty(value) {
  return typeof value === 'string' ? value : ''
}

export function localMediaPathToXlethMediaUrl(filePath) {
  if (typeof filePath !== 'string' || !filePath.trim()) return ''
  const normalized = filePath.replace(/\\/g, '/')
  const driveMatch = normalized.match(/^([a-zA-Z]):\/(.*)$/)
  if (driveMatch) {
    const [, drive, rest] = driveMatch
    return `xleth-media://${drive.toLowerCase()}/${rest.split('/').map(encodeURIComponent).join('/')}`
  }
  return `xleth-media:///${normalized.split('/').map(encodeURIComponent).join('/')}`
}

export function backdropMediaFromBackdropState(state, previous = DEFAULT_BACKDROP_MEDIA_SETTINGS) {
  const sourceType = state?.mode === 'image'
    ? 'image'
    : state?.mode === 'video'
      ? 'video'
      : state?.mode === 'native-acrylic' || state?.preference === 'acrylic'
        ? 'acrylic'
        : 'none'
  return sanitizeBackdropMediaSettings({
    sourceType,
    imagePath: state?.imagePath ?? previous.imagePath,
    videoPath: state?.videoPath ?? previous.videoPath,
    lastError: state?.lastError ?? previous.lastError,
  })
}

export function sanitizeBackdropMediaSettings(value, legacyBackdropState = null) {
  const source = typeof value === 'string'
    ? { sourceType: value }
    : value && typeof value === 'object'
      ? value
      : {}
  const legacyImagePath = stringOrEmpty(legacyBackdropState?.imagePath)
  const legacyVideoPath = stringOrEmpty(legacyBackdropState?.videoPath)
  const imagePath = stringOrEmpty(source.imagePath) || legacyImagePath
  const videoPath = stringOrEmpty(source.videoPath) || legacyVideoPath
  let sourceType = VALID_SOURCE_TYPES.has(source.sourceType) ? source.sourceType : null

  if (!sourceType) {
    if (legacyBackdropState?.mode === 'image' || imagePath) sourceType = 'image'
    else if (legacyBackdropState?.mode === 'native-acrylic' || legacyBackdropState?.preference === 'acrylic') sourceType = 'acrylic'
    else sourceType = DEFAULT_BACKDROP_MEDIA_SETTINGS.sourceType
  }

  return {
    sourceType,
    imagePath,
    videoPath,
    lastError: stringOrEmpty(source.lastError),
  }
}

function getXleth() {
  return typeof window !== 'undefined' ? window.xleth : null
}

export const useBackdropMediaSettingsStore = create((set, get) => ({
  settings: { ...DEFAULT_BACKDROP_MEDIA_SETTINGS },
  hydrated: false,
  hydrate: async () => {
    const xleth = getXleth()
    const legacyState = xleth?.backdrop?.current ?? null
    const settingsBridge = xleth?.settings
    if (!settingsBridge?.get) {
      const next = sanitizeBackdropMediaSettings(get().settings, legacyState)
      set({ settings: next, hydrated: true })
      return next
    }
    try {
      const saved = await settingsBridge.get(BACKDROP_MEDIA_SETTINGS_KEY)
      const next = sanitizeBackdropMediaSettings(saved, legacyState)
      set({ settings: next, hydrated: true })
      return next
    } catch (err) {
      console.warn('[BackdropMedia] settings hydrate failed:', err?.message || err)
      const next = sanitizeBackdropMediaSettings(get().settings, legacyState)
      set({ settings: next, hydrated: true })
      return next
    }
  },
  setSettings: async (patch) => {
    const next = sanitizeBackdropMediaSettings({
      ...get().settings,
      ...(patch || {}),
    })
    set({ settings: next, hydrated: true })
    try {
      const state = await getXleth()?.backdrop?.setMedia?.(next)
      if (state) {
        const synced = backdropMediaFromBackdropState(state, next)
        set({ settings: synced, hydrated: true })
        return synced
      }
      await getXleth()?.settings?.set?.(BACKDROP_MEDIA_SETTINGS_KEY, next)
    } catch (err) {
      try {
        await getXleth()?.settings?.set?.(BACKDROP_MEDIA_SETTINGS_KEY, next)
      } catch (fallbackErr) {
        console.warn('[BackdropMedia] settings persist failed:', fallbackErr?.message || fallbackErr)
      }
    }
    return next
  },
  syncFromBackdropState: (state) => {
    const next = backdropMediaFromBackdropState(state, get().settings)
    set({ settings: next, hydrated: true })
    return next
  },
  setVideoError: async (message = VIDEO_BACKDROP_ERROR_MESSAGE) => {
    const next = sanitizeBackdropMediaSettings({
      ...get().settings,
      lastError: message,
    })
    set({ settings: next, hydrated: true })
    try {
      await getXleth()?.settings?.set?.(BACKDROP_MEDIA_SETTINGS_KEY, next)
    } catch {}
    return next
  },
  resetForTests: () => set({
    settings: { ...DEFAULT_BACKDROP_MEDIA_SETTINGS },
    hydrated: false,
  }),
}))
