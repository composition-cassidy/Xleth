import { useEffect } from 'react'
import { createPortal } from 'react-dom'

/**
 * Three-way "unsaved changes" prompt. Imperative promise wrapper lives below
 * (`showUnsavedChangesDialog`). Resolves to 'save' | 'discard' | 'cancel'.
 *
 * Esc → cancel, Enter → save, backdrop click → cancel.
 */
export default function UnsavedChangesDialog({ onSave, onDiscard, onCancel }) {
  useEffect(() => {
    const handler = (e) => {
      if (e.key === 'Escape') onCancel?.()
      if (e.key === 'Enter')  onSave?.()
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onCancel, onSave])

  return createPortal(
    <div className="confirm-dialog-backdrop unsaved-dialog-backdrop" onClick={onCancel}>
      <div className="confirm-dialog unsaved-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="confirm-dialog-header">Unsaved changes</div>
        <div className="confirm-dialog-body">
          You have unsaved changes. Save them before starting a new project?
        </div>
        <div className="confirm-dialog-footer unsaved-dialog-footer">
          <button className="confirm-dialog-btn" onClick={onCancel}>Cancel</button>
          <button className="confirm-dialog-btn danger" onClick={onDiscard}>Discard</button>
          <button className="confirm-dialog-btn primary" onClick={onSave} autoFocus>Save</button>
        </div>
      </div>
    </div>,
    document.body
  )
}

/**
 * Imperative promise-based launcher. Mounts the dialog under document.body and
 * resolves with the user's choice. Safe to call from outside React component
 * scope (event handlers, non-component helpers).
 */
export function showUnsavedChangesDialog() {
  return new Promise((resolve) => {
    const container = document.createElement('div')
    document.body.appendChild(container)

    import('react-dom/client').then(({ createRoot }) => {
      const root = createRoot(container)
      const done = (choice) => {
        root.unmount()
        container.remove()
        resolve(choice)
      }
      root.render(
        <UnsavedChangesDialog
          onSave={() => done('save')}
          onDiscard={() => done('discard')}
          onCancel={() => done('cancel')}
        />
      )
    })
  })
}
