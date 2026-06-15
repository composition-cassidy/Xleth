import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  BACKDROP_MEDIA_SETTINGS_KEY,
  DEFAULT_BACKDROP_MEDIA_SETTINGS,
  localMediaPathToXlethMediaUrl,
  sanitizeBackdropMediaSettings,
  useBackdropMediaSettingsStore,
} from './backdropMediaSettings.js'

describe('backdrop media settings', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    useBackdropMediaSettingsStore.getState().resetForTests()
  })

  it('sanitizes valid source modes and paths', () => {
    expect(sanitizeBackdropMediaSettings({ sourceType: 'none' })).toMatchObject({ sourceType: 'none' })
    expect(sanitizeBackdropMediaSettings({ sourceType: 'acrylic' })).toMatchObject({ sourceType: 'acrylic' })
    expect(sanitizeBackdropMediaSettings('acrylic')).toMatchObject({ sourceType: 'acrylic' })
    expect(sanitizeBackdropMediaSettings({ sourceType: 'image', imagePath: 'C:\\Art\\still.png' })).toMatchObject({
      sourceType: 'image',
      imagePath: 'C:\\Art\\still.png',
    })
    expect(sanitizeBackdropMediaSettings({ sourceType: 'video', videoPath: 'C:\\Art\\loop.mp4' })).toMatchObject({
      sourceType: 'video',
      videoPath: 'C:\\Art\\loop.mp4',
    })
  })

  it('falls back from invalid source types to existing image mode when possible', () => {
    expect(sanitizeBackdropMediaSettings({ sourceType: 'future' })).toEqual(DEFAULT_BACKDROP_MEDIA_SETTINGS)
    expect(sanitizeBackdropMediaSettings(
      { sourceType: 'future' },
      { mode: 'image', imagePath: 'C:\\Art\\old.webp' },
    )).toMatchObject({
      sourceType: 'image',
      imagePath: 'C:\\Art\\old.webp',
    })
    expect(sanitizeBackdropMediaSettings(
      { sourceType: 'future' },
      { mode: 'native-acrylic', preference: 'acrylic' },
    )).toMatchObject({
      sourceType: 'acrylic',
    })
  })

  it('sanitizes non-string paths to empty strings', () => {
    expect(sanitizeBackdropMediaSettings({
      sourceType: 'video',
      imagePath: 12,
      videoPath: { path: 'nope' },
    })).toMatchObject({
      sourceType: 'video',
      imagePath: '',
      videoPath: '',
    })
  })

  it('hydrates and persists without touching window at import time', async () => {
    const get = vi.fn().mockResolvedValue({
      sourceType: 'video',
      videoPath: 'C:\\Loops\\bg #1.mp4',
    })
    const setMedia = vi.fn().mockResolvedValue({
      mode: 'video',
      videoPath: 'C:\\Loops\\bg #2.mp4',
    })
    vi.stubGlobal('window', {
      xleth: {
        settings: { get },
        backdrop: {
          current: null,
          setMedia,
        },
      },
    })

    expect(get).not.toHaveBeenCalled()
    await useBackdropMediaSettingsStore.getState().hydrate()
    expect(get).toHaveBeenCalledWith(BACKDROP_MEDIA_SETTINGS_KEY)
    expect(useBackdropMediaSettingsStore.getState().settings.videoPath).toBe('C:\\Loops\\bg #1.mp4')

    await useBackdropMediaSettingsStore.getState().setSettings({ videoPath: 'C:\\Loops\\bg #2.mp4' })
    expect(setMedia).toHaveBeenCalledWith(expect.objectContaining({
      sourceType: 'video',
      videoPath: 'C:\\Loops\\bg #2.mp4',
    }))
  })

  it('builds encoded xleth-media URLs for Windows paths', () => {
    expect(localMediaPathToXlethMediaUrl('C:\\Video Loops\\a#b ü.mp4'))
      .toBe('xleth-media://c/Video%20Loops/a%23b%20%C3%BC.mp4')
  })
})
