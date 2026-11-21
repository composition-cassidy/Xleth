/**
 * @vitest-environment jsdom
 */
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// The real strips (not mocks): the gutter FX button must flip every strip from the
// "N FX" cell to named rows, and flip them back.
describe('MixerPanel insert toggle, real strips', () => {
  beforeEach(() => {
    vi.resetModules()
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    localStorage.clear()
    const chain = [{ nodeId: 1, pluginId: 'resonancesuppressor' }, { nodeId: 2, pluginId: 'xletheq' }]
    window.xleth = {
      audio: { getAllPeaks: vi.fn(async () => null), getEffectChain: vi.fn(async () => chain) },
      timeline: {
        getTracks: vi.fn(async () => [1, 2].map((id) => ({
          id, name: id === 1 ? 'A' : 'B', volume: 1, pan: 0, muted: false, solo: false, visualOnly: false, outputRoute: { targetTrackId: -1 },
        }))),
        getTrackLayout: vi.fn(async () => null),
        getRouting: vi.fn(async () => []),
      },
    }
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)
  })

  afterEach(() => {
    document.body.innerHTML = ''
    delete window.xleth
    vi.restoreAllMocks()
  })

  it('opens and closes the named rows on every strip', async () => {
    const { default: MixerPanel } = await import('../MixerPanel.jsx')
    const { default: useMixerStore } = await import('../../../stores/mixerStore.js')
    useMixerStore.setState({
      visible: true,
      tracks: {
        1: { id: 1, name: 'A', volume: 1, pan: 0, spread: 1, muted: false, solo: false, visualOnly: false },
        2: { id: 2, name: 'B', volume: 1, pan: 0, spread: 1, muted: false, solo: false, visualOnly: false },
      },
      trackOrder: [1, 2],
      outputRoutes: { 1: -1, 2: -1 },
      selectedChainKey: '1',
    })
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    await act(async () => { root.render(<MixerPanel />) })
    await act(async () => { await Promise.resolve(); await Promise.resolve() })

    const rowsIn = (id) => Array.from(container.querySelectorAll(`[data-testid="mixer-strip-${id}"] [role="option"]`))
      .map((r) => r.textContent)
    const toggle = container.querySelector('[data-testid="mixer-inserts-toggle"]')
    expect(rowsIn(1)).toEqual([])
    expect(container.querySelector('[data-testid="mixer-strip-1"] [data-testid="mixer-inserts"]').textContent).toBe('2 FX')

    await act(async () => { toggle.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    expect(rowsIn(1)).toEqual(['Res. Suppr.', 'Param. EQ'])
    expect(rowsIn(2)).toEqual(['Res. Suppr.', 'Param. EQ'])

    await act(async () => { toggle.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    expect(rowsIn(1)).toEqual([])
    await act(async () => root.unmount())
  })
})
