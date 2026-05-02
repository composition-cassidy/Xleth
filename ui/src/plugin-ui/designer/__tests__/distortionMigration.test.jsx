import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { usePluginUIDesignerStore } from '../usePluginUIDesignerStore.js'
import { saveCurrentLayout } from '../persistenceActions.js'
import { getParamPickerOptions, getMeterSlotOptions, getVizSourceOptions } from '../BindingPicker.jsx'
import { SHIPPED_LAYOUTS } from '../../layouts/index.js'
import { MANIFESTS, getManifest } from '../../manifests/index.js'
import { DISTORTION_MANIFEST } from '../../manifests/distortion.js'
import { LIMITER_MANIFEST } from '../../manifests/limiter.js'
import { COMPRESSOR_MANIFEST } from '../../manifests/compressor.js'
import { validate } from '../../schema/validate.js'

describe('Distortion manifest registry', () => {
  it('exposes the Distortion manifest under getManifest("distortion")', () => {
    expect(getManifest('distortion')).toBe(DISTORTION_MANIFEST)
    expect(MANIFESTS.distortion).toBe(DISTORTION_MANIFEST)
  })

  it('declares exactly the engine Distortion parameters', () => {
    expect(Object.keys(DISTORTION_MANIFEST.params).sort())
      .toEqual(['drive', 'filter_pos', 'mix', 'mode', 'tone'])
    expect(DISTORTION_MANIFEST.params.mode.kind).toBe('discrete')
    expect(DISTORTION_MANIFEST.params.mode.min).toBe(0)
    expect(DISTORTION_MANIFEST.params.mode.max).toBe(3)
    expect(DISTORTION_MANIFEST.params.filter_pos.kind).toBe('discrete')
    expect(DISTORTION_MANIFEST.params.drive.format).toBe('dB1')
    expect(DISTORTION_MANIFEST.params.tone.format).toBe('hz0')
    expect(DISTORTION_MANIFEST.params.mix.format).toBe('pct0')
  })

  it('exposes only generic peak meters and no visualization sources', () => {
    expect(DISTORTION_MANIFEST.meterSlots).toEqual(['PEAK_L', 'PEAK_R'])
    expect(DISTORTION_MANIFEST.vizSources).toEqual([])
  })
})

describe('Distortion shipped layout registry', () => {
  it('registers the shipped Distortion layout under SHIPPED_LAYOUTS.distortion', () => {
    expect(SHIPPED_LAYOUTS.distortion).toBeTruthy()
    expect(SHIPPED_LAYOUTS.distortion.pluginId).toBe('distortion')
    expect(SHIPPED_LAYOUTS.distortion.schemaVersion).toBe(1)
    expect(SHIPPED_LAYOUTS.distortion.root?.type).toBe('panel')
  })

  it('validates against the Distortion manifest', () => {
    const result = validate(SHIPPED_LAYOUTS.distortion, DISTORTION_MANIFEST)
    expect(result.ok).toBe(true)
    expect(collectInvalidNodeIds(result.doc.root)).toEqual([])
    expect(result.errors).toEqual([])
  })

  it('does not validate against other plugin manifests', () => {
    for (const manifest of [COMPRESSOR_MANIFEST, LIMITER_MANIFEST]) {
      const result = validate(SHIPPED_LAYOUTS.distortion, manifest)
      expect(result.ok).toBe(false)
      expect(result.errors[0]?.code).toBe('PLUGIN_ID_MISMATCH')
    }
  })

  it('recreates the legacy controls without fake visualizers or extra params', () => {
    expect(collectNodeTypes(SHIPPED_LAYOUTS.distortion.root)).not.toContain('visualizer')
    expect(collectVizSources(SHIPPED_LAYOUTS.distortion.root)).toEqual([])

    const refs = collectParamRefs(SHIPPED_LAYOUTS.distortion.root).sort()
    expect(refs).toEqual(['drive', 'filter_pos', 'filter_pos', 'mix', 'mode', 'mode', 'mode', 'mode', 'tone'])
    for (const param of refs) {
      expect(DISTORTION_MANIFEST.params[param]).toBeTruthy()
    }
  })
})

describe('Designer store - loadInitial("distortion")', () => {
  beforeEach(() => {
    usePluginUIDesignerStore.getState().reset()
  })

  afterEach(() => {
    try { delete globalThis.window } catch { /* ignore */ }
  })

  it('populates workingLayout from the shipped Distortion default when no IPC is available', async () => {
    await usePluginUIDesignerStore.getState().loadInitial('distortion')

    const state = usePluginUIDesignerStore.getState()
    expect(state.pluginId).toBe('distortion')
    expect(state.manifest).toBe(DISTORTION_MANIFEST)
    expect(state.shippedLayout?.pluginId).toBe('distortion')
    expect(state.workingLayout?.pluginId).toBe('distortion')
    expect(state.savedOverride).toBeNull()
    expect(state.dirty).toBe(false)
    expect(state.validationResult.ok).toBe(true)
  })

  it('uses a valid Distortion user override when the IPC returns one', async () => {
    const override = JSON.parse(JSON.stringify(SHIPPED_LAYOUTS.distortion))
    override.name = 'Distortion Override For Test'

    globalThis.window = {
      xleth: {
        pluginUi: {
          loadUserOverride: vi.fn().mockResolvedValue(override),
        },
      },
    }

    await usePluginUIDesignerStore.getState().loadInitial('distortion')

    expect(window.xleth.pluginUi.loadUserOverride).toHaveBeenCalledWith('distortion')
    expect(usePluginUIDesignerStore.getState().workingLayout?.name).toBe('Distortion Override For Test')
  })
})

describe('Designer BindingPicker for Distortion', () => {
  it('lists Distortion params without Compressor or Limiter leakage', () => {
    const values = getParamPickerOptions(DISTORTION_MANIFEST, null).map(o => o.value).sort()
    expect(values).toEqual(['drive', 'filter_pos', 'mix', 'mode', 'tone'])
    expect(values).not.toContain('threshold')
    expect(values).not.toContain('ceiling')
  })

  it('lists only generic peak meter slots', () => {
    const values = getMeterSlotOptions(DISTORTION_MANIFEST, null).map(o => o.value)
    expect(values).toEqual(['PEAK_L', 'PEAK_R'])
  })

  it('lists no visualizer source options', () => {
    expect(getVizSourceOptions(DISTORTION_MANIFEST, null)).toEqual([])
  })
})

describe('Designer persistence - Distortion writes to distortion override path', () => {
  beforeEach(() => {
    usePluginUIDesignerStore.getState().reset()
    installPluginUiIpc()
  })

  afterEach(() => {
    try { delete globalThis.window } catch { /* ignore */ }
  })

  it('saveCurrentLayout calls saveUserOverride("distortion", layout) when Distortion is loaded', async () => {
    await usePluginUIDesignerStore.getState().loadInitial('distortion')
    const next = JSON.parse(JSON.stringify(SHIPPED_LAYOUTS.distortion))
    next.name = 'Distortion Save Test'
    usePluginUIDesignerStore.getState().setWorkingLayout(next)

    const result = await saveCurrentLayout()

    expect(result.ok).toBe(true)
    expect(window.xleth.pluginUi.saveUserOverride).toHaveBeenCalledTimes(1)
    expect(window.xleth.pluginUi.saveUserOverride).toHaveBeenCalledWith(
      'distortion',
      expect.objectContaining({ pluginId: 'distortion', name: 'Distortion Save Test' }),
    )
    for (const otherId of ['compressor', 'limiter', 'transientproc', 'overdone']) {
      expect(window.xleth.pluginUi.saveUserOverride).not.toHaveBeenCalledWith(
        otherId, expect.anything(),
      )
    }
  })
})

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
