import { useCallback } from 'react'
import { lowNoteFor, noteName, MIN_OCTAVE_SHIFT, MAX_OCTAVE_SHIFT } from './auditionKeymap.js'

// ── AuditionBar ─────────────────────────────────────────────────────────────
// Makes the panel's computer-keyboard piano VISIBLE. The bindings themselves
// have existed all along (Z-row and Q-row, two-and-a-bit octaves), but nothing
// on screen said so, there was no way to reach notes outside the fixed C4..E6
// window, and velocity was hard-coded at 0.8 — so every audition was at one
// fixed dynamic whatever the sample's velocity modulation was set up to do.
//
// Deliberately a thin strip, not the old MiniKeyboard: that was 80px tall and
// ~364px wide, which is most of the vertical budget the slot-strip rewrite just
// bought back. This is one row, and it carries the two things a keyboard
// cannot — which keys are live, and at what velocity.

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

  const bump = useCallback((d) => {
    onOctaveShift(octaveShift + d)
  }, [octaveShift, onOctaveShift])

  return (
    <div className="sampler-audition-bar">
      <span className={`sampler-audition-lamp${heldCount > 0 ? ' is-lit' : ''}`} aria-hidden />
      <span className="sampler-audition-label">
        Audition
      </span>

      <span className="sampler-audition-hint" title="Z S X D C V G B H N J M and Q 2 W 3 E R 5 T 6 Y 7 U play the sampler while this panel has focus">
        Z…M / Q…P
      </span>

      <span className="sampler-audition-range">
        {noteName(low)}–{noteName(high)}
      </span>

      <div className="sampler-audition-oct" role="group" aria-label="Audition octave">
        <button
          type="button"
          onClick={() => bump(-1)}
          disabled={octaveShift <= MIN_OCTAVE_SHIFT}
          title="Shift the audition keyboard down an octave"
          aria-label="Octave down"
        >−</button>
        <span title="Octave shift applied to the computer-keyboard notes">
          {octaveShift > 0 ? `+${octaveShift}` : octaveShift}
        </span>
        <button
          type="button"
          onClick={() => bump(1)}
          disabled={octaveShift >= MAX_OCTAVE_SHIFT}
          title="Shift the audition keyboard up an octave"
          aria-label="Octave up"
        >+</button>
      </div>

      <label className="sampler-audition-vel" title="Velocity every auditioned note is played at — what the VELO modulation source reads">
        <span>Vel</span>
        <input
          type="range"
          min={1}
          max={127}
          value={Math.round(velocity * 127)}
          onChange={(e) => onVelocity(Number(e.target.value) / 127)}
          aria-label="Audition velocity"
        />
        <span className="sampler-audition-vel-val">{Math.round(velocity * 127)}</span>
      </label>

      <button
        type="button"
        className="sampler-audition-root"
        onClick={onPreviewRoot}
        disabled={disabled}
        title="Play the root note once"
      >
        ▶ {noteName(rootNote)}
      </button>
    </div>
  )
}
