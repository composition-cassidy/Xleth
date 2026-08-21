import { forwardRef, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useRef } from 'react'

const SCROLLBAR_WIDTH = 20
const MIN_THUMB_SIZE = 24

// The thumb tracks the animator's per-frame scrollY (and per-frame content
// height, which a vertical zoom changes) through applyView(), not through the
// settled React state — see PianoRollKeyboard for why.
const PianoRollScrollbarV = forwardRef(function PianoRollScrollbarV({
  contentHeight, viewportHeight, scrollY, scrollYRef, setScrollY, getContentHeight,
}, ref) {
  const trackRef = useRef(null)
  const thumbRef = useRef(null)
  const dragRef = useRef(null)

  const maxScroll = Math.max(0, contentHeight - viewportHeight)
  const hasOverflow = maxScroll > 0
  const ratio = hasOverflow ? viewportHeight / contentHeight : 1
  const thumbSize = hasOverflow ? Math.max(MIN_THUMB_SIZE, viewportHeight * ratio) : viewportHeight
  const trackLen = viewportHeight
  const thumbTop = hasOverflow ? (scrollY / maxScroll) * (trackLen - thumbSize) : 0

  // Live geometry from the refs — the props above are the settled mirror,
  // used for the initial render and for deciding whether a thumb exists.
  const applyView = () => {
    const thumb = thumbRef.current
    if (!thumb) return
    const content = getContentHeight ? getContentHeight() : contentHeight
    const max = Math.max(0, content - viewportHeight)
    if (max <= 0) return
    const size = Math.max(MIN_THUMB_SIZE, viewportHeight * (viewportHeight / content))
    const top = ((scrollYRef?.current ?? 0) / max) * (viewportHeight - size)
    thumb.style.top = `${top}px`
    thumb.style.height = `${size}px`
  }

  useImperativeHandle(ref, () => ({ applyView }))
  useLayoutEffect(applyView)

  const handleThumbMouseDown = useCallback((e) => {
    if (e.button !== 0 || !hasOverflow) return
    e.preventDefault()
    e.stopPropagation()
    // Read the live ref, not the (debounced) scrollY prop — dragging can
    // start mid-animation, and the prop may not have settled to the real
    // position yet.
    dragRef.current = { startY: e.clientY, origScroll: scrollYRef?.current ?? scrollY }
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
          ref={thumbRef}
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
})

export default PianoRollScrollbarV

export { SCROLLBAR_WIDTH as SCROLLBAR_V_WIDTH }
