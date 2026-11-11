/**
 * @vitest-environment jsdom
 */
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

async function loadMixerStripFixture() {
  const stripModule = await import('../MixerStrip.jsx')
  const { default: useMixerStore } = await import('../../../stores/mixerStore.js')
  const { default: useTimelineFocusStore } = await import('../../../stores/timelineFocusStore.js')
  const { usePanelRegistry } = await import('../../../windowing/registry/PanelRegistry')
  return { MixerStrip: stripModule.default, useMixerStore, useTimelineFocusStore, usePanelRegistry }
}

function seedMixer(store, outputRoutes = {}, overrides = {}) {
  store.setState({
    tracks: {
      1: { id: 1, name: 'Track A', volume: 1, pan: 0, spread: 1, muted: false, solo: false, visualOnly: false, ...overrides },
      2: { id: 2, name: 'Bus Name', volume: 1, pan: 0, spread: 1, muted: false, solo: false, visualOnly: false },
      3: { id: 3, name: 'Visual', volume: 1, pan: 0, spread: 1, muted: false, solo: false, visualOnly: true },
    },
    trackOrder: [1, 2, 3],
    outputRoutes: { 1: -1, 2: -1, 3: -1, ...outputRoutes },
    routingError: null,
    selectedChainKey: null,
  })
}

async function renderStrip(Component, trackId, props = {}) {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  await act(async () => {
    root.render(<Component trackId={trackId} index={trackId} color="#58B2CE" {...props} />)
  })
  return { container, root }
}

async function unmountRoot(root) {
  await act(async () => {
    root.unmount()
  })
}

const click = (el) => act(async () => { el.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
const outputTrigger = (container) => container.querySelector('button[aria-haspopup="listbox"]')
const optionLabels = () => Array.from(document.querySelectorAll('[role="option"]')).map(o => o.textContent)

describe('MixerStrip', () => {
  beforeEach(() => {
    vi.resetModules()
    window.xleth = {
      timeline: {
        setTrackOutputRoute: vi.fn(async (_trackId, targetTrackId) => ({ ok: true, targetTrackId })),
        setTrackMuted: vi.fn(),
        setTrackSolo: vi.fn(),
        setTrackVisualOnly: vi.fn(),
        getRouting: vi.fn(async () => []),
      },
      audio: { setTrackVolume: vi.fn(), setTrackPan: vi.fn(), setTrackSpread: vi.fn() },
    }
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)
    window.HTMLIFrameElement = window.HTMLIFrameElement || class HTMLIFrameElement extends window.HTMLElement {}
  })

  afterEach(() => {
    document.body.innerHTML = ''
    delete window.xleth
    delete globalThis.IS_REACT_ACT_ENVIRONMENT
    vi.restoreAllMocks()
  })

  it('shows number, name, an insert list and an Output selector reading Master', async () => {
    const { MixerStrip, useMixerStore } = await loadMixerStripFixture()
    seedMixer(useMixerStore)

    const { container, root } = await renderStrip(MixerStrip, 1)

    expect(container.querySelector('[data-testid="mixer-strip-1"]').getAttribute('aria-label')).toBe('Track 1 Track A')
    expect(container.textContent).toContain('Track A')
    expect(container.querySelector('[data-testid="mixer-inserts"]').getAttribute('aria-label')).toBe('Track A inserts: No FX')
    expect(outputTrigger(container).getAttribute('aria-label')).toBe('Output of Track A')
    expect(outputTrigger(container).textContent).toBe('Master')
    await unmountRoot(root)
  })

  it('loads its own chain on mount, so an untouched, unselected track names its real inserts', async () => {
    const getEffectChain = vi.fn(async () => [
      { nodeId: 5, pluginId: 'distortion', position: 0, bypassed: false },
      { nodeId: 6, pluginId: 'xletheq', position: 1, bypassed: false },
    ])
    window.xleth.audio.getEffectChain = getEffectChain
    const { MixerStrip, useMixerStore } = await loadMixerStripFixture()
    seedMixer(useMixerStore)

    const { container, root } = await renderStrip(MixerStrip, 1)

    expect(getEffectChain).toHaveBeenCalledWith(1)
    const rows = Array.from(container.querySelectorAll('[data-testid="mixer-inserts"] [role="option"]')).map((r) => r.textContent)
    expect(rows).toEqual(['Distortion', 'Parametric EQ'])
    expect(container.querySelector('[data-testid="mixer-inserts"]').getAttribute('aria-label')).toBe('Track A inserts: FX 2')
    expect(useMixerStore.getState().selectedChainKey).toBeNull()
    await unmountRoot(root)
  })

  it('carries the track identity colour on the strip', async () => {
    const { MixerStrip, useMixerStore } = await loadMixerStripFixture()
    seedMixer(useMixerStore)

    const { container, root } = await renderStrip(MixerStrip, 1, { color: '#DB6E3B' })

    expect(container.querySelector('[data-testid="mixer-strip-1"]').style.getPropertyValue('--strip-id')).toBe('#DB6E3B')
    await unmountRoot(root)
  })

  it('clicking a strip selects it as the focused mixer chain', async () => {
    const { MixerStrip, useMixerStore, useTimelineFocusStore } = await loadMixerStripFixture()
    seedMixer(useMixerStore)
    useTimelineFocusStore.setState({ focusedTrackId: null })

    const { container, root } = await renderStrip(MixerStrip, 2)
    await click(container.querySelector('[data-testid="mixer-strip-2"]'))

    expect(useMixerStore.getState().selectedChainKey).toBe('2')
    expect(useTimelineFocusStore.getState().focusedTrackId).toBe(2)
    await unmountRoot(root)
  })

  it('marks the selected strip with a data flag and aria state', async () => {
    const { MixerStrip, useMixerStore } = await loadMixerStripFixture()
    seedMixer(useMixerStore)
    useMixerStore.setState({ selectedChainKey: '1' })

    const { container, root } = await renderStrip(MixerStrip, 1)
    const strip = container.querySelector('[data-testid="mixer-strip-1"]')

    expect(strip.getAttribute('data-selected')).toBe('true')
    expect(strip.getAttribute('aria-selected')).toBe('true')
    await unmountRoot(root)
  })

  it('picking a bus calls the route action with the source and target ids', async () => {
    const { MixerStrip, useMixerStore } = await loadMixerStripFixture()
    seedMixer(useMixerStore)

    const { container, root } = await renderStrip(MixerStrip, 1)
    await click(outputTrigger(container))
    const bus = Array.from(document.querySelectorAll('[role="option"]')).find(o => o.textContent === 'Bus Name')
    await click(bus)

    expect(window.xleth.timeline.setTrackOutputRoute).toHaveBeenCalledWith(1, 2)
    await unmountRoot(root)
  })

  it('omits invalid self, visual-only, and cycle targets', async () => {
    const { MixerStrip, useMixerStore } = await loadMixerStripFixture()
    seedMixer(useMixerStore, { 2: 1 })

    const { container, root } = await renderStrip(MixerStrip, 1)
    await click(outputTrigger(container))

    expect(optionLabels()).toContain('Master')
    expect(optionLabels()).not.toContain('Track A')
    expect(optionLabels()).not.toContain('Bus Name')
    expect(optionLabels()).not.toContain('Visual')
    await unmountRoot(root)
  })

  it('shows the bus a track is routed to', async () => {
    const { MixerStrip, useMixerStore } = await loadMixerStripFixture()
    seedMixer(useMixerStore, { 1: 2 })

    const { container, root } = await renderStrip(MixerStrip, 1)

    expect(outputTrigger(container).textContent).toBe('Bus Name')
    await unmountRoot(root)
  })

  it('shows mute, solo and visual-only at rest and dims a muted strip with a glyph', async () => {
    const { MixerStrip, useMixerStore } = await loadMixerStripFixture()
    seedMixer(useMixerStore, {}, { muted: true, solo: true })

    const { container, root } = await renderStrip(MixerStrip, 1)
    const strip = container.querySelector('[data-testid="mixer-strip-1"]')
    const pressed = (name) => container.querySelector(`button[aria-label="${name} Track A"]`).getAttribute('aria-pressed')

    expect(pressed('Mute')).toBe('true')
    expect(pressed('Solo')).toBe('true')
    expect(pressed('Visual only')).toBe('false')
    expect(strip.getAttribute('data-muted')).toBe('true')
    expect(strip.getAttribute('aria-label')).toContain('muted')
    expect(strip.querySelector('svg.lucide-volume-x, svg[class*="volume-x"]')).not.toBeNull()
    await unmountRoot(root)
  })

  it('wires M, S and V to the existing store actions', async () => {
    const { MixerStrip, useMixerStore } = await loadMixerStripFixture()
    seedMixer(useMixerStore)

    const { container, root } = await renderStrip(MixerStrip, 1)
    await click(container.querySelector('button[aria-label="Mute Track A"]'))
    await click(container.querySelector('button[aria-label="Solo Track A"]'))
    await click(container.querySelector('button[aria-label="Visual only Track A"]'))

    expect(window.xleth.timeline.setTrackMuted).toHaveBeenCalledWith(1, true)
    expect(window.xleth.timeline.setTrackSolo).toHaveBeenCalledWith(1, true)
    expect(window.xleth.timeline.setTrackVisualOnly).toHaveBeenCalledWith(1, true)
    await unmountRoot(root)
  })

  it('has a bipolar pan knob, a width knob, a volume field and a volume fader, all with unit text', async () => {
    const { MixerStrip, useMixerStore } = await loadMixerStripFixture()
    seedMixer(useMixerStore)

    const { container, root } = await renderStrip(MixerStrip, 1)
    const sliders = Array.from(container.querySelectorAll('[role="slider"]'))
    const text = (label) => sliders.find(s => s.getAttribute('aria-label') === label)?.getAttribute('aria-valuetext')

    expect(text('Pan')).toBe('Pan, C')
    expect(text('Width')).toBe('Width, 100 %')
    expect(text('Track A volume')).toContain('0.0 dB')
    await unmountRoot(root)
  })

  it('opens the Devices tab on this strip from an empty insert list', async () => {
    const { MixerStrip, useMixerStore, usePanelRegistry } = await loadMixerStripFixture()
    seedMixer(useMixerStore)
    usePanelRegistry.getState().closePanel('devices')

    const { container, root } = await renderStrip(MixerStrip, 2)
    await click(container.querySelector('[data-testid="mixer-inserts"] [data-insert-row="0"]'))

    expect(useMixerStore.getState().selectedChainKey).toBe('2')
    expect(usePanelRegistry.getState().panels.devices.hidden).toBe(false)
    await unmountRoot(root)
  })

  it('an insert row opens Devices on that device; a long chain ends in "+N more"; a bypassed insert is marked', async () => {
    const chain = ['xletheq', 'compressor', 'uniflange', 'delay', 'reverb', 'limiter', 'apex']
      .map((pluginId, i) => ({ nodeId: 10 + i, pluginId, position: i, bypassed: i === 1 }))
    window.xleth.audio.getEffectChain = vi.fn(async () => chain)
    const { MixerStrip, useMixerStore, usePanelRegistry } = await loadMixerStripFixture()
    const { default: useDeviceRevealStore } = await import('../../devices/deviceRevealStore.js')
    seedMixer(useMixerStore)
    usePanelRegistry.getState().closePanel('devices')

    const { container, root } = await renderStrip(MixerStrip, 1)
    const rows = Array.from(container.querySelectorAll('[data-testid="mixer-inserts"] [role="option"]'))
    expect(rows.map((r) => r.textContent)).toEqual(['Parametric EQ', 'Compressor', 'UniFlange', 'Delay', '+3 more'])
    expect(rows[1].getAttribute('data-off')).toBe('true')
    expect(rows[1].getAttribute('title')).toBe('Compressor (bypassed)')

    await click(rows[2])
    expect(useMixerStore.getState().selectedChainKey).toBe('1')
    expect(usePanelRegistry.getState().panels.devices.hidden).toBe(false)
    expect(useDeviceRevealStore.getState().request).toMatchObject({ chainKey: '1', index: 2 })

    // "+3 more" opens the first device that is not listed.
    await click(rows[4])
    expect(useDeviceRevealStore.getState().request).toMatchObject({ chainKey: '1', index: 4 })
    await unmountRoot(root)
  })

  it('a short dock shows three insert rows', async () => {
    const chain = ['xletheq', 'compressor', 'delay', 'reverb'].map((pluginId, i) => ({ nodeId: 20 + i, pluginId }))
    window.xleth.audio.getEffectChain = vi.fn(async () => chain)
    const { MixerStrip, useMixerStore } = await loadMixerStripFixture()
    seedMixer(useMixerStore)

    const { container, root } = await renderStrip(MixerStrip, 1, { insertRowCount: 3 })
    const rows = Array.from(container.querySelectorAll('[data-testid="mixer-inserts"] [role="option"]')).map((r) => r.textContent)
    expect(rows).toEqual(['Parametric EQ', 'Compressor', '+2 more'])
    await unmountRoot(root)
  })

  it('the insert list is one keyboard control: arrows move, Enter opens the active row', async () => {
    const chain = ['xletheq', 'compressor'].map((pluginId, i) => ({ nodeId: 30 + i, pluginId }))
    window.xleth.audio.getEffectChain = vi.fn(async () => chain)
    const { MixerStrip, useMixerStore } = await loadMixerStripFixture()
    const { default: useDeviceRevealStore } = await import('../../devices/deviceRevealStore.js')
    seedMixer(useMixerStore)

    const { container, root } = await renderStrip(MixerStrip, 1)
    const list = container.querySelector('[data-testid="mixer-inserts"]')
    expect(list.getAttribute('role')).toBe('listbox')
    expect(list.getAttribute('tabindex')).toBe('0')
    const key = (k) => act(async () => { list.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true })) })
    await key('ArrowDown')
    expect(list.querySelector('[aria-selected="true"]').textContent).toBe('Compressor')
    await key('Enter')
    expect(useDeviceRevealStore.getState().request).toMatchObject({ chainKey: '1', index: 1 })
    await unmountRoot(root)
  })

  it('prints no "Pan" or "Width" word on the strip; the knobs keep their names and values; positive gain is signed', async () => {
    const { MixerStrip, useMixerStore } = await loadMixerStripFixture()
    seedMixer(useMixerStore, {}, { volume: 10 ** (3 / 20) })

    const { container, root } = await renderStrip(MixerStrip, 1)
    const text = container.textContent
    expect(text).not.toContain('Pan')
    expect(text).not.toContain('Width')
    const sliders = Array.from(container.querySelectorAll('[role="slider"]'))
    expect(sliders.map((s) => s.getAttribute('aria-label'))).toEqual(expect.arrayContaining(['Pan', 'Width']))
    // The value under each knob stays: no knob without a readout.
    expect(text).toContain('C')
    expect(text).toMatch(/100\s%/)
    // Positive gain says so; the volume field draws no fill of its own (the fader is the slider).
    const field = sliders.find((s) => s.getAttribute('aria-label') === 'Track A volume' && s.getAttribute('aria-orientation') === 'horizontal')
    expect(field.getAttribute('aria-valuetext')).toBe('Track A volume, +3.0\u2009dB')
    expect(field.querySelector('[class*="fill"]')).toBeNull()
    // The clip latch is not drawn until the meter clips.
    expect(container.querySelector('[data-clip-space]')).not.toBeNull()
    expect(container.querySelector('button[aria-label*="clipping"]')).toBeNull()
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
