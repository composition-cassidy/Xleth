import { gmDrumName } from './filenameMatch.js'

// options: { enabled, visualOnly, sampleId, outputTrackIndex, pitch, ... }
// onChange(patch): partial patch dispatched up to onOutputChange in the dialog
export default function MidiDrumSubTrackRow({ noteNum, options, onChange, sources }) {
  const gmName = gmDrumName(noteNum) || `Note ${noteNum}`
  const missingSample = options.enabled && (options.sampleId == null || Number(options.sampleId) < 0)

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
        <option value="">None — assign later</option>
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
      {missingSample && (
        <div className="midi-track-warning">
          ⚠ Sample required to import this track
        </div>
      )}
    </div>
  )
}
