import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { usePluginUIDesignerStore } from '../usePluginUIDesignerStore.js'
import { addChildToSelected } from '../designerActions.js'
import { findNode } from '../layoutMutations.js'
import { saveCurrentLayout } from '../persistenceActions.js'
import { getParamPickerOptions, getMeterSlotOptions, getVizSourceOptions } from '../BindingPicker.jsx'
import { isSaveAllowed } from '../validationStatus.js'
import { SHIPPED_LAYOUTS } from '../../layouts/index.js'
import { MANIFESTS, getManifest } from '../../manifests/index.js'
import { LIMITER_MANIFEST } from '../../manifests/limiter.js'
import { COMPRESSOR_MANIFEST } from '../../manifests/compressor.js'
import { validate } from '../../schema/validate.js'

// Phase: Limiter migration to stock plugin UI runtime + Designer.
// These tests cover the registry wiring, layout/manifest validation and
// the Designer's pluginId-driven dispatch (load + save + binding pickers).

describe('Limiter manifest registry', () => {
  it('exposes the Limiter manifest under getManifest("limiter")', () => {
    expect(getManifest('limiter')).toBe(LIMITER_MANIFEST)
    expect(MANIFESTS.limiter).toBe(LIMITER_MANIFEST)
  })

  it('declares the Limiter parameter set used by the legacy panel', () => {
    expect(Object.keys(LIMITER_MANIFEST.params).sort())
      .toEqual(['ceiling', 'gain', 'release', 'style'])
    expect(LIMITER_MANIFEST.params.style.kind).toBe('discrete')
    expect(LIMITER_MANIFEST.params.gain.kind).toBe('continuous')
  })

  it('declares the Limiter meter slots used by the legacy panel', () => {
    expect(LIMITER_MANIFEST.meterSlots).toEqual(
      ['PEAK_L', 'PEAK_R', 'GAIN_REDUCTION', 'LUFS_MOMENTARY', 'LUFS_SHORT_TERM'],
    )
  })

  it('declares the Limiter visualization source keys backed by the engine pipeline', () => {
    expect(Array.isArray(LIMITER_MANIFEST.vizSources)).toBe(true)
    expect(LIMITER_MANIFEST.vizSources).toContain('limiter.realtime')
    // Sources must not collide with the Compressor namespace.
    for (const src of LIMITER_MANIFEST.vizSources) {
      expect(src.startsWith('limiter.')).toBe(true)
    }
  })
})

describe('Limiter shipped layout registry', () => {
  it('registers the shipped Limiter layout under SHIPPED_LAYOUTS.limiter', () => {
    expect(SHIPPED_LAYOUTS.limiter).toBeTruthy()
    expect(SHIPPED_LAYOUTS.limiter.pluginId).toBe('limiter')
    expect(SHIPPED_LAYOUTS.limiter.schemaVersion).toBe(1)
    expect(SHIPPED_LAYOUTS.limiter.root?.type).toBe('panel')
  })

  it('validates against the Limiter manifest', () => {
    const result = validate(SHIPPED_LAYOUTS.limiter, LIMITER_MANIFEST)
    expect(result.ok).toBe(true)
    const invalidNodeIds = collectInvalidNodeIds(result.doc.root)
    expect(invalidNodeIds).toEqual([])
  })

  it('does not validate against the Compressor manifest (pluginId mismatch)', () => {
    const result = validate(SHIPPED_LAYOUTS.limiter, COMPRESSOR_MANIFEST)
    expect(result.ok).toBe(false)
    expect(result.errors[0]?.code).toBe('PLUGIN_ID_MISMATCH')
  })

  it('contains a limiter visualizer node bound to the realtime source', () => {
    const types = collectNodeTypes(SHIPPED_LAYOUTS.limiter.root)
    expect(types).toContain('visualizer')

    const vizNode = findVisualizerNode(SHIPPED_LAYOUTS.limiter.root)
    expect(vizNode).toBeTruthy()
    expect(vizNode.props?.source).toMatch(/^limiter\./)
    expect(LIMITER_MANIFEST.vizSources).toContain(vizNode.props.source)
  })

  it('references only params declared by the Limiter manifest', () => {
    const refs = collectParamRefs(SHIPPED_LAYOUTS.limiter.root)
    expect(refs.length).toBeGreaterThan(0)
    for (const param of refs) {
      expect(LIMITER_MANIFEST.params[param]).toBeTruthy()
    }
  })

  it('references only meter slots declared by the Limiter manifest', () => {
    const slots = collectMeterSlots(SHIPPED_LAYOUTS.limiter.root)
    expect(slots.length).toBeGreaterThan(0)
    for (const slot of slots) {
      expect(LIMITER_MANIFEST.meterSlots).toContain(slot)
    }
  })
})

describe('Designer store — loadInitial("limiter")', () => {
  beforeEach(() => {
    usePluginUIDesignerStore.getState().reset()
  })

  afterEach(() => {
    try { delete globalThis.window } catch { /* ignore */ }
  })

  it('populates workingLayout from the shipped Limiter default when no IPC is available', async () => {
    await usePluginUIDesignerStore.getState().loadInitial('limiter')

    const state = usePluginUIDesignerStore.getState()
    expect(state.pluginId).toBe('limiter')
    expect(state.manifest).toBe(LIMITER_MANIFEST)
    expect(state.shippedLayout?.pluginId).toBe('limiter')
    expect(state.workingLayout?.pluginId).toBe('limiter')
    expect(state.savedOverride).toBeNull()
    expect(state.dirty).toBe(false)
    expect(state.validationResult.ok).toBe(true)
  })

  it('uses a valid Limiter user override when the IPC returns one', async () => {
    const override = JSON.parse(JSON.stringify(SHIPPED_LAYOUTS.limiter))
    override.name = 'Limiter Override For Test'

    globalThis.window = {
      xleth: {
        pluginUi: {
          loadUserOverride: vi.fn().mockResolvedValue(override),
        },
      },
    }

    await usePluginUIDesignerStore.getState().loadInitial('limiter')

    expect(window.xleth.pluginUi.loadUserOverride).toHaveBeenCalledWith('limiter')
    const state = usePluginUIDesignerStore.getState()
    expect(state.savedOverride?.name).toBe('Limiter Override For Test')
    expect(state.workingLayout?.name).toBe('Limiter Override For Test')
  })
})

describe('Designer BindingPicker for Limiter', () => {
  it('lists Limiter params (not Compressor params)', () => {
    const options = getParamPickerOptions(LIMITER_MANIFEST, null)
    const values = options.map(o => o.value)
    expect(values.sort()).toEqual(['ceiling', 'gain', 'release', 'style'])
    // Compressor-specific params must not leak through.
    expect(values).not.toContain('threshold')
    expect(values).not.toContain('detect_mode')
  })

  it('lists Limiter meter slots (the semantic ones declared by the manifest)', () => {
    const options = getMeterSlotOptions(LIMITER_MANIFEST, null)
    const values = options.map(o => o.value)
    expect(values).toContain('GAIN_REDUCTION')
    expect(values).toContain('LUFS_MOMENTARY')
    expect(values).toContain('LUFS_SHORT_TERM')
    expect(values).toContain('PEAK_L')
    expect(values).toContain('PEAK_R')
  })

  it('lists limiter visualizer source options for the Limiter manifest', () => {
    const options = getVizSourceOptions(LIMITER_MANIFEST, null)
    const values = options.map(o => o.value)
    expect(values).toContain('limiter.realtime')
    // Must NOT leak Compressor sources.
    expect(values.every(v => v.startsWith('limiter.'))).toBe(true)
  })

  it('still lists Compressor params for the Compressor manifest (no leakage in either direction)', () => {
    const options = getParamPickerOptions(COMPRESSOR_MANIFEST, null)
    const values = options.map(o => o.value)
    expect(values).toContain('threshold')
    expect(values).toContain('detect_mode')
    expect(values).not.toContain('gain')
    expect(values).not.toContain('ceiling')
  })
})

describe('Designer persistence — Limiter writes to limiter override path', () => {
  beforeEach(async () => {
    usePluginUIDesignerStore.getState().reset()
    installPluginUiIpc()
  })

  afterEach(() => {
    try { delete globalThis.window } catch { /* ignore */ }
  })

  it('saveCurrentLayout calls saveUserOverride("limiter", layout) when Limiter is loaded', async () => {
    await usePluginUIDesignerStore.getState().loadInitial('limiter')
    const next = JSON.parse(JSON.stringify(SHIPPED_LAYOUTS.limiter))
    next.name = 'Limiter Save Test'
    usePluginUIDesignerStore.getState().setWorkingLayout(next)

    const result = await saveCurrentLayout()

    expect(result.ok).toBe(true)
    expect(window.xleth.pluginUi.saveUserOverride).toHaveBeenCalledTimes(1)
    expect(window.xleth.pluginUi.saveUserOverride).toHaveBeenCalledWith(
      'limiter',
      expect.objectContaining({ pluginId: 'limiter', name: 'Limiter Save Test' }),
    )
    // Compressor must not be touched by a Limiter save.
    expect(window.xleth.pluginUi.saveUserOverride).not.toHaveBeenCalledWith(
      'compressor', expect.anything(),
    )
  })

  it('saveCurrentLayout calls saveUserOverride("compressor", layout) when Compressor is loaded', async () => {
    await usePluginUIDesignerStore.getState().loadInitial('compressor')
    const next = JSON.parse(JSON.stringify(SHIPPED_LAYOUTS.compressor))
    next.name = 'Compressor Save Test'
    usePluginUIDesignerStore.getState().setWorkingLayout(next)

    const result = await saveCurrentLayout()

    expect(result.ok).toBe(true)
    expect(window.xleth.pluginUi.saveUserOverride).toHaveBeenCalledWith(
      'compressor',
      expect.objectContaining({ pluginId: 'compressor', name: 'Compressor Save Test' }),
    )
    expect(window.xleth.pluginUi.saveUserOverride).not.toHaveBeenCalledWith(
      'limiter', expect.anything(),
    )
  })
})

// ── Cross-plugin visualizer leakage regression ───────────────────────────────

describe('Limiter shipped layout contains no Compressor visualizer sources', () => {
  it('all viz sources in Limiter shipped layout are limiter.* (never compressor.*)', () => {
    const sources = collectVizSources(SHIPPED_LAYOUTS.limiter.root)
    expect(sources.length).toBeGreaterThan(0)
    for (const src of sources) {
      expect(src.startsWith('compressor.')).toBe(false)
    }
  })

  it('Limiter shipped layout does not contain the node id "viz-compressor-combined"', () => {
    const ids = collectAllNodeIds(SHIPPED_LAYOUTS.limiter.root)
    expect(ids).not.toContain('viz-compressor-combined')
  })

  it('Limiter shipped layout validates cleanly against LIMITER_MANIFEST with no UNKNOWN_VIZ_SOURCE errors', () => {
    const result = validate(SHIPPED_LAYOUTS.limiter, LIMITER_MANIFEST)
    expect(result.ok).toBe(true)
    const vizErrors = (result.errors || []).filter(e => e.code === 'UNKNOWN_VIZ_SOURCE')
    expect(vizErrors).toEqual([])
    expect(isSaveAllowed(result)).toBe(true)
  })

  it('Compressor shipped layout still has a compressor.* visualizer source (no regression)', () => {
    const sources = collectVizSources(SHIPPED_LAYOUTS.compressor.root)
    expect(sources.some(src => src.startsWith('compressor.'))).toBe(true)
  })
})

// ── Palette visualizer source dispatch ───────────────────────────────────────

describe('Palette visualizer source dispatch', () => {
  beforeEach(() => {
    usePluginUIDesignerStore.getState().reset()
  })

  it('adds a limiter.realtime visualizer when Limiter is loaded', async () => {
    await usePluginUIDesignerStore.getState().loadInitial('limiter')
    usePluginUIDesignerStore.getState().setSelectedNodeId('root')

    const result = addChildToSelected('visualizer')

    expect(result.ok).toBe(true)
    const newNode = findNode(usePluginUIDesignerStore.getState().workingLayout, result.selectedNodeId)
    expect(newNode?.type).toBe('visualizer')
    expect(newNode?.props?.source).toBe('limiter.realtime')
    expect(newNode?.props?.source).not.toMatch(/^compressor\./)
  })

  it('adds a compressor.* visualizer when Compressor is loaded (first manifest vizSource)', async () => {
    await usePluginUIDesignerStore.getState().loadInitial('compressor')
    usePluginUIDesignerStore.getState().setSelectedNodeId('root')

    const result = addChildToSelected('visualizer')

    expect(result.ok).toBe(true)
    const newNode = findNode(usePluginUIDesignerStore.getState().workingLayout, result.selectedNodeId)
    expect(newNode?.type).toBe('visualizer')
    // Source must be the first entry from the Compressor manifest's vizSources.
    expect(newNode?.props?.source).toBe(COMPRESSOR_MANIFEST.vizSources[0])
    expect(newNode?.props?.source).toMatch(/^compressor\./)
    expect(COMPRESSOR_MANIFEST.vizSources).toContain(newNode?.props?.source)
  })

  it('fails with a clear error when manifest has no vizSources', async () => {
    await usePluginUIDesignerStore.getState().loadInitial('limiter')
    usePluginUIDesignerStore.setState({
      manifest: { ...LIMITER_MANIFEST, vizSources: [] },
    })
    usePluginUIDesignerStore.getState().setSelectedNodeId('root')

    const result = addChildToSelected('visualizer')

    expect(result.ok).toBe(false)
    expect(usePluginUIDesignerStore.getState().mutationError).toMatch(/no visualizer sources/i)
  })

  it('the added visualizer validates without UNKNOWN_VIZ_SOURCE when Limiter is loaded', async () => {
    await usePluginUIDesignerStore.getState().loadInitial('limiter')
    usePluginUIDesignerStore.getState().setSelectedNodeId('root')
    addChildToSelected('visualizer')

    const { validationResult } = usePluginUIDesignerStore.getState()
    const vizErrors = (validationResult.errors || []).filter(e => e.code === 'UNKNOWN_VIZ_SOURCE')
    expect(vizErrors).toEqual([])
  })
})

// ── Stale override repair UX ──────────────────────────────────────────────────

describe('Stale Limiter override repair UX', () => {
  beforeEach(() => {
    usePluginUIDesignerStore.getState().reset()
    installPluginUiIpc()
  })

  afterEach(() => {
    try { delete globalThis.window } catch { /* ignore */ }
  })

  it('save is blocked when Limiter working layout has a compressor.combined viz source', async () => {
    await usePluginUIDesignerStore.getState().loadInitial('limiter')
    const stale = JSON.parse(JSON.stringify(SHIPPED_LAYOUTS.limiter))
    const viz = findVisualizerNode(stale.root)
    viz.props.source = 'compressor.combined'
    viz.props.preset  = 'compressorCombined'
    usePluginUIDesignerStore.getState().setWorkingLayout(stale)

    expect(isSaveAllowed(usePluginUIDesignerStore.getState().validationResult)).toBe(false)

    const saveResult = await saveCurrentLayout()
    expect(saveResult.ok).toBe(false)
    expect(window.xleth.pluginUi.saveUserOverride).not.toHaveBeenCalled()
  })

  it('source dropdown shows (removed) compressor.combined with limiter.realtime still selectable', () => {
    const options = getVizSourceOptions(LIMITER_MANIFEST, 'compressor.combined')
    const removed  = options.find(o => o.removed)
    expect(removed).toBeTruthy()
    expect(removed.value).toBe('compressor.combined')
    expect(removed.disabled).toBe(true)
    expect(options.some(o => o.value === 'limiter.realtime' && !o.disabled)).toBe(true)
  })

  it('save is unblocked after repairing stale compressor.combined to limiter.realtime', async () => {
    await usePluginUIDesignerStore.getState().loadInitial('limiter')

    const stale = JSON.parse(JSON.stringify(SHIPPED_LAYOUTS.limiter))
    const viz = findVisualizerNode(stale.root)
    viz.props.source = 'compressor.combined'
    viz.props.preset  = 'compressorCombined'
    usePluginUIDesignerStore.getState().setWorkingLayout(stale)
    expect(isSaveAllowed(usePluginUIDesignerStore.getState().validationResult)).toBe(false)

    const repaired = JSON.parse(JSON.stringify(usePluginUIDesignerStore.getState().workingLayout))
    const repViz = findVisualizerNode(repaired.root)
    repViz.props.source = 'limiter.realtime'
    repViz.props.preset  = 'limiterRealtime'
    usePluginUIDesignerStore.getState().setWorkingLayout(repaired)

    expect(isSaveAllowed(usePluginUIDesignerStore.getState().validationResult)).toBe(true)
  })
})

// ── helpers ──────────────────────────────────────────────────────────────────

function installPluginUiIpc(overrides = {}) {
  globalThis.window = {
    xleth: {
      pluginUi: {
        loadUserOverride: vi.fn().mockResolvedValue(null),
        saveUserOverride: vi.fn().mockResolvedValue(true),
        clearUserOverride: vi.fn().mockResolvedValue(true),
        importDialog: vi.fn().mockResolvedValue(null),
        exportDialog: vi.fn().mockResolvedValue({ path: 'C:\\tmp\\plugin.xlethui.json' }),
        ...overrides,
      },
    },
  }
}

function collectNodeTypes(node, out = []) {
  if (!node) return out
  if (node.type) out.push(node.type)
  if (Array.isArray(node.children)) for (const c of node.children) collectNodeTypes(c, out)
  return out
}

function findVisualizerNode(node) {
  if (!node) return null
  if (node.type === 'visualizer') return node
  if (Array.isArray(node.children)) {
    for (const c of node.children) {
      const found = findVisualizerNode(c)
      if (found) return found
    }
  }
  return null
}

function collectInvalidNodeIds(node, out = []) {
  if (!node) return out
  if (node._invalid) out.push(node.id)
  if (Array.isArray(node.children)) for (const c of node.children) collectInvalidNodeIds(c, out)
  return out
}

function collectParamRefs(node, out = []) {
  if (!node) return out
  const param = node.props?.param
  if (typeof param === 'string') out.push(param)
  if (Array.isArray(node.children)) for (const c of node.children) collectParamRefs(c, out)
  return out
}

function collectMeterSlots(node, out = []) {
  if (!node) return out
  if (node.type === 'meter' && typeof node.props?.source?.slot === 'string') {
    out.push(node.props.source.slot)
  }
  if (Array.isArray(node.children)) for (const c of node.children) collectMeterSlots(c, out)
  return out
}

function collectVizSources(node, out = []) {
  if (!node) return out
  if (node.type === 'visualizer' && typeof node.props?.source === 'string') {
    out.push(node.props.source)
  }
  if (Array.isArray(node.children)) for (const c of node.children) collectVizSources(c, out)
  return out
}

function collectAllNodeIds(node, out = []) {
  if (!node) return out
  if (node.id) out.push(node.id)
  if (Array.isArray(node.children)) for (const c of node.children) collectAllNodeIds(c, out)
  return out
}
