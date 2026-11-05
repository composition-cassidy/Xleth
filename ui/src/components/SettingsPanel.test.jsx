/* @vitest-environment jsdom */
import React from 'react'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import SettingsPanel, { SETTINGS_CATEGORIES, SETTINGS_TABS } from './SettingsPanel.jsx'
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
      'clipfx',
      'audio',
      'plugins',
      'graphics',
      'appearance',
      'shortcuts',
      'launchers',
      'logs',
    ])
  })

  it('groups every category under exactly one of the two tabs', () => {
    expect(SETTINGS_TABS.map(tab => tab.id)).toEqual(['project', 'application'])

    const tabIds = new Set(SETTINGS_TABS.map(tab => tab.id))
    for (const category of SETTINGS_CATEGORIES) {
      expect(tabIds.has(category.tab)).toBe(true)
    }

    // Both tabs must be reachable: selecting one shows its first page, so a
    // tab with no categories would be a dead control.
    for (const tab of SETTINGS_TABS) {
      expect(SETTINGS_CATEGORIES.some(category => category.tab === tab.id)).toBe(true)
    }
  })

  it('renders the tab strip and only the active tab categories in the sub-nav', () => {
    const projectHtml = renderToStaticMarkup(<SettingsPanel initialCategory="project" onClose={() => {}} />)

    expect(projectHtml).toContain('settings-panel-tabs')
    expect(projectHtml).toContain('data-settings-tab="project"')
    expect(projectHtml).toContain('Clip FX')
    // An Application-tab page must not appear in the Project tab's sub-nav.
    expect(projectHtml).not.toContain('>Plugins<')

    const appHtml = renderToStaticMarkup(<SettingsPanel initialCategory="plugins" onClose={() => {}} />)
    expect(appHtml).toContain('data-settings-tab="application"')
    expect(appHtml).toContain('>Plugins<')
  })

  it('lands merged Transport and Advanced deep links on the Project page', () => {
    for (const legacy of ['transport', 'advanced']) {
      const html = renderToStaticMarkup(
        <SettingsPanel initialCategory={legacy} onClose={() => {}} />
      )
      expect(html).toContain('data-settings-category="project"')
    }
  })

  it('renders project settings with themed select triggers instead of native selects', () => {
    const html = renderToStaticMarkup(<SettingsPanel onClose={() => {}} />)

    expect(html).toContain('Global Clip Processing')
    expect(html).toContain('New Project Default')
    expect(html).toContain('Formant Preservation')
    expect(html).toContain('Autosave')
    // Absorbed from the old standalone Transport and Advanced pages.
    expect(html).toContain('Spacebar behavior')
    expect(html).toContain('Filename Format')
    expect(html).toContain('xleth-select-trigger')
    expect(html).not.toContain('<select')
  })

  it('renders the requested category content without native select markup', () => {
    const expectations = [
      ['clipfx', 'Swirl with Vibrato'],
      ['audio', 'Performance report'],
      ['plugins', 'VST3 Browser'],
      ['graphics', 'Video encode/decode'],
      ['appearance', 'Backdrop Media'],
      ['shortcuts', 'Panel Toggles'],
      ['logs', 'Session Log'],
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

  it('applies the proxy codec to both the settings store and the engine', async () => {
    const settingsSet = vi.fn().mockResolvedValue(true)
    const setCodec = vi.fn().mockResolvedValue({ requested: 'intra', effective: 'intra', h264Available: true })
    window.xleth.settings = { get: vi.fn().mockResolvedValue(null), set: settingsSet }
    window.xleth.proxy = {
      getCodec: vi.fn().mockResolvedValue({ requested: 'h264', effective: 'h264', h264Available: true }),
      setCodec,
    }
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)

    try {
      await act(async () => {
        root.render(<SettingsPanel initialCategory="graphics" onClose={() => {}} />)
      })

      const trigger = container.querySelector('[aria-label="Proxy codec"]')
      expect(trigger).not.toBeNull()
      expect(trigger.textContent).toContain('H.264')

      await act(async () => {
        trigger.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      })
      const intra = Array.from(document.body.querySelectorAll('[role="option"]'))
        .find((option) => option.textContent.includes('All-intra'))
      expect(intra).toBeTruthy()
      await act(async () => {
        intra.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      })

      expect(settingsSet).toHaveBeenCalledWith('proxyCodec', 'intra')
      expect(setCodec).toHaveBeenCalledWith('intra')
    } finally {
      await act(async () => root.unmount())
      container.remove()
    }
  })

  it('warns when H.264 is selected but no H.264 encoder is available', async () => {
    window.xleth.settings = { get: vi.fn().mockResolvedValue(null), set: vi.fn() }
    window.xleth.proxy = {
      getCodec: vi.fn().mockResolvedValue({ requested: 'h264', effective: 'intra', h264Available: false }),
      setCodec: vi.fn(),
    }
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)

    try {
      await act(async () => {
        root.render(<SettingsPanel initialCategory="graphics" onClose={() => {}} />)
      })
      expect(container.textContent).toContain('No H.264 encoder is available')
    } finally {
      await act(async () => root.unmount())
      container.remove()
    }
  })

  describe('Delete regenerable files when closing a project', () => {
    async function mount(xleth) {
      Object.assign(window.xleth, xleth)
      const container = document.createElement('div')
      document.body.appendChild(container)
      const root = createRoot(container)
      await act(async () => {
        root.render(<SettingsPanel initialCategory="graphics" onClose={() => {}} />)
      })
      const unmount = async () => { await act(async () => root.unmount()); container.remove() }
      return { container, unmount }
    }

    it('is OFF by default', async () => {
      const { container, unmount } = await mount({
        settings: { get: vi.fn().mockResolvedValue(null), set: vi.fn() },
        proxy: { getCodec: vi.fn().mockResolvedValue(null) },
      })
      try {
        const box = container.querySelector('#settings-purge-on-close')
        expect(box).not.toBeNull()
        expect(box.checked).toBe(false)
        expect(container.textContent).toContain('Delete regenerable files when closing a project')
      } finally { await unmount() }
    })

    it('restores the persisted value', async () => {
      const { container, unmount } = await mount({
        settings: {
          get: vi.fn().mockImplementation(async (key) => (key === 'purgeRegenerableOnClose' ? true : null)),
          set: vi.fn(),
        },
        proxy: { getCodec: vi.fn().mockResolvedValue(null) },
      })
      try {
        expect(container.querySelector('#settings-purge-on-close').checked).toBe(true)
      } finally { await unmount() }
    })

    it('persists the choice AND pushes it to the engine, confirming the echoed value', async () => {
      const set = vi.fn().mockResolvedValue(true)
      // The engine echoes the value now in force; the mock must too.
      const setPurgeOnClose = vi.fn(async (enabled) => enabled)
      const { container, unmount } = await mount({
        settings: { get: vi.fn().mockResolvedValue(null), set },
        proxy: { getCodec: vi.fn().mockResolvedValue(null) },
        project: { setPurgeOnClose },
      })
      try {
        const box = container.querySelector('#settings-purge-on-close')
        await act(async () => { box.click() })
        expect(set).toHaveBeenCalledWith('purgeRegenerableOnClose', true)
        expect(setPurgeOnClose).toHaveBeenCalledWith(true)
        expect(container.querySelector('#settings-purge-on-close').checked).toBe(true)
        expect(container.textContent).not.toContain('Could not apply this setting')

        await act(async () => { container.querySelector('#settings-purge-on-close').click() })
        expect(set).toHaveBeenLastCalledWith('purgeRegenerableOnClose', false)
        expect(setPurgeOnClose).toHaveBeenLastCalledWith(false)
      } finally { await unmount() }
    })

    it('warns when the engine bridge call is missing or does not echo the value', async () => {
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      try {
        // Missing bridge call: optional chaining would swallow this silently.
        let ctx = await mount({
          settings: { get: vi.fn().mockResolvedValue(null), set: vi.fn().mockResolvedValue(true) },
          proxy: { getCodec: vi.fn().mockResolvedValue(null) },
          project: {},
        })
        await act(async () => { ctx.container.querySelector('#settings-purge-on-close').click() })
        expect(ctx.container.textContent).toContain('Could not apply this setting to the engine')
        await ctx.unmount()

        // Engine answered, but with the wrong value.
        ctx = await mount({
          settings: { get: vi.fn().mockResolvedValue(null), set: vi.fn().mockResolvedValue(true) },
          proxy: { getCodec: vi.fn().mockResolvedValue(null) },
          project: { setPurgeOnClose: vi.fn().mockResolvedValue(false) },
        })
        await act(async () => { ctx.container.querySelector('#settings-purge-on-close').click() })
        expect(ctx.container.textContent).toContain('Could not apply this setting to the engine')
        await ctx.unmount()
      } finally { errSpy.mockRestore() }
    })
  })
})
