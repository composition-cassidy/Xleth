import { useEffect } from 'react'

import useSandboxStore from '../../stores/sandboxStore.js'

// Bottom readout bar — cursor position, selection start/end/length, undo
// depth, clipboard size. Live: every value here is read straight off the
// store on each render, same source of truth the waveform canvas and op
// stack already use. Render/composite status moved to the toolstrip's render
// chip and the Composite section (Sources & Layers panel) respectively, so
// this bar isn't a second copy of state shown elsewhere.
function formatSec(samples, sampleRate) {
  if (!sampleRate || samples == null) return '0.000'
  return (samples / sampleRate).toFixed(3)
}

export default function SandboxStatusBar() {
  const layers = useSandboxStore((s) => s.layers)
  const activeLayerId = useSandboxStore((s) => s.activeLayerId)
  const selection = useSandboxStore((s) => s.selection)
  const clipboard = useSandboxStore((s) => s.clipboard)
  const history = useSandboxStore((s) => s.history)
  const undo = useSandboxStore((s) => s.undo)
  const redo = useSandboxStore((s) => s.redo)
  const refreshHistory = useSandboxStore((s) => s.refreshHistory)
  const layer = layers.find((l) => l.id === activeLayerId) ?? null

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

  const sampleRate = layer?.renderedBuffer?.sampleRate
  const hasSelection = !!selection && selection.endSample > selection.startSample
  const cursorSample = selection?.startSample ?? 0
  const lengthSamples = hasSelection ? selection.endSample - selection.startSample : 0

  return (
    <div className="sandbox-status-bar">
      <div className="sandbox-readout-group">
        <span className="sandbox-status-item">Cursor: {formatSec(cursorSample, sampleRate)}</span>
        <span className="sandbox-status-item">
          Sel: {hasSelection ? `${formatSec(selection.startSample, sampleRate)} – ${formatSec(selection.endSample, sampleRate)}` : '—'}
        </span>
        <span className="sandbox-status-item">Len: {hasSelection ? `${formatSec(lengthSamples, sampleRate)}s` : '—'}</span>
      </div>
      <div className="sandbox-readout-group">
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
