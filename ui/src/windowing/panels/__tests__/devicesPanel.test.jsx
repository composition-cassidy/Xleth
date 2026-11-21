/**
 * @vitest-environment jsdom
 */
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import useMixerStore from '../../../stores/mixerStore.js'
import useVideoDeviceStore from '../../../components/devices/video/videoDeviceStore.js'

vi.mock('../../components/PanelFrame', () => ({ PanelFrame: ({ children }) => <div>{children}</div> }))

import DevicesPanel from '../DevicesPanel'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

let container
let root

const flush = async () => { await act(async () => { await new Promise((r) => setTimeout(r, 0)) }) }

beforeEach(() => {
  HTMLCanvasElement.prototype.getContext = () => null
  window.xleth = {
    timeline: { getTracks: vi.fn(async () => [{ id: 3, name: 'Pitch', type: 'Clip', visualEffectChain: [] }]) },
    audio: { getEffectChain: async () => '[]' },
  }
  useMixerStore.setState({ selectedChainKey: '3', tracks: { 3: { id: 3, name: 'Pitch' } } })
  useVideoDeviceStore.setState({ view: 'audio', viewNonce: 0, shown: {}, window: null })
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  delete window.xleth
})

describe('DevicesPanel', () => {
  it('shows an Audio lane over a Video lane, each under its own text tab, with no view switch', async () => {
    act(() => root.render(<DevicesPanel />))
    await flush()
    const lanes = Array.from(container.querySelectorAll('[data-lane]'))
    expect(lanes.map((l) => l.getAttribute('data-lane'))).toEqual(['audio', 'video'])
    expect(lanes[0].querySelector('[data-testid="xleth-device-chain"]')).not.toBeNull()
    expect(lanes[1].querySelector('[data-testid="xleth-video-chain"]')).not.toBeNull()
    expect(container.querySelector('[data-testid="xleth-lane-tab-audio"]').textContent).toBe('Audio')
    expect(container.querySelector('[data-testid="xleth-lane-tab-video"]').textContent).toBe('Video')
    expect(container.querySelector('[data-chain-view]')).toBeNull()
    expect(container.querySelector('[data-lane] svg')).toBeNull() // tabs carry text, not icons
  })

  it('asking for the Video lane scrolls it into view', async () => {
    act(() => root.render(<DevicesPanel />))
    await flush()
    const scroller = container.querySelector('[data-testid="xleth-devices-lanes"]')
    scroller.scrollTo = vi.fn()
    act(() => useVideoDeviceStore.getState().setView('video'))
    expect(scroller.scrollTo).toHaveBeenCalledTimes(1)
    act(() => useVideoDeviceStore.getState().setView('video'))
    expect(scroller.scrollTo).toHaveBeenCalledTimes(2)
  })
})
