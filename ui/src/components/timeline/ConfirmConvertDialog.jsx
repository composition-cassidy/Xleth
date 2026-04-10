import { useEffect } from 'react'
import { createPortal } from 'react-dom'

/**
 * Lightweight confirmation modal for destructive track operations.
 *
 * Props:
 *   title        – heading text
 *   message      – body paragraph (string or JSX)
 *   confirmLabel – button text for confirm (default "Confirm")
 *   cancelLabel  – button text for cancel (default "Cancel")
 *   onConfirm, onCancel – callbacks
 *   danger       – render confirm button with danger styling
 */
export default function ConfirmConvertDialog({
  title, message, confirmLabel = 'Confirm', cancelLabel = 'Cancel',
  onConfirm, onCancel, danger = true,
}) {
  useEffect(() => {
    const handler = (e) => {
      if (e.key === 'Escape') onCancel?.()
      if (e.key === 'Enter')  onConfirm?.()
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onCancel, onConfirm])

  return createPortal(
    <div className="confirm-dialog-backdrop" onClick={onCancel}>
      <div className="confirm-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="confirm-dialog-header">{title}</div>
        <div className="confirm-dialog-body">{message}</div>
        <div className="confirm-dialog-footer">
          <button className="confirm-dialog-btn" onClick={onCancel}>{cancelLabel}</button>
          <button
            className={`confirm-dialog-btn ${danger ? 'danger' : 'primary'}`}
            onClick={onConfirm}
            autoFocus
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>,
    document.body
  )
}
