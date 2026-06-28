/**
 * @vitest-environment jsdom
 */
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import SampleRow from './SampleRow.jsx'

class MockAudio {
  static instances = []

  constructor(src) {
    this.src = src
    this.currentTime = 0
    this.listeners = new Map()
    this.pause = vi.fn()
    this.play = vi.fn(async () => {})
    MockAudio.instances.push(this)
  }

  addEventListener(type, listener) {
    this.listeners.set(type, listener)
  }

  emit(type) {
    this.listeners.get(type)?.()
  }
}

describe('SampleRow preview playback', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    MockAudio.instances = []
    vi.stubGlobal('Audio', MockAudio)
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    window.xleth = { getMediaPort: vi.fn(async () => 4321) }
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
    document.body.innerHTML = ''
    delete window.xleth
    delete globalThis.IS_REACT_ACT_ENVIRONMENT
  })

  it('waits for metadata before seeking, playing, and timing the cut', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)

    await act(async () => {
      root.render(
        <SampleRow
          region={{ id: 3, sourceId: 1, startTime: 394.1, endTime: 394.81, label: 'Snare', name: 'Snare 3' }}
          isActive={false}
          onSelect={() => {}}
          onContextMenu={() => {}}
          isEditing={false}
          editValue=""
          onRenameChange={() => {}}
          onRenameCommit={() => {}}
          onRenameCancel={() => {}}
          sourceName="source.mp4"
          sourceFilePath={'C:\\media\\source.mp4'}
          rootNote={null}
        />,
      )
    })

    await act(async () => {
      container.querySelector('.sample-row-play').click()
    })

    const audio = MockAudio.instances[0]
    expect(audio.src).toBe('http://127.0.0.1:4321/media?path=C%3A%5Cmedia%5Csource.mp4')
    expect(audio.play).not.toHaveBeenCalled()
    expect(audio.currentTime).toBe(0)
    act(() => vi.advanceTimersByTime(1000))
    expect(audio.pause).not.toHaveBeenCalled()

    await act(async () => {
      audio.emit('loadedmetadata')
      await Promise.resolve()
    })

    expect(audio.currentTime).toBe(394.1)
    expect(audio.play).toHaveBeenCalledOnce()

    act(() => vi.advanceTimersByTime(700))
    expect(audio.pause).not.toHaveBeenCalled()
    act(() => vi.advanceTimersByTime(20))
    expect(audio.pause).toHaveBeenCalledOnce()

    await act(async () => root.unmount())
  })
})
