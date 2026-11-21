import { forwardRef, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useRef } from 'react'
import styles from './PianoRoll.module.css'

const SCROLLBAR_HEIGHT = 14
const ZOOM_GUTTER_HEIGHT = 10
const MIN_THUMB_SIZE = 24

// The thumb tracks the animator's per-frame scrollX (and per-frame content
// width, which zooming changes) through applyView(), not through the settled
// React state — see PianoRollKeyboard for why.
const PianoRollScrollbarH = forwardRef(function PianoRollScrollbarH({
  contentWidth, viewportWidth, scrollX, scrollXRef, setScrollX,
  onZoomDelta, getContentWidth,
}, ref) {
  const trackRef = useRef(null)
  const thumbRef = useRef(null)
  const gutterRef = useRef(null)
  const dragRef = useRef(null)

  const maxScroll = Math.max(0, contentWidth - viewportWidth)
  const hasOverflow = maxScroll > 0
  const ratio = hasOverflow ? viewportWidth / contentWidth : 1
  const thumbSize = hasOverflow ? Math.max(MIN_THUMB_SIZE, viewportWidth * ratio) : viewportWidth
  const trackLen = viewportWidth
  const thumbLeft = hasOverflow ? (scrollX / maxScroll) * (trackLen - thumbSize) : 0

  // Live geometry from the refs — the props above are the settled mirror,
  // used for the initial render and for deciding whether a thumb exists.
  const applyView = () => {
    const thumb = thumbRef.current
    if (!thumb) return
    const content = getContentWidth ? getContentWidth() : contentWidth
    const max = Math.max(0, content - viewportWidth)
    if (max <= 0) return
    const size = Math.max(MIN_THUMB_SIZE, viewportWidth * (viewportWidth / content))
    const left = ((scrollXRef?.current ?? 0) / max) * (viewportWidth - size)
    thumb.style.left = `${left}px`
    thumb.style.width = `${size}px`
  }

  useImperativeHandle(ref, () => ({ applyView }))
  useLayoutEffect(applyView)

  const handleThumbMouseDown = useCallback((e) => {
    if (e.button !== 0 || !hasOverflow) return
    e.preventDefault()
    e.stopPropagation()
    // Read the live ref, not the (debounced) scrollX prop — dragging can
    // start mid-animation, and the prop may not have settled to the real
    // position yet.
    dragRef.current = { startX: e.clientX, origScroll: scrollXRef?.current ?? scrollX }
    const onMove = (me) => {
      const d = dragRef.current
      if (!d) return
      const dx = me.clientX - d.startX
      const scrollRange = trackLen - thumbSize
      if (scrollRange <= 0) return
      const next = d.origScroll + (dx / scrollRange) * maxScroll
      setScrollX(Math.max(0, Math.min(maxScroll, next)))
    }
    const onUp = () => {
      dragRef.current = null
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }, [hasOverflow, scrollX, trackLen, thumbSize, maxScroll, setScrollX])

  const handleTrackClick = useCallback((e) => {
    if (!hasOverflow) return
    const track = trackRef.current
    if (!track) return
    const rect = track.getBoundingClientRect()
    const clickX = e.clientX - rect.left
    const page = viewportWidth * 0.9
    if (clickX < thumbLeft) {
      setScrollX(Math.max(0, scrollX - page))
    } else if (clickX > thumbLeft + thumbSize) {
      setScrollX(Math.min(maxScroll, scrollX + page))
    }
  }, [hasOverflow, viewportWidth, thumbLeft, thumbSize, scrollX, maxScroll, setScrollX])

  // Wheel-over horizontal scrollbar scrolls horizontally
  useEffect(() => {
    const el = trackRef.current
    if (!el) return
    const onWheel = (e) => {
      e.preventDefault()
      setScrollX((x) => Math.max(0, Math.min(maxScroll, x + e.deltaY)))
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [maxScroll, setScrollX])

  // Wheel-over zoom gutter zooms
  useEffect(() => {
    const el = gutterRef.current
    if (!el) return
    const onWheel = (e) => {
      e.preventDefault()
      onZoomDelta?.(e.deltaY < 0 ? 1 : -1)
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [onZoomDelta])

  return (
    <div className={styles.hscrollWrap}>
      <div
        ref={trackRef}
        className={styles.hscroll}
        onMouseDown={handleTrackClick}
        data-hint="Time scroll"
        data-hint-mods="Drag: scroll · Click: page · Wheel: scroll"
      >
        {hasOverflow && (
          <div
            ref={thumbRef}
            className={styles.thumb}
            onMouseDown={handleThumbMouseDown}
            style={{ left: thumbLeft, width: thumbSize }}
          />
        )}
      </div>
      <div
        ref={gutterRef}
        className={styles.zoomStrip}
        data-hint="Time zoom"
        data-hint-mods="Wheel: zoom in or out"
      />
    </div>
  )
})

export default PianoRollScrollbarH

export const SCROLLBAR_H_HEIGHT = SCROLLBAR_HEIGHT + ZOOM_GUTTER_HEIGHT
