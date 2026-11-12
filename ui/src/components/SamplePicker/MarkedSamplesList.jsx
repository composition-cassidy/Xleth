import { EmptyState, IconButton, SplitSyllablesIcon } from '../../ui-kit'
import { labelColor } from '../../constants/labels.js'
import { formatSpan, formatTimecode } from './pickerFormat.js'
import styles from './SamplePicker.module.css'
import { iconComponent } from '../../ui-kit/icons'

const IcEyeFill = iconComponent('eye', 'fill')
const IcEyeSlashReg = iconComponent('eye-slash', 'regular')
const IcX = iconComponent('x')

/**
 * The samples already marked on this source. Rows are 24px, the same row the
 * Browser uses for a sample: the label's identity colour as an edge stripe, the
 * name, then tabular numerals. Split and Remove are always visible (they used
 * to appear on hover only).
 *
 * Props:
 *   samples           – Array<{ id, sourceId, startTime, endTime, label, name }>
 *   selectedId        – id | null
 *   onSelect          – (sample) => void   loads its In / Out and seeks to it
 *   onDelete          – (id) => void
 *   onSplit           – (sample) => void   opens Split Syllables (Quote rows)
 *   showMarks         – boolean            marked samples are drawn on the waveform
 *   onToggleShowMarks – () => void
 */
export default function MarkedSamplesList({
  samples, selectedId, onSelect, onDelete, onSplit, showMarks, onToggleShowMarks,
}) {
  return (
    <div className={styles.marked} data-testid="picker-marked">
      <div className={styles.markedHeader}>
        <h3 className={styles.markedTitle}>Marked samples</h3>
        <span className={styles.markedCount} aria-label={`${samples.length} marked`}>{samples.length}</span>
        {onToggleShowMarks ? (
          <IconButton
            size="sm"
            className={styles.markedToggle}
            label="Show marked samples on the waveform"
            pressed={!!showMarks}
            onClick={onToggleShowMarks}
            hint={showMarks
              ? 'Marked samples are drawn on the waveform in their label colours. Click to hide them'
              : 'Draw the marked samples on the waveform in their label colours'}
            data-testid="picker-show-marks"
          >
            {showMarks ? <IcEyeFill aria-hidden="true" /> : <IcEyeSlashReg aria-hidden="true" />}
          </IconButton>
        ) : null}
      </div>

      {samples.length === 0 ? (
        <EmptyState message="No samples marked yet. Mark In and Out on the waveform, then Add sample." />
      ) : (
        <ul className={styles.markedRows}>
          {samples.map((sample) => {
            const selected = sample.id === selectedId
            const length = Math.abs(sample.endTime - sample.startTime)
            return (
              <li
                key={sample.id}
                className={styles.markedRow}
                data-selected={selected || undefined}
                style={{ '--picker-label-color': labelColor(sample.label) }}
              >
                <button
                  type="button"
                  className={styles.markedMain}
                  onClick={() => onSelect(sample)}
                  aria-pressed={selected}
                  data-hint={`${sample.name}: ${sample.label}, ${formatTimecode(sample.startTime)} to ${formatTimecode(sample.endTime)}. Click to load its In and Out`}
                  data-testid="picker-marked-row"
                >
                  <span className={styles.markedName}>{sample.name}</span>
                  {sample.hasSwappedAudio ? <span className={styles.markedTag}>Swapped</span> : null}
                  <span className={styles.markedTime}>{formatTimecode(sample.startTime, 2)}</span>
                  <span className={styles.markedLength}>{formatSpan(length)}</span>
                </button>
                {onSplit && sample.label === 'Quote' ? (
                  <IconButton
                    size="sm"
                    label={`Split syllables of ${sample.name}`}
                    onClick={() => onSplit(sample)}
                    hint="Open Split Syllables for this quote"
                    data-testid="picker-marked-split"
                  >
                    <SplitSyllablesIcon aria-hidden="true" />
                  </IconButton>
                ) : null}
                <IconButton
                  size="sm"
                  label={`Remove ${sample.name}`}
                  onClick={() => onDelete(sample.id)}
                  hint="Remove this sample from the project"
                  data-testid="picker-marked-remove"
                >
                  <IcX aria-hidden="true" />
                </IconButton>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
