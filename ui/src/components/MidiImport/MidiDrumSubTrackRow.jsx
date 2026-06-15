import React from 'react'
import { gmDrumName } from './filenameMatch.js'
import { MAX_NOTE_LENGTH_OPTIONS, DEFAULT_MAX_NOTE_LENGTH_DENOM } from './maxNoteLength.js'
import MidiSampleRail from './MidiSampleRail.jsx'
import XlethSelect from '../common/XlethSelect.jsx'

const MAX_LENGTH_SELECT_OPTIONS = MAX_NOTE_LENGTH_OPTIONS.map(option => ({
  value: option.value,
  label: option.value === 0 ? 'None' : option.label,
}))

// options: { enabled, visualOnly, sampleId, outputTrackIndex, pitch, ... }
// onChange(patch): partial patch dispatched up to onOutputChange in the dialog
export default function MidiDrumSubTrackRow({ noteNum, options, onChange, sampleItems }) {
  const gmName = gmDrumName(noteNum) || `Note ${noteNum}`

  return (
    <div className={`midi-drum-sub-row${options.enabled ? '' : ' midi-drum-sub-row--disabled'}`}>
      <div className="midi-drum-sub-head">
        <input
          type="checkbox"
          checked={options.enabled}
          onChange={e => onChange({ enabled: e.target.checked })}
          title="Enable this note"
        />
        <span className="midi-drum-sub-note" title={`MIDI note ${noteNum}`}>{gmName}</span>
        <span className="midi-drum-sub-midi-note">{noteNum}</span>
      </div>
      <MidiSampleRail
        items={sampleItems}
        value={options.sampleId ?? null}
        onChange={sampleId => onChange({ sampleId })}
        disabled={!options.enabled}
        compact
        ariaLabel={`${gmName} sample assignment`}
      />
      <div className="midi-track-controls midi-track-controls--compact">
        <label className="midi-control-group">
          <span className="midi-control-label">Max Length</span>
          <XlethSelect
            value={options.maxNoteLengthDenom ?? DEFAULT_MAX_NOTE_LENGTH_DENOM}
            options={MAX_LENGTH_SELECT_OPTIONS}
            onChange={value => onChange({ maxNoteLengthDenom: Number(value) })}
            disabled={!options.enabled}
            ariaLabel={`${gmName} maximum note length`}
            className="midi-max-note-length-select"
          />
        </label>
        <label className="midi-visual-only-label">
          <input
            type="checkbox"
            checked={options.visualOnly}
            onChange={e => onChange({ visualOnly: e.target.checked })}
            disabled={!options.enabled}
          />
          Visual only
        </label>
      </div>
    </div>
  )
}
