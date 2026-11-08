import React from 'react'
import { gmDrumName } from './filenameMatch.js'
import { MAX_NOTE_LENGTH_OPTIONS, DEFAULT_MAX_NOTE_LENGTH_DENOM } from './maxNoteLength.js'
import MidiSampleRail from './MidiSampleRail.jsx'
import MidiReimportModeSelect, { MODE_UPDATE } from './MidiReimportModeSelect.jsx'
import { Checkbox, Select } from '../../ui-kit'
import styles from './MidiImport.module.css'

const MAX_LENGTH_SELECT_OPTIONS = MAX_NOTE_LENGTH_OPTIONS.map(option => ({
  value: option.value,
  label: option.value === 0 ? 'None' : option.label,
}))

// options: { enabled, visualOnly, sampleId, outputTrackIndex, pitch, ... }
// onChange(patch): partial patch dispatched up to onOutputChange in the dialog
export default function MidiDrumSubTrackRow({ noteNum, options, onChange, sampleItems, reimportTargets }) {
  const gmName = gmDrumName(noteNum) || `Note ${noteNum}`

  return (
    <div className={styles.drumRow} data-disabled={!options.enabled || undefined}>
      <div className={styles.drumHeadRow}>
        <Checkbox checked={options.enabled} onChange={enabled => onChange({ enabled })} aria-label={`Enable ${gmName}`}>
          <span className={styles.trackName} title={`MIDI note ${noteNum}`}>{gmName}</span>
        </Checkbox>
        <span className={styles.midiNote}>Note {noteNum}</span>
      </div>
      <MidiSampleRail
        items={sampleItems}
        value={options.sampleId ?? null}
        onChange={sampleId => onChange({ sampleId })}
        disabled={!options.enabled}
        compact
        ariaLabel={`${gmName} sample assignment`}
      />
      <div className={styles.controls}>
        <MidiReimportModeSelect
          targets={reimportTargets}
          mode={options.mode}
          targetTrackId={options.targetTrackId}
          onChange={onChange}
          disabled={!options.enabled}
          ariaLabel={`${gmName} import target`}
        />
        {(reimportTargets?.length > 0) && options.mode === MODE_UPDATE && (
          <span className={styles.note} title="Re-import rows always keep their existing block placement">
            Position and tiling are ignored on re-import
          </span>
        )}
        <div className={styles.control}>
          <span className={styles.label}>Max length</span>
          <Select
            value={options.maxNoteLengthDenom ?? DEFAULT_MAX_NOTE_LENGTH_DENOM}
            options={MAX_LENGTH_SELECT_OPTIONS}
            onChange={value => onChange({ maxNoteLengthDenom: Number(value) })}
            disabled={!options.enabled}
            ariaLabel={`${gmName} maximum note length`}
          />
        </div>
        <Checkbox checked={!!options.visualOnly} onChange={visualOnly => onChange({ visualOnly })} disabled={!options.enabled}>
          Visual only
        </Checkbox>
      </div>
    </div>
  )
}
