import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

async function loadSelectedRackFixture() {
  const rackModule = await import('../SelectedEffectRack.jsx')
  const { default: useMixerStore } = await import('../../../stores/mixerStore.js')
  const { default: useEffectChainStore } = await import('../../../stores/effectChainStore.js')
  const { default: useVstStore } = await import('../../../stores/vstStore.js')
  return {
    SelectedEffectRack: rackModule.default,
    useMixerStore,
    useEffectChainStore,
    useVstStore,
  }
}

describe('SelectedEffectRack', () => {
  beforeEach(() => {
    vi.resetModules()
    globalThis.window = {
      xleth: {
        audio: {
          getEffectChain: vi.fn(async () => '[]'),
          getMasterEffectChain: vi.fn(async () => '[]'),
        },
        onGraphChanged: vi.fn(() => () => {}),
        onProjectLoaded: vi.fn(() => () => {}),
      },
    }
  })

  afterEach(() => {
    delete globalThis.window
  })

  it('renders an empty selection state when no chain key is selected', async () => {
    const { SelectedEffectRack, useMixerStore } = await loadSelectedRackFixture()
    useMixerStore.setState({
      tracks: {},
      trackOrder: [],
      selectedChainKey: null,
    })

    const html = renderToStaticMarkup(<SelectedEffectRack />)

    expect(html).toContain('No track selected')
    expect(html).toContain('Select a mixer track')
    expect(html).not.toContain('effect-chain-panel--editable')
  })

  it('renders the selected track chain in editable mode', async () => {
    const { SelectedEffectRack, useMixerStore, useEffectChainStore, useVstStore } = await loadSelectedRackFixture()
    useMixerStore.setState({
      tracks: { 7: { id: 7, name: 'Bass' } },
      trackOrder: [7],
      selectedChainKey: '7',
    })
    useEffectChainStore.setState({
      chains: { '7': [{ nodeId: 3, pluginId: 'compressor', position: 0, bypassed: false }] },
      fxModes: { '7': 'chain' },
    })
    useVstStore.setState({ plugins: [] })

    const html = renderToStaticMarkup(<SelectedEffectRack />)

    expect(html).toContain('Bass')
    expect(html).toContain('effect-chain-panel--editable')
    expect(html).toContain('Compressor')
    expect(html).toContain('effect-module-grip')
    expect(html).toContain('effect-chain-add-btn')
  })

  it('renders the master chain in editable mode', async () => {
    const { SelectedEffectRack, useMixerStore, useEffectChainStore, useVstStore } = await loadSelectedRackFixture()
    useMixerStore.setState({
      tracks: { 7: { id: 7, name: 'Bass' } },
      trackOrder: [7],
      selectedChainKey: 'master',
    })
    useEffectChainStore.setState({
      chains: { master: [{ nodeId: 8, pluginId: 'limiter', position: 0, bypassed: false }] },
    })
    useVstStore.setState({ plugins: [] })

    const html = renderToStaticMarkup(<SelectedEffectRack />)

    expect(html).toContain('MASTER')
    expect(html).toContain('Master effect chain')
    expect(html).toContain('Limiter')
    expect(html).toContain('effect-chain-panel--editable')
  })
})
