/**
 * @vitest-environment jsdom
 */
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

async function loadMixerPanelFixture() {
  vi.doMock('../MixerStrip.jsx', () => ({
    default: ({ trackId }) => <div data-testid={`mixer-strip-${trackId}`} />,
  }))
  vi.doMock('../MasterStrip.jsx', () => ({
    default: () => <div data-testid="master-strip" />,
  }))

  const panelModule = await import('../MixerPanel.jsx')
  const { default: useMixerStore } = await import('../../../stores/mixerStore.js')
  const { default: useTimelineFocusStore } = await import('../../../stores/timelineFocusStore.js')
  return { MixerPanel: panelModule.default, useMixerStore, useTimelineFocusStore }
}

function makeTimelineTrack(id, name) {
  return {
    id,
    name,
    volume: 1,
    pan: 0,
    muted: false,
    solo: false,
    visualOnly: false,
    outputRoute: { targetTrackId: -1 },
  }
}

function renderPanel(Component) {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  act(() => {
    root.render(<Component />)
  })
  return { container, root }
}

async function flushEffects() {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

describe('MixerPanel selection and layout', () => {
  beforeEach(() => {
    vi.resetModules()
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    window.xleth = {
      audio: {
        getAllPeaks: vi.fn(async () => null),
      },
      timeline: {
        getTracks: vi.fn(async () => []),
        getRouting: vi.fn(async () => []),
      },
      onProjectLoaded: vi.fn(() => () => {}),
    }
  })

  afterEach(() => {
    document.body.innerHTML = ''
    delete window.xleth
    delete globalThis.IS_REACT_ACT_ENVIRONMENT
    vi.doUnmock('../MixerStrip.jsx')
    vi.doUnmock('../MasterStrip.jsx')
  })

  it('falls back to the focused track when the selected chain was removed', async () => {
    const { MixerPanel, useMixerStore, useTimelineFocusStore } = await loadMixerPanelFixture()
    const timelineTracks = [makeTimelineTrack(7, 'Bass'), makeTimelineTrack(8, 'Keys')]
    window.xleth.timeline.getTracks.mockResolvedValue(timelineTracks)
    useTimelineFocusStore.setState({ focusedTrackId: 8 })
    useMixerStore.setState({
      visible: true,
      tracks: {
        7: { id: 7, name: 'Bass', volume: 1, pan: 0, spread: 1, muted: false, solo: false, visualOnly: false },
        8: { id: 8, name: 'Keys', volume: 1, pan: 0, spread: 1, muted: false, solo: false, visualOnly: false },
      },
      trackOrder: [7, 8],
      selectedChainKey: '99',
    })

    const { root } = renderPanel(MixerPanel)
    await flushEffects()

    expect(useMixerStore.getState().selectedChainKey).toBe('8')
    await act(async () => root.unmount())
  })

  it('clears the selection when no mixer tracks remain', async () => {
    const { MixerPanel, useMixerStore, useTimelineFocusStore } = await loadMixerPanelFixture()
    window.xleth.timeline.getTracks.mockResolvedValue([])
    useTimelineFocusStore.setState({ focusedTrackId: null })
    useMixerStore.setState({
      visible: true,
      tracks: {},
      trackOrder: [],
      selectedChainKey: '99',
    })

    const { root } = renderPanel(MixerPanel)
    await flushEffects()

    expect(useMixerStore.getState().selectedChainKey).toBeNull()
    await act(async () => root.unmount())
  })

  it('does not mount the VST browser or deprecated mixer toolbar', async () => {
    const { MixerPanel, useMixerStore } = await loadMixerPanelFixture()
    useMixerStore.setState({
      visible: true,
      tracks: {},
      trackOrder: [],
      selectedChainKey: null,
      routingError: null,
    })

    const { container, root } = renderPanel(MixerPanel)
    await flushEffects()

    expect(container.querySelector('.vst-browser')).toBeNull()
    expect(container.querySelector('.mixer-toolbar')).toBeNull()
    await act(async () => root.unmount())
  })

  it('has no permanent inspector column, with or without tracks', async () => {
    const { MixerPanel, useMixerStore } = await loadMixerPanelFixture()
    useMixerStore.setState({
      visible: true,
      tracks: { 7: { id: 7, name: 'Bass', volume: 1, pan: 0, spread: 1, muted: false, solo: false, visualOnly: false } },
      trackOrder: [7],
      selectedChainKey: '7',
    })

    const { container, root } = renderPanel(MixerPanel)
    await flushEffects()

    expect(container.querySelector('.selected-effect-rack')).toBeNull()
    expect(container.querySelector('[aria-label="Selected mixer effect rack"]')).toBeNull()
    expect(container.textContent).not.toMatch(/select a mixer track|no track selected/i)
    await act(async () => root.unmount())
  })

  it('keeps the master strip and the loudness dock fixed, after the scrolling strips', async () => {
    const { MixerPanel, useMixerStore } = await loadMixerPanelFixture()
    window.xleth.timeline.getTracks.mockResolvedValue([makeTimelineTrack(7, 'Bass'), makeTimelineTrack(8, 'Keys')])
    useMixerStore.setState({
      visible: true,
      tracks: {
        7: { id: 7, name: 'Bass', volume: 1, pan: 0, spread: 1, muted: false, solo: false, visualOnly: false },
        8: { id: 8, name: 'Keys', volume: 1, pan: 0, spread: 1, muted: false, solo: false, visualOnly: false },
      },
      trackOrder: [7, 8],
      selectedChainKey: '7',
    })

    const { container, root } = renderPanel(MixerPanel)
    await flushEffects()

    const panel = container.querySelector('[data-testid="mixer-panel"]')
    // Gutter (fixed), then the scrolling strips, then the dock (fixed).
    const gutter = panel.children[0]
    const scroll = panel.children[1]
    const dock = panel.children[2]
    expect(gutter.querySelector('[data-testid="mixer-gutter"]')).not.toBeNull()
    expect(scroll.querySelectorAll('[data-testid^="mixer-strip-"]')).toHaveLength(2)
    expect(dock.querySelector('[data-testid="master-strip"]')).not.toBeNull()
    expect(dock.textContent).toMatch(/loudness/i)
    // What every strip shares is printed once, in the gutter.
    expect(gutter.textContent).toContain('Pan')
    expect(gutter.textContent).toContain('Width')
    expect(gutter.textContent).toContain('dB')
    expect(scroll.textContent).not.toContain('Pan')
    expect(gutter.querySelector('[role="img"]').getAttribute('aria-label')).toBe('Level scale, 0 to −60 dB')
    await act(async () => root.unmount())
  })

  it('shows a structural empty state with an Add track action that calls the existing addTrack', async () => {
    const { MixerPanel, useMixerStore } = await loadMixerPanelFixture()
    window.xleth.timeline.addTrack = vi.fn(async () => 1)
    useMixerStore.setState({ visible: true, tracks: {}, trackOrder: [], selectedChainKey: null })

    const { container, root } = renderPanel(MixerPanel)
    await flushEffects()

    expect(container.textContent).not.toContain('add tracks in the timeline')
    const add = Array.from(container.querySelectorAll('button')).find(b => b.textContent === 'Add track')
    expect(add).toBeTruthy()
    await act(async () => { add.dispatchEvent(new MouseEvent('click', { bubbles: true })) })

    expect(window.xleth.timeline.addTrack).toHaveBeenCalledWith({ name: 'Track 1', order: 0 })
    expect(container.querySelector('[data-testid="master-strip"]')).not.toBeNull()
    await act(async () => root.unmount())
  })
})
