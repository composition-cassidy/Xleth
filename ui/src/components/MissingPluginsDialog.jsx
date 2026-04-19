import { useState, useCallback } from 'react'

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
    <div className="export-dialog-backdrop missing-plugins-backdrop">
      <div className="export-dialog missing-plugins-dialog">

        <div className="export-dialog-header">
          <span className="export-dialog-title">Missing Plugins</span>
        </div>

        <div className="export-dialog-body missing-plugins-body">
          <p className="missing-plugins-desc">
            The following plugins could not be loaded. Audio will pass through without processing
            until they are resolved.
          </p>

          <div className="missing-plugins-list">
            {plugins.map((p) => (
              <div key={`${p.trackId}-${p.nodeId}`} className="missing-plugin-row">
                <div className="missing-plugin-info">
                  <span className="missing-plugin-name">{p.pluginName || p.pluginId}</span>
                  {p.pluginVendor && (
                    <span className="missing-plugin-vendor">{p.pluginVendor}</span>
                  )}
                  <span className="missing-plugin-chain">{trackLabel(p.trackId)}</span>
                </div>
                <div className="missing-plugin-actions">
                  <button
                    className="missing-plugin-btn"
                    onClick={() => handleRetry(p.trackId, p.nodeId)}
                    disabled={retrying[p.nodeId]}
                    title="Try to load plugin again"
                  >
                    {retrying[p.nodeId] ? '…' : 'Retry'}
                  </button>
                  <button
                    className="missing-plugin-btn missing-plugin-btn-remove"
                    onClick={() => handleRemove(p.trackId, p.nodeId)}
                    disabled={retrying[p.nodeId]}
                    title="Remove this placeholder from the chain"
                  >
                    Remove
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className="export-dialog-footer">
          <button
            className="export-dialog-footer button"
            onClick={onClose}
            disabled={removing}
          >
            Ignore All
          </button>
          <button
            className="export-dialog-footer button export-btn-danger"
            onClick={handleRemoveAll}
            disabled={removing}
          >
            {removing ? 'Removing…' : 'Remove All Missing'}
          </button>
        </div>

      </div>
    </div>
  )
}
