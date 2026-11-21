/**
 * @vitest-environment jsdom
 *
 * P1 (docs/PLUGIN_HOSTING_LOG.md): VST3 search folders are engine-owned. The
 * pre-P1 renderer copy in localStorage ('xleth.vstSearchPaths') is pushed into
 * the engine's VST3 user folders once and then deleted; scans no longer carry
 * paths. Mounts the REAL VstBrowser against a stubbed window.xleth and asserts
 * on the captured IPC payloads.
 */
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import VstBrowser from '../VstBrowser.jsx'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const KEY = 'xleth.vstSearchPaths'
let container
let root
let audio
let engineUser

const flush = async () => {
  for (let i = 0; i < 5; i++) await act(async () => { await Promise.resolve() })
}

beforeEach(() => {
  engineUser = ['D:\\Engine\\VST3']
  audio = {
    getScannedPlugins: vi.fn(async () => '[]'),
    getFailedPlugins: vi.fn(async () => '[]'),
    getScanProgress: vi.fn(async () => ({ scanning: false, done: 0, total: 0 })),
    getPluginSearchPaths: vi.fn(async () => ({
      VST3: { defaults: ['C:\\Program Files\\Common Files\\VST3'], user: [...engineUser], useDefaults: true },
    })),
    setPluginSearchPaths: vi.fn(async (_fmt, user) => { engineUser = [...user]; return { ok: true } }),
    scanPlugins: vi.fn(async () => ({ ok: true })),
  }
  window.xleth = { audio }
  localStorage.clear()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  delete window.xleth
  localStorage.clear()
})

describe('VstBrowser search folders (engine-owned)', () => {
  it('migrates the legacy localStorage list into VST3.user once, then deletes the key', async () => {
    localStorage.setItem(KEY, JSON.stringify(['D:\\Legacy\\VST3', 'D:\\Engine\\VST3']))
    await act(async () => { root.render(<VstBrowser embedded />) })
    await flush()

    expect(audio.setPluginSearchPaths).toHaveBeenCalledTimes(1)
    expect(audio.setPluginSearchPaths).toHaveBeenCalledWith(
      'VST3', ['D:\\Engine\\VST3', 'D:\\Legacy\\VST3'], true)
    expect(localStorage.getItem(KEY)).toBeNull()
    expect(container.textContent).toContain('D:\\Legacy\\VST3')
  })

  it('keeps the legacy key when the engine refuses the write', async () => {
    audio.setPluginSearchPaths.mockResolvedValueOnce({ ok: false, error: 'scan-in-progress' })
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    localStorage.setItem(KEY, JSON.stringify(['D:\\Legacy\\VST3']))
    await act(async () => { root.render(<VstBrowser embedded />) })
    await flush()

    expect(localStorage.getItem(KEY)).not.toBeNull()
    expect(err).toHaveBeenCalled()
    err.mockRestore()
  })

  it('does not write when there is nothing to migrate, and scans without paths', async () => {
    await act(async () => { root.render(<VstBrowser embedded />) })
    await flush()
    expect(audio.setPluginSearchPaths).not.toHaveBeenCalled()
    expect(container.textContent).toContain('D:\\Engine\\VST3')

    const scan = [...container.querySelectorAll('button')].find((b) => /Scan plugins/.test(b.textContent))
    await act(async () => { scan.click() })
    expect(audio.scanPlugins).toHaveBeenCalledWith({ mode: 'incremental' })
  })

  it('removing a folder writes the engine list, not localStorage', async () => {
    await act(async () => { root.render(<VstBrowser embedded />) })
    await flush()
    const remove = [...container.querySelectorAll('button')]
      .find((b) => b.getAttribute('aria-label') === 'Remove D:\\Engine\\VST3')
    await act(async () => { remove.click() })
    await flush()
    expect(audio.setPluginSearchPaths).toHaveBeenCalledWith('VST3', [], true)
    expect(localStorage.getItem(KEY)).toBeNull()
  })
})
