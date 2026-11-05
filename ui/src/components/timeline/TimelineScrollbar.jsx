import { forwardRef, useEffect, useImperativeHandle, useLayoutEffect, useRef, useCallback } from 'react'

/**
 * Horizontal scrollbar for timeline panning.
 * Shows a draggable thumb representing the visible region.
 * Wheel over this scrollbar = horizontal scroll.
 *
 * Props:
 *   scrollOffsetRef, pixelsPerBeatRef, totalBeats, canvasWidth,
 *   maxScrollRef (optional — the live scroll clamp; see scrollExtent below),
 *   onScroll(deltaBeats), onScrollTo(beat)
 *   scrollOffset (state value, for re-render)
 *   pixelsPerBeat (state value, for re-render)
 */

/**
 * Beats the scrollbar's track represents. With the live clamp available this
 * is exactly the scrollable range plus the visible window, so the thumb's
 * right edge meets the track's end at the scroll limit, whatever the zoom
 * (the clamp is zoom-dependent; see zoomFit.js). Without it, falls back to
 * the static song length.
 */
export function scrollExtent(maxScroll, visibleBeats, totalBeats) {
  if (Number.isFinite(maxScroll) && maxScroll >= 0 && visibleBeats > 0) {
    return maxScroll + visibleBeats
  }
  return totalBeats
}

const TimelineScrollbar = forwardRef(function TimelineScrollbar({
  scrollOffsetRef, pixelsPerBeatRef, maxScrollRef, totalBeats,
  canvasWidth, onScroll, onScrollTo,
  scrollOffset, pixelsPerBeat,
}, ref) {
  const trackRef = useRef(null)
  const thumbRef = useRef(null)
  const dragging = useRef(false)
  const dragStartX = useRef(0)
  const dragStartScroll = useRef(0)

  // Visible beats as a fraction of the scrollable extent
  const visibleBeats = canvasWidth / (pixelsPerBeat || 40)
  const extentNow = () => scrollExtent(
    maxScrollRef?.current,
    canvasWidth / (pixelsPerBeatRef?.current || 40),
    totalBeats,
  )
  const renderExtent = scrollExtent(maxScrollRef?.current, visibleBeats, totalBeats)
  const thumbFraction = Math.min(1, visibleBeats / renderExtent)
  const thumbLeft = (scrollOffset / renderExtent) * 100
  const thumbWidth = thumbFraction * 100

  // The thumb is DOM, so it has to be repositioned per animator frame from the
  // same refs the canvas draws with (applyView(), called by TimelineView's
  // commitViewportRedraw). The values above are the settled mirror, used for
  // the initial render only — driving the thumb from them left it frozen for
  // the whole gesture and jumping ~100ms after it stopped.
  const applyView = () => {
    const thumb = thumbRef.current
    if (!thumb) return
    const ppb = pixelsPerBeatRef?.current || 40
    const scroll = scrollOffsetRef?.current || 0
    const visible = canvasWidth / ppb
    const extent = extentNow()
    const fraction = Math.min(1, visible / extent)
    thumb.style.left = `${(scroll / extent) * 100}%`
    thumb.style.width = `${Math.max(fraction * 100, 3)}%`
    // Everything visible: hide the thumb but keep the track mounted. The
    // track used to unmount here, and at the zoom-out limit that shifted the
    // track rows by the bar's height each time the view crossed the limit.
    thumb.style.visibility = fraction >= 0.999 ? 'hidden' : ''
  }

  useImperativeHandle(ref, () => ({ applyView }))
  useLayoutEffect(applyView)

  // ── Drag handling ──────────────────────────────────────────────────────────

  const onMouseDown = useCallback((e) => {
    if (e.button !== 0) return
    e.preventDefault()
    dragging.current = true
    dragStartX.current = e.clientX
    dragStartScroll.current = scrollOffsetRef.current
    document.body.style.cursor = 'grabbing'
    document.body.style.userSelect = 'none'
  }, [scrollOffsetRef])

  useEffect(() => {
    function onMouseMove(e) {
      if (!dragging.current) return
      const track = trackRef.current
      if (!track) return
      const trackW = track.clientWidth
      const dx = e.clientX - dragStartX.current
      const beatsDelta = (dx / trackW) * extentNow()
      onScrollTo(dragStartScroll.current + beatsDelta)
    }

    function onMouseUp() {
      if (!dragging.current) return
      dragging.current = false
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }

    document.addEventListener('mousemove', onMouseMove)
    document.addEventListener('mouseup', onMouseUp)
    return () => {
      document.removeEventListener('mousemove', onMouseMove)
      document.removeEventListener('mouseup', onMouseUp)
    }
  }, [totalBeats, onScrollTo, canvasWidth, maxScrollRef, pixelsPerBeatRef])

  // ── Click on track (not thumb) to jump ─────────────────────────────────────

  const onTrackClick = useCallback((e) => {
    if (e.target.classList.contains('timeline-scrollbar-thumb')) return
    const track = trackRef.current
    if (!track) return
    const rect = track.getBoundingClientRect()
    const fraction = (e.clientX - rect.left) / rect.width
    const visible = canvasWidth / (pixelsPerBeatRef?.current || 40)
    const beat = fraction * extentNow() - visible / 2
    onScrollTo(beat)
  }, [totalBeats, canvasWidth, maxScrollRef, pixelsPerBeatRef, onScrollTo])

  // ── Wheel on scrollbar = horizontal scroll ─────────────────────────────────

  useEffect(() => {
    const el = trackRef.current
    if (!el) return
    function handleWheel(e) {
      e.preventDefault()
      const delta = (e.deltaY || e.deltaX) / (pixelsPerBeatRef.current || 40) * 0.8
      onScroll(delta)
    }
    el.addEventListener('wheel', handleWheel, { passive: false })
    return () => el.removeEventListener('wheel', handleWheel)
  }, [onScroll, pixelsPerBeatRef])

  return (
    <div
      ref={trackRef}
      className="timeline-scrollbar"
      onClick={onTrackClick}
    >
      <div
        ref={thumbRef}
        className="timeline-scrollbar-thumb"
        style={{
          left: `${thumbLeft}%`,
          width: `${Math.max(thumbWidth, 3)}%`,
          visibility: thumbFraction >= 0.999 ? 'hidden' : undefined,
        }}
        onMouseDown={onMouseDown}
      />
    </div>
  )
})

export default TimelineScrollbar
