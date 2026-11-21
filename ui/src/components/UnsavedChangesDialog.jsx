import { Button, Dialog, DialogText } from '../ui-kit'

/**
 * Three-way "unsaved changes" prompt. Imperative promise wrapper lives below
 * (`showUnsavedChangesDialog`). Resolves to 'save' | 'discard' | 'cancel'.
 *
 * Esc → cancel, Enter → save, backdrop click → cancel.
 */
export default function UnsavedChangesDialog({ onSave, onDiscard, onCancel }) {
  return (
    <Dialog
      title="Unsaved changes"
      width="sm"
      onClose={onCancel}
      onEnter={onSave}
      actions={
        <>
          <Button size="lg" onClick={onCancel}>Cancel</Button>
          <Button size="lg" variant="danger" onClick={onDiscard}>Discard</Button>
          <Button size="lg" variant="primary" onClick={onSave} data-autofocus>Save</Button>
        </>
      }
    >
      <DialogText>You have unsaved changes. Save them before starting a new project?</DialogText>
    </Dialog>
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
