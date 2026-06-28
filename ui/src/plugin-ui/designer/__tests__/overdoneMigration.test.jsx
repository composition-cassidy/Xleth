import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { usePluginUIDesignerStore } from '../usePluginUIDesignerStore.js'
import { addChildToSelected } from '../designerActions.js'
import { findNode } from '../layoutMutations.js'
import { saveCurrentLayout } from '../persistenceActions.js'
import { getParamPickerOptions, getMeterSlotOptions, getVizSourceOptions } from '../BindingPicker.jsx'
import { isSaveAllowed } from '../validationStatus.js'
import { SHIPPED_LAYOUTS } from '../../layouts/index.js'
import { MANIFESTS, getManifest } from '../../manifests/index.js'
import { OVERDONE_MANIFEST } from '../../manifests/overdone.js'
import { TRANSIENT_MANIFEST } from '../../manifests/transient.js'
import { LIMITER_MANIFEST } from '../../manifests/limiter.js'
import { COMPRESSOR_MANIFEST } from '../../manifests/compressor.js'
import { validate } from '../../schema/validate.js'

// Phase: Overdone (3-band OTT) migration to stock plugin UI runtime + Designer.
// Mirrors transientMigration.test.jsx — registry wiring, layout/manifest
// validation, Designer pluginId-driven dispatch.

describe('Overdone manifest registry', () => {
  it('exposes the Overdone manifest under getManifest("overdone")', () => {
    expect(getManifest('overdone')).toBe(OVERDONE_MANIFEST)
    expect(MANIFESTS.overdone).toBe(OVERDONE_MANIFEST)
  })

  it('declares the Overdone parameter set used by the legacy panel and engine', () => {
    expect(Object.keys(OVERDONE_MANIFEST.params).sort())
      .toEqual(['depth', 'gain_high', 'gain_low', 'gain_mid', 'time', 'xover_high', 'xover_low'])
    expect(OVERDONE_MANIFEST.params.depth.kind).toBe('continuous')
    expect(OVERDONE_MANIFEST.params.depth.min).toBe(0)
    expect(OVERDONE_MANIFEST.params.depth.max).toBe(100)
    expect(OVERDONE_MANIFEST.params.xover_low.min).toBe(40)
    expect(OVERDONE_MANIFEST.params.xover_low.max).toBe(400)
    expect(OVERDONE_MANIFEST.params.xover_high.min).toBe(1000)
    expect(OVERDONE_MANIFEST.params.xover_high.max).toBe(8000)
    expect(OVERDONE_MANIFEST.params.gain_low.min).toBe(-12)
    expect(OVERDONE_MANIFEST.params.gain_low.max).toBe(12)
  })

  it('declares meter slots that match the engine effect (peaks + per-band GR)', () => {
    expect(OVERDONE_MANIFEST.meterSlots).toEqual(['PEAK_L', 'PEAK_R', 'BAND_GR_LOW', 'BAND_GR_MID', 'BAND_GR_HIGH'])
  })

  it('declares the Overdone visualization source keys backed by the engine pipeline', () => {
    expect(Array.isArray(OVERDONE_MANIFEST.vizSources)).toBe(true)
    expect(OVERDONE_MANIFEST.vizSources).toContain('overdone.multiband')
    for (const src of OVERDONE_MANIFEST.vizSources) {
      expect(src.startsWith('overdone.')).toBe(true)
    }
  })
})

describe('Overdone shipped layout registry', () => {
  it('registers the shipped Overdone layout under SHIPPED_LAYOUTS.overdone', () => {
    expect(SHIPPED_LAYOUTS.overdone).toBeTruthy()
    expect(SHIPPED_LAYOUTS.overdone.pluginId).toBe('overdone')
    expect(SHIPPED_LAYOUTS.overdone.schemaVersion).toBe(1)
    expect(SHIPPED_LAYOUTS.overdone.root?.type).toBe('panel')
  })

  it('validates against the Overdone manifest', () => {
    const result = validate(SHIPPED_LAYOUTS.overdone, OVERDONE_MANIFEST)
    expect(result.ok).toBe(true)
    const invalidNodeIds = collectInvalidNodeIds(result.doc.root)
    expect(invalidNodeIds).toEqual([])
  })

  it('does not validate against the Compressor manifest (pluginId mismatch)', () => {
    const result = validate(SHIPPED_LAYOUTS.overdone, COMPRESSOR_MANIFEST)
    expect(result.ok).toBe(false)
    expect(result.errors[0]?.code).toBe('PLUGIN_ID_MISMATCH')
  })

  it('does not validate against the Limiter manifest (pluginId mismatch)', () => {
    const result = validate(SHIPPED_LAYOUTS.overdone, LIMITER_MANIFEST)
    expect(result.ok).toBe(false)
    expect(result.errors[0]?.code).toBe('PLUGIN_ID_MISMATCH')
  })

  it('does not validate against the Transient manifest (pluginId mismatch)', () => {
    const result = validate(SHIPPED_LAYOUTS.overdone, TRANSIENT_MANIFEST)
    expect(result.ok).toBe(false)
    expect(result.errors[0]?.code).toBe('PLUGIN_ID_MISMATCH')
  })

  it('contains a multiband visualizer node bound to an overdone.* source', () => {
    const types = collectNodeTypes(SHIPPED_LAYOUTS.overdone.root)
    expect(types).toContain('visualizer')

    const vizNode = findVisualizerNode(SHIPPED_LAYOUTS.overdone.root)
    expect(vizNode).toBeTruthy()
    expect(vizNode.props?.source).toMatch(/^overdone\./)
    expect(OVERDONE_MANIFEST.vizSources).toContain(vizNode.props.source)
  })

  it('references only params declared by the Overdone manifest', () => {
    const refs = collectParamRefs(SHIPPED_LAYOUTS.overdone.root)
    expect(refs.length).toBeGreaterThan(0)
    for (const param of refs) {
      expect(OVERDONE_MANIFEST.params[param]).toBeTruthy()
    }
  })

  it('uses Compressor-style sliders for all Overdone controls', () => {
    const types = collectNodeTypes(SHIPPED_LAYOUTS.overdone.root)
    const sliderCount = types.filter(type => type === 'compressorSlider').length
    expect(sliderCount).toBe(7)
    expect(types).not.toContain('knob')

    const refs = collectParamRefs(SHIPPED_LAYOUTS.overdone.root).sort()
    expect(refs).toEqual(['depth', 'gain_high', 'gain_low', 'gain_mid', 'time', 'xover_high', 'xover_low'])
  })
})

describe('Designer store — loadInitial("overdone")', () => {
  beforeEach(() => {
    usePluginUIDesignerStore.getState().reset()
  })

  afterEach(() => {
    try { delete globalThis.window } catch { /* ignore */ }
  })

  it('populates workingLayout from the shipped Overdone default when no IPC is available', async () => {
    await usePluginUIDesignerStore.getState().loadInitial('overdone')

    const state = usePluginUIDesignerStore.getState()
    expect(state.pluginId).toBe('overdone')
    expect(state.manifest).toBe(OVERDONE_MANIFEST)
    expect(state.shippedLayout?.pluginId).toBe('overdone')
    expect(state.workingLayout?.pluginId).toBe('overdone')
    expect(state.savedOverride).toBeNull()
    expect(state.dirty).toBe(false)
    expect(state.validationResult.ok).toBe(true)
  })

  it('uses a valid Overdone user override when the IPC returns one', async () => {
    const override = JSON.parse(JSON.stringify(SHIPPED_LAYOUTS.overdone))
    override.name = 'Overdone Override For Test'

    globalThis.window = {
      xleth: {
        pluginUi: {
          loadUserOverride: vi.fn().mockResolvedValue(override),
        },
      },
    }

    await usePluginUIDesignerStore.getState().loadInitial('overdone')

    expect(window.xleth.pluginUi.loadUserOverride).toHaveBeenCalledWith('overdone')
    const state = usePluginUIDesignerStore.getState()
    expect(state.savedOverride?.name).toBe('Overdone Override For Test')
    expect(state.workingLayout?.name).toBe('Overdone Override For Test')
  })
})

describe('Designer BindingPicker for Overdone', () => {
  it('lists Overdone params (not Compressor / Limiter / Transient params)', () => {
    const options = getParamPickerOptions(OVERDONE_MANIFEST, null)
    const values = options.map(o => o.value).sort()
    expect(values).toEqual(['depth', 'gain_high', 'gain_low', 'gain_mid', 'time', 'xover_high', 'xover_low'])
    expect(values).not.toContain('ratio')
    expect(values).not.toContain('ceiling')
    expect(values).not.toContain('attack_speed')
  })

  it('lists Overdone meter slots (per-band GR)', () => {
    const options = getMeterSlotOptions(OVERDONE_MANIFEST, null)
    const values = options.map(o => o.value)
    expect(values).toContain('PEAK_L')
    expect(values).toContain('PEAK_R')
    expect(values).toContain('BAND_GR_LOW')
    expect(values).toContain('BAND_GR_MID')
    expect(values).toContain('BAND_GR_HIGH')
  })

  it('lists overdone visualizer source options for the Overdone manifest', () => {
    const options = getVizSourceOptions(OVERDONE_MANIFEST, null)
    const values = options.map(o => o.value)
    expect(values).toContain('overdone.multiband')
    expect(values.every(v => v.startsWith('overdone.'))).toBe(true)
  })
})

describe('Designer persistence — Overdone writes to overdone override path', () => {
  beforeEach(async () => {
    usePluginUIDesignerStore.getState().reset()
    installPluginUiIpc()
  })

  afterEach(() => {
    try { delete globalThis.window } catch { /* ignore */ }
  })

  it('saveCurrentLayout calls saveUserOverride("overdone", layout) when Overdone is loaded', async () => {
    await usePluginUIDesignerStore.getState().loadInitial('overdone')
    const next = JSON.parse(JSON.stringify(SHIPPED_LAYOUTS.overdone))
    next.name = 'Overdone Save Test'
    usePluginUIDesignerStore.getState().setWorkingLayout(next)

    const result = await saveCurrentLayout()

    expect(result.ok).toBe(true)
    expect(window.xleth.pluginUi.saveUserOverride).toHaveBeenCalledTimes(1)
    expect(window.xleth.pluginUi.saveUserOverride).toHaveBeenCalledWith(
      'overdone',
      expect.objectContaining({ pluginId: 'overdone', name: 'Overdone Save Test' }),
    )
    // Compressor / Limiter / Transient must not be touched by an Overdone save.
    for (const otherId of ['compressor', 'limiter', 'transientproc']) {
      expect(window.xleth.pluginUi.saveUserOverride).not.toHaveBeenCalledWith(
        otherId, expect.anything(),
      )
    }
  })
})

// ── Cross-plugin visualizer leakage regression ───────────────────────────────

describe('Overdone shipped layout contains no Compressor / Limiter / Transient visualizer sources', () => {
  it('all viz sources in Overdone shipped layout are overdone.* (never compressor.* / limiter.* / transient.*)', () => {
    const sources = collectVizSources(SHIPPED_LAYOUTS.overdone.root)
    expect(sources.length).toBeGreaterThan(0)
    for (const src of sources) {
      expect(src.startsWith('compressor.')).toBe(false)
      expect(src.startsWith('limiter.')).toBe(false)
      expect(src.startsWith('transient.')).toBe(false)
      expect(src.startsWith('overdone.')).toBe(true)
    }
  })

  it('Overdone shipped layout validates cleanly against OVERDONE_MANIFEST with no UNKNOWN_VIZ_SOURCE errors', () => {
    const result = validate(SHIPPED_LAYOUTS.overdone, OVERDONE_MANIFEST)
    expect(result.ok).toBe(true)
    const vizErrors = (result.errors || []).filter(e => e.code === 'UNKNOWN_VIZ_SOURCE')
    expect(vizErrors).toEqual([])
    expect(isSaveAllowed(result)).toBe(true)
  })

  it('Compressor / Limiter / Transient shipped layouts still have their own visualizer sources (no regression)', () => {
    const compressorSources = collectVizSources(SHIPPED_LAYOUTS.compressor.root)
    expect(compressorSources.some(src => src.startsWith('compressor.'))).toBe(true)
    const limiterSources = collectVizSources(SHIPPED_LAYOUTS.limiter.root)
    expect(limiterSources.some(src => src.startsWith('limiter.'))).toBe(true)
    const transientSources = collectVizSources(SHIPPED_LAYOUTS.transientproc.root)
    expect(transientSources.some(src => src.startsWith('transient.'))).toBe(true)
  })
})

// ── Palette visualizer source dispatch ───────────────────────────────────────

describe('Palette visualizer source dispatch for Overdone', () => {
  beforeEach(() => {
    usePluginUIDesignerStore.getState().reset()
  })

  it('adds an overdone.multiband visualizer when Overdone is loaded', async () => {
    await usePluginUIDesignerStore.getState().loadInitial('overdone')
    usePluginUIDesignerStore.getState().setSelectedNodeId('root')

    const result = addChildToSelected('visualizer')

    expect(result.ok).toBe(true)
    const newNode = findNode(usePluginUIDesignerStore.getState().workingLayout, result.selectedNodeId)
    expect(newNode?.type).toBe('visualizer')
    expect(newNode?.props?.source).toBe('overdone.multiband')
    expect(newNode?.props?.source).not.toMatch(/^compressor\./)
    expect(newNode?.props?.source).not.toMatch(/^limiter\./)
    expect(newNode?.props?.source).not.toMatch(/^transient\./)
  })

  it('the added visualizer validates without UNKNOWN_VIZ_SOURCE when Overdone is loaded', async () => {
    await usePluginUIDesignerStore.getState().loadInitial('overdone')
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
