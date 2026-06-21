const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']
const WHITE_NOTES = [0, 2, 4, 5, 7, 9, 11]
const BLACK_NOTES = [1, 3, 6, 8, 10]
const BLACK_LEFT = { 1: 18, 3: 44, 6: 96, 8: 122, 10: 148 }

function midiToComponents(midi) {
  const value = Math.max(0, Math.min(127, midi | 0))
  return { noteIndex: value % 12, octave: Math.floor(value / 12) - 1 }
}

function componentsToMidi(noteIndex, octave) {
  return noteIndex + (octave + 1) * 12
}

export default function RootNotePicker({ value, onChange }) {
  const { noteIndex, octave } = midiToComponents(value)
  const selectNote = (nextNote) => {
    const next = componentsToMidi(nextNote, octave)
    if (next >= 0 && next <= 127) onChange(next)
  }
  const changeOctave = (delta) => {
    const next = componentsToMidi(noteIndex, octave + delta)
    if (next >= 0 && next <= 127) onChange(next)
  }

  return (
    <div className="sampler-root-picker">
      <div className="sampler-root-keys" aria-label="Root note">
        {WHITE_NOTES.map((note, index) => (
          <button
            type="button"
            key={note}
            className={`sampler-root-key sampler-root-key--white${noteIndex === note ? ' is-selected' : ''}`}
            style={{ left: `${(index / 7) * 100}%` }}
            onClick={() => selectNote(note)}
            aria-label={`${NOTE_NAMES[note]}${octave}`}
            aria-pressed={noteIndex === note}
          />
        ))}
        {BLACK_NOTES.map((note) => (
          <button
            type="button"
            key={note}
            className={`sampler-root-key sampler-root-key--black${noteIndex === note ? ' is-selected' : ''}`}
            style={{ left: `${(BLACK_LEFT[note] / 182) * 100}%` }}
            onClick={() => selectNote(note)}
            aria-label={`${NOTE_NAMES[note]}${octave}`}
            aria-pressed={noteIndex === note}
          />
        ))}
      </div>
      <div className="sampler-root-octave">
        <button type="button" onClick={() => changeOctave(-1)} disabled={componentsToMidi(noteIndex, octave - 1) < 0}>-</button>
        <span>{NOTE_NAMES[noteIndex]}{octave}</span>
        <button type="button" onClick={() => changeOctave(1)} disabled={componentsToMidi(noteIndex, octave + 1) > 127}>+</button>
      </div>
    </div>
  )
}
