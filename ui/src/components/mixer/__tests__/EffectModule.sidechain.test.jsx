/**
 * @vitest-environment jsdom
 */
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

async function loadEffectModuleFixture() {
  const effectModule = await import('../EffectModule.jsx')
  const { default: useMixerStore } = await import('../../../stores/mixerStore.js')
  const { default: useVstStore } = await import('../../../stores/vstStore.js')
  return {
    EffectModule: effectModule.default,
    effectModule,
    useMixerStore,
    useVstStore,
  }
}

function makeCompressor(overrides = {}) {
  return {
    nodeId: 44,
    pluginId: 'compressor',
    effectInstanceId: 'cmp-1',
    position: 0,
    bypassed: false,
    missing: false,
    crashed: false,
    ...overrides,
  }
}

function seedMixerStore(useMixerStore, sidechainRoutes = []) {
  useMixerStore.setState({
    tracks: {
      1: { id: 1, name: 'Kick', volume: 1, pan: 0, spread: 1, muted: false, solo: false, visualOnly: false },
      2: { id: 2, name: 'Bass', volume: 1, pan: 0, spread: 1, muted: false, solo: false, visualOnly: false },
      3: { id: 3, name: 'Visual', volume: 1, pan: 0, spread: 1, muted: false, solo: false, visualOnly: true },
    },
    trackOrder: [1, 2, 3],
    outputRoutes: { 1: -1, 2: -1, 3: -1 },
    sidechainRoutes,
    routingError: null,
    sidechainRoutingErrors: {},
  })
}

async function renderEffect(Component, effect = makeCompressor()) {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  await act(async () => {
    root.render(
      <Component
        effect={effect}
        index={0}
        storeKey="2"
        onDragStart={() => {}}
        onDragOver={() => {}}
        onSelect={() => {}}
      />,
    )
  })
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
  return { container, root }
}

async function unmountRoot(root) {
  await act(async () => {
    root.unmount()
  })
}

async function clickCheckbox(checkbox) {
  await act(async () => {
    checkbox.click()
    await Promise.resolve()
    await Promise.resolve()
  })
}

describe('EffectModule compressor sidechain controls', () => {
  beforeEach(() => {
    vi.resetModules()
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    window.HTMLIFrameElement = window.HTMLIFrameElement || class HTMLIFrameElement extends window.HTMLElement {}
    window.xleth = {
      audio: {
        getEffectChain: vi.fn(async () => '[]'),
        getMasterEffectChain: vi.fn(async () => '[]'),
        getEffectParameters: vi.fn(async () => JSON.stringify([
          { id: 'threshold', value: -20 },
          { id: 'sc_external', value: 0 },
        ])),
        setEffectParameter: vi.fn(async () => true),
      },
      timeline: {
        getRouting: vi.fn(async () => [
          { trackId: 1, outputRoute: { targetTrackId: -1 }, sidechainRoutes: [] },
          { trackId: 2, outputRoute: { targetTrackId: -1 }, sidechainRoutes: [] },
          { trackId: 3, outputRoute: { targetTrackId: -1 }, sidechainRoutes: [] },
        ]),
        addSidechainRoute: vi.fn(async () => ({ ok: true, routeId: 'route-new' })),
        removeSidechainRoute: vi.fn(async () => ({ ok: true })),
      },
      onGraphChanged: vi.fn(() => () => {}),
      onProjectLoaded: vi.fn(() => () => {}),
    }
  })

  afterEach(() => {
    document.body.innerHTML = ''
    delete window.xleth
    delete globalThis.IS_REACT_ACT_ENVIRONMENT
  })

  it('stock compressor renders the External Sidechain toggle', async () => {
    const { EffectModule, useMixerStore } = await loadEffectModuleFixture()
    seedMixerStore(useMixerStore)

    const { container, root } = await renderEffect(EffectModule)

    expect(container.textContent).toContain('External Sidechain')
    expect(container.querySelector('input[aria-label="External Sidechain"]')).not.toBeNull()
    await unmountRoot(root)
  })

  it('non-compressor stock effects and VST rows do not render active sidechain controls', async () => {
    const { EffectModule, useMixerStore, useVstStore } = await loadEffectModuleFixture()
    seedMixerStore(useMixerStore)
    useVstStore.setState({ plugins: [{ id: 'third.party', name: 'Third Party', vendor: 'Vendor' }] })

    const stock = await renderEffect(EffectModule, makeCompressor({ pluginId: 'limiter' }))
    const vst = await renderEffect(EffectModule, makeCompressor({ pluginId: 'third.party' }))

    expect(stock.container.textContent).not.toContain('External Sidechain')
    expect(vst.container.textContent).not.toContain('External Sidechain')
    await unmountRoot(stock.root)
    await unmountRoot(vst.root)
  })

  it('source selector is disabled when external sidechain is off and enabled after toggle on', async () => {
    const { EffectModule, useMixerStore } = await loadEffectModuleFixture()
    seedMixerStore(useMixerStore)

    const { container, root } = await renderEffect(EffectModule)
    const checkbox = container.querySelector('input[aria-label="External Sidechain"]')
    const select = container.querySelector('select[aria-label="Sidechain source"]')

    expect(select.disabled).toBe(true)

    await clickCheckbox(checkbox)

    expect(window.xleth.audio.setEffectParameter).toHaveBeenCalledWith(2, 44, 'sc_external', 1)
    expect(select.disabled).toBe(false)
    await unmountRoot(root)
  })

  it('selecting a source calls the route API with the compressor effectInstanceId', async () => {
    const { EffectModule, useMixerStore } = await loadEffectModuleFixture()
    let routing = [
      { trackId: 1, outputRoute: { targetTrackId: -1 }, sidechainRoutes: [] },
      { trackId: 2, outputRoute: { targetTrackId: -1 }, sidechainRoutes: [] },
      { trackId: 3, outputRoute: { targetTrackId: -1 }, sidechainRoutes: [] },
    ]
    window.xleth.timeline.getRouting.mockImplementation(async () => routing)
    window.xleth.timeline.addSidechainRoute.mockImplementation(async (sourceTrackId, payload) => {
      routing = routing.map((entry) => entry.trackId === sourceTrackId
        ? {
            ...entry,
            sidechainRoutes: [{ routeId: 'route-1', sourceTrackId, ...payload, status: 'ok' }],
          }
        : entry)
      return { ok: true, routeId: 'route-1' }
    })
    seedMixerStore(useMixerStore)

    const { container, root } = await renderEffect(EffectModule)
    const checkbox = container.querySelector('input[aria-label="External Sidechain"]')
    const select = container.querySelector('select[aria-label="Sidechain source"]')

    await clickCheckbox(checkbox)
    await act(async () => {
      select.value = '1'
      select.dispatchEvent(new Event('change', { bubbles: true }))
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(window.xleth.timeline.addSidechainRoute).toHaveBeenCalledWith(1, {
      targetTrackId: 2,
      targetEffectInstanceId: 'cmp-1',
      gain: 1.0,
      preFader: false,
      enabled: true,
    })
    expect(container.textContent).toContain('Keyed by: Kick')
    await unmountRoot(root)
  })

  it('shows selected source labels and stale route status from routing state', async () => {
    const { EffectModule, useMixerStore } = await loadEffectModuleFixture()
    const route = {
      routeId: 'route-1',
      sourceTrackId: 1,
      targetTrackId: 2,
      targetEffectInstanceId: 'cmp-1',
      gain: 1,
      preFader: false,
      enabled: true,
      status: 'ok',
    }
    window.xleth.audio.getEffectParameters.mockResolvedValue(JSON.stringify([{ id: 'sc_external', value: 1 }]))
    window.xleth.timeline.getRouting.mockImplementation(async () => [
      { trackId: 1, outputRoute: { targetTrackId: -1 }, sidechainRoutes: [route] },
      { trackId: 2, outputRoute: { targetTrackId: -1 }, sidechainRoutes: [] },
      { trackId: 3, outputRoute: { targetTrackId: -1 }, sidechainRoutes: [] },
    ])
    seedMixerStore(useMixerStore, [route])

    const okRender = await renderEffect(EffectModule)
    expect(okRender.container.textContent).toContain('Keyed by: Kick')
    expect(okRender.container.querySelector('select[aria-label="Sidechain source"]').value).toBe('1')
    await unmountRoot(okRender.root)

    const staleRoute = { ...route, status: 'stale_effect_instance' }
    window.xleth.timeline.getRouting.mockImplementation(async () => [
      { trackId: 1, outputRoute: { targetTrackId: -1 }, sidechainRoutes: [staleRoute] },
      { trackId: 2, outputRoute: { targetTrackId: -1 }, sidechainRoutes: [] },
      { trackId: 3, outputRoute: { targetTrackId: -1 }, sidechainRoutes: [] },
    ])
    seedMixerStore(useMixerStore, [staleRoute])
    const staleRender = await renderEffect(EffectModule)
    expect(staleRender.container.textContent).toContain('Route stale')
    await unmountRoot(staleRender.root)
  })

  it('shows readable backend rejection copy', async () => {
    const { EffectModule, useMixerStore } = await loadEffectModuleFixture()
    window.xleth.timeline.addSidechainRoute.mockResolvedValueOnce({ ok: false, reason: 'duplicate_route' })
    seedMixerStore(useMixerStore)

    const { container, root } = await renderEffect(EffectModule)
    const checkbox = container.querySelector('input[aria-label="External Sidechain"]')
    const select = container.querySelector('select[aria-label="Sidechain source"]')

    await clickCheckbox(checkbox)
    await act(async () => {
      select.value = '1'
      select.dispatchEvent(new Event('change', { bubbles: true }))
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(container.textContent).toContain('Sidechain route already exists')
    expect(container.textContent).not.toContain('duplicate_route')
    await unmountRoot(root)
  })

  it('does not introduce Send or FX Graph sidechain UI in the module row', async () => {
    const { EffectModule, useMixerStore } = await loadEffectModuleFixture()
    seedMixerStore(useMixerStore)

    const { container, root } = await renderEffect(EffectModule)
    const text = container.textContent.toLowerCase()

    expect(text).not.toContain('send')
    expect(text).not.toContain('fx graph')
    await unmountRoot(root)
  })
})
