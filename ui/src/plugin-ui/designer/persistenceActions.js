import { validate } from '../schema/validate.js'
import { usePluginUIDesignerStore } from './usePluginUIDesignerStore.js'
import {
  formatValidationError,
  isExportAllowed,
  isSaveAllowed,
} from './validationStatus.js'

const PLUGIN_UI_LAYOUT_KIND = 'plugin-ui-layout'

export async function saveCurrentLayout() {
  const store = usePluginUIDesignerStore.getState()
  const ipc = getPluginUiIpc()

  if (!store.workingLayout) {
    return fail(store, 'No layout is loaded')
  }
  if (!store.pluginId || !store.manifest) {
    return fail(store, 'No plugin manifest is loaded')
  }

  if (!store.dirty) {
    store.setPersistenceMessage?.('No unsaved changes.')
    store.setSaveError?.(null)
    return { ok: false, error: 'No unsaved changes' }
  }

  const checked = validateForPersistence(store.workingLayout, 'save', store.manifest)
  if (!checked.ok) return fail(store, checked.error)

  if (!ipc || typeof ipc.saveUserOverride !== 'function') {
    return fail(store, 'pluginUi save IPC unavailable')
  }

  store.setPersistenceBusy?.('saving', true)
  store.setSaveError?.(null)
  try {
    await ipc.saveUserOverride(store.pluginId, checked.layout)
    usePluginUIDesignerStore.getState().markSaved(checked.layout)
    return { ok: true, layout: checked.layout }
  } catch (err) {
    return fail(usePluginUIDesignerStore.getState(), `Save failed: ${err?.message || err}`)
  } finally {
    usePluginUIDesignerStore.getState().setPersistenceBusy?.('saving', false)
  }
}

export function resetToShippedDefault() {
  const store = usePluginUIDesignerStore.getState()
  try {
    const result = store.resetToShipped()
    if (result?.ok === false) return fail(store, result.error)
    return result
  } catch (err) {
    return fail(store, `Reset failed: ${err?.message || err}`)
  }
}

export function discardUnsavedChanges() {
  const store = usePluginUIDesignerStore.getState()
  try {
    const result = store.discardChanges()
    if (result?.ok === false) return fail(store, result.error)
    return result
  } catch (err) {
    return fail(store, `Discard failed: ${err?.message || err}`)
  }
}

export async function clearUserOverrideOnDisk() {
  const store = usePluginUIDesignerStore.getState()
  const ipc = getPluginUiIpc()

  if (!store.pluginId) {
    return fail(store, 'No plugin manifest is loaded')
  }
  if (!ipc || typeof ipc.clearUserOverride !== 'function') {
    return fail(store, 'pluginUi clear IPC unavailable')
  }

  store.setPersistenceBusy?.('saving', true)
  store.setSaveError?.(null)
  try {
    await ipc.clearUserOverride(store.pluginId)
    usePluginUIDesignerStore.getState().clearSavedOverrideState()
    return { ok: true }
  } catch (err) {
    return fail(usePluginUIDesignerStore.getState(), `Clear override failed: ${err?.message || err}`)
  } finally {
    usePluginUIDesignerStore.getState().setPersistenceBusy?.('saving', false)
  }
}

export async function importLayoutFromDialog() {
  const store = usePluginUIDesignerStore.getState()
  const ipc = getPluginUiIpc()

  if (!ipc || typeof ipc.importDialog !== 'function') {
    return fail(store, 'pluginUi import IPC unavailable')
  }

  if (!store.pluginId || !store.manifest) {
    return fail(store, 'No plugin manifest is loaded')
  }

  store.setPersistenceBusy?.('importing', true)
  store.setSaveError?.(null)
  try {
    const imported = await ipc.importDialog()
    if (!imported) {
      usePluginUIDesignerStore.getState().setPersistenceMessage?.('Import canceled.')
      return { ok: false, canceled: true }
    }

    const normalized = normalizeImportedLayout(imported, store.pluginId)
    if (!normalized.ok) return fail(usePluginUIDesignerStore.getState(), normalized.error)

    const checked = validateForPersistence(normalized.layout, 'import', store.manifest)
    if (!checked.ok) return fail(usePluginUIDesignerStore.getState(), `Import failed: ${checked.error}`)

    usePluginUIDesignerStore.getState().replaceWithImported(checked.layout)
    return { ok: true, layout: checked.layout, path: imported.path ?? null }
  } catch (err) {
    return fail(usePluginUIDesignerStore.getState(), `Import failed: ${err?.message || err}`)
  } finally {
    usePluginUIDesignerStore.getState().setPersistenceBusy?.('importing', false)
  }
}

export async function exportCurrentLayout() {
  const store = usePluginUIDesignerStore.getState()
  const ipc = getPluginUiIpc()

  if (!store.workingLayout) {
    return fail(store, 'No layout is loaded')
  }
  if (!store.pluginId || !store.manifest) {
    return fail(store, 'No plugin manifest is loaded')
  }

  const checked = validateForPersistence(store.workingLayout, 'export', store.manifest)
  if (!checked.ok) return fail(store, checked.error)

  if (!ipc || typeof ipc.exportDialog !== 'function') {
    return fail(store, 'pluginUi export IPC unavailable')
  }

  store.setPersistenceBusy?.('exporting', true)
  store.setSaveError?.(null)
  try {
    const result = await ipc.exportDialog(store.pluginId, checked.layout)
    if (!result) {
      usePluginUIDesignerStore.getState().setPersistenceMessage?.('Export canceled.')
      return { ok: false, canceled: true }
    }

    usePluginUIDesignerStore.getState().setPersistenceMessage?.('Exported layout.')
    return { ok: true, path: result.path ?? null, layout: checked.layout }
  } catch (err) {
    return fail(usePluginUIDesignerStore.getState(), `Export failed: ${err?.message || err}`)
  } finally {
    usePluginUIDesignerStore.getState().setPersistenceBusy?.('exporting', false)
  }
}

function normalizeImportedLayout(imported, expectedPluginId) {
  const layout = imported?.layout
  if (!layout || typeof layout !== 'object') {
    return { ok: false, error: 'Import failed: layout is missing' }
  }

  if (layout.$xleth !== undefined && layout.$xleth !== PLUGIN_UI_LAYOUT_KIND) {
    return { ok: false, error: `Import failed: invalid $xleth "${layout.$xleth}"` }
  }

  const pluginId = imported.pluginId ?? layout.pluginId
  if (pluginId !== expectedPluginId || layout.pluginId !== expectedPluginId) {
    return { ok: false, error: `Import failed: pluginId must be "${expectedPluginId}"` }
  }

  return { ok: true, layout }
}

function validateForPersistence(layout, mode, manifest) {
  const result = validate(layout, manifest)
  const allowed = mode === 'export'
    ? isExportAllowed(result)
    : isSaveAllowed(result)

  if (!result.ok || !allowed) {
    return {
      ok: false,
      error: formatValidationResult(result, mode),
      validationResult: result,
    }
  }

  return { ok: true, layout: result.doc, validationResult: result }
}

function formatValidationResult(result, mode) {
  const action = mode === 'import'
    ? 'Imported layout is blocked by validation'
    : mode === 'export'
      ? 'Export blocked by validation'
      : 'Save blocked by validation'
  const errors = result?.errors || []
  if (!errors.length) return action
  return `${action}: ${errors.map(formatValidationError).join('; ')}`
}

function fail(store, error) {
  const message = String(error?.message || error || 'Layout persistence failed')
  store.setSaveError?.(message)
  store.setPersistenceMessage?.(message)
  return { ok: false, error: message }
}

function getPluginUiIpc() {
  return (typeof window !== 'undefined' && window.xleth?.pluginUi) || null
}
