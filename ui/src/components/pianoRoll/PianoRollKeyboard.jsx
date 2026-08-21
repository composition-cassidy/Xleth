import { forwardRef, useImperativeHandle, useLayoutEffect, useRef } from 'react'

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

// The keyboard's vertical placement is a pure function of the per-frame
// (pixelsPerSemitone, scrollY) that PianoRoll's view animator eases — so it is
// driven imperatively from that animator's onTick via applyView(), NOT from
// the settled React state. Reading the settled state left the keys locked in
// place for the whole gesture and jumping ~100ms after it stopped, while the
// canvas next to them scrolled smoothly.
//
// Every key is mounted once (120 divs) inside a single layer; scrolling is one
// transform write on that layer per frame. Only a vertical ZOOM (a change in
// pixelsPerSemitone, which also changes each key's height) re-lays out the
// individual keys.
const PianoRollKeyboard = forwardRef(function PianoRollKeyboard({
  pixelsPerSemitoneRef, scrollYRef, height,
  onPreviewNote, highlightedPitches,
}, ref) {
  const layerRef = useRef(null)
  const keyElsRef = useRef([])       // index = PITCH_MAX - pitch (top to bottom)
  const lastPpsRef = useRef(null)

  const applyView = () => {
    const layer = layerRef.current
    if (!layer) return
    const pps = pixelsPerSemitoneRef?.current || 0
    const scrollY = scrollYRef?.current || 0

    if (pps !== lastPpsRef.current) {
      lastPpsRef.current = pps
      const els = keyElsRef.current
      for (let i = 0; i < els.length; i++) {
        const el = els[i]
        if (!el) continue
        el.style.top = `${i * pps}px`
        el.style.height = `${pps}px`
      }
      layer.style.height = `${NUM_PITCHES * pps}px`
    }
    layer.style.transform = `translateY(${-scrollY}px)`
  }

  useImperativeHandle(ref, () => ({ applyView }))

  // Re-apply after every React render too: a render can replace key elements
  // (highlight changes) and always resets the inline styles React owns.
  useLayoutEffect(() => {
    lastPpsRef.current = null // force the full re-layout, styles were just reset
    applyView()
  })

  const keys = []
  for (let p = PITCH_MAX; p >= PITCH_MIN; p--) {
    const idx = PITCH_MAX - p
    const isBlack = isBlackKey(p)
    const isC = (p % 12) === 0
    const highlighted = highlightedPitches?.has(p)
    keys.push(
      <div
        key={p}
        ref={(el) => { keyElsRef.current[idx] = el }}
        className={`piano-roll-key ${isBlack ? 'black' : 'white'} ${highlighted ? 'highlighted' : ''}`}
        style={{
          position: 'absolute',
          top: 0,      // real top/height are written by applyView()
          height: 0,
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
      <div
        ref={layerRef}
        style={{ position: 'absolute', top: 0, left: 0, right: 0, willChange: 'transform' }}
      >
        {keys}
      </div>
    </div>
  )
})

export default PianoRollKeyboard

export { PITCH_MIN, PITCH_MAX, NUM_PITCHES, isBlackKey, pitchLabel }
