import { forwardRef, useImperativeHandle, useLayoutEffect, useRef } from 'react'

// Ruler tick labels for the visible horizontal range. Bar boundaries (every 4
// beats, 4/4) get a bright integer; in-between beats get a dim "bar.beat"
// sub-label.
//
// Their positions — and which labels exist at all — are a pure function of the
// per-frame (pixelsPerBeat, scrollX) that PianoRoll's view animator eases, so
// they are built imperatively from those refs via applyView() rather than
// re-rendered from the settled React state (which only syncs ~100ms after a
// gesture stops, leaving the numbers frozen while the grid under them moved).
//
// Spans are pooled and reused across frames: the visible label count is bounded
// by viewportWidth / MIN_PX_PER_BEAT, so the pool stabilises after the first
// few frames and a frame costs a handful of style writes, no allocation.
const PianoRollRuler = forwardRef(function PianoRollRuler({
  pixelsPerBeatRef, scrollXRef, width, keyboardWidth, scrollbarWidth, height,
}, ref) {
  const trackRef = useRef(null)
  const poolRef = useRef([])
  const widthRef = useRef(width)
  widthRef.current = width

  const applyView = () => {
    const track = trackRef.current
    if (!track) return
    const ppb = pixelsPerBeatRef?.current || 0
    const scrollX = scrollXRef?.current || 0
    const w = widthRef.current
    if (!(ppb > 0) || !(w > 0)) return

    const startBeat = Math.max(0, Math.floor(scrollX / ppb))
    const endBeat = Math.ceil((scrollX + w) / ppb) + 1
    const pool = poolRef.current
    let n = 0

    for (let b = startBeat; b <= endBeat; b++) {
      const left = b * ppb - scrollX
      if (left < -20 || left > w) continue
      let el = pool[n]
      if (!el) {
        el = document.createElement('span')
        pool[n] = el
        track.appendChild(el)
      }
      const isBar = b % 4 === 0
      const className = `piano-roll-ruler-tick${isBar ? ' bar' : ''}`
      const text = isBar ? String(b / 4 + 1) : `${Math.floor(b / 4) + 1}.${(b % 4) + 1}`
      if (el.className !== className) el.className = className
      if (el.textContent !== text) el.textContent = text
      el.style.left = `${left}px`
      el.style.display = ''
      n++
    }
    for (let i = n; i < pool.length; i++) pool[i].style.display = 'none'
  }

  useImperativeHandle(ref, () => ({ applyView }))

  // Width changes (panel resize) don't go through the animator.
  useLayoutEffect(applyView)

  return (
    <div className="piano-roll-ruler" style={{ height }}>
      <div className="piano-roll-ruler-corner" style={{ width: keyboardWidth }} />
      <div ref={trackRef} className="piano-roll-ruler-track" style={{ width }} />
      <div className="piano-roll-ruler-corner" style={{ width: scrollbarWidth }} />
    </div>
  )
})

export default PianoRollRuler
