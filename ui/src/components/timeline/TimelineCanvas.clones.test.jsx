// @vitest-environment jsdom
//
// Clone rows on the arrangement canvas (docs/XLETH_CLONE_SPEC.md "Timeline and Motion
// view"): a click on a ghost clip in a Clone's lane selects that note of the SOURCE
// pattern in the shared note selection (the piano roll mirrors it) and focuses the
// Clone; no tool acts there; hovering an overflow note says how to fix it.
import React, { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRoot } from 'react-dom/client'
import TimelineCanvas from './TimelineCanvas.jsx'
import { buildTrackLayout } from './timelineRowLayout.js'
import { buildReelModel } from './reelLaneModel.js'
import { REEL_OVERFLOW_HINT } from './reelLaneDrawing.js'
import useNoteSelectionStore from '../../stores/useNoteSelectionStore.js'
import { HINT_REFRESH_EVENT } from '../../ui-kit/hint'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const n = (id, s, e, pitch) => ({ id, positionTicks: s, durationTicks: e - s, pitch, velocity: 1 })
const tracks = [
  { id: 1, name: 'Lead', type: 'Pattern', order: 0, cloneOf: -1, muted: false },
  { id: 2, name: 'Lead · Clone 1', type: 'Pattern', order: 1, cloneOf: 1, clone: { kind: 'Voice' }, muted: false },
]
const patterns = { 7: { id: 7, regionId: 100, lengthTicks: 3840, notes: [n(1, 0, 960, 67), n(2, 0, 960, 64), n(3, 0, 960, 60)] } }
const patternBlocks = [{ id: 1, trackId: 1, patternId: 7, positionTicks: 0, durationTicks: 3840, offsetTicks: 0, loopEnabled: false }]
const regions = { 100: { id: 100, sourceId: 10, startTime: 0 } }
const sources = { 10: { id: 10, hasVideo: true, filePath: 'a.mp4', duration: 4 } }

let container
let root
let onFocusTrack
let onCreatePatternBlock
let layout

function mount() {
  const reel = buildReelModel({ tracks, patternBlocks, patterns, regions, sources })
  const reelLanes = {}
  for (const [id, lane] of reel.byTrack) reelLanes[id] = { collapsed: false, subRows: lane.subRows }
  layout = buildTrackLayout({ tracks, reelLanes })
  act(() => {
    root.render(
      <TimelineCanvas
        trackCount={tracks.length}
        pixelsPerBeatRef={{ current: 40 }}
        scrollOffsetRef={{ current: 0 }}
        playheadBeatRef={{ current: 0 }}
        clips={[]} regions={regions} tracks={tracks} selectedClipIds={new Set()}
        dropPreviewRef={{ current: null }}
        patternBlocks={patternBlocks} patterns={patterns} selectedBlockIds={new Set()} setSelectedBlockIds={vi.fn()}
        currentPatternIdByTrack={{}}
        activeTool="pencil"
        snapGranularity="Beat"
        setSelectedClipIds={vi.fn()}
        onFocusTrack={onFocusTrack}
        onCreatePatternBlock={onCreatePatternBlock}
        timelineDisplaySettings={{}}
        trackLayout={layout}
        reel={reel}
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
  onFocusTrack = vi.fn()
  onCreatePatternBlock = vi.fn()
  useNoteSelectionStore.getState().clear()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  useNoteSelectionStore.getState().clear()
  vi.restoreAllMocks()
})

const press = (el, x, y) => act(() => {
  el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0, clientX: x, clientY: y }))
  window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 0, clientX: x, clientY: y }))
})

describe('TimelineCanvas Clone rows', () => {
  it('a click on a Clone ghost clip selects the source pattern note and focuses the Clone', () => {
    const el = mount()
    const row = layout.cloneRows[0]
    press(el, 10, row.y + row.height / 2)
    expect(onFocusTrack).toHaveBeenCalledWith(2)
    const sel = useNoteSelectionStore.getState().byPattern
    expect([...sel[7]]).toEqual([2])
  })

  it('the pencil tool draws nothing on a Clone row (it is read-only)', () => {
    const el = mount()
    const row = layout.cloneRows[0]
    press(el, 600, row.y + 4)
    // Empty lane space: the click only clears the note selection; no block is drawn.
    expect(useNoteSelectionStore.getState().byPattern).toEqual({})
    expect(onCreatePatternBlock).not.toHaveBeenCalled()
    expect(onFocusTrack).toHaveBeenCalledWith(2)
  })

  it('hovering an overflow note in the source lane puts the fix in the hint bar', () => {
    const el = mount()
    const seen = []
    const onHint = (e) => seen.push(e.detail)
    window.addEventListener(HINT_REFRESH_EVENT, onHint)
    const src = layout.getReelRows()[0]
    act(() => {
      el.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: 10, clientY: src.y + src.height - 4 }))
    })
    act(() => {
      el.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: 11, clientY: src.y + src.height - 4 }))
    })
    act(() => { el.dispatchEvent(new MouseEvent('mouseout', { bubbles: true, relatedTarget: document.body })) })
    window.removeEventListener(HINT_REFRESH_EVENT, onHint)
    // Shown once (not per move), then handed back on leave.
    expect(seen).toEqual([expect.objectContaining({ hint: REEL_OVERFLOW_HINT }), null])
  })
})
