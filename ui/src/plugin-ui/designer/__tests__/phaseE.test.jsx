import { beforeEach, describe, expect, it } from 'vitest'

import { usePluginUIDesignerStore } from '../usePluginUIDesignerStore.js'
import { addChildToSelected } from '../designerActions.js'
import {
  addChild,
  duplicateNode,
  findNode,
  moveNode,
  removeNode,
  reorderSibling,
  wrapInContainer,
} from '../layoutMutations.js'
import { nextId, regenerateSubtreeIds, seedForNodeTemplate, slugifyIdPart } from '../idGenerator.js'
import { PALETTE_ENTRIES } from '../paletteCatalog.js'
import { SHIPPED_LAYOUTS } from '../../layouts/index.js'

describe('idGenerator', () => {
  it('slugifies readable id parts and suffixes collisions', () => {
    const layout = {
      root: {
        id: 'root',
        type: 'panel',
        children: [{ id: 'label-detect', type: 'label' }],
      },
    }

    expect(slugifyIdPart('  Label Detect.Mode_1!  ')).toBe('label-detect-mode-1')
    expect(nextId(layout, 'label-detect')).toBe('label-detect-2')
  })

  it('uses type-specific seeds for node templates', () => {
    expect(seedForNodeTemplate({ type: 'knob', props: { param: 'threshold' } })).toBe('knob-threshold')
    expect(seedForNodeTemplate({ type: 'toggle', props: { param: 'detect_mode' } })).toBe('toggle-detect-mode')
    expect(seedForNodeTemplate({ type: 'meter', props: { source: { slot: 'GAIN_REDUCTION' } } })).toBe('meter-gain-reduction')
    expect(seedForNodeTemplate({ type: 'visualizer', props: { source: 'compressor.combined' } })).toBe('viz-compressor-combined')
    expect(seedForNodeTemplate({ type: 'label', props: { text: 'Detect' } })).toBe('label-detect')
    expect(seedForNodeTemplate({ type: 'row' })).toBe('row')
  })
})

describe('Phase E layout mutations', () => {
  it('addChild inserts into a container with a stable generated id', () => {
    const layout = cloneCompressorLayout()
    const next = addChild(layout, 'root', { type: 'row', children: [] })

    expect(findNode(next, 'row')).toBeTruthy()
    expect(next.root.children.at(-1).id).toBe('row')
    expect(findNode(layout, 'row')).toBeNull()
  })

  it('addChild refuses a leaf parent', () => {
    const layout = cloneCompressorLayout()

    expect(() => addChild(layout, 'k-threshold', { type: 'label', props: { text: 'Nope' } })).toThrow(/cannot contain/i)
  })

  it('removeNode refuses root', () => {
    const layout = cloneCompressorLayout()

    expect(() => removeNode(layout, 'root')).toThrow(/root/i)
  })

  it('removeNode removes the selected node subtree', () => {
    const layout = cloneCompressorLayout()
    const next = removeNode(layout, 'knob-grid')

    expect(findNode(next, 'knob-grid')).toBeNull()
    expect(findNode(next, 'k-threshold')).toBeNull()
    expect(findNode(layout, 'knob-grid')).toBeTruthy()
  })

  it('duplicateNode regenerates ids for a nested subtree', () => {
    const layout = cloneCompressorLayout()
    const next = duplicateNode(layout, 'knob-grid')
    const body = findNode(next, 'body')
    const duplicate = body.children[1]

    expect(duplicate.id).toBe('group')
    expect(duplicate.children).toHaveLength(8)
    expect(new Set(duplicate.children.map(child => child.id)).size).toBe(8)
    expect(duplicate.children.map(child => child.id)).not.toContain('k-threshold')
    expect(findNode(next, 'k-threshold')).toBeTruthy()
  })

  it('moveNode refuses moving a node into its own descendant', () => {
    const layout = cloneCompressorLayout()

    expect(() => moveNode(layout, 'body', 'knob-grid', 0)).toThrow(/descendant/i)
  })

  it('reorderSibling moves node up and down', () => {
    const layout = cloneCompressorLayout()
    const up = reorderSibling(layout, 'detect-row', 'up')
    expect(up.root.children.map(child => child.id)).toEqual(['viz-row', 'detect-row', 'body'])

    const down = reorderSibling(up, 'detect-row', 'down')
    expect(down.root.children.map(child => child.id)).toEqual(['viz-row', 'body', 'detect-row'])
  })

  it('wrapInContainer rejects non-contiguous siblings', () => {
    const layout = cloneCompressorLayout()

    expect(() => wrapInContainer(layout, ['viz-row', 'detect-row'], 'group')).toThrow(/contiguous/i)
  })

  it('regenerateSubtreeIds strips validator annotations from cloned data', () => {
    const layout = cloneCompressorLayout()
    const subtree = {
      id: 'old',
      type: 'row',
      _invalid: true,
      children: [{ id: 'old-child', type: 'label', _vizUnavailable: true, props: { text: 'Child' } }],
    }

    const clone = regenerateSubtreeIds(layout, subtree)
    expect(clone.id).toBe('row')
    expect(clone._invalid).toBeUndefined()
    expect(clone.children[0]._vizUnavailable).toBeUndefined()
  })
})

describe('Phase E actions and palette', () => {
  beforeEach(() => {
    usePluginUIDesignerStore.getState().reset()
  })

  it('addChildToSelected inserts and selects the generated node', async () => {
    await usePluginUIDesignerStore.getState().loadInitial('compressor')
    usePluginUIDesignerStore.getState().setSelectedNodeId('root')

    const result = addChildToSelected('row')
    const state = usePluginUIDesignerStore.getState()

    expect(result.ok).toBe(true)
    expect(result.selectedNodeId).toBe('row')
    expect(state.selectedNodeId).toBe('row')
    expect(findNode(state.workingLayout, 'row')).toBeTruthy()
    expect(state.expandedNodeIds.has('root')).toBe(true)
  })

  it('palette catalog does not expose unsafe or out-of-scope types', () => {
    const visibleTypes = new Set(PALETTE_ENTRIES.map(entry => entry.type))

    for (const type of ['panel', 'tabGroup', 'button', 'image', 'html', 'script']) {
      expect(visibleTypes.has(type)).toBe(false)
    }
  })
})

function cloneCompressorLayout() {
  return JSON.parse(JSON.stringify(SHIPPED_LAYOUTS.compressor))
}
