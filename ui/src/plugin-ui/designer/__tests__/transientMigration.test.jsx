import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { usePluginUIDesignerStore } from '../usePluginUIDesignerStore.js'
import { addChildToSelected } from '../designerActions.js'
import { findNode } from '../layoutMutations.js'
import { saveCurrentLayout } from '../persistenceActions.js'
import { getParamPickerOptions, getMeterSlotOptions, getVizSourceOptions } from '../BindingPicker.jsx'
import { isSaveAllowed } from '../validationStatus.js'
import { SHIPPED_LAYOUTS } from '../../layouts/index.js'
import { MANIFESTS, getManifest } from '../../manifests/index.js'
import { TRANSIENT_MANIFEST } from '../../manifests/transient.js'
import { LIMITER_MANIFEST } from '../../manifests/limiter.js'
import { COMPRESSOR_MANIFEST } from '../../manifests/compressor.js'
import { validate } from '../../schema/validate.js'

// Phase: Transient Processor migration to stock plugin UI runtime + Designer.
// Mirrors limiterMigration.test.jsx — registry wiring, layout/manifest
// validation, Designer pluginId-driven dispatch.

describe('Transient manifest registry', () => {
  it('exposes the Transient manifest under getManifest("transientproc")', () => {
    expect(getManifest('transientproc')).toBe(TRANSIENT_MANIFEST)
    expect(MANIFESTS.transientproc).toBe(TRANSIENT_MANIFEST)
  })

  it('declares the Transient parameter set used by the legacy panel and engine', () => {
    expect(Object.keys(TRANSIENT_MANIFEST.params).sort())
      .toEqual(['attack', 'attack_speed', 'dry', 'midi_detect', 'mix', 'mix_linked', 'sustain', 'threshold', 'wet'])
    expect(TRANSIENT_MANIFEST.params.midi_detect.kind).toBe('discrete')
    expect(TRANSIENT_MANIFEST.params.attack.kind).toBe('continuous')
    expect(TRANSIENT_MANIFEST.params.attack.min).toBe(-100)
    expect(TRANSIENT_MANIFEST.params.attack.max).toBe(100)
  })

  it('declares meter slots that match the engine effect (peaks + signed gain)', () => {
    expect(TRANSIENT_MANIFEST.meterSlots).toEqual(['PEAK_L', 'PEAK_R', 'GAIN_REDUCTION'])
  })

  it('declares the Transient visualization source keys backed by the engine pipeline', () => {
    expect(Array.isArray(TRANSIENT_MANIFEST.vizSources)).toBe(true)
    expect(TRANSIENT_MANIFEST.vizSources).toContain('transient.shaper')
    for (const src of TRANSIENT_MANIFEST.vizSources) {
      expect(src.startsWith('transient.')).toBe(true)
    }
  })
})

describe('Transient shipped layout registry', () => {
  it('registers the shipped Transient layout under SHIPPED_LAYOUTS.transientproc', () => {
    expect(SHIPPED_LAYOUTS.transientproc).toBeTruthy()
    expect(SHIPPED_LAYOUTS.transientproc.pluginId).toBe('transientproc')
    expect(SHIPPED_LAYOUTS.transientproc.schemaVersion).toBe(1)
    expect(SHIPPED_LAYOUTS.transientproc.root?.type).toBe('panel')
  })

  it('validates against the Transient manifest', () => {
    const result = validate(SHIPPED_LAYOUTS.transientproc, TRANSIENT_MANIFEST)
    expect(result.ok).toBe(true)
    const invalidNodeIds = collectInvalidNodeIds(result.doc.root)
    expect(invalidNodeIds).toEqual([])
  })

  it('does not validate against the Compressor manifest (pluginId mismatch)', () => {
    const result = validate(SHIPPED_LAYOUTS.transientproc, COMPRESSOR_MANIFEST)
    expect(result.ok).toBe(false)
    expect(result.errors[0]?.code).toBe('PLUGIN_ID_MISMATCH')
  })

  it('does not validate against the Limiter manifest (pluginId mismatch)', () => {
    const result = validate(SHIPPED_LAYOUTS.transientproc, LIMITER_MANIFEST)
    expect(result.ok).toBe(false)
    expect(result.errors[0]?.code).toBe('PLUGIN_ID_MISMATCH')
  })

  it('contains a transient visualizer node bound to a transient.* source', () => {
    const types = collectNodeTypes(SHIPPED_LAYOUTS.transientproc.root)
    expect(types).toContain('visualizer')

    const vizNode = findVisualizerNode(SHIPPED_LAYOUTS.transientproc.root)
    expect(vizNode).toBeTruthy()
    expect(vizNode.props?.source).toMatch(/^transient\./)
    expect(TRANSIENT_MANIFEST.vizSources).toContain(vizNode.props.source)
  })

  it('references only params declared by the Transient manifest', () => {
    const refs = collectParamRefs(SHIPPED_LAYOUTS.transientproc.root)
    expect(refs.length).toBeGreaterThan(0)
    for (const param of refs) {
      expect(TRANSIENT_MANIFEST.params[param]).toBeTruthy()
    }
  })
})

describe('Designer store — loadInitial("transientproc")', () => {
  beforeEach(() => {
    usePluginUIDesignerStore.getState().reset()
  })

  afterEach(() => {
    try { delete globalThis.window } catch { /* ignore */ }
  })

  it('populates workingLayout from the shipped Transient default when no IPC is available', async () => {
    await usePluginUIDesignerStore.getState().loadInitial('transientproc')

    const state = usePluginUIDesignerStore.getState()
    expect(state.pluginId).toBe('transientproc')
    expect(state.manifest).toBe(TRANSIENT_MANIFEST)
    expect(state.shippedLayout?.pluginId).toBe('transientproc')
    expect(state.workingLayout?.pluginId).toBe('transientproc')
    expect(state.savedOverride).toBeNull()
    expect(state.dirty).toBe(false)
    expect(state.validationResult.ok).toBe(true)
  })

  it('uses a valid Transient user override when the IPC returns one', async () => {
    const override = JSON.parse(JSON.stringify(SHIPPED_LAYOUTS.transientproc))
    override.name = 'Transient Override For Test'

    globalThis.window = {
      xleth: {
        pluginUi: {
          loadUserOverride: vi.fn().mockResolvedValue(override),
        },
      },
    }

    await usePluginUIDesignerStore.getState().loadInitial('transientproc')

    expect(window.xleth.pluginUi.loadUserOverride).toHaveBeenCalledWith('transientproc')
    const state = usePluginUIDesignerStore.getState()
    expect(state.savedOverride?.name).toBe('Transient Override For Test')
    expect(state.workingLayout?.name).toBe('Transient Override For Test')
  })
})

describe('Designer BindingPicker for Transient', () => {
  it('lists Transient params (not Compressor / Limiter params)', () => {
    const options = getParamPickerOptions(TRANSIENT_MANIFEST, null)
    const values = options.map(o => o.value).sort()
    expect(values).toEqual(['attack', 'attack_speed', 'dry', 'midi_detect', 'mix', 'mix_linked', 'sustain', 'threshold', 'wet'])
    expect(values).not.toContain('ratio')
    expect(values).not.toContain('ceiling')
    expect(values).not.toContain('release')
  })

  it('lists Transient meter slots (the semantic ones declared by the manifest)', () => {
    const options = getMeterSlotOptions(TRANSIENT_MANIFEST, null)
    const values = options.map(o => o.value)
    expect(values).toContain('PEAK_L')
    expect(values).toContain('PEAK_R')
    expect(values).toContain('GAIN_REDUCTION')
  })

  it('lists transient visualizer source options for the Transient manifest', () => {
    const options = getVizSourceOptions(TRANSIENT_MANIFEST, null)
    const values = options.map(o => o.value)
    expect(values).toContain('transient.shaper')
    expect(values.every(v => v.startsWith('transient.'))).toBe(true)
  })
})

describe('Designer persistence — Transient writes to transientproc override path', () => {
  beforeEach(async () => {
    usePluginUIDesignerStore.getState().reset()
    installPluginUiIpc()
  })

  afterEach(() => {
    try { delete globalThis.window } catch { /* ignore */ }
  })

  it('saveCurrentLayout calls saveUserOverride("transientproc", layout) when Transient is loaded', async () => {
    await usePluginUIDesignerStore.getState().loadInitial('transientproc')
    const next = JSON.parse(JSON.stringify(SHIPPED_LAYOUTS.transientproc))
    next.name = 'Transient Save Test'
    usePluginUIDesignerStore.getState().setWorkingLayout(next)

    const result = await saveCurrentLayout()

    expect(result.ok).toBe(true)
    expect(window.xleth.pluginUi.saveUserOverride).toHaveBeenCalledTimes(1)
    expect(window.xleth.pluginUi.saveUserOverride).toHaveBeenCalledWith(
      'transientproc',
      expect.objectContaining({ pluginId: 'transientproc', name: 'Transient Save Test' }),
    )
    // Compressor / Limiter must not be touched by a Transient save.
    expect(window.xleth.pluginUi.saveUserOverride).not.toHaveBeenCalledWith(
      'compressor', expect.anything(),
    )
    expect(window.xleth.pluginUi.saveUserOverride).not.toHaveBeenCalledWith(
      'limiter', expect.anything(),
    )
  })
})

// ── Cross-plugin visualizer leakage regression ───────────────────────────────

describe('Transient shipped layout contains no Compressor / Limiter visualizer sources', () => {
  it('all viz sources in Transient shipped layout are transient.* (never compressor.* / limiter.*)', () => {
    const sources = collectVizSources(SHIPPED_LAYOUTS.transientproc.root)
    expect(sources.length).toBeGreaterThan(0)
    for (const src of sources) {
      expect(src.startsWith('compressor.')).toBe(false)
      expect(src.startsWith('limiter.')).toBe(false)
      expect(src.startsWith('transient.')).toBe(true)
    }
  })

  it('Transient shipped layout validates cleanly against TRANSIENT_MANIFEST with no UNKNOWN_VIZ_SOURCE errors', () => {
    const result = validate(SHIPPED_LAYOUTS.transientproc, TRANSIENT_MANIFEST)
    expect(result.ok).toBe(true)
    const vizErrors = (result.errors || []).filter(e => e.code === 'UNKNOWN_VIZ_SOURCE')
    expect(vizErrors).toEqual([])
    expect(isSaveAllowed(result)).toBe(true)
  })

  it('Limiter and Compressor shipped layouts still have their own visualizer sources (no regression)', () => {
    const limiterSources = collectVizSources(SHIPPED_LAYOUTS.limiter.root)
    expect(limiterSources.some(src => src.startsWith('limiter.'))).toBe(true)
    const compressorSources = collectVizSources(SHIPPED_LAYOUTS.compressor.root)
    expect(compressorSources.some(src => src.startsWith('compressor.'))).toBe(true)
  })
})

// ── Palette visualizer source dispatch ───────────────────────────────────────

describe('Palette visualizer source dispatch for Transient', () => {
  beforeEach(() => {
    usePluginUIDesignerStore.getState().reset()
  })

  it('adds a transient.shaper visualizer when Transient is loaded', async () => {
    await usePluginUIDesignerStore.getState().loadInitial('transientproc')
    usePluginUIDesignerStore.getState().setSelectedNodeId('root')

    const result = addChildToSelected('visualizer')

    expect(result.ok).toBe(true)
    const newNode = findNode(usePluginUIDesignerStore.getState().workingLayout, result.selectedNodeId)
    expect(newNode?.type).toBe('visualizer')
    expect(newNode?.props?.source).toBe('transient.shaper')
    expect(newNode?.props?.source).not.toMatch(/^compressor\./)
    expect(newNode?.props?.source).not.toMatch(/^limiter\./)
  })

  it('the added visualizer validates without UNKNOWN_VIZ_SOURCE when Transient is loaded', async () => {
    await usePluginUIDesignerStore.getState().loadInitial('transientproc')
    usePluginUIDesignerStore.getState().setSelectedNodeId('root')
    addChildToSelected('visualizer')

    const { validationResult } = usePluginUIDesignerStore.getState()
    const vizErrors = (validationResult.errors || []).filter(e => e.code === 'UNKNOWN_VIZ_SOURCE')
    expect(vizErrors).toEqual([])
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

function collectVizSources(node, out = []) {
  if (!node) return out
  if (node.type === 'visualizer' && typeof node.props?.source === 'string') {
    out.push(node.props.source)
  }
  if (Array.isArray(node.children)) for (const c of node.children) collectVizSources(c, out)
  return out
}
