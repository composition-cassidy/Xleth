/* @vitest-environment jsdom */
// The Theme Editor is reachable from Settings > Appearance: closed by default, opened by one
// button, closed by the same button. It needs the ThemeProvider, so without one the section is
// absent rather than broken.
import React from 'react'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import SettingsPanel from './SettingsPanel.jsx'
import { ThemeContext } from '../theming/runtime/ThemeProvider'
import { getShippedTheme } from '../theming/runtime/ThemeLoader'
import { resolveTheme } from '../theming/runtime/applyTheme'

const SLUG = 'xleth-default'

function makeContext() {
  const theme = getShippedTheme(SLUG)
  return {
    slug: SLUG,
    theme,
    resolved: resolveTheme(theme),
    source: 'shipped',
    warnings: [],
    setTheme: vi.fn(async () => undefined),
    updateTokens: vi.fn(),
    setDerivationDetached: vi.fn(),
    flushSaves: vi.fn(async () => undefined),
  }
}

async function mount(ui) {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  await act(async () => root.render(ui))
  return {
    container,
    cleanup: async () => {
      await act(async () => root.unmount())
      container.remove()
    },
  }
}

describe('Settings > Appearance hosts the Theme Editor', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
    window.xleth = {}
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
  })

  it('shows an Open editor button and no editor until it is pressed', async () => {
    const { container, cleanup } = await mount(
      <ThemeContext.Provider value={makeContext()}>
        <SettingsPanel initialCategory="appearance" onClose={() => {}} />
      </ThemeContext.Provider>,
    )
    try {
      const button = [...container.querySelectorAll('button')].find((b) => b.textContent === 'Open editor')
      expect(button).toBeTruthy()
      expect(button.getAttribute('aria-expanded')).toBe('false')
      expect(container.querySelector('.theme-editor-content')).toBeNull()
    } finally {
      await cleanup()
    }
  })

  it('mounts the embedded editor on Open and unmounts it on Close', async () => {
    const { container, cleanup } = await mount(
      <ThemeContext.Provider value={makeContext()}>
        <SettingsPanel initialCategory="appearance" onClose={() => {}} />
      </ThemeContext.Provider>,
    )
    try {
      const find = (text) => [...container.querySelectorAll('button')].find((b) => b.textContent === text)
      await act(async () => find('Open editor').click())

      const editor = container.querySelector('.theme-editor-content')
      expect(editor).not.toBeNull()
      expect(editor.classList.contains('theme-editor-content--embedded')).toBe(true)
      // Embedded, so the overlay chrome (header, close X, backdrop) is not rendered.
      expect(container.querySelector('.theme-editor-backdrop')).toBeNull()
      expect(container.querySelector('.theme-editor-header')).toBeNull()
      // Its two modes, theme list, preview and the Apply / Revert footer are all reachable.
      expect(editor.textContent).toContain('Simple')
      expect(editor.textContent).toContain('Advanced')
      const inEditor = (text) => [...editor.querySelectorAll('button')].some((b) => b.textContent === text)
      for (const text of ['Apply', 'Revert', 'Save as New Theme']) expect(inEditor(text)).toBe(true)
      expect(find('Close editor').getAttribute('aria-expanded')).toBe('true')

      await act(async () => find('Close editor').click())
      expect(container.querySelector('.theme-editor-content')).toBeNull()
      expect(find('Open editor')).toBeTruthy()
    } finally {
      await cleanup()
    }
  })

  it('Apply sets the working theme through the provider', async () => {
    const ctx = makeContext()
    const { container, cleanup } = await mount(
      <ThemeContext.Provider value={ctx}>
        <SettingsPanel initialCategory="appearance" onClose={() => {}} />
      </ThemeContext.Provider>,
    )
    try {
      const find = (text) => [...container.querySelectorAll('button')].find((b) => b.textContent === text)
      await act(async () => find('Open editor').click())
      const editorApply = [...container.querySelectorAll('.theme-editor-footer .theme-editor-btn--primary')].find((b) => b.textContent === 'Apply')
      await act(async () => editorApply.click())
      expect(ctx.setTheme).toHaveBeenCalledTimes(1)
      expect(ctx.setTheme.mock.calls[0][0]).toBe(SLUG)
    } finally {
      await cleanup()
    }
  })

  it('omits the section when there is no ThemeProvider', async () => {
    const { container, cleanup } = await mount(
      <SettingsPanel initialCategory="appearance" onClose={() => {}} />,
    )
    try {
      expect(container.textContent).not.toContain('Open editor')
      expect(container.textContent).toContain('Accent color')
    } finally {
      await cleanup()
    }
  })
})
