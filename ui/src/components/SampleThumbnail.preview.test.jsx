/**
 * @vitest-environment jsdom
 */
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import SampleThumbnail from './SampleThumbnail.jsx'

const HOVER_PREVIEW_DELAY_MS = 200

function baseProps(overrides = {}) {
  return {
    region: { id: 42, sourceId: 1, startTime: 12.5, endTime: 14.2, label: 'Quote', name: 'Quote 1' },
    isActive: false,
    onSelect: () => {},
    onContextMenu: () => {},
    sourceName: 'source.mp4',
    sourceFilePath: 'C:\\media\\source.mp4',
    sourceHasVideo: true,
    rootNote: null,
    onDoubleClick: () => {},
    ...overrides,
  }
}

async function seekAndCapture(video) {
  Object.defineProperty(video, 'videoWidth', { value: 320, configurable: true })
  Object.defineProperty(video, 'videoHeight', { value: 180, configurable: true })
  await act(async () => { video.dispatchEvent(new Event('loadedmetadata')) })
  await act(async () => { video.dispatchEvent(new Event('seeked')) })
}

describe('SampleThumbnail still-frame cache + shared mediaPort', () => {
  let getMediaPortMock

  beforeEach(() => {
    vi.useFakeTimers()
    globalThis.IS_REACT_ACT_ENVIRONMENT = true

    // jsdom doesn't implement real video decode or canvas 2D rendering —
    // stub just enough of the surface for the capture path to run.
    window.HTMLMediaElement.prototype.play = vi.fn(() => Promise.resolve())
    window.HTMLMediaElement.prototype.pause = vi.fn()
    HTMLCanvasElement.prototype.getContext = vi.fn(() => ({ drawImage: vi.fn() }))
    HTMLCanvasElement.prototype.toDataURL = vi.fn(() => 'data:image/jpeg;base64,FAKESTILL')

    getMediaPortMock = vi.fn(async () => 4321)
    window.xleth = { getMediaPort: getMediaPortMock }

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

  it('N simultaneous cache-miss thumbnails share one mediaPort call and each eagerly loads/seeks/captures', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)

    await act(async () => {
      root.render(
        <>
          <SampleThumbnail {...baseProps({ region: { id: 1, sourceId: 1, startTime: 1, endTime: 2, label: 'Quote', name: 'A' } })} />
          <SampleThumbnail {...baseProps({ region: { id: 2, sourceId: 1, startTime: 3, endTime: 4, label: 'Quote', name: 'B' } })} />
          <SampleThumbnail {...baseProps({ region: { id: 3, sourceId: 1, startTime: 5, endTime: 6, label: 'Quote', name: 'C' } })} />
        </>
      )
      await Promise.resolve() // let the shared getMediaPort() promise resolve
    })
    await act(async () => { await Promise.resolve() })

    // Exactly one underlying IPC call, no matter how many thumbnails mounted together.
    expect(getMediaPortMock).toHaveBeenCalledTimes(1)

    const videos = container.querySelectorAll('video')
    expect(videos.length).toBe(3) // cache miss → each eagerly mounts its own <video>

    for (const video of videos) {
      await seekAndCapture(video)
    }

    expect(container.querySelectorAll('img.sample-thumbnail-still-cache').length).toBe(3)
    expect(HTMLCanvasElement.prototype.toDataURL).toHaveBeenCalledTimes(3)

    await act(async () => root.unmount())
  })

  it('cache hit: does not mount <video> until hover, then activates it in time for preview', async () => {
    // First mount populates the cache for region id=1 (cache miss).
    const primer = document.createElement('div')
    document.body.appendChild(primer)
    const primerRoot = createRoot(primer)
    await act(async () => {
      primerRoot.render(<SampleThumbnail {...baseProps()} />)
      await Promise.resolve()
    })
    await act(async () => { await Promise.resolve() })
    await seekAndCapture(primer.querySelector('video'))
    await act(async () => primerRoot.unmount())

    // Second mount of the SAME region+startTime should be a cache hit.
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    await act(async () => {
      root.render(<SampleThumbnail {...baseProps()} />)
      await Promise.resolve()
    })
    await act(async () => { await Promise.resolve() })

    // Cached still paints immediately — no <video> element mounted yet.
    const img = container.querySelector('img.sample-thumbnail-still-cache')
    expect(img).not.toBeNull()
    expect(img.src).toBe('data:image/jpeg;base64,FAKESTILL')
    expect(container.querySelector('video')).toBeNull()

    // Hover in: video should activate immediately (ahead of the preview delay).
    // React's onMouseEnter is synthesized from native 'mouseover' (mouseenter itself
    // doesn't bubble, so React listens at the root via mouseover/mouseout instead).
    await act(async () => {
      container.querySelector('.sample-thumbnail').dispatchEvent(
        new MouseEvent('mouseover', { bubbles: true, relatedTarget: null })
      )
    })
    const video = container.querySelector('video')
    expect(video).not.toBeNull()

    Object.defineProperty(video, 'videoWidth', { value: 320, configurable: true })
    Object.defineProperty(video, 'videoHeight', { value: 180, configurable: true })

    // Advance past the hover delay: startPreview() should now run against a mounted video.
    await act(async () => {
      vi.advanceTimersByTime(HOVER_PREVIEW_DELAY_MS)
    })
    expect(video.play).toHaveBeenCalledOnce()
    expect(video.currentTime).toBe(12.5)

    await act(async () => root.unmount())
  })
})
