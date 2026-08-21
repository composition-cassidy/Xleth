import { useState, useRef, useCallback, useEffect } from 'react'
import { MIN_PPB, MAX_PPB, DEFAULT_PPB, ZOOM_FACTOR } from '../constants/timeline.js'

// How long to wait after the last applyZoom() before syncing React state.
// Only affects DOM-positioned consumers (badges, scrollbar, zoom readout) —
// the draw path never waits on this, see onCommit below.
const SETTLE_MS = 100

export default function useTimelineZoom(onCommit) {
  const [pixelsPerBeat, setPixelsPerBeatState] = useState(DEFAULT_PPB)
  const pixelsPerBeatRef = useRef(DEFAULT_PPB)

  // Latest onCommit, refreshed every render so applyZoom (stable identity,
  // deps: []) always invokes the current callback without needing to be
  // recreated when the caller's closure changes.
  const onCommitRef = useRef(onCommit)
  onCommitRef.current = onCommit

  const settleTimerRef = useRef(null)
  useEffect(() => () => clearTimeout(settleTimerRef.current), [])

  const applyZoom = useCallback((ppb) => {
    const clamped = Math.max(MIN_PPB, Math.min(MAX_PPB, ppb))
    pixelsPerBeatRef.current = clamped

    if (onCommitRef.current) {
      // Hot path: the ref is already the source of truth, so redraw now,
      // synchronously, with no React render in between.
      onCommitRef.current(clamped)
      // Trailing-edge sync: React state (and everything derived from it —
      // badges, scrollbar, the toolbar zoom readout) catches up ~100ms after
      // the gesture stops, instead of on every wheel tick.
      clearTimeout(settleTimerRef.current)
      settleTimerRef.current = setTimeout(() => {
        setPixelsPerBeatState(pixelsPerBeatRef.current)
      }, SETTLE_MS)
    } else {
      // No onCommit supplied: preserve the original synchronous-state
      // behavior (used by callers that don't drive their own redraw path).
      setPixelsPerBeatState(clamped)
    }

    return clamped
  }, [])

  // Zoom centered on a cursor beat position.
  // deltaY > 0 = zoom out, deltaY < 0 = zoom in (matches wheel convention)
  const zoomAtCursor = useCallback((deltaY, cursorBeat, scrollOffsetRef, applyScroll) => {
    const oldPpb = pixelsPerBeatRef.current
    const factor = deltaY > 0 ? 1 / ZOOM_FACTOR : ZOOM_FACTOR
    const newPpb = applyZoom(oldPpb * factor)

    // Keep the beat under the cursor at the same pixel position
    // cursorPixel = (cursorBeat - scrollOffset) * oldPpb
    // newScrollOffset = cursorBeat - cursorPixel / newPpb
    const cursorPixel = (cursorBeat - scrollOffsetRef.current) * oldPpb
    const newScroll = cursorBeat - cursorPixel / newPpb
    applyScroll(newScroll)

    return newPpb
  }, [applyZoom])

  return { pixelsPerBeat, pixelsPerBeatRef, applyZoom, zoomAtCursor }
}
