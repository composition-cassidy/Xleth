import React from 'react'
import { beforeEach, describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'

import { usePluginUIDesignerStore } from '../usePluginUIDesignerStore.js'
import { addChildToSelected } from '../designerActions.js'
import { findNode, getParentInfo } from '../layoutMutations.js'
import { PALETTE_ENTRIES, DESIGNER_VISIBLE_TYPES } from '../paletteCatalog.js'
import { SHIPPED_LAYOUTS } from '../../layouts/index.js'

import { LayoutTreeContent } from '../LayoutTreePanel.jsx'
import { InspectorContent } from '../InspectorPanel.jsx'

import { FRAME_BOUNDS, clampFrameField } from '../inspectors/FrameFields.jsx'
import DecorTextInspector from '../inspectors/DecorTextInspector.jsx'
import DecorLineInspector from '../inspectors/DecorLineInspector.jsx'
import DecorShapeInspector from '../inspectors/DecorShapeInspector.jsx'
import DecalInspector from '../inspectors/DecalInspector.jsx'
import FreeformLayerInspector from '../inspectors/FreeformLayerInspector.jsx'
import { PLACEHOLDER_DECAL_ID } from '../../appearance/decals/placeholder.js'

// ── Helpers ───────────────────────────────────────────────────────────────────

function cloneCompressorLayout() {
  return JSON.parse(JSON.stringify(SHIPPED_LAYOUTS.compressor))
}

function paletteTypes() {
  return new Set(PALETTE_ENTRIES.map(e => e.type))
}

// ── Palette entries ───────────────────────────────────────────────────────────

describe('Freeform-B palette entries', () => {
  it('exposes freeformLayer, decorText, decorLine, decorShape, decal', () => {
    const types = paletteTypes()
    expect(types.has('freeformLayer')).toBe(true)
    expect(types.has('decorText')).toBe(true)
    expect(types.has('decorLine')).toBe(true)
    expect(types.has('decorShape')).toBe(true)
    expect(types.has('decal')).toBe(true)
  })

  it('does not expose forbidden types', () => {
    const types = paletteTypes()
    for (const banned of ['image', 'html', 'script', 'webview', 'iframe', 'panel', 'tabGroup', 'button']) {
      expect(types.has(banned), `palette should not expose "${banned}"`).toBe(false)
    }
  })

  it('DESIGNER_VISIBLE_TYPES contains all 5 new freeform types', () => {
    expect(DESIGNER_VISIBLE_TYPES.has('freeformLayer')).toBe(true)
    expect(DESIGNER_VISIBLE_TYPES.has('decorText')).toBe(true)
    expect(DESIGNER_VISIBLE_TYPES.has('decorLine')).toBe(true)
    expect(DESIGNER_VISIBLE_TYPES.has('decorShape')).toBe(true)
    expect(DESIGNER_VISIBLE_TYPES.has('decal')).toBe(true)
  })

  it('freeformLayer template has correct defaults', () => {
    const entry = PALETTE_ENTRIES.find(e => e.type === 'freeformLayer')
    expect(entry.template.style.widthPx).toBe(480)
    expect(entry.template.style.heightPx).toBe(160)
    expect(entry.template.props.snap.gridPx).toBe(8)
    expect(entry.template.props.snap.enabled).toBe(true)
    expect(entry.template.props.background).toBe('transparent')
    expect(entry.template.props.clip).toBe('panel')
  })

  it('decorText template has correct defaults', () => {
    const entry = PALETTE_ENTRIES.find(e => e.type === 'decorText')
    expect(entry.template.props.frame.x).toBe(16)
    expect(entry.template.props.frame.y).toBe(16)
    expect(entry.template.props.frame.widthPx).toBe(120)
    expect(entry.template.props.frame.heightPx).toBe(18)
    expect(entry.template.props.text).toBe('Text')
  })

  it('decorLine template uses lineStyle prop (not style)', () => {
    const entry = PALETTE_ENTRIES.find(e => e.type === 'decorLine')
    expect(entry.template.props.lineStyle).toBeDefined()
    expect(entry.template.props).not.toHaveProperty('style')
  })

  it('decal template uses assetId builtin.placeholder.missing', () => {
    const entry = PALETTE_ENTRIES.find(e => e.type === 'decal')
    expect(entry.template.props.assetId).toBe('builtin.placeholder.missing')
  })
})

// ── Palette insertion actions ─────────────────────────────────────────────────

describe('Freeform-B insertion actions', () => {
  beforeEach(() => {
    usePluginUIDesignerStore.getState().reset()
  })

  it('adds freeformLayer into a normal container when root is selected', async () => {
    await usePluginUIDesignerStore.getState().loadInitial('compressor')
    usePluginUIDesignerStore.getState().setSelectedNodeId('root')

    const result = addChildToSelected('freeformLayer')
    expect(result.ok).toBe(true)

    const state = usePluginUIDesignerStore.getState()
    const newNode = findNode(state.workingLayout, result.selectedNodeId)
    expect(newNode).not.toBeNull()
    expect(newNode.type).toBe('freeformLayer')
    expect(newNode.style.widthPx).toBe(480)
    expect(newNode.props.snap.gridPx).toBe(8)
  })

  it('adds decorText when freeformLayer is selected', async () => {
    await usePluginUIDesignerStore.getState().loadInitial('compressor')
    usePluginUIDesignerStore.getState().setSelectedNodeId('root')
    const ffResult = addChildToSelected('freeformLayer')
    expect(ffResult.ok).toBe(true)

    const ffId = ffResult.selectedNodeId
    usePluginUIDesignerStore.getState().setSelectedNodeId(ffId)

    const result = addChildToSelected('decorText')
    expect(result.ok).toBe(true)

    const state = usePluginUIDesignerStore.getState()
    const newNode = findNode(state.workingLayout, result.selectedNodeId)
    expect(newNode).not.toBeNull()
    expect(newNode.type).toBe('decorText')
    expect(newNode.props.frame).toBeDefined()
    expect(newNode.props.text).toBe('Text')

    const parentInfo = getParentInfo(state.workingLayout, result.selectedNodeId)
    expect(parentInfo.parent.id).toBe(ffId)
  })

  it('adds decorLine, decorShape, decal when freeformLayer is selected', async () => {
    await usePluginUIDesignerStore.getState().loadInitial('compressor')
    usePluginUIDesignerStore.getState().setSelectedNodeId('root')
    const ffResult = addChildToSelected('freeformLayer')
    const ffId = ffResult.selectedNodeId
    usePluginUIDesignerStore.getState().setSelectedNodeId(ffId)

    for (const type of ['decorLine', 'decorShape', 'decal']) {
      usePluginUIDesignerStore.getState().setSelectedNodeId(ffId)
      const result = addChildToSelected(type)
      expect(result.ok, `adding ${type} should succeed`).toBe(true)
      const state = usePluginUIDesignerStore.getState()
      const newNode = findNode(state.workingLayout, result.selectedNodeId)
      expect(newNode.type).toBe(type)
      expect(newNode.props.frame).toBeDefined()
    }
  })

  it('rejects decoration node when no freeformLayer is selected, sets mutationError', async () => {
    await usePluginUIDesignerStore.getState().loadInitial('compressor')
    usePluginUIDesignerStore.getState().setSelectedNodeId('k-threshold')

    const result = addChildToSelected('decorText')
    expect(result.ok).toBe(false)

    const state = usePluginUIDesignerStore.getState()
    expect(state.mutationError).toContain('Freeform Layer')
  })

  it('rejects decoration node with no selection, sets specific error', async () => {
    await usePluginUIDesignerStore.getState().loadInitial('compressor')
    usePluginUIDesignerStore.getState().setSelectedNodeId(null)

    const result = addChildToSelected('decorShape')
    expect(result.ok).toBe(false)
    expect(usePluginUIDesignerStore.getState().mutationError).toContain('Freeform Layer')
  })

  it('inserts decor as sibling after a selected child already inside freeformLayer', async () => {
    await usePluginUIDesignerStore.getState().loadInitial('compressor')
    usePluginUIDesignerStore.getState().setSelectedNodeId('root')
    const ffResult = addChildToSelected('freeformLayer')
    const ffId = ffResult.selectedNodeId

    // Add first child
    usePluginUIDesignerStore.getState().setSelectedNodeId(ffId)
    const firstResult = addChildToSelected('decorText')
    const firstChildId = firstResult.selectedNodeId

    // Select the first child, then add another decor — should be a sibling
    usePluginUIDesignerStore.getState().setSelectedNodeId(firstChildId)
    const secondResult = addChildToSelected('decorLine')
    expect(secondResult.ok).toBe(true)

    const state = usePluginUIDesignerStore.getState()
    const ffNode = findNode(state.workingLayout, ffId)
    expect(ffNode.children.length).toBe(2)
    // Second child should come after the first (index 1)
    expect(ffNode.children[0].id).toBe(firstChildId)
    expect(ffNode.children[1].id).toBe(secondResult.selectedNodeId)
  })

  it('inserted freeform/decor nodes get deterministic unique ids', async () => {
    await usePluginUIDesignerStore.getState().loadInitial('compressor')
    usePluginUIDesignerStore.getState().setSelectedNodeId('root')

    const r1 = addChildToSelected('freeformLayer')
    const r2 = addChildToSelected('freeformLayer')

    expect(r1.selectedNodeId).not.toBe(r2.selectedNodeId)
    expect(r1.selectedNodeId).toBeTruthy()
    expect(r2.selectedNodeId).toBeTruthy()
  })
})

// ── FrameFields helpers ───────────────────────────────────────────────────────

describe('FrameFields clampFrameField', () => {
  it('clamps x within -2000..4000', () => {
    expect(clampFrameField('x', -3000)).toBe(-2000)
    expect(clampFrameField('x', 5000)).toBe(4000)
    expect(clampFrameField('x', 100)).toBe(100)
  })

  it('clamps y within -2000..4000', () => {
    expect(clampFrameField('y', -9999)).toBe(-2000)
    expect(clampFrameField('y', 9999)).toBe(4000)
  })

  it('clamps widthPx to minimum 1', () => {
    expect(clampFrameField('widthPx', 0)).toBe(1)
    expect(clampFrameField('widthPx', -100)).toBe(1)
    expect(clampFrameField('widthPx', 50)).toBe(50)
  })

  it('clamps widthPx to maximum 4096', () => {
    expect(clampFrameField('widthPx', 9999)).toBe(4096)
  })

  it('clamps heightPx to minimum 1', () => {
    expect(clampFrameField('heightPx', 0)).toBe(1)
  })

  it('clamps zIndex within 0..999', () => {
    expect(clampFrameField('zIndex', -1)).toBe(0)
    expect(clampFrameField('zIndex', 1000)).toBe(999)
    expect(clampFrameField('zIndex', 5)).toBe(5)
  })

  it('FRAME_BOUNDS exports correct ranges', () => {
    expect(FRAME_BOUNDS.x.min).toBe(-2000)
    expect(FRAME_BOUNDS.x.max).toBe(4000)
    expect(FRAME_BOUNDS.widthPx.min).toBe(1)
    expect(FRAME_BOUNDS.widthPx.max).toBe(4096)
    expect(FRAME_BOUNDS.zIndex.max).toBe(999)
  })
})

// ── Inspector rendering (pure output checks) ──────────────────────────────────

describe('DecorTextInspector rendering', () => {
  function makeNode(propOverrides = {}) {
    return {
      id: 'dt-test', type: 'decorText',
      props: {
        frame: { x: 0, y: 0, widthPx: 80, heightPx: 18 },
        text: 'Hello', variant: 'default', align: 'left',
        letterSpacing: 'normal', textToken: 'text.primary',
        ...propOverrides,
      },
    }
  }

  it('renders variant options including header, muted, caption', () => {
    const html = renderToStaticMarkup(<DecorTextInspector node={makeNode()} onPatchProps={() => {}} />)
    expect(html).toContain('header')
    expect(html).toContain('muted')
    expect(html).toContain('caption')
  })

  it('renders text token select with text.* options', () => {
    const html = renderToStaticMarkup(<DecorTextInspector node={makeNode()} onPatchProps={() => {}} />)
    expect(html).toContain('text.primary')
    expect(html).toContain('text.muted')
    expect(html).toContain('text.subtle')
  })

  it('renders align and letterSpacing options', () => {
    const html = renderToStaticMarkup(<DecorTextInspector node={makeNode()} onPatchProps={() => {}} />)
    expect(html).toContain('center')
    expect(html).toContain('wide')
    expect(html).toContain('wider')
  })

  it('includes FrameFields (x, y, widthPx, heightPx, zIndex)', () => {
    const html = renderToStaticMarkup(<DecorTextInspector node={makeNode()} onPatchProps={() => {}} />)
    expect(html).toContain('widthPx')
    expect(html).toContain('heightPx')
    expect(html).toContain('zIndex')
  })

  it('does not contain URL or path field labels', () => {
    const html = renderToStaticMarkup(<DecorTextInspector node={makeNode()} onPatchProps={() => {}} />)
    expect(html).not.toMatch(/\bsrc\b/)
    expect(html).not.toMatch(/\bhref\b/)
    expect(html).not.toMatch(/\burl\b/i)
    expect(html).not.toMatch(/\bpath\b/i)
  })
})

describe('DecorLineInspector rendering', () => {
  function makeNode(propOverrides = {}) {
    return {
      id: 'dl-test', type: 'decorLine',
      props: {
        frame: { x: 0, y: 0, widthPx: 80, heightPx: 1 },
        orientation: 'horizontal', thickness: 'hair', lineStyle: 'solid',
        strokeToken: 'text.subtle', ...propOverrides,
      },
    }
  }

  it('renders lineStyle field (not style)', () => {
    const html = renderToStaticMarkup(<DecorLineInspector node={makeNode()} onPatchProps={() => {}} />)
    expect(html).toContain('lineStyle')
    // Must not have a raw "style" label that would confuse with node.style
    expect(html).not.toMatch(/[^a-z]style[^A-Z]/)
  })

  it('renders orientation options', () => {
    const html = renderToStaticMarkup(<DecorLineInspector node={makeNode()} onPatchProps={() => {}} />)
    expect(html).toContain('horizontal')
    expect(html).toContain('vertical')
  })

  it('renders thickness options', () => {
    const html = renderToStaticMarkup(<DecorLineInspector node={makeNode()} onPatchProps={() => {}} />)
    expect(html).toContain('hair')
    expect(html).toContain('thin')
    expect(html).toContain('thick')
  })

  it('renders stroke token options from accent, text, meter groups', () => {
    const html = renderToStaticMarkup(<DecorLineInspector node={makeNode()} onPatchProps={() => {}} />)
    expect(html).toContain('accent.primary')
    expect(html).toContain('text.subtle')
    expect(html).toContain('meter.good')
  })
})

describe('DecorShapeInspector rendering', () => {
  function makeNode(propOverrides = {}) {
    return {
      id: 'ds-test', type: 'decorShape',
      props: {
        frame: { x: 0, y: 0, widthPx: 64, heightPx: 64 },
        shape: 'rect', cornerRadius: 4,
        fillToken: 'surface.control', strokeToken: 'stroke.none',
        strokeWidth: 0, opacity: 100, ...propOverrides,
      },
    }
  }

  it('renders shape options: rect, roundedRect, circle, pill', () => {
    const html = renderToStaticMarkup(<DecorShapeInspector node={makeNode()} onPatchProps={() => {}} />)
    expect(html).toContain('rect')
    expect(html).toContain('roundedRect')
    expect(html).toContain('circle')
    expect(html).toContain('pill')
  })

  it('renders fill token options including fill.none', () => {
    const html = renderToStaticMarkup(<DecorShapeInspector node={makeNode()} onPatchProps={() => {}} />)
    expect(html).toContain('fill.none')
    expect(html).toContain('surface.panel')
    expect(html).toContain('accent.primary')
  })

  it('renders stroke token options including stroke.none', () => {
    const html = renderToStaticMarkup(<DecorShapeInspector node={makeNode()} onPatchProps={() => {}} />)
    expect(html).toContain('stroke.none')
  })

  it('renders opacity options as closed enum (25, 50, 75, 100)', () => {
    const html = renderToStaticMarkup(<DecorShapeInspector node={makeNode()} onPatchProps={() => {}} />)
    expect(html).toContain('25%')
    expect(html).toContain('50%')
    expect(html).toContain('75%')
    expect(html).toContain('100%')
  })

  it('renders strokeWidth options 0-4', () => {
    const html = renderToStaticMarkup(<DecorShapeInspector node={makeNode()} onPatchProps={() => {}} />)
    expect(html).toContain('0 (none)')
    expect(html).toContain('4 px')
  })

  it('does not contain arbitrary CSS or color input', () => {
    const html = renderToStaticMarkup(<DecorShapeInspector node={makeNode()} onPatchProps={() => {}} />)
    expect(html).not.toContain('type="color"')
    expect(html).not.toContain('placeholder="rgb')
    expect(html).not.toContain('cssText')
  })
})

describe('DecalInspector rendering', () => {
  function makeNode(propOverrides = {}) {
    return {
      id: 'dcl-test', type: 'decal',
      props: {
        frame:   { x: 0, y: 0, widthPx: 64, heightPx: 64 },
        assetId: PLACEHOLDER_DECAL_ID,
        fit: 'contain', opacity: 100, ...propOverrides,
      },
    }
  }

  it('renders only builtin.placeholder.missing as assetId option', () => {
    const html = renderToStaticMarkup(<DecalInspector node={makeNode()} onPatchProps={() => {}} />)
    expect(html).toContain(PLACEHOLDER_DECAL_ID)
  })

  it('does not render URL or path input', () => {
    const html = renderToStaticMarkup(<DecalInspector node={makeNode()} onPatchProps={() => {}} />)
    expect(html).not.toContain('type="file"')
    expect(html).not.toContain('type="url"')
    expect(html).not.toMatch(/placeholder.*http/i)
  })

  it('renders fit options: contain, cover, stretch', () => {
    const html = renderToStaticMarkup(<DecalInspector node={makeNode()} onPatchProps={() => {}} />)
    expect(html).toContain('contain')
    expect(html).toContain('cover')
    expect(html).toContain('stretch')
  })

  it('renders tintToken with tint.none option', () => {
    const html = renderToStaticMarkup(<DecalInspector node={makeNode()} onPatchProps={() => {}} />)
    expect(html).toContain('tint.none')
    expect(html).toContain('tintToken')
  })
})

// ── FreeformLayerInspector rendering ─────────────────────────────────────────

describe('FreeformLayerInspector rendering', () => {
  function makeNode(overrides = {}) {
    return {
      id: 'ff-test', type: 'freeformLayer',
      style: { widthPx: 480, heightPx: 160 },
      props: { snap: { gridPx: 8, enabled: true }, background: 'transparent', clip: 'panel' },
      children: [],
      ...overrides,
    }
  }

  it('renders widthPx and heightPx inputs', () => {
    const html = renderToStaticMarkup(
      <FreeformLayerInspector node={makeNode()} onPatchProps={() => {}} onPatchStyle={() => {}} />,
    )
    expect(html).toContain('widthPx')
    expect(html).toContain('heightPx')
  })

  it('renders snap.gridPx and snap.enabled', () => {
    const html = renderToStaticMarkup(
      <FreeformLayerInspector node={makeNode()} onPatchProps={() => {}} onPatchStyle={() => {}} />,
    )
    expect(html).toContain('snap.gridPx')
    expect(html).toContain('snap.enabled')
  })

  it('renders background and clip selects', () => {
    const html = renderToStaticMarkup(
      <FreeformLayerInspector node={makeNode()} onPatchProps={() => {}} onPatchStyle={() => {}} />,
    )
    expect(html).toContain('background')
    expect(html).toContain('transparent')
    expect(html).toContain('clip')
    expect(html).toContain('panel')
  })
})

// ── Layout tree frame badge ───────────────────────────────────────────────────

describe('LayoutTree frame badge for freeform children', () => {
  function makeLayoutWithFF() {
    return {
      schemaVersion: 1,
      pluginId: 'compressor',
      root: {
        id: 'root', type: 'panel',
        children: [{
          id: 'ff-layer', type: 'freeformLayer',
          style: { widthPx: 200, heightPx: 100 },
          props: { snap: { gridPx: 8, enabled: true }, background: 'transparent', clip: 'panel' },
          children: [{
            id: 'dt-child', type: 'decorText',
            props: {
              frame: { x: 10, y: 20, widthPx: 80, heightPx: 16 },
              text: 'DYNAMICS', variant: 'header', align: 'left',
              letterSpacing: 'normal', textToken: 'text.primary',
            },
          }],
        }],
      },
    }
  }

  it('renders [FF] badge for freeformLayer rows', () => {
    const html = renderToStaticMarkup(
      <LayoutTreeContent
        layout={makeLayoutWithFF()}
        selectedNodeId={null}
        expandedNodeIds={new Set(['root', 'ff-layer'])}
        onSelect={() => {}}
        onToggleExpanded={() => {}}
        onDuplicate={() => {}}
        onRemove={() => {}}
        onMoveUp={() => {}}
        onMoveDown={() => {}}
      />,
    )
    expect(html).toContain('[FF]')
    expect(html).toContain('freeformLayer')
  })

  it('renders frame badge showing x,y for freeform children', () => {
    const html = renderToStaticMarkup(
      <LayoutTreeContent
        layout={makeLayoutWithFF()}
        selectedNodeId={null}
        expandedNodeIds={new Set(['root', 'ff-layer'])}
        onSelect={() => {}}
        onToggleExpanded={() => {}}
        onDuplicate={() => {}}
        onRemove={() => {}}
        onMoveUp={() => {}}
        onMoveDown={() => {}}
      />,
    )
    // The frame badge should show "10,20" (x=10, y=20 from the dt-child frame)
    expect(html).toContain('10,20')
  })

  it('freeformLayer expand/collapse works (has children in tree)', () => {
    const html = renderToStaticMarkup(
      <LayoutTreeContent
        layout={makeLayoutWithFF()}
        selectedNodeId={null}
        expandedNodeIds={new Set(['root', 'ff-layer'])}
        onSelect={() => {}}
        onToggleExpanded={() => {}}
        onDuplicate={() => {}}
        onRemove={() => {}}
        onMoveUp={() => {}}
        onMoveDown={() => {}}
      />,
    )
    // When expanded, child should be visible
    expect(html).toContain('DYNAMICS')
    expect(html).toContain('dt-child')
  })
})

// ── InspectorPanel routing ────────────────────────────────────────────────────

describe('InspectorPanel routes to correct inspector', () => {
  function renderInspector(node) {
    return renderToStaticMarkup(
      <InspectorContent
        node={node}
        allNodeIds={new Set([node.id])}
        validationErrors={[]}
        onRename={() => {}}
        onPatchProps={() => {}}
        onPatchStyle={() => {}}
      />,
    )
  }

  it('routes decorText to DecorTextInspector (shows variant/textToken fields)', () => {
    const html = renderInspector({
      id: 'dt', type: 'decorText',
      props: { frame: { x: 0, y: 0, widthPx: 80, heightPx: 16 }, text: 'Hi', variant: 'default', align: 'left', letterSpacing: 'normal', textToken: 'text.primary' },
    })
    expect(html).toContain('textToken')
    expect(html).toContain('variant')
  })

  it('routes decorLine to DecorLineInspector (shows lineStyle field)', () => {
    const html = renderInspector({
      id: 'dl', type: 'decorLine',
      props: { frame: { x: 0, y: 0, widthPx: 80, heightPx: 1 }, orientation: 'horizontal', thickness: 'hair', lineStyle: 'solid', strokeToken: 'text.subtle' },
    })
    expect(html).toContain('lineStyle')
    expect(html).toContain('strokeToken')
  })

  it('routes decorShape to DecorShapeInspector (shows fillToken/shape)', () => {
    const html = renderInspector({
      id: 'ds', type: 'decorShape',
      props: { frame: { x: 0, y: 0, widthPx: 64, heightPx: 64 }, shape: 'rect', cornerRadius: 0, fillToken: 'fill.none', strokeToken: 'stroke.none', strokeWidth: 0, opacity: 100 },
    })
    expect(html).toContain('fillToken')
    expect(html).toContain('shape')
  })

  it('routes decal to DecalInspector (shows assetId)', () => {
    const html = renderInspector({
      id: 'dcl', type: 'decal',
      props: { frame: { x: 0, y: 0, widthPx: 64, heightPx: 64 }, assetId: 'builtin.placeholder.missing', fit: 'contain', opacity: 100 },
    })
    expect(html).toContain('assetId')
    expect(html).toContain('builtin.placeholder.missing')
  })

  it('routes freeformLayer to FreeformLayerInspector', () => {
    const html = renderInspector({
      id: 'ff', type: 'freeformLayer',
      style: { widthPx: 480, heightPx: 160 },
      props: { snap: { gridPx: 8, enabled: true }, background: 'transparent', clip: 'panel' },
      children: [],
    })
    expect(html).toContain('snap.gridPx')
    expect(html).toContain('background')
  })
})
