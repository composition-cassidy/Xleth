import React, { useCallback, useEffect, useRef } from 'react'
import './styles/designer.css'
import { usePluginUIDesignerStore } from './usePluginUIDesignerStore.js'
import LayoutTreePanel from './LayoutTreePanel.jsx'
import InspectorPanel from './InspectorPanel.jsx'
import ComponentPalette from './ComponentPalette.jsx'
import ValidationPanel from './ValidationPanel.jsx'
import { getValidationSummary } from './validationStatus.js'
import {
  clearUserOverrideOnDisk,
  discardUnsavedChanges,
  exportCurrentLayout,
  importLayoutFromDialog,
  resetToShippedDefault,
  saveCurrentLayout,
} from './persistenceActions.js'

// Right-side docked Designer column.
// Phases A-I, Compressor-only:
//   - Loads shipped/user layout into workingLayout (Phase B).
//   - Renders a Layout Tree with selection support (Phase C).
//   - Inspector supports safe common/style edits (Phase D).
//   - Palette, tree mutations, binding pickers, and validation are wired (E-G).
//   - Undo/redo are in-memory only (Phase I).
//   - Save/reset/import/export persist Compressor .xlethui.json layouts (Phase H).
//
// The runtime preview is NOT mounted by this component. CompressorPanel mounts
// one StockPluginRuntimeRenderer; when the Designer is open, that single mount
// receives layoutOverride={workingLayout} from this store. This avoids two
// renderers competing over the same engine target.
//
// The selection outline overlay is rendered inside the runtime preview pane by
// the parent panel; this component owns the store but not the preview DOM.

export default function PluginUIDesigner({ pluginId, onClose, registerCloseGuard }) {
  const loadInitial   = usePluginUIDesignerStore(s => s.loadInitial)
  const isLoading     = usePluginUIDesignerStore(s => s.isLoading)
  const loadError     = usePluginUIDesignerStore(s => s.loadError)
  const mutationError = usePluginUIDesignerStore(s => s.mutationError)
  const persistenceMessage = usePluginUIDesignerStore(s => s.persistenceMessage)
  const saveError     = usePluginUIDesignerStore(s => s.saveError)
  const dirty         = usePluginUIDesignerStore(s => s.dirty)
  const undo          = usePluginUIDesignerStore(s => s.undo)
  const redo          = usePluginUIDesignerStore(s => s.redo)
  const setMutationError = usePluginUIDesignerStore(s => s.setMutationError)
  const rootRef      = useRef(null)
  const designerActiveRef = useRef(false)

  useEffect(() => {
    loadInitial(pluginId)
  }, [loadInitial, pluginId])

  useEffect(() => {
    const handlePointerDown = event => {
      designerActiveRef.current = !!rootRef.current?.contains(event.target)
    }

    const handleKeyDown = event => {
      if (!designerActiveRef.current && !rootRef.current?.contains(document.activeElement)) return
      if (!event.ctrlKey || event.altKey || event.metaKey) return
      if (isEditableElement(event.target)) return

      const key = String(event.key || '').toLowerCase()
      const wantsUndo = key === 'z' && !event.shiftKey
      const wantsRedo = (key === 'z' && event.shiftKey) || key === 'y'
      if (!wantsUndo && !wantsRedo) return

      event.preventDefault()
      try {
        const result = wantsUndo ? undo() : redo()
        if (result?.ok === false && !/nothing to (undo|redo)/i.test(result.error || '')) {
          setMutationError(result.error || 'Layout history action failed')
        }
      } catch (err) {
        setMutationError(err)
      }
    }

    document.addEventListener('pointerdown', handlePointerDown, true)
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown, true)
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [redo, setMutationError, undo])

  const requestClose = useCallback(async () => {
    if (!dirty) {
      return true
    }

    const wantsSave = window.confirm('You have unsaved layout changes. Save before closing?')
    if (wantsSave) {
      const result = await saveCurrentLayout()
      return !!result.ok
    }

    const wantsDiscard = window.confirm('Discard unsaved layout changes and close Designer?')
    if (wantsDiscard) {
      discardUnsavedChanges()
      return true
    }
    return false
  }, [dirty])

  useEffect(() => {
    if (typeof registerCloseGuard !== 'function') return undefined
    return registerCloseGuard(requestClose)
  }, [registerCloseGuard, requestClose])

  const handleClose = async () => {
    if (await requestClose()) onClose?.()
  }

  return (
    <div ref={rootRef} className="pluginui-designer-root" role="complementary" aria-label="Plugin UI Designer">
      <Toolbar onClose={onClose ? handleClose : null} />

      {isLoading && (
        <div className="pluginui-designer-loading">Loading layout…</div>
      )}

      {loadError && !isLoading && (
        <div className="pluginui-designer-error" title={loadError}>
          {loadError}
        </div>
      )}

      {mutationError && (
        <div className="pluginui-designer-mutation-error" role="status" title={mutationError}>
          {mutationError}
        </div>
      )}

      {persistenceMessage && (
        <div
          className={[
            'pluginui-designer-toast',
            saveError && 'pluginui-designer-toast--error',
          ].filter(Boolean).join(' ')}
          role="status"
          title={persistenceMessage}
        >
          {persistenceMessage}
        </div>
      )}

      <Section title="Layout Tree" grow>
        <LayoutTreePanel />
      </Section>

      <Section title="Inspector" scrollable>
        <InspectorPanel />
      </Section>

      <Section title="Palette">
        <ComponentPalette />
      </Section>

      <Section title="Validation">
        <ValidationPanel />
      </Section>
    </div>
  )
}

function Toolbar({ onClose }) {
  const validationResult = usePluginUIDesignerStore(s => s.validationResult)
  const workingLayout = usePluginUIDesignerStore(s => s.workingLayout)
  const dirty = usePluginUIDesignerStore(s => s.dirty)
  const isSaving = usePluginUIDesignerStore(s => s.isSaving)
  const isImporting = usePluginUIDesignerStore(s => s.isImporting)
  const isExporting = usePluginUIDesignerStore(s => s.isExporting)
  const undoStack = usePluginUIDesignerStore(s => s.undoStack)
  const redoStack = usePluginUIDesignerStore(s => s.redoStack)
  const undo = usePluginUIDesignerStore(s => s.undo)
  const redo = usePluginUIDesignerStore(s => s.redo)
  const setMutationError = usePluginUIDesignerStore(s => s.setMutationError)
  const summary = getValidationSummary(validationResult)
  const undoEnabled = undoStack.length > 0
  const redoEnabled = redoStack.length > 0
  const busy = isSaving || isImporting || isExporting
  const layoutLoaded = !!workingLayout
  const saveEnabled = dirty && summary.canSave && !busy
  const importEnabled = !busy
  const exportEnabled = summary.canExport && !busy && layoutLoaded
  const resetEnabled = layoutLoaded && !busy

  const runHistoryAction = action => {
    try {
      const result = action()
      if (result?.ok === false && !/nothing to (undo|redo)/i.test(result.error || '')) {
        setMutationError(result.error || 'Layout history action failed')
      }
    } catch (err) {
      setMutationError(err)
    }
  }

  const runAsyncAction = async action => {
    try {
      const result = await action()
      if (result?.ok === false && result.error) {
        setMutationError(null)
      }
    } catch (err) {
      setMutationError(err)
    }
  }

  const confirmClearOverride = () => {
    if (!window.confirm('Delete the saved UI override and return to the shipped layout?')) return
    runAsyncAction(clearUserOverrideOnDisk)
  }

  return (
    <div className="pluginui-designer-toolbar" role="toolbar" aria-label="Designer toolbar">
      <button
        className="pluginui-designer-button pluginui-designer-button--primary"
        disabled={!saveEnabled}
        title={saveEnabled ? 'Save user override layout' : 'Save requires unsaved valid changes'}
        onClick={() => runAsyncAction(saveCurrentLayout)}
      >
        {isSaving ? 'Saving...' : 'Save'}
      </button>
      <button
        className="pluginui-designer-button"
        disabled={!importEnabled}
        title="Import .xlethui.json layout"
        onClick={() => runAsyncAction(importLayoutFromDialog)}
      >
        {isImporting ? 'Importing...' : 'Import'}
      </button>
      <button
        className="pluginui-designer-button"
        disabled={!exportEnabled}
        title={exportEnabled ? 'Export current layout' : 'Export requires a valid layout'}
        onClick={() => runAsyncAction(exportCurrentLayout)}
      >
        {isExporting ? 'Exporting...' : 'Export'}
      </button>
      <div className="pluginui-designer-reset-group" aria-label="Reset actions">
        <button
          className="pluginui-designer-button pluginui-designer-button--compact"
          disabled={!resetEnabled}
          title="Reset working layout to shipped default"
          onClick={resetToShippedDefault}
        >
          Reset to Shipped
        </button>
        <button
          className="pluginui-designer-button pluginui-designer-button--compact"
          disabled={!resetEnabled || !dirty}
          title="Discard unsaved layout changes"
          onClick={discardUnsavedChanges}
        >
          Discard Changes
        </button>
        <button
          className="pluginui-designer-button pluginui-designer-button--compact pluginui-designer-button--danger"
          disabled={!resetEnabled}
          title="Delete saved user override"
          onClick={confirmClearOverride}
        >
          Clear Override
        </button>
      </div>
      <button
        className="pluginui-designer-button"
        disabled={!undoEnabled || busy}
        title="Undo latest layout edit"
        onClick={() => runHistoryAction(undo)}
      >
        Undo
      </button>
      <button
        className="pluginui-designer-button"
        disabled={!redoEnabled || busy}
        title="Redo latest undone layout edit"
        onClick={() => runHistoryAction(redo)}
      >
        Redo
      </button>
      <div
        className={[
          'pluginui-designer-toolbar-validation',
          `pluginui-designer-toolbar-validation--${summary.severity}`,
        ].join(' ')}
        title={`Save: ${summary.canSave ? 'eligible' : 'blocked'}; Export: ${summary.canExport ? 'eligible' : 'blocked'}`}
      >
        <span>{summary.label}</span>
        <span className="pluginui-designer-toolbar-validation-eligibility">
          save {summary.canSave ? 'yes' : 'no'} / export {summary.canExport ? 'yes' : 'no'}
        </span>
      </div>
      {onClose && (
        <button
          className="pluginui-designer-button pluginui-designer-button--close"
          onClick={onClose}
          title="Close Designer"
        >
          Close
        </button>
      )}
    </div>
  )
}

function isEditableElement(target) {
  if (!target || typeof target.closest !== 'function') return false
  return !!target.closest('input, textarea, select, [contenteditable="true"]')
}

function Section({ title, grow, scrollable, children }) {
  const cls = [
    'pluginui-designer-section',
    grow && 'pluginui-designer-section--grow',
    scrollable && 'pluginui-designer-section--scrollable',
  ].filter(Boolean).join(' ')
  return (
    <div className={cls}>
      <div className="pluginui-designer-section-header">{title}</div>
      <div className="pluginui-designer-section-body">{children}</div>
    </div>
  )
}
