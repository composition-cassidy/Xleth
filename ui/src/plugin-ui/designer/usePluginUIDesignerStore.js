import { create } from 'zustand'
import { SHIPPED_LAYOUTS } from '../layouts/index.js'
import { getManifest } from '../manifests/index.js'
import { validate } from '../schema/validate.js'

// Phase B store — load + selection only.
// Mutations, undo/redo, save, import/export land in Phases D–I.

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

  isLoading:        false,
  loadError:        null,
}

export const usePluginUIDesignerStore = create((set, get) => ({
  ...initialState,

  // ── Setters (limited surface for Phase B/C) ─────────────────────────────────

  setWorkingLayout(layout) {
    const { manifest, savedOverride } = get()
    const result = manifest ? validate(layout, manifest) : { ok: true, errors: [] }
    const nextLayout = result.ok ? result.doc : layout
    set({
      workingLayout:    nextLayout,
      validationResult: result,
      dirty:            !shallowEqualLayout(nextLayout, savedOverride),
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
    const shipped  = SHIPPED_LAYOUTS[pluginId] ?? null

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

    const baseLayout = savedOverride ?? shipped
    const result     = validate(baseLayout, manifest)
    const workingLayout = result.ok ? result.doc : baseLayout

    set({
      pluginId,
      manifest,
      shippedLayout:    shipped,
      savedOverride,
      workingLayout,
      validationResult: result,
      selectedNodeId:   null,
      expandedNodeIds:  defaultExpanded(workingLayout),
      dirty:            false,
      isLoading:        false,
      loadError:        loadWarning,
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
