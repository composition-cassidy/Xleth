import MidiDrumSubTrackRow from './MidiDrumSubTrackRow.jsx'

// parentOptions: { enabled, splitByNote }
// outputOptions: for non-split tracks — single { outputTrackIndex, sampleId, visualOnly, name, ... } or null
//                for split-drum tracks — array of { pitch, outputTrackIndex, sampleId, visualOnly, ... }
// onParentChange(patch)              — partial patch to source-track-level options
// onOutputChange(outputTrackIndex, patch) — partial patch to output-track-level options
export default function MidiTrackRow({ track, parentOptions, outputOptions, onParentChange, onOutputChange, sources }) {
  const isSplitDrum = !!track.isDrum && !!parentOptions.splitByNote

  // Inline warning for non-split rows missing a sample assignment.
  const nonSplitMissingSample = (
    !isSplitDrum &&
    parentOptions.enabled &&
    outputOptions != null &&
    (outputOptions.sampleId == null || Number(outputOptions.sampleId) < 0)
  )

  return (
    <div className={`midi-track-row${parentOptions.enabled ? '' : ' midi-track-row--disabled'}`}>

      <div className="midi-track-main">
        <input
          type="checkbox"
          className="midi-track-enable"
          checked={parentOptions.enabled}
          onChange={e => onParentChange({ enabled: e.target.checked })}
          title="Include this track"
        />
        <span className="midi-track-name">
          {track.name || `Track ${track.index + 1}`}
        </span>
        <span className="midi-track-notes">{track.noteCount} notes</span>

        {/* Sample select and visual-only only shown on non-split rows */}
        {!isSplitDrum && (
          <>
            <select
              className="midi-sample-select"
              value={outputOptions?.sampleId ?? ''}
              onChange={e => outputOptions != null && onOutputChange(
                outputOptions.outputTrackIndex,
                { sampleId: e.target.value || null }
              )}
              disabled={!parentOptions.enabled || outputOptions == null}
            >
              <option value="">None — assign later</option>
              {(sources || []).map(s => (
                <option key={s.id} value={s.id}>{s.name}</option>
              ))}
            </select>
            <label className="midi-visual-only-label">
              <input
                type="checkbox"
                checked={outputOptions?.visualOnly ?? false}
                onChange={e => outputOptions != null && onOutputChange(
                  outputOptions.outputTrackIndex,
                  { visualOnly: e.target.checked }
                )}
                disabled={!parentOptions.enabled || outputOptions == null}
              />
              Visual only
            </label>
          </>
        )}
      </div>

      {track.hasPitchBend && (
        <div className="midi-track-warning">
          ⚠ Pitch bend will be discarded (slide note conversion planned)
        </div>
      )}

      {nonSplitMissingSample && (
        <div className="midi-track-warning">
          ⚠ Sample required to import this track
        </div>
      )}

      {track.isDrum && (
        <div className="midi-drum-section">
          <div className="midi-drum-indicator">⚠ Detected as drum track</div>
          <label className="midi-checkbox-row">
            <input
              type="checkbox"
              checked={parentOptions.splitByNote}
              onChange={e => onParentChange({ splitByNote: e.target.checked })}
              disabled={!parentOptions.enabled}
            />
            Split by note
          </label>
          {isSplitDrum && Array.isArray(outputOptions) && outputOptions.length > 0 && (
            <div className="midi-drum-sub-rows">
              {outputOptions.map(subEntry => (
                <MidiDrumSubTrackRow
                  key={subEntry.pitch}
                  noteNum={subEntry.pitch}
                  options={subEntry}
                  onChange={patch => onOutputChange(subEntry.outputTrackIndex, patch)}
                  sources={sources}
                />
              ))}
            </div>
          )}
        </div>
      )}

    </div>
  )
}
