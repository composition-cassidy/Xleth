/**
 * @vitest-environment jsdom
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
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
    sends: {},
    sidechainRoutes: [],
    routingError: null,
    selectedChainKey: null,
  })
}

async function renderStrip(Component, trackId, props = {}) {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  await act(async () => {
    root.render(<Component trackId={trackId} index={trackId} color="#58B2CE" insertsOpen {...props} />)
  })
  return { container, root }
}

async function unmountRoot(root) {
  await act(async () => {
    root.unmount()
  })
}

const click = (el) => act(async () => { el.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
const arrowOf = (container, trackId) => container.querySelector(`[data-testid="route-${trackId}"] button`)
const rightClick = (el) => act(async () => { el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })) })
const ctrlClick = (el) => act(async () => { el.dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: true })) })

async function renderStrips(Component, ids) {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  await act(async () => {
    root.render(<>{ids.map(id => <Component key={id} trackId={id} index={id} color="#58B2CE" />)}</>)
  })
  return { container, root }
}

describe('MixerStrip', () => {
  beforeEach(() => {
    vi.resetModules()
    window.xleth = {
      timeline: {
        setTrackOutputRoute: vi.fn(async (_trackId, targetTrackId) => ({ ok: true, targetTrackId })),
        setTrackRoutes: vi.fn(async (_trackId, routes) => ({ ok: true, targetTrackId: routes.targetTrackId, sends: routes.sends })),
        setTrackSendGain: vi.fn(async () => ({ ok: true })),
        addSidechainRoute: vi.fn(async () => ({ ok: true, routeId: 'sc-1' })),
        removeSidechainRoute: vi.fn(async () => ({ ok: true })),
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

  it('shows number, name, an insert list and a route arrow (no Output dropdown)', async () => {
    const { MixerStrip, useMixerStore } = await loadMixerStripFixture()
    seedMixer(useMixerStore)

    const { container, root } = await renderStrip(MixerStrip, 1)

    expect(container.querySelector('[data-testid="mixer-strip-1"]').getAttribute('aria-label')).toBe('Track 1 Track A')
    expect(container.textContent).toContain('Track A')
    expect(container.querySelector('[data-testid="mixer-inserts"]').getAttribute('aria-label')).toBe('Track A inserts: No FX')
    expect(container.querySelector('button[aria-haspopup="listbox"][aria-label^="Output"]')).toBeNull()
    // Nothing selected: the arrow has no source to route.
    expect(arrowOf(container, 1).getAttribute('aria-disabled')).toBe('true')
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
    expect(rows).toEqual(['Distortion', 'Param. EQ'])
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

  it('clicking a strip\'s arrow routes the SELECTED track there too, keeping Master (FL multi-wiring)', async () => {
    const { MixerStrip, useMixerStore } = await loadMixerStripFixture()
    seedMixer(useMixerStore)
    useMixerStore.setState({ selectedChainKey: '1' })

    const { container, root } = await renderStrips(MixerStrip, [1, 2])
    expect(container.querySelector('[data-testid="route-1"]').getAttribute('data-self')).toBe('true')
    await click(arrowOf(container, 2))

    expect(window.xleth.timeline.setTrackRoutes).toHaveBeenCalledWith(1, { targetTrackId: -1, sends: [{ targetTrackId: 2, gain: 1 }] })
    expect(useMixerStore.getState().selectedChainKey).toBe('1') // the arrow never re-selects
    expect(arrowOf(container, 2).getAttribute('aria-pressed')).toBe('true')
    expect(arrowOf(container, 2).hasAttribute('data-audio')).toBe(true)
    // A send shows its level dial next to the lit arrow.
    expect(container.querySelector('[data-testid="route-2"] [role="slider"]').getAttribute('aria-label')).toBe('Send level Track A to Bus Name')

    await click(arrowOf(container, 2))
    expect(window.xleth.timeline.setTrackRoutes).toHaveBeenLastCalledWith(1, { targetTrackId: -1, sends: [] })
    expect(arrowOf(container, 2).getAttribute('aria-pressed')).toBe('false')
    await unmountRoot(root)
  })

  it('Ctrl+click routes to that track only', async () => {
    const { MixerStrip, useMixerStore } = await loadMixerStripFixture()
    seedMixer(useMixerStore)
    useMixerStore.setState({ selectedChainKey: '1' })

    const { container, root } = await renderStrips(MixerStrip, [1, 2])
    await ctrlClick(arrowOf(container, 2))

    expect(window.xleth.timeline.setTrackRoutes).toHaveBeenCalledWith(1, { targetTrackId: 2, sends: [] })
    expect(useMixerStore.getState().outputRoutes[1]).toBe(2)
    await unmountRoot(root)
  })

  it('right-click sidechains the selected track there (yellow), and again removes it', async () => {
    const { MixerStrip, useMixerStore } = await loadMixerStripFixture()
    seedMixer(useMixerStore)
    useMixerStore.setState({ selectedChainKey: '1' })
    const routing = (sc) => [
      { trackId: 1, outputRoute: { targetTrackId: -1 }, sends: [], sidechainRoutes: sc },
      { trackId: 2, outputRoute: { targetTrackId: -1 }, sends: [], sidechainRoutes: [] },
      { trackId: 3, outputRoute: { targetTrackId: -1 }, sends: [], sidechainRoutes: [] },
    ]
    window.xleth.timeline.getRouting = vi.fn(async () => routing([
      { routeId: 'sc-1', sourceTrackId: 1, targetTrackId: 2, targetEffectInstanceId: '', enabled: true, status: 'ok' },
    ]))

    const { container, root } = await renderStrips(MixerStrip, [1, 2])
    await rightClick(arrowOf(container, 2))

    expect(window.xleth.timeline.addSidechainRoute).toHaveBeenCalledWith(1, expect.objectContaining({ targetTrackId: 2, targetEffectInstanceId: '' }))
    expect(arrowOf(container, 2).hasAttribute('data-sidechain')).toBe(true)
    expect(arrowOf(container, 2).hasAttribute('data-audio')).toBe(false)
    expect(window.xleth.timeline.setTrackRoutes).not.toHaveBeenCalled()
    expect(useMixerStore.getState().selectedChainKey).toBe('1') // no FX-chain menu, no re-select

    window.xleth.timeline.getRouting = vi.fn(async () => routing([]))
    await rightClick(arrowOf(container, 2))
    expect(window.xleth.timeline.removeSidechainRoute).toHaveBeenCalledWith(1, 'sc-1')
    expect(arrowOf(container, 2).hasAttribute('data-sidechain')).toBe(false)
    await unmountRoot(root)
  })

  it('refuses a cycle and a visual-only target without calling the engine', async () => {
    const { MixerStrip, useMixerStore } = await loadMixerStripFixture()
    seedMixer(useMixerStore, { 2: 1 })
    useMixerStore.setState({ selectedChainKey: '1' })

    const { container, root } = await renderStrips(MixerStrip, [1, 2, 3])
    await click(arrowOf(container, 2))
    expect(useMixerStore.getState().routingError).toBe('Would create feedback loop')
    await click(arrowOf(container, 3))
    expect(useMixerStore.getState().routingError).toBe('Invalid output target')
    expect(window.xleth.timeline.setTrackRoutes).not.toHaveBeenCalled()
    await unmountRoot(root)
  })

  it('lights the arrow of the bus the selected track is routed to', async () => {
    const { MixerStrip, useMixerStore } = await loadMixerStripFixture()
    seedMixer(useMixerStore, { 1: 2 })
    useMixerStore.setState({ selectedChainKey: '1' })

    const { container, root } = await renderStrips(MixerStrip, [1, 2])

    expect(arrowOf(container, 2).getAttribute('aria-pressed')).toBe('true')
    // The primary output has no level dial (the fader is its level).
    expect(container.querySelector('[data-testid="route-2"] [role="slider"]')).toBeNull()
    await unmountRoot(root)
  })

  it('shows the output pearl and visual-only at rest and dims a muted strip with a glyph', async () => {
    const { MixerStrip, useMixerStore } = await loadMixerStripFixture()
    seedMixer(useMixerStore, {}, { muted: true })

    const { container, root } = await renderStrip(MixerStrip, 1)
    const strip = container.querySelector('[data-testid="mixer-strip-1"]')

    // Muted = the pearl is dark (hollow); it is lit only when the track is heard.
    expect(container.querySelector('button[aria-label="Track A output"]').getAttribute('aria-pressed')).toBe('false')
    expect(container.querySelector('button[aria-label="Visual only Track A"]').getAttribute('aria-pressed')).toBe('false')
    expect(strip.getAttribute('data-muted')).toBe('true')
    expect(strip.getAttribute('aria-label')).toContain('muted')
    expect(strip.querySelector('svg[data-icon="speaker-simple-x"]')).not.toBeNull()
    await unmountRoot(root)
  })

  it('wires the pearl (click = on/off, right-click = solo) and V to the engine', async () => {
    const { MixerStrip, useMixerStore } = await loadMixerStripFixture()
    seedMixer(useMixerStore)

    const { container, root } = await renderStrip(MixerStrip, 1)
    const pearl = () => container.querySelector('button[aria-label="Track A output"]')
    await click(pearl())
    expect(window.xleth.timeline.setTrackMuted).toHaveBeenCalledWith(1, true)
    await click(pearl())
    expect(window.xleth.timeline.setTrackMuted).toHaveBeenLastCalledWith(1, false)

    // Right-click: Track A only - every other track is muted.
    window.xleth.timeline.setTrackMuted.mockClear()
    await act(async () => { pearl().dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })) })
    expect(window.xleth.timeline.setTrackMuted.mock.calls).toEqual([[2, true], [3, true]])
    // Right-click the only lit one: everything back on.
    window.xleth.timeline.setTrackMuted.mockClear()
    await act(async () => { pearl().dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })) })
    expect(window.xleth.timeline.setTrackMuted.mock.calls).toEqual([[2, false], [3, false]])

    await click(container.querySelector('button[aria-label="Visual only Track A"]'))
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
    expect(rows.map((r) => r.textContent)).toEqual(['Param. EQ', 'Compressor', 'UniFlange', 'Delay', '+3 more'])
    expect(rows[1].getAttribute('data-off')).toBe('true')
    expect(rows[1].getAttribute('title')).toBe('Compressor (bypassed)')
    // The row prints the short name; its tooltip spells the device out.
    expect(rows[0].getAttribute('title')).toBe('Parametric EQ')

    await click(rows[2])
    expect(useMixerStore.getState().selectedChainKey).toBe('1')
    expect(usePanelRegistry.getState().panels.devices.hidden).toBe(false)
    expect(useDeviceRevealStore.getState().request).toMatchObject({ chainKey: '1', index: 2 })

    // "+3 more" opens the first device that is not listed.
    await click(rows[4])
    expect(useDeviceRevealStore.getState().request).toMatchObject({ chainKey: '1', index: 4 })
    await unmountRoot(root)
  })

  it('closed, a strip shows one "N FX" cell that still opens its chain', async () => {
    const chain = ['xletheq', 'compressor', 'delay'].map((pluginId, i) => ({ nodeId: 40 + i, pluginId }))
    window.xleth.audio.getEffectChain = vi.fn(async () => chain)
    const { MixerStrip, useMixerStore, usePanelRegistry } = await loadMixerStripFixture()
    seedMixer(useMixerStore)
    usePanelRegistry.getState().closePanel('devices')

    const { container, root } = await renderStrip(MixerStrip, 1, { insertsOpen: false })
    const cell = container.querySelector('[data-testid="mixer-inserts"]')
    expect(cell.getAttribute('data-closed')).toBe('true')
    expect(cell.querySelectorAll('[role="option"]')).toHaveLength(0)
    expect(cell.textContent).toBe('3 FX')
    await click(cell)
    expect(useMixerStore.getState().selectedChainKey).toBe('1')
    expect(usePanelRegistry.getState().panels.devices.hidden).toBe(false)
    await unmountRoot(root)
  })

  it('a short dock shows three insert rows', async () => {
    const chain = ['xletheq', 'compressor', 'delay', 'reverb'].map((pluginId, i) => ({ nodeId: 20 + i, pluginId }))
    window.xleth.audio.getEffectChain = vi.fn(async () => chain)
    const { MixerStrip, useMixerStore } = await loadMixerStripFixture()
    seedMixer(useMixerStore)

    const { container, root } = await renderStrip(MixerStrip, 1, { insertRowCount: 3 })
    const rows = Array.from(container.querySelectorAll('[data-testid="mixer-inserts"] [role="option"]')).map((r) => r.textContent)
    expect(rows).toEqual(['Param. EQ', 'Compressor', '+2 more'])
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

  it('prints no "Pan" or "Width" word and no knob readout; the knobs keep their names and values; positive gain is signed', async () => {
    const { MixerStrip, useMixerStore } = await loadMixerStripFixture()
    seedMixer(useMixerStore, {}, { volume: 10 ** (3 / 20) })

    const { container, root } = await renderStrip(MixerStrip, 1)
    const text = container.textContent
    expect(text).not.toContain('Pan')
    expect(text).not.toContain('Width')
    const sliders = Array.from(container.querySelectorAll('[role="slider"]'))
    expect(sliders.map((s) => s.getAttribute('aria-label'))).toEqual(expect.arrayContaining(['Pan', 'Width']))
    // Width is a plain dial and pan a horizontal slider: no "C" and no "100 %" printed on them. The
    // value is still the accessible value text, and a double-click still types one.
    expect(text).not.toMatch(/100\s%/)
    const pan = sliders.find((s) => s.getAttribute('aria-label') === 'Pan')
    const width = sliders.find((s) => s.getAttribute('aria-label') === 'Width')
    expect(pan.getAttribute('aria-orientation')).toBe('horizontal')
    expect(width.hasAttribute('data-minimal')).toBe(true)
    expect(width.hasAttribute('data-no-value')).toBe(true)
    expect(pan.textContent).toBe('')
    expect(width.textContent).toBe('')
    expect(pan.getAttribute('aria-valuetext')).toBe('Pan, C')
    expect(width.getAttribute('aria-valuetext')).toMatch(/^Width, 100\s%$/)
    // Positive gain says so; the volume field draws no fill of its own (the fader is the slider).
    const field = sliders.find((s) => s.getAttribute('aria-label') === 'Track A volume' && s.getAttribute('aria-orientation') === 'horizontal')
    expect(field.getAttribute('aria-valuetext')).toBe('Track A volume, +3.0\u2009dB')
    expect(field.querySelector('[class*="fill"]')).toBeNull()
    // The clip latch is not drawn until the meter clips.
    expect(container.querySelector('[data-clip-space]')).not.toBeNull()
    expect(container.querySelector('button[aria-label*="clipping"]')).toBeNull()
    await unmountRoot(root)
  })

  it('writes the name once, up the side of the meter, and keeps only the number in the head', async () => {
    const { MixerStrip, useMixerStore } = await loadMixerStripFixture()
    seedMixer(useMixerStore)

    const { container, root } = await renderStrip(MixerStrip, 1)
    const names = Array.from(container.querySelectorAll('[data-testid="strip-name"]'))
    expect(names).toHaveLength(1)
    expect(names[0].textContent).toBe('Track A')
    expect(names[0].getAttribute('title')).toBe('Track A')
    // Decoration for the eye: the strip's group label already names the track.
    expect(names[0].getAttribute('aria-hidden')).toBe('true')
    // It sits in the fader row, after the meter (next to it), not in the head.
    const row = names[0].parentElement
    expect(row.querySelector('[role="group"][aria-label="Track A meter"]')).not.toBeNull()
    expect(row.lastElementChild).toBe(names[0])
    expect(names[0].previousElementSibling.getAttribute('aria-label')).toBe('Track A meter')
    await unmountRoot(root)
  })

  it('the name reads top to bottom in bold: plain vertical-rl, and a muted strip does not dim it', () => {
    const css = readFileSync(path.resolve(process.cwd(), 'src/components/mixer/MixerStrip.module.css'), 'utf8')
    const vtext = /\.vtext\s*\{([^}]*)\}/.exec(css)?.[1] ?? ''
    expect(vtext).toMatch(/writing-mode:\s*vertical-rl/)
    expect(vtext).not.toMatch(/transform:\s*rotate/)
    expect(vtext).toMatch(/font-weight:\s*var\(--weight-semibold\)/)
    // The fader row is exempt from the strip-wide mute dimming; only its fader and meter dim.
    expect(css).toMatch(/\[data-muted="true"\]\s*>\s*:not\(\.toggles\):not\(\.head\):not\(\.faderRow\)/)
    expect(css).toMatch(/\[data-muted="true"\]\s*>\s*\.faderRow\s*>\s*:not\(\.vname\)/)
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
