import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { usePluginUIDesignerStore } from '../usePluginUIDesignerStore.js'
import {
  clearUserOverrideOnDisk,
  discardUnsavedChanges,
  exportCurrentLayout,
  importLayoutFromDialog,
  resetToShippedDefault,
  saveCurrentLayout,
} from '../persistenceActions.js'
import { SHIPPED_LAYOUTS } from '../../layouts/index.js'

describe('Phase H persistence actions', () => {
  beforeEach(async () => {
    usePluginUIDesignerStore.getState().reset()
    installPluginUiIpc()
    await usePluginUIDesignerStore.getState().loadInitial('compressor')
  })

  afterEach(() => {
    try { delete globalThis.window } catch { /* ignore */ }
  })

  it('saveCurrentLayout rejects when validation blocks save', async () => {
    const invalid = cloneCompressorLayout()
    invalid.root.children[0].children[0].children[0].props.param = 'missing-param'
    usePluginUIDesignerStore.getState().setWorkingLayout(invalid)

    const result = await saveCurrentLayout()

    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/validation/i)
    expect(window.xleth.pluginUi.saveUserOverride).not.toHaveBeenCalled()
    expect(usePluginUIDesignerStore.getState().dirty).toBe(true)
  })

  it('saveCurrentLayout calls saveUserOverride("compressor", layout) when dirty and valid', async () => {
    const next = cloneCompressorLayout()
    next.name = 'Save Test Layout'
    usePluginUIDesignerStore.getState().setWorkingLayout(next)

    const result = await saveCurrentLayout()

    expect(result.ok).toBe(true)
    expect(window.xleth.pluginUi.saveUserOverride).toHaveBeenCalledTimes(1)
    expect(window.xleth.pluginUi.saveUserOverride).toHaveBeenCalledWith(
      'compressor',
      expect.objectContaining({ pluginId: 'compressor', name: 'Save Test Layout' }),
    )
  })

  it('successful save sets dirty false and savedOverride to the saved layout', async () => {
    const next = cloneCompressorLayout()
    next.name = 'Saved Baseline'
    usePluginUIDesignerStore.getState().setWorkingLayout(next)

    await saveCurrentLayout()
    const state = usePluginUIDesignerStore.getState()

    expect(state.dirty).toBe(false)
    expect(state.savedOverride.name).toBe('Saved Baseline')
    expect(state.workingLayout.name).toBe('Saved Baseline')
  })

  it('exportCurrentLayout calls exportDialog but does not clear dirty', async () => {
    const next = cloneCompressorLayout()
    next.name = 'Dirty Export'
    usePluginUIDesignerStore.getState().setWorkingLayout(next)

    const result = await exportCurrentLayout()

    expect(result.ok).toBe(true)
    expect(window.xleth.pluginUi.exportDialog).toHaveBeenCalledTimes(1)
    expect(window.xleth.pluginUi.exportDialog).toHaveBeenCalledWith(
      'compressor',
      expect.objectContaining({ name: 'Dirty Export' }),
    )
    expect(usePluginUIDesignerStore.getState().dirty).toBe(true)
  })

  it('importLayoutFromDialog rejects wrong pluginId', async () => {
    const before = usePluginUIDesignerStore.getState().workingLayout
    const wrong = cloneCompressorLayout()
    wrong.pluginId = 'limiter'
    window.xleth.pluginUi.importDialog.mockResolvedValue({ pluginId: 'limiter', layout: wrong })

    const result = await importLayoutFromDialog()

    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/pluginId/i)
    expect(usePluginUIDesignerStore.getState().workingLayout).toBe(before)
  })

  it('importLayoutFromDialog rejects invalid $xleth', async () => {
    const before = usePluginUIDesignerStore.getState().workingLayout
    const imported = cloneCompressorLayout()
    imported.$xleth = 'not-a-plugin-layout'
    window.xleth.pluginUi.importDialog.mockResolvedValue({ pluginId: 'compressor', layout: imported })

    const result = await importLayoutFromDialog()

    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/\$xleth/)
    expect(usePluginUIDesignerStore.getState().workingLayout).toBe(before)
  })

  it('importLayoutFromDialog loads valid compressor layout into workingLayout and marks dirty', async () => {
    const imported = cloneCompressorLayout()
    imported.name = 'Imported Compressor Layout'
    window.xleth.pluginUi.importDialog.mockResolvedValue({ pluginId: 'compressor', layout: imported, path: 'C:\\tmp\\compressor.xlethui.json' })

    const result = await importLayoutFromDialog()
    const state = usePluginUIDesignerStore.getState()

    expect(result.ok).toBe(true)
    expect(state.workingLayout.name).toBe('Imported Compressor Layout')
    expect(state.dirty).toBe(true)
    expect(window.xleth.pluginUi.saveUserOverride).not.toHaveBeenCalled()
  })

  it('resetToShippedDefault replaces workingLayout and marks dirty appropriately', async () => {
    const override = cloneCompressorLayout()
    override.name = 'Saved Override'
    usePluginUIDesignerStore.setState({
      savedOverride: override,
      workingLayout: override,
      dirty: false,
    })

    const result = resetToShippedDefault()
    const state = usePluginUIDesignerStore.getState()

    expect(result.ok).toBe(true)
    expect(state.workingLayout.name).toBe(SHIPPED_LAYOUTS.compressor.name)
    expect(state.dirty).toBe(true)
  })

  it('discardUnsavedChanges restores savedOverride and clears dirty', () => {
    const override = cloneCompressorLayout()
    override.name = 'Saved Override'
    const dirty = cloneCompressorLayout()
    dirty.name = 'Unsaved Edit'
    usePluginUIDesignerStore.setState({
      savedOverride: override,
      workingLayout: dirty,
      dirty: true,
    })

    const result = discardUnsavedChanges()
    const state = usePluginUIDesignerStore.getState()

    expect(result.ok).toBe(true)
    expect(state.workingLayout.name).toBe('Saved Override')
    expect(state.dirty).toBe(false)
  })

  it('discardUnsavedChanges restores shippedLayout when no savedOverride exists', () => {
    const dirty = cloneCompressorLayout()
    dirty.name = 'Unsaved Edit'
    usePluginUIDesignerStore.setState({
      savedOverride: null,
      workingLayout: dirty,
      dirty: true,
    })

    const result = discardUnsavedChanges()
    const state = usePluginUIDesignerStore.getState()

    expect(result.ok).toBe(true)
    expect(state.workingLayout.name).toBe(SHIPPED_LAYOUTS.compressor.name)
    expect(state.dirty).toBe(false)
  })

  it('clearUserOverrideOnDisk calls clearUserOverride("compressor") and resets to shipped', async () => {
    const override = cloneCompressorLayout()
    override.name = 'Saved Override'
    usePluginUIDesignerStore.setState({
      savedOverride: override,
      workingLayout: override,
      dirty: false,
    })

    const result = await clearUserOverrideOnDisk()
    const state = usePluginUIDesignerStore.getState()

    expect(result.ok).toBe(true)
    expect(window.xleth.pluginUi.clearUserOverride).toHaveBeenCalledWith('compressor')
    expect(state.savedOverride).toBeNull()
    expect(state.workingLayout.name).toBe(SHIPPED_LAYOUTS.compressor.name)
    expect(state.dirty).toBe(false)
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
        exportDialog: vi.fn().mockResolvedValue({ path: 'C:\\tmp\\compressor.xlethui.json' }),
        ...overrides,
      },
    },
  }
}

function cloneCompressorLayout() {
  return JSON.parse(JSON.stringify(SHIPPED_LAYOUTS.compressor))
}
