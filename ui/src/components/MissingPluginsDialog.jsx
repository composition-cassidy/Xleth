import { useState, useCallback } from 'react'
import { Button, Dialog, DialogList, DialogListItem, DialogText } from '../ui-kit'

// ── MissingPluginsDialog ─────────────────────────────────────────────────────
// Shown after project load when one or more VST3 plugins could not be found.
// Each row has a Retry button (re-scan + resolve) and a Remove button.
// Footer has "Ignore All" (close) and "Remove All Missing" actions.
//
// Props:
//   plugins  – array of { trackId, nodeId, pluginId, pluginName, pluginVendor, filePath }
//   onClose  – called when the dialog should be dismissed (no more missing plugins or user ignores)

export default function MissingPluginsDialog({ plugins: initialPlugins, onClose }) {
  const [plugins, setPlugins] = useState(initialPlugins ?? [])
  const [retrying, setRetrying] = useState({})   // nodeId → true while retrying
  const [removing, setRemoving] = useState(false)

  const trackLabel = (trackId) =>
    trackId === -1 ? 'Master' : `Track ${trackId + 1}`

  const handleRetry = useCallback(async (trackId, nodeId) => {
    setRetrying(prev => ({ ...prev, [nodeId]: true }))
    try {
      const result = await window.xleth?.audio?.retryMissingPlugin?.(trackId, nodeId)
      if (result?.success) {
        setPlugins(prev => prev.filter(p => p.nodeId !== nodeId))
      }
    } finally {
      setRetrying(prev => ({ ...prev, [nodeId]: false }))
    }
  }, [])

  const handleRemove = useCallback(async (trackId, nodeId) => {
    setRetrying(prev => ({ ...prev, [nodeId]: true }))
    try {
      // Re-use retryMissingPlugin — if the plugin is still missing, call removeAllMissing for
      // just this one by calling removeEffect indirectly. Since we have no single-remove API
      // at the missing-plugin level, we do: retry (no-op if still missing), then refresh list.
      // The simplest path: just remove it from the local state and call removeAllMissing,
      // which clears every remaining placeholder including this one.
      // To remove just one node we use the existing audio_removeEffect binding indirectly.
      // The bridge exposes window.xleth.audio.removeEffect(trackId, nodeId) for per-track chains
      // and window.xleth.audio.removeMasterEffect(nodeId) for the master.
      if (trackId === -1) {
        await window.xleth?.audio?.removeMasterEffect?.(nodeId)
      } else {
        await window.xleth?.audio?.removeEffect?.(trackId, nodeId)
      }
      setPlugins(prev => prev.filter(p => p.nodeId !== nodeId))
    } finally {
      setRetrying(prev => ({ ...prev, [nodeId]: false }))
    }
  }, [])

  const handleRemoveAll = useCallback(async () => {
    setRemoving(true)
    try {
      await window.xleth?.audio?.removeAllMissing?.()
      setPlugins([])
    } finally {
      setRemoving(false)
    }
  }, [])

  // Auto-close when all plugins resolved or removed
  if (plugins.length === 0) {
    onClose?.()
    return null
  }

  return (
    <Dialog
      title="Missing plugins"
      width="lg"
      dismissable={false}
      actions={
        <>
          <Button size="lg" onClick={onClose} disabled={removing}>Ignore all</Button>
          <Button size="lg" variant="danger" onClick={handleRemoveAll} disabled={removing}>
            {removing ? 'Removing…' : 'Remove all missing'}
          </Button>
        </>
      }
    >
      <DialogText>
        The following plugins could not be loaded. Audio will pass through without processing
        until they are resolved.
      </DialogText>

      <DialogList label="Missing plugins">
        {plugins.map((p) => (
          <DialogListItem
            key={`${p.trackId}-${p.nodeId}`}
            label={p.pluginName || p.pluginId}
            detail={[p.pluginVendor, trackLabel(p.trackId)].filter(Boolean).join(' · ')}
          >
            <Button
              size="sm"
              onClick={() => handleRetry(p.trackId, p.nodeId)}
              disabled={retrying[p.nodeId]}
              title="Try to load plugin again"
            >
              {retrying[p.nodeId] ? '…' : 'Retry'}
            </Button>
            <Button
              size="sm"
              variant="danger"
              onClick={() => handleRemove(p.trackId, p.nodeId)}
              disabled={retrying[p.nodeId]}
              title="Remove this placeholder from the chain"
            >
              Remove
            </Button>
          </DialogListItem>
        ))}
      </DialogList>
    </Dialog>
  )
}
