import { Play } from 'lucide-react'
import { Button, NumberBox, hintAttrs } from '../../ui-kit'
import { lowNoteFor, noteName, MIN_OCTAVE_SHIFT, MAX_OCTAVE_SHIFT } from './auditionKeymap.js'
import styles from './Sampler.module.css'

// ── Audition bar ────────────────────────────────────────────────────────────
// The panel's computer-keyboard piano, made visible: which keys play, the note
// range they cover, the octave shift, the velocity every audition uses (what the
// Velocity modulation source reads), and a one-shot play of the root note. It is
// always shown, in every view: it is the panel's "is this making a sound" cue.

const KEY_HINT = 'Z S X D C V G B H N J M and Q 2 W 3 E R 5 T 6 Y 7 U I 9 O 0 P play the sampler while this panel has focus'
const round = (v) => Math.round(v)

export default function AuditionBar({
  octaveShift,
  onOctaveShift,
  velocity,
  onVelocity,
  heldCount,
  rootNote,
  onPreviewRoot,
  disabled,
}) {
  const low = lowNoteFor(octaveShift)
  const high = Math.min(127, low + 28)
  const sounding = heldCount > 0

  return (
    <div className={styles.audition} role="group" aria-label="Audition">
      <span
        className={styles.auditionState}
        data-on={sounding || undefined}
        role="status"
        aria-live="polite"
        {...hintAttrs({ hint: sounding ? `${heldCount} key${heldCount > 1 ? 's' : ''} held` : 'No key held' })}
      >
        <span className={styles.auditionDot} aria-hidden="true" />
        Audition
      </span>
      <span className={styles.caption} {...hintAttrs({ hint: KEY_HINT })}>Keys Z–M, Q–P</span>
      <span className={styles.auditionRange} {...hintAttrs({ hint: 'Notes the computer keys cover at this octave shift' })}>
        {noteName(low)}–{noteName(high)}
      </span>
      <NumberBox
        label="Key octave"
        width={116}
        value={octaveShift}
        min={MIN_OCTAVE_SHIFT} max={MAX_OCTAVE_SHIFT} step={1} quantize={round} defaultValue={0} bipolar
        pxPerRange={120}
        format={(v) => (v > 0 ? `+${v}` : (v < 0 ? `−${Math.abs(v)}` : '0'))}
        onChange={(v) => onOctaveShift(round(v))}
        onCommit={(v) => onOctaveShift(round(v))}
        hint="Octave shift for the computer-keyboard notes"
        data-field="auditionOctave"
      />
      <NumberBox
        label="Velocity"
        width={104}
        value={Math.round(velocity * 127)}
        min={1} max={127} step={1} quantize={round} defaultValue={102}
        onChange={(v) => onVelocity(round(v) / 127)}
        onCommit={(v) => onVelocity(round(v) / 127)}
        hint="Velocity every auditioned note plays at: what the Velocity modulation source reads"
        data-field="auditionVelocity"
      />
      <span className={styles.spacer} />
      <Button
        size="sm"
        glyph={<Play aria-hidden="true" />}
        onClick={onPreviewRoot}
        disabled={disabled}
        hint="Play the root note once"
        data-field="playRoot"
      >{`Root ${noteName(rootNote)}`}</Button>
    </div>
  )
}
