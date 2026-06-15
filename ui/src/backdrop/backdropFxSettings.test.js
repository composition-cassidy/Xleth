import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  BACKDROP_FX_PRESETS,
  BACKDROP_FX_SETTINGS_KEY,
  DEFAULT_BACKDROP_FX_SETTINGS,
  backdropFxIntensityUniforms,
  backdropFxPresetNeedsAnimation,
  backdropFxPresetToUniform,
  isBackdropFxReactivePreset,
  qualityToRenderConfig,
  resolveBackdropFxRuntime,
  sanitizeBackdropFxSettings,
  useBackdropFxSettingsStore,
} from './backdropFxSettings.js'

describe('backdrop FX settings', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('defaults to disabled static behavior', () => {
    expect(sanitizeBackdropFxSettings(null)).toEqual(DEFAULT_BACKDROP_FX_SETTINGS)
    expect(sanitizeBackdropFxSettings(null).studioGridOverlay).toBe(false)
    expect(backdropFxPresetNeedsAnimation(DEFAULT_BACKDROP_FX_SETTINGS)).toBe(false)
  })

  it('only exposes the final preset ids and labels', () => {
    expect(BACKDROP_FX_PRESETS.map((preset) => preset.value)).toEqual([
      'static-enhanced',
      'subtle-glass',
    ])
    expect(BACKDROP_FX_PRESETS.map((preset) => preset.label)).toEqual([
      'Static Enhanced',
      'Subtle Glass',
    ])
  })

  it('sanitizes supported preset ids while keeping unknown values on the safe default', () => {
    for (const preset of BACKDROP_FX_PRESETS) {
      expect(sanitizeBackdropFxSettings({ preset: preset.value }).preset).toBe(preset.value)
    }
    expect(sanitizeBackdropFxSettings({ preset: 'future-fx' }).preset).toBe(DEFAULT_BACKDROP_FX_SETTINGS.preset)
  })

  it('migrates removed preset ids to compatible Subtle Glass settings', () => {
    expect(sanitizeBackdropFxSettings({ preset: 'depth-glass' })).toMatchObject({
      preset: 'subtle-glass',
      studioGridOverlay: false,
    })
    expect(sanitizeBackdropFxSettings({ preset: 'liquid-backdrop' })).toMatchObject({
      preset: 'subtle-glass',
      studioGridOverlay: false,
    })
    expect(sanitizeBackdropFxSettings({ preset: 'studio-grid' })).toMatchObject({
      preset: 'subtle-glass',
      studioGridOverlay: true,
    })
  })

  it('maps quality to bounded render scale and DPR caps', () => {
    expect(qualityToRenderConfig('low', 4)).toMatchObject({ scale: 0.5, dpr: 1 })
    expect(qualityToRenderConfig('medium', 4)).toMatchObject({ scale: 0.75, dpr: 1.25 })
    expect(qualityToRenderConfig('high', 4)).toMatchObject({ scale: 1, dpr: 1.5 })
    expect(qualityToRenderConfig('unknown', 2)).toMatchObject({ scale: 0.75, dpr: 1.25 })
  })

  it('maps intensity into stronger high-end reactive channels', () => {
    const zero = backdropFxIntensityUniforms(0)
    const mid = backdropFxIntensityUniforms(50)
    const high = backdropFxIntensityUniforms(100)

    expect(zero).toMatchObject({
      normalized: 0,
      displacement: 0,
      glow: 0,
      ripple: 0,
      window: 0,
    })
    expect(mid.normalized).toBe(0.5)
    expect(mid.displacement).toBeGreaterThan(0.8)
    expect(high.displacement).toBeGreaterThan(mid.displacement * 2)
    expect(high.ripple).toBeGreaterThan(mid.ripple * 2)
    expect(high.window).toBeGreaterThan(mid.window * 2)
  })

  it('preserves saved current presets and overlay settings', () => {
    expect(sanitizeBackdropFxSettings({ preset: 'static-enhanced' }).preset).toBe('static-enhanced')
    expect(sanitizeBackdropFxSettings({ preset: 'subtle-glass' }).preset).toBe('subtle-glass')
    expect(sanitizeBackdropFxSettings({
      preset: 'subtle-glass',
      studioGridOverlay: true,
    }).studioGridOverlay).toBe(true)
  })

  it('classifies only Subtle Glass as reactive for RAF and input routing', () => {
    expect(isBackdropFxReactivePreset('static-enhanced')).toBe(false)
    expect(backdropFxPresetToUniform('static-enhanced')).toBe(0)
    expect(isBackdropFxReactivePreset('subtle-glass')).toBe(true)
    expect(backdropFxPresetToUniform('subtle-glass')).toBe(1)

    expect(backdropFxPresetNeedsAnimation({
      ...DEFAULT_BACKDROP_FX_SETTINGS,
      enabled: true,
      preset: 'subtle-glass',
    })).toBe(true)

    expect(backdropFxPresetToUniform('not-real')).toBe(0)
  })

  it('keeps reduced-motion defaults non-reactive until the user enables FX', () => {
    expect(resolveBackdropFxRuntime(DEFAULT_BACKDROP_FX_SETTINGS, true).enabled).toBe(false)
    expect(resolveBackdropFxRuntime(DEFAULT_BACKDROP_FX_SETTINGS, true).needsAnimation).toBe(false)
    expect(resolveBackdropFxRuntime({
      ...DEFAULT_BACKDROP_FX_SETTINGS,
      enabled: true,
      preset: 'subtle-glass',
    }, true).needsAnimation).toBe(true)
  })

  it('hydrates and persists only through explicit store actions', async () => {
    useBackdropFxSettingsStore.getState().resetForTests()
    const saved = {
      enabled: true,
      preset: 'subtle-glass',
      quality: 'high',
      intensity: 80,
      studioGridOverlay: true,
    }
    const get = vi.fn().mockResolvedValue(saved)
    const set = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('window', { xleth: { settings: { get, set } } })

    expect(get).not.toHaveBeenCalled()
    await useBackdropFxSettingsStore.getState().hydrate()
    expect(get).toHaveBeenCalledWith(BACKDROP_FX_SETTINGS_KEY)
    expect(useBackdropFxSettingsStore.getState().settings).toMatchObject(saved)

    await useBackdropFxSettingsStore.getState().setSettings({ intensity: 42 })
    expect(set).toHaveBeenCalledWith(BACKDROP_FX_SETTINGS_KEY, expect.objectContaining({
      intensity: 42,
      studioGridOverlay: true,
    }))
  })
})
