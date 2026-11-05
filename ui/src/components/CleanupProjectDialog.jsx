import { useEffect } from 'react'
import { createPortal } from 'react-dom'
import { formatFreed } from './projectCleanup.js'

/**
 * "Clean up project" confirmation. Shows exactly what will be deleted (per
 * category, with sizes) and — just as important — what will be KEPT and why,
 * so a proxy that is the only remaining copy of an offline source is never a
 * surprise. Nothing here is deleted until the user confirms.
 *
 * `scan` is the engine's project_cleanupScan result. Imperative promise wrapper
 * below (`showCleanupProjectDialog`) resolves true (Clean up) / false (Cancel).
 * Esc → cancel, Enter → confirm, backdrop click → cancel.
 */
export default function CleanupProjectDialog({ scan, onConfirm, onCancel }) {
  useEffect(() => {
    const handler = (e) => {
      if (e.key === 'Escape') onCancel?.()
      if (e.key === 'Enter') onConfirm?.()
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onCancel, onConfirm])

  const willFree = scan?.willFree || { files: 0, bytes: 0, categories: [] }
  const kept = scan?.kept || { files: 0, bytes: 0, items: [] }

  return createPortal(
    <div className="confirm-dialog-backdrop cleanup-dialog-backdrop" onClick={onCancel}>
      <div
        className="confirm-dialog cleanup-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="cleanup-dialog-title"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="confirm-dialog-header" id="cleanup-dialog-title">Clean up project</div>

        <p className="cleanup-dialog-lead">
          Delete leftover and unused preview files to free disk space. Xleth
          rebuilds anything it still needs. Your source media and the project
          file are never touched.
        </p>

        <ul className="cleanup-dialog-list" aria-label="Files to delete">
          {willFree.categories.map((c) => (
            <li className="cleanup-dialog-item" key={c.id}>
              <span className="cleanup-dialog-item-label">{c.label}</span>
              <span className="cleanup-dialog-item-size">
                {c.files} file{c.files === 1 ? '' : 's'} · {formatFreed(c.bytes)}
              </span>
            </li>
          ))}
          <li className="cleanup-dialog-item cleanup-dialog-total">
            <span className="cleanup-dialog-item-label">Will free</span>
            <span className="cleanup-dialog-item-size">
              {willFree.files} file{willFree.files === 1 ? '' : 's'} · {formatFreed(willFree.bytes)}
            </span>
          </li>
        </ul>

        {kept.files > 0 && (
          <p className="cleanup-dialog-note">
            Kept: {kept.files} file{kept.files === 1 ? '' : 's'} ({formatFreed(kept.bytes)}). Their
            source media is offline, so they cannot be rebuilt — relink the media to include them.
            {kept.items?.length > 0 && (
              <span className="cleanup-dialog-kept-names">
                {' '}({kept.items.map((i) => i.name).join(', ')}{kept.files > kept.items.length ? ', …' : ''})
              </span>
            )}
          </p>
        )}
        {scan?.partialsSkipped && (
          <p className="cleanup-dialog-note">
            A background job is still running, so its unfinished files are left alone.
          </p>
        )}

        <div className="confirm-dialog-footer">
          <button className="confirm-dialog-btn" onClick={onCancel}>Cancel</button>
          <button className="confirm-dialog-btn primary" onClick={onConfirm} autoFocus>
            Clean up {formatFreed(willFree.bytes)}
          </button>
        </div>
      </div>
    </div>,
    document.body
  )
}

/**
 * Imperative promise-based launcher (same pattern as showUnsavedChangesDialog):
 * mounts the dialog under document.body and resolves with the user's choice.
 */
export function showCleanupProjectDialog(scan) {
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
        <CleanupProjectDialog
          scan={scan}
          onConfirm={() => done(true)}
          onCancel={() => done(false)}
        />
      )
    })
  })
}
