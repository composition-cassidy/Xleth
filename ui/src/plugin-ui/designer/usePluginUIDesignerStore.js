import { create } from 'zustand'
import { SHIPPED_LAYOUTS } from '../layouts/index.js'
import { getManifest } from '../manifests/index.js'
import { validate } from '../schema/validate.js'
import {
  applyRedo,
  applyUndo,
  clearRedoStack as clearRedoStackHelper,
  pushUndoSnapshot as pushUndoSnapshotHelper,
} from './undoRedo.js'
import { nodeExists } from './layoutMutations.js'

// Designer state for the in-memory Compressor layout editor.
// Phase H persistence state is intentionally UI-only: layout JSON is saved via
// the narrow pluginUi IPC surface, never by giving the renderer raw fs access.

const initialState = {
  pluginId:        null,
  manifest:        null,

  workingLayout:   null,
  shippedLayout:   null,
  savedOverride:   null,

  selectedNodeId:  null,
  expandedNodeIds: new Set(),

  validationResult: { ok: true, errors: [] },
  dirty:            false,
  mutationError:    null,
  persistenceMessage: null,

  undoStack:         [],
  redoStack:         [],
  pendingCoalesce:   null,
  lastEditMeta:      null,

  isLoading:        false,
  loadError:        null,
  isSaving:         false,
  isImporting:      false,
  isExporting:      false,
  saveError:        null,
  lastSavedAt:      null,
}

export const usePluginUIDesignerStore = create((set, get) => ({
  ...initialState,

  // ── Setters (limited surface for Phase B/C) ─────────────────────────────────

  setWorkingLayout(layout) {
    const { manifest, savedOverride, shippedLayout } = get()
    const result = manifest ? validate(layout, manifest) : { ok: true, errors: [] }
    const nextLayout = result.ok ? result.doc : layout
    set({
      workingLayout:    nextLayout,
      validationResult: result,
      dirty:            !layoutMatchesSavedBase(nextLayout, savedOverride, shippedLayout),
    })
  },

  setSelectedNodeId(nodeId) {
    set({ selectedNodeId: nodeId ?? null })
  },

  setValidationResult(result) {
    set({ validationResult: result || { ok: true, errors: [] } })
  },

  setDirty(flag) {
    set({ dirty: !!flag })
  },

  setMutationError(errorOrNull) {
    set({ mutationError: errorOrNull ? String(errorOrNull?.message || errorOrNull) : null })
  },

  setPersistenceMessage(messageOrNull) {
    set({ persistenceMessage: messageOrNull ? String(messageOrNull) : null })
  },

  setPersistenceBusy(kind, flag) {
    const key = {
      saving: 'isSaving',
      importing: 'isImporting',
      exporting: 'isExporting',
    }[kind]
    if (key) set({ [key]: !!flag })
  },

  setSaveError(errorOrNull) {
    set({ saveError: errorOrNull ? String(errorOrNull?.message || errorOrNull) : null })
  },

  setUndoStack(stack) {
    set({ undoStack: Array.isArray(stack) ? [...stack] : [] })
  },

  setRedoStack(stack) {
    set({ redoStack: Array.isArray(stack) ? [...stack] : [] })
  },

  setPendingCoalesce(coalesce) {
    set({ pendingCoalesce: coalesce ?? null })
  },

  pushUndoSnapshot(reason, options) {
    const current = get()
    const next = pushUndoSnapshotHelper(current, reason, options)
    set({
      undoStack:       next.undoStack,
      redoStack:       next.redoStack,
      pendingCoalesce: next.pendingCoalesce,
      lastEditMeta:    next.pendingCoalesce,
    })
  },

  clearRedoStack() {
    const next = clearRedoStackHelper(get())
    set({ redoStack: next.redoStack || [] })
  },

  undo() {
    try {
      const next = applyUndo(get())
      if (!next) return { ok: false, error: 'Nothing to undo' }
      set(next)
      return { ok: true, layout: next.workingLayout, selectedNodeId: next.selectedNodeId }
    } catch (err) {
      const message = String(err?.message || err || 'Undo failed')
      set({ mutationError: message })
      return { ok: false, error: message }
    }
  },

  redo() {
    try {
      const next = applyRedo(get())
      if (!next) return { ok: false, error: 'Nothing to redo' }
      set(next)
      return { ok: true, layout: next.workingLayout, selectedNodeId: next.selectedNodeId }
    } catch (err) {
      const message = String(err?.message || err || 'Redo failed')
      set({ mutationError: message })
      return { ok: false, error: message }
    }
  },

  clearHistory() {
    set({
      undoStack:       [],
      redoStack:       [],
      pendingCoalesce: null,
      lastEditMeta:    null,
    })
  },

  markSaved(layout) {
    const { manifest } = get()
    const cloned = cloneJson(layout)
    const result = manifest ? validate(cloned, manifest) : { ok: true, doc: cloned, errors: [] }
    const savedLayout = result.ok ? result.doc : cloned
    set({
      savedOverride:      cloneJson(savedLayout),
      workingLayout:      cloneJson(savedLayout),
      validationResult:   result,
      dirty:              false,
      saveError:          null,
      persistenceMessage: 'Saved.',
      lastSavedAt:        Date.now(),
    })
  },

  replaceWithImported(layout) {
    const { manifest, selectedNodeId } = get()
    const cloned = cloneJson(layout)
    const result = manifest ? validate(cloned, manifest) : { ok: true, doc: cloned, errors: [] }
    const nextLayout = result.ok ? result.doc : cloned

    get().pushUndoSnapshot('import layout')
    set({
      workingLayout:      nextLayout,
      validationResult:   result,
      selectedNodeId:     selectedNodeId && nodeExists(nextLayout, selectedNodeId)
        ? selectedNodeId
        : nextLayout?.root?.id ?? null,
      expandedNodeIds:    defaultExpanded(nextLayout),
      dirty:              true,
      mutationError:      null,
      saveError:          null,
      persistenceMessage: 'Imported layout. Save to keep it as your override.',
    })
  },

  resetToShipped() {
    const { shippedLayout, manifest, selectedNodeId, savedOverride } = get()
    if (!shippedLayout) return { ok: false, error: 'No shipped layout is loaded' }

    const nextLayout = cloneJson(shippedLayout)
    const result = manifest ? validate(nextLayout, manifest) : { ok: true, doc: nextLayout, errors: [] }
    const workingLayout = result.ok ? result.doc : nextLayout

    get().pushUndoSnapshot('reset to shipped')
    set({
      workingLayout,
      validationResult:   result,
      selectedNodeId:     selectedNodeId && nodeExists(workingLayout, selectedNodeId)
        ? selectedNodeId
        : workingLayout?.root?.id ?? null,
      expandedNodeIds:    defaultExpanded(workingLayout),
      dirty:              !layoutMatchesSavedBase(workingLayout, savedOverride, shippedLayout),
      mutationError:      null,
      saveError:          null,
      persistenceMessage: 'Reset to shipped layout. Save to keep this change.',
    })
    return { ok: true, layout: workingLayout }
  },

  discardChanges() {
    const { savedOverride, shippedLayout, manifest } = get()
    const baseLayout = cloneJson(savedOverride ?? shippedLayout)
    if (!baseLayout) return { ok: false, error: 'No saved or shipped layout is loaded' }

    const result = manifest ? validate(baseLayout, manifest) : { ok: true, doc: baseLayout, errors: [] }
    const workingLayout = result.ok ? result.doc : baseLayout

    set({
      workingLayout,
      validationResult:   result,
      selectedNodeId:     workingLayout?.root?.id ?? null,
      expandedNodeIds:    defaultExpanded(workingLayout),
      dirty:              false,
      undoStack:          [],
      redoStack:          [],
      pendingCoalesce:    null,
      lastEditMeta:       null,
      mutationError:      null,
      saveError:          null,
      persistenceMessage: 'Changes discarded.',
    })
    return { ok: true, layout: workingLayout }
  },

  clearSavedOverrideState() {
    const { shippedLayout, manifest } = get()
    const nextLayout = cloneJson(shippedLayout)
    const result = nextLayout && manifest ? validate(nextLayout, manifest) : { ok: true, doc: nextLayout, errors: [] }
    const workingLayout = result.ok ? result.doc : nextLayout

    set({
      savedOverride:      null,
      workingLayout,
      validationResult:   result,
      selectedNodeId:     workingLayout?.root?.id ?? null,
      expandedNodeIds:    defaultExpanded(workingLayout),
      dirty:              false,
      undoStack:          [],
      redoStack:          [],
      pendingCoalesce:    null,
      lastEditMeta:       null,
      mutationError:      null,
      saveError:          null,
      persistenceMessage: 'User override cleared.',
    })
  },

  toggleNodeExpanded(nodeId, forceState) {
    const expanded = new Set(get().expandedNodeIds)
    const isOpen = expanded.has(nodeId)
    const nextOpen = typeof forceState === 'boolean' ? forceState : !isOpen
    if (nextOpen) expanded.add(nodeId)
    else expanded.delete(nodeId)
    set({ expandedNodeIds: expanded })
  },

  // ── Loader ─────────────────────────────────────────────────────────────────

  async loadInitial(pluginId) {
    set({
      ...initialState,
      pluginId,
      isLoading: true,
    })

    const manifest = getManifest(pluginId)
    let shipped  = cloneJson(SHIPPED_LAYOUTS[pluginId] ?? null)

    if (!shipped) {
      set({
        manifest,
        shippedLayout:    null,
        workingLayout:    null,
        savedOverride:    null,
        validationResult: { ok: false, errors: [{ code: 'NO_SHIPPED_LAYOUT', message: `No shipped layout for plugin "${pluginId}"` }] },
        isLoading:        false,
        loadError:        `No shipped layout for "${pluginId}"`,
      })
      return
    }

    let savedOverride = null
    let loadWarning   = null
    try {
      const ipc = (typeof window !== 'undefined' && window.xleth?.pluginUi) || null
      if (ipc && typeof ipc.getShipped === 'function') {
        try {
          const rawShipped = await ipc.getShipped(pluginId)
          const validatedShipped = validate(rawShipped, manifest)
          if (validatedShipped.ok) shipped = validatedShipped.doc
        } catch {
          // Packaged builds may not expose a raw JSON file; the bundled import
          // remains the renderer-side fallback.
        }
      }

      if (!ipc || typeof ipc.loadUserOverride !== 'function') {
        loadWarning = 'pluginUi IPC unavailable; using shipped default'
      } else {
        const raw = await ipc.loadUserOverride(pluginId)
        if (raw) {
          const validated = validate(raw, manifest)
          if (validated.ok) {
            savedOverride = validated.doc
          } else {
            loadWarning = 'User override invalid; using shipped default'
          }
        }
      }
    } catch (err) {
      loadWarning = `Could not read user override: ${err?.message || err}`
    }

    const baseLayout = cloneJson(savedOverride ?? shipped)
    const result     = validate(baseLayout, manifest)
    const workingLayout = result.ok ? result.doc : baseLayout

    set({
      pluginId,
      manifest,
      shippedLayout:    cloneJson(shipped),
      savedOverride:    cloneJson(savedOverride),
      workingLayout,
      validationResult: result,
      selectedNodeId:   null,
      expandedNodeIds:  defaultExpanded(workingLayout),
      dirty:            false,
      mutationError:    null,
      undoStack:         [],
      redoStack:         [],
      pendingCoalesce:   null,
      lastEditMeta:      null,
      isLoading:        false,
      loadError:        loadWarning,
      isSaving:         false,
      isImporting:      false,
      isExporting:      false,
      saveError:        null,
      persistenceMessage: null,
      lastSavedAt:      savedOverride ? Date.now() : null,
    })
  },

  reset() {
    set({ ...initialState })
  },
}))

// ── Helpers ──────────────────────────────────────────────────────────────────

function defaultExpanded(layout) {
  const ids = new Set()
  if (!layout?.root) return ids
  // Expand root + first level by default for first cut.
  ids.add(layout.root.id)
  for (const child of layout.root.children || []) {
    if (child?.id) ids.add(child.id)
  }
  return ids
}

function layoutMatchesSavedBase(layout, savedOverride, shippedLayout) {
  return shallowEqualLayout(layout, savedOverride ?? shippedLayout)
}

function shallowEqualLayout(a, b) {
  if (a === b) return true
  if (!a || !b) return false
  // Cheap structural check; layouts are tiny so JSON.stringify is fine here.
  try {
    return JSON.stringify(a) === JSON.stringify(b)
  } catch {
    return false
  }
}

function cloneJson(value) {
  if (value == null) return value
  return JSON.parse(JSON.stringify(value))
}
