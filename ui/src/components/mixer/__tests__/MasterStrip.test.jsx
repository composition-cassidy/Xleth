/**
 * @vitest-environment jsdom
 */
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

async function loadMasterStripFixture() {
  const masterModule = await import('../MasterStrip.jsx')
  const { default: useMixerStore } = await import('../../../stores/mixerStore.js')
  return { MasterStrip: masterModule.default, useMixerStore }
}

async function renderMasterStrip(Component) {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  await act(async () => {
    root.render(<Component />)
  })
  return { container, root }
}

describe('MasterStrip', () => {
  beforeEach(() => {
    vi.resetModules()
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    window.xleth = { audio: { setMasterVolume: vi.fn() } }
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)
  })

  afterEach(() => {
    document.body.innerHTML = ''
    delete window.xleth
    delete globalThis.IS_REACT_ACT_ENVIRONMENT
    vi.restoreAllMocks()
  })

  it('renders the master with an empty insert list and selects master on click', async () => {
    const { MasterStrip, useMixerStore } = await loadMasterStripFixture()
    useMixerStore.setState({ master: { volume: 1 }, selectedChainKey: null })

    const { container, root } = await renderMasterStrip(MasterStrip)
    const strip = container.querySelector('[data-testid="master-strip"]')

    expect(strip.textContent).toContain('Master')
    const inserts = strip.querySelector('[data-testid="mixer-inserts"]')
    expect(inserts.getAttribute('aria-label')).toBe('Master inserts: No FX')
    expect(inserts.querySelectorAll('[role="option"]')).toHaveLength(0)
    expect(inserts.querySelectorAll('[data-empty="true"]')).toHaveLength(5)

    await act(async () => {
      strip.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(useMixerStore.getState().selectedChainKey).toBe('master')
    expect(strip.getAttribute('data-selected')).toBe('true')
    await act(async () => {
      root.unmount()
    })
  })

  it('loads the master chain on mount so the insert list names the real chain', async () => {
    const getMasterEffectChain = vi.fn(async () => [
      { nodeId: 9, pluginId: 'apex', position: 0, bypassed: false },
    ])
    window.xleth.audio.getMasterEffectChain = getMasterEffectChain
    const { MasterStrip, useMixerStore } = await loadMasterStripFixture()
    useMixerStore.setState({ master: { volume: 1 }, selectedChainKey: null })

    const { container, root } = await renderMasterStrip(MasterStrip)

    expect(getMasterEffectChain).toHaveBeenCalled()
    const rows = Array.from(container.querySelectorAll('[data-testid="mixer-inserts"] [role="option"]')).map((r) => r.textContent)
    expect(rows).toEqual(['APEX'])
    expect(container.querySelector('[data-testid="mixer-inserts"]').getAttribute('aria-label')).toBe('Master inserts: FX 1')
    await act(async () => {
      root.unmount()
    })
  })

  it('does not render track M/S/V controls, pan or width on the master strip', async () => {
    const { MasterStrip, useMixerStore } = await loadMasterStripFixture()
    useMixerStore.setState({ master: { volume: 1 }, selectedChainKey: null })

    const { container, root } = await renderMasterStrip(MasterStrip)
    const names = Array.from(container.querySelectorAll('[aria-pressed], [role="slider"]'))
      .map(el => el.getAttribute('aria-label'))

    expect(container.querySelectorAll('[aria-pressed]')).toHaveLength(0)
    expect(names).not.toContain('Pan')
    expect(names).not.toContain('Width')
    expect(names).toContain('Master volume')
    await act(async () => {
      root.unmount()
    })
  })

  it('shows the master level in dB with a unit', async () => {
    const { MasterStrip, useMixerStore } = await loadMasterStripFixture()
    useMixerStore.setState({ master: { volume: 0.5 }, selectedChainKey: null })

    const { container, root } = await renderMasterStrip(MasterStrip)
    const fader = Array.from(container.querySelectorAll('[role="slider"]'))
      .find(el => el.getAttribute('aria-label') === 'Master volume')

    expect(fader.getAttribute('aria-valuetext')).toContain('−6.0 dB')
    await act(async () => {
      root.unmount()
    })
  })
})
