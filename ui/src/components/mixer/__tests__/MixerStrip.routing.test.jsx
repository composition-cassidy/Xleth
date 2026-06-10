/**
 * @vitest-environment jsdom
 */
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

async function loadMixerStripFixture() {
  vi.doMock('../EffectChainPanel.jsx', () => ({
    default: () => <div data-testid="effect-chain-panel" />,
  }))
  vi.doMock('../PeakMeter.jsx', () => ({
    default: () => <div data-testid="peak-meter" />,
  }))
  vi.doMock('../VolumeFader.jsx', () => ({
    default: ({ value, onChange }) => (
      <input data-testid="volume-fader" value={value} onChange={(e) => onChange(Number(e.target.value))} />
    ),
  }))
  vi.doMock('../../sampler/Knob.jsx', () => ({
    default: ({ label }) => <div data-testid={`knob-${label}`} />,
  }))

  const stripModule = await import('../MixerStrip.jsx')
  const { default: useMixerStore } = await import('../../../stores/mixerStore.js')
  return { MixerStrip: stripModule.default, useMixerStore }
}

function seedMixer(store, outputRoutes = {}) {
  store.setState({
    tracks: {
      1: { id: 1, name: 'Track A', volume: 1, pan: 0, spread: 1, muted: false, solo: false, visualOnly: false },
      2: { id: 2, name: 'Bus Name', volume: 1, pan: 0, spread: 1, muted: false, solo: false, visualOnly: false },
      3: { id: 3, name: 'Visual', volume: 1, pan: 0, spread: 1, muted: false, solo: false, visualOnly: true },
    },
    trackOrder: [1, 2, 3],
    outputRoutes: { 1: -1, 2: -1, 3: -1, ...outputRoutes },
    routingError: null,
  })
}

async function renderStrip(Component, trackId) {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  await act(async () => {
    root.render(<Component trackId={trackId} />)
  })
  return { container, root }
}

async function unmountRoot(root) {
  await act(async () => {
    root.unmount()
  })
}

describe('MixerStrip output routing UI', () => {
  beforeEach(() => {
    vi.resetModules()
    window.xleth = {
      timeline: {
        setTrackOutputRoute: vi.fn(async (_trackId, targetTrackId) => ({ ok: true, targetTrackId })),
        getRouting: vi.fn(async () => []),
      },
    }
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    window.HTMLIFrameElement = window.HTMLIFrameElement || class HTMLIFrameElement extends window.HTMLElement {}
  })

  afterEach(() => {
    document.body.innerHTML = ''
    delete window.xleth
    delete globalThis.IS_REACT_ACT_ENVIRONMENT
    vi.doUnmock('../EffectChainPanel.jsx')
    vi.doUnmock('../PeakMeter.jsx')
    vi.doUnmock('../VolumeFader.jsx')
    vi.doUnmock('../../sampler/Knob.jsx')
  })

  it('renders an Output selector showing Master by default', async () => {
    const { MixerStrip, useMixerStore } = await loadMixerStripFixture()
    seedMixer(useMixerStore)

    const { container, root } = await renderStrip(MixerStrip, 1)
    const select = container.querySelector('.mixer-output-select')

    expect(container.textContent).toContain('Output')
    expect(select.value).toBe('-1')
    expect(Array.from(select.options).map(option => option.textContent)).toContain('Master')
    await unmountRoot(root)
  })

  it('selecting a bus calls the route action with the source and target ids', async () => {
    const { MixerStrip, useMixerStore } = await loadMixerStripFixture()
    seedMixer(useMixerStore)

    const { container, root } = await renderStrip(MixerStrip, 1)
    const select = container.querySelector('.mixer-output-select')

    await act(async () => {
      select.value = '2'
      select.dispatchEvent(new Event('change', { bubbles: true }))
      await Promise.resolve()
    })

    expect(window.xleth.timeline.setTrackOutputRoute).toHaveBeenCalledWith(1, 2)
    await unmountRoot(root)
  })

  it('renders the source route chip when routed to a bus', async () => {
    const { MixerStrip, useMixerStore } = await loadMixerStripFixture()
    seedMixer(useMixerStore, { 1: 2 })

    const { container, root } = await renderStrip(MixerStrip, 1)

    expect(container.textContent).toContain('→ Bus Name')
    await unmountRoot(root)
  })

  it('renders the bus input-count badge', async () => {
    const { MixerStrip, useMixerStore } = await loadMixerStripFixture()
    seedMixer(useMixerStore, { 1: 2 })

    const { container, root } = await renderStrip(MixerStrip, 2)

    expect(container.textContent).toContain('1 input')
    await unmountRoot(root)
  })

  it('omits invalid self, visual-only, and cycle targets', async () => {
    const { MixerStrip, useMixerStore } = await loadMixerStripFixture()
    seedMixer(useMixerStore, { 2: 1 })

    const { container, root } = await renderStrip(MixerStrip, 1)
    const optionTexts = Array.from(container.querySelector('.mixer-output-select').options)
      .map(option => option.textContent)

    expect(optionTexts).toContain('Master')
    expect(optionTexts).not.toContain('Track A')
    expect(optionTexts).not.toContain('Bus Name')
    expect(optionTexts).not.toContain('Visual')
    await unmountRoot(root)
  })

  it('does not render send or sidechain controls', async () => {
    const { MixerStrip, useMixerStore } = await loadMixerStripFixture()
    seedMixer(useMixerStore)

    const { container, root } = await renderStrip(MixerStrip, 1)
    const text = container.textContent.toLowerCase()

    expect(text).not.toContain('send')
    expect(text).not.toContain('sidechain')
    await unmountRoot(root)
  })
})
