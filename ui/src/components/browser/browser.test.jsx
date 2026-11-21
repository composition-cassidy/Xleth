/**
 * @vitest-environment jsdom
 */
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { formatClock, formatSampleDuration, moveRowFocus } from './browserFormat.js'
import useBrowserStore, { HISTORY_LIMIT } from '../../stores/browserStore.js'
import {
  getActivePreviewId,
  startPreview,
  stopPreview,
  subscribePreview,
  togglePreview,
} from '../samplePreview.js'
import SourceCard from '../SourceCard.jsx'
import SearchField from './SearchField.jsx'

describe('browser duration format', () => {
  it('keeps decimals for a sample and a clock for a source, with a thin space before the unit', () => {
    expect(formatSampleDuration(0.42)).toBe('0.42\u2009s')
    expect(formatSampleDuration(12)).toBe('12.00\u2009s')
    expect(formatSampleDuration(Number.NaN)).toBe('0.00\u2009s')
    expect(formatClock(204)).toBe('3:24')
    expect(formatClock(3727)).toBe('1:02:07')
    expect(formatClock(-5)).toBe('0:00')
  })
})

describe('browser store', () => {
  beforeEach(() => {
    localStorage.clear()
    useBrowserStore.setState({ tab: 'media', autoPreview: true, history: { media: [], samples: [] } })
  })

  it('remembers recent searches per tab, newest first, without duplicates, capped', () => {
    const { pushHistory } = useBrowserStore.getState()
    pushHistory('samples', 'kick')
    pushHistory('samples', 'snare')
    pushHistory('samples', 'kick')
    pushHistory('media', 'intro')
    pushHistory('media', '   ')
    expect(useBrowserStore.getState().history.samples).toEqual(['kick', 'snare'])
    expect(useBrowserStore.getState().history.media).toEqual(['intro'])
    for (let i = 0; i < HISTORY_LIMIT + 4; i++) pushHistory('media', `q${i}`)
    expect(useBrowserStore.getState().history.media).toHaveLength(HISTORY_LIMIT)
    expect(useBrowserStore.getState().history.media[0]).toBe(`q${HISTORY_LIMIT + 3}`)
  })

  it('persists auto-preview and ignores an unknown tab', () => {
    useBrowserStore.getState().setAutoPreview(false)
    expect(JSON.parse(localStorage.getItem('xleth-browser-auto-preview'))).toBe(false)
    useBrowserStore.getState().setTab('nope')
    expect(useBrowserStore.getState().tab).toBe('media')
    useBrowserStore.getState().setTab('samples')
    expect(useBrowserStore.getState().tab).toBe('samples')
  })
})

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
  addEventListener(type, listener) { this.listeners.set(type, listener) }
}

describe('shared preview', () => {
  beforeEach(() => {
    MockAudio.instances = []
    vi.stubGlobal('Audio', MockAudio)
  })
  afterEach(() => {
    stopPreview()
    vi.unstubAllGlobals()
  })

  const region = (id) => ({ id, name: `r${id}`, startTime: 1, endTime: 2 })

  it('plays one thing at a time and tells subscribers which', () => {
    const seen = []
    const off = subscribePreview((id) => seen.push(id))
    expect(startPreview({ region: region(1), sourceFilePath: 'C:\\a.wav', mediaPort: 1234 })).toBe(true)
    expect(startPreview({ region: region(2), sourceFilePath: 'C:\\a.wav', mediaPort: 1234 })).toBe(true)
    expect(getActivePreviewId()).toBe(2)
    expect(MockAudio.instances[0].pause).toHaveBeenCalled()
    stopPreview()
    expect(getActivePreviewId()).toBeNull()
    off()
    expect(seen).toEqual([1, null, 2, null])
  })

  it('toggle stops the region that is already playing, and a missing file plays nothing', () => {
    expect(togglePreview({ region: region(5), sourceFilePath: 'C:\\a.wav', mediaPort: 1 })).toBe(true)
    expect(togglePreview({ region: region(5), sourceFilePath: 'C:\\a.wav', mediaPort: 1 })).toBe(false)
    expect(getActivePreviewId()).toBeNull()
    expect(startPreview({ region: region(6), sourceFilePath: '', mediaPort: 1 })).toBe(false)
    expect(getActivePreviewId()).toBeNull()
  })
})

describe('browser components', () => {
  let container
  let root
  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    localStorage.clear()
    useBrowserStore.setState({ history: { media: [], samples: ['kick', 'snare'] } })
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })
  afterEach(async () => {
    await act(async () => root.unmount())
    document.body.innerHTML = ''
    delete globalThis.IS_REACT_ACT_ENVIRONMENT
  })

  it('a media row is an option with its type named; only audio-only sources drag', async () => {
    await act(async () => {
      root.render(
        <div>
          <SourceCard source={{ id: 1, name: 'clip.mp4', filePath: 'C:\\clip.mp4', duration: 204, hasVideo: true, proxyReady: true }} />
          <SourceCard source={{ id: 2, name: 'loop.wav', filePath: 'C:\\loop.wav', duration: 8, hasVideo: false, proxyReady: false }} selected />
        </div>,
      )
    })
    const [video, audio] = container.querySelectorAll('[role="option"]')
    expect(video.getAttribute('draggable')).toBe('false')
    expect(audio.getAttribute('draggable')).toBe('true')
    expect(audio.getAttribute('aria-selected')).toBe('true')
    expect(video.textContent).toContain('3:24')
    expect(video.querySelector('[aria-label="Video source"]')).not.toBeNull()
    expect(audio.querySelector('[aria-label="Audio source"]')).not.toBeNull()
    expect(audio.querySelector('[aria-label="Transcoding proxy"]')).not.toBeNull()
    expect(video.querySelector('[aria-label="Transcoding proxy"]')).toBeNull()
  })

  it('Arrow keys move focus between rows', async () => {
    await act(async () => {
      root.render(
        <div onKeyDown={moveRowFocus}>
          <div data-browser-row="" tabIndex={0} id="a" />
          <div data-browser-row="" tabIndex={0} id="b" />
        </div>,
      )
    })
    container.querySelector('#a').focus()
    await act(async () => {
      container.querySelector('#a').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
    })
    expect(document.activeElement.id).toBe('b')
  })

  it('an empty focused search offers recent searches and picking one fills the field', async () => {
    const onChange = vi.fn()
    await act(async () => {
      root.render(<SearchField tab="samples" value="" onChange={onChange} placeholder="Search samples" ariaLabel="Search samples" />)
    })
    expect(container.querySelector('[role="listbox"]')).toBeNull()
    await act(async () => { container.querySelector('input').focus() })
    const options = container.querySelectorAll('[role="listbox"] [role="option"] button')
    expect(Array.from(options).map((b) => b.textContent)).toEqual(['kick', 'snare'])
    await act(async () => {
      options[1].dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }))
    })
    expect(onChange).toHaveBeenCalledWith('snare')
  })
})
