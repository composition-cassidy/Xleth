import { useEffect, useMemo, useState } from 'react'
import { validateActionCombo } from '../../utils/quantize.js'
import { Button, Dialog, SegmentedControl } from '../../ui-kit'
import styles from './QuantizeDialog.module.css'

// ── QuantizeDialog ───────────────────────────────────────────────────────────
// Per-edge quantize picker for arranger clips and pattern blocks (DESIGN.md 22).
// Start edge and End edge are one SegmentedControl each. Apply emits a single
// onApply({ startAction, endAction }) call; TimelineView does the math + IPC.

const ACTIONS = [
  { id: 'leave',   label: 'Leave',   hint: 'Do not change this edge' },
  { id: 'move',    label: 'Move',    hint: 'Snap the edge and translate the whole clip' },
  { id: 'trim',    label: 'Trim',    hint: 'Snap the edge; the opposite edge stays (offset and duration adjust)' },
  { id: 'stretch', label: 'Stretch', hint: 'Snap the edge; the opposite edge stays and the duration changes through stretchRatio' },
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

  const canApply = validation.ok && selectionCount > 0
  const apply = () => {
    if (!canApply) return
    onApply?.({ startAction, endAction })
  }

  const options = ACTIONS.map((a) => {
    const disabled = a.id === 'stretch' && stretchDisabled
    return { value: a.id, label: a.label, disabled, hint: disabled ? 'Stretch is unavailable for pattern blocks' : a.hint }
  })

  const what = hasClip && hasPatternBlock ? 'clips and pattern blocks'
    : hasPatternBlock ? 'pattern blocks'
      : 'clips'

  return (
    <Dialog
      title="Quantize"
      width="sm"
      onClose={onClose}
      onEnter={apply}
      actions={
        <>
          <Button size="lg" onClick={onClose}>Cancel</Button>
          <Button size="lg" variant="primary" onClick={apply} disabled={!canApply} data-autofocus>Apply</Button>
        </>
      }
    >
      <p className={styles.summary}>
        <span className={styles.numbers}>{selectionCount}</span> selected ({what}), snapped to <span className={styles.numbers}>{snapGranularity}</span>
      </p>

      <div className={styles.edges}>
        <div className={styles.edge}>
          <span className={styles.edgeLabel}>Start edge</span>
          <SegmentedControl
            label="Start edge"
            value={startAction}
            onChange={setStartAction}
            options={options}
            hint="What quantize does to each clip's start"
          />
        </div>
        <div className={styles.edge}>
          <span className={styles.edgeLabel}>End edge</span>
          <SegmentedControl
            label="End edge"
            value={endAction}
            onChange={setEndAction}
            options={options}
            hint="What quantize does to each clip's end"
          />
        </div>
      </div>

      {!validation.ok && (
        <p className={styles.warn} role="alert">{validation.reason}</p>
      )}
    </Dialog>
  )
}
