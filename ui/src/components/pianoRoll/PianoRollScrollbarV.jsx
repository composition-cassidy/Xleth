import { useCallback, useEffect, useRef } from 'react'

const SCROLLBAR_WIDTH = 12
const MIN_THUMB_SIZE = 24

export default function PianoRollScrollbarV({
  contentHeight, viewportHeight, scrollY, setScrollY,
}) {
  const trackRef = useRef(null)
  const dragRef = useRef(null)

  const maxScroll = Math.max(0, contentHeight - viewportHeight)
  const hasOverflow = maxScroll > 0
  const ratio = hasOverflow ? viewportHeight / contentHeight : 1
  const thumbSize = hasOverflow ? Math.max(MIN_THUMB_SIZE, viewportHeight * ratio) : viewportHeight
  const trackLen = viewportHeight
  const thumbTop = hasOverflow ? (scrollY / maxScroll) * (trackLen - thumbSize) : 0

  const handleThumbMouseDown = useCallback((e) => {
    if (e.button !== 0 || !hasOverflow) return
    e.preventDefault()
    e.stopPropagation()
    dragRef.current = { startY: e.clientY, origScroll: scrollY }
    const onMove = (me) => {
      const d = dragRef.current
      if (!d) return
      const dy = me.clientY - d.startY
      const scrollRange = trackLen - thumbSize
      if (scrollRange <= 0) return
      const next = d.origScroll + (dy / scrollRange) * maxScroll
      setScrollY(Math.max(0, Math.min(maxScroll, next)))
    }
    const onUp = () => {
      dragRef.current = null
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }, [hasOverflow, scrollY, trackLen, thumbSize, maxScroll, setScrollY])

  const handleTrackClick = useCallback((e) => {
    if (!hasOverflow) return
    const track = trackRef.current
    if (!track) return
    const rect = track.getBoundingClientRect()
    const clickY = e.clientY - rect.top
    // Page jump: if click above thumb go up, below go down
    const page = viewportHeight * 0.9
    if (clickY < thumbTop) {
      setScrollY(Math.max(0, scrollY - page))
    } else if (clickY > thumbTop + thumbSize) {
      setScrollY(Math.min(maxScroll, scrollY + page))
    }
  }, [hasOverflow, viewportHeight, thumbTop, thumbSize, scrollY, maxScroll, setScrollY])

  // Wheel-over scrollbar scrolls vertically regardless of modifiers
  useEffect(() => {
    const el = trackRef.current
    if (!el) return
    const onWheel = (e) => {
      e.preventDefault()
      setScrollY((y) => Math.max(0, Math.min(maxScroll, y + e.deltaY)))
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [maxScroll, setScrollY])

  return (
    <div
      ref={trackRef}
      className="piano-roll-scrollbar-v"
      onMouseDown={handleTrackClick}
      style={{ width: SCROLLBAR_WIDTH, height: viewportHeight }}
    >
      {hasOverflow && (
        <div
          className="piano-roll-scrollbar-thumb"
          onMouseDown={handleThumbMouseDown}
          style={{
            top: thumbTop,
            height: thumbSize,
            width: SCROLLBAR_WIDTH - 2,
          }}
        />
      )}
    </div>
  )
}

export { SCROLLBAR_WIDTH as SCROLLBAR_V_WIDTH }
