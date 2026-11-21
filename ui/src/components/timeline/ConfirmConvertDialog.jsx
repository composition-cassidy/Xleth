import { Button, Dialog, DialogText } from '../../ui-kit'

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
  return (
    <Dialog
      title={title}
      width="sm"
      onClose={onCancel}
      onEnter={onConfirm}
      actions={
        <>
          <Button size="lg" onClick={onCancel}>{cancelLabel}</Button>
          <Button size="lg" variant={danger ? 'danger' : 'primary'} onClick={onConfirm} data-autofocus>
            {confirmLabel}
          </Button>
        </>
      }
    >
      {typeof message === 'string' ? <DialogText>{message}</DialogText> : message}
    </Dialog>
  )
}
