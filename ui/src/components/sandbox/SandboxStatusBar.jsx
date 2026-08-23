import { useEffect } from 'react'

import useSandboxStore from '../../stores/sandboxStore.js'

const TIERS = ['Fast', 'Balanced', 'Best']

const RENDER_STATE_LABEL = {
  idle: 'Idle',
  rendering: 'Rendering…',
  ready: 'Ready',
  error: 'Error',
}

const COMPOSITE_STATUS_LABEL = {
  rendering: 'Rendering…', error: 'Error', ready: 'Cached', idle: 'Idle',
}

export default function SandboxStatusBar() {
  const layers = useSandboxStore((s) => s.layers)
  const activeLayerId = useSandboxStore((s) => s.activeLayerId)
  const clipboard = useSandboxStore((s) => s.clipboard)
  const history = useSandboxStore((s) => s.history)
  const composite = useSandboxStore((s) => s.composite)
  const compositeAutoRender = useSandboxStore((s) => s.compositeAutoRender)
  const undo = useSandboxStore((s) => s.undo)
  const redo = useSandboxStore((s) => s.redo)
  const refreshHistory = useSandboxStore((s) => s.refreshHistory)
  const layer = layers.find((l) => l.id === activeLayerId) ?? null

  // "Rendering…" covers both the debounce window (an edit just landed, the
  // composite render hasn't fired yet) and the render itself actually being
  // in flight — from the outside they are the same "not caught up yet" state.
  const compositeStatus = composite.renderState === 'error'
    ? 'error'
    : (compositeAutoRender.debouncePending || compositeAutoRender.pending || composite.renderState === 'rendering')
      ? 'rendering'
      : composite.renderedBuffer ? 'ready' : 'idle'

  // The undo stack is SHARED with the Timeline (there is one UndoManager in the
  // engine). These buttons are only live when the next entry is actually a
  // sandbox edit — the engine refuses otherwise, and a button that silently
  // does nothing is worse than a disabled one that explains itself.
  const canUndo = history.canUndo && history.undoDomain === 'sandbox'
  const canRedo = history.canRedo && history.redoDomain === 'sandbox'
  const undoTitle = !history.canUndo
    ? 'Nothing to undo'
    : canUndo
      ? `Undo ${history.undoDescription}`
      : `Next undo is a ${history.undoDomain} edit (${history.undoDescription})`
  const redoTitle = !history.canRedo
    ? 'Nothing to redo'
    : canRedo
      ? `Redo ${history.redoDescription}`
      : `Next redo is a ${history.redoDomain} edit (${history.redoDescription})`

  // The panel can be opened onto a session whose edits it never saw (a project
  // load, or edits made while it was closed), so seed the readout on mount.
  useEffect(() => { refreshHistory() }, [refreshHistory])

  const renderState = layer ? RENDER_STATE_LABEL[layer.renderState] ?? layer.renderState : '—'
  const bufferRate = layer?.renderedBuffer?.sampleRate
    ? `${Math.round(layer.renderedBuffer.sampleRate)} Hz`
    : '—'

  return (
    <div className="sandbox-status-bar">
      <div className="sandbox-tier-strip" title="Separation tiers — coming in a future prompt">
        {TIERS.map((tier) => (
          <button key={tier} className="sandbox-tier-btn" disabled>{tier}</button>
        ))}
      </div>
      <div className="sandbox-session-status">
        <span className={`sandbox-status-item${layer?.renderState === 'error' ? ' error' : ''}`}>
          Render: {renderState}
        </span>
        <span className="sandbox-status-item">Buffer: {bufferRate}</span>
        <span className={`sandbox-status-item${compositeStatus === 'error' ? ' error' : ''}`}>
          Composite: {COMPOSITE_STATUS_LABEL[compositeStatus]}
        </span>
        <span className="sandbox-undo-group">
          <button className="sandbox-undo-btn" disabled={!canUndo} onClick={() => undo()} title={undoTitle}>
            ↶
          </button>
          <button className="sandbox-undo-btn" disabled={!canRedo} onClick={() => redo()} title={redoTitle}>
            ↷
          </button>
          <span className="sandbox-status-item">Undo depth: {history.sandboxUndoCount}</span>
        </span>
        <span className="sandbox-status-item">
          Clipboard: {clipboard ? `${clipboard.numSamples} smp` : 'empty'}
        </span>
      </div>
    </div>
  )
}
