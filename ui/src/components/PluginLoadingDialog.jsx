import { useEffect, useState } from 'react'
import { Button, Dialog, DialogList, DialogListItem, DialogText, Progress } from '../ui-kit'
import {
  cancelPluginLoad,
  describePluginLoadError,
  retryPluginLoad,
  usePluginLoadStore,
} from './mixer/pluginEditorLoader.js'
import styles from './PluginLoadingDialog.module.css'

const secs = (ms) => `${(Math.max(0, ms) / 1000).toFixed(1)} s`

/**
 * The loading screen for a third-party plugin: shown while it is inserted into
 * the engine and while its editor window loads in xleth-editor-host, so a slow
 * plugin is met with what is happening instead of a dead click. State lives in
 * pluginEditorLoader.js. Modal on purpose: repeat clicks land on the scrim.
 */
export default function PluginLoadingDialog() {
  const job = usePluginLoadStore((s) => s.job)
  const loading = Boolean(job?.visible) && job.phase !== 'failed'
  const [now, setNow] = useState(() => Date.now())

  // Elapsed time is the one honest number a plugin load has: tick it.
  useEffect(() => {
    if (!loading) return undefined
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), 100)
    return () => clearInterval(timer)
  }, [loading])

  // Escape cancels while loading (the dialog itself ignores Escape so a stray
  // backdrop click from a spam-click cannot cancel).
  useEffect(() => {
    if (!loading) return undefined
    const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); cancelPluginLoad() } }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [loading])

  if (!job?.visible) return null

  const failed = job.phase === 'failed'
  const addValue = job.phase === 'adding' ? 'Loading…'
    : job.openedAt == null ? 'Failed' : secs(job.openedAt - job.startedAt)
  const openValue = job.openedAt == null ? 'Waiting'
    : failed ? 'Failed' : 'Loading…'

  return (
    <Dialog
      title={job.name}
      width="sm"
      dismissable={failed}
      onClose={failed ? cancelPluginLoad : undefined}
      onEnter={failed && job.nodeId != null ? retryPluginLoad : undefined}
      actions={failed ? (
        <>
          <Button size="lg" onClick={cancelPluginLoad}>Close</Button>
          {job.nodeId != null ? (
            <Button size="lg" variant="primary" onClick={retryPluginLoad}>Retry</Button>
          ) : null}
        </>
      ) : (
        <Button size="lg" onClick={cancelPluginLoad}>Cancel</Button>
      )}
    >
      <div className={styles.status} tabIndex={-1} data-autofocus aria-live="polite">
        {job.vendor ? <p className={styles.vendor}>{job.vendor}</p> : null}
        <DialogList label="Loading steps">
          {job.withAddStep ? <DialogListItem label="Load plugin" value={addValue} /> : null}
          <DialogListItem label="Open editor window" value={openValue} strong={!failed && job.phase === 'opening'} />
        </DialogList>
        {failed ? (
          <div role="alert">
            <DialogText>{describePluginLoadError(job.error)}</DialogText>
            {job.nodeId != null ? (
              <DialogText tone="secondary">The plugin is still on the track.</DialogText>
            ) : null}
          </div>
        ) : (
          <>
            <Progress value={null} label={`Loading ${job.name}`} text={secs(now - job.startedAt)} />
            <DialogText tone="secondary">Cancel keeps the plugin on the track.</DialogText>
          </>
        )}
      </div>
    </Dialog>
  )
}
