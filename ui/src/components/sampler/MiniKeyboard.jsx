import { isBlackKey, pitchLabel } from '../pianoRoll/PianoRollKeyboard.jsx'

const WHITE_KEY_W = 26
const KEY_H = 80

// Count white keys in a pitch range [lo, hi] inclusive
function countWhiteKeys(lo, hi) {
  let n = 0
  for (let p = lo; p <= hi; p++) if (!isBlackKey(p)) n++
  return n
}

export default function MiniKeyboard({ rootNote, regionId }) {
  // 2-octave range centered on root note, clamped to [0, 127]
  const lo = Math.max(0, Math.min(127 - 23, rootNote - 12))
  const hi = Math.min(127, lo + 23)

  const handlePress = (pitch) => {
    window.xleth?.timeline?.previewNote?.(regionId, pitch, 0.8)
    const release = () => {
      window.xleth?.timeline?.previewNoteOff?.(regionId, pitch)
      window.removeEventListener('mouseup', release)
      window.removeEventListener('mouseleave', release)
    }
    window.addEventListener('mouseup', release)
    window.addEventListener('mouseleave', release)
  }

  const numWhite = countWhiteKeys(lo, hi)
  const totalW = numWhite * WHITE_KEY_W

  // Pre-compute white-key x positions so black keys can reference them
  const whiteXByPitch = {}
  let whiteIdx = 0
  for (let p = lo; p <= hi; p++) {
    if (!isBlackKey(p)) {
      whiteXByPitch[p] = whiteIdx * WHITE_KEY_W
      whiteIdx++
    }
  }

  const whites = []
  const blacks = []
  for (let p = lo; p <= hi; p++) {
    const isRoot = p === rootNote
    if (!isBlackKey(p)) {
      const x = whiteXByPitch[p]
      whites.push(
        <div
          key={p}
          onMouseDown={(e) => { e.preventDefault(); handlePress(p) }}
          style={{
            position: 'absolute',
            left: x,
            top: 0,
            width: WHITE_KEY_W - 1,
            height: KEY_H,
            background: isRoot ? '#69DB7C' : '#EAEAF0',
            color: isRoot ? '#0a0a10' : '#333',
            borderRadius: '0 0 3px 3px',
            borderRight: '1px solid #2A2A38',
            display: 'flex',
            alignItems: 'flex-end',
            justifyContent: 'center',
            paddingBottom: 4,
            fontSize: 9,
            fontWeight: isRoot ? 700 : 400,
            cursor: 'pointer',
            userSelect: 'none',
          }}
        >
          {(p % 12) === 0 || isRoot ? pitchLabel(p) : ''}
        </div>
      )
    } else {
      // Black key sits between the previous white (offset within prev white ~65%)
      const prevWhite = p - 1
      // Find the most recent white key <= p
      let anchor = prevWhite
      while (anchor >= lo && isBlackKey(anchor)) anchor--
      if (anchor < lo) continue
      const x = whiteXByPitch[anchor] + WHITE_KEY_W - WHITE_KEY_W * 0.35
      blacks.push(
        <div
          key={p}
          onMouseDown={(e) => { e.preventDefault(); handlePress(p) }}
          style={{
            position: 'absolute',
            left: x,
            top: 0,
            width: WHITE_KEY_W * 0.7,
            height: KEY_H * 0.6,
            background: isRoot ? '#69DB7C' : '#1a1a24',
            color: isRoot ? '#0a0a10' : '#888',
            borderRadius: '0 0 3px 3px',
            border: '1px solid #000',
            zIndex: 2,
            cursor: 'pointer',
            userSelect: 'none',
            display: 'flex',
            alignItems: 'flex-end',
            justifyContent: 'center',
            paddingBottom: 3,
            fontSize: 8,
            fontWeight: isRoot ? 700 : 400,
          }}
        >
          {isRoot ? pitchLabel(p) : ''}
        </div>
      )
    }
  }

  return (
    <div
      style={{
        position: 'relative',
        width: totalW,
        height: KEY_H,
        background: '#0a0a10',
        borderRadius: 4,
        border: '1px solid #2A2A38',
      }}
    >
      {whites}
      {blacks}
    </div>
  )
}
