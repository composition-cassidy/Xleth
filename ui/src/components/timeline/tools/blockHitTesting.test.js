// The four timeline tools resolve "what is under the pointer" through the same
// geometry the canvas paints with (blockGeometry.js). These drive the real tool
// objects to pin the behaviours that depended on each tool's own copy of that
// arithmetic agreeing with the draw path, and did not.
import { describe, expect, it, vi } from 'vitest'
import { createSelectTool } from './selectTool.js'
import { createDeleteTool } from './deleteTool.js'
import { createSplitTool } from './splitTool.js'
import { createPencilTool } from './pencilTool.js'
import { TRACK_HEIGHT, beatsToTicks } from '../../../constants/timeline.js'
import { blockRect } from '../blockGeometry.js'

const PPB = 40
const TRACKS = [
  { id: 't1', type: 'Clip' },
  { id: 't2', type: 'Pattern' },
]
const rowY = (i) => i * TRACK_HEIGHT + 10

const mods = (over) => ({
  button: 0, shiftKey: false, ctrlKey: false, altKey: false, metaKey: false,
  preventDefault: vi.fn(), ...over,
})

const clip = (id, startBeat, lengthBeats, over = {}) => ({
  id, trackId: 't1', regionId: 'r1',
  positionTicks: beatsToTicks(startBeat), durationTicks: beatsToTicks(lengthBeats),
  regionOffsetTicks: 0, ...over,
})
const block = (id, startBeat, lengthBeats, over = {}) => ({
  id, trackId: 't2', patternId: 1,
  positionTicks: beatsToTicks(startBeat), durationTicks: beatsToTicks(lengthBeats),
  offsetTicks: 0, ...over,
})

function makeDeps({ clips = [], blocks = [], selected = [], snap = '1/16', ...over } = {}) {
  const deps = {
    clipsRef: { current: clips },
    tracksRef: { current: TRACKS },
    // A long region, so resize clamps never get in the way.
    regionsRef: { current: { r1: { id: 'r1', label: 'kick', name: 'Kick', startTime: 0, endTime: 600 } } },
    selectedRef: { current: new Set(selected) },
    pixelsPerBeatRef: { current: PPB },
    scrollOffsetRef: { current: 0 },
    bpmRef: { current: 120 },
    trackIdToIndexRef: { current: { t1: 0, t2: 1 } },
    trackColorOf: (trackId) => ({ t1: '#336699', t2: '#996633' }[trackId]),
    snapGranularityRef: { current: snap },
    activeSampleIdRef: { current: 'r1' },
    stickyNoteLengthRef: { current: beatsToTicks(4) },
    pencilTemplateRef: { current: null },
    patternBlocksRef: { current: blocks },
    patternsRef: { current: { 1: { id: 1, name: 'Melody', regionId: 'r1', lengthTicks: beatsToTicks(8), notes: [] } } },
    selectedBlockIdsRef: { current: new Set() },
    currentPatternIdByTrackRef: { current: { t2: 1 } },
    trackLayoutRef: { current: null },
    containerRef: { current: { classList: { add: vi.fn(), remove: vi.fn(), contains: () => false } } },
    automationClipsRef: { current: [] },
    selectedAutomationClipIdsRef: { current: new Set() },
    automationEnvelopesByIdRef: { current: new Map() },
    automationPointDragRef: { current: null },
    onCreateClip: vi.fn(), onDeleteClip: vi.fn(), onDeleteSweep: vi.fn(), onMoveClips: vi.fn(), onDuplicateClips: vi.fn(),
    onResizeClip: vi.fn(), onResizeClipLeft: vi.fn(), onStretchClip: vi.fn(), onStretchClipLeft: vi.fn(),
    onSplitClip: vi.fn(), onRequestClipContextMenu: vi.fn(),
    setSelectedClipIds: vi.fn(), setStickyNoteLength: vi.fn(),
    setSelectedBlockIds: vi.fn(),
    onCreatePatternBlock: vi.fn(), onMovePatternBlocks: vi.fn(), onDuplicatePatternBlocks: vi.fn(),
    onResizePatternBlock: vi.fn(), onResizePatternBlockLeft: vi.fn(),
    onDeletePatternBlock: vi.fn(), onSplitPatternBlock: vi.fn(),
    onRequestPatternBlockContextMenu: vi.fn(),
    setSelectedAutomationClipIds: vi.fn(), setSelectedAutomationPoint: vi.fn(),
    onMoveAutomationClip: vi.fn(), onResizeAutomationClip: vi.fn(), onResizeAutomationClipLeft: vi.fn(),
    onDuplicateAutomationClips: vi.fn(), onRequestAutomationClipContextMenu: vi.fn(),
    onAddAutomationPoint: vi.fn(), onRemoveAutomationPoint: vi.fn(), onMoveAutomationPoint: vi.fn(),
    redrawOverlay: vi.fn(), redrawContent: vi.fn(),
    ...over,
  }
  return deps
}

/** A 2D context stub that records fillRect rectangles and their fill colour. */
function makeCtx() {
  const rects = []
  const state = {}
  const ctx = new Proxy({}, {
    get(_t, prop) {
      if (prop in state) return state[prop]
      if (prop === 'fillRect') return (x, y, w, h) => rects.push({ x, y, w, h, fillStyle: state.fillStyle })
      if (prop === 'measureText') return () => ({ width: 10 })
      return () => {}
    },
    set(_t, prop, value) { state[prop] = value; return true },
  })
  return { ctx, rects }
}

describe('select tool', () => {
  it('selects the clip painted on top where two overlap', () => {
    // Painted in array order: `over` covers `under` between beats 2 and 4.
    const under = clip('under', 0, 4)
    const over = clip('over', 2, 4)
    const deps = makeDeps({ clips: [under, over] })
    const tool = createSelectTool(deps)
    tool.onMouseDown(3 * PPB, rowY(0), mods())
    tool.onMouseUp(3 * PPB, rowY(0), mods())
    expect(deps.setSelectedClipIds).toHaveBeenLastCalledWith(new Set(['over']))
  })

  it('moves a narrow selected clip from its middle instead of resizing it', () => {
    // 0.2 beat = 8px wide. With a flat 6px edge zone on each side the whole
    // clip was a resize handle and it could not be dragged at all.
    const narrow = clip('n', 2, 0.2)
    const deps = makeDeps({ clips: [narrow], selected: ['n'] })
    const tool = createSelectTool(deps)
    const r = blockRect(narrow, 0, 0, PPB)
    const x = r.x + r.w / 2
    tool.onMouseDown(x, rowY(0), mods())
    tool.onMouseMove(x + 2 * PPB, rowY(0), mods())
    tool.onMouseUp(x + 2 * PPB, rowY(0), mods())
    expect(deps.onMoveClips).toHaveBeenCalledTimes(1)
    expect(deps.onResizeClip).not.toHaveBeenCalled()
    expect(deps.onResizeClipLeft).not.toHaveBeenCalled()
  })

  it('still resizes that narrow clip from its outermost pixels', () => {
    const narrow = clip('n', 2, 0.2)
    const r = blockRect(narrow, 0, 0, PPB)

    const right = makeDeps({ clips: [narrow], selected: ['n'] })
    const rightTool = createSelectTool(right)
    rightTool.onMouseDown(r.x + r.w - 0.5, rowY(0), mods())
    rightTool.onMouseMove(r.x + r.w + 2 * PPB, rowY(0), mods())
    rightTool.onMouseUp(r.x + r.w + 2 * PPB, rowY(0), mods())
    expect(right.onResizeClip).toHaveBeenCalledTimes(1)
    expect(right.onMoveClips).not.toHaveBeenCalled()

    // Two beats of source before the clip start, so the left edge has room to move.
    const left = makeDeps({ clips: [clip('n', 2, 0.2, { regionOffsetTicks: beatsToTicks(2) })], selected: ['n'] })
    const leftTool = createSelectTool(left)
    leftTool.onMouseDown(r.x + 0.5, rowY(0), mods())
    leftTool.onMouseMove(r.x - PPB, rowY(0), mods())
    leftTool.onMouseUp(r.x - PPB, rowY(0), mods())
    expect(left.onResizeClipLeft).toHaveBeenCalledTimes(1)
    expect(left.onMoveClips).not.toHaveBeenCalled()
  })

  it('hits a tiny clip across the whole width it is painted at', () => {
    // 2 ticks long: far less than a pixel of time, painted 4px wide.
    const tiny = clip('tiny', 5, 0, { durationTicks: 2 })
    const deps = makeDeps({ clips: [tiny] })
    const tool = createSelectTool(deps)
    const r = blockRect(tiny, 0, 0, PPB)
    tool.onMouseDown(r.x + r.w - 0.5, rowY(0), mods())
    tool.onMouseUp(r.x + r.w - 0.5, rowY(0), mods())
    expect(deps.setSelectedClipIds).toHaveBeenLastCalledWith(new Set(['tiny']))
  })

  it('rubber-bands the blocks whose painted rectangles the band touches', () => {
    const a = clip('a', 0, 1)
    const b = clip('b', 4, 1)
    const pat = block('p', 2, 2)
    const deps = makeDeps({ clips: [a, b], blocks: [pat] })
    const tool = createSelectTool(deps)
    // Start on empty lane after clip a, drag down across the pattern row.
    tool.onMouseDown(1.5 * PPB, rowY(0), mods())
    tool.onMouseMove(3 * PPB, rowY(1), mods())
    tool.onMouseUp(3 * PPB, rowY(1), mods())
    expect(deps.setSelectedClipIds).toHaveBeenLastCalledWith(new Set())
    expect(deps.setSelectedBlockIds).toHaveBeenLastCalledWith(new Set(['p']))
  })

  it('previews a drag in the colour the clip is painted in', () => {
    const c = clip('c', 0, 2)
    const deps = makeDeps({ clips: [c] })
    const tool = createSelectTool(deps)
    tool.onMouseDown(PPB, rowY(0), mods())
    tool.onMouseMove(PPB + 2 * PPB, rowY(0), mods())
    const { ctx, rects } = makeCtx()
    tool.drawOverlay(ctx, 800, 200, { scrollOffset: 0, pixelsPerBeat: PPB })
    expect(rects).toHaveLength(1)
    expect(rects[0].fillStyle).toBe('rgba(51,102,153,0.3)') // track t1's #336699
    tool.onMouseUp(PPB + 2 * PPB, rowY(0), mods())
  })
})

describe('delete tool', () => {
  it('click-deletes the clip painted on top', () => {
    const deps = makeDeps({ clips: [clip('under', 0, 4), clip('over', 2, 4)] })
    const tool = createDeleteTool(deps)
    tool.onMouseDown(3 * PPB, rowY(0), mods())
    expect(deps.onDeleteClip).toHaveBeenCalledWith('over')
    expect(deps.onDeleteClip).toHaveBeenCalledTimes(1)
  })

  it('sweep-deletes what the sweep rectangle touches, clips and pattern blocks alike', async () => {
    const deps = makeDeps({
      clips: [clip('a', 0, 1), clip('b', 2, 1), clip('far', 10, 1)],
      blocks: [block('p', 1, 2), block('q', 12, 2)],
    })
    const tool = createDeleteTool(deps)
    tool.onMouseDown(1.5 * PPB, rowY(0), mods()) // empty lane between a and b
    tool.onMouseMove(2.5 * PPB, rowY(1), mods())
    await tool.onMouseUp(2.5 * PPB, rowY(1), mods())
    expect(deps.onDeleteSweep).toHaveBeenCalledTimes(1)
    expect(deps.onDeleteSweep).toHaveBeenCalledWith(['b'], ['p'])
    expect(deps.onDeleteClip).not.toHaveBeenCalled()
  })

  it('sweeping N clips issues exactly one batch call, at mouseup', async () => {
    const clips = Array.from({ length: 30 }, (_, i) => clip(`c${i}`, i * 2, 1))
    const deps = makeDeps({ clips })
    const tool = createDeleteTool(deps)
    tool.onMouseDown(-5, rowY(0), mods()) // empty space left of the first clip
    tool.onMouseMove(70 * PPB, rowY(0), mods())
    expect(deps.onDeleteSweep).not.toHaveBeenCalled() // no commit during the drag
    await tool.onMouseUp(70 * PPB, rowY(0), mods())
    expect(deps.onDeleteSweep).toHaveBeenCalledTimes(1)
    expect(deps.onDeleteSweep.mock.calls[0][0]).toHaveLength(30)
    expect(deps.onDeleteClip).not.toHaveBeenCalled()
  })

  it('works without the shared track index (builds its own)', () => {
    const deps = makeDeps({ clips: [clip('a', 0, 2)], trackIdToIndexRef: undefined })
    const tool = createDeleteTool(deps)
    tool.onMouseDown(PPB, rowY(0), mods())
    expect(deps.onDeleteClip).toHaveBeenCalledWith('a')
  })
})

describe('split tool', () => {
  it('splits the clicked clip at the snapped position', () => {
    const deps = makeDeps({ clips: [clip('a', 0, 4)] })
    const tool = createSplitTool(deps)
    tool.onMouseDown(1.02 * PPB, rowY(0), mods())
    expect(deps.onSplitClip).toHaveBeenCalledWith('a', beatsToTicks(1), beatsToTicks(3))
  })

  it('never cuts the neighbour of the clip that was clicked', () => {
    // Bar snap: a click at beat 3.4 inside `a` [3, 3.5) snaps to beat 4, which
    // lies inside `b` [3.5, 8). The cut used to land on `b`.
    const deps = makeDeps({ clips: [clip('a', 3, 0.5), clip('b', 3.5, 4.5)], snap: 'Bar' })
    const tool = createSplitTool(deps)
    tool.onMouseDown(3.4 * PPB, rowY(0), mods())
    expect(deps.onSplitClip).not.toHaveBeenCalled()
  })

  it('from empty lane, cuts the clip the snapped position falls in', () => {
    const deps = makeDeps({ clips: [clip('b', 3.5, 4.5)], snap: 'Bar' })
    const tool = createSplitTool(deps)
    tool.onMouseDown(3.4 * PPB, rowY(0), mods()) // empty: b starts at 3.5
    expect(deps.onSplitClip).toHaveBeenCalledWith('b', beatsToTicks(0.5), beatsToTicks(4))
  })

  it('splits pattern blocks the same way', () => {
    const deps = makeDeps({ blocks: [block('p', 0, 8)] })
    const tool = createSplitTool(deps)
    tool.onMouseDown(2 * PPB, rowY(1), mods())
    expect(deps.onSplitPatternBlock).toHaveBeenCalledWith('p', beatsToTicks(2))
  })
})

describe('pencil tool ghost', () => {
  const ghostRect = (tool) => {
    const { ctx, rects } = makeCtx()
    tool.drawOverlay(ctx, 800, 200, { scrollOffset: 0, pixelsPerBeat: PPB })
    return rects[0] ?? null
  }

  it('previews a clip where the click will actually put it, past what it would overlap', () => {
    // Sticky length is 4 beats. Proposed at beat 3 it would run into the clip
    // at [4, 6), so the click slides it to beat 6; the ghost must show that.
    const deps = makeDeps({ clips: [clip('x', 4, 2)] })
    const tool = createPencilTool(deps)
    tool.onMouseMove(3 * PPB, rowY(0), mods())
    expect(ghostRect(tool)).toMatchObject({ x: 6 * PPB, w: 4 * PPB })

    tool.onMouseDown(3 * PPB, rowY(0), mods())
    expect(deps.onCreateClip).toHaveBeenCalledWith('t1', 'r1', beatsToTicks(6), beatsToTicks(4))
  })

  it('previews a pattern block, at the pattern length, on a pattern track', () => {
    const deps = makeDeps()
    const tool = createPencilTool(deps)
    tool.onMouseMove(2 * PPB, rowY(1), mods())
    // The pattern is 8 beats long; the old ghost showed the 4-beat clip length.
    expect(ghostRect(tool)).toMatchObject({ x: 2 * PPB, w: 8 * PPB })

    tool.onMouseDown(2 * PPB, rowY(1), mods())
    expect(deps.onCreatePatternBlock).toHaveBeenCalledWith('t2', 1, beatsToTicks(2), beatsToTicks(8), 0)
  })

  it('shows no ghost on a pattern track with no current pattern', () => {
    const deps = makeDeps({ currentPatternIdByTrackRef: { current: {} } })
    const tool = createPencilTool(deps)
    tool.onMouseMove(2 * PPB, rowY(1), mods())
    expect(ghostRect(tool)).toBeNull()
  })

  it('shows no ghost over an existing clip', () => {
    const deps = makeDeps({ clips: [clip('x', 0, 4)] })
    const tool = createPencilTool(deps)
    tool.onMouseMove(2 * PPB, rowY(0), mods())
    expect(ghostRect(tool)).toBeNull()
  })

  it('draws the ghost in the destination track colour', () => {
    const deps = makeDeps()
    const tool = createPencilTool(deps)
    tool.onMouseMove(2 * PPB, rowY(0), mods())
    expect(ghostRect(tool).fillStyle).toBe('rgba(51,102,153,0.25)')
  })
})
