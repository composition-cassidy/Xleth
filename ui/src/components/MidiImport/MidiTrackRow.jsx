import React from 'react'
import MidiDrumSubTrackRow from './MidiDrumSubTrackRow.jsx'
import MidiTrackThumbnail from './MidiTrackThumbnail.jsx'
import { MAX_NOTE_LENGTH_OPTIONS, DEFAULT_MAX_NOTE_LENGTH_DENOM } from './maxNoteLength.js'
import { TRANSPOSE_MIN_SEMITONES, TRANSPOSE_MAX_SEMITONES, DEFAULT_TRANSPOSE_SEMITONES, clampTransposeSemitones } from './transpose.js'
import { MODE_UPDATE } from './MidiReimportModeSelect.jsx'
import MidiSampleRail from './MidiSampleRail.jsx'
import MidiReimportModeSelect from './MidiReimportModeSelect.jsx'
import { Checkbox, MINUS, NumberBox, Select } from '../../ui-kit'
import styles from './MidiImport.module.css'

const MAX_LENGTH_SELECT_OPTIONS = MAX_NOTE_LENGTH_OPTIONS.map(option => ({
  value: option.value,
  label: option.value === 0 ? 'None' : option.label,
}))

const semitones = (v) => `${v > 0 ? '+' : v < 0 ? MINUS : ''}${Math.abs(Math.round(v))}\u2009st`

// parentOptions: { enabled, splitByNote }
// outputOptions: for non-split tracks - single { outputTrackIndex, sampleId, visualOnly, name, ... } or null
//                for split-drum tracks - array of { pitch, outputTrackIndex, sampleId, visualOnly, ... }
// onParentChange(patch)              - partial patch to source-track-level options
// onOutputChange(outputTrackIndex, patch) - partial patch to output-track-level options
// reimportTargets - existing Pattern tracks this row can be re-imported into
export default function MidiTrackRow({ track, parentOptions, outputOptions, onParentChange, onOutputChange, sampleItems, reimportTargets }) {
  const isSplitDrum = !!track.isDrum && !!parentOptions.splitByNote
  const trackName = track.name || `Track ${track.index + 1}`
  const controlsDisabled = !parentOptions.enabled || outputOptions == null

  return (
    <div className={styles.track} data-disabled={!parentOptions.enabled || undefined}>

      <div className={styles.trackHead}>
        <Checkbox
          checked={parentOptions.enabled}
          onChange={enabled => onParentChange({ enabled })}
          aria-label={`Include ${trackName}`}
        >
          <span className={styles.trackName} title={trackName}>{trackName}</span>
        </Checkbox>
        <span className={styles.trackNotes}>{track.noteCount} notes</span>
      </div>

      {track.thumb && (
        <div className={styles.thumbWrap}>
          <MidiTrackThumbnail thumb={track.thumb} />
        </div>
      )}

      {!isSplitDrum && (
        <>
          <div className={styles.railWrap}>
            <span className={styles.sectionLabel}>Sample</span>
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
          <div className={styles.controls}>
            <MidiReimportModeSelect
              targets={reimportTargets}
              mode={outputOptions?.mode}
              targetTrackId={outputOptions?.targetTrackId}
              onChange={patch => outputOptions != null && onOutputChange(
                outputOptions.outputTrackIndex,
                patch
              )}
              disabled={controlsDisabled}
              ariaLabel={`${trackName} import target`}
            />
            {(reimportTargets?.length > 0) && outputOptions?.mode === MODE_UPDATE && (
              <span className={styles.note} title="Re-import rows always keep their existing block placement">
                Position and tiling are ignored on re-import
              </span>
            )}
            {!track.isDrum && (
              <NumberBox
                label={`${trackName} transpose`}
                caption="Transpose"
                width={96}
                min={TRANSPOSE_MIN_SEMITONES}
                max={TRANSPOSE_MAX_SEMITONES}
                step={1}
                quantize={Math.round}
                format={semitones}
                bipolar
                centre={0}
                defaultValue={DEFAULT_TRANSPOSE_SEMITONES}
                disabled={controlsDisabled}
                value={outputOptions?.transposeSemitones ?? DEFAULT_TRANSPOSE_SEMITONES}
                onCommit={value => outputOptions != null && onOutputChange(
                  outputOptions.outputTrackIndex,
                  { transposeSemitones: clampTransposeSemitones(value) }
                )}
              />
            )}
            <div className={styles.control}>
              <span className={styles.label}>Max length</span>
              <Select
                value={outputOptions?.maxNoteLengthDenom ?? DEFAULT_MAX_NOTE_LENGTH_DENOM}
                options={MAX_LENGTH_SELECT_OPTIONS}
                onChange={value => outputOptions != null && onOutputChange(
                  outputOptions.outputTrackIndex,
                  { maxNoteLengthDenom: Number(value) }
                )}
                disabled={controlsDisabled}
                ariaLabel={`${trackName} maximum note length`}
              />
            </div>
            <Checkbox
              checked={outputOptions?.visualOnly ?? false}
              onChange={visualOnly => outputOptions != null && onOutputChange(
                outputOptions.outputTrackIndex,
                { visualOnly }
              )}
              disabled={controlsDisabled}
            >
              Visual only
            </Checkbox>
          </div>
        </>
      )}

      {track.isDrum && (
        <div className={styles.railWrap}>
          <div className={styles.drumHead}>
            <span className={styles.sectionLabel}>Drum track</span>
            <Checkbox
              checked={parentOptions.splitByNote}
              onChange={splitByNote => onParentChange({ splitByNote })}
              disabled={!parentOptions.enabled}
            >
              Split by note
            </Checkbox>
          </div>
          {isSplitDrum && Array.isArray(outputOptions) && outputOptions.length > 0 && (
            <div className={styles.drumRows}>
              {outputOptions.map(subEntry => (
                <MidiDrumSubTrackRow
                  key={subEntry.pitch}
                  noteNum={subEntry.pitch}
                  options={subEntry}
                  onChange={patch => onOutputChange(subEntry.outputTrackIndex, patch)}
                  sampleItems={sampleItems}
                  reimportTargets={reimportTargets}
                />
              ))}
            </div>
          )}
        </div>
      )}

    </div>
  )
}
