// @vitest-environment jsdom
import React, { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRoot } from 'react-dom/client'
import MidiSampleRail from './MidiSampleRail.jsx'
import { clearSamplePreviewCache } from './samplePreviewCache.js'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

let container
let root

function renderRail(props) {
  act(() => {
    root.render(<MidiSampleRail {...props} />)
  })
}

describe('MidiSampleRail', () => {
  beforeEach(() => {
    window.xleth = { video: {} }
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    clearSamplePreviewCache()
  })

  afterEach(() => {
    act(() => { root.unmount() })
    container.remove()
  })

  it('selects a sample tile and clears back to assign later', () => {
    const onChange = vi.fn()
    const items = [
      { id: 42, name: 'Kick', source: { id: 1, hasVideo: false } },
    ]

    renderRail({ items, value: null, onChange })
    const initialTiles = container.querySelectorAll('[data-sample-tile]')
    expect(initialTiles[0].getAttribute('aria-pressed')).toBe('true')

    act(() => {
      initialTiles[1].dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(onChange).toHaveBeenLastCalledWith(42)

    renderRail({ items, value: 42, onChange })
    const selectedTiles = container.querySelectorAll('[data-sample-tile]')
    expect(selectedTiles[1].getAttribute('aria-pressed')).toBe('true')

    act(() => {
      selectedTiles[0].dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(onChange).toHaveBeenLastCalledWith(null)
  })

  it('renders disabled tiles without firing selection', () => {
    const onChange = vi.fn()
    renderRail({
      items: [{ id: 42, name: 'Kick', source: { id: 1, hasVideo: false } }],
      value: 42,
      onChange,
      disabled: true,
    })

    const sampleTile = container.querySelectorAll('[data-sample-tile]')[1]
    expect(sampleTile.disabled).toBe(true)
    act(() => {
      sampleTile.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(onChange).not.toHaveBeenCalled()
  })

  it('shares one getFrameAtTime call between two simultaneous rail instances previewing the same tile', async () => {
    const getFrameAtTime = vi.fn().mockResolvedValue('data:image/png;base64,XYZ')
    window.xleth = { video: { getFrameAtTime } }

    const items = [{
      id: 42,
      name: 'Kick',
      source: { id: 1, hasVideo: true, filePath: 'a.mp4', duration: 2 },
      previewTime: 0.5,
    }]

    const containerB = document.createElement('div')
    document.body.appendChild(containerB)
    const rootB = createRoot(containerB)

    await act(async () => {
      root.render(<MidiSampleRail items={items} value={null} onChange={() => {}} />)
      rootB.render(<MidiSampleRail items={items} value={null} onChange={() => {}} />)
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(getFrameAtTime).toHaveBeenCalledTimes(1)
    expect(getFrameAtTime).toHaveBeenCalledWith(1, 0.5, 144, 81)

    const imgA = container.querySelector('[data-sample-tile] img')
    const imgB = containerB.querySelector('[data-sample-tile] img')
    expect(imgA?.getAttribute('src')).toBe('data:image/png;base64,XYZ')
    expect(imgB?.getAttribute('src')).toBe('data:image/png;base64,XYZ')

    act(() => { rootB.unmount() })
    containerB.remove()
  })

  it('does not serve a stale thumbnail once the source fingerprint (filePath/duration) changes', async () => {
    const getFrameAtTime = vi.fn().mockResolvedValue('data:image/png;base64,ORIGINAL')
    window.xleth = { video: { getFrameAtTime } }

    const items = [{
      id: 42,
      name: 'Kick',
      source: { id: 1, hasVideo: true, filePath: 'a.mp4', duration: 2 },
      previewTime: 0.5,
    }]

    await act(async () => {
      root.render(<MidiSampleRail items={items} value={null} onChange={() => {}} />)
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(getFrameAtTime).toHaveBeenCalledTimes(1)

    // Same sourceId, but the underlying media changed (re-swapped audio, say) --
    // the fingerprint differs, so this must NOT reuse the cached entry.
    getFrameAtTime.mockResolvedValue('data:image/png;base64,UPDATED')
    const changedItems = [{
      id: 42,
      name: 'Kick',
      source: { id: 1, hasVideo: true, filePath: 'a.mp4', duration: 9 },
      previewTime: 0.5,
    }]

    const containerB = document.createElement('div')
    document.body.appendChild(containerB)
    const rootB = createRoot(containerB)

    await act(async () => {
      rootB.render(<MidiSampleRail items={changedItems} value={null} onChange={() => {}} />)
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(getFrameAtTime).toHaveBeenCalledTimes(2)
    const imgB = containerB.querySelector('[data-sample-tile] img')
    expect(imgB?.getAttribute('src')).toBe('data:image/png;base64,UPDATED')

    act(() => { rootB.unmount() })
    containerB.remove()
  })
})
