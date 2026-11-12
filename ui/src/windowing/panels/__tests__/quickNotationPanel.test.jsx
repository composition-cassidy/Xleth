/**
 * @vitest-environment jsdom
 *
 * Quick Notation (sample mode) contract:
 *  1. Each syllable has its own saved 32nd offset; editing one writes the whole syllable list back
 *     (with `quickOffsetPercent`) once, shortly after the last change.
 *  2. The ghost clips go on the SELECTED track, not one row per syllable.
 *  3. "Play" auditions the notation through the source player with the notation's real timing and
 *     each syllable's own offset; nothing is placed.
 *  4. Inserted clips offset into the syllable by a share of THAT syllable's length.
 */
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../components/PanelFrame', () => ({ PanelFrame: ({ children }) => <div>{children}</div> }))
vi.mock('../../registry/PanelRegistry', () => ({ usePanelRegistry: { getState: () => ({ closePanel: vi.fn() }) } }))
vi.mock('../../../transportStore.js', () => ({ getTransportState: () => ({ bpm: 120 }), subscribe: () => () => {} }))
vi.mock('../../../services/EditCursor.js', () => ({ editCursor: { getPosition: () => 0 } }))

import QuickNotationPanel from '../QuickNotationPanel.tsx'
import useQuickNotationStore from '../../../stores/quickNotationStore.js'
import useGhostClipStore from '../../../stores/ghostClipStore.js'
import useTimelineFocusStore from '../../../stores/timelineFocusStore.js'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const REGION = { id: 7, name: 'Quote', sourceId: 1, startTime: 10, endTime: 12, audioFilePath: '/a/b.wav' }
const SYLLABLES = [
  { startTime: 0, endTime: 1, number: 1, text: 'hel', quickOffsetPercent: 50 },
  { startTime: 1, endTime: 2, number: 2, text: 'lo', quickOffsetPercent: 20 },
]

let host
let root
let xleth

const flush = async () => { await act(async () => { await Promise.resolve() }) }

const type = async (text) => {
  const area = host.querySelector('textarea')
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set
  await act(async () => {
    setter.call(area, text)
    area.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

const buttonByText = (text) => [...host.querySelectorAll('button')].find((b) => b.textContent.trim() === text)

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] })
  xleth = {
    timeline: {
      addClipsBatch: vi.fn(() => Promise.resolve([1])),
      setSyllables: vi.fn(() => Promise.resolve()),
      getSources: vi.fn(() => Promise.resolve([])),
    },
    audio: {
      loadSource: vi.fn(() => Promise.resolve({ success: true })),
      playRegionPreview: vi.fn(() => Promise.resolve({ started: true })),
      pauseSource: vi.fn(() => Promise.resolve()),
    },
  }
  window.xleth = xleth
  useQuickNotationStore.getState().setContext({
    regionId: 7, regionName: 'Quote', syllableCount: 2, regionDurationTicks: 3840, region: REGION, syllables: SYLLABLES,
  })
  useTimelineFocusStore.setState({ focusedTrackId: 42 })
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  await act(async () => { root.render(<QuickNotationPanel />) })
  await flush()
})

afterEach(async () => {
  await act(async () => { root.unmount() })
  host.remove()
  useGhostClipStore.getState().clearGhostClips()
  useQuickNotationStore.getState().clearContext()
  vi.useRealTimers()
})

describe('Quick Notation panel', () => {
  it('lists every syllable with its saved offset', () => {
    const rows = host.querySelectorAll('ul')[0].querySelectorAll('li')
    expect(rows).toHaveLength(2)
    expect(rows[0].textContent).toContain('hel')
    expect(rows[1].textContent).toContain('lo')
  })

  it('puts the ghost clips on the selected track', async () => {
    await type('1_2')
    const { ghostClips, trackId } = useGhostClipStore.getState()
    expect(trackId).toBe(42)
    expect(ghostClips.map((g) => g.syllableIndex)).toEqual([0, 1])
  })

  it('shows no ghosts when no track is selected', async () => {
    useTimelineFocusStore.setState({ focusedTrackId: null })
    await type('1_2')
    expect(useGhostClipStore.getState().ghostClips).toEqual([])
    expect(host.textContent).toContain('Click a track')
  })

  it('auditions the notation at its real timing, each 32nd at its own syllable offset', async () => {
    await type("1_2'")
    await act(async () => { buttonByText('Play').click() })
    // 120 bpm, 960 PPQ: a 16th is 125 ms. "1" at 0, "_" a rest, "2'" at 250 ms.
    await act(async () => { vi.advanceTimersByTime(1) })
    expect(xleth.audio.playRegionPreview).toHaveBeenCalledTimes(1)
    expect(xleth.audio.playRegionPreview.mock.calls[0][0]).toBeCloseTo(10)
    await act(async () => { vi.advanceTimersByTime(260) })
    expect(xleth.audio.playRegionPreview).toHaveBeenCalledTimes(2)
    const [start, end] = xleth.audio.playRegionPreview.mock.calls[1]
    expect(start).toBeCloseTo(10 + 1 + 0.2) // region start + syllable 2 start + 20% of its 1 s
    expect(end - start).toBeCloseTo(0.0625) // a 32nd at 120 bpm
    expect(xleth.timeline.addClipsBatch).not.toHaveBeenCalled()
  })

  it('writes a changed offset back to the syllables once, with the project', async () => {
    const box = host.querySelectorAll('ul')[0].querySelectorAll('li')[1].querySelector('[role="slider"]')
    // Plain arrow = one step; Shift = a coarser one (see the kit's NumberBox). 20% -> 21%.
    await act(async () => {
      box.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }))
    })
    await act(async () => { vi.advanceTimersByTime(500) })
    expect(xleth.timeline.setSyllables).toHaveBeenCalledTimes(1)
    const [regionId, saved] = xleth.timeline.setSyllables.mock.calls[0]
    expect(regionId).toBe(7)
    expect(saved.map((s) => s.quickOffsetPercent)).toEqual([50, 21])
    expect(saved.map((s) => s.text)).toEqual(['hel', 'lo'])
  })

  it('offsets inserted clips by a share of the syllable, not of the whole region', async () => {
    await type("2'")
    await act(async () => { buttonByText('Insert 1 clip').click() })
    const [clips] = xleth.timeline.addClipsBatch.mock.calls[0]
    // syllable 2 is 1 s = 2 beats at 120 bpm = 1920 ticks; 20% of that is 384.
    expect(clips[0]).toMatchObject({ trackId: 42, syllableIndex: 1, regionOffsetTicks: 384, durationTicks: 120 })
  })
})
