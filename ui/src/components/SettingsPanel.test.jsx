/* @vitest-environment jsdom */
import React from 'react'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import SettingsPanel, { SETTINGS_CATEGORIES, SETTINGS_TABS } from './SettingsPanel.jsx'

describe('SettingsPanel consolidated shell', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
    window.xleth = {}
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
  })

  it('renders the responsive category shell without a standalone Theme Editor category', () => {
    const html = renderToStaticMarkup(<SettingsPanel onClose={() => {}} />)

    expect(html).toContain('role="dialog"')
    expect(html).toContain('aria-label="Settings pages"')
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

  it('renders one nav with both scope groups and marks the open page', () => {
    const projectHtml = renderToStaticMarkup(<SettingsPanel initialCategory="project" onClose={() => {}} />)

    expect(projectHtml).toContain('data-settings-tab="project"')
    expect(projectHtml).toContain('aria-labelledby="settings-group-project"')
    expect(projectHtml).toContain('aria-labelledby="settings-group-application"')
    expect(projectHtml).toContain('>Clip FX<')
    expect(projectHtml).toContain('>Plugins<')
    // Exactly one page is marked as the current one.
    expect(projectHtml.match(/aria-current="page"/g)).toHaveLength(1)

    const appHtml = renderToStaticMarkup(<SettingsPanel initialCategory="plugins" onClose={() => {}} />)
    expect(appHtml).toContain('data-settings-tab="application"')
    expect(appHtml).toContain('data-settings-category="plugins"')
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

    expect(html).toContain('Global clip processing')
    expect(html).toContain('New project default')
    expect(html).toContain('Formant preservation')
    expect(html).toContain('Autosave')
    // Absorbed from the old standalone Transport and Advanced pages.
    expect(html).toContain('Spacebar behavior')
    expect(html).toContain('Filename format')
    expect(html).toContain('aria-haspopup="listbox"')
    expect(html).not.toContain('<select')
  })

  it('renders the requested category content without native select markup', () => {
    const expectations = [
      ['clipfx', 'Swirl with Vibrato'],
      ['audio', 'Performance report'],
      ['plugins', 'Scan plugins'],
      ['graphics', 'Video encode and decode'],
      ['appearance', 'UI scale'],
      ['shortcuts', 'Panel toggles'],
      ['logs', 'Session log'],
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
    expect(html).toContain('VST3 plugin library')
    expect(html).toContain('aria-label="Search plugins"')
    expect(html).toContain('Scan plugins')
    expect(html).toContain('Add path')
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
      // A kit NumberBox: a slider you drag or type into.
      expect(brightness.getAttribute('role')).toBe('slider')
      expect(brightness.getAttribute('aria-valuemin')).toBe('0')
      expect(brightness.getAttribute('aria-valuemax')).toBe('100')
    } finally {
      await act(async () => root.unmount())
      container.remove()
    }
  })

  it('offers a 100-200 % UI scale in 10 % steps, a capped tint, and no workspace backdrop', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)

    try {
      await act(async () => {
        root.render(<SettingsPanel initialCategory="appearance" onClose={() => {}} />)
      })

      const scale = container.querySelector('#settings-ui-scale')
      expect(scale).not.toBeNull()
      expect(scale.getAttribute('role')).toBe('slider')
      expect(scale.getAttribute('aria-valuemin')).toBe('100')
      expect(scale.getAttribute('aria-valuemax')).toBe('200')

      expect(container.querySelector('#settings-appearance-saturation')).not.toBeNull()
      expect(container.textContent).toContain('Tint')
      expect(container.textContent).not.toContain('Backdrop')
      expect(container.textContent).not.toContain('backdrop')
      // The Floor-preserving minimum for text contrast.
      expect(container.querySelector('#settings-appearance-contrast').getAttribute('aria-valuemin')).toBe('80')
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
        expect(box.getAttribute('aria-pressed')).toBe('false')
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
        expect(container.querySelector('#settings-purge-on-close').getAttribute('aria-pressed')).toBe('true')
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
        expect(container.querySelector('#settings-purge-on-close').getAttribute('aria-pressed')).toBe('true')
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
