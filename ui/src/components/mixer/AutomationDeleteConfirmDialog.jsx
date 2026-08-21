import { useEffect } from 'react'
import { createPortal } from 'react-dom'

// ── Deletion contract dialog (Phase C) ───────────────────────────────────────
//
// Removing an effect instance takes its bound automation clips with it. The
// locked spec requires the user to SEE which clips die before that happens, so
// this dialog names them; Confirm removes clips + effect, Cancel aborts the
// removal entirely (the effect stays, the clips stay).
//
// Same imperative-promise shape as showUnsavedChangesDialog: callable from a
// zustand store action, not just from React component scope, which is exactly
// where the effect-removal path lives.

export default function AutomationDeleteConfirmDialog({ title, subject, clips, onConfirm, onCancel }) {
  useEffect(() => {
    const handler = (e) => {
      if (e.key === 'Escape') onCancel?.()
      if (e.key === 'Enter') onConfirm?.()
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onCancel, onConfirm])

  const count = clips.length

  return createPortal(
    <div className="confirm-dialog-backdrop" onClick={onCancel}>
      <div className="confirm-dialog automation-delete-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="confirm-dialog-header">{title}</div>
        <div className="confirm-dialog-body">
          <p className="automation-delete-lead">
            {`Deleting ${subject} will also delete ${count} automation clip${count === 1 ? '' : 's'} bound to `}
            {count === 1 ? 'it' : 'its parameters'}:
          </p>
          <ul className="automation-delete-list">
            {clips.map((c) => (
              <li key={c.id} className="automation-delete-item">
                <span className="automation-delete-item-param">{c.label}</span>
                <span className="automation-delete-item-pos">{c.position}</span>
              </li>
            ))}
          </ul>
          <p className="automation-delete-note">
            Undo restores the automation clips and their lanes in one step.
          </p>
        </div>
        <div className="confirm-dialog-footer">
          <button className="confirm-dialog-btn" onClick={onCancel} autoFocus>Cancel</button>
          <button className="confirm-dialog-btn danger" onClick={onConfirm}>Delete anyway</button>
        </div>
      </div>
    </div>,
    document.body
  )
}

/**
 * Imperative promise-based launcher. Resolves true (delete) / false (abort).
 * Safe to call from outside React component scope.
 */
export function showAutomationDeleteConfirm({ title, subject, clips }) {
  return new Promise((resolve) => {
    const container = document.createElement('div')
    document.body.appendChild(container)

    import('react-dom/client').then(({ createRoot }) => {
      const root = createRoot(container)
      const done = (result) => {
        root.unmount()
        container.remove()
        resolve(result)
      }
      root.render(
        <AutomationDeleteConfirmDialog
          title={title}
          subject={subject}
          clips={clips}
          onConfirm={() => done(true)}
          onCancel={() => done(false)}
        />
      )
    })
  })
}
