import { describe, expect, it, vi } from 'vitest'
import { createSelectTool } from './selectTool.js'
import { PPQ, beatsToTicks } from '../../../constants/timeline.js'

// Regression test for the trim/left-trim scheduling fix: a clip resize drag
// must preview locally (no IPC) and commit onResizeClip/onResizeClipLeft
// exactly ONCE, on mouseup — not once per mousemove frame. Before the fix,
// selectTool.js called onResizeClip from inside onMouseMove, so a 60-frame
// drag fired 60 engine round trips (and, upstream, 60 undo entries).

const PPB = 40 // pixelsPerBeat

function makeContainer() {
  const classes = new Set()
  return {
    classList: {
      add: vi.fn((c) => classes.add(c)),
      remove: vi.fn((...cs) => cs.forEach((c) => classes.delete(c))),
      contains: (c) => classes.has(c),
    },
  }
}

function makeClip(over) {
  // 4 beats long, starting at beat 0 (positionTicks 0, durationTicks 4*PPQ).
  return { id: 'c1', trackId: 't1', regionId: 'r1', positionTicks: 0, durationTicks: 4 * PPQ, regionOffsetTicks: 0, ...over }
}

function makeDeps({ clip = makeClip(), selected = true } = {}) {
  const container = makeContainer()
  const onResizeClip = vi.fn()
  const onResizeClipLeft = vi.fn()
  const redrawOverlay = vi.fn()
  const setStickyNoteLength = vi.fn()
  const selectedRef = { current: selected ? new Set([clip.id]) : new Set() }
  const deps = {
    clipsRef: { current: [clip] },
    tracksRef: { current: [{ id: 't1', type: 'Sample' }] },
    regionsRef: { current: { r1: { label: 'kick' } } },
    selectedRef,
    pixelsPerBeatRef: { current: PPB },
    scrollOffsetRef: { current: 0 },
    bpmRef: { current: 120 },
    trackIdToIndexRef: { current: { t1: 0 } },
    onMoveClips: vi.fn(), onDuplicateClips: vi.fn(), onResizeClip, onResizeClipLeft,
    onStretchClip: vi.fn(), onStretchClipLeft: vi.fn(),
    setSelectedClipIds: vi.fn(), setStickyNoteLength,
    onRequestClipContextMenu: vi.fn(),
    redrawOverlay,
    containerRef: { current: container },
    snapGranularityRef: { current: null },
    patternBlocksRef: { current: [] }, patternsRef: { current: {} }, selectedBlockIdsRef: { current: new Set() },
    setSelectedBlockIds: vi.fn(),
    onMovePatternBlocks: vi.fn(), onDuplicatePatternBlocks: vi.fn(), onResizePatternBlock: vi.fn(), onResizePatternBlockLeft: vi.fn(),
    onRequestPatternBlockContextMenu: vi.fn(),
    trackLayoutRef: {
      current: {
        trackIndexAtY: () => 0,
        trackTop: () => 0,
      },
    },
    automationClipsRef: { current: [] },
    selectedAutomationClipIdsRef: { current: new Set() },
    setSelectedAutomationClipIds: vi.fn(),
    onMoveAutomationClip: vi.fn(),
    onResizeAutomationClip: vi.fn(),
    onResizeAutomationClipLeft: vi.fn(),
    onDuplicateAutomationClips: vi.fn(),
    onRequestAutomationClipContextMenu: vi.fn(),
    automationEnvelopesByIdRef: { current: new Map() },
    setSelectedAutomationPoint: vi.fn(),
    onAddAutomationPoint: vi.fn(), onRemoveAutomationPoint: vi.fn(), onMoveAutomationPoint: vi.fn(),
    automationPointDragRef: { current: null },
    redrawContent: vi.fn(),
  }
  return { deps, clip, onResizeClip, onResizeClipLeft, redrawOverlay, setStickyNoteLength }
}

const mods = (over) => ({ button: 0, shiftKey: false, ctrlKey: false, altKey: false, metaKey: false, ...over })

describe('createSelectTool — clip trim (right edge) scheduling', () => {
  it('fires zero onResizeClip calls during a 60-frame drag and exactly one on mouseup', () => {
    const { deps, onResizeClip } = makeDeps()
    const tool = createSelectTool(deps)
    const e = mods()

    // Clip spans beats [0,4) at PPB=40 -> pixels [0,160). Right edge is at
    // x=160, but the hit test is half-open ([clipBeat, clipEnd)) so x=160
    // itself falls just outside the clip — grab a pixel inside, within
    // HANDLE_W (6px) of the edge.
    tool.onMouseDown(158, 0, e)

    // 60-frame drag, each frame nudging the pointer 1px further right.
    for (let i = 1; i <= 60; i++) {
      tool.onMouseMove(158 + i, 0, e)
    }
    expect(onResizeClip).not.toHaveBeenCalled()

    tool.onMouseUp(158 + 60, 0, e)
    expect(onResizeClip).toHaveBeenCalledTimes(1)
  })

  it('fires zero onResizeClipLeft calls during a 60-frame left-trim drag and exactly one on mouseup', () => {
    const { deps, onResizeClipLeft } = makeDeps()
    const tool = createSelectTool(deps)
    const e = mods()

    // Left edge of the clip is at x=0.
    tool.onMouseDown(0, 0, e)

    for (let i = 1; i <= 60; i++) {
      tool.onMouseMove(i, 0, e)
    }
    expect(onResizeClipLeft).not.toHaveBeenCalled()

    tool.onMouseUp(60, 0, e)
    expect(onResizeClipLeft).toHaveBeenCalledTimes(1)
  })
})

// A reversed clip plays its source window backwards, so its right edge sits on
// the START of the window and its left edge on the END (clipTrim.js). The
// commit has to move regionOffset for exactly the edge that sits on the start.
describe('createSelectTool — which end of the source a trim takes from', () => {
  function drag(tool, fromX, toX) {
    const e = mods()
    tool.onMouseDown(fromX, 0, e)
    const step = toX > fromX ? 1 : -1
    for (let x = fromX + step; x !== toX + step; x += step) tool.onMouseMove(x, 0, e)
    tool.onMouseUp(toX, 0, e)
  }

  it('forward clip, right edge: the duration alone', () => {
    const { deps, onResizeClip } = makeDeps()
    drag(createSelectTool(deps), 158, 2 * PPB)            // 4 beats -> 2 beats
    expect(onResizeClip).toHaveBeenCalledTimes(1)
    expect(onResizeClip.mock.calls[0]).toEqual(['c1', beatsToTicks(2)])
  })

  it('reversed clip, right edge: the region offset advances by what was cut', () => {
    const { deps, onResizeClip } = makeDeps({ clip: makeClip({ reversed: true }) })
    drag(createSelectTool(deps), 158, 2 * PPB)
    expect(onResizeClip).toHaveBeenCalledTimes(1)
    expect(onResizeClip.mock.calls[0]).toEqual(['c1', beatsToTicks(2), beatsToTicks(2)])
  })

  it('reversed and stretched, right edge: the offset moves in SOURCE ticks', () => {
    const { deps, onResizeClip } = makeDeps({ clip: makeClip({ reversed: true, stretchRatio: 2 }) })
    drag(createSelectTool(deps), 158, 2 * PPB)
    expect(onResizeClip.mock.calls[0]).toEqual(['c1', beatsToTicks(2), beatsToTicks(1)])
  })

  it('forward clip, left edge: the region offset advances with the edge', () => {
    const { deps, onResizeClipLeft } = makeDeps()
    drag(createSelectTool(deps), 0, PPB)                  // start moves to beat 1
    expect(onResizeClipLeft.mock.calls[0]).toEqual(['c1', beatsToTicks(1), beatsToTicks(3), beatsToTicks(1)])
  })

  it('reversed clip, left edge: the region offset stays where it is', () => {
    const { deps, onResizeClipLeft } = makeDeps({ clip: makeClip({ reversed: true }) })
    drag(createSelectTool(deps), 0, PPB)
    expect(onResizeClipLeft.mock.calls[0]).toEqual(['c1', beatsToTicks(1), beatsToTicks(3), 0])
  })
})
