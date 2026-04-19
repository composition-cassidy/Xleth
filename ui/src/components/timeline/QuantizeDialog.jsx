import { useEffect, useMemo, useState } from 'react'
import { validateActionCombo } from '../../utils/quantize.js'

// ── QuantizeDialog ───────────────────────────────────────────────────────────
// Per-edge quantize picker for arranger clips and pattern blocks.
// Two radio columns (Start edge, End edge). The Apply button emits a single
// onApply({ startAction, endAction }) call; TimelineView does the math + IPC.

const ACTIONS = [
  { id: 'leave',   label: 'Leave',   hint: 'Do not change this edge' },
  { id: 'move',    label: 'Move',    hint: 'Snap the edge and translate the whole clip' },
  { id: 'trim',    label: 'Trim',    hint: 'Snap the edge; opposite edge stays (offset/duration adjust)' },
  { id: 'stretch', label: 'Stretch', hint: 'Snap the edge; opposite edge stays, duration changes via stretchRatio' },
]

export default function QuantizeDialog({
  isOpen,
  onClose,
  onApply,
  snapGranularity,
  selectionCount,
  hasPatternBlock,
  hasClip,
}) {
  const [startAction, setStartAction] = useState('leave')
  const [endAction,   setEndAction]   = useState('trim')

  // Reset to sensible defaults each open.
  useEffect(() => {
    if (isOpen) {
      setStartAction('leave')
      setEndAction('trim')
    }
  }, [isOpen])

  const stretchDisabled = hasPatternBlock // mixed or pure pattern blocks
  const validation = useMemo(
    () => validateActionCombo(startAction, endAction, hasPatternBlock),
    [startAction, endAction, hasPatternBlock]
  )

  if (!isOpen) return null

  const apply = () => {
    if (!validation.ok) return
    onApply?.({ startAction, endAction })
  }

  const renderRadioColumn = (edgeLabel, value, setValue) => (
    <div className="quantize-col">
      <div className="quantize-col-title">{edgeLabel}</div>
      {ACTIONS.map(a => {
        const disabled = a.id === 'stretch' && stretchDisabled
        return (
          <label
            key={a.id}
            className={`quantize-radio ${value === a.id ? 'active' : ''} ${disabled ? 'disabled' : ''}`}
            title={disabled ? 'Stretch unavailable for pattern blocks' : a.hint}
          >
            <input
              type="radio"
              name={`quantize-${edgeLabel}`}
              checked={value === a.id}
              disabled={disabled}
              onChange={() => setValue(a.id)}
            />
            <span>{a.label}</span>
          </label>
        )
      })}
    </div>
  )

  return (
    <div className="quantize-dialog-backdrop" onClick={onClose}>
      <div className="quantize-dialog" onClick={e => e.stopPropagation()}>
        <div className="quantize-dialog-header">
          <span>Quantize · snap {snapGranularity}</span>
          <button className="quantize-dialog-close" onClick={onClose} title="Close">×</button>
        </div>

        <div className="quantize-dialog-body">
          <div className="quantize-summary">
            {selectionCount} selected
            {hasClip && hasPatternBlock ? ' (clips + pattern blocks)'
              : hasPatternBlock ? ' (pattern blocks)'
              : ' (clips)'}
          </div>

          <div className="quantize-cols">
            {renderRadioColumn('Start edge', startAction, setStartAction)}
            {renderRadioColumn('End edge',   endAction,   setEndAction)}
          </div>

          {!validation.ok && (
            <div className="quantize-warn">{validation.reason}</div>
          )}
        </div>

        <div className="quantize-dialog-footer">
          <button onClick={onClose}>Cancel</button>
          <button
            className="quantize-btn-primary"
            onClick={apply}
            disabled={!validation.ok || selectionCount === 0}
          >Apply</button>
        </div>
      </div>
    </div>
  )
}
