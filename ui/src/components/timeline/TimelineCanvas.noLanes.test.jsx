// @vitest-environment jsdom
//
// docs/XLETH_MOTION_VIEW_DESIGN.md R17: the Edit view's canvas no longer draws, hit-tests
// or opens a menu for Roam / Sweep key lanes. A caller that still passes the old `roam` /
// `sweep` props and lane inputs gets the plain arrangement: the band under a track is the
// next track, a click there never grabs a key, and a right-click there opens no key menu.
import React, { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRoot } from 'react-dom/client'
import TimelineCanvas from './TimelineCanvas.jsx'
import { buildTrackLayout } from './timelineRowLayout.js'
import { TRACK_HEIGHT } from '../../constants/timeline.js'
import useRoamKeysStore from '../../stores/useRoamKeysStore.js'
import useSweepKeysStore from '../../stores/useSweepKeysStore.js'
import useInspectorStore from '../../stores/useInspectorStore.js'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const K = (channel, pos, value) => ({ channel, anchor: 'Origin', pos, value, interp: 'Linear' })
const tracks = [
  { id: 1, name: 'Lead', type: 'Pattern', muted: false },
  { id: 2, name: 'Drums', type: 'Clip', muted: false },
]

let container
let root
let roam
let sweep
let onFocusTrack

function mount() {
  const trackLayout = buildTrackLayout({ tracks, roamLanes: { 1: true }, sweepLanes: { 1: true } })
  act(() => {
    root.render(
      <TimelineCanvas
        trackCount={tracks.length}
        pixelsPerBeatRef={{ current: 40 }}
        scrollOffsetRef={{ current: 0 }}
        playheadBeatRef={{ current: 0 }}
        clips={[]} regions={{}} tracks={tracks} selectedClipIds={new Set()}
        dropPreviewRef={{ current: null }}
        patternBlocks={[]} patterns={{}} selectedBlockIds={new Set()} setSelectedBlockIds={vi.fn()}
        currentPatternIdByTrack={{}}
        activeTool="select"
        snapGranularity="Beat"
        setSelectedClipIds={vi.fn()}
        onFocusTrack={onFocusTrack}
        timelineDisplaySettings={{}}
        trackLayout={trackLayout}
        // What an old TimelineView passed for open lanes: ignored now.
        roam={roam}
        sweep={sweep}
        automationClips={[]}
        selectedAutomationClipIds={new Set()}
        setSelectedAutomationClipIds={vi.fn()}
      />,
    )
  })
  return container.querySelector('.timeline-canvas-container')
}

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)
  roam = {
    byTrack: new Map([[1, { base: { offsetX: 0 }, keys: [K('offsetX', 0, 0), K('offsetX', 3840, 1)] }]]),
    commitKeys: vi.fn(),
  }
  sweep = {
    byTrack: new Map([[1, { base: {}, keys: [K('zoom', 0, 1), K('zoom', 1920, 2)] }]]),
    commitKeys: vi.fn(),
  }
  onFocusTrack = vi.fn()
  useRoamKeysStore.setState({ laneOpen: new Set([1]), selected: null, multi: [], draft: null })
  useSweepKeysStore.setState({ laneOpen: new Set([1]), selected: null, multi: [], draft: null })
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  useRoamKeysStore.setState({ laneOpen: new Set(), selected: null, multi: [], draft: null })
  useSweepKeysStore.setState({ laneOpen: new Set(), selected: null, multi: [], draft: null })
  vi.restoreAllMocks()
})

describe('TimelineCanvas without key lanes (R17)', () => {
  it('the content is exactly the tracks tall: no lane band is reserved', () => {
    const el = mount()
    expect(el.style.minHeight).toBe(`${Math.max(2 * TRACK_HEIGHT, 200)}px`)
  })

  it('a click where the Roam / Sweep lane used to sit grabs no key and commits nothing', () => {
    const requestTrackSelection = vi.spyOn(useInspectorStore.getState(), 'requestTrackSelection')
    const el = mount()
    // jsdom has no layout: the container's rect is at 0,0, so client = local px.
    // tick 0 sits at x 0; the old lane's key at tick 0 / 3840 is where a lane hit would be.
    for (const y of [TRACK_HEIGHT + 4, TRACK_HEIGHT + 30]) {
      act(() => {
        el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0, clientX: 1, clientY: y }))
        window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 0, clientX: 1, clientY: y }))
      })
    }
    expect(roam.commitKeys).not.toHaveBeenCalled()
    expect(sweep.commitKeys).not.toHaveBeenCalled()
    expect(useRoamKeysStore.getState().selected).toBeNull()
    expect(useRoamKeysStore.getState().draft).toBeNull()
    expect(useSweepKeysStore.getState().selected).toBeNull()
    expect(useSweepKeysStore.getState().draft).toBeNull()
    expect(requestTrackSelection).not.toHaveBeenCalled()
  })

  it('a right-click there opens no key menu; it focuses the track under the pointer (the next track)', () => {
    const el = mount()
    act(() => {
      el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2, clientX: 1, clientY: TRACK_HEIGHT + 4 }))
    })
    const items = [...document.querySelectorAll('[role="menuitem"], [role="menuitemcheckbox"]')].map((n) => n.textContent.trim())
    expect(items).not.toContain('Hold')
    expect(items.some((t) => /^Delete( \d+)? keys?$/.test(t))).toBe(false)
    expect(onFocusTrack).toHaveBeenCalledWith(2)
  })

  it('a store change of the old lane state is not a canvas concern any more (no subscription throws)', () => {
    mount()
    expect(() => act(() => {
      useRoamKeysStore.setState({ draft: { trackId: 1, keys: [] }, selected: { trackId: 1, channel: 'offsetX', pos: 0 } })
      useSweepKeysStore.setState({ draft: { trackId: 1, keys: [] } })
    })).not.toThrow()
  })
})
