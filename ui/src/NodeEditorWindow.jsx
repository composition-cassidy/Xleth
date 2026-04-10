import { useCallback, useEffect } from 'react'
import NodeEditor from './components/mixer/NodeEditor.jsx'
import '@xyflow/react/dist/style.css'

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
        <NodeEditor storeKey={storeKey} />
      </div>
    </div>
  )
}
