import { useCallback, useEffect } from 'react'

export default function NodeEditorWindow({ storeKey, trackPos }) {
  const handleClose = useCallback(() => {
    window.xleth?.window?.closeNodeEditor()
  }, [])

  // Escape key closes window
  useEffect(() => {
    const onKeyDown = (e) => {
      if (e.key === 'Escape') window.xleth?.window?.closeNodeEditor()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [])

  const label = storeKey === 'master' ? 'Master' : `Track ${trackPos ?? storeKey}`

  return (
    <div className="node-editor-window">
      <div className="node-editor-window-titlebar">
        <span className="node-editor-window-title">
          Node Editor &mdash; {label}
        </span>
        <button
          className="node-editor-window-close"
          onClick={handleClose}
          title="Close"
        >
          &times;
        </button>
      </div>
      <div className="node-editor-window-body">
        <div className="node-editor-window-quarantine" role="note">
          <div className="node-editor-window-quarantine-title">
            Legacy Node Editor Disabled
          </div>
          <div className="node-editor-window-quarantine-copy">
            FX Graph will return in a separate workspace after renderer and routing safety work is complete.
          </div>
        </div>
      </div>
    </div>
  )
}
