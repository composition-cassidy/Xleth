import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import { usePluginUIDesignerStore } from '../usePluginUIDesignerStore.js'
import { LayoutTreeContent } from '../LayoutTreePanel.jsx'
import { SHIPPED_LAYOUTS } from '../../layouts/index.js'
import { renameSelectedNode } from '../designerActions.js'
import { findNode } from '../layoutMutations.js'

// Phase A–C smoke test: with no user-override IPC available, the Designer
// store must load the bundled shipped Compressor layout and the LayoutTreePanel
// must surface every id from compressor.json.

describe('PluginUIDesigner — Phase A–C skeleton', () => {
  beforeEach(() => {
    usePluginUIDesignerStore.getState().reset()
  })

  afterEach(() => {
    if (typeof globalThis !== 'undefined' && 'window' in globalThis) {
      // Tests may install a window stub; clear it between cases.
      try { delete globalThis.window } catch { /* ignore */ }
    }
  })

  it('loadInitial("compressor") populates workingLayout from the shipped default when no IPC is available', async () => {
    await usePluginUIDesignerStore.getState().loadInitial('compressor')

    const state = usePluginUIDesignerStore.getState()
    expect(state.pluginId).toBe('compressor')
    expect(state.shippedLayout).toBeTruthy()
    expect(state.shippedLayout.pluginId).toBe('compressor')
    expect(state.workingLayout).toBeTruthy()
    expect(state.workingLayout.root?.id).toBe('root')
    expect(state.savedOverride).toBeNull()
    expect(state.dirty).toBe(false)
    expect(state.validationResult.ok).toBe(true)
  })

  it('loadInitial uses a valid user override when the IPC returns one', async () => {
    const shipped = SHIPPED_LAYOUTS.compressor
    // Build a minimal-but-valid user override by cloning the shipped layout
    // and tweaking the name.
    const override = JSON.parse(JSON.stringify(shipped))
    override.name = 'Override For Test'

    globalThis.window = {
      xleth: {
        pluginUi: {
          loadUserOverride: vi.fn().mockResolvedValue(override),
        },
      },
    }

    await usePluginUIDesignerStore.getState().loadInitial('compressor')

    const state = usePluginUIDesignerStore.getState()
    expect(state.savedOverride).toBeTruthy()
    expect(state.savedOverride.name).toBe('Override For Test')
    expect(state.workingLayout.name).toBe('Override For Test')
    expect(state.dirty).toBe(false)
    expect(window.xleth.pluginUi.loadUserOverride).toHaveBeenCalledWith('compressor')
  })

  it('loadInitial falls back to shipped when the IPC returns an invalid override', async () => {
    globalThis.window = {
      xleth: {
        pluginUi: {
          loadUserOverride: vi.fn().mockResolvedValue({ schemaVersion: 999, pluginId: 'compressor', root: { id: 'root', type: 'panel' } }),
        },
      },
    }

    await usePluginUIDesignerStore.getState().loadInitial('compressor')

    const state = usePluginUIDesignerStore.getState()
    expect(state.savedOverride).toBeNull()
    expect(state.workingLayout?.root?.id).toBe('root')
    expect(state.loadError).toMatch(/invalid/i)
  })

  it('LayoutTreeContent surfaces every id from the shipped Compressor layout', async () => {
    await usePluginUIDesignerStore.getState().loadInitial('compressor')

    const layout = usePluginUIDesignerStore.getState().workingLayout
    const allIds = collectIds(layout.root)
    const expanded = new Set(allIds)

    const html = renderToStaticMarkup(
      <LayoutTreeContent
        layout={layout}
        selectedNodeId={null}
        expandedNodeIds={expanded}
        onSelect={() => {}}
        onToggleExpanded={() => {}}
      />,
    )

    // Spot-check a representative subset of node ids from compressor.json.
    const expected = [
      'root',
      'body',
      'knob-grid',
      'k-threshold',
      'k-ratio',
      'k-attack',
      'k-release',
      'gr-meter',
      'detect-row',
      'btn-peak',
      'btn-rms',
      'viz-row',
      'compressor-viz',
    ]
    for (const id of expected) {
      expect(html).toContain(`#${id}`)
    }
  })

  it('selecting a node updates the store and rendering reflects the selection class', async () => {
    await usePluginUIDesignerStore.getState().loadInitial('compressor')

    usePluginUIDesignerStore.getState().setSelectedNodeId('k-threshold')
    expect(usePluginUIDesignerStore.getState().selectedNodeId).toBe('k-threshold')

    const layout = usePluginUIDesignerStore.getState().workingLayout
    const expanded = new Set(collectIds(layout.root))

    const html = renderToStaticMarkup(
      <LayoutTreeContent
        layout={layout}
        selectedNodeId="k-threshold"
        expandedNodeIds={expanded}
        onSelect={() => {}}
        onToggleExpanded={() => {}}
      />,
    )
    expect(html).toContain('pluginui-designer-tree-row--selected')
    expect(html).toContain('#k-threshold')
  })

  it('renameSelectedNode updates workingLayout and selectedNodeId together', async () => {
    await usePluginUIDesignerStore.getState().loadInitial('compressor')
    usePluginUIDesignerStore.getState().setSelectedNodeId('k-threshold')

    const result = renameSelectedNode('k-threshold-renamed')
    const state = usePluginUIDesignerStore.getState()

    expect(result.ok).toBe(true)
    expect(state.selectedNodeId).toBe('k-threshold-renamed')
    expect(findNode(state.workingLayout, 'k-threshold')).toBeNull()
    expect(findNode(state.workingLayout, 'k-threshold-renamed')).toBeTruthy()
    expect(state.dirty).toBe(true)
    expect(state.mutationError).toBeNull()
  })
})

function collectIds(node, out = []) {
  if (!node) return out
  if (node.id) out.push(node.id)
  for (const child of node.children || []) collectIds(child, out)
  return out
}
