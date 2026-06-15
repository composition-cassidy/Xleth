import { create } from 'zustand'

export const BACKDROP_FX_SETTINGS_KEY = 'backdropFx'

export const BACKDROP_FX_PRESETS = Object.freeze([
  { value: 'static-enhanced', label: 'Static Enhanced' },
  { value: 'subtle-glass', label: 'Subtle Glass' },
])

export const BACKDROP_FX_QUALITIES = Object.freeze([
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
])

export const DEFAULT_BACKDROP_FX_SETTINGS = Object.freeze({
  enabled: false,
  preset: 'static-enhanced',
  quality: 'medium',
  intensity: 50,
  reactToCursor: true,
  reactToWindows: true,
  reactToClicks: true,
  studioGridOverlay: false,
})

const PRESET_VALUES = new Set(BACKDROP_FX_PRESETS.map((item) => item.value))
const QUALITY_VALUES = new Set(BACKDROP_FX_QUALITIES.map((item) => item.value))
const PRESET_UNIFORM_VALUES = Object.freeze({
  'static-enhanced': 0,
  'subtle-glass': 1,
})
const REMOVED_PRESET_MIGRATIONS = Object.freeze({
  'depth-glass': { preset: 'subtle-glass', studioGridOverlay: false },
  'liquid-backdrop': { preset: 'subtle-glass', studioGridOverlay: false },
  'studio-grid': { preset: 'subtle-glass', studioGridOverlay: true },
})

function boolOrDefault(value, fallback) {
  return typeof value === 'boolean' ? value : fallback
}

export function sanitizeBackdropFxSettings(value) {
  const source = value && typeof value === 'object' ? value : {}
  const intensity = Number(source.intensity)
  const migrated = REMOVED_PRESET_MIGRATIONS[source.preset]
  const preset = migrated?.preset
    ?? (PRESET_VALUES.has(source.preset) ? source.preset : DEFAULT_BACKDROP_FX_SETTINGS.preset)
  const studioGridOverlay = migrated?.studioGridOverlay === true
    ? true
    : boolOrDefault(source.studioGridOverlay, DEFAULT_BACKDROP_FX_SETTINGS.studioGridOverlay)
  return {
    enabled: boolOrDefault(source.enabled, DEFAULT_BACKDROP_FX_SETTINGS.enabled),
    preset,
    quality: QUALITY_VALUES.has(source.quality) ? source.quality : DEFAULT_BACKDROP_FX_SETTINGS.quality,
    intensity: Number.isFinite(intensity) ? Math.max(0, Math.min(100, Math.round(intensity))) : DEFAULT_BACKDROP_FX_SETTINGS.intensity,
    reactToCursor: boolOrDefault(source.reactToCursor, DEFAULT_BACKDROP_FX_SETTINGS.reactToCursor),
    reactToWindows: boolOrDefault(source.reactToWindows, DEFAULT_BACKDROP_FX_SETTINGS.reactToWindows),
    reactToClicks: boolOrDefault(source.reactToClicks, DEFAULT_BACKDROP_FX_SETTINGS.reactToClicks),
    studioGridOverlay,
  }
}

export function qualityToRenderConfig(quality, devicePixelRatio = 1) {
  const normalized = QUALITY_VALUES.has(quality) ? quality : DEFAULT_BACKDROP_FX_SETTINGS.quality
  const scale = normalized === 'low' ? 0.5 : normalized === 'high' ? 1 : 0.75
  const maxDpr = normalized === 'high' ? 1.5 : normalized === 'medium' ? 1.25 : 1
  const dpr = Math.max(1, Math.min(Number(devicePixelRatio) || 1, maxDpr))
  return { scale, dpr, pixelRatio: scale * dpr }
}

export function backdropFxIntensityUniforms(intensity) {
  const normalized = Math.max(0, Math.min(1, Number(intensity) / 100 || 0))
  const base = {
    normalized,
    displacement: Math.pow(normalized, 1.18) * 2.8,
    glow: Math.pow(normalized, 0.9) * 1.25,
    ripple: Math.pow(normalized, 1.1) * 2.35,
    window: Math.pow(normalized, 1.05) * 1.85,
  }
  return base
}

export function backdropFxPresetToUniform(preset) {
  const sanitized = sanitizeBackdropFxSettings({ preset }).preset
  return PRESET_UNIFORM_VALUES[sanitized] ?? PRESET_UNIFORM_VALUES[DEFAULT_BACKDROP_FX_SETTINGS.preset]
}

export function isBackdropFxReactivePreset(preset) {
  const sanitized = sanitizeBackdropFxSettings({ preset }).preset
  return sanitized === 'subtle-glass'
}

export function backdropFxPresetNeedsAnimation(settings) {
  const s = sanitizeBackdropFxSettings(settings)
  return s.enabled
    && isBackdropFxReactivePreset(s.preset)
    && (s.reactToCursor || s.reactToWindows || s.reactToClicks)
}

export function resolveBackdropFxRuntime(settings, prefersReducedMotion = false) {
  const s = sanitizeBackdropFxSettings(settings)
  return {
    settings: s,
    enabled: s.enabled,
    reactiveAnimationAllowed: s.enabled && (!prefersReducedMotion || s.enabled),
    needsAnimation: backdropFxPresetNeedsAnimation(s) && (!prefersReducedMotion || s.enabled),
  }
}

function getXlethSettings() {
  return typeof window !== 'undefined' ? window.xleth?.settings : null
}

export const useBackdropFxSettingsStore = create((set, get) => ({
  settings: { ...DEFAULT_BACKDROP_FX_SETTINGS },
  hydrated: false,
  hydrate: async () => {
    const settingsBridge = getXlethSettings()
    if (!settingsBridge?.get) {
      set({ hydrated: true })
      return get().settings
    }
    try {
      const saved = await settingsBridge.get(BACKDROP_FX_SETTINGS_KEY)
      const next = sanitizeBackdropFxSettings(saved)
      set({ settings: next, hydrated: true })
      return next
    } catch (err) {
      console.warn('[BackdropFX] settings hydrate failed:', err?.message || err)
      set({ hydrated: true })
      return get().settings
    }
  },
  setSettings: async (patch) => {
    const next = sanitizeBackdropFxSettings({
      ...get().settings,
      ...(patch || {}),
    })
    set({ settings: next, hydrated: true })
    try {
      await getXlethSettings()?.set?.(BACKDROP_FX_SETTINGS_KEY, next)
    } catch (err) {
      console.warn('[BackdropFX] settings persist failed:', err?.message || err)
    }
    return next
  },
  resetForTests: () => set({
    settings: { ...DEFAULT_BACKDROP_FX_SETTINGS },
    hydrated: false,
  }),
}))
