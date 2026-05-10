import { gmDrumName } from './filenameMatch.js'
import { MAX_NOTE_LENGTH_OPTIONS, DEFAULT_MAX_NOTE_LENGTH_DENOM } from './maxNoteLength.js'

// options: { enabled, visualOnly, sampleId, outputTrackIndex, pitch, ... }
// onChange(patch): partial patch dispatched up to onOutputChange in the dialog
export default function MidiDrumSubTrackRow({ noteNum, options, onChange, sources }) {
  const gmName = gmDrumName(noteNum) || `Note ${noteNum}`
  const unassignedSample = options.enabled && (options.sampleId == null || Number(options.sampleId) < 0)

  return (
    <div className="midi-drum-sub-row">
      <input
        type="checkbox"
        checked={options.enabled}
        onChange={e => onChange({ enabled: e.target.checked })}
        title="Enable this note"
      />
      <span className="midi-drum-sub-note" title={`MIDI note ${noteNum}`}>{gmName}</span>
      <select
        className="midi-sample-select"
        value={options.sampleId ?? ''}
        onChange={e => onChange({ sampleId: e.target.value || null })}
        disabled={!options.enabled}
      >
        <option value="">None - assign later</option>
        {(sources || []).map(s => (
          <option key={s.id} value={s.id}>{s.name}</option>
        ))}
      </select>
      <label className="midi-visual-only-label">
        <input
          type="checkbox"
          checked={options.visualOnly}
          onChange={e => onChange({ visualOnly: e.target.checked })}
          disabled={!options.enabled}
        />
        Visual only
      </label>
      <select
        className="midi-max-note-length-select"
        value={options.maxNoteLengthDenom ?? DEFAULT_MAX_NOTE_LENGTH_DENOM}
        onChange={e => onChange({ maxNoteLengthDenom: Number(e.target.value) })}
        disabled={!options.enabled}
        title="Maximum note length: clamp this drum slot's imported note durations to this musical length. Note starts are never moved."
      >
        {MAX_NOTE_LENGTH_OPTIONS.map(o => (
          <option key={o.value} value={o.value}>Max {o.label}</option>
        ))}
      </select>
      {unassignedSample && (
        <div className="midi-track-warning">
          This note will import without a sample assignment. You can assign one later.
        </div>
      )}
    </div>
  )
}
