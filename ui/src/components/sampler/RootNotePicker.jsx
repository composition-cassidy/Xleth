const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']

function midiToComponents(midi) {
  const m = Math.max(0, Math.min(127, midi | 0))
  return { noteIndex: m % 12, octave: Math.floor(m / 12) - 1 }
}

function componentsToMidi(noteIndex, octave) {
  return Math.max(0, Math.min(127, noteIndex + (octave + 1) * 12))
}

const BASE = {
  background: 'var(--theme-bg-elevated)',
  border: '1px solid var(--theme-border-strong)',
  color: 'var(--theme-text)',
  borderRadius: 3,
  outline: 'none',
  cursor: 'pointer',
  lineHeight: 1,
}

export default function RootNotePicker({ value, onChange, fontSize = 10 }) {
  const { noteIndex, octave } = midiToComponents(value)

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 2 }}>
      <select
        value={noteIndex}
        onChange={(e) => onChange(componentsToMidi(Number(e.target.value), octave))}
        style={{ ...BASE, fontSize, padding: '2px 2px' }}
      >
        {NOTE_NAMES.map((n, i) => <option key={i} value={i}>{n}</option>)}
      </select>
      <button
        onClick={() => onChange(componentsToMidi(noteIndex, octave - 1))}
        disabled={componentsToMidi(noteIndex, octave - 1) < 0}
        style={{ ...BASE, fontSize, padding: '2px 5px' }}
      >−</button>
      <span style={{ fontSize, color: 'var(--theme-text)', minWidth: 16, textAlign: 'center' }}>
        {octave}
      </span>
      <button
        onClick={() => onChange(componentsToMidi(noteIndex, octave + 1))}
        disabled={componentsToMidi(noteIndex, octave + 1) > 127}
        style={{ ...BASE, fontSize, padding: '2px 5px' }}
      >+</button>
    </div>
  )
}
