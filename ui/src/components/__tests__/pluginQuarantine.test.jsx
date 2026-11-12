// @vitest-environment jsdom
// P2 host safety (docs/PLUGIN_HOSTING_LOG.md): the startup notice for a plugin
// whose load killed the previous engine, and the quarantined row of the
// missing-plugins dialog (Retry = audio.unquarantinePlugin).
import React, { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRoot } from 'react-dom/client'
import MissingPluginsDialog from '../MissingPluginsDialog.jsx'
import { reportLastPluginLoadCrash } from '../../XlethRoot.jsx'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

let container
let root
beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
  document.body.innerHTML = ''
  delete window.xleth
})

const render = (el) => act(async () => { root.render(el) })
const btn = (text) => Array.from(document.body.querySelectorAll('button')).find((b) => b.textContent.trim().startsWith(text))

describe('P2 load-crash notice', () => {
  it('shows ONE error toast naming the plugin, even when asked twice (StrictMode double mount)', async () => {
    const getLastLoadCrash = vi.fn()
      .mockResolvedValueOnce({ name: 'Crashy', vendor: 'Acme', phase: 'instantiate', quarantined: true })
      .mockResolvedValue(null)
    const xl = { audio: { getLastLoadCrash } }
    const showToast = vi.fn()

    const [a, b] = await Promise.all([
      reportLastPluginLoadCrash({ xl, showToast }),
      reportLastPluginLoadCrash({ xl, showToast }),
    ])

    // The engine record is read once (a second read would come back null) and
    // the toast fires once, however many mounts ask.
    expect(getLastLoadCrash).toHaveBeenCalledTimes(1)
    expect(a).toBe(true)
    expect(b).toBe(true)
    expect(showToast).toHaveBeenCalledTimes(1)
    const [message, level] = showToast.mock.calls[0]
    expect(message).toContain("XLETH's engine stopped while loading Crashy by Acme")
    expect(message).toContain('quarantined')
    expect(level).toBe('error')
  })
})

describe('Missing plugins dialog: quarantined rows', () => {
  const quarantined = {
    trackId: -1, nodeId: 3, pluginId: 'VST3-Crashy-1-2', pluginName: 'Crashy', pluginVendor: 'Acme',
    missingReason: 'quarantined', pluginFormat: 'VST3', uniqueId: 'e783521a', deprecatedUid: '5923c135',
  }

  it('says the plugin is quarantined, and Retry unquarantines it instead of a plain retry', async () => {
    const unquarantinePlugin = vi.fn().mockResolvedValue({ ok: true, removed: true, resolved: 1, failed: 0 })
    const retryMissingPlugin = vi.fn()
    const getMissingPlugins = vi.fn().mockResolvedValue('[]')
    window.xleth = { audio: { unquarantinePlugin, retryMissingPlugin, getMissingPlugins } }
    const onClose = vi.fn()

    await render(<MissingPluginsDialog plugins={[quarantined]} onClose={onClose} />)
    const dlg = document.querySelector('[role="dialog"]')
    expect(dlg.textContent).toContain("Quarantined: it crashed XLETH's engine while loading")
    expect(dlg.textContent).toContain('Acme · Master')

    await act(async () => { btn('Retry').click() })
    expect(unquarantinePlugin).toHaveBeenCalledWith('VST3', 'e783521a', '5923c135')
    expect(retryMissingPlugin).not.toHaveBeenCalled()
    // Resolved (no longer in getMissingPlugins) → the row is gone → dialog closes.
    expect(onClose).toHaveBeenCalled()
  })

  it('keeps the row as plain missing when the retry fails to load it', async () => {
    const unquarantinePlugin = vi.fn().mockResolvedValue({ ok: true, removed: true, resolved: 0, failed: 1 })
    const getMissingPlugins = vi.fn().mockResolvedValue(JSON.stringify([{ trackId: -1, nodeId: 3, missingReason: 'missing' }]))
    window.xleth = { audio: { unquarantinePlugin, getMissingPlugins } }

    await render(<MissingPluginsDialog plugins={[quarantined]} onClose={vi.fn()} />)
    await act(async () => { btn('Retry').click() })
    const dlg = document.querySelector('[role="dialog"]')
    expect(dlg.textContent).toContain('Crashy')
    expect(dlg.textContent).not.toContain('Quarantined')
  })
})
