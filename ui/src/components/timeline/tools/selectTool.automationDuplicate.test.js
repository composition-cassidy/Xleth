import { describe, expect, it, vi } from 'vitest'
import { createSelectTool } from './selectTool.js'
import { PPQ } from '../../../constants/timeline.js'

// Exercises the REAL createSelectTool state machine (the exact object
// TimelineCanvas.jsx wires up and calls onMouseDown/onMouseMove/onMouseUp/
// onKeyUp on with plain localX/localY/e values — no DOM or canvas needed,
// see TimelineCanvas.jsx's toolRef.current?.onMouseDown(pos.localX, pos.localY, e)).
//
// Fixed geometry for every test: pixelsPerBeat=40 (DEFAULT_PPB), scrollOffset=0,
// snap granularity '1/16' (240 ticks/grid line), a single automation lane
// (laneId 5, ownerTrackId -1) spanning the whole canvas height so any localY
// resolves to it.

const PPB = 40
const LANE = { laneId: 5, y: 0, height: 24, ownerTrackId: -1 }

function makeContainer() {
  const classes = new Set()
  return {
    classList: {
      add: vi.fn((c) => classes.add(c)),
      remove: vi.fn((...cs) => cs.forEach((c) => classes.delete(c))),
      contains: (c) => classes.has(c),
    },
    _classes: classes,
  }
}

function makeClip(over) {
  return { id: 1, laneId: 5, positionTicks: 0, durationTicks: 960, offsetTicks: 0, envelopeId: 10, ...over }
}

function makeDeps({ clips = [makeClip()], selectedIds = new Set(), laneRow = LANE } = {}) {
  const container = makeContainer()
  const onDuplicateAutomationClips = vi.fn()
  const onMoveAutomationClip = vi.fn()
  const setSelectedAutomationClipIds = vi.fn()
  const selectedAutomationClipIdsRef = { current: selectedIds }
  const deps = {
    clipsRef: { current: [] },
    tracksRef: { current: [] },
    regionsRef: { current: {} },
    selectedRef: { current: new Set() },
    pixelsPerBeatRef: { current: PPB },
    scrollOffsetRef: { current: 0 },
    bpmRef: { current: 140 },
    onMoveClips: vi.fn(), onDuplicateClips: vi.fn(), onResizeClip: vi.fn(), onResizeClipLeft: vi.fn(),
    onStretchClip: vi.fn(), onStretchClipLeft: vi.fn(),
    setSelectedClipIds: vi.fn(), setStickyNoteLength: vi.fn(),
    onRequestClipContextMenu: vi.fn(),
    redrawOverlay: vi.fn(),
    containerRef: { current: container },
    snapGranularityRef: { current: '1/16' },
    patternBlocksRef: { current: [] }, patternsRef: { current: {} }, selectedBlockIdsRef: { current: new Set() },
    setSelectedBlockIds: vi.fn(),
    onMovePatternBlocks: vi.fn(), onDuplicatePatternBlocks: vi.fn(), onResizePatternBlock: vi.fn(), onResizePatternBlockLeft: vi.fn(),
    onRequestPatternBlockContextMenu: vi.fn(),
    trackLayoutRef: {
      current: {
        automationLaneRowAtY: () => laneRow,
        getAutomationLaneRows: () => [laneRow],
        trackIndexAtY: () => 0,
        trackTop: () => 0,
      },
    },
    automationClipsRef: { current: clips },
    selectedAutomationClipIdsRef,
    setSelectedAutomationClipIds,
    onMoveAutomationClip,
    onResizeAutomationClip: vi.fn(),
    onResizeAutomationClipLeft: vi.fn(),
    onDuplicateAutomationClips,
    onRequestAutomationClipContextMenu: vi.fn(),
    automationEnvelopesByIdRef: { current: new Map() },
    setSelectedAutomationPoint: vi.fn(),
    onAddAutomationPoint: vi.fn(), onRemoveAutomationPoint: vi.fn(), onMoveAutomationPoint: vi.fn(),
    automationPointDragRef: { current: null },
    redrawContent: vi.fn(),
  }
  return { deps, container, onDuplicateAutomationClips, onMoveAutomationClip, setSelectedAutomationClipIds }
}

const mods = (over) => ({ button: 0, shiftKey: false, ctrlKey: false, altKey: false, metaKey: false, ...over })

describe('createSelectTool — automation clip Shift+drag duplicate', () => {
  it('commits ONE duplicate placement, snapped to grid, on mouseup — clip body, single selection', () => {
    const { deps, container, onDuplicateAutomationClips } = makeDeps()
    const tool = createSelectTool(deps)
    const e = mods({ shiftKey: true })

    // localX=20 -> beat 0.5 -> tick 480, inside clip [0,960).
    tool.onMouseDown(20, 0, e)
    // Past DRAG_THRESHOLD (3px): localX=30 -> beat delta 0.25 -> +240 ticks.
    tool.onMouseMove(30, 0, e)
    expect(container.classList.add).toHaveBeenCalledWith('duplicating')

    tool.onMouseUp(30, 0, e)

    expect(onDuplicateAutomationClips).toHaveBeenCalledTimes(1)
    const placements = onDuplicateAutomationClips.mock.calls[0][0]
    expect(placements).toHaveLength(1)
    expect(placements[0].laneId).toBe(5)
    expect(placements[0].positionTicks).toBe(240)
    expect(placements[0].clip.id).toBe(1)
  })

  it('never calls onMoveAutomationClip for a duplicate-drag commit', () => {
    const { deps, onMoveAutomationClip, onDuplicateAutomationClips } = makeDeps()
    const tool = createSelectTool(deps)
    const e = mods({ shiftKey: true })
    tool.onMouseDown(20, 0, e)
    tool.onMouseMove(30, 0, e)
    tool.onMouseUp(30, 0, e)
    expect(onDuplicateAutomationClips).toHaveBeenCalledTimes(1)
    expect(onMoveAutomationClip).not.toHaveBeenCalled()
  })

  it('plain drag (no Shift) still resolves to move, not duplicate', () => {
    const { deps, onMoveAutomationClip, onDuplicateAutomationClips } = makeDeps()
    const tool = createSelectTool(deps)
    const e = mods({ shiftKey: false })
    tool.onMouseDown(20, 0, e)
    tool.onMouseMove(30, 0, e)
    tool.onMouseUp(30, 0, e)
    expect(onMoveAutomationClip).toHaveBeenCalledTimes(1)
    expect(onDuplicateAutomationClips).not.toHaveBeenCalled()
  })

  it('cancels a mid-drag duplicate when Shift is released (no commit on the eventual mouseup)', () => {
    const { deps, onDuplicateAutomationClips, container } = makeDeps()
    const tool = createSelectTool(deps)
    const shiftDown = mods({ shiftKey: true })
    tool.onMouseDown(20, 0, shiftDown)
    tool.onMouseMove(30, 0, shiftDown) // crosses threshold -> dragMode 'duplicate'
    expect(container.classList.add).toHaveBeenCalledWith('duplicating')

    tool.onKeyUp({ key: 'Shift' })
    // A trailing mouseup (as the real browser would still deliver one) must be
    // a no-op — the cancel flag swallows it before any commit logic runs.
    tool.onMouseUp(30, 0, mods({ shiftKey: false }))

    expect(onDuplicateAutomationClips).not.toHaveBeenCalled()
  })

  it('cancels a PENDING duplicate (Shift released before the drag threshold) — no crash, no commit', () => {
    const { deps, onDuplicateAutomationClips } = makeDeps()
    const tool = createSelectTool(deps)
    tool.onMouseDown(20, 0, mods({ shiftKey: true }))
    // No mousemove yet — still 'pending'. Shift released now.
    tool.onKeyUp({ key: 'Shift' })
    tool.onMouseUp(20, 0, mods({ shiftKey: false }))
    expect(onDuplicateAutomationClips).not.toHaveBeenCalled()
  })

  it('duplicates every clip in a multi-selection, preserving each one\'s own offset', () => {
    const clip1 = makeClip({ id: 1, laneId: 5, positionTicks: 0 })
    const clip2 = makeClip({ id: 2, laneId: 5, positionTicks: 1920 }) // +2 beats
    const { deps, onDuplicateAutomationClips } = makeDeps({
      clips: [clip1, clip2],
      selectedIds: new Set([1, 2]),
    })
    const tool = createSelectTool(deps)
    const e = mods({ shiftKey: true })

    // Grab clip1's body (tick 480 is inside [0,960)).
    tool.onMouseDown(20, 0, e)
    tool.onMouseMove(30, 0, e) // same +240t delta as the single-clip test
    tool.onMouseUp(30, 0, e)

    expect(onDuplicateAutomationClips).toHaveBeenCalledTimes(1)
    const placements = onDuplicateAutomationClips.mock.calls[0][0]
    expect(placements).toHaveLength(2)
    const byId = Object.fromEntries(placements.map(p => [p.clip.id, p]))
    expect(byId[1].positionTicks).toBe(240)       // 0 + 240
    expect(byId[2].positionTicks).toBe(1920 + 240) // preserves the 1920t gap
    expect(byId[1].laneId).toBe(5)
    expect(byId[2].laneId).toBe(5)
  })

  it('snaps the duplicate placement to the CURRENT snap granularity', () => {
    const clip = makeClip({ id: 1, laneId: 5, positionTicks: 0 })
    const { deps, onDuplicateAutomationClips } = makeDeps({ clips: [clip] })
    deps.snapGranularityRef.current = 'Bar' // 4 beats/grid line = 3840 ticks
    const tool = createSelectTool(deps)
    const e = mods({ shiftKey: true })

    // Drag exactly 1 beat (40px at ppb=40): round(1/4 grid-units)/4 = 0 —
    // short of the nearest bar line at 4 beats, so it snaps DOWN to tick 0.
    tool.onMouseDown(0, 0, e)
    tool.onMouseMove(40, 0, e)
    tool.onMouseUp(40, 0, e)

    const placements = onDuplicateAutomationClips.mock.calls[0][0]
    expect(placements[0].positionTicks).toBe(0)
  })

  it('does not affect the original clip — placements are new positions only, not mutations', () => {
    const clip = makeClip({ id: 1, laneId: 5, positionTicks: 0 })
    const { deps, onDuplicateAutomationClips } = makeDeps({ clips: [clip] })
    const tool = createSelectTool(deps)
    const e = mods({ shiftKey: true })
    tool.onMouseDown(20, 0, e)
    tool.onMouseMove(30, 0, e)
    tool.onMouseUp(30, 0, e)
    expect(clip.positionTicks).toBe(0)
    const placements = onDuplicateAutomationClips.mock.calls[0][0]
    expect(placements[0].clip).toBe(clip) // same reference, untouched
  })

  it('drawOverlay renders a duplicate preview without throwing', () => {
    const clip = makeClip({ id: 1, laneId: 5, positionTicks: 0 })
    const { deps } = makeDeps({ clips: [clip] })
    const tool = createSelectTool(deps)
    const e = mods({ shiftKey: true })
    tool.onMouseDown(20, 0, e)
    tool.onMouseMove(30, 0, e)

    const ctx = {
      save: vi.fn(), restore: vi.fn(), fillRect: vi.fn(), strokeRect: vi.fn(),
      fillText: vi.fn(), beginPath: vi.fn(), moveTo: vi.fn(), lineTo: vi.fn(), stroke: vi.fn(),
      set fillStyle(v) {}, set strokeStyle(v) {}, set globalAlpha(v) {}, set lineWidth(v) {},
      set font(v) {}, set textAlign(v) {},
    }
    expect(() => tool.drawOverlay(ctx, 800, 200, { scrollOffset: 0, pixelsPerBeat: PPB })).not.toThrow()
    expect(ctx.fillRect).toHaveBeenCalled()
  })
})

describe('createSelectTool — automation clip duplicate ticks sanity', () => {
  it('PPQ constant used by this suite matches the engine (960)', () => {
    expect(PPQ).toBe(960)
  })
})
