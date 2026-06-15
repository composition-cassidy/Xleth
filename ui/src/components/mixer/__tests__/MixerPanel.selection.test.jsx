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
  vi.doMock('../SelectedEffectRack.jsx', () => ({
    default: () => <div data-testid="selected-effect-rack" />,
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

describe('MixerPanel selected effect rack fallback', () => {
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
    vi.doUnmock('../SelectedEffectRack.jsx')
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

  it('falls back to an empty rack state when no mixer tracks remain', async () => {
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
})
