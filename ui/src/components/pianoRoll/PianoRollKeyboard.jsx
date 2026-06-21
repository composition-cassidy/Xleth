import { useRef, useEffect } from 'react'

// MIDI pitch layout: pitch 0 = C-1. Piano rolls typically show C0..B9 (12..131).
// We'll render a vertical keyboard that aligns with the canvas rows.
const PITCH_MIN = 12   // C0
const PITCH_MAX = 131  // B9
const NUM_PITCHES = PITCH_MAX - PITCH_MIN + 1

// Semitone offsets within an octave that are black keys
const BLACK_KEY_SET = new Set([1, 3, 6, 8, 10])

function isBlackKey(pitch) {
  return BLACK_KEY_SET.has(pitch % 12)
}

function pitchLabel(pitch) {
  const names = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B']
  const octave = Math.floor(pitch / 12) - 1
  return `${names[pitch % 12]}${octave}`
}

export default function PianoRollKeyboard({
  pixelsPerSemitone, scrollY, height,
  onPreviewNote, highlightedPitches,
}) {
  const containerRef = useRef(null)

  // Render keys as DOM for simplicity (120 keys is fine).
  const keys = []
  for (let p = PITCH_MAX; p >= PITCH_MIN; p--) {
    const y = (PITCH_MAX - p) * pixelsPerSemitone - scrollY
    if (y + pixelsPerSemitone < 0 || y > height) continue
    const isBlack = isBlackKey(p)
    const isC = (p % 12) === 0
    const highlighted = highlightedPitches?.has(p)
    keys.push(
      <div
        key={p}
        className={`piano-roll-key ${isBlack ? 'black' : 'white'} ${highlighted ? 'highlighted' : ''}`}
        style={{
          position: 'absolute',
          top: y,
          height: pixelsPerSemitone,
          left: 0,
          right: 0,
          background: isBlack
            ? (highlighted ? '#223530' : '#161616')
            : (highlighted ? '#bcd2c9' : '#a8a8a8'),
          borderBottom: isBlack ? '1px solid #0d0d0d' : '1px solid rgba(0,0,0,0.18)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'flex-end',
          paddingRight: 5,
          fontSize: 8,
          letterSpacing: '0.02em',
          color: isBlack ? '#5a5a5a' : '#2a2a2a',
          cursor: 'pointer',
          userSelect: 'none',
        }}
        onMouseDown={(e) => { e.preventDefault(); onPreviewNote?.(p) }}
      >
        {isC ? pitchLabel(p) : ''}
      </div>
    )
  }

  return (
    <div
      ref={containerRef}
      className="piano-roll-keyboard"
      style={{
        position: 'relative',
        width: 60,
        height: height,
        overflow: 'hidden',
        background: '#0d0d0d',
        borderRight: '1px solid #222',
        flexShrink: 0,
      }}
    >
      {keys}
    </div>
  )
}

export { PITCH_MIN, PITCH_MAX, NUM_PITCHES, isBlackKey, pitchLabel }
