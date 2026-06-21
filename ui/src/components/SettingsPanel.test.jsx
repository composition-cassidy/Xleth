/* @vitest-environment jsdom */
import React from 'react'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import SettingsPanel, { SETTINGS_CATEGORIES } from './SettingsPanel.jsx'
import {
  DEFAULT_BACKDROP_FX_SETTINGS,
  useBackdropFxSettingsStore,
} from '../backdrop/backdropFxSettings.js'
import {
  useBackdropMediaSettingsStore,
} from '../backdrop/backdropMediaSettings.js'

describe('SettingsPanel consolidated shell', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
    window.xleth = {
      backdrop: {
        current: { capability: null, preference: 'acrylic', mode: 'off' },
        chooseImage: () => Promise.resolve(null),
        chooseVideo: () => Promise.resolve(null),
      },
    }
    useBackdropFxSettingsStore.getState().resetForTests()
    useBackdropMediaSettingsStore.getState().resetForTests()
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
  })

  it('renders the responsive category shell without a standalone Theme Editor category', () => {
    const html = renderToStaticMarkup(<SettingsPanel onClose={() => {}} />)

    expect(html).toContain('settings-panel-shell')
    expect(html).toContain('settings-panel-categories')
    expect(html).not.toContain('Theme Editor')
    expect(SETTINGS_CATEGORIES.every(category => !('icon' in category))).toBe(true)
    expect(SETTINGS_CATEGORIES.map(category => category.id)).toEqual([
      'project',
      'transport',
      'audio',
      'plugins',
      'graphics',
      'appearance',
      'launchers',
      'advanced',
    ])
  })

  it('renders project settings with themed select triggers instead of native selects', () => {
    const html = renderToStaticMarkup(<SettingsPanel onClose={() => {}} />)

    expect(html).toContain('Global Clip Processing')
    expect(html).toContain('New Project Default')
    expect(html).toContain('Formant Preservation')
    expect(html).toContain('Autosave')
    expect(html).toContain('xleth-select-trigger')
    expect(html).not.toContain('<select')
  })

  it('renders the requested category content without native select markup', () => {
    const expectations = [
      ['transport', 'Spacebar behavior'],
      ['audio', 'Performance report'],
      ['plugins', 'VST3 Browser'],
      ['graphics', 'Video encode/decode'],
      ['appearance', 'Backdrop Media'],
      ['advanced', 'Filename Format'],
    ]

    for (const [category, label] of expectations) {
      const html = renderToStaticMarkup(
        <SettingsPanel initialCategory={category} onClose={() => {}} />
      )

      expect(html).toContain(`data-settings-category="${category}"`)
      expect(html).toContain(label)
      expect(html).not.toContain('<select')
    }
  })

  it('renders the VST3 browser inside the Plugins settings category', () => {
    const html = renderToStaticMarkup(
      <SettingsPanel initialCategory="plugins" onClose={() => {}} />
    )

    expect(html).toContain('data-settings-category="plugins"')
    expect(html).toContain('VST3 Plugin Library')
    expect(html).toContain('vst-browser--embedded')
    expect(html).toContain('Scan Plugins')
    expect(html).toContain('Add Path')
  })

  it('exposes accent color and brightness controls in the Appearance category', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)

    try {
      await act(async () => {
        root.render(<SettingsPanel initialCategory="appearance" onClose={() => {}} />)
      })

      expect(container.textContent).toContain('Accent color')
      expect(container.textContent).toContain('Brightness')
      expect(container.querySelector('#settings-appearance-accent')).not.toBeNull()
      const brightness = container.querySelector('#settings-appearance-brightness')
      expect(brightness).not.toBeNull()
      expect(brightness.getAttribute('type')).toBe('range')
    } finally {
      await act(async () => root.unmount())
      container.remove()
    }
  })

  it('offers Backdrop Media source modes separately from Backdrop FX', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)

    try {
      await act(async () => {
        root.render(<SettingsPanel initialCategory="appearance" onClose={() => {}} />)
      })

      expect(container.textContent).toContain('Backdrop Media')
      expect(container.textContent).toContain('Backdrop FX')
      expect(container.textContent).toContain('Enable reactive backdrop')

      await act(async () => {
        container.querySelector('[aria-label="Backdrop Media source"]').dispatchEvent(new MouseEvent('click', {
          bubbles: true,
        }))
      })

      const optionLabels = Array.from(document.body.querySelectorAll('[role="option"]'))
        .map((option) => option.textContent)
      expect(optionLabels).toEqual(['None', 'Acrylic', 'Image', 'Video'])
    } finally {
      await act(async () => root.unmount())
      container.remove()
    }
  })

  it('persists Acrylic as a backdrop media source when selected', async () => {
    const setMedia = vi.fn().mockResolvedValue({
      capability: { supportsNativeSystemBackdrop: true },
      preference: 'acrylic',
      mode: 'native-acrylic',
      imagePath: null,
      imageUrl: null,
      videoPath: null,
      videoUrl: null,
      lastError: null,
    })
    window.xleth.backdrop.setMedia = setMedia
    useBackdropMediaSettingsStore.setState({
      settings: {
        sourceType: 'none',
        imagePath: '',
        videoPath: '',
        lastError: '',
      },
      hydrated: true,
    })
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)

    try {
      await act(async () => {
        root.render(<SettingsPanel initialCategory="appearance" onClose={() => {}} />)
      })

      await act(async () => {
        container.querySelector('[aria-label="Backdrop Media source"]').dispatchEvent(new MouseEvent('click', {
          bubbles: true,
        }))
      })

      const acrylicOption = Array.from(document.body.querySelectorAll('[role="option"]'))
        .find((option) => option.textContent === 'Acrylic')
      expect(acrylicOption).not.toBeNull()

      await act(async () => {
        acrylicOption.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      })

      expect(setMedia).toHaveBeenCalledWith(expect.objectContaining({
        sourceType: 'acrylic',
      }))
      expect(useBackdropMediaSettingsStore.getState().settings.sourceType).toBe('acrylic')
    } finally {
      await act(async () => root.unmount())
      container.remove()
    }
  })

  it('shows MP4 controls and active video path when Video media is selected', async () => {
    window.xleth.backdrop.current = {
      capability: null,
      preference: 'video',
      mode: 'video',
      imagePath: null,
      imageUrl: null,
      videoPath: 'C:\\Loops\\calm.mp4',
      videoUrl: 'xleth-media://c/Loops/calm.mp4',
      lastError: 'Video backdrop could not be played. The file may be missing or unsupported.',
    }
    useBackdropMediaSettingsStore.setState({
      settings: {
        sourceType: 'video',
        imagePath: '',
        videoPath: 'C:\\Loops\\calm.mp4',
        lastError: 'Video backdrop could not be played. The file may be missing or unsupported.',
      },
      hydrated: true,
    })
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)

    try {
      await act(async () => {
        root.render(<SettingsPanel initialCategory="appearance" onClose={() => {}} />)
      })

      expect(container.textContent).toContain('Change MP4...')
      expect(container.textContent).toContain('Active file: C:\\Loops\\calm.mp4')
      expect(container.textContent).toContain('Video is always muted and looped.')
      expect(container.textContent).toContain('Video backdrop could not be played.')
    } finally {
      await act(async () => root.unmount())
      container.remove()
    }
  })

  it('falls back to renderer MP4 selection when the main backdrop media handler is unavailable', async () => {
    const set = vi.fn().mockResolvedValue(undefined)
    const getDroppedFilePath = vi.fn().mockReturnValue('C:\\Loops\\fallback.mp4')
    window.xleth = {
      ...window.xleth,
      getDroppedFilePath,
      settings: { set },
    }
    useBackdropMediaSettingsStore.setState({
      settings: {
        sourceType: 'video',
        imagePath: '',
        videoPath: '',
        lastError: '',
      },
      hydrated: true,
    })
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)

    try {
      await act(async () => {
        root.render(<SettingsPanel initialCategory="appearance" onClose={() => {}} />)
      })

      const input = container.querySelector('.settings-panel-hidden-file-input')
      const file = new File([''], 'fallback.mp4', { type: 'video/mp4' })
      Object.defineProperty(input, 'files', { configurable: true, value: [file] })

      await act(async () => {
        input.dispatchEvent(new Event('change', { bubbles: true }))
      })

      expect(getDroppedFilePath).toHaveBeenCalledWith(file)
      expect(set).toHaveBeenCalledWith('backdropMedia', expect.objectContaining({
        sourceType: 'video',
        videoPath: 'C:\\Loops\\fallback.mp4',
      }))
      expect(useBackdropMediaSettingsStore.getState().settings.videoPath).toBe('C:\\Loops\\fallback.mp4')
    } finally {
      await act(async () => root.unmount())
      container.remove()
    }
  })

  it('shows only the final Backdrop FX preset labels in the preset dropdown', async () => {
    useBackdropFxSettingsStore.setState({
      settings: {
        ...DEFAULT_BACKDROP_FX_SETTINGS,
        enabled: true,
      },
      hydrated: true,
    })
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)

    try {
      await act(async () => {
        root.render(<SettingsPanel initialCategory="appearance" onClose={() => {}} />)
      })

      await act(async () => {
        container.querySelector('[aria-label="Backdrop FX preset"]').dispatchEvent(new MouseEvent('click', {
          bubbles: true,
        }))
      })

      const optionLabels = Array.from(document.body.querySelectorAll('[role="option"]'))
        .map((option) => option.textContent)
      expect(optionLabels).toEqual(['Static Enhanced', 'Subtle Glass'])
    } finally {
      await act(async () => root.unmount())
      container.remove()
    }
  })

  it('shows the Studio Grid overlay checkbox disabled for Static Enhanced', async () => {
    useBackdropFxSettingsStore.setState({
      settings: {
        ...DEFAULT_BACKDROP_FX_SETTINGS,
        enabled: true,
        preset: 'static-enhanced',
      },
      hydrated: true,
    })
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)

    try {
      await act(async () => {
        root.render(<SettingsPanel initialCategory="appearance" onClose={() => {}} />)
      })

      const overlayCheckbox = container.querySelector('#settings-backdrop-fx-studio-grid')
      expect(container.textContent).toContain('Studio Grid overlay')
      expect(overlayCheckbox).not.toBeNull()
      expect(overlayCheckbox.disabled).toBe(true)
    } finally {
      await act(async () => root.unmount())
      container.remove()
    }
  })

  it('enables the Studio Grid overlay checkbox for enabled Subtle Glass', async () => {
    useBackdropFxSettingsStore.setState({
      settings: {
        ...DEFAULT_BACKDROP_FX_SETTINGS,
        enabled: true,
        preset: 'subtle-glass',
      },
      hydrated: true,
    })
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)

    try {
      await act(async () => {
        root.render(<SettingsPanel initialCategory="appearance" onClose={() => {}} />)
      })

      const overlayCheckbox = container.querySelector('#settings-backdrop-fx-studio-grid')
      expect(container.textContent).toContain('Studio Grid overlay')
      expect(overlayCheckbox).not.toBeNull()
      expect(overlayCheckbox.disabled).toBe(false)
    } finally {
      await act(async () => root.unmount())
      container.remove()
    }
  })
})
