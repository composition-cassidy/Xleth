import { useState, useRef, useCallback } from 'react'
import { MIN_PPB, MAX_PPB, DEFAULT_PPB, ZOOM_FACTOR } from '../constants/timeline.js'

export default function useTimelineZoom() {
  const [pixelsPerBeat, setPixelsPerBeatState] = useState(DEFAULT_PPB)
  const pixelsPerBeatRef = useRef(DEFAULT_PPB)

  const applyZoom = useCallback((ppb) => {
    const clamped = Math.max(MIN_PPB, Math.min(MAX_PPB, ppb))
    pixelsPerBeatRef.current = clamped
    setPixelsPerBeatState(clamped)
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
