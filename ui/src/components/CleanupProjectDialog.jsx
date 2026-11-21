import { Button, Dialog, DialogList, DialogListItem, DialogText } from '../ui-kit'
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
  const willFree = scan?.willFree || { files: 0, bytes: 0, categories: [] }
  const kept = scan?.kept || { files: 0, bytes: 0, items: [] }
  const count = (n) => `${n} file${n === 1 ? '' : 's'}`

  return (
    <Dialog
      title="Clean up project"
      width="md"
      onClose={onCancel}
      onEnter={onConfirm}
      actions={
        <>
          <Button size="lg" onClick={onCancel}>Cancel</Button>
          <Button size="lg" variant="primary" onClick={onConfirm} data-autofocus>
            Clean up {formatFreed(willFree.bytes)}
          </Button>
        </>
      }
    >
      <DialogText>
        Delete leftover and unused preview files to free disk space. Xleth
        rebuilds anything it still needs. Your source media and the project
        file are never touched.
      </DialogText>

      <DialogList label="Files to delete">
        {willFree.categories.map((c) => (
          <DialogListItem key={c.id} label={c.label} value={`${count(c.files)} · ${formatFreed(c.bytes)}`} />
        ))}
        <DialogListItem strong label="Will free" value={`${count(willFree.files)} · ${formatFreed(willFree.bytes)}`} />
      </DialogList>

      {kept.files > 0 && (
        <DialogText tone="secondary">
          Kept: {count(kept.files)} ({formatFreed(kept.bytes)}). Their
          source media is offline, so they cannot be rebuilt — relink the media to include them.
          {kept.items?.length > 0 && (
            <>
              {' '}({kept.items.map((i) => i.name).join(', ')}{kept.files > kept.items.length ? ', …' : ''})
            </>
          )}
        </DialogText>
      )}
      {scan?.partialsSkipped && (
        <DialogText tone="secondary">
          A background job is still running, so its unfinished files are left alone.
        </DialogText>
      )}
    </Dialog>
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
