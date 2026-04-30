/**
 * Phase Freeform-C.5: move/convert existing controls into freeform layers.
 *
 * Coverage:
 *   1. isFreeformLayer / isFreeformEligibleLeaf
 *   2. moveNodeIntoFreeformLayer — preserves props/bindings/appearance
 *   3. moveNodeIntoFreeformLayer — adds frame, removes from old parent
 *   4. moveNodeIntoFreeformLayer — rejects root, containers, missing target
 *   5. moveNodesIntoFreeformLayer — batch move
 *   6. convertContainerToFreeformLayer — converts a row of knobs
 *   7. convertContainerToFreeformLayer — rejects nested containers
 *   8. convertContainerToFreeformLayer — preserves child ids and props
 *   9. Style cleanup — strips flow-only keys, preserves visual keys
 *  10. freeformMeasure — buildFrameFromRects geometry
 *  11. freeformMeasure — measureChildrenForFreeform with mocked DOM
 *  12. freeformMeasure — missing DOM node returns error
 *  13. getFreeformLayerOptions / findFirstFreeformLayer
 *  14. moveSelectedNodeToFreeform action — sets mutationError without preview host
 *  15. convertSelectedContainerToFreeform action — sets mutationError without preview host
 *  16. Undo after convertContainerToFreeformLayer restores original container
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  collectEligibleLeafDescendantIds,
  collectEligibleLeafDescendants,
  convertContainerToFreeformLayer,
  findNode,
  getParentInfo,
  isFreeformEligibleLeaf,
  isFreeformLayer,
  moveNodeIntoFreeformLayer,
  moveNodesIntoFreeformLayer,
} from '../layoutMutations.js'
import {
  buildFrameFromRects,
  getNodeRectInPreview,
  measureChildrenForFreeform,
} from '../freeformMeasure.js'
import {
  convertSelectedContainerToFreeform,
  findFirstFreeformLayer,
  getFreeformLayerOptions,
  moveSelectedNodeToFreeform,
  setPreviewHostEl,
} from '../designerActions.js'
import { usePluginUIDesignerStore } from '../usePluginUIDesignerStore.js'
import { COMPRESSOR_MANIFEST } from '../../manifests/compressor.js'

// ── Layout builders ───────────────────────────────────────────────────────────

function makeLayout(overrides = {}) {
  return {
    id: 'layout-1',
    schemaVersion: 1,
    pluginId: 'compressor',
    root: {
      id: 'root',
      type: 'panel',
      children: [
        {
          id: 'body-row',
          type: 'row',
          children: [
            {
              id: 'knob-attack',
              type: 'knob',
              props: {
                param:      'attack',
                label:      'Attack',
                size:       52,
                format:     'ms1',
                appearance: { preset: 'xleth.blue' },
              },
              style: { growsToFill: true, flexBasis: 60 },
            },
            {
              id: 'knob-release',
              type: 'knob',
              props: { param: 'release', label: 'Release', size: 52, format: 'ms1' },
            },
          ],
        },
        {
          id: 'ff-layer',
          type: 'freeformLayer',
          style: { widthPx: 480, heightPx: 160 },
          props: { snap: { gridPx: 8, enabled: true }, background: 'transparent', clip: 'panel' },
          children: [],
        },
      ],
    },
    ...overrides,
  }
}

// Layout with no freeform layer.
function makeLayoutNoFF() {
  const layout = makeLayout()
  layout.root.children = layout.root.children.filter(c => c.id !== 'ff-layer')
  return layout
}

function resetStore(extra = {}) {
  usePluginUIDesignerStore.setState({
    pluginId:           'compressor',
    manifest:           COMPRESSOR_MANIFEST,
    workingLayout:      null,
    shippedLayout:      null,
    savedOverride:      null,
    selectedNodeId:     null,
    expandedNodeIds:    new Set(),
    validationResult:   { ok: true, errors: [] },
    dirty:              false,
    mutationError:      null,
    persistenceMessage: null,
    undoStack:          [],
    redoStack:          [],
    pendingCoalesce:    null,
    lastEditMeta:       null,
    isLoading:          false,
    loadError:          null,
    isSaving:           false,
    isImporting:        false,
    isExporting:        false,
    saveError:          null,
    lastSavedAt:        null,
    ...extra,
  })
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. isFreeformLayer / isFreeformEligibleLeaf
// ─────────────────────────────────────────────────────────────────────────────

describe('isFreeformLayer', () => {
  it('returns true for freeformLayer nodes', () => {
    expect(isFreeformLayer({ type: 'freeformLayer' })).toBe(true)
  })

  it('returns false for other containers', () => {
    expect(isFreeformLayer({ type: 'row' })).toBe(false)
    expect(isFreeformLayer({ type: 'panel' })).toBe(false)
    expect(isFreeformLayer(null)).toBe(false)
  })
})

describe('isFreeformEligibleLeaf', () => {
  it('returns true for all eligible leaf types', () => {
    const eligible = ['knob', 'toggle', 'button', 'meter', 'visualizer', 'label', 'spacer',
      'decorText', 'decorLine', 'decorShape', 'decal']
    for (const type of eligible) {
      expect(isFreeformEligibleLeaf({ type }), `${type} should be eligible`).toBe(true)
    }
  })

  it('returns false for containers', () => {
    expect(isFreeformEligibleLeaf({ type: 'row' })).toBe(false)
    expect(isFreeformEligibleLeaf({ type: 'freeformLayer' })).toBe(false)
    expect(isFreeformEligibleLeaf({ type: 'panel' })).toBe(false)
    expect(isFreeformEligibleLeaf(null)).toBe(false)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// collectEligibleLeafDescendants / collectEligibleLeafDescendantIds
// ─────────────────────────────────────────────────────────────────────────────

describe('collectEligibleLeafDescendants', () => {
  it('returns direct leaf children', () => {
    const layout = makeLayout()
    const bodyRow = findNode(layout, 'body-row')
    const leaves = collectEligibleLeafDescendants(bodyRow)
    expect(leaves.map(n => n.id)).toEqual(['knob-attack', 'knob-release'])
  })

  it('flattens through nested flow containers', () => {
    const layout  = makeLayout()
    const bodyRow = findNode(layout, 'body-row')
    const knobRelease = bodyRow.children.find(c => c.id === 'knob-release')
    bodyRow.children = [
      bodyRow.children.find(c => c.id === 'knob-attack'),
      { id: 'inner-col', type: 'column', children: [knobRelease] },
    ]
    const leaves = collectEligibleLeafDescendants(bodyRow)
    expect(leaves.map(n => n.id)).toEqual(['knob-attack', 'knob-release'])
  })

  it('throws on nested freeformLayer', () => {
    const layout  = makeLayout()
    const bodyRow = findNode(layout, 'body-row')
    bodyRow.children.push({ id: 'bad-ff', type: 'freeformLayer', children: [] })
    expect(() => collectEligibleLeafDescendants(bodyRow)).toThrow(/freeformLayer/)
  })

  it('throws on nested tabGroup', () => {
    const layout  = makeLayout()
    const bodyRow = findNode(layout, 'body-row')
    bodyRow.children.push({ id: 'bad-tab', type: 'tabGroup', children: [] })
    expect(() => collectEligibleLeafDescendants(bodyRow)).toThrow(/tabGroup/)
  })

  it('returns empty array for empty container', () => {
    const node = { id: 'empty', type: 'row', children: [] }
    expect(collectEligibleLeafDescendants(node)).toEqual([])
  })
})

describe('collectEligibleLeafDescendantIds', () => {
  it('returns a Set of leaf ids', () => {
    const layout = makeLayout()
    const ids = collectEligibleLeafDescendantIds(layout, 'body-row')
    expect(ids).toEqual(new Set(['knob-attack', 'knob-release']))
  })

  it('returns empty Set for unknown containerId', () => {
    const layout = makeLayout()
    expect(collectEligibleLeafDescendantIds(layout, 'nonexistent')).toEqual(new Set())
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 2 & 3. moveNodeIntoFreeformLayer — preserves props, adds frame, removes from parent
// ─────────────────────────────────────────────────────────────────────────────

describe('moveNodeIntoFreeformLayer', () => {
  it('removes knob from its old parent and inserts into freeformLayer', () => {
    const layout = makeLayout()
    const frame  = { x: 10, y: 20, widthPx: 52, heightPx: 52 }
    const next   = moveNodeIntoFreeformLayer(layout, 'knob-attack', 'ff-layer', frame)

    // Old parent no longer has the knob.
    const bodyRow = findNode(next, 'body-row')
    expect(bodyRow.children.find(c => c.id === 'knob-attack')).toBeUndefined()

    // FreeformLayer now has the knob.
    const ffLayer = findNode(next, 'ff-layer')
    expect(ffLayer.children).toHaveLength(1)
    expect(ffLayer.children[0].id).toBe('knob-attack')
  })

  it('preserves all props including param, label, appearance, format', () => {
    const layout = makeLayout()
    const frame  = { x: 0, y: 0, widthPx: 52, heightPx: 52 }
    const next   = moveNodeIntoFreeformLayer(layout, 'knob-attack', 'ff-layer', frame)

    const movedNode = findNode(next, 'knob-attack')
    expect(movedNode.props.param).toBe('attack')
    expect(movedNode.props.label).toBe('Attack')
    expect(movedNode.props.format).toBe('ms1')
    expect(movedNode.props.appearance).toEqual({ preset: 'xleth.blue' })
  })

  it('adds frame to the moved node props', () => {
    const layout = makeLayout()
    const frame  = { x: 16, y: 32, widthPx: 80, heightPx: 60 }
    const next   = moveNodeIntoFreeformLayer(layout, 'knob-attack', 'ff-layer', frame)

    const movedNode = findNode(next, 'knob-attack')
    expect(movedNode.props.frame).toEqual(frame)
  })

  it('strips flow-only style keys but not others', () => {
    const layout = makeLayout()
    // knob-attack has growsToFill and flexBasis in style.
    const frame  = { x: 0, y: 0, widthPx: 52, heightPx: 52 }
    const next   = moveNodeIntoFreeformLayer(layout, 'knob-attack', 'ff-layer', frame)

    const movedNode = findNode(next, 'knob-attack')
    // Flow-only keys stripped.
    expect(movedNode.style?.growsToFill).toBeUndefined()
    expect(movedNode.style?.flexBasis).toBeUndefined()
  })

  it('preserves non-flow style keys', () => {
    const layout = makeLayout()
    // Add a visual style key to knob-release.
    const knobRelease = findNode(layout, 'knob-release')
    knobRelease.style = { widthPx: 60, paddingPx: 4, gapPx: 8 }

    const frame = { x: 0, y: 0, widthPx: 60, heightPx: 60 }
    const next  = moveNodeIntoFreeformLayer(layout, 'knob-release', 'ff-layer', frame)

    const movedNode = findNode(next, 'knob-release')
    expect(movedNode.style?.widthPx).toBe(60)       // kept
    expect(movedNode.style?.paddingPx).toBeUndefined() // stripped
    expect(movedNode.style?.gapPx).toBeUndefined()    // stripped
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 4. moveNodeIntoFreeformLayer — rejection cases
// ─────────────────────────────────────────────────────────────────────────────

describe('moveNodeIntoFreeformLayer — rejections', () => {
  it('throws for root node', () => {
    const layout = makeLayout()
    const frame  = { x: 0, y: 0, widthPx: 80, heightPx: 40 }
    expect(() => moveNodeIntoFreeformLayer(layout, 'root', 'ff-layer', frame)).toThrow()
  })

  it('throws for container nodes', () => {
    const layout = makeLayout()
    const frame  = { x: 0, y: 0, widthPx: 80, heightPx: 40 }
    expect(() => moveNodeIntoFreeformLayer(layout, 'body-row', 'ff-layer', frame)).toThrow(
      /cannot be moved/,
    )
  })

  it('throws if target layer does not exist', () => {
    const layout = makeLayout()
    const frame  = { x: 0, y: 0, widthPx: 80, heightPx: 40 }
    expect(() => moveNodeIntoFreeformLayer(layout, 'knob-attack', 'nonexistent', frame)).toThrow()
  })

  it('throws if target id is not a freeformLayer', () => {
    const layout = makeLayout()
    const frame  = { x: 0, y: 0, widthPx: 80, heightPx: 40 }
    expect(() => moveNodeIntoFreeformLayer(layout, 'knob-attack', 'body-row', frame)).toThrow(
      /not a freeform layer/,
    )
  })

  it('throws if node does not exist', () => {
    const layout = makeLayout()
    const frame  = { x: 0, y: 0, widthPx: 80, heightPx: 40 }
    expect(() => moveNodeIntoFreeformLayer(layout, 'does-not-exist', 'ff-layer', frame)).toThrow()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 5. moveNodesIntoFreeformLayer — batch move
// ─────────────────────────────────────────────────────────────────────────────

describe('moveNodesIntoFreeformLayer', () => {
  it('moves multiple nodes in order', () => {
    const layout = makeLayout()
    const nodeFrames = [
      { nodeId: 'knob-attack',  frame: { x: 10, y: 10, widthPx: 52, heightPx: 52 } },
      { nodeId: 'knob-release', frame: { x: 70, y: 10, widthPx: 52, heightPx: 52 } },
    ]
    const next = moveNodesIntoFreeformLayer(layout, nodeFrames, 'ff-layer')

    const ffLayer = findNode(next, 'ff-layer')
    expect(ffLayer.children).toHaveLength(2)
    expect(ffLayer.children[0].id).toBe('knob-attack')
    expect(ffLayer.children[1].id).toBe('knob-release')

    // Old parent is now empty.
    const bodyRow = findNode(next, 'body-row')
    expect(bodyRow.children).toHaveLength(0)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 6. convertContainerToFreeformLayer — converts a row of knobs
// ─────────────────────────────────────────────────────────────────────────────

describe('convertContainerToFreeformLayer', () => {
  it('replaces the container with a freeformLayer at the same sibling position', () => {
    const layout = makeLayout()
    const frames = {
      __container__:  { widthPx: 480, heightPx: 80 },
      'knob-attack':  { x: 10, y: 10, widthPx: 52, heightPx: 52 },
      'knob-release': { x: 70, y: 10, widthPx: 52, heightPx: 52 },
    }
    const next = convertContainerToFreeformLayer(layout, 'body-row', frames, { layerId: 'new-ff' })

    // body-row is gone.
    expect(findNode(next, 'body-row')).toBeNull()

    // New freeformLayer exists at root level.
    const newLayer = findNode(next, 'new-ff')
    expect(newLayer).not.toBeNull()
    expect(newLayer.type).toBe('freeformLayer')
  })

  it('sets layer dimensions from __container__ measured frame', () => {
    const layout = makeLayout()
    const frames = {
      __container__:  { widthPx: 360, heightPx: 90 },
      'knob-attack':  { x: 0, y: 0, widthPx: 52, heightPx: 52 },
      'knob-release': { x: 60, y: 0, widthPx: 52, heightPx: 52 },
    }
    const next = convertContainerToFreeformLayer(layout, 'body-row', frames, { layerId: 'new-ff' })

    const newLayer = findNode(next, 'new-ff')
    expect(newLayer.style.widthPx).toBe(360)
    expect(newLayer.style.heightPx).toBe(90)
  })

  it('preserves child ids and props', () => {
    const layout = makeLayout()
    const frames = {
      __container__:  { widthPx: 480, heightPx: 80 },
      'knob-attack':  { x: 10, y: 10, widthPx: 52, heightPx: 52 },
      'knob-release': { x: 70, y: 10, widthPx: 52, heightPx: 52 },
    }
    const next = convertContainerToFreeformLayer(layout, 'body-row', frames, { layerId: 'new-ff' })

    const newLayer = findNode(next, 'new-ff')
    const attackNode  = newLayer.children.find(c => c.id === 'knob-attack')
    const releaseNode = newLayer.children.find(c => c.id === 'knob-release')

    expect(attackNode).not.toBeUndefined()
    expect(attackNode.props.param).toBe('attack')
    expect(attackNode.props.label).toBe('Attack')
    expect(attackNode.props.appearance).toEqual({ preset: 'xleth.blue' })
    expect(attackNode.props.frame).toEqual({ x: 10, y: 10, widthPx: 52, heightPx: 52 })

    expect(releaseNode).not.toBeUndefined()
    expect(releaseNode.props.param).toBe('release')
  })

  it('strips flow-only style keys from converted children', () => {
    const layout = makeLayout()
    const frames = {
      __container__: { widthPx: 480, heightPx: 80 },
      'knob-attack':  { x: 0, y: 0, widthPx: 52, heightPx: 52 },
      'knob-release': { x: 60, y: 0, widthPx: 52, heightPx: 52 },
    }
    const next = convertContainerToFreeformLayer(layout, 'body-row', frames, { layerId: 'new-ff' })

    const newLayer   = findNode(next, 'new-ff')
    const attackNode = newLayer.children.find(c => c.id === 'knob-attack')
    // growsToFill and flexBasis were on knob-attack — must be gone.
    expect(attackNode.style?.growsToFill).toBeUndefined()
    expect(attackNode.style?.flexBasis).toBeUndefined()
  })

  it('flattens leaf descendants from nested containers', () => {
    const layout  = makeLayout()
    const bodyRow = findNode(layout, 'body-row')
    // Wrap knob-release in a nested column.
    const knobRelease = bodyRow.children.find(c => c.id === 'knob-release')
    bodyRow.children = [
      bodyRow.children.find(c => c.id === 'knob-attack'),
      { id: 'nested-col', type: 'column', children: [knobRelease] },
    ]

    const frames = {
      __container__:  { widthPx: 480, heightPx: 80 },
      'knob-attack':  { x: 10, y: 10, widthPx: 52, heightPx: 52 },
      'knob-release': { x: 70, y: 10, widthPx: 52, heightPx: 52 },
    }
    const next = convertContainerToFreeformLayer(layout, 'body-row', frames, { layerId: 'new-ff' })

    const newLayer = findNode(next, 'new-ff')
    // Both leaf nodes are direct children of the new freeformLayer.
    expect(newLayer.children).toHaveLength(2)
    expect(newLayer.children.find(c => c.id === 'knob-attack')).toBeDefined()
    expect(newLayer.children.find(c => c.id === 'knob-release')).toBeDefined()
    // Intermediate container is gone.
    expect(findNode(next, 'nested-col')).toBeNull()
  })

  it('throws when a nested freeformLayer is encountered', () => {
    const layout  = makeLayout()
    const bodyRow = findNode(layout, 'body-row')
    bodyRow.children.push({ id: 'nested-ff', type: 'freeformLayer', children: [] })

    const frames = { __container__: { widthPx: 480, heightPx: 80 } }
    expect(() =>
      convertContainerToFreeformLayer(layout, 'body-row', frames, { layerId: 'new-ff' }),
    ).toThrow(/freeformLayer/)
  })

  it('rejects if container is root', () => {
    const layout = makeLayout()
    expect(() =>
      convertContainerToFreeformLayer(layout, 'root', {}, {}),
    ).toThrow(/Root node/)
  })

  it('rejects non-flow containers (panel, tabGroup)', () => {
    const layout = makeLayout()
    expect(() =>
      convertContainerToFreeformLayer(layout, 'root', {}, {}),
    ).toThrow()
    // freeformLayer itself also cannot be converted.
    expect(() =>
      convertContainerToFreeformLayer(layout, 'ff-layer', {}, { layerId: 'x' }),
    ).toThrow(/cannot be converted/)
  })

  it('uses fallback frames for children without measured positions', () => {
    const layout = makeLayout()
    // No child frames provided — should use fallback { x:0, y:0, widthPx:80, heightPx:40 }.
    const frames = { __container__: { widthPx: 480, heightPx: 80 } }
    const next   = convertContainerToFreeformLayer(layout, 'body-row', frames, { layerId: 'new-ff' })

    const newLayer   = findNode(next, 'new-ff')
    const attackNode = newLayer.children.find(c => c.id === 'knob-attack')
    expect(attackNode.props.frame).toEqual({ x: 0, y: 0, widthPx: 80, heightPx: 40 })
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 10. freeformMeasure — buildFrameFromRects geometry
// ─────────────────────────────────────────────────────────────────────────────

describe('buildFrameFromRects', () => {
  it('computes x/y relative to layer top-left', () => {
    const nodeRect  = { left: 150, top: 80, width: 52, height: 52 }
    const layerRect = { left: 100, top: 60, width: 480, height: 160 }
    const frame     = buildFrameFromRects(nodeRect, layerRect)
    expect(frame.x).toBe(50)
    expect(frame.y).toBe(20)
    expect(frame.widthPx).toBe(52)
    expect(frame.heightPx).toBe(52)
  })

  it('uses defaultWidth/defaultHeight when rect dimensions are 0', () => {
    const nodeRect  = { left: 0, top: 0, width: 0, height: 0 }
    const layerRect = { left: 0, top: 0, width: 480, height: 160 }
    const frame     = buildFrameFromRects(nodeRect, layerRect, { defaultWidth: 120, defaultHeight: 30 })
    expect(frame.widthPx).toBe(120)
    expect(frame.heightPx).toBe(30)
  })

  it('clamps large values to frame bounds', () => {
    const nodeRect  = { left: -3000, top: -3000, width: 9000, height: 9000 }
    const layerRect = { left: 0,     top: 0,     width: 480,  height: 160 }
    const frame     = buildFrameFromRects(nodeRect, layerRect)
    // x/y clamped to [-2000, 4000]; width/height clamped to [1, 4096]
    expect(frame.x).toBe(-2000)
    expect(frame.y).toBe(-2000)
    expect(frame.widthPx).toBe(4096)
    expect(frame.heightPx).toBe(4096)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 11 & 12. freeformMeasure — DOM queries
// ─────────────────────────────────────────────────────────────────────────────

describe('getNodeRectInPreview', () => {
  it('returns error when previewRootEl is null', () => {
    const result = getNodeRectInPreview(null, 'node-1')
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/Missing/)
  })

  it('returns error when element is not found', () => {
    const fakeRoot = { querySelector: () => null }
    const result   = getNodeRectInPreview(fakeRoot, 'missing-node')
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/DOM node not found/)
  })

  it('returns the bounding rect when element is found', () => {
    const fakeRect = { left: 10, top: 20, width: 100, height: 50 }
    const fakeEl   = { getBoundingClientRect: () => fakeRect }
    const fakeRoot = { querySelector: () => fakeEl }
    const result   = getNodeRectInPreview(fakeRoot, 'some-node')
    expect(result.ok).toBe(true)
    expect(result.rect).toBe(fakeRect)
  })
})

describe('measureChildrenForFreeform', () => {
  it('computes frames relative to layer rect', () => {
    const layerRect  = { left: 100, top: 50, width: 480, height: 160 }
    const child1Rect = { left: 120, top: 60, width: 52, height: 52 }
    const child2Rect = { left: 180, top: 60, width: 52, height: 52 }

    const elements = {
      'ff-layer': { getBoundingClientRect: () => layerRect },
      'knob-1':   { getBoundingClientRect: () => child1Rect },
      'knob-2':   { getBoundingClientRect: () => child2Rect },
    }
    const fakeRoot = {
      querySelector(sel) {
        const match = sel.match(/data-pluginui-id="([^"]+)"/)
        return match ? elements[match[1]] ?? null : null
      },
    }

    const result = measureChildrenForFreeform(fakeRoot, ['knob-1', 'knob-2'], 'ff-layer')
    expect(result.ok).toBe(true)
    expect(result.frames['knob-1']).toEqual({ x: 20, y: 10, widthPx: 52, heightPx: 52 })
    expect(result.frames['knob-2']).toEqual({ x: 80, y: 10, widthPx: 52, heightPx: 52 })
  })

  it('returns errors for missing children, partial frames for found ones', () => {
    const layerRect = { left: 0, top: 0, width: 480, height: 160 }
    const knobRect  = { left: 10, top: 10, width: 52, height: 52 }

    const fakeRoot = {
      querySelector(sel) {
        if (sel.includes('ff-layer')) return { getBoundingClientRect: () => layerRect }
        if (sel.includes('knob-ok'))  return { getBoundingClientRect: () => knobRect }
        return null
      },
    }

    const result = measureChildrenForFreeform(fakeRoot, ['knob-ok', 'knob-missing'], 'ff-layer')
    expect(result.ok).toBe(false)
    expect(result.errors).toHaveLength(1)
    expect(result.frames['knob-ok']).toBeDefined()
    expect(result.frames['knob-missing']).toBeUndefined()
  })

  it('fails early when layer element is not found', () => {
    const fakeRoot = { querySelector: () => null }
    const result   = measureChildrenForFreeform(fakeRoot, ['child-1'], 'missing-layer')
    expect(result.ok).toBe(false)
    expect(result.errors).toHaveLength(1)
    expect(result.frames).toEqual({})
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 13. getFreeformLayerOptions / findFirstFreeformLayer
// ─────────────────────────────────────────────────────────────────────────────

describe('getFreeformLayerOptions', () => {
  it('returns all freeformLayer nodes', () => {
    const layout  = makeLayout()
    const options = getFreeformLayerOptions(layout)
    expect(options).toHaveLength(1)
    expect(options[0].id).toBe('ff-layer')
  })

  it('returns empty array when no freeformLayer exists', () => {
    const layout  = makeLayoutNoFF()
    const options = getFreeformLayerOptions(layout)
    expect(options).toHaveLength(0)
  })

  it('returns multiple layers when present', () => {
    const layout = makeLayout()
    layout.root.children.push({
      id: 'ff-layer-2', type: 'freeformLayer',
      style: { widthPx: 480, heightPx: 80 },
      props: { snap: { gridPx: 8, enabled: true }, background: 'transparent', clip: 'panel' },
      children: [],
    })
    const options = getFreeformLayerOptions(layout)
    expect(options).toHaveLength(2)
  })
})

describe('findFirstFreeformLayer', () => {
  it('returns the id of the first freeformLayer', () => {
    expect(findFirstFreeformLayer(makeLayout())).toBe('ff-layer')
  })

  it('returns null when no freeformLayer exists', () => {
    expect(findFirstFreeformLayer(makeLayoutNoFF())).toBeNull()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 14. moveSelectedNodeToFreeform action — error paths
// ─────────────────────────────────────────────────────────────────────────────

describe('moveSelectedNodeToFreeform action', () => {
  beforeEach(() => {
    resetStore()
    setPreviewHostEl(null)
  })

  it('sets mutationError when no selection', () => {
    const layout = makeLayout()
    resetStore({ workingLayout: layout, selectedNodeId: null })
    const result = moveSelectedNodeToFreeform('ff-layer')
    expect(result.ok).toBe(false)
    expect(usePluginUIDesignerStore.getState().mutationError).toMatch(/leaf control/)
  })

  it('sets mutationError when selected node is a container', () => {
    const layout = makeLayout()
    resetStore({ workingLayout: layout, selectedNodeId: 'body-row' })
    const result = moveSelectedNodeToFreeform('ff-layer')
    expect(result.ok).toBe(false)
    expect(usePluginUIDesignerStore.getState().mutationError).toMatch(/leaf control/)
  })

  it('sets mutationError when no preview host (cannot measure)', () => {
    const layout = makeLayout()
    resetStore({ workingLayout: layout, selectedNodeId: 'knob-attack' })
    setPreviewHostEl(null)
    const result = moveSelectedNodeToFreeform('ff-layer')
    expect(result.ok).toBe(false)
    expect(usePluginUIDesignerStore.getState().mutationError).toMatch(/measure/)
  })

  it('sets mutationError when target layer does not exist', () => {
    const layout = makeLayout()
    resetStore({ workingLayout: layout, selectedNodeId: 'knob-attack' })
    const result = moveSelectedNodeToFreeform('nonexistent-layer')
    expect(result.ok).toBe(false)
    expect(usePluginUIDesignerStore.getState().mutationError).toMatch(/Freeform Layer/)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 15. convertSelectedContainerToFreeform action — error paths
// ─────────────────────────────────────────────────────────────────────────────

describe('convertSelectedContainerToFreeform action', () => {
  beforeEach(() => {
    resetStore()
    setPreviewHostEl(null)
  })

  it('sets mutationError when nothing is selected', () => {
    const layout = makeLayout()
    resetStore({ workingLayout: layout, selectedNodeId: null })
    const result = convertSelectedContainerToFreeform()
    expect(result.ok).toBe(false)
    expect(usePluginUIDesignerStore.getState().mutationError).toMatch(/row, group, or column/)
  })

  it('sets mutationError when selected node is a leaf, not a container', () => {
    const layout = makeLayout()
    resetStore({ workingLayout: layout, selectedNodeId: 'knob-attack' })
    const result = convertSelectedContainerToFreeform()
    expect(result.ok).toBe(false)
    expect(usePluginUIDesignerStore.getState().mutationError).toMatch(/row, group, or column/)
  })

  it('sets mutationError when container has a nested freeformLayer', () => {
    const layout  = makeLayout()
    const bodyRow = findNode(layout, 'body-row')
    bodyRow.children.push({ id: 'nested-ff', type: 'freeformLayer', children: [] })
    resetStore({ workingLayout: layout, selectedNodeId: 'body-row' })
    const result = convertSelectedContainerToFreeform()
    expect(result.ok).toBe(false)
    expect(usePluginUIDesignerStore.getState().mutationError).toMatch(/freeformLayer/)
  })

  it('sets mutationError when container has no eligible leaf descendants', () => {
    const layout  = makeLayout()
    const bodyRow = findNode(layout, 'body-row')
    bodyRow.children = [{ id: 'empty-col', type: 'column', children: [] }]
    resetStore({ workingLayout: layout, selectedNodeId: 'body-row' })
    const result = convertSelectedContainerToFreeform()
    expect(result.ok).toBe(false)
    expect(usePluginUIDesignerStore.getState().mutationError).toMatch(/no eligible controls/)
  })

  it('sets mutationError when preview host is unavailable', () => {
    const layout = makeLayout()
    resetStore({ workingLayout: layout, selectedNodeId: 'body-row' })
    setPreviewHostEl(null)
    const result = convertSelectedContainerToFreeform()
    expect(result.ok).toBe(false)
    expect(usePluginUIDesignerStore.getState().mutationError).toMatch(/measure/)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 16. Undo after convertContainerToFreeformLayer
// ─────────────────────────────────────────────────────────────────────────────

describe('undo after convertContainerToFreeformLayer (via store)', () => {
  beforeEach(() => resetStore())

  it('restores the original container after undo', () => {
    const layout = makeLayout()
    resetStore({ workingLayout: layout, selectedNodeId: 'body-row' })

    // Manually call the pure mutation and push it through the store.
    const frames = {
      __container__:  { widthPx: 480, heightPx: 80 },
      'knob-attack':  { x: 10, y: 10, widthPx: 52, heightPx: 52 },
      'knob-release': { x: 70, y: 10, widthPx: 52, heightPx: 52 },
    }
    const { pushUndoSnapshot, setWorkingLayout } = usePluginUIDesignerStore.getState()
    pushUndoSnapshot('convert to freeform')
    const converted = convertContainerToFreeformLayer(layout, 'body-row', frames, { layerId: 'new-ff' })
    setWorkingLayout(converted)

    // Confirm conversion is in place.
    expect(findNode(usePluginUIDesignerStore.getState().workingLayout, 'body-row')).toBeNull()
    expect(findNode(usePluginUIDesignerStore.getState().workingLayout, 'new-ff')).not.toBeNull()

    // Undo.
    const { undo } = usePluginUIDesignerStore.getState()
    const undoResult = undo()
    expect(undoResult.ok).toBe(true)

    const afterUndo = usePluginUIDesignerStore.getState().workingLayout
    expect(findNode(afterUndo, 'body-row')).not.toBeNull()
    expect(findNode(afterUndo, 'new-ff')).toBeNull()
  })
})
