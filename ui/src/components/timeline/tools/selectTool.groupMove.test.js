import { describe, expect, it, vi } from 'vitest'
import { createSelectTool } from './selectTool.js'
import { beatsToTicks, TRACK_HEIGHT } from '../../../constants/timeline.js'

// Drives the REAL createSelectTool state machine (the object TimelineCanvas.jsx
// wires up), so these cover the seam the pure groupTransform tests cannot: that
// the overlay and the mouseup commit consume the SAME placement list.
//
// Fixed geometry: pixelsPerBeat=40, scrollOffset=0, contiguous track rows of
// TRACK_HEIGHT px. Row 2 is a Pattern track wedged between Clip tracks.

const PPB = 40
const TRACKS = [
  { id: 10, type: 'Clip' },
  { id: 11, type: 'Clip' },
  { id: 12, type: 'Pattern' },
  { id: 13, type: 'Clip' },
]
const rowY = (i) => i * TRACK_HEIGHT + 2
const xOfBeat = (b) => b * PPB

const mods = (over) => ({ button: 0, shiftKey: false, ctrlKey: false, altKey: false, metaKey: false, ...over })

function makeContainer() {
  return { classList: { add: vi.fn(), remove: vi.fn(), contains: () => false } }
}

/** A canvas 2D stub that records every drawMovePreview rectangle it is handed. */
function makeCtx(rects) {
  return {
    save: vi.fn(), restore: vi.fn(), beginPath: vi.fn(), moveTo: vi.fn(), lineTo: vi.fn(),
    stroke: vi.fn(), fill: vi.fn(), clip: vi.fn(), rect: vi.fn(), closePath: vi.fn(),
    setLineDash: vi.fn(), fillText: vi.fn(), measureText: () => ({ width: 10 }),
    fillRect: vi.fn((x, y, w, h) => rects.push({ x, y, w, h })),
    strokeRect: vi.fn(),
    set fillStyle(v) {}, set strokeStyle(v) {}, set globalAlpha(v) {}, set lineWidth(v) {},
    set font(v) {}, set textAlign(v) {}, set textBaseline(v) {},
  }
}

function makeDeps({ clips = [], blocks = [], selectedClipIds = new Set(), selectedBlockIds = new Set(),
                    snap = '1/16' } = {}) {
  const trackIdToIndex = {}
  TRACKS.forEach((t, i) => { trackIdToIndex[t.id] = i })
  const onMoveClips = vi.fn()
  const onMovePatternBlocks = vi.fn()
  const onDuplicateClips = vi.fn()
  const deps = {
    clipsRef: { current: clips },
    tracksRef: { current: TRACKS },
    regionsRef: { current: {} },
    selectedRef: { current: selectedClipIds },
    pixelsPerBeatRef: { current: PPB },
    scrollOffsetRef: { current: 0 },
    bpmRef: { current: 120 },
    trackIdToIndexRef: { current: trackIdToIndex },
    onMoveClips, onDuplicateClips, onResizeClip: vi.fn(), onResizeClipLeft: vi.fn(),
    onStretchClip: vi.fn(), onStretchClipLeft: vi.fn(),
    setSelectedClipIds: vi.fn(), setStickyNoteLength: vi.fn(),
    onRequestClipContextMenu: vi.fn(),
    redrawOverlay: vi.fn(),
    containerRef: { current: makeContainer() },
    snapGranularityRef: { current: snap },
    patternBlocksRef: { current: blocks },
    patternsRef: { current: {} },
    selectedBlockIdsRef: { current: selectedBlockIds },
    setSelectedBlockIds: vi.fn(),
    onMovePatternBlocks, onDuplicatePatternBlocks: vi.fn(),
    onResizePatternBlock: vi.fn(), onResizePatternBlockLeft: vi.fn(),
    onRequestPatternBlockContextMenu: vi.fn(),
    trackLayoutRef: {
      current: {
        trackIndexAtY: (y) => (y < 0 ? -1 : Math.min(Math.floor(y / TRACK_HEIGHT), TRACKS.length - 1)),
        trackTop: (i) => i * TRACK_HEIGHT,
        automationLaneRowAtY: () => null,
        getAutomationLaneRows: () => [],
      },
    },
    automationClipsRef: { current: [] },
    selectedAutomationClipIdsRef: { current: new Set() },
    setSelectedAutomationClipIds: vi.fn(),
    onMoveAutomationClip: vi.fn(), onResizeAutomationClip: vi.fn(), onResizeAutomationClipLeft: vi.fn(),
    onDuplicateAutomationClips: vi.fn(), onRequestAutomationClipContextMenu: vi.fn(),
    automationEnvelopesByIdRef: { current: new Map() },
    setSelectedAutomationPoint: vi.fn(),
    onAddAutomationPoint: vi.fn(), onRemoveAutomationPoint: vi.fn(), onMoveAutomationPoint: vi.fn(),
    automationPointDragRef: { current: null },
    redrawContent: vi.fn(),
  }
  return { deps, onMoveClips, onMovePatternBlocks }
}

const clipAt = (id, beat, row, durationBeats = 0.4) => ({
  id, trackId: TRACKS[row].id, regionId: 1,
  positionTicks: beatsToTicks(beat), durationTicks: beatsToTicks(durationBeats),
})
const blockAt = (id, beat, row, durationBeats = 0.4) => ({
  id, trackId: TRACKS[row].id, patternId: 1,
  positionTicks: beatsToTicks(beat), durationTicks: beatsToTicks(durationBeats),
})

/** mousedown on `grabBeat`/`row`, drag to `toBeat`/`toRow`, return the tool mid-drag. */
function startDrag(tool, { grabBeat, row, toBeat, toRow, e = mods() }) {
  tool.onMouseDown(xOfBeat(grabBeat), rowY(row), e)
  tool.onMouseMove(xOfBeat(toBeat), rowY(toRow ?? row), e)
  return tool
}

describe('selectTool group move — snap never deforms the selection', () => {
  it('keeps three clips 0.5 beats apart under a Bar snap and a +0.1 beat nudge', () => {
    const clips = [clipAt(1, 0, 0), clipAt(2, 0.5, 0), clipAt(3, 1.0, 0)]
    const { deps, onMoveClips } = makeDeps({
      clips, selectedClipIds: new Set([1, 2, 3]), snap: 'Bar',
    })
    const tool = createSelectTool(deps)

    // Grab clip 1 mid-body (clear of its 6px resize handles) and nudge right
    // by 0.1 beat (4px at ppb=40).
    startDrag(tool, { grabBeat: 0.2, row: 0, toBeat: 0.3 })
    tool.onMouseUp(xOfBeat(0.3), rowY(0), mods())

    // Bar snap swallows the nudge entirely, so nothing moved…
    expect(onMoveClips).not.toHaveBeenCalled()
    // …and, crucially, nothing collapsed onto beat 0 either.
    expect(clips.map((c) => c.positionTicks)).toEqual([0, 480, 960])
  })

  it('translates the whole selection by ONE snapped delta, gaps intact', () => {
    const clips = [clipAt(1, 0, 0), clipAt(2, 0.5, 0), clipAt(3, 1.0, 0)]
    const { deps, onMoveClips } = makeDeps({
      clips, selectedClipIds: new Set([1, 2, 3]), snap: 'Beat',
    })
    const tool = createSelectTool(deps)

    startDrag(tool, { grabBeat: 0.2, row: 0, toBeat: 1.3 })
    tool.onMouseUp(xOfBeat(1.3), rowY(0), mods())

    const moves = onMoveClips.mock.calls[0][0]
    const byId = Object.fromEntries(moves.map((m) => [m.clipId, m.positionTicks]))
    expect(byId[1]).toBe(beatsToTicks(1))  // anchor snapped to the beat line
    expect(byId[2] - byId[1]).toBe(480)    // gaps preserved exactly
    expect(byId[3] - byId[2]).toBe(480)
  })

  it('stops the group at zero instead of stacking its items there', () => {
    const clips = [clipAt(1, 4, 0), clipAt(2, 18, 0), clipAt(3, 32, 0)]
    const { deps, onMoveClips } = makeDeps({ clips, selectedClipIds: new Set([1, 2, 3]) })
    const tool = createSelectTool(deps)

    // Drag the leftmost clip 100 beats to the left.
    startDrag(tool, { grabBeat: 4.2, row: 0, toBeat: -95.8 })
    tool.onMouseUp(xOfBeat(-95.8), rowY(0), mods())

    const byId = Object.fromEntries(onMoveClips.mock.calls[0][0].map((m) => [m.clipId, m.positionTicks]))
    expect(byId[1]).toBe(0)
    expect(byId[3] - byId[1]).toBe(beatsToTicks(28))
    expect(new Set(Object.values(byId)).size).toBe(3) // no two clips share a tick
  })
})

describe('selectTool group move — the preview IS the commit', () => {
  it('refuses a mixed Clip/Pattern selection over a type-mismatched row, drawing and committing nothing', () => {
    const clips = [clipAt(1, 0, 0)]
    const blocks = [blockAt(100, 0, 2)]
    const { deps, onMoveClips, onMovePatternBlocks } = makeDeps({
      clips, blocks, selectedClipIds: new Set([1]), selectedBlockIds: new Set([100]),
    })
    const tool = createSelectTool(deps)

    // Grab the clip on row 0 and drag one row down: the clip would land on row 1
    // (Clip — fine) but the pattern block on row 3 (Clip — invalid).
    startDrag(tool, { grabBeat: 0.2, row: 0, toBeat: 0.7, toRow: 1 })

    const rects = []
    tool.drawOverlay(makeCtx(rects), 800, 400, { scrollOffset: 0, pixelsPerBeat: PPB })
    expect(rects).toEqual([]) // preview drew nothing

    tool.onMouseUp(xOfBeat(0.7), rowY(1), mods())
    expect(onMoveClips).not.toHaveBeenCalled()
    expect(onMovePatternBlocks).not.toHaveBeenCalled()
  })

  it('applies the same mixed selection when both destination rows match', () => {
    const clips = [clipAt(1, 0, 0)]
    const blocks = [blockAt(100, 0, 2)]
    const { deps, onMoveClips, onMovePatternBlocks } = makeDeps({
      clips, blocks, selectedClipIds: new Set([1]), selectedBlockIds: new Set([100]),
    })
    const tool = createSelectTool(deps)

    // Straight horizontal drag: trackDelta 0, so every destination is its own row.
    startDrag(tool, { grabBeat: 0.2, row: 0, toBeat: 0.7 })

    const rects = []
    tool.drawOverlay(makeCtx(rects), 800, 400, { scrollOffset: 0, pixelsPerBeat: PPB })
    expect(rects).toHaveLength(2) // one ghost per item

    tool.onMouseUp(xOfBeat(0.7), rowY(0), mods())
    expect(onMoveClips.mock.calls[0][0]).toEqual([{ clipId: 1, trackId: 10, positionTicks: 480 }])
    expect(onMovePatternBlocks.mock.calls[0][0]).toEqual([{ blockId: 100, trackId: 12, positionTicks: 480 }])
    // The ghosts sat exactly where the commit put the items.
    expect(rects.map((r) => Math.round(r.x))).toEqual([xOfBeat(0.5), xOfBeat(0.5)])
  })

  it('moves a clip between Clip rows, carrying the whole group down one track', () => {
    const clips = [clipAt(1, 0, 0), clipAt(2, 2, 0)]
    const { deps, onMoveClips } = makeDeps({ clips, selectedClipIds: new Set([1, 2]) })
    const tool = createSelectTool(deps)

    startDrag(tool, { grabBeat: 0.2, row: 0, toBeat: 0.2, toRow: 1 })
    tool.onMouseUp(xOfBeat(0.2), rowY(1), mods())

    const moves = onMoveClips.mock.calls[0][0]
    expect(moves.map((m) => m.trackId)).toEqual([11, 11])
    expect(moves.map((m) => m.positionTicks)).toEqual([0, beatsToTicks(2)])
  })

  it('does not drift when a free (Alt) drag is repeated frame after frame', () => {
    const clips = [clipAt(1, 1, 0), clipAt(2, 1.3333, 0)]
    const gapBefore = clips[1].positionTicks - clips[0].positionTicks
    const { deps, onMoveClips } = makeDeps({ clips, selectedClipIds: new Set([1, 2]) })
    const tool = createSelectTool(deps)
    const alt = mods({ altKey: true })

    tool.onMouseDown(xOfBeat(1.2), rowY(0), alt)
    for (let px = 1; px <= 50; px++) tool.onMouseMove(xOfBeat(1.2) + px, rowY(0), alt)
    tool.onMouseUp(xOfBeat(1.2) + 50, rowY(0), alt)

    const byId = Object.fromEntries(onMoveClips.mock.calls[0][0].map((m) => [m.clipId, m.positionTicks]))
    expect(byId[2] - byId[1]).toBe(gapBefore)
    expect(Number.isInteger(byId[1])).toBe(true)
  })
})
