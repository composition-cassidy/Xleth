/**
 * @vitest-environment jsdom
 */
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import SampleThumbnail from './SampleThumbnail.jsx'
import { __resetSampleStillsForTests } from './sampleStills.js'

const HOVER_PREVIEW_DELAY_MS = 200

function baseProps(overrides = {}) {
  return {
    region: { id: 42, sourceId: 1, startTime: 12.5, endTime: 14.2, label: 'Quote', name: 'Quote 1' },
    isActive: false,
    onSelect: () => {},
    onContextMenu: () => {},
    sourceFilePath: 'C:\\media\\source.mp4',
    sourceHasVideo: true,
    sourceDuration: 60,
    rootNote: null,
    onOpen: () => {},
    ...overrides,
  }
}

function region(id, startTime) {
  return { id, sourceId: 1, startTime, endTime: startTime + 1, label: 'Quote', name: `R${id}` }
}

// Let the still pipeline (disk lookup → engine queue → setState) settle.
async function flush(rounds = 12) {
  for (let i = 0; i < rounds; i++) {
    await act(async () => { await Promise.resolve() })
  }
}

function mount(node) {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  return { container, root, render: async (n = node) => { await act(async () => { root.render(n) }); await flush() } }
}

describe('SampleThumbnail — shared stills, video only on hover', () => {
  let getMediaPortMock
  let getFrameAtTime
  let openSource

  beforeEach(() => {
    vi.useFakeTimers()
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    __resetSampleStillsForTests()

    window.HTMLMediaElement.prototype.play = vi.fn(() => Promise.resolve())
    window.HTMLMediaElement.prototype.pause = vi.fn()
    window.HTMLMediaElement.prototype.load = vi.fn()

    getMediaPortMock = vi.fn(async () => 4321)
    getFrameAtTime = vi.fn(async (sourceId, t) => `data:image/jpeg;base64,FRAME@${t.toFixed(2)}`)
    openSource = vi.fn(async () => ({ success: true }))
    window.xleth = {
      getMediaPort: getMediaPortMock,
      video: { getFrameAtTime, openSource },
    }

    // Simulate IntersectionObserver reporting every tile as in-view immediately.
    window.IntersectionObserver = class {
      constructor(cb) { this.cb = cb }
      observe(el) { this.cb([{ isIntersecting: true, target: el }]) }
      disconnect() {}
    }
  })

  afterEach(() => {
    vi.useRealTimers()
    document.body.innerHTML = ''
    delete window.xleth
    delete globalThis.IS_REACT_ACT_ENVIRONMENT
  })

  it('uncached tiles fetch one small engine frame each, one at a time, and mount no <video>', async () => {
    let inFlight = 0
    let peak = 0
    getFrameAtTime.mockImplementation(async (sourceId, t) => {
      inFlight += 1
      peak = Math.max(peak, inFlight)
      await Promise.resolve()
      inFlight -= 1
      return `data:image/jpeg;base64,FRAME@${t.toFixed(2)}`
    })

    const { container, root, render } = mount()
    await render(
      <>
        <SampleThumbnail {...baseProps({ region: region(1, 1) })} />
        <SampleThumbnail {...baseProps({ region: region(2, 3) })} />
        <SampleThumbnail {...baseProps({ region: region(3, 5) })} />
      </>
    )

    expect(container.querySelectorAll('video').length).toBe(0)
    expect(getFrameAtTime).toHaveBeenCalledTimes(3)
    expect(peak).toBe(1)
    // Tile-sized frame at region start + the still offset, not a full-res grab.
    expect(getFrameAtTime).toHaveBeenCalledWith(1, 1.04, 320, 180)

    const imgs = container.querySelectorAll('img.sample-thumbnail-still-cache')
    expect(imgs.length).toBe(3)
    expect(imgs[1].src).toBe('data:image/jpeg;base64,FRAME@3.04')

    await act(async () => root.unmount())
  })

  it('a remount of the same region paints from cache with no engine call', async () => {
    const first = mount()
    await first.render(<SampleThumbnail {...baseProps()} />)
    expect(getFrameAtTime).toHaveBeenCalledTimes(1)
    await act(async () => first.root.unmount())

    const second = mount()
    // Synchronously on first paint — no flush needed for a memory hit.
    await act(async () => { second.root.render(<SampleThumbnail {...baseProps()} />) })
    const img = second.container.querySelector('img.sample-thumbnail-still-cache')
    expect(img).not.toBeNull()
    expect(img.src).toBe('data:image/jpeg;base64,FRAME@12.54')
    await flush()
    expect(getFrameAtTime).toHaveBeenCalledTimes(1)
    expect(second.container.querySelector('video')).toBeNull()

    await act(async () => second.root.unmount())
  })

  it('re-rendering with fresh region objects (a regions refetch) does not refetch stills', async () => {
    const { root, render } = mount()
    await render(<SampleThumbnail {...baseProps()} />)
    await render(<SampleThumbnail {...baseProps({ region: { ...baseProps().region } })} />)
    await render(<SampleThumbnail {...baseProps({ region: { ...baseProps().region }, isActive: true })} />)
    expect(getFrameAtTime).toHaveBeenCalledTimes(1)
    await act(async () => root.unmount())
  })

  it('two tiles wanting the same frame share one engine call', async () => {
    const { container, root, render } = mount()
    await render(
      <>
        <SampleThumbnail {...baseProps({ region: region(1, 2) })} />
        <SampleThumbnail {...baseProps({ region: region(2, 2) })} />
      </>
    )
    expect(getFrameAtTime).toHaveBeenCalledTimes(1)
    expect(container.querySelectorAll('img.sample-thumbnail-still-cache').length).toBe(2)
    await act(async () => root.unmount())
  })

  it('opens the source in the frame server when it is not open yet (loaded project)', async () => {
    let open = false
    openSource.mockImplementation(async () => { open = true; return { success: true } })
    getFrameAtTime.mockImplementation(async () => (open ? 'data:image/jpeg;base64,OPENED' : null))

    const { container, root, render } = mount()
    await render(
      <>
        <SampleThumbnail {...baseProps({ region: region(1, 1) })} />
        <SampleThumbnail {...baseProps({ region: region(2, 3) })} />
      </>
    )
    expect(openSource).toHaveBeenCalledTimes(1)
    expect(openSource).toHaveBeenCalledWith(1)
    expect(container.querySelectorAll('img.sample-thumbnail-still-cache').length).toBe(2)
    await act(async () => root.unmount())
  })

  it('a source that cannot be opened is tried once, not once per tile or per mount', async () => {
    getFrameAtTime.mockImplementation(async () => null)
    openSource.mockImplementation(async () => ({ success: false }))

    const tiles = (
      <>
        <SampleThumbnail {...baseProps({ region: region(1, 1) })} />
        <SampleThumbnail {...baseProps({ region: region(2, 3) })} />
        <SampleThumbnail {...baseProps({ region: region(3, 5) })} />
      </>
    )
    const first = mount()
    await first.render(tiles)
    expect(openSource).toHaveBeenCalledTimes(1)
    expect(getFrameAtTime).toHaveBeenCalledTimes(3)
    expect(first.container.querySelectorAll('img').length).toBe(0)
    await act(async () => first.root.unmount())

    const second = mount()
    await second.render(tiles)
    expect(openSource).toHaveBeenCalledTimes(1)
    expect(getFrameAtTime).toHaveBeenCalledTimes(3)
    await act(async () => second.root.unmount())
  })

  it('an engine error is not remembered as "no frame" — the next mount retries', async () => {
    getFrameAtTime.mockImplementationOnce(async () => { throw new Error('Engine not ready: starting') })

    const first = mount()
    await first.render(<SampleThumbnail {...baseProps()} />)
    expect(first.container.querySelector('img')).toBeNull()
    await act(async () => first.root.unmount())

    const second = mount()
    await second.render(<SampleThumbnail {...baseProps()} />)
    expect(getFrameAtTime).toHaveBeenCalledTimes(2)
    expect(second.container.querySelector('img.sample-thumbnail-still-cache')).not.toBeNull()
    await act(async () => second.root.unmount())
  })

  it('tiles that unmount before their turn never reach the engine', async () => {
    let releaseFirst
    getFrameAtTime.mockImplementationOnce(() => new Promise(resolve => { releaseFirst = resolve }))

    const { root, render } = mount()
    await render(
      <>
        <SampleThumbnail {...baseProps({ region: region(1, 1) })} />
        <SampleThumbnail {...baseProps({ region: region(2, 3) })} />
        <SampleThumbnail {...baseProps({ region: region(3, 5) })} />
      </>
    )
    expect(getFrameAtTime).toHaveBeenCalledTimes(1) // first is in flight, two are queued

    await act(async () => root.unmount())
    await act(async () => { releaseFirst('data:image/jpeg;base64,LATE') })
    await flush()
    expect(getFrameAtTime).toHaveBeenCalledTimes(1)
  })

  it('mounts a <video> only while hovered, plays the region, and releases it on leave', async () => {
    const { container, root, render } = mount()
    await render(<SampleThumbnail {...baseProps()} />)
    // The port is looked up once per app lifetime (module scope), so by this
    // point in the file an earlier tile has usually already resolved it.
    expect(getMediaPortMock.mock.calls.length).toBeLessThanOrEqual(1)
    expect(container.querySelector('video')).toBeNull()

    // React's onMouseEnter is synthesized from native 'mouseover' (mouseenter itself
    // doesn't bubble, so React listens at the root via mouseover/mouseout instead).
    const tile = container.querySelector('.sample-thumbnail')
    await act(async () => {
      tile.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, relatedTarget: null }))
    })
    const video = container.querySelector('video')
    expect(video).not.toBeNull()
    expect(video.getAttribute('src')).toContain('http://127.0.0.1:4321/media?path=')
    // The still stays up until the video is actually presenting frames.
    expect(container.querySelector('img.sample-thumbnail-still-cache')).not.toBeNull()

    await act(async () => { vi.advanceTimersByTime(HOVER_PREVIEW_DELAY_MS) })
    expect(video.play).toHaveBeenCalledOnce()
    expect(video.currentTime).toBe(12.5)
    expect(container.querySelector('img.sample-thumbnail-still-cache')).not.toBeNull()

    await act(async () => { video.dispatchEvent(new Event('playing')) })
    expect(container.querySelector('img.sample-thumbnail-still-cache')).toBeNull()

    await act(async () => {
      tile.dispatchEvent(new MouseEvent('mouseout', { bubbles: true, relatedTarget: document.body }))
    })
    expect(container.querySelector('video')).toBeNull()
    expect(video.load).toHaveBeenCalled()
    expect(video.hasAttribute('src')).toBe(false)
    expect(container.querySelector('img.sample-thumbnail-still-cache')).not.toBeNull()

    await act(async () => root.unmount())
  })

  it('audio-only tiles fetch waveform peaks once across re-renders and remounts', async () => {
    const getFilePeaks = vi.fn(async () => ({ peaks: new Float32Array([-0.5, 0.5, 0.3, -0.2, 0.4, 0.2]), ready: true }))
    window.xleth.waveform = { getFilePeaks }
    HTMLCanvasElement.prototype.getContext = vi.fn(() => ({ clearRect: vi.fn(), fillRect: vi.fn() }))

    const props = baseProps({ sourceHasVideo: false, sourceFilePath: 'C:\\media\\hit.wav' })
    const first = mount()
    await first.render(<SampleThumbnail {...props} />)
    await first.render(<SampleThumbnail {...props} region={{ ...props.region }} />)
    await first.render(<SampleThumbnail {...props} region={{ ...props.region }} isActive />)
    expect(getFilePeaks).toHaveBeenCalledTimes(1)
    expect(getFrameAtTime).not.toHaveBeenCalled()
    await act(async () => first.root.unmount())

    const second = mount()
    await second.render(<SampleThumbnail {...props} />)
    expect(getFilePeaks).toHaveBeenCalledTimes(1)
    await act(async () => second.root.unmount())
  })
})
