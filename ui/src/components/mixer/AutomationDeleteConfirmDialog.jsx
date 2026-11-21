import { Button, Dialog, DialogList, DialogListItem, DialogText } from '../../ui-kit'

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
  const count = clips.length

  return (
    <Dialog
      title={title}
      width="md"
      onClose={onCancel}
      onEnter={onConfirm}
      actions={
        <>
          <Button size="lg" onClick={onCancel} data-autofocus>Cancel</Button>
          <Button size="lg" variant="danger" onClick={onConfirm}>Delete anyway</Button>
        </>
      }
    >
      <DialogText>
        {`Deleting ${subject} will also delete ${count} automation clip${count === 1 ? '' : 's'} bound to `}
        {count === 1 ? 'it' : 'its parameters'}:
      </DialogText>
      <DialogList label="Automation clips that will be deleted">
        {clips.map((c) => (
          <DialogListItem key={c.id} label={c.label} value={c.position} />
        ))}
      </DialogList>
      <DialogText tone="secondary">Undo restores the automation clips and their lanes in one step.</DialogText>
    </Dialog>
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
