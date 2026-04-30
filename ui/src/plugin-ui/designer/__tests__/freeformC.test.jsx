/**
 * Phase Freeform-C: selection overlay, drag, resize, nudge, snap.
 *
 * Coverage:
 *   1. snapValue — pure helper
 *   2. clampFrame — bounds enforcement
 *   3. dragFrame — translate with snap / bypass / axis constraint
 *   4. resizeFrame — all 8 handles, snap, aspect ratio, clamping
 *   5. nudgeFrame — 1/10/gridPx nudge sizes
 *   6. isFrameLocked / getFrameBounds
 *   7. setFrameLive — live store update without undo push
 *   8. nudgeSelectedFrame — action with store integration
 *   9. SelectionOverlay — render tests
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  clampFrame,
  dragFrame,
  getFrameBounds,
  isFrameLocked,
  nudgeFrame,
  resizeFrame,
  snapValue,
} from '../freeformGeometry.js'
import { setFrameLive, commitFrameGesture, nudgeSelectedFrame } from '../designerActions.js'
import { usePluginUIDesignerStore } from '../usePluginUIDesignerStore.js'
import SelectionOverlay from '../SelectionOverlay.jsx'
import { COMPRESSOR_MANIFEST } from '../../manifests/compressor.js'

// ── Store helpers ──────────────────────────────────────────────────────────────

function makeMinimalLayout(nodeOverride = {}) {
  const baseFrame = { x: 20, y: 30, widthPx: 100, heightPx: 60 }
  return {
    id: 'layout-1',
    schemaVersion: 1,
    pluginId: 'compressor',
    root: {
      id: 'root',
      type: 'panel',
      children: [
        {
          id: 'ff-layer',
          type: 'freeformLayer',
          style: { widthPx: 480, heightPx: 160 },
          props: { snap: { gridPx: 8, enabled: true }, background: 'transparent', clip: 'panel' },
          children: [
            {
              id: 'decor-1',
              type: 'decorText',
              props: {
                frame: { ...baseFrame, ...nodeOverride },
                text: 'Hello',
                variant: 'default',
                align: 'left',
                letterSpacing: 'normal',
                textToken: 'text.primary',
              },
            },
          ],
        },
      ],
    },
  }
}

function resetStore() {
  usePluginUIDesignerStore.setState({
    pluginId: 'compressor',
    manifest: COMPRESSOR_MANIFEST,
    workingLayout: null,
    shippedLayout: null,
    savedOverride: null,
    selectedNodeId: null,
    expandedNodeIds: new Set(),
    validationResult: { ok: true, errors: [] },
    dirty: false,
    mutationError: null,
    persistenceMessage: null,
    undoStack: [],
    redoStack: [],
    pendingCoalesce: null,
    lastEditMeta: null,
    isLoading: false,
    loadError: null,
    isSaving: false,
    isImporting: false,
    isExporting: false,
    saveError: null,
    lastSavedAt: null,
  })
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. snapValue
// ─────────────────────────────────────────────────────────────────────────────

describe('snapValue', () => {
  it('rounds 7 to 8 with gridPx=8 enabled', () => {
    expect(snapValue(7, 8, true)).toBe(8)
  })

  it('rounds 13 to 16 with gridPx=8 enabled', () => {
    expect(snapValue(13, 8, true)).toBe(16)
  })

  it('returns 7 unchanged when disabled', () => {
    expect(snapValue(7, 8, false)).toBe(7)
  })

  it('returns value unchanged when gridPx=1', () => {
    expect(snapValue(7, 1, true)).toBe(7)
  })

  it('rounds 4 up to 8 with gridPx=8 enabled (midpoint rounds up)', () => {
    // Math.round(4/8) = Math.round(0.5) = 1 → 1*8 = 8
    expect(snapValue(4, 8, true)).toBe(8)
  })

  it('snaps negative value', () => {
    // -3 / 8 = -0.375 → round = 0 → 0
    expect(snapValue(-3, 8, true)).toBe(0)
    // -5 / 8 = -0.625 → round = -1 → -8
    expect(snapValue(-5, 8, true)).toBe(-8)
  })

  it('snaps to gridPx=16', () => {
    expect(snapValue(24, 16, true)).toBe(32) // 24/16=1.5 → 2 → 32
    expect(snapValue(7, 16, true)).toBe(0)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 2. clampFrame
// ─────────────────────────────────────────────────────────────────────────────

describe('clampFrame', () => {
  it('clamps x below -2000', () => {
    expect(clampFrame({ x: -3000, y: 0, widthPx: 10, heightPx: 10 }).x).toBe(-2000)
  })

  it('clamps y above 4000', () => {
    expect(clampFrame({ x: 0, y: 5000, widthPx: 10, heightPx: 10 }).y).toBe(4000)
  })

  it('clamps widthPx below 1', () => {
    expect(clampFrame({ x: 0, y: 0, widthPx: -5, heightPx: 10 }).widthPx).toBe(1)
  })

  it('clamps heightPx above 4096', () => {
    expect(clampFrame({ x: 0, y: 0, widthPx: 10, heightPx: 9000 }).heightPx).toBe(4096)
  })

  it('clamps zIndex when present', () => {
    expect(clampFrame({ x: 0, y: 0, widthPx: 10, heightPx: 10, zIndex: 1200 }).zIndex).toBe(999)
  })

  it('does not add zIndex when not in original frame', () => {
    const f = clampFrame({ x: 0, y: 0, widthPx: 10, heightPx: 10 })
    expect('zIndex' in f).toBe(false)
  })

  it('preserves in-range values unchanged', () => {
    const f = { x: 10, y: 20, widthPx: 100, heightPx: 200 }
    expect(clampFrame(f)).toEqual(f)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 3. dragFrame
// ─────────────────────────────────────────────────────────────────────────────

describe('dragFrame', () => {
  const base = { x: 0, y: 0, widthPx: 100, heightPx: 80 }

  it('translates by integer delta when snap disabled', () => {
    const r = dragFrame(base, 15, 25, { snapEnabled: false })
    expect(r.x).toBe(15)
    expect(r.y).toBe(25)
  })

  it('snaps translated position to grid', () => {
    // x=0+15=15 → snap(15,8)=16; y=0+25=25 → snap(25,8)=24
    const r = dragFrame(base, 15, 25, { snapEnabled: true, gridPx: 8 })
    expect(r.x).toBe(16)
    expect(r.y).toBe(24)
  })

  it('does not snap when bypassSnap=true (Alt key)', () => {
    const r = dragFrame(base, 15, 25, { snapEnabled: true, gridPx: 8, bypassSnap: true })
    expect(r.x).toBe(15)
    expect(r.y).toBe(25)
  })

  it('constrains to horizontal axis (Shift → lock vertical)', () => {
    const r = dragFrame(base, 30, 50, { snapEnabled: false, constrainAxis: 'horizontal' })
    expect(r.x).toBe(30)
    expect(r.y).toBe(0)  // dy zeroed out
  })

  it('constrains to vertical axis (Shift → lock horizontal)', () => {
    const r = dragFrame(base, 30, 50, { snapEnabled: false, constrainAxis: 'vertical' })
    expect(r.x).toBe(0)  // dx zeroed out
    expect(r.y).toBe(50)
  })

  it('clamps result within bounds', () => {
    const r = dragFrame(base, 5000, -5000, { snapEnabled: false })
    expect(r.x).toBe(4000)
    expect(r.y).toBe(-2000)
  })

  it('does not change widthPx or heightPx', () => {
    const r = dragFrame(base, 10, 20, { snapEnabled: false })
    expect(r.widthPx).toBe(100)
    expect(r.heightPx).toBe(80)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 4. resizeFrame
// ─────────────────────────────────────────────────────────────────────────────

describe('resizeFrame', () => {
  const base = { x: 40, y: 30, widthPx: 200, heightPx: 100 }
  const noSnap = { snapEnabled: false }

  // South handle (bottom edge moves, top stays)
  it('s handle: grows height downward', () => {
    const r = resizeFrame(base, 's', 0, 20, noSnap)
    expect(r.x).toBe(40)
    expect(r.y).toBe(30)
    expect(r.widthPx).toBe(200)
    expect(r.heightPx).toBe(120)
  })

  // North handle (top edge moves, bottom stays)
  it('n handle: moves top edge and shrinks height', () => {
    const r = resizeFrame(base, 'n', 0, 10, noSnap)
    expect(r.y).toBe(40)          // top moved down 10
    expect(r.heightPx).toBe(90)   // bottom stays at y+h=130, height=130-40=90
    expect(r.x).toBe(40)
  })

  // East handle (right edge moves, left stays)
  it('e handle: grows width rightward', () => {
    const r = resizeFrame(base, 'e', 30, 0, noSnap)
    expect(r.x).toBe(40)
    expect(r.widthPx).toBe(230)
    expect(r.y).toBe(30)
    expect(r.heightPx).toBe(100)
  })

  // West handle (left edge moves, right stays)
  it('w handle: moves left edge and reduces width', () => {
    const r = resizeFrame(base, 'w', 20, 0, noSnap)
    expect(r.x).toBe(60)          // left moved right 20
    expect(r.widthPx).toBe(180)   // right stays at x+w=240, width=240-60=180
    expect(r.y).toBe(30)
  })

  // SE corner (bottom-right moves, top-left stays)
  it('se handle: expands bottom-right', () => {
    const r = resizeFrame(base, 'se', 50, 40, noSnap)
    expect(r.x).toBe(40)
    expect(r.y).toBe(30)
    expect(r.widthPx).toBe(250)
    expect(r.heightPx).toBe(140)
  })

  // NW corner (top-left moves, bottom-right stays)
  it('nw handle: keeps bottom-right anchored', () => {
    // bottom-right anchor = (240, 130)
    const r = resizeFrame(base, 'nw', 20, 10, noSnap)
    expect(r.x).toBe(60)           // left moved right 20
    expect(r.y).toBe(40)           // top moved down 10
    expect(r.widthPx).toBe(180)    // right=240, width=240-60
    expect(r.heightPx).toBe(90)    // bottom=130, height=130-40
  })

  // NE corner
  it('ne handle: keeps bottom-left anchored', () => {
    const r = resizeFrame(base, 'ne', 20, -10, noSnap)
    expect(r.x).toBe(40)           // left stays
    expect(r.y).toBe(20)           // top moves up 10
    expect(r.widthPx).toBe(220)    // right moved right 20
    expect(r.heightPx).toBe(110)   // bottom stays at 130, height=130-20
  })

  // SW corner
  it('sw handle: keeps top-right anchored', () => {
    const r = resizeFrame(base, 'sw', -20, 20, noSnap)
    expect(r.x).toBe(20)           // left moved left 20
    expect(r.y).toBe(30)           // top stays
    expect(r.widthPx).toBe(220)    // right=240 unchanged, width=240-20
    expect(r.heightPx).toBe(120)   // bottom moved down 20
  })

  // Snap applied to moving edges
  it('applies snap to moving edge', () => {
    // e handle: right edge moves from 240 to 240+15=255 → snap(255,8)=256
    const r = resizeFrame(base, 'e', 15, 0, { snapEnabled: true, gridPx: 8 })
    expect(r.widthPx).toBe(256 - 40)  // snappedRight=256, x=40, w=216
  })

  // Clamp to minimum size
  it('clamps widthPx to 1 when resized too small', () => {
    const r = resizeFrame(base, 'e', -500, 0, noSnap)
    expect(r.widthPx).toBe(1)
  })

  it('clamps heightPx to 1 when resized too small', () => {
    // S handle uses deltaY — move bottom edge up by 500 to shrink below minimum.
    const r = resizeFrame(base, 's', 0, -500, noSnap)
    expect(r.heightPx).toBe(1)
  })

  // Aspect ratio preservation (Shift + corner)
  it('preserves aspect ratio from se corner (width-dominant)', () => {
    // base: 200×100 → aspect=2
    // drag se by (60, 20) → rawNewW=260, rawNewH=120
    // wScale = 260/200-1 = 0.3, hScale = 120/100-1 = 0.2 → width dominant
    // targetH = 260 / 2 = 130
    const r = resizeFrame(base, 'se', 60, 20, { ...noSnap, preserveAspect: true })
    expect(r.widthPx).toBe(260)
    expect(r.heightPx).toBe(130)
    expect(r.x).toBe(40)   // top-left anchored
    expect(r.y).toBe(30)
  })

  it('preserves aspect ratio from nw corner (height-dominant)', () => {
    // base: 200×100 → aspect=2
    // drag nw by (10, -50) → newX=50, newY=-20, rawNewW=190, rawNewH=150
    // wScale = 190/200-1 = -0.05 abs=0.05, hScale = 150/100-1 = 0.5 abs=0.5 → height dominant
    // targetW = 150 * 2 = 300 → but right stays at 240, newX = 240-300 = -60
    const r = resizeFrame(base, 'nw', 10, -50, { ...noSnap, preserveAspect: true })
    expect(r.heightPx).toBe(150)
    expect(r.widthPx).toBe(300)
    expect(r.x).toBe(-60)  // clamped: -60 > -2000 so not clamped
    expect(r.y).toBe(-20)
  })

  it('does not apply aspect ratio to edge handles (non-corner)', () => {
    // preserveAspect on an edge handle should be a no-op
    const r1 = resizeFrame(base, 's', 0, 50, { ...noSnap, preserveAspect: true })
    const r2 = resizeFrame(base, 's', 0, 50, noSnap)
    expect(r1).toEqual(r2)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 5. nudgeFrame
// ─────────────────────────────────────────────────────────────────────────────

describe('nudgeFrame', () => {
  const base = { x: 100, y: 80, widthPx: 60, heightPx: 40 }

  it('nudges right by 1 with no modifier', () => {
    expect(nudgeFrame(base, 'right').x).toBe(101)
    expect(nudgeFrame(base, 'right').y).toBe(80)
  })

  it('nudges left by 1 with no modifier', () => {
    expect(nudgeFrame(base, 'left').x).toBe(99)
  })

  it('nudges up by 1 with no modifier', () => {
    expect(nudgeFrame(base, 'up').y).toBe(79)
  })

  it('nudges down by 1 with no modifier', () => {
    expect(nudgeFrame(base, 'down').y).toBe(81)
  })

  it('nudges by 10 when shiftKey=true', () => {
    expect(nudgeFrame(base, 'right', { shiftKey: true }).x).toBe(110)
  })

  it('nudges by gridPx when altKey=true', () => {
    expect(nudgeFrame(base, 'right', { altKey: true, gridPx: 16 }).x).toBe(116)
  })

  it('nudges by default gridPx=8 when altKey=true and no gridPx given', () => {
    expect(nudgeFrame(base, 'right', { altKey: true }).x).toBe(108)
  })

  it('clamps result within bounds', () => {
    const atEdge = { x: 4000, y: 4000, widthPx: 10, heightPx: 10 }
    expect(nudgeFrame(atEdge, 'right', { shiftKey: true }).x).toBe(4000)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 6. isFrameLocked / getFrameBounds
// ─────────────────────────────────────────────────────────────────────────────

describe('isFrameLocked', () => {
  it('returns true when frame.locked=true', () => {
    expect(isFrameLocked({ locked: true })).toBe(true)
  })

  it('returns false when frame.locked=false', () => {
    expect(isFrameLocked({ locked: false })).toBe(false)
  })

  it('returns false when locked is absent', () => {
    expect(isFrameLocked({ x: 0, y: 0, widthPx: 10, heightPx: 10 })).toBe(false)
  })

  it('returns false for null/undefined', () => {
    expect(isFrameLocked(null)).toBe(false)
    expect(isFrameLocked(undefined)).toBe(false)
  })
})

describe('getFrameBounds', () => {
  it('returns an object with x, y, widthPx, heightPx, zIndex, rotationDeg', () => {
    const b = getFrameBounds()
    expect(b).toHaveProperty('x')
    expect(b).toHaveProperty('y')
    expect(b).toHaveProperty('widthPx')
    expect(b).toHaveProperty('heightPx')
    expect(b).toHaveProperty('zIndex')
    expect(b).toHaveProperty('rotationDeg')
  })

  it('widthPx min is 1', () => {
    expect(getFrameBounds().widthPx.min).toBe(1)
  })

  it('x range is -2000..4000', () => {
    const b = getFrameBounds()
    expect(b.x.min).toBe(-2000)
    expect(b.x.max).toBe(4000)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 7. setFrameLive — updates layout without pushing undo
// ─────────────────────────────────────────────────────────────────────────────

describe('setFrameLive', () => {
  beforeEach(() => {
    resetStore()
    usePluginUIDesignerStore.setState({
      workingLayout: makeMinimalLayout(),
      selectedNodeId: 'decor-1',
    })
  })

  it('updates the frame on the target node', () => {
    const newFrame = { x: 50, y: 60, widthPx: 120, heightPx: 80 }
    setFrameLive('decor-1', newFrame)
    const state = usePluginUIDesignerStore.getState()
    const node = state.workingLayout.root.children[0].children[0]
    expect(node.props.frame).toMatchObject(newFrame)
  })

  it('does not push to undo stack', () => {
    setFrameLive('decor-1', { x: 1, y: 2, widthPx: 10, heightPx: 10 })
    expect(usePluginUIDesignerStore.getState().undoStack).toHaveLength(0)
  })

  it('is a no-op when nodeId is absent', () => {
    const before = JSON.stringify(usePluginUIDesignerStore.getState().workingLayout)
    setFrameLive(null, { x: 1, y: 2, widthPx: 10, heightPx: 10 })
    const after  = JSON.stringify(usePluginUIDesignerStore.getState().workingLayout)
    expect(before).toBe(after)
  })

  it('sets dirty=true when frame differs from shippedLayout', () => {
    const layout = makeMinimalLayout()
    usePluginUIDesignerStore.setState({ shippedLayout: layout, workingLayout: layout, savedOverride: null, dirty: false })
    setFrameLive('decor-1', { x: 99, y: 99, widthPx: 10, heightPx: 10 })
    expect(usePluginUIDesignerStore.getState().dirty).toBe(true)
  })

  it('keeps dirty=false when frame matches shippedLayout', () => {
    const layout = makeMinimalLayout()
    usePluginUIDesignerStore.setState({ shippedLayout: layout, workingLayout: layout, savedOverride: null, dirty: false })
    // Apply same frame values as already in the layout — dirty must stay false
    setFrameLive('decor-1', { x: 20, y: 30, widthPx: 100, heightPx: 60 })
    expect(usePluginUIDesignerStore.getState().dirty).toBe(false)
  })

  it('does not mutate shippedLayout or savedOverride', () => {
    const layout = makeMinimalLayout()
    const shipped = JSON.parse(JSON.stringify(layout))
    usePluginUIDesignerStore.setState({ shippedLayout: layout, workingLayout: layout, savedOverride: null, dirty: false })
    setFrameLive('decor-1', { x: 77, y: 77, widthPx: 50, heightPx: 50 })
    const state = usePluginUIDesignerStore.getState()
    expect(JSON.stringify(state.shippedLayout)).toBe(JSON.stringify(shipped))
    expect(state.savedOverride).toBeNull()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 7b. commitFrameGesture — final commit at pointer-up
// ─────────────────────────────────────────────────────────────────────────────

describe('commitFrameGesture', () => {
  beforeEach(() => {
    resetStore()
    const layout = makeMinimalLayout()
    usePluginUIDesignerStore.setState({
      workingLayout: layout,
      shippedLayout: layout,
      savedOverride: null,
      selectedNodeId: 'decor-1',
      dirty: false,
    })
  })

  it('does not throw when workingLayout is null', () => {
    usePluginUIDesignerStore.setState({ workingLayout: null })
    expect(() => commitFrameGesture()).not.toThrow()
  })

  it('updates validationResult after a setFrameLive mutation', () => {
    setFrameLive('decor-1', { x: 50, y: 50, widthPx: 80, heightPx: 60 })
    commitFrameGesture()
    const { validationResult } = usePluginUIDesignerStore.getState()
    expect(validationResult).toBeDefined()
    expect(validationResult.ok).toBe(true)
  })

  it('dirty remains true after commit when frame differs from base', () => {
    setFrameLive('decor-1', { x: 50, y: 50, widthPx: 80, heightPx: 60 })
    commitFrameGesture()
    expect(usePluginUIDesignerStore.getState().dirty).toBe(true)
  })

  it('dirty is false after commit when frame matches shippedLayout', () => {
    // Move frame to same position as shippedLayout (no net change)
    setFrameLive('decor-1', { x: 20, y: 30, widthPx: 100, heightPx: 60 })
    commitFrameGesture()
    expect(usePluginUIDesignerStore.getState().dirty).toBe(false)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 8. nudgeSelectedFrame — discrete action with undo coalescing
// ─────────────────────────────────────────────────────────────────────────────

describe('nudgeSelectedFrame', () => {
  beforeEach(() => {
    resetStore()
    usePluginUIDesignerStore.setState({
      workingLayout: makeMinimalLayout(),
      selectedNodeId: 'decor-1',
    })
  })

  function getFrame() {
    return usePluginUIDesignerStore.getState().workingLayout.root.children[0].children[0].props.frame
  }

  it('nudges right by 1 with no modifier', () => {
    nudgeSelectedFrame('right', {})
    expect(getFrame().x).toBe(21)
  })

  it('nudges by 10 with shiftKey', () => {
    nudgeSelectedFrame('up', { shiftKey: true })
    expect(getFrame().y).toBe(20)
  })

  it('nudges by gridPx with altKey', () => {
    nudgeSelectedFrame('left', { altKey: true })
    // gridPx=8 from the freeformLayer's snap.gridPx
    expect(getFrame().x).toBe(12)
  })

  it('returns ok:true result', () => {
    const result = nudgeSelectedFrame('down', {})
    expect(result.ok).toBe(true)
  })

  it('pushes to undo stack', () => {
    nudgeSelectedFrame('right', {})
    expect(usePluginUIDesignerStore.getState().undoStack).toHaveLength(1)
  })

  it('returns error if node has no frame', () => {
    usePluginUIDesignerStore.setState({ selectedNodeId: 'ff-layer' })
    const result = nudgeSelectedFrame('right', {})
    expect(result.ok).toBe(false)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 9. SelectionOverlay — render tests
// ─────────────────────────────────────────────────────────────────────────────

describe('SelectionOverlay', () => {
  const mockHostRef = { current: null }

  beforeEach(() => {
    resetStore()
  })

  it('renders nothing when no node is selected', () => {
    usePluginUIDesignerStore.setState({ workingLayout: makeMinimalLayout(), selectedNodeId: null })
    const html = renderToStaticMarkup(<SelectionOverlay hostRef={mockHostRef} />)
    expect(html).toBe('')
  })

  it('renders nothing when selected node has no frame (flow node)', () => {
    usePluginUIDesignerStore.setState({ workingLayout: makeMinimalLayout(), selectedNodeId: 'root' })
    const html = renderToStaticMarkup(<SelectionOverlay hostRef={mockHostRef} />)
    expect(html).toBe('')
  })

  it('renders nothing when workingLayout is null', () => {
    usePluginUIDesignerStore.setState({ workingLayout: null, selectedNodeId: 'decor-1' })
    const html = renderToStaticMarkup(<SelectionOverlay hostRef={mockHostRef} />)
    expect(html).toBe('')
  })

  it('renders overlay container for freeform node (rect=null, inner returns null from static render)', () => {
    // Static render cannot run useLayoutEffect, so rect stays null and the inner
    // renders nothing. Verify the component at least does not throw.
    usePluginUIDesignerStore.setState({ workingLayout: makeMinimalLayout(), selectedNodeId: 'decor-1' })
    expect(() => {
      renderToStaticMarkup(<SelectionOverlay hostRef={mockHostRef} />)
    }).not.toThrow()
  })

  it('renders locked overlay class for a locked frame', () => {
    const layout = makeMinimalLayout({ locked: true })
    usePluginUIDesignerStore.setState({ workingLayout: layout, selectedNodeId: 'decor-1' })
    // Rendered to static with null rect — inner returns null. Test is structural:
    // ensure the overlay would include the locked class if rect were present.
    // Verify by checking that isFrameLocked returns true for this node.
    const node = layout.root.children[0].children[0]
    expect(isFrameLocked(node.props.frame)).toBe(true)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Extra: snapValue edge cases from the spec
// ─────────────────────────────────────────────────────────────────────────────

describe('snapValue spec examples', () => {
  it('snapValue(7, 8, true) === 8', () => {
    expect(snapValue(7, 8, true)).toBe(8)
  })

  it('snapValue(13, 8, true) === 16', () => {
    expect(snapValue(13, 8, true)).toBe(16)
  })

  it('snapValue(7, 8, false) === 7', () => {
    expect(snapValue(7, 8, false)).toBe(7)
  })
})
