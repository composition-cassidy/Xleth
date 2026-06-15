import React from 'react'
import MidiDrumSubTrackRow from './MidiDrumSubTrackRow.jsx'
import { MAX_NOTE_LENGTH_OPTIONS, DEFAULT_MAX_NOTE_LENGTH_DENOM } from './maxNoteLength.js'
import MidiSampleRail from './MidiSampleRail.jsx'
import XlethSelect from '../common/XlethSelect.jsx'

const MAX_LENGTH_SELECT_OPTIONS = MAX_NOTE_LENGTH_OPTIONS.map(option => ({
  value: option.value,
  label: option.value === 0 ? 'None' : option.label,
}))

// parentOptions: { enabled, splitByNote }
// outputOptions: for non-split tracks - single { outputTrackIndex, sampleId, visualOnly, name, ... } or null
//                for split-drum tracks - array of { pitch, outputTrackIndex, sampleId, visualOnly, ... }
// onParentChange(patch)              - partial patch to source-track-level options
// onOutputChange(outputTrackIndex, patch) - partial patch to output-track-level options
export default function MidiTrackRow({ track, parentOptions, outputOptions, onParentChange, onOutputChange, sampleItems }) {
  const isSplitDrum = !!track.isDrum && !!parentOptions.splitByNote
  const trackName = track.name || `Track ${track.index + 1}`
  const controlsDisabled = !parentOptions.enabled || outputOptions == null

  return (
    <div className={`midi-track-row${parentOptions.enabled ? '' : ' midi-track-row--disabled'}`}>

      <div className="midi-track-head">
        <input
          type="checkbox"
          className="midi-track-enable"
          checked={parentOptions.enabled}
          onChange={e => onParentChange({ enabled: e.target.checked })}
          title="Include this track"
        />
        <span className="midi-track-title-wrap">
          <span className="midi-track-name" title={trackName}>{trackName}</span>
          <span className="midi-track-notes">{track.noteCount} notes</span>
        </span>
      </div>

      {!isSplitDrum && (
        <>
          <div className="midi-track-sample-area">
            <span className="midi-track-section-label">Sample</span>
            <MidiSampleRail
              items={sampleItems}
              value={outputOptions?.sampleId ?? null}
              onChange={sampleId => outputOptions != null && onOutputChange(
                outputOptions.outputTrackIndex,
                { sampleId }
              )}
              disabled={controlsDisabled}
              ariaLabel={`${trackName} sample assignment`}
            />
          </div>
          <div className="midi-track-controls">
            <label className="midi-control-group">
              <span className="midi-control-label">Max Length</span>
              <XlethSelect
                value={outputOptions?.maxNoteLengthDenom ?? DEFAULT_MAX_NOTE_LENGTH_DENOM}
                options={MAX_LENGTH_SELECT_OPTIONS}
                onChange={value => outputOptions != null && onOutputChange(
                  outputOptions.outputTrackIndex,
                  { maxNoteLengthDenom: Number(value) }
                )}
                disabled={controlsDisabled}
                ariaLabel={`${trackName} maximum note length`}
                className="midi-max-note-length-select"
              />
            </label>
            <label className="midi-visual-only-label">
              <input
                type="checkbox"
                checked={outputOptions?.visualOnly ?? false}
                onChange={e => outputOptions != null && onOutputChange(
                  outputOptions.outputTrackIndex,
                  { visualOnly: e.target.checked }
                )}
                disabled={controlsDisabled}
              />
              Visual only
            </label>
          </div>
        </>
      )}

      {track.isDrum && (
        <div className="midi-drum-section">
          <div className="midi-drum-head">
            <span className="midi-drum-indicator">Drum track</span>
            <label className="midi-checkbox-row">
              <input
                type="checkbox"
                checked={parentOptions.splitByNote}
                onChange={e => onParentChange({ splitByNote: e.target.checked })}
                disabled={!parentOptions.enabled}
              />
              Split by note
            </label>
          </div>
          {isSplitDrum && Array.isArray(outputOptions) && outputOptions.length > 0 && (
            <div className="midi-drum-sub-rows">
              {outputOptions.map(subEntry => (
                <MidiDrumSubTrackRow
                  key={subEntry.pitch}
                  noteNum={subEntry.pitch}
                  options={subEntry}
                  onChange={patch => onOutputChange(subEntry.outputTrackIndex, patch)}
                  sampleItems={sampleItems}
                />
              ))}
            </div>
          )}
        </div>
      )}

    </div>
  )
}
